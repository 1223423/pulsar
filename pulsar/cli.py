"""CLI entrypoint for the WebGL runtime."""

import argparse
import asyncio
import atexit
import datetime as dt
import os
import signal
import threading
import time
from pathlib import Path

import uvicorn

from .core.ble import stream_ecg, stream_hr
from .core.config import AppConfig
from .core.database import DatabaseStorage
from .core.state import SharedState
from .web import create_web_app

DEFAULT_WINDOW_SAMPLES = 172800


def flush_worker(state: SharedState, db: DatabaseStorage, stop_signal: threading.Event) -> None:
    """Flush buffered recording rows to SQLite."""
    while not stop_signal.is_set():
        time.sleep(1.0)

        rows: list[dict] = []
        with state.lock:
            if state.write_buffer.should_flush() and state.write_buffer.samples:
                rows = list(state.write_buffer.samples)
                state.write_buffer.clear()

        if not rows:
            continue

        try:
            db.insert_samples_batch(rows)
        except Exception as exc:
            print(f"[DB] Flush error: {exc}")
            with state.lock:
                state.write_buffer.samples.extend(rows)


class StreamController:
    """Manage BLE stream threads and recording lifecycle."""

    def __init__(self, config: AppConfig, state: SharedState, db: DatabaseStorage):
        self.config = config
        self.state = state
        self.db = db
        self.shutdown = threading.Event()
        self.stream_stop: threading.Event | None = None
        self.hr_thread: threading.Thread | None = None
        self.ecg_thread: threading.Thread | None = None
        self.flush_thread: threading.Thread | None = None

    def start(self, device_id: str) -> tuple[bool, str]:
        """Start live HR + ECG streams."""
        if not device_id:
            return False, "No device specified"
        if self.hr_thread and self.hr_thread.is_alive():
            return False, "Already streaming"

        self.stream_stop = threading.Event()

        def run_hr() -> None:
            asyncio.run(stream_hr(device_id, self.state, self.stream_stop))

        def run_ecg() -> None:
            asyncio.run(stream_ecg(device_id, self.state, self.stream_stop))

        self.hr_thread = threading.Thread(target=run_hr, daemon=True)
        self.ecg_thread = threading.Thread(target=run_ecg, daemon=True)
        self.hr_thread.start()
        self.ecg_thread.start()

        # Allow BLE stack a short warmup.
        time.sleep(0.5)
        return True, f"Connected to {device_id}"

    def start_recording(self) -> tuple[bool, str]:
        """Start DB recording for current stream."""
        if self.state.recording_active:
            return False, "Already recording"
        if not self.hr_thread or not self.hr_thread.is_alive():
            return False, "No device connected"

        with self.state.lock:
            device_name = self.state.device_name or "Unknown"
            device_id = self.state.device_id or "Unknown"

        session_id = self.db.create_session(
            device_name=device_name,
            device_id=device_id,
            hr_max=self.config.hr_max,
            started_at=dt.datetime.now().isoformat(),
        )

        with self.state.lock:
            self.state.current_session_id = session_id
            self.state.recording_active = True

        if not self.flush_thread or not self.flush_thread.is_alive():
            self.flush_thread = threading.Thread(
                target=flush_worker,
                args=(self.state, self.db, self.shutdown),
                daemon=True,
            )
            self.flush_thread.start()

        print(f"[DB] Recording started, session #{session_id}")
        return True, f"Recording to session #{session_id}"

    def stop_recording(self) -> tuple[bool, str]:
        """Stop recording and finalize the current session."""
        if not self.state.recording_active:
            return False, "Not recording"

        with self.state.lock:
            session_id = self.state.current_session_id
            pending = list(self.state.write_buffer.samples)
            self.state.write_buffer.clear()

        if pending:
            try:
                self.db.insert_samples_batch(pending)
                print(f"[DB] Final flush: {len(pending)} samples")
            except Exception as exc:
                print(f"[DB] Final flush error: {exc}")

        if not session_id:
            with self.state.lock:
                self.state.recording_active = False
            return False, "No active session"

        self.db.end_session(session_id, dt.datetime.now().isoformat())

        with self.state.lock:
            self.state.recording_active = False
            self.state.current_session_id = None

        print(f"[DB] Recording ended, session #{session_id}")
        return True, f"Recording saved to session #{session_id}"

    def stop(self) -> tuple[bool, str]:
        """Stop live streams and recording if active."""
        if not self.hr_thread or not self.hr_thread.is_alive():
            return False, "No active stream"

        if self.state.recording_active:
            self.stop_recording()

        if self.stream_stop:
            self.stream_stop.set()
        if self.hr_thread:
            self.hr_thread.join(timeout=5.0)
        if self.ecg_thread:
            self.ecg_thread.join(timeout=5.0)

        self.hr_thread = None
        self.ecg_thread = None
        self.stream_stop = None
        return True, "Stopped streaming"


def parse_args(argv: list[str] | None = None) -> tuple[AppConfig, str]:
    """Parse CLI args and return runtime config + DB path."""
    parser = argparse.ArgumentParser(description="Pulsar - Polar H10 monitor")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Server host")
    parser.add_argument("--port", type=int, default=8050, help="Server port")
    parser.add_argument(
        "--db",
        "--db-path",
        dest="db_path",
        type=str,
        default=None,
        help="Database path (default: ~/.pulsar/sessions.db)",
    )
    args = parser.parse_args(argv)

    db_path = args.db_path or str(Path.home() / ".pulsar" / "sessions.db")
    config = AppConfig(
        host=args.host,
        port=args.port,
    )
    return config, db_path


def main(argv: list[str] | None = None) -> None:
    """Run the WebGL server."""
    config, db_path = parse_args(argv)
    print(f"[Pulsar] Starting on {config.host}:{config.port}")
    print(f"[DB] Database: {db_path}")
    print("[UI] Mode: webgl")

    db = DatabaseStorage(db_path)
    active_session = db.get_active_session()
    if active_session:
        session_id = int(active_session["id"])
        print(f"[DB] Found active session #{session_id} from previous run")
        db.end_session(session_id, dt.datetime.now().isoformat())
        print(f"[DB] Marked session #{session_id} as ended")

    state = SharedState(window=DEFAULT_WINDOW_SAMPLES)
    controller = StreamController(config, state, db)

    def shutdown(*_args) -> None:
        print("\n[Pulsar] Shutting down...")
        controller.shutdown.set()
        controller.stop()
        db.close()
        os._exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    atexit.register(lambda: controller.stop())

    web_app = create_web_app(config, state, controller, db)
    uvicorn.run(
        web_app,
        host=config.host,
        port=config.port,
        log_level="info",
        ws="websockets",
    )


if __name__ == "__main__":
    main()

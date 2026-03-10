"""Shared state container."""
import datetime as dt
import threading
from collections import deque
from dataclasses import dataclass, field


@dataclass
class MarkerEvent:
    """User-created marker."""
    id: str
    timestamp: dt.datetime
    label: str
    sample_index: int
    color: str = "#f4be37"


MIN_WINDOW_SAMPLES = 172800
ECG_WINDOW_SAMPLES = 3900  # ~30 seconds at 130Hz (prevents browser memory crash)


@dataclass
class WriteBuffer:
    """Buffer for batching database writes."""
    samples: list[dict] = field(default_factory=list)
    max_size: int = 500
    last_flush: dt.datetime = field(default_factory=dt.datetime.now)
    flush_interval_seconds: float = 5.0

    def should_flush(self) -> bool:
        """Check if buffer should be flushed."""
        size_trigger = len(self.samples) >= self.max_size
        time_trigger = (dt.datetime.now() - self.last_flush).total_seconds() >= self.flush_interval_seconds
        return size_trigger or time_trigger

    def clear(self):
        """Clear buffer after flush."""
        self.samples.clear()
        self.last_flush = dt.datetime.now()


@dataclass
class SharedState:
    """Thread-safe container for streaming data."""

    window: int
    lock: threading.RLock = field(default_factory=threading.RLock, init=False)

    # Raw data streams
    ts: deque = field(default_factory=deque, init=False)
    sample_idx: deque = field(default_factory=deque, init=False)
    hr: deque = field(default_factory=deque, init=False)
    rr: deque = field(default_factory=deque, init=False)
    ecg_vals: deque = field(default_factory=deque, init=False)
    ecg_ts: deque = field(default_factory=deque, init=False)

    # Markers / recording session
    markers: list[MarkerEvent] = field(default_factory=list, init=False)
    current_session_id: int | None = None

    # Database write buffer
    write_buffer: WriteBuffer = field(default_factory=WriteBuffer, init=False)

    # Device info
    device_name: str | None = None
    device_id: str | None = None

    # Stream status
    connection_status: str = "idle"
    connection_error: str | None = None
    sample_counter: int = 0
    marker_seq: int = 0
    ecg_rate: int = 130
    last_update: dt.datetime | None = None

    # Recording
    recording_active: bool = False

    # ECG timing references
    ecg_time_origin: dt.datetime | None = None
    ecg_timestamp_origin_ns: int | None = None
    ecg_sample_index: int = 0

    def __post_init__(self):
        self.window = max(self.window, MIN_WINDOW_SAMPLES)
        self.ts = deque(maxlen=self.window)
        self.hr = deque(maxlen=self.window)
        self.sample_idx = deque(maxlen=self.window)
        self.rr = deque(maxlen=self.window)
        # ECG uses fixed small window to prevent browser memory crash
        self.ecg_vals = deque(maxlen=ECG_WINDOW_SAMPLES)
        self.ecg_ts = deque(maxlen=ECG_WINDOW_SAMPLES)

    def reset(self):
        """Clear all buffers."""
        with self.lock:
            self.ts.clear()
            self.sample_idx.clear()
            self.hr.clear()
            self.rr.clear()
            self.ecg_vals.clear()
            self.ecg_ts.clear()
            self.markers.clear()
            self.write_buffer.clear()
            self.sample_counter = 0
            self.marker_seq = 0
            self.ecg_rate = 130
            self.ecg_time_origin = None
            self.ecg_timestamp_origin_ns = None
            self.ecg_sample_index = 0
            self.current_session_id = None
            self.connection_status = "idle"
            self.connection_error = None
            self.device_name = None
            self.device_id = None
            self.last_update = None
            self.recording_active = False

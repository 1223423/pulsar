"""FastAPI + WebGL website for Pulsar live monitoring."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import math
import sys
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ..core.config import AppConfig
from ..core.state import MarkerEvent, SharedState
from ..core.zones import hr_zones, zone_label_and_color


class ConnectRequest(BaseModel):
    """Connection request payload."""

    device_id: str = Field(min_length=1, max_length=128)


class MarkerRequest(BaseModel):
    """Marker request payload."""

    label: str | None = Field(default=None, max_length=120)
    color: str | None = Field(default="#f4be37", max_length=16)
    timestamp: str | None = Field(default=None, max_length=64)
    session_id: int | None = Field(default=None, ge=1)


class MarkerUpdateRequest(BaseModel):
    """Marker update payload."""

    label: str | None = Field(default=None, max_length=120)
    color: str | None = Field(default=None, max_length=16)
    timestamp: str | None = Field(default=None, max_length=64)
    session_id: int | None = Field(default=None, ge=1)


class SessionUpdateRequest(BaseModel):
    """Session update payload."""

    name: str = Field(min_length=1, max_length=120)


class RecoveryTestRequest(BaseModel):
    """Post-hoc recovery test payload."""

    marker_id: str = Field(min_length=1, max_length=128)


def _iso_or_none(value: dt.datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat(timespec="milliseconds")


def _safe_float(value: Any) -> float | None:
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


def _serialize_markers(markers: list[MarkerEvent]) -> list[dict[str, Any]]:
    return [
        {
            "id": m.id,
            "timestamp": _iso_or_none(m.timestamp),
            "label": m.label,
            "sample_index": m.sample_index,
            "color": m.color,
        }
        for m in markers
    ]


def _parse_marker_timestamp(raw_value: str | None) -> dt.datetime:
    if raw_value is None or not str(raw_value).strip():
        return dt.datetime.now()

    text = str(raw_value).strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"

    parsed = dt.datetime.fromisoformat(text)
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def _iso_ms(value: dt.datetime) -> str:
    return value.isoformat(timespec="milliseconds")


def _nearest_session_sample_index(samples: list[dict[str, Any]], target: dt.datetime) -> int:
    best_index = 0
    best_gap: float | None = None
    for row in samples:
        raw_ts = row.get("timestamp")
        if raw_ts is None:
            continue
        try:
            sample_ts = dt.datetime.fromisoformat(str(raw_ts))
        except Exception:
            continue
        gap = abs((sample_ts - target).total_seconds())
        if best_gap is None or gap < best_gap:
            best_gap = gap
            best_index = int(row.get("sample_index") or 0)
    return best_index


def _nearest_live_sample_index(state: SharedState, target: dt.datetime) -> int:
    if state.ts and state.sample_idx:
        return int(
            min(
                zip(state.sample_idx, state.ts),
                key=lambda pair: abs((pair[1] - target).total_seconds()),
            )[0]
        )
    return int(state.sample_counter)


def _marker_payload(
    marker_id: str,
    timestamp: dt.datetime | str,
    label: str,
    sample_index: int,
    color: str,
) -> dict[str, Any]:
    ts = _iso_ms(timestamp) if isinstance(timestamp, dt.datetime) else str(timestamp)
    return {
        "id": marker_id,
        "timestamp": ts,
        "label": label,
        "sample_index": sample_index,
        "color": color,
    }


def _session_name(session: dict[str, Any]) -> str:
    notes = str(session.get("notes") or "").strip()
    if notes:
        return notes
    session_id = session.get("id")
    return f"Session #{session_id}" if session_id is not None else "Session"


def _session_duration_minutes(session: dict[str, Any]) -> float | None:
    started_raw = session.get("started_at")
    if not started_raw:
        return None
    try:
        started = _parse_marker_timestamp(str(started_raw))
    except Exception:
        return None

    ended_raw = session.get("ended_at")
    if ended_raw:
        try:
            ended = _parse_marker_timestamp(str(ended_raw))
        except Exception:
            ended = dt.datetime.now()
    else:
        ended = dt.datetime.now()

    minutes = (ended - started).total_seconds() / 60.0
    if not math.isfinite(minutes):
        return None
    return max(0.0, round(minutes, 1))


def _serialize_session(session: dict[str, Any]) -> dict[str, Any]:
    payload = dict(session)
    payload["session_name"] = _session_name(session)
    payload["duration_minutes"] = _session_duration_minutes(session)
    return payload


def _compute_zone_breakdown_from_samples(samples: list[dict[str, Any]], hr_max: int) -> list[dict[str, Any]]:
    zones = [z for z in hr_zones(hr_max) if z.label.startswith("Zone")]
    if not zones:
        return []

    totals = [{"zone": zone, "seconds": 0.0} for zone in zones]
    series: list[tuple[dt.datetime, float]] = []
    for sample in samples:
        hr_value = _safe_float(sample.get("heart_rate_bpm"))
        if hr_value is None:
            continue
        try:
            ts = _parse_marker_timestamp(str(sample.get("timestamp")))
        except Exception:
            continue
        series.append((ts, hr_value))

    if len(series) < 2:
        return [
            {
                "label": item["zone"].label,
                "color": item["zone"].color,
                "seconds": 0.0,
                "pct": 0,
                "threshold_bpm": int(item["zone"].high),
            }
            for item in totals
        ]

    series.sort(key=lambda item: item[0])
    valid_deltas = [
        (series[idx + 1][0] - series[idx][0]).total_seconds()
        for idx in range(len(series) - 1)
        if 0.0 < (series[idx + 1][0] - series[idx][0]).total_seconds() < 10.0
    ]
    if valid_deltas:
        sorted_deltas = sorted(valid_deltas)
        median_idx = len(sorted_deltas) // 2
        default_dt = (
            sorted_deltas[median_idx]
            if len(sorted_deltas) % 2 == 1
            else (sorted_deltas[median_idx - 1] + sorted_deltas[median_idx]) / 2
        )
    else:
        default_dt = 1.0

    for idx in range(len(series) - 1):
        current_ts, current_hr = series[idx]
        next_ts = series[idx + 1][0]
        delta = (next_ts - current_ts).total_seconds()
        if delta <= 0.0 or delta > 10.0:
            delta = default_dt

        target_idx = 0
        for zone_idx, zone in enumerate(zones):
            if zone.low <= current_hr < zone.high:
                target_idx = zone_idx
                break
            if zone_idx == len(zones) - 1 and current_hr >= zone.low:
                target_idx = zone_idx
                break
        totals[target_idx]["seconds"] += delta

    total_seconds = sum(item["seconds"] for item in totals)
    breakdown: list[dict[str, Any]] = []
    for item in totals:
        zone = item["zone"]
        seconds = float(item["seconds"])
        pct = int(round((seconds / total_seconds) * 100.0)) if total_seconds > 0 else 0
        breakdown.append(
            {
                "label": zone.label,
                "color": zone.color,
                "seconds": seconds,
                "pct": pct,
                "threshold_bpm": int(zone.high),
            }
        )
    return breakdown


def _compute_hrr60_from_samples(samples: list[dict[str, Any]], marker_time: dt.datetime) -> dict[str, Any]:
    hr_points: list[tuple[dt.datetime, float]] = []
    for sample in samples:
        hr_value = _safe_float(sample.get("heart_rate_bpm"))
        if hr_value is None:
            continue
        try:
            ts = _parse_marker_timestamp(str(sample.get("timestamp")))
        except Exception:
            continue
        hr_points.append((ts, hr_value))

    if len(hr_points) < 2:
        raise ValueError("Not enough HR samples for recovery test")

    hr_points.sort(key=lambda item: item[0])
    if (hr_points[-1][0] - marker_time).total_seconds() < 45:
        raise ValueError("Marker must be at least ~45s before session end")

    def nearest(target: dt.datetime, max_gap_seconds: float) -> tuple[float, float, dt.datetime] | None:
        best: tuple[float, float, dt.datetime] | None = None
        for ts, hr_value in hr_points:
            diff = abs((ts - target).total_seconds())
            if best is None or diff < best[0]:
                best = (diff, hr_value, ts)
        if best is None or best[0] > max_gap_seconds:
            return None
        return best

    n0 = nearest(marker_time, max_gap_seconds=15.0)
    n1 = nearest(marker_time + dt.timedelta(seconds=60), max_gap_seconds=20.0)
    if n0 is None or n1 is None:
        raise ValueError("Not enough nearby HR data for 60s recovery estimate")

    delta = n0[1] - n1[1]
    return {
        "marker_time": marker_time.isoformat(timespec="milliseconds"),
        "hr_at_marker_bpm": round(n0[1], 2),
        "hr_at_60s_bpm": round(n1[1], 2),
        "delta_bpm": round(delta, 2),
        "marker_sample_time": n0[2].isoformat(timespec="milliseconds"),
        "sample_60s_time": n1[2].isoformat(timespec="milliseconds"),
        "marker_gap_s": round(n0[0], 3),
        "gap_60s_s": round(n1[0], 3),
    }


def _extract_hr_points(
    state: SharedState,
    last_cursor: int,
    initial_limit: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    with state.lock:
        sample_idx = list(state.sample_idx)
        ts = list(state.ts)
        hr = list(state.hr)
        rr = list(state.rr)

    rows = list(zip(sample_idx, ts, hr, rr))
    if last_cursor <= 0:
        selected = rows[-initial_limit:] if initial_limit > 0 else rows
    else:
        # If cursor moved ahead of current sample indices, stream was reset.
        # Re-seed the client with currently buffered points.
        if rows and last_cursor > rows[-1][0]:
            selected = rows[-initial_limit:] if initial_limit > 0 else rows
        else:
            selected = [row for row in rows if row[0] > last_cursor]

    points = [
        {
            "idx": idx,
            "t": _iso_or_none(timestamp),
            "hr": _safe_float(hr_value),
            "rr": _safe_float(rr_value),
        }
        for idx, timestamp, hr_value, rr_value in selected
    ]

    if points:
        new_cursor = int(points[-1]["idx"])
    else:
        new_cursor = last_cursor

    return points, new_cursor


def _extract_ecg_points(
    state: SharedState,
    last_cursor: int,
    initial_limit: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    with state.lock:
        ts = list(state.ecg_ts)
        vals = list(state.ecg_vals)
        total_samples = int(state.ecg_sample_index)

    first_idx = max(1, total_samples - len(vals) + 1)
    rows = [
        (first_idx + offset, timestamp, value)
        for offset, (timestamp, value) in enumerate(zip(ts, vals))
    ]

    if last_cursor <= 0:
        selected = rows[-initial_limit:] if initial_limit > 0 else rows
    else:
        # If cursor moved ahead of current sample indices, stream was reset.
        # Re-seed the client with currently buffered points.
        if rows and last_cursor > rows[-1][0]:
            selected = rows[-initial_limit:] if initial_limit > 0 else rows
        else:
            selected = [row for row in rows if row[0] > last_cursor]

    points = [
        {
            "idx": idx,
            "t": _iso_or_none(timestamp),
            "v": _safe_float(value),
        }
        for idx, timestamp, value in selected
    ]

    if points:
        new_cursor = int(points[-1]["idx"])
    else:
        new_cursor = last_cursor

    return points, new_cursor


def _build_status_payload(state: SharedState, config: AppConfig) -> dict[str, Any]:
    with state.lock:
        hr_values = list(state.hr)
        rr_values = list(state.rr)
        ecg_values = list(state.ecg_vals)
        markers = list(state.markers)

        connection_status = state.connection_status
        device_name = state.device_name
        device_id = state.device_id
        recording_active = state.recording_active
        current_session_id = state.current_session_id
        sample_counter = int(state.sample_counter)
        ecg_rate = int(state.ecg_rate)

    last_hr = hr_values[-1] if hr_values else float("nan")
    zone_label, zone_color, zone_fraction = zone_label_and_color(last_hr, config.hr_max)

    avg_hr = sum(hr_values) / len(hr_values) if hr_values else float("nan")
    min_hr = min(hr_values) if hr_values else float("nan")
    max_hr = max(hr_values) if hr_values else float("nan")
    last_rr = rr_values[-1] if rr_values else float("nan")

    connected = connection_status not in {"idle", "error", "stopped", ""}

    return {
        "server_time": dt.datetime.now().isoformat(timespec="milliseconds"),
        "connection": {
            "status": connection_status,
            "connected": connected,
            "device_name": device_name,
            "device_id": device_id,
        },
        "recording": {
            "active": recording_active,
            "session_id": current_session_id,
        },
        "zone": {
            "label": zone_label,
            "color": zone_color,
            "fraction": _safe_float(zone_fraction),
            "pct": int(round(zone_fraction * 100)) if math.isfinite(zone_fraction) else None,
        },
        "stats": {
            "last_hr": _safe_float(last_hr),
            "avg_hr": _safe_float(avg_hr),
            "min_hr": _safe_float(min_hr),
            "max_hr": _safe_float(max_hr),
            "last_rr": _safe_float(last_rr),
            "samples": sample_counter,
            "ecg_samples": len(ecg_values),
            "ecg_rate": ecg_rate,
            "hr_max": config.hr_max,
        },
        "markers": _serialize_markers(markers),
    }


def _build_live_payload(
    state: SharedState,
    config: AppConfig,
    hr_cursor: int,
    ecg_cursor: int,
    initial_hr_limit: int,
    initial_ecg_limit: int,
) -> tuple[dict[str, Any], int, int]:
    hr_points, new_hr_cursor = _extract_hr_points(
        state,
        hr_cursor,
        initial_limit=initial_hr_limit,
    )
    ecg_points, new_ecg_cursor = _extract_ecg_points(
        state,
        ecg_cursor,
        initial_limit=initial_ecg_limit,
    )

    status_payload = _build_status_payload(state, config)
    return {
        "type": "live_update",
        "cursor": {
            "hr": new_hr_cursor,
            "ecg": new_ecg_cursor,
        },
        "series": {
            "hr": hr_points,
            "ecg": ecg_points,
        },
        **status_payload,
    }, new_hr_cursor, new_ecg_cursor


async def _scan_devices_isolated(timeout_seconds: float = 15.0) -> list[dict[str, Any]]:
    """Run BLE scan in a subprocess so scanner crashes cannot take down the API server."""
    script = (
        "import asyncio, json\n"
        "from pulsar.core.ble import scan_devices\n"
        "async def _main():\n"
        "    devices = await scan_devices()\n"
        "    print(json.dumps(devices))\n"
        "asyncio.run(_main())\n"
    )

    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        script,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
    except asyncio.TimeoutError as exc:
        process.kill()
        await process.communicate()
        raise RuntimeError("Bluetooth scan timed out") from exc

    if process.returncode != 0:
        error_text = stderr.decode(errors="replace").strip() or f"scanner exited with code {process.returncode}"
        raise RuntimeError(error_text)

    raw = stdout.decode(errors="replace").strip()
    if not raw:
        return []

    data = json.loads(raw)
    if isinstance(data, list):
        return data
    raise RuntimeError("Scanner returned invalid payload")


def create_web_app(config: AppConfig, state: SharedState, controller: Any, db: Any) -> FastAPI:
    """Create the WebGL web app."""

    static_dir = Path(__file__).resolve().parent / "static"

    app = FastAPI(title="Pulsar WebGL", version="0.1.0")
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(static_dir / "index.html")

    @app.get("/api/status")
    async def api_status() -> dict[str, Any]:
        return _build_status_payload(state, config)

    @app.post("/api/scan")
    async def api_scan() -> dict[str, Any]:
        try:
            devices = await _scan_devices_isolated()
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Scan failed: {exc}") from exc
        return {"devices": devices}

    @app.post("/api/connect")
    async def api_connect(payload: ConnectRequest) -> dict[str, Any]:
        ok, message = await asyncio.to_thread(controller.start, payload.device_id)
        if not ok and message == "Already streaming":
            with state.lock:
                already_connected = state.connection_status not in {"idle", "error", "stopped", ""}
            if already_connected:
                return {"ok": True, "message": "Already connected"}

            # Recover from stale stream state: stop/reset and retry once.
            await asyncio.to_thread(controller.stop)
            state.reset()
            ok, message = await asyncio.to_thread(controller.start, payload.device_id)

        if not ok:
            raise HTTPException(status_code=400, detail=message)
        return {"ok": True, "message": message}

    @app.post("/api/disconnect")
    async def api_disconnect() -> dict[str, Any]:
        ok, message = await asyncio.to_thread(controller.stop)
        state.reset()
        return {
            "ok": bool(ok),
            "message": message or "Disconnected",
        }

    @app.post("/api/record/start")
    async def api_start_recording() -> dict[str, Any]:
        ok, message = await asyncio.to_thread(controller.start_recording)
        if not ok:
            raise HTTPException(status_code=400, detail=message)
        return {"ok": True, "message": message}

    @app.post("/api/record/stop")
    async def api_stop_recording() -> dict[str, Any]:
        ok, message = await asyncio.to_thread(controller.stop_recording)
        if not ok:
            raise HTTPException(status_code=400, detail=message)
        return {"ok": True, "message": message}

    @app.post("/api/marker")
    async def api_add_marker(payload: MarkerRequest) -> dict[str, Any]:
        if payload.session_id is not None:
            session = await asyncio.to_thread(db.get_session, payload.session_id)
            if not session:
                raise HTTPException(status_code=404, detail="Session not found")

            marker_time = _parse_marker_timestamp(payload.timestamp)
            marker_id = f"marker-{payload.session_id}-{uuid4().hex[:12]}"
            label = payload.label or "Marker"
            color = payload.color or "#f4be37"

            samples = await asyncio.to_thread(db.get_session_samples, payload.session_id, "hr_rr", None, None, None)
            sample_index = _nearest_session_sample_index(samples, marker_time)

            try:
                await asyncio.to_thread(
                    db.insert_marker,
                    payload.session_id,
                    marker_id,
                    _iso_ms(marker_time),
                    label,
                    sample_index,
                    color,
                )
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"Marker save failed: {exc}") from exc

            return {
                "ok": True,
                "marker": _marker_payload(marker_id, marker_time, label, sample_index, color),
            }

        marker_time = _parse_marker_timestamp(payload.timestamp)
        with state.lock:
            session_key = state.current_session_id if state.current_session_id is not None else "live"
            marker_id = f"marker-{session_key}-{uuid4().hex[:12]}"
            state.marker_seq += 1
            sample_index = _nearest_live_sample_index(state, marker_time)
            marker = MarkerEvent(
                id=marker_id,
                timestamp=marker_time,
                label=payload.label or f"Marker {state.marker_seq}",
                sample_index=sample_index,
                color=payload.color or "#f4be37",
            )
            state.markers.append(marker)
            state.markers.sort(key=lambda item: (item.timestamp, item.sample_index, item.id))
            recording_active = state.recording_active
            current_session_id = state.current_session_id

        if recording_active and current_session_id:
            try:
                db.insert_marker(
                    session_id=current_session_id,
                    marker_id=marker.id,
                    timestamp=_iso_ms(marker_time),
                    label=marker.label,
                    sample_index=marker.sample_index,
                    color=marker.color,
                )
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"Marker was added in memory but DB save failed: {exc}") from exc

        return {
            "ok": True,
            "marker": _marker_payload(
                marker.id,
                marker.timestamp,
                marker.label,
                marker.sample_index,
                marker.color,
            ),
        }

    @app.patch("/api/marker/{marker_id}")
    async def api_update_marker(marker_id: str, payload: MarkerUpdateRequest) -> dict[str, Any]:
        fields_set = set(payload.model_fields_set)
        if not fields_set:
            raise HTTPException(status_code=400, detail="No updates provided")

        if payload.session_id is not None:
            markers = await asyncio.to_thread(db.get_session_markers, payload.session_id)
            current = next((row for row in markers if row.get("marker_id") == marker_id), None)
            if current is None:
                raise HTTPException(status_code=404, detail="Marker not found")

            next_timestamp: dt.datetime | None = None
            if "timestamp" in fields_set:
                next_timestamp = _parse_marker_timestamp(payload.timestamp)

            sample_index: int | None = None
            if next_timestamp is not None:
                samples = await asyncio.to_thread(db.get_session_samples, payload.session_id, "hr_rr", None, None, None)
                sample_index = _nearest_session_sample_index(samples, next_timestamp)

            try:
                await asyncio.to_thread(
                    db.update_marker,
                    payload.session_id,
                    marker_id,
                    _iso_ms(next_timestamp) if next_timestamp is not None else None,
                    payload.label if "label" in fields_set else None,
                    payload.color if "color" in fields_set else None,
                    sample_index,
                )
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"Marker update failed: {exc}") from exc

            return {
                "ok": True,
                "marker": _marker_payload(
                    marker_id,
                    next_timestamp if next_timestamp is not None else str(current.get("timestamp")),
                    payload.label if "label" in fields_set and payload.label is not None else str(current.get("label") or "Marker"),
                    sample_index if sample_index is not None else int(current.get("sample_index") or 0),
                    payload.color if "color" in fields_set and payload.color is not None else str(current.get("color") or "#f4be37"),
                ),
            }

        next_timestamp: dt.datetime | None = None
        if "timestamp" in fields_set:
            next_timestamp = _parse_marker_timestamp(payload.timestamp)

        with state.lock:
            marker = next((item for item in state.markers if item.id == marker_id), None)
            if marker is None:
                raise HTTPException(status_code=404, detail="Marker not found")

            if "label" in fields_set and payload.label is not None:
                marker.label = payload.label
            if "color" in fields_set and payload.color is not None:
                marker.color = payload.color
            if next_timestamp is not None:
                marker.timestamp = next_timestamp
                marker.sample_index = _nearest_live_sample_index(state, next_timestamp)

            state.markers.sort(key=lambda item: (item.timestamp, item.sample_index, item.id))

            recording_active = state.recording_active
            current_session_id = state.current_session_id

        if recording_active and current_session_id:
            try:
                db.update_marker(
                    session_id=current_session_id,
                    marker_id=marker_id,
                    timestamp=_iso_ms(marker.timestamp) if next_timestamp is not None else None,
                    label=marker.label if "label" in fields_set else None,
                    color=marker.color if "color" in fields_set else None,
                    sample_index=marker.sample_index if next_timestamp is not None else None,
                )
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"Marker was updated in memory but DB save failed: {exc}") from exc

        return {
            "ok": True,
            "marker": _marker_payload(
                marker.id,
                marker.timestamp,
                marker.label,
                marker.sample_index,
                marker.color,
            ),
        }

    @app.delete("/api/marker/{marker_id}")
    async def api_delete_marker(marker_id: str, session_id: int | None = Query(default=None, ge=1)) -> dict[str, Any]:
        if session_id is not None:
            markers = await asyncio.to_thread(db.get_session_markers, session_id)
            marker_row = next((row for row in markers if row.get("marker_id") == marker_id), None)
            if marker_row is None:
                raise HTTPException(status_code=404, detail="Marker not found")

            try:
                await asyncio.to_thread(db.delete_marker, session_id, marker_id)
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"Marker delete failed: {exc}") from exc

            return {
                "ok": True,
                "marker": _marker_payload(
                    marker_id,
                    str(marker_row.get("timestamp")),
                    str(marker_row.get("label") or "Marker"),
                    int(marker_row.get("sample_index") or 0),
                    str(marker_row.get("color") or "#f4be37"),
                ),
            }

        with state.lock:
            marker_idx = next((idx for idx, item in enumerate(state.markers) if item.id == marker_id), None)
            if marker_idx is None:
                raise HTTPException(status_code=404, detail="Marker not found")

            marker = state.markers.pop(marker_idx)
            recording_active = state.recording_active
            current_session_id = state.current_session_id

        if recording_active and current_session_id:
            try:
                db.delete_marker(session_id=current_session_id, marker_id=marker_id)
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"Marker was deleted in memory but DB delete failed: {exc}") from exc

        return {
            "ok": True,
            "marker": _marker_payload(
                marker.id,
                marker.timestamp,
                marker.label,
                marker.sample_index,
                marker.color,
            ),
        }

    @app.get("/api/sessions")
    async def api_sessions(
        limit: int = Query(default=30, ge=1, le=200),
        status: str | None = Query(default=None),
    ) -> dict[str, Any]:
        sessions = await asyncio.to_thread(db.get_all_sessions, limit, 0, status)
        return {"sessions": [_serialize_session(session) for session in sessions]}

    @app.get("/api/session/{session_id}")
    async def api_session_data(session_id: int) -> dict[str, Any]:
        session = await asyncio.to_thread(db.get_session, session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")

        samples = await asyncio.to_thread(db.get_session_samples, session_id, "hr_rr", None, None, None)
        markers = await asyncio.to_thread(db.get_session_markers, session_id)
        stats = await asyncio.to_thread(db.get_session_stats, session_id)
        session_hr_max = int(session.get("hr_max") or config.hr_max)
        zone_breakdown = _compute_zone_breakdown_from_samples(samples, session_hr_max)

        hr_rows = [
            {
                "idx": row.get("sample_index"),
                "t": row.get("timestamp"),
                "hr": _safe_float(row.get("heart_rate_bpm")),
                "rr": _safe_float(row.get("rr_ms")),
            }
            for row in samples
            if _safe_float(row.get("heart_rate_bpm")) is not None
        ]

        marker_rows = [
            {
                "id": row.get("marker_id"),
                "timestamp": row.get("timestamp"),
                "label": row.get("label"),
                "sample_index": row.get("sample_index"),
                "color": row.get("color"),
            }
            for row in markers
        ]

        last_hr = hr_rows[-1]["hr"] if hr_rows else float("nan")
        zone_label, zone_color, zone_fraction = zone_label_and_color(last_hr, session_hr_max)

        return {
            "session": _serialize_session(session),
            "series": {
                "hr": hr_rows,
                "ecg": [],
            },
            "markers": marker_rows,
            "stats": {
                "last_hr": _safe_float(last_hr),
                "avg_hr": _safe_float(stats.get("avg_hr")),
                "min_hr": _safe_float(stats.get("min_hr")),
                "max_hr": _safe_float(stats.get("max_hr")),
                "last_rr": _safe_float(hr_rows[-1]["rr"]) if hr_rows else None,
                "samples": len(hr_rows),
                "ecg_samples": 0,
                "ecg_rate": int(state.ecg_rate),
                "hr_max": session_hr_max,
            },
            "zone": {
                "label": zone_label,
                "color": zone_color,
                "fraction": _safe_float(zone_fraction),
                "pct": int(round(zone_fraction * 100)) if math.isfinite(zone_fraction) else None,
            },
            "zone_breakdown": zone_breakdown,
        }

    @app.patch("/api/session/{session_id}")
    async def api_update_session(session_id: int, payload: SessionUpdateRequest) -> dict[str, Any]:
        session = await asyncio.to_thread(db.get_session, session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")

        next_name = payload.name.strip()
        if not next_name:
            raise HTTPException(status_code=400, detail="Session name cannot be empty")

        try:
            await asyncio.to_thread(db.update_session_notes, session_id, next_name)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Session update failed: {exc}") from exc

        updated = await asyncio.to_thread(db.get_session, session_id)
        return {
            "ok": True,
            "session": _serialize_session(updated or session),
        }

    @app.delete("/api/session/{session_id}")
    async def api_delete_session(session_id: int) -> dict[str, Any]:
        session = await asyncio.to_thread(db.get_session, session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        if str(session.get("status") or "").lower() == "active":
            raise HTTPException(status_code=400, detail="Cannot delete an active session")

        try:
            deleted = await asyncio.to_thread(db.delete_session, session_id)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Session delete failed: {exc}") from exc

        if not deleted:
            raise HTTPException(status_code=500, detail="Session delete failed")

        return {
            "ok": True,
            "session_id": session_id,
        }

    @app.post("/api/session/{session_id}/tests/hrr60")
    async def api_session_hrr60_test(session_id: int, payload: RecoveryTestRequest) -> dict[str, Any]:
        session = await asyncio.to_thread(db.get_session, session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")

        markers = await asyncio.to_thread(db.get_session_markers, session_id)
        marker_row = next((row for row in markers if str(row.get("marker_id")) == payload.marker_id), None)
        if marker_row is None:
            raise HTTPException(status_code=404, detail="Marker not found")

        try:
            marker_time = _parse_marker_timestamp(str(marker_row.get("timestamp")))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid marker timestamp: {exc}") from exc

        samples = await asyncio.to_thread(db.get_session_samples, session_id, "hr_rr", None, None, None)
        try:
            result = _compute_hrr60_from_samples(samples, marker_time)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        return {
            "ok": True,
            "test": "hrr60",
            "session_id": session_id,
            "marker": {
                "id": str(marker_row.get("marker_id")),
                "label": str(marker_row.get("label") or "Marker"),
                "timestamp": str(marker_row.get("timestamp")),
            },
            "result": result,
        }

    @app.websocket("/ws/live")
    async def ws_live(websocket: WebSocket):
        await websocket.accept()

        hr_cursor = 0
        ecg_cursor = 0
        last_send = 0.0
        loop = asyncio.get_running_loop()

        try:
            while True:
                payload, hr_cursor, ecg_cursor = _build_live_payload(
                    state,
                    config,
                    hr_cursor,
                    ecg_cursor,
                    initial_hr_limit=2500 if hr_cursor == 0 else 0,
                    initial_ecg_limit=1800 if ecg_cursor == 0 else 0,
                )

                has_new_points = bool(payload["series"]["hr"] or payload["series"]["ecg"])
                now = loop.time()
                # Keep UI fresh every second even when there are no incoming points.
                if has_new_points or (now - last_send) >= 1.0:
                    await websocket.send_json(payload)
                    last_send = now

                await asyncio.sleep(0.10)
        except WebSocketDisconnect:
            return
        except RuntimeError:
            # Client disconnected between serialization and send.
            return

    return app

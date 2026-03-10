"""BLE streaming for Polar H10 devices."""
import asyncio
import datetime as dt
import struct
from typing import Protocol

from bleak import BleakClient, BleakScanner

from .constants import (
    HR_MEASUREMENT_UUID,
    PMD_CONTROL_UUID,
    PMD_DATA_UUID,
    PMD_CMD_START_MEASUREMENT,
    PMD_CMD_STOP_MEASUREMENT,
    PMD_TYPE_ECG,
)
from .hrm import parse_hr_measurement
from .state import SharedState


ECG_SAMPLE_RATE_HZ = 130  # Polar H10 ECG sampling frequency
ECG_SAMPLE_SCALE_UV = 0.01  # Convert raw counts to approximate microvolts


class StopSignal(Protocol):
    """Signal for stopping streams."""
    def is_set(self) -> bool: ...


async def scan_devices(timeout: float = 8.0) -> list[dict]:
    """Scan for all BLE devices and return list with name and address."""
    devices = await BleakScanner.discover(timeout=timeout)
    return [
        {
            "name": dev.name or "Unknown",
            "address": getattr(dev, "address", ""),
            "rssi": getattr(dev, "rssi", None),
        }
        for dev in devices
        if dev.name  # Only include named devices
    ]


async def find_device(target: str | None, timeout: float = 8.0) -> object | None:
    """Find Polar device by address or name."""
    if not target:
        return None

    # Try exact address first
    device = await BleakScanner.find_device_by_address(target, timeout=timeout)
    if device:
        return device

    # Scan for name match
    devices = await BleakScanner.discover(timeout=timeout)
    target_lower = target.lower()
    for dev in devices:
        name = (dev.name or "").lower()
        address = (getattr(dev, "address", "") or "").lower()
        if target_lower in name or target_lower == address:
            return dev

    return None


async def stream_hr(
    device_id: str,
    state: SharedState,
    stop: StopSignal,
) -> None:
    """Stream heart rate and RR intervals."""
    state.connection_status = "connecting"

    device = await find_device(device_id)
    if not device:
        state.connection_status = "error"
        state.connection_error = f"Device '{device_id}' not found"
        return

    with state.lock:
        state.device_name = device.name
        state.device_id = getattr(device, "address", None)

    try:
        async with BleakClient(device, timeout=30.0) as client:
            state.connection_status = "connected"
            state.connection_error = None

            def on_hr_data(_, data: bytearray):
                measurement = parse_hr_measurement(bytes(data))
                if not measurement:
                    return

                now = dt.datetime.now()
                with state.lock:
                    state.sample_counter += 1
                    state.ts.append(now)
                    state.sample_idx.append(state.sample_counter)
                    state.hr.append(measurement.heart_rate)
                    state.rr.append(measurement.latest_rr)
                    state.last_update = now

                    # Add to database write buffer only while recording.
                    if state.recording_active and state.current_session_id:
                        state.write_buffer.samples.append({
                            "session_id": state.current_session_id,
                            "stream": "hr_rr",
                            "timestamp": now.isoformat(timespec="milliseconds"),
                            "sample_index": state.sample_counter,
                            "heart_rate_bpm": measurement.heart_rate,
                            "rr_ms": measurement.latest_rr,
                            "ecg_uv": None,
                            "recording": state.recording_active,
                        })

            await client.start_notify(HR_MEASUREMENT_UUID, on_hr_data)

            while not stop.is_set():
                await asyncio.sleep(0.5)

            await client.stop_notify(HR_MEASUREMENT_UUID)

    except Exception as exc:
        state.connection_status = "error"
        state.connection_error = str(exc)

    finally:
        if stop.is_set():
            state.connection_status = "stopped"


async def stream_ecg(
    device_id: str,
    state: SharedState,
    stop: StopSignal,
) -> None:
    """Stream ECG using Polar PMD service."""
    device = await find_device(device_id)
    if not device:
        return

    try:
        async with BleakClient(device, timeout=30.0) as client:

            def on_ecg_data(_, data: bytearray):
                # Parse Polar PMD ECG format
                payload = bytes(data)
                if len(payload) < 10:
                    return

                # PMD format: [type, timestamp(8), frame_type, samples...]
                measurement_type = payload[0]
                if measurement_type != PMD_TYPE_ECG:
                    return

                timestamp_ns = struct.unpack("<Q", payload[1:9])[0]
                frame_type = payload[9]
                if frame_type != 0x00:
                    # Unsupported frame type for ECG
                    return

                sample_bytes = payload[10:]
                if len(sample_bytes) < 3:
                    return
                if len(sample_bytes) % 3 != 0:
                    # Misaligned payload, skip frame
                    return

                sample_rate = ECG_SAMPLE_RATE_HZ

                samples = []
                for i in range(0, len(sample_bytes), 3):
                    chunk = sample_bytes[i:i+3]
                    raw = int.from_bytes(chunk, byteorder="little", signed=True)
                    samples.append(float(raw) * ECG_SAMPLE_SCALE_UV)

                if not samples:
                    return

                now = dt.datetime.now()

                with state.lock:
                    if state.ecg_timestamp_origin_ns is None:
                        state.ecg_timestamp_origin_ns = timestamp_ns
                        state.ecg_time_origin = now
                        state.ecg_sample_index = 0

                    # Handle timer resets or wrap-around by re-anchoring reference points
                    if state.ecg_timestamp_origin_ns is not None and timestamp_ns < state.ecg_timestamp_origin_ns:
                        state.ecg_timestamp_origin_ns = timestamp_ns
                        state.ecg_time_origin = now
                        state.ecg_sample_index = 0

                    if state.ecg_time_origin is None or state.ecg_timestamp_origin_ns is None:
                        state.ecg_time_origin = now
                        state.ecg_timestamp_origin_ns = timestamp_ns

                    base_time = state.ecg_time_origin + dt.timedelta(
                        seconds=(timestamp_ns - state.ecg_timestamp_origin_ns) / 1_000_000_000
                    )

                    timestamps = [
                        base_time + dt.timedelta(seconds=i / sample_rate)
                        for i in range(len(samples))
                    ]

                    # Update deques for real-time viewing only
                    state.ecg_rate = sample_rate
                    state.ecg_ts.extend(timestamps)
                    state.ecg_vals.extend(samples)
                    state.ecg_sample_index += len(samples)

                    # ECG is in-memory only for real-time visualization.

            # Start ECG streaming
            start_cmd = bytes([PMD_CMD_START_MEASUREMENT, PMD_TYPE_ECG, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0E, 0x00])
            await client.write_gatt_char(PMD_CONTROL_UUID, start_cmd)
            await client.start_notify(PMD_DATA_UUID, on_ecg_data)

            while not stop.is_set():
                await asyncio.sleep(0.5)

            # Stop streaming
            stop_cmd = bytes([PMD_CMD_STOP_MEASUREMENT, PMD_TYPE_ECG])
            await client.write_gatt_char(PMD_CONTROL_UUID, stop_cmd)
            await client.stop_notify(PMD_DATA_UUID)

    except Exception as exc:
        print(f"[ECG] Stream error: {exc}")

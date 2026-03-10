"""Heart rate measurement parsing."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class HeartRateMeasurement:
    """Structured representation of a Polar heart-rate packet."""

    heart_rate: int
    contact_detected: bool | None
    energy_expended: int | None
    rr_intervals_ms: list[float]

    @property
    def latest_rr(self) -> float:
        """Return the most recent RR interval from the packet."""

        return self.rr_intervals_ms[-1] if self.rr_intervals_ms else float("nan")


def parse_hr_measurement(data: bytes) -> HeartRateMeasurement | None:
    """Parse the Bluetooth Heart Rate Measurement characteristic payload.

    Parameters
    ----------
    data:
        Raw payload from characteristic ``0x2A37``.

    Returns
    -------
    HeartRateMeasurement | None
        Parsed measurement or ``None`` if the payload is invalid.
    """

    if not data:
        return None

    idx = 0
    flags = data[idx]
    idx += 1

    hr_16bit = bool(flags & 0b0000_0001)
    contact_supported = bool(flags & 0b0000_0010)
    contact_detected_flag = bool(flags & 0b0000_0100)
    energy_present = bool(flags & 0b0000_1000)
    rr_present = bool(flags & 0b0001_0000)

    try:
        if hr_16bit:
            heart_rate = int.from_bytes(data[idx : idx + 2], "little")
            idx += 2
        else:
            heart_rate = data[idx]
            idx += 1
    except IndexError:
        return None

    energy_expended: int | None = None
    if energy_present:
        if idx + 2 > len(data):
            return None
        energy_expended = int.from_bytes(data[idx : idx + 2], "little")
        idx += 2

    rr_intervals_ms: list[float] = []
    if rr_present:
        while idx + 1 < len(data):
            rr = int.from_bytes(data[idx : idx + 2], "little")
            idx += 2
            rr_ms = (rr / 1024.0) * 1000.0
            rr_intervals_ms.append(rr_ms)

    return HeartRateMeasurement(
        heart_rate=heart_rate,
        contact_detected=contact_detected_flag if contact_supported else None,
        energy_expended=energy_expended,
        rr_intervals_ms=rr_intervals_ms,
    )


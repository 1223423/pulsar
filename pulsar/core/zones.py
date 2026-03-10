"""Heart-rate zone utilities."""
from __future__ import annotations

from dataclasses import dataclass
import math


@dataclass(frozen=True)
class Zone:
    low: int
    high: int
    label: str
    color: str


def hr_zones(hr_max: int) -> list[Zone]:
    """Return Polar-style training zones for the supplied max heart-rate."""

    edges = [0.0, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00]
    labels = ["Below Zone I", "Zone I", "Zone II", "Zone III", "Zone IV", "Zone V"]
    colors = ["#0a0f14", "#0e5336", "#0c6a41", "#0a7f4b", "#0d8f53", "#ad2f2f"]
    zones: list[Zone] = []
    for idx, label in enumerate(labels):
        lo = int(hr_max * edges[idx])
        hi = int(hr_max * edges[idx + 1])
        zones.append(Zone(lo, hi, label, colors[idx]))
    return zones


def zone_label_and_color(hr: float | None, hr_max: int) -> tuple[str, str, float]:
    """Return zone label, color, and fractional intensity."""

    if hr is None or math.isnan(hr):
        return "—", "#445069", float("nan")

    z = hr / hr_max
    if z < 0.50:
        return "<50%", "#445069", z
    if z <= 0.60:
        return "Zone I", "#0e5336", z
    if z <= 0.70:
        return "Zone II", "#0c6a41", z
    if z <= 0.80:
        return "Zone III", "#0a7f4b", z
    if z <= 0.90:
        return "Zone IV", "#0d8f53", z
    return "Zone V", "#ad2f2f", z

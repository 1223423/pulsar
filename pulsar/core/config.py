"""Application configuration."""
from dataclasses import dataclass


@dataclass(frozen=True)
class AppConfig:
    """Core application settings."""
    host: str = "127.0.0.1"
    port: int = 8050
    hr_max: int = 189

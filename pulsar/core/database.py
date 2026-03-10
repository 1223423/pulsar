"""Database storage for sessions and samples."""
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from threading import Lock


class DatabaseStorage:
    """Thread-safe database operations for session persistence."""

    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = Lock()
        self._init_schema()

    @contextmanager
    def get_connection(self):
        """Context manager for database connections."""
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def _init_schema(self):
        """Initialize database schema if not exists."""
        with self.get_connection() as conn:
            # Sessions table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_name TEXT,
                    device_id TEXT,
                    started_at TEXT NOT NULL,
                    ended_at TEXT,
                    hr_max INTEGER,
                    notes TEXT,
                    status TEXT DEFAULT 'active',
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Samples table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS samples (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER NOT NULL,
                    stream TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    sample_index INTEGER,
                    heart_rate_bpm REAL,
                    rr_ms REAL,
                    ecg_uv REAL,
                    recording BOOLEAN DEFAULT 0,
                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                )
            """)

            # Indexes for samples
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_samples_session_ts
                ON samples(session_id, timestamp)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_samples_session_stream
                ON samples(session_id, stream)
            """)

            # Markers table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS markers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER NOT NULL,
                    marker_id TEXT UNIQUE NOT NULL,
                    timestamp TEXT NOT NULL,
                    label TEXT,
                    sample_index INTEGER,
                    color TEXT DEFAULT '#f4be37',
                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_markers_session
                ON markers(session_id)
            """)

            conn.commit()

    # Session operations
    def create_session(self, device_name: str, device_id: str, hr_max: int, started_at: str) -> int:
        """Create new session and return session_id."""
        with self.lock:
            with self.get_connection() as conn:
                cursor = conn.execute(
                    """INSERT INTO sessions (device_name, device_id, hr_max, started_at, status)
                       VALUES (?, ?, ?, ?, 'active')""",
                    (device_name, device_id, hr_max, started_at)
                )
                conn.commit()
                return cursor.lastrowid

    def end_session(self, session_id: int, ended_at: str):
        """Mark session as ended."""
        with self.lock:
            with self.get_connection() as conn:
                conn.execute(
                    """UPDATE sessions
                       SET status = 'ended', ended_at = ?, updated_at = CURRENT_TIMESTAMP
                       WHERE id = ?""",
                    (ended_at, session_id)
                )
                conn.commit()

    def get_session(self, session_id: int) -> dict | None:
        """Get session metadata."""
        with self.get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (session_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_all_sessions(self, limit: int = 100, offset: int = 0, status: str | None = None) -> list[dict]:
        """List all sessions, paginated and optionally filtered by status."""
        with self.get_connection() as conn:
            if status:
                rows = conn.execute(
                    """SELECT * FROM sessions
                       WHERE status = ?
                       ORDER BY started_at DESC
                       LIMIT ? OFFSET ?""",
                    (status, limit, offset)
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT * FROM sessions
                       ORDER BY started_at DESC
                       LIMIT ? OFFSET ?""",
                    (limit, offset)
                ).fetchall()
            return [dict(row) for row in rows]

    def get_active_session(self) -> dict | None:
        """Get currently active session if any."""
        with self.get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 1"
            ).fetchone()
            return dict(row) if row else None

    def update_session_notes(self, session_id: int, notes: str):
        """Update session notes."""
        with self.lock:
            with self.get_connection() as conn:
                conn.execute(
                    """UPDATE sessions
                       SET notes = ?, updated_at = CURRENT_TIMESTAMP
                       WHERE id = ?""",
                    (notes, session_id)
                )
                conn.commit()

    def delete_session(self, session_id: int) -> bool:
        """Delete a session and associated samples/markers."""
        with self.lock:
            with self.get_connection() as conn:
                conn.execute("DELETE FROM markers WHERE session_id = ?", (session_id,))
                conn.execute("DELETE FROM samples WHERE session_id = ?", (session_id,))
                result = conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
                conn.commit()
                return result.rowcount > 0

    # Sample operations
    def insert_samples_batch(self, samples: list[dict]):
        """Batch insert samples (thread-safe)."""
        if not samples:
            return

        with self.lock:
            with self.get_connection() as conn:
                conn.executemany(
                    """INSERT INTO samples
                       (session_id, stream, timestamp, sample_index, heart_rate_bpm, rr_ms, ecg_uv, recording)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    [
                        (
                            s.get("session_id"),
                            s.get("stream"),
                            s.get("timestamp"),
                            s.get("sample_index"),
                            s.get("heart_rate_bpm"),
                            s.get("rr_ms"),
                            s.get("ecg_uv"),
                            s.get("recording", False),
                        )
                        for s in samples
                    ]
                )
                conn.commit()

    def get_session_samples(
        self,
        session_id: int,
        stream: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
        limit: int | None = None,
    ) -> list[dict]:
        """Query samples with optional filters."""
        with self.get_connection() as conn:
            query = "SELECT * FROM samples WHERE session_id = ?"
            params = [session_id]

            if stream:
                query += " AND stream = ?"
                params.append(stream)

            if start_time:
                query += " AND timestamp >= ?"
                params.append(start_time)

            if end_time:
                query += " AND timestamp <= ?"
                params.append(end_time)

            query += " ORDER BY timestamp ASC"

            if limit:
                query += " LIMIT ?"
                params.append(limit)

            rows = conn.execute(query, params).fetchall()
            return [dict(row) for row in rows]

    def get_session_stats(self, session_id: int) -> dict:
        """Calculate session statistics."""
        with self.get_connection() as conn:
            # Get HR stats
            hr_stats = conn.execute(
                """SELECT
                       AVG(heart_rate_bpm) as avg_hr,
                       MAX(heart_rate_bpm) as max_hr,
                       MIN(heart_rate_bpm) as min_hr,
                       COUNT(*) as hr_count
                   FROM samples
                   WHERE session_id = ? AND heart_rate_bpm IS NOT NULL""",
                (session_id,)
            ).fetchone()

            # Get RR stats
            rr_stats = conn.execute(
                """SELECT
                       AVG(rr_ms) as avg_rr,
                       COUNT(*) as rr_count
                   FROM samples
                   WHERE session_id = ? AND rr_ms IS NOT NULL""",
                (session_id,)
            ).fetchone()

            # Get ECG count
            ecg_count = conn.execute(
                """SELECT COUNT(*) as ecg_count
                   FROM samples
                   WHERE session_id = ? AND ecg_uv IS NOT NULL""",
                (session_id,)
            ).fetchone()

            # Get time range
            time_range = conn.execute(
                """SELECT MIN(timestamp) as start_ts, MAX(timestamp) as end_ts
                   FROM samples
                   WHERE session_id = ?""",
                (session_id,)
            ).fetchone()

            return {
                "avg_hr": hr_stats["avg_hr"] if hr_stats else None,
                "max_hr": hr_stats["max_hr"] if hr_stats else None,
                "min_hr": hr_stats["min_hr"] if hr_stats else None,
                "hr_count": hr_stats["hr_count"] if hr_stats else 0,
                "avg_rr": rr_stats["avg_rr"] if rr_stats else None,
                "rr_count": rr_stats["rr_count"] if rr_stats else 0,
                "ecg_count": ecg_count["ecg_count"] if ecg_count else 0,
                "start_time": time_range["start_ts"] if time_range else None,
                "end_time": time_range["end_ts"] if time_range else None,
            }

    # Marker operations
    def insert_marker(self, session_id: int, marker_id: str, timestamp: str, label: str, sample_index: int, color: str):
        """Insert marker."""
        with self.lock:
            with self.get_connection() as conn:
                marker_key = marker_id
                for attempt in range(5):
                    try:
                        conn.execute(
                            """INSERT INTO markers (session_id, marker_id, timestamp, label, sample_index, color)
                               VALUES (?, ?, ?, ?, ?, ?)""",
                            (session_id, marker_key, timestamp, label, sample_index, color)
                        )
                        conn.commit()
                        return
                    except sqlite3.IntegrityError as exc:
                        # Some historical marker ids can collide across sessions.
                        # Retry with a deterministic suffix to avoid dropping user markers.
                        if "markers.marker_id" not in str(exc):
                            raise
                        marker_key = f"{marker_id}-{attempt + 1}"
                raise sqlite3.IntegrityError(f"Failed to insert marker after retries: {marker_id}")

    def get_session_markers(self, session_id: int) -> list[dict]:
        """Get all markers for session."""
        with self.get_connection() as conn:
            rows = conn.execute(
                """SELECT * FROM markers
                   WHERE session_id = ?
                   ORDER BY
                     CASE WHEN sample_index IS NULL THEN 1 ELSE 0 END,
                     sample_index ASC,
                     timestamp ASC,
                     id ASC""",
                (session_id,)
            ).fetchall()
            return [dict(row) for row in rows]

    def update_marker(self, session_id: int, marker_id: str, timestamp: str | None = None, label: str | None = None, color: str | None = None, sample_index: int | None = None):
        """Update marker fields."""
        fields = []
        params = []
        if timestamp is not None:
            fields.append("timestamp = ?")
            params.append(timestamp)
        if label is not None:
            fields.append("label = ?")
            params.append(label)
        if color is not None:
            fields.append("color = ?")
            params.append(color)
        if sample_index is not None:
            fields.append("sample_index = ?")
            params.append(sample_index)
        if not fields:
            return
        params.extend([session_id, marker_id])
        with self.lock:
            with self.get_connection() as conn:
                conn.execute(
                    f"UPDATE markers SET {', '.join(fields)} WHERE session_id = ? AND marker_id = ?",
                    tuple(params)
                )
                conn.commit()

    def delete_marker(self, session_id: int, marker_id: str):
        """Delete marker."""
        with self.lock:
            with self.get_connection() as conn:
                conn.execute(
                    "DELETE FROM markers WHERE session_id = ? AND marker_id = ?",
                    (session_id, marker_id)
                )
                conn.commit()

    def close(self):
        """Cleanup operations (currently a no-op for SQLite)."""
        pass

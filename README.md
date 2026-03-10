# Pulsar

Pulsar is a personal suite for Polar H10 heart rate monitor users who want to track their cardiovascular fitness & recovery at a fine level of detail.

<video src="https://private-user-images.githubusercontent.com/40682719/560625368-0337fda6-2ff6-4bc6-945f-3d5a0f266791.mp4?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3NzMxMDM1MjAsIm5iZiI6MTc3MzEwMzIyMCwicGF0aCI6Ii80MDY4MjcxOS81NjA2MjUzNjgtMDMzN2ZkYTYtMmZmNi00YmM2LTk0NWYtM2Q1YTBmMjY2NzkxLm1wND9YLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFWQ09EWUxTQTUzUFFLNFpBJTJGMjAyNjAzMTAlMkZ1cy1lYXN0LTElMkZzMyUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjYwMzEwVDAwNDAyMFomWC1BbXotRXhwaXJlcz0zMDAmWC1BbXotU2lnbmF0dXJlPTIwY2Q2NzEwMzVhMzU2MWQ4OTQzOTNjNTFiNjAwOWI5MjczMWI5ZGZlYmI3MzQ0NDRkYzIxYzY4NTJhMTNhYjEmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0In0.-2is2btwzjb5KyMkbu9_40SoKXlj0fG6tkL21KmS6eo"
       width="640" controls loop muted playsinline>
  Your browser does not support the video tag.
</video>

## Run

```bash
uv sync
uv run python -m pulsar
```
Open your browser at: `http://127.0.0.1:8050`

## App navigation

- `Pulsar` (top-left): return to main menu
- `New Session`: livestream and (optionally) record a session
- `View Recordings`: explore and edit past recorded sessions

## Hotkeys

- `[1-5]` place down preconfigured markers at current timestep
- `m` place down a custom marker at cursor location
- `e` edit a highlighted marker
- `t` post-hoc tests starting from a selected marker

## Optional CLI flags

- `--host <ip>`: bind host (default `127.0.0.1`)
- `--port <int>`: bind port (default `8050`)
- `--db <path>` or `--db-path <path>`: SQLite file path (default `~/.pulsar/sessions.db`)

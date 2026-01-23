from __future__ import annotations

from pathlib import Path

from .cache import output_dir


def clear_output_cache() -> int:
    """Delete cached wav/json files in the output directory.

    Returns number of deleted files.
    """
    out = output_dir()
    if not out.exists():
        return 0
    deleted = 0
    for p in out.glob("*"):
        if p.is_file() and p.suffix.lower() in (".wav", ".json"):
            try:
                p.unlink()
                deleted += 1
            except Exception:
                pass
    return deleted

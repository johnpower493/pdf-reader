from __future__ import annotations

from functools import lru_cache


def _extract_voice_id(path: str) -> str | None:
    # Expected: voices/<id>.pt
    if not path.startswith("voices/"):
        return None
    if not path.endswith(".pt"):
        return None
    return path[len("voices/") : -len(".pt")]


@lru_cache(maxsize=1)
def list_kokoro_voice_ids(repo_id: str = "hexgrad/Kokoro-82M") -> list[str]:
    """Return known Kokoro voice IDs.

    We query the HF repo file list and derive IDs from voices/*.pt.
    Cached for process lifetime.
    """
    try:
        from huggingface_hub import HfApi  # type: ignore
    except Exception as e:  # pragma: no cover
        raise RuntimeError("huggingface_hub is required to list voices") from e

    api = HfApi()
    files = api.list_repo_files(repo_id)

    voices: list[str] = []
    for f in files:
        vid = _extract_voice_id(f)
        if vid:
            voices.append(vid)

    voices = sorted(set(voices))

    # Keep a friendly default first if present
    if "af_heart" in voices:
        voices.remove("af_heart")
        voices.insert(0, "af_heart")

    return voices

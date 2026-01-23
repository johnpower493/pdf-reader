from __future__ import annotations

import io
from typing import Tuple

from pypdf import PdfReader


def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    reader = PdfReader(io.BytesIO(pdf_bytes))
    parts: list[str] = []
    for page in reader.pages:
        t = page.extract_text() or ""
        # normalize excessive whitespace while keeping paragraphs reasonably intact
        parts.append(t)
    text = "\n\n".join(parts)
    # Simple cleanup
    text = text.replace("\r", "\n")
    # Collapse trailing spaces
    lines = [ln.strip() for ln in text.split("\n")]
    return "\n".join([ln for ln in lines if ln != ""])


def extract_text_from_txt(txt_bytes: bytes) -> str:
    # Best-effort encoding
    for enc in ("utf-8", "utf-16", "latin-1"):
        try:
            return txt_bytes.decode(enc)
        except UnicodeDecodeError:
            continue
    return txt_bytes.decode("utf-8", errors="replace")

from __future__ import annotations

from fastapi import HTTPException

from .book_jobs import book_job_manager


def require_book_id(book_id: str | None) -> str:
    if not book_id:
        raise HTTPException(status_code=400, detail="book_id is required")
    return book_id

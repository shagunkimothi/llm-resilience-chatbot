"""SQLite persistence (SQLAlchemy): chat sessions and message history."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import Column, Index, Integer, Text, create_engine, select, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import declarative_base, sessionmaker

Base = declarative_base()


class ChatSession(Base):
    __tablename__ = "sessions"

    session_id = Column(Text, primary_key=True)
    system_prompt = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False)


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        Index("ix_messages_session_id_id", "session_id", "id"),
        {"sqlite_autoincrement": True},  # emit INTEGER PRIMARY KEY AUTOINCREMENT
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(Text, nullable=False)
    role = Column(Text, nullable=False)
    content = Column(Text, nullable=False)
    # "metadata" is reserved on declarative classes; the DB column is still "metadata".
    meta = Column("metadata", Text, nullable=True)
    created_at = Column(Text, nullable=False)


_engine: Engine | None = None
_SessionLocal: sessionmaker | None = None


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def configure_db(database_url: str) -> Engine:
    """(Re)create the engine for database_url, creating the SQLite folder if needed."""
    global _engine, _SessionLocal
    dispose_db()
    url = make_url(database_url)
    connect_args: dict[str, Any] = {}
    if url.get_backend_name() == "sqlite":
        connect_args["check_same_thread"] = False
        if url.database and url.database != ":memory:":
            Path(url.database).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
    _engine = create_engine(database_url, connect_args=connect_args)
    _SessionLocal = sessionmaker(bind=_engine, expire_on_commit=False)
    return _engine


def dispose_db() -> None:
    global _engine, _SessionLocal
    if _engine is not None:
        _engine.dispose()
    _engine, _SessionLocal = None, None


def init_db() -> None:
    Base.metadata.create_all(_require_engine())


def _require_engine() -> Engine:
    if _engine is None:
        raise RuntimeError("database not configured")
    return _engine


def _session():
    _require_engine()
    return _SessionLocal()


def ping() -> bool:
    try:
        with _require_engine().connect() as conn:
            return conn.execute(text("SELECT 1")).scalar() == 1
    except Exception:
        return False


def session_exists(session_id: str) -> bool:
    with _session() as db:
        return db.get(ChatSession, session_id) is not None


def get_system_prompt(session_id: str) -> str | None:
    with _session() as db:
        row = db.get(ChatSession, session_id)
        return row.system_prompt if row else None


def get_history(session_id: str) -> list[Message]:
    """All messages of a session, oldest first."""
    with _session() as db:
        stmt = select(Message).where(Message.session_id == session_id).order_by(Message.id)
        return list(db.scalars(stmt))


def save_exchange(
    session_id: str,
    user_text: str,
    assistant_text: str,
    metadata: dict[str, Any],
    system_prompt: str | None = None,
) -> None:
    """Write the user + assistant rows (and upsert the session) in ONE transaction."""
    now = utcnow_iso()
    with _session() as db, db.begin():
        sess = db.get(ChatSession, session_id)
        if sess is None:
            db.add(ChatSession(session_id=session_id, system_prompt=system_prompt, created_at=now))
        elif system_prompt is not None:
            sess.system_prompt = system_prompt
        db.add(Message(session_id=session_id, role="user", content=user_text, created_at=now))
        db.add(Message(session_id=session_id, role="assistant", content=assistant_text,
                       meta=json.dumps(metadata), created_at=utcnow_iso()))

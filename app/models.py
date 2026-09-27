"""The server only stores what the page computes.

A route is a JSON document (whatever fields the page gives it), with a few columns pulled out
for lookups. The old tables of the Python version ("routes", "ignored_duplicates") are left
alone; app/legacy.py copies them into these tables once.
"""
from __future__ import annotations

from sqlalchemy import JSON, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class RouteDoc(Base):
    __tablename__ = "library_routes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    file_hash: Mapped[str] = mapped_column(String(64), index=True)
    track_hash: Mapped[str | None] = mapped_column(String(64), index=True)
    # When the route was last saved (ISO 8601, set by the server): a save based on an older
    # version is refused, so two open pages don't overwrite each other's changes.
    updated_at: Mapped[str] = mapped_column(String(40))
    data: Mapped[dict] = mapped_column(JSON)


class StoredFile(Base):
    """An original GPX file, by the SHA-256 of its bytes."""

    __tablename__ = "library_files"

    hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(500))  # original file name
    path: Mapped[str] = mapped_column(String(1000))  # relative to GPX_DIR


class IgnoredFile(Base):
    """A GPX file in the GPX folder that is not offered for import (by content, so every copy
    of it is ignored): a duplicate of a route already in the library, a file that can't be
    read, or one the user dismissed."""

    __tablename__ = "library_ignored_files"

    hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    path: Mapped[str] = mapped_column(String(1000))  # where it was when it was ignored
    reason: Mapped[str | None] = mapped_column(String(300))
    ignored_at: Mapped[str] = mapped_column(String(40))


class IgnoredPair(Base):
    """Two routes the user marked as "not duplicates" (key "a_b", a < b)."""

    __tablename__ = "library_ignored"

    key: Mapped[str] = mapped_column(String(40), primary_key=True)


class Setting(Base):
    __tablename__ = "library_settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[object] = mapped_column(JSON, nullable=True)

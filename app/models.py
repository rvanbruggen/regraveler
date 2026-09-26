from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Route(Base):
    __tablename__ = "routes"
    # A GPX file may contain several tracks; each track is its own route.
    __table_args__ = (UniqueConstraint("file_hash", "track_index", name="uq_file_track"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(300))
    slug: Mapped[str] = mapped_column(String(300), unique=True, index=True)

    # Original file, relative to GPX_DIR. Never modified.
    gpx_path: Mapped[str] = mapped_column(String(1000))
    original_filename: Mapped[str] = mapped_column(String(500))
    track_index: Mapped[int] = mapped_column(Integer, default=0)
    track_name: Mapped[str | None] = mapped_column(String(300))
    file_hash: Mapped[str] = mapped_column(String(64), index=True)
    # Hash of the track's coordinates (rounded): the same track in a different file.
    track_hash: Mapped[str | None] = mapped_column(String(64), index=True)

    # Computed on import
    distance_km: Mapped[float] = mapped_column(Float)
    elevation_gain_m: Mapped[float | None] = mapped_column(Float)
    elevation_loss_m: Mapped[float | None] = mapped_column(Float)
    min_elevation_m: Mapped[float | None] = mapped_column(Float)
    max_elevation_m: Mapped[float | None] = mapped_column(Float)
    start_lat: Mapped[float] = mapped_column(Float)
    start_lon: Mapped[float] = mapped_column(Float)
    end_lat: Mapped[float] = mapped_column(Float)
    end_lon: Mapped[float] = mapped_column(Float)
    min_lat: Mapped[float] = mapped_column(Float)
    min_lon: Mapped[float] = mapped_column(Float)
    max_lat: Mapped[float] = mapped_column(Float)
    max_lon: Mapped[float] = mapped_column(Float)
    is_loop: Mapped[bool] = mapped_column(Boolean)
    # Simplified [[lat, lon], ...] for map display and geometry comparisons.
    geometry: Mapped[list] = mapped_column(JSON)

    # User metadata. Add new fields here (nullable); db.init_db adds the column.
    activity: Mapped[str | None] = mapped_column(String(20), index=True)  # gravel / road / hiking
    quality_rating: Mapped[int | None] = mapped_column(Integer)
    paved_pct: Mapped[float | None] = mapped_column(Float)
    paved_source: Mapped[str | None] = mapped_column(String(20))  # "manual" or "estimated"
    # Surface estimate from OpenStreetMap (see app/surface.py), or None.
    surface: Mapped[dict | None] = mapped_column(JSON)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    notes: Mapped[str | None] = mapped_column(Text)

    # Provenance
    source_name: Mapped[str | None] = mapped_column(String(300), index=True)
    source_url: Mapped[str | None] = mapped_column(String(1000))
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    # Derivation: ids of parent routes for combined routes (phase 3).
    derived_from: Mapped[list] = mapped_column(JSON, default=list)

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        return (self.min_lat, self.min_lon, self.max_lat, self.max_lon)


class IgnoredDuplicate(Base):
    """A pair of routes the user marked as "not duplicates"."""

    __tablename__ = "ignored_duplicates"
    __table_args__ = (UniqueConstraint("a_id", "b_id", name="uq_ignored_pair"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    a_id: Mapped[int] = mapped_column(Integer, index=True)  # always the smaller id
    b_id: Mapped[int] = mapped_column(Integer, index=True)

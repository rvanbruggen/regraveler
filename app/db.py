"""Database engine, session and a minimal schema migration."""
from __future__ import annotations

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from . import config


class Base(DeclarativeBase):
    pass


engine = None
SessionLocal = sessionmaker(autoflush=False, expire_on_commit=False)


def init_db(url: str | None = None) -> None:
    """Create the engine, create missing tables and add missing columns."""
    global engine
    url = url or config.DATABASE_URL
    if url.startswith("sqlite:///") and url != "sqlite:///:memory:":
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    engine = create_engine(url, connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    SessionLocal.configure(bind=engine)
    from . import models  # noqa: F401  (register models)

    Base.metadata.create_all(engine)
    _add_missing_columns()


def _add_missing_columns() -> None:
    """Add columns that exist on the models but not yet in the database.

    This keeps metadata easy to extend: add a nullable column to the model and it
    appears in an existing database on the next start. (No renames or type changes.)
    """
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name not in existing:
                    coltype = col.type.compile(dialect=engine.dialect)
                    conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {coltype}'))


def get_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()

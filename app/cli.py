"""Command line tools.

    python -m app.cli backup <file.zip>     the whole library as a backup zip
    python -m app.cli restore <file.zip>    replace the library with a backup
    python -m app.cli migrate               move a library of the Python version (0.7.x) to the
                                            new store (also happens by itself at start-up)

Importing GPX files happens in the page: drop files or folders on the Import screen, or add
the files that are already in the GPX folder from there.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import db, legacy, store


def cmd_backup(args) -> int:
    with db.SessionLocal() as session:
        data = store.backup_zip(session)
    Path(args.file).write_bytes(data)
    print(f"Backup written to {args.file} ({len(data) / 1e6:.1f} MB)")
    return 0


def cmd_restore(args) -> int:
    with db.SessionLocal() as session:
        res = store.restore(session, Path(args.file).read_bytes())
    print(f"Restored {res['routes']} routes ({res['files']} GPX files)")
    return 0


def cmd_migrate(_args) -> int:
    with db.SessionLocal() as session:
        if not legacy.needed(session):
            print("Nothing to move: no library of the Python version, or the new store already has routes.")
            return 0
        res = legacy.migrate(session)
    print(f"Moved {res['routes']} routes, {res['files']} GPX files, {res['ignored_pairs']} 'not duplicates' pairs")
    for path in res["missing_files"]:
        print(f"  missing on disk: {path}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m app.cli", description="rerouter command line tools")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backup", help="write the whole library to a backup zip")
    b.add_argument("file")
    r = sub.add_parser("restore", help="replace the library with a backup zip")
    r.add_argument("file")
    sub.add_parser("migrate", help="move a library of the Python version to the new store")
    args = ap.parse_args(argv)
    try:
        db.init_db()
        return {"backup": cmd_backup, "restore": cmd_restore, "migrate": cmd_migrate}[args.cmd](args)
    except store.StoreError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

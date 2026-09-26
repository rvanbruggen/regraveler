"""Command line tools.

    python -m app.cli import <folder> [--source-name NAME] [--source-url URL] [--no-source-from-folder]
    python -m app.cli recompute
    python -m app.cli estimate-surface [--all] [--overwrite-manual]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from sqlalchemy import select

from . import brouter, config, db, surface
from .gpxstats import compute_stats, parse_gpx
from .importer import import_folder
from .models import Route


def cmd_import(args) -> int:
    folder = Path(args.folder)
    if not folder.is_dir():
        print(f"Not a folder: {folder}", file=sys.stderr)
        return 2
    counts = {"imported": 0, "partial": 0, "duplicate": 0, "error": 0}

    def progress(res):
        counts[res.status] += 1
        label = {"imported": "OK  ", "partial": "PART", "duplicate": "DUP ", "error": "ERR "}[res.status]
        names = ", ".join(r["name"] for r in res.routes)
        line = f"{label} {res.filename}"
        if names and names != Path(res.filename).stem:
            line += f" -> {names}"
        if res.message:
            line += f"  ({res.message})"
        print(line)
        for s in res.similar:
            print(f"     similar: '{s['route_name']}' ~ '{s['other_name']}' ({s['overlap']:.0%} overlap)")

    db.init_db()
    with db.SessionLocal() as session:
        import_folder(
            session,
            folder,
            source_name=args.source_name,
            source_url=args.source_url,
            source_from_folder=not args.no_source_from_folder,
            progress=progress,
        )
    print(
        f"\nImported: {counts['imported'] + counts['partial']} file(s), "
        f"duplicates skipped: {counts['duplicate']}, errors: {counts['error']}"
    )
    return 1 if counts["error"] else 0


def cmd_recompute(_args) -> int:
    """Recompute stats of all routes from their GPX files (after changing the algorithm)."""
    db.init_db()
    with db.SessionLocal() as session:
        for route in session.scalars(select(Route)).all():
            path = config.GPX_DIR / route.gpx_path
            if not path.is_file():
                print(f"MISSING {route.gpx_path}")
                continue
            tracks = parse_gpx(path.read_bytes()).tracks
            if route.track_index >= len(tracks):
                print(f"MISSING track {route.track_index} in {route.gpx_path}")
                continue
            st = compute_stats(tracks[route.track_index].points)
            for key, value in st.__dict__.items():
                setattr(route, key, value)
            print(f"OK   {route.name}: {st.distance_km} km, {st.elevation_gain_m} m")
        session.commit()
    return 0


def cmd_estimate_surface(args) -> int:
    """Estimate the surface of routes via BRouter (only routes without an estimate, unless --all)."""
    from .main import load_track

    db.init_db()
    failed = 0
    with db.SessionLocal() as session:
        routes = session.scalars(select(Route).order_by(Route.name)).all()
        todo = [r for r in routes if args.all or not r.surface]
        print(f"Estimating the surface of {len(todo)} route(s) via {config.BROUTER_URL}")
        for route in todo:
            try:
                result = surface.estimate(load_track(route))
            except brouter.BRouterUnavailable as exc:
                print(f"ERR  {exc}")
                return 2
            except Exception as exc:
                failed += 1
                print(f"ERR  {route.name}: {getattr(exc, 'detail', exc)}")
                continue
            applied = surface.apply_estimate(route, result, args.overwrite_manual)
            session.commit()
            pct = "?" if result["paved_pct"] is None else f"{result['paved_pct']}%"
            note = "" if applied else f"  (kept your {route.paved_pct:g}%)"
            print(f"OK   {route.name}: {pct} paved, {result['cobbles_km']} km cobbles{note}")
    return 1 if failed else 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description="Gravel Route Manager tools")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("import", help="Import all .gpx files in a folder (recursively)")
    p.add_argument("folder")
    p.add_argument("--source-name", help="Source name for all files (default: subfolder name)")
    p.add_argument("--source-url", help="Source URL for all files (default: link found in the GPX)")
    p.add_argument(
        "--no-source-from-folder",
        action="store_true",
        help="Don't use the subfolder name as source name",
    )
    p.set_defaults(func=cmd_import)

    p = sub.add_parser("recompute", help="Recompute stats for all routes from their GPX files")
    p.set_defaults(func=cmd_recompute)

    p = sub.add_parser("estimate-surface", help="Estimate paved %% from OpenStreetMap via BRouter")
    p.add_argument("--all", action="store_true", help="Also routes that already have an estimate")
    p.add_argument("--overwrite-manual", action="store_true", help="Replace paved %% values you entered yourself")
    p.set_defaults(func=cmd_estimate_surface)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

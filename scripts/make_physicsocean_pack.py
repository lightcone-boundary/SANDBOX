#!/usr/bin/env python3
"""Build distributable PhysicsOcean content packs from a local corpus.

Produces two gzip-compressed tar archives, each with a sibling ``.sha256``
checksum and a shared ``manifest.json``:

    physicsocean-textbooks-<date>.tar.gz   .tex + search.db + books.md/json
    physicsocean-arxiv-<date>.tar.gz       arxiv_meta.db only

The split keeps the multi-gigabyte arXiv mirror out of the textbook pack so a
textbook edit never forces re-packing the large database. The npm package's
``sandbox data install`` command imports either or both.

Only the Python standard library is used (tarfile + gzip + sqlite3 + hashlib),
so pack production runs identically on macOS, Linux, and Windows without an
external ``tar``/``zstd`` binary.

SQLite databases are checkpointed (``PRAGMA wal_checkpoint(TRUNCATE)``) before
packing so the write-ahead-log sidecars (``-wal``/``-shm``) are folded into the
main file; those sidecars are never packed, since shipping them mid-write would
corrupt the database on import. The per-tester ``arxiv/`` saved-papers folder is
also excluded so an imported pack never clobbers a tester's own fetched papers.

Usage:
    python scripts/make_physicsocean_pack.py [--root ~/sandbox/PhysicsOcean]
        [--out-dir .] [--date YYYY-MM-DD] [--only textbooks|arxiv]
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sqlite3
import sys
import tarfile
from datetime import date
from pathlib import Path

_sandbox_home = Path(os.environ.get("SANDBOX_HOME", str(Path.home() / "sandbox")))
DEFAULT_ROOT = _sandbox_home / "PhysicsOcean"
TEXTBOOK_DBS = ("search.db",)
ARXIV_DBS = ("arxiv_meta.db",)
CATALOG_FILES = ("books.md", "books.json")
HASH_CHUNK = 1024 * 1024


def _checkpoint(db_path: Path) -> None:
    if not db_path.exists():
        return
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.commit()
    finally:
        conn.close()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(HASH_CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def _row_count(db_path: Path, table: str) -> int | None:
    if not db_path.exists():
        return None
    conn = sqlite3.connect(str(db_path))
    try:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def _sync_state(db_path: Path, key: str) -> str | None:
    if not db_path.exists():
        return None
    conn = sqlite3.connect(str(db_path))
    try:
        row = conn.execute(
            "SELECT value FROM sync_state WHERE key = ?", (key,)
        ).fetchone()
        return row[0] if row else None
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def _write_tar_gz(members: list[tuple[Path, str]], out_path: Path) -> None:
    with gzip.GzipFile(filename="", mode="wb", fileobj=out_path.open("wb"), mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w") as tar:
            for source, arcname in members:
                tar.add(str(source), arcname=arcname)


def _collect_textbook_members(root: Path) -> list[tuple[Path, str]]:
    members: list[tuple[Path, str]] = []
    for tex in sorted(root.glob("*.tex")):
        members.append((tex, tex.name))
    for name in (*TEXTBOOK_DBS, *CATALOG_FILES):
        candidate = root / name
        if candidate.exists():
            members.append((candidate, name))
    return members


def _collect_arxiv_members(root: Path) -> list[tuple[Path, str]]:
    members: list[tuple[Path, str]] = []
    for name in ARXIV_DBS:
        candidate = root / name
        if candidate.exists():
            members.append((candidate, name))
    return members


def _finalize(out_path: Path) -> tuple[dict[str, object], str]:
    checksum = _sha256(out_path)
    (out_path.parent / f"{out_path.name}.sha256").write_text(
        f"{checksum}  {out_path.name}\n"
    )
    entry: dict[str, object] = {
        "file": out_path.name,
        "size_bytes": out_path.stat().st_size,
        "sha256": checksum,
    }
    return entry, checksum


def build(root: Path, out_dir: Path, stamp: str, only: str | None) -> int:
    if not root.is_dir():
        print(f"error: corpus root not found: {root}", file=sys.stderr)
        return 2
    out_dir.mkdir(parents=True, exist_ok=True)

    packs: dict[str, dict[str, object]] = {}
    manifest: dict[str, object] = {"date": stamp, "packs": packs}

    if only in (None, "textbooks"):
        members = _collect_textbook_members(root)
        tex_count = sum(1 for _, name in members if name.endswith(".tex"))
        if tex_count == 0:
            print(f"error: no .tex files under {root}", file=sys.stderr)
            return 2
        out_path = out_dir / f"physicsocean-textbooks-{stamp}.tar.gz"
        print(f"Packing {tex_count} textbooks + search.db -> {out_path.name}")
        _checkpoint(root / "search.db")
        _write_tar_gz(_collect_textbook_members(root), out_path)
        entry, checksum = _finalize(out_path)
        entry["tex_files"] = tex_count
        entry["search_passages"] = _row_count(root / "search.db", "passages")
        packs["textbooks"] = entry
        print(f"  -> {out_path.stat().st_size} bytes, sha256 {checksum}")

    if only in (None, "arxiv"):
        out_path = out_dir / f"physicsocean-arxiv-{stamp}.tar.gz"
        arxiv_db = root / "arxiv_meta.db"
        if not arxiv_db.exists():
            print(f"error: arxiv_meta.db not found under {root}", file=sys.stderr)
            return 2
        last_synced = _sync_state(arxiv_db, "last_synced_until")
        if not last_synced:
            print(
                "warning: arxiv_meta.db has no sync_state.last_synced_until; "
                "the native plugin cannot determine which date ranges the mirror covers.",
                file=sys.stderr,
            )
        print(f"Packing arxiv_meta.db -> {out_path.name}")
        _checkpoint(arxiv_db)
        _write_tar_gz(_collect_arxiv_members(root), out_path)
        entry, checksum = _finalize(out_path)
        entry["paper_rows"] = _row_count(arxiv_db, "papers")
        entry["last_synced_until"] = last_synced
        packs["arxiv"] = entry
        print(f"  -> {out_path.stat().st_size} bytes, sha256 {checksum}")

    manifest_path = out_dir / f"physicsocean-manifest-{stamp}.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(f"Manifest: {manifest_path}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build PhysicsOcean content packs.")
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--out-dir", default=".")
    parser.add_argument("--date", default=date.today().isoformat())
    parser.add_argument("--only", choices=("textbooks", "arxiv"), default=None)
    return parser


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    return build(
        Path(args.root).expanduser().resolve(),
        Path(args.out_dir).expanduser().resolve(),
        args.date,
        args.only,
    )


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

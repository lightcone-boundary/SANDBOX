#!/usr/bin/env python3
"""Harvest arXiv paper metadata via OAI-PMH into a local SQLite + FTS5 database.

This is a standalone maintainer CLI that talks to arXiv's official OAI-PMH
endpoint (https://oaipmh.arxiv.org/oai) and incrementally upserts paper
metadata into a SQLite database. The schema is fixed (see ``SCHEMA_SQL``)
because the native OpenCode plugin queries the ``papers_fts`` virtual table.

Only the Python standard library is used (urllib + xml.etree + sqlite3).
No new pip dependencies are introduced.

Usage examples
--------------

Bootstrap the entire arXiv corpus (slow, hours)::

    python scripts/arxiv_oai_sync.py --bootstrap

Harvest an explicit window (inclusive on both ends)::

    python scripts/arxiv_oai_sync.py --from 2024-10-01 --until 2024-10-02

Default incremental mode (reads ``sync_state.last_synced_until``)::

    python scripts/arxiv_oai_sync.py

Inspect the database without harvesting::

    python scripts/arxiv_oai_sync.py --status

The OAI-PMH ``set=physics`` umbrella set is used, which covers the physics
sub-archives (hep-th, gr-qc, cond-mat, astro-ph, hep-ph, ...). Records with
``status="deleted"`` headers are skipped. Upserts on the ``arxiv_id`` unique
key make the harvester safe to re-run; commits per OAI batch make an
interrupted harvest resumable on the next page.
"""

from __future__ import annotations

import argparse
import os
import random
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from collections.abc import Iterable, Iterator
from typing import Any

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

OAI_ENDPOINT = "https://oaipmh.arxiv.org/oai"
OAI_METADATA_PREFIX = "arXiv"
OAI_SET = "physics"
OAI_NS = "http://www.openarchives.org/OAI/2.0/"
ARXIV_NS = "http://arxiv.org/OAI/arXiv/"

USER_AGENT = "SANDBOX-arxiv-oai-sync/1.0 (+https://arxiv.org/help/oa)"
POLITENESS_DELAY_SECONDS = 4.0
BACKOFF_BASE_SECONDS = 5.0
BACKOFF_MAX_SECONDS = 300.0
BACKOFF_MAX_ATTEMPTS = 8
# Measured: during load-shedding the server takes 180s+ just to deliver its
# 503 + Retry-After. A shorter read timeout turns polite flow-control into
# blind retry-burning.
READ_TIMEOUT_SECONDS = 300

# Sentinel meaning "everything". The server REJECTS from-dates earlier than
# its Identify.earliestDatestamp (2005-09-16 at time of writing) with
# badArgument "start date too early", so run_harvest clamps this at runtime.
BOOTSTRAP_FROM = "1991-01-01"
DEFAULT_INCREMENTAL_OVERLAP_DAYS = 1
RESUME_FALLBACK_MARGIN_DAYS = 3

SYNC_KEY_LAST_UNTIL = "last_synced_until"
SYNC_KEY_LAST_DATESTAMP = "last_record_datestamp"

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS sync_state(
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS papers(
  id INTEGER PRIMARY KEY,
  arxiv_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  abstract TEXT NOT NULL,
  authors TEXT NOT NULL,
  categories TEXT NOT NULL,
  primary_category TEXT NOT NULL,
  published TEXT NOT NULL,
  updated TEXT NOT NULL,
  doi TEXT,
  journal_ref TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
  title, abstract, authors, categories,
  content='papers', content_rowid='id', tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS papers_ai AFTER INSERT ON papers BEGIN
  INSERT INTO papers_fts(rowid, title, abstract, authors, categories)
  VALUES (new.id, new.title, new.abstract, new.authors, new.categories);
END;

CREATE TRIGGER IF NOT EXISTS papers_ad AFTER DELETE ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, abstract, authors, categories)
  VALUES ('delete', old.id, old.title, old.abstract, old.authors, old.categories);
END;

CREATE TRIGGER IF NOT EXISTS papers_au AFTER UPDATE ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, abstract, authors, categories)
  VALUES ('delete', old.id, old.title, old.abstract, old.authors, old.categories);
  INSERT INTO papers_fts(rowid, title, abstract, authors, categories)
  VALUES (new.id, new.title, new.abstract, new.authors, new.categories);
END;
"""

UPSERT_SQL = """
INSERT INTO papers (
  arxiv_id, title, abstract, authors, categories, primary_category,
  published, updated, doi, journal_ref
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(arxiv_id) DO UPDATE SET
  title = excluded.title,
  abstract = excluded.abstract,
  authors = excluded.authors,
  categories = excluded.categories,
  primary_category = excluded.primary_category,
  published = excluded.published,
  updated = excluded.updated,
  doi = excluded.doi,
  journal_ref = excluded.journal_ref
"""


# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------


def _log(message: str) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] {message}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------


def default_db_path() -> Path:
    base_env = os.environ.get("SANDBOX_HOME", "").strip()
    base = Path(base_env) if base_env else Path.home() / "sandbox"
    return base / "PhysicsOcean" / "arxiv_meta.db"


def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA_SQL)
    conn.commit()
    return conn


def fts5_available() -> bool:
    try:
        probe = sqlite3.connect(":memory:")
        probe.execute("CREATE VIRTUAL TABLE _probe USING fts5(x)")
        probe.close()
        return True
    except sqlite3.OperationalError:
        return False


def get_sync_state(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute(
        "SELECT value FROM sync_state WHERE key = ?", (key,)
    ).fetchone()
    return row[0] if row else None


def set_sync_state(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO sync_state(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


# ---------------------------------------------------------------------------
# OAI-PMH record model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ArxivRecord:
    arxiv_id: str
    title: str
    abstract: str
    authors: str
    categories: str
    primary_category: str
    published: str
    updated: str
    doi: str | None
    journal_ref: str | None

    def as_row(self) -> tuple[Any, ...]:
        return (
            self.arxiv_id,
            self.title,
            self.abstract,
            self.authors,
            self.categories,
            self.primary_category,
            self.published,
            self.updated,
            self.doi,
            self.journal_ref,
        )


# ---------------------------------------------------------------------------
# XML parsing
# ---------------------------------------------------------------------------


def _normalize_whitespace(value: str | None) -> str:
    if not value:
        return ""
    return " ".join(value.split())


def _text(elem: ET.Element | None) -> str:
    if elem is None or elem.text is None:
        return ""
    return elem.text


def _format_author(author_elem: ET.Element) -> str:
    forenames = _normalize_whitespace(_text(author_elem.find(f"{{{ARXIV_NS}}}forenames")))
    keyname = _normalize_whitespace(_text(author_elem.find(f"{{{ARXIV_NS}}}keyname")))
    suffix = _normalize_whitespace(_text(author_elem.find(f"{{{ARXIV_NS}}}suffix")))
    parts = [p for p in (forenames, keyname) if p]
    name = " ".join(parts) if parts else ""
    if suffix:
        name = f"{name} {suffix}".strip()
    return name


def _date_only(value: str | None) -> str:
    if not value:
        return ""
    value = value.strip()
    # arXiv created/updated are YYYY-MM-DD already, but be defensive.
    return value[:10]


def parse_record(record_elem: ET.Element) -> ArxivRecord | None:
    """Parse one ``<record>`` element. Returns None for deleted records."""

    header = record_elem.find(f"{{{OAI_NS}}}header")
    if header is not None and header.get("status") == "deleted":
        return None

    metadata = record_elem.find(f"{{{OAI_NS}}}metadata")
    if metadata is None:
        return None
    arxiv_elem = metadata.find(f"{{{ARXIV_NS}}}arXiv")
    if arxiv_elem is None:
        return None

    arxiv_id = _normalize_whitespace(_text(arxiv_elem.find(f"{{{ARXIV_NS}}}id")))
    if not arxiv_id:
        return None

    title = _normalize_whitespace(_text(arxiv_elem.find(f"{{{ARXIV_NS}}}title")))
    abstract = _normalize_whitespace(_text(arxiv_elem.find(f"{{{ARXIV_NS}}}abstract")))
    categories_raw = _normalize_whitespace(
        _text(arxiv_elem.find(f"{{{ARXIV_NS}}}categories"))
    )
    categories_tokens = [tok for tok in categories_raw.split() if tok]
    categories = " ".join(categories_tokens)
    primary_category = categories_tokens[0] if categories_tokens else ""

    authors_elem = arxiv_elem.find(f"{{{ARXIV_NS}}}authors")
    author_names: list[str] = []
    if authors_elem is not None:
        for author_elem in authors_elem.findall(f"{{{ARXIV_NS}}}author"):
            name = _format_author(author_elem)
            if name:
                author_names.append(name)
    authors = ", ".join(author_names)

    created = _date_only(_text(arxiv_elem.find(f"{{{ARXIV_NS}}}created")))
    updated = _date_only(_text(arxiv_elem.find(f"{{{ARXIV_NS}}}updated"))) or created

    doi_text = _normalize_whitespace(_text(arxiv_elem.find(f"{{{ARXIV_NS}}}doi"))) or None
    journal_ref = (
        _normalize_whitespace(_text(arxiv_elem.find(f"{{{ARXIV_NS}}}journal-ref"))) or None
    )

    if not (title and abstract and authors and categories and primary_category and created):
        # Skip pathological records rather than insert NOT NULL violations.
        return None

    return ArxivRecord(
        arxiv_id=arxiv_id,
        title=title,
        abstract=abstract,
        authors=authors,
        categories=categories,
        primary_category=primary_category,
        published=created,
        updated=updated,
        doi=doi_text,
        journal_ref=journal_ref,
    )


def iter_records(root: ET.Element) -> Iterator[ArxivRecord]:
    list_records = root.find(f"{{{OAI_NS}}}ListRecords")
    if list_records is None:
        return
    for record_elem in list_records.findall(f"{{{OAI_NS}}}record"):
        record = parse_record(record_elem)
        if record is not None:
            yield record


def parse_resumption_token(root: ET.Element) -> str | None:
    list_records = root.find(f"{{{OAI_NS}}}ListRecords")
    if list_records is None:
        return None
    token_elem = list_records.find(f"{{{OAI_NS}}}resumptionToken")
    if token_elem is None or token_elem.text is None:
        return None
    text = token_elem.text.strip()
    return text or None


def parse_oai_error(root: ET.Element) -> tuple[str, str] | None:
    err = root.find(f"{{{OAI_NS}}}error")
    if err is None:
        return None
    return (err.get("code") or "unknown", (err.text or "").strip())


# ---------------------------------------------------------------------------
# OAI-PMH HTTP client
# ---------------------------------------------------------------------------


class OAITransientError(Exception):
    """Retryable failure (5xx, connection error, malformed body)."""


class OAIFatalError(Exception):
    """Non-retryable failure (4xx other than 503, fatal OAI error code)."""


def _build_url(params: dict[str, str]) -> str:
    return f"{OAI_ENDPOINT}?{urllib.parse.urlencode(params)}"


def _sleep_with_jitter(base_seconds: float) -> None:
    jitter = random.uniform(0, base_seconds * 0.25)
    time.sleep(base_seconds + jitter)


def _backoff_seconds(attempt: int) -> float:
    return min(BACKOFF_BASE_SECONDS * (2 ** attempt), BACKOFF_MAX_SECONDS)


def fetch_oai(params: dict[str, str]) -> ET.Element:
    """Fetch one OAI-PMH response, honoring 503 Retry-After and backoff."""

    url = _build_url(params)
    last_error: Exception | None = None

    for attempt in range(BACKOFF_MAX_ATTEMPTS):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=READ_TIMEOUT_SECONDS) as response:
                body = response.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 503:
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                wait = _backoff_seconds(attempt)
                if retry_after:
                    try:
                        wait = max(float(retry_after), 1.0)
                    except ValueError:
                        pass
                _log(
                    f"OAI 503 flow-control; sleeping {wait:.1f}s "
                    f"(attempt {attempt + 1}/{BACKOFF_MAX_ATTEMPTS})"
                )
                time.sleep(wait)
                last_error = exc
                continue
            if 500 <= exc.code < 600:
                wait = _backoff_seconds(attempt)
                _log(
                    f"OAI HTTP {exc.code}; backing off {wait:.1f}s "
                    f"(attempt {attempt + 1}/{BACKOFF_MAX_ATTEMPTS})"
                )
                _sleep_with_jitter(wait)
                last_error = exc
                continue
            raise OAIFatalError(f"HTTP {exc.code} from OAI endpoint: {exc.reason}") from exc
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            wait = _backoff_seconds(attempt)
            _log(
                f"OAI connection error: {exc}; backing off {wait:.1f}s "
                f"(attempt {attempt + 1}/{BACKOFF_MAX_ATTEMPTS})"
            )
            _sleep_with_jitter(wait)
            last_error = exc
            continue

        try:
            root = ET.fromstring(body)
        except ET.ParseError as exc:
            wait = _backoff_seconds(attempt)
            _log(
                f"OAI XML parse error: {exc}; backing off {wait:.1f}s "
                f"(attempt {attempt + 1}/{BACKOFF_MAX_ATTEMPTS})"
            )
            _sleep_with_jitter(wait)
            last_error = exc
            continue

        error = parse_oai_error(root)
        if error is not None:
            code, message = error
            if code == "noRecordsMatch":
                # Not actually a fatal harvest condition; return the empty doc
                # and let the caller treat it as "zero records, no token".
                return root
            raise OAIFatalError(f"OAI error {code}: {message}")

        return root

    raise OAITransientError(
        f"Exhausted {BACKOFF_MAX_ATTEMPTS} attempts to fetch OAI; last error: {last_error}"
    )


# ---------------------------------------------------------------------------
# Harvest loop
# ---------------------------------------------------------------------------


def _initial_params(from_date: str, until_date: str) -> dict[str, str]:
    return {
        "verb": "ListRecords",
        "metadataPrefix": OAI_METADATA_PREFIX,
        "set": OAI_SET,
        "from": from_date,
        "until": until_date,
    }


def _resumption_params(token: str) -> dict[str, str]:
    return {"verb": "ListRecords", "resumptionToken": token}


def upsert_batch(conn: sqlite3.Connection, records: Iterable[ArxivRecord]) -> int:
    rows = [r.as_row() for r in records]
    if not rows:
        return 0
    conn.executemany(UPSERT_SQL, rows)
    return len(rows)


def fetch_earliest_datestamp() -> str | None:
    try:
        root = fetch_oai({"verb": "Identify"})
    except (OAITransientError, OAIFatalError):
        return None
    elem = root.find(f"{{{OAI_NS}}}Identify/{{{OAI_NS}}}earliestDatestamp")
    if elem is None or not elem.text:
        return None
    return elem.text.strip()[:10]


def harvest(
    conn: sqlite3.Connection,
    from_date: str,
    until_date: str,
) -> tuple[int, int]:
    """Harvest a [from_date, until_date] window. Returns (records_seen, upserted)."""

    _log(f"Harvesting OAI window from={from_date} until={until_date} set={OAI_SET}")

    params = _initial_params(from_date, until_date)
    total_seen = 0
    total_upserted = 0
    batch_index = 0
    first_request = True
    progress_datestamp = get_sync_state(conn, SYNC_KEY_LAST_DATESTAMP) or ""

    while True:
        if not first_request:
            time.sleep(POLITENESS_DELAY_SECONDS)
        first_request = False

        root = fetch_oai(params)
        batch_records = list(iter_records(root))
        token = parse_resumption_token(root)

        # Count every <record> element including deleted ones for "seen".
        list_records = root.find(f"{{{OAI_NS}}}ListRecords")
        seen_in_batch = (
            len(list_records.findall(f"{{{OAI_NS}}}record")) if list_records is not None else 0
        )
        total_seen += seen_in_batch

        upserted = upsert_batch(conn, batch_records)
        batch_max_datestamp = max(
            (
                (elem.text or "")[:10]
                for elem in root.iter(f"{{{OAI_NS}}}datestamp")
            ),
            default="",
        )
        if batch_max_datestamp > progress_datestamp:
            progress_datestamp = batch_max_datestamp
            set_sync_state(conn, SYNC_KEY_LAST_DATESTAMP, progress_datestamp)
        conn.commit()
        total_upserted += upserted
        batch_index += 1

        position_note = f"token={token[:32] + '...' if token and len(token) > 32 else token}"
        _log(
            f"batch {batch_index}: seen={seen_in_batch} upserted={upserted} "
            f"running_total_seen={total_seen} running_total_upserted={total_upserted} "
            f"{position_note}"
        )

        if not token:
            break
        params = _resumption_params(token)

    return total_seen, total_upserted


# ---------------------------------------------------------------------------
# CLI commands
# ---------------------------------------------------------------------------


def _parse_date(value: str, field: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise SystemExit(f"Invalid {field} date '{value}' (expected YYYY-MM-DD): {exc}")


def _today() -> date:
    from datetime import timezone
    return datetime.now(timezone.utc).date()


def run_status(db_path: Path) -> int:
    if not db_path.exists():
        print(f"db: {db_path} (does not exist)")
        return 0
    conn = open_db(db_path)
    try:
        row_count = conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
        last_until = get_sync_state(conn, SYNC_KEY_LAST_UNTIL)
        latest_published, latest_updated = conn.execute(
            "SELECT MAX(published), MAX(updated) FROM papers"
        ).fetchone()
    finally:
        conn.close()
    size = db_path.stat().st_size
    print(f"db: {db_path}")
    print(f"rows: {row_count}")
    print(f"last_synced_until: {last_until or '(none)'}")
    print(f"latest_published: {latest_published or '(none)'}")
    print(f"latest_updated: {latest_updated or '(none)'}")
    print(f"size_bytes: {size}")
    return 0


def _resolve_window(args: argparse.Namespace, conn: sqlite3.Connection) -> tuple[str, str]:
    today = _today()
    until_arg = getattr(args, "until", None)
    until_d = _parse_date(until_arg, "--until") if until_arg else today

    if args.bootstrap:
        from_d = _parse_date(BOOTSTRAP_FROM, "bootstrap-from")
        _log(
            "Bootstrap mode: harvesting the ENTIRE arXiv corpus from "
            f"{BOOTSTRAP_FROM} to {until_d}. This typically takes several hours."
        )
        return (from_d.isoformat(), until_d.isoformat())

    if args.from_date:
        from_d = _parse_date(args.from_date, "--from")
        return (from_d.isoformat(), until_d.isoformat())

    if args.resume:
        progress = get_sync_state(conn, SYNC_KEY_LAST_DATESTAMP)
        margin_days = DEFAULT_INCREMENTAL_OVERLAP_DAYS
        if not progress:
            row = conn.execute("SELECT MAX(updated) FROM papers").fetchone()
            progress = row[0] if row and row[0] else None
            margin_days = RESUME_FALLBACK_MARGIN_DAYS
            if progress:
                _log(
                    "Resume: no recorded harvest progress (older harvest); using "
                    f"MAX(updated)={progress} with a {margin_days}-day margin. "
                    "Safe because arXiv OAI iterates datestamps in ascending order."
                )
        if not progress:
            raise SystemExit(
                "Nothing to resume: the database has no harvest progress or rows. "
                "Run --bootstrap instead."
            )
        from_d = _parse_date(progress, "resume progress") - timedelta(days=margin_days)
        _log(
            f"Resume mode: continuing interrupted harvest from={from_d.isoformat()} "
            f"until={until_d.isoformat()}"
        )
        return (from_d.isoformat(), until_d.isoformat())

    # Incremental default
    last_until = get_sync_state(conn, SYNC_KEY_LAST_UNTIL)
    if not last_until:
        raise SystemExit(
            "No sync state found. Run with --bootstrap to harvest the full corpus, "
            "or pass --from YYYY-MM-DD to harvest an explicit window."
        )
    last_until_d = _parse_date(last_until, "sync_state.last_synced_until")
    from_d = last_until_d - timedelta(days=DEFAULT_INCREMENTAL_OVERLAP_DAYS)
    _log(
        f"Incremental mode: last_synced_until={last_until} -> harvesting "
        f"from={from_d.isoformat()} (with {DEFAULT_INCREMENTAL_OVERLAP_DAYS}-day overlap) "
        f"until={until_d.isoformat()}"
    )
    return (from_d.isoformat(), until_d.isoformat())


def run_harvest(db_path: Path, args: argparse.Namespace) -> int:
    if not fts5_available():
        _log(
            "ERROR: This Python's sqlite3 build does not have FTS5. "
            "Install a Python with FTS5-enabled sqlite (most macOS/Homebrew "
            "and python.org builds include it)."
        )
        return 2

    conn = open_db(db_path)
    try:
        from_iso, until_iso = _resolve_window(args, conn)
        earliest = fetch_earliest_datestamp()
        if earliest and from_iso < earliest:
            _log(
                f"from={from_iso} predates the server's earliestDatestamp={earliest}; "
                "clamping (the server rejects earlier dates with 'start date too early')."
            )
            from_iso = earliest
        _log(f"DB: {db_path}")
        seen, upserted = harvest(conn, from_iso, until_iso)
        existing_until = get_sync_state(conn, SYNC_KEY_LAST_UNTIL)
        if existing_until is None or until_iso > existing_until:
            set_sync_state(conn, SYNC_KEY_LAST_UNTIL, until_iso)
        conn.commit()
        _log(
            f"Harvest complete. records_seen={seen} upserted={upserted} "
            f"window=[{from_iso}, {until_iso}]"
        )
        total = conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
        _log(f"papers table now contains {total} rows.")
    finally:
        conn.close()
    return 0


# ---------------------------------------------------------------------------
# Argparse / main
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Harvest arXiv metadata via OAI-PMH into a local SQLite + FTS5 database. "
            "Defaults to incremental mode using sync_state.last_synced_until."
        ),
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=None,
        help=(
            "Path to the SQLite database (default: "
            "$SANDBOX_HOME/PhysicsOcean/arxiv_meta.db or "
            "~/sandbox/PhysicsOcean/arxiv_meta.db)."
        ),
    )
    parser.add_argument(
        "--from",
        dest="from_date",
        type=str,
        default=None,
        help="Inclusive harvest start date (YYYY-MM-DD).",
    )
    parser.add_argument(
        "--until",
        dest="until",
        type=str,
        default=None,
        help="Inclusive harvest end date (YYYY-MM-DD). Defaults to today (UTC).",
    )
    parser.add_argument(
        "--bootstrap",
        action="store_true",
        help=f"Harvest the full arXiv corpus from {BOOTSTRAP_FROM} to today (slow, hours).",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help=(
            "Continue an interrupted --bootstrap from the last committed batch "
            "instead of restarting from scratch."
        ),
    )
    parser.add_argument(
        "--status",
        action="store_true",
        help="Print database path, row count, last_synced_until, and file size, then exit.",
    )
    parser.add_argument(
        "--if-stale",
        dest="if_stale_days",
        type=int,
        default=None,
        metavar="DAYS",
        help=(
            "Only harvest when the sync state is older than DAYS; otherwise exit 0. "
            "Skips (exit 0) when the database or sync state does not exist yet. "
            "Intended for maintainer-operated schedulers."
        ),
    )
    return parser


def _skip_if_fresh(db_path: Path, max_age_days: int) -> bool:
    if not db_path.exists():
        _log("--if-stale: no database yet; skipping (run --bootstrap first).")
        return True
    conn = open_db(db_path)
    try:
        last_until = get_sync_state(conn, SYNC_KEY_LAST_UNTIL)
    finally:
        conn.close()
    if not last_until:
        _log("--if-stale: no sync state; skipping (run --bootstrap first).")
        return True
    age_days = (_today() - _parse_date(last_until, "sync_state.last_synced_until")).days
    if age_days < max_age_days:
        _log(f"--if-stale: synced through {last_until} ({age_days}d old); fresh enough.")
        return True
    return False


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    db_path = (args.db.expanduser().resolve() if args.db else default_db_path())

    if args.status:
        return run_status(db_path)

    exclusive_modes = [bool(args.bootstrap), bool(args.from_date), bool(args.resume)]
    if sum(exclusive_modes) > 1:
        _log("ERROR: --bootstrap, --from, and --resume are mutually exclusive.")
        return 2

    if args.if_stale_days is not None and _skip_if_fresh(db_path, args.if_stale_days):
        return 0

    try:
        return run_harvest(db_path, args)
    except OAIFatalError as exc:
        _log(f"FATAL: OAI error: {exc}")
        return 3
    except OAITransientError as exc:
        _log(f"FATAL: transient OAI failure exhausted retries: {exc}")
        return 4
    except KeyboardInterrupt:
        _log("Interrupted by user; partial batches are already committed.")
        return 130


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

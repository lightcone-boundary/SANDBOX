#!/usr/bin/env python3
"""Build the PhysicsOcean full-text search index (search.db).

Chunks every `.tex` book into section-bounded passages, cleans LaTeX markup
from an indexed copy of the text, and writes everything into a SQLite FTS5
database. The `.tex` files remain the source of truth; search.db is a
disposable accelerator that can be rebuilt at any time.

Schema:
    meta(key TEXT PRIMARY KEY, value TEXT)
    passages = fts5(text, book, section,
                    path UNINDEXED, line_start UNINDEXED, line_end UNINDEXED,
                    tokenize='porter unicode61')

Usage:
    python build_search_index.py [--root ~/sandbox/PhysicsOcean] [--db <root>/search.db]
"""

from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

_sandbox_home = Path(os.environ.get("SANDBOX_HOME", str(Path.home() / "sandbox")))
DEFAULT_ROOT = _sandbox_home / "PhysicsOcean"
SKIP_TITLES = {"contents", "table of contents"}
COMMAND_LEVELS = ("part", "chapter", "section", "subsection", "subsubsection")

# Bare structural headings like "CHAPTER ONE" / "PART II" that OCR splits from
# the real title on the following heading line.
BARE_HEADING = re.compile(
    r"^(chapter|part)\s+([0-9ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten|"
    r"eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s*$",
    re.IGNORECASE,
)

MAX_CHUNK_CHARS = 8000
MIN_CHUNK_CHARS = 80
BATCH_SIZE = 500


@dataclass(frozen=True)
class Heading:
    line: int  # 1-based line number of the heading
    level: str
    title: str


@dataclass(frozen=True)
class Passage:
    book: str
    section: str
    path: str
    line_start: int
    line_end: int
    text: str


def _collapse_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _extract_braced_content(text: str, start_index: int) -> tuple[str, int] | None:
    if start_index >= len(text) or text[start_index] != "{":
        return None
    depth = 0
    chars: list[str] = []
    for index in range(start_index, len(text)):
        char = text[index]
        if char == "{":
            depth += 1
            if depth > 1:
                chars.append(char)
            continue
        if char == "}":
            depth -= 1
            if depth == 0:
                return "".join(chars), index
            chars.append(char)
            continue
        chars.append(char)
    return None


def _parse_tex_heading(line: str) -> tuple[str, str] | None:
    stripped = line.lstrip()
    for level in COMMAND_LEVELS:
        for suffix in ("", "*"):
            prefix = f"\\{level}{suffix}"
            if not stripped.startswith(prefix):
                continue
            rest = stripped[len(prefix) :].lstrip()
            if not rest.startswith("{"):
                continue
            extracted = _extract_braced_content(rest, 0)
            if extracted is None:
                continue
            title = _collapse_whitespace(extracted[0])
            if title and title.lower() not in SKIP_TITLES:
                return level, title
    return None


def parse_headings(lines: list[str]) -> list[Heading]:
    """Extract headings, fusing bare 'CHAPTER N' lines with the next heading."""
    raw: list[Heading] = []
    for line_number, line in enumerate(lines, start=1):
        parsed = _parse_tex_heading(line)
        if parsed is None:
            continue
        level, title = parsed
        raw.append(Heading(line=line_number, level=level, title=title))

    fused: list[Heading] = []
    index = 0
    while index < len(raw):
        current = raw[index]
        nxt = raw[index + 1] if index + 1 < len(raw) else None
        if (
            nxt is not None
            and BARE_HEADING.match(current.title)
            and not BARE_HEADING.match(nxt.title)
            and nxt.line - current.line <= 12
        ):
            fused.append(
                Heading(
                    line=current.line,
                    level=current.level,
                    title=f"{current.title.title()}: {nxt.title}",
                )
            )
            index += 2
            continue
        fused.append(current)
        index += 1
    return fused


# --- LaTeX cleaning for the indexed copy ------------------------------------

_RE_COMMENT = re.compile(r"(?<!\\)%.*$", re.MULTILINE)
_RE_DROP_WITH_ARG = re.compile(
    r"\\(?:label|ref|eqref|pageref|cite[tp]?\*?|bibitem|includegraphics|input|include|"
    r"url|href|begin|end|documentclass|usepackage|newcommand|renewcommand|def)\s*"
    r"(?:\[[^\]]*\])?\s*\{[^{}]*\}"
)
_RE_DISPLAY_MATH = re.compile(r"\$\$.*?\$\$|\\\[.*?\\\]", re.DOTALL)
_RE_INLINE_MATH = re.compile(r"\$[^$]*\$|\\\(.*?\\\)", re.DOTALL)
_RE_COMMAND = re.compile(r"\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?")
_RE_LEFTOVER = re.compile(r"[{}~^_&\\]")


def clean_latex(text: str) -> str:
    """Strip markup so only searchable prose reaches the tokenizer."""
    text = _RE_COMMENT.sub(" ", text)
    text = _RE_DROP_WITH_ARG.sub(" ", text)
    text = _RE_DISPLAY_MATH.sub(" ", text)
    text = _RE_INLINE_MATH.sub(" ", text)
    text = _RE_COMMAND.sub(" ", text)
    text = _RE_LEFTOVER.sub(" ", text)
    return _collapse_whitespace(text)


# --- Chunking ----------------------------------------------------------------


def _split_long_chunk(
    lines: list[str], start: int, end: int, max_chars: int
) -> list[tuple[int, int]]:
    """Split [start, end] (1-based, inclusive) at blank-line boundaries."""
    spans: list[tuple[int, int]] = []
    span_start = start
    span_chars = 0
    for line_number in range(start, end + 1):
        span_chars += len(lines[line_number - 1]) + 1
        at_paragraph_break = line_number < end and not lines[line_number].strip()
        if span_chars >= max_chars and at_paragraph_break:
            spans.append((span_start, line_number))
            span_start = line_number + 1
            span_chars = 0
    if span_start <= end:
        spans.append((span_start, end))
    return spans


def chunk_book(path: Path, book: str) -> list[Passage]:
    try:
        raw = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    lines = raw.splitlines()
    if not lines:
        return []

    headings = parse_headings(lines)
    boundaries: list[tuple[int, int, str]] = []  # (start, end, section)

    if not headings:
        boundaries.append((1, len(lines), "(no sections)"))
    else:
        if headings[0].line > 1:
            boundaries.append((1, headings[0].line - 1, "(front matter)"))
        for index, heading in enumerate(headings):
            end = headings[index + 1].line - 1 if index + 1 < len(headings) else len(lines)
            boundaries.append((heading.line, end, heading.title))

    passages: list[Passage] = []
    for start, end, section in boundaries:
        if end < start:
            continue
        spans = _split_long_chunk(lines, start, end, MAX_CHUNK_CHARS)
        total = len(spans)
        for part_index, (span_start, span_end) in enumerate(spans, start=1):
            chunk_raw = "\n".join(lines[span_start - 1 : span_end])
            text = clean_latex(chunk_raw)
            if len(text) < MIN_CHUNK_CHARS:
                continue
            label = section if total == 1 else f"{section} (part {part_index}/{total})"
            passages.append(
                Passage(
                    book=book,
                    section=label,
                    path=str(path),
                    line_start=span_start,
                    line_end=span_end,
                    text=text,
                )
            )
    return passages


# --- DB ------------------------------------------------------------------------


def create_db(db_path: Path) -> sqlite3.Connection:
    if db_path.exists():
        db_path.unlink()
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)")
    conn.execute(
        "CREATE VIRTUAL TABLE passages USING fts5("
        "text, book, section, "
        "path UNINDEXED, line_start UNINDEXED, line_end UNINDEXED, "
        "tokenize='porter unicode61')"
    )
    return conn


def build_index(root: Path, db_path: Path) -> tuple[int, int]:
    tex_files = sorted(p for p in root.rglob("*.tex") if p.is_file())
    conn = create_db(db_path)
    passage_count = 0
    batch: list[tuple[str, str, str, str, int, int]] = []

    try:
        for file_index, path in enumerate(tex_files, start=1):
            book = path.stem
            for passage in chunk_book(path, book):
                batch.append(
                    (
                        passage.text,
                        passage.book,
                        passage.section,
                        passage.path,
                        passage.line_start,
                        passage.line_end,
                    )
                )
                passage_count += 1
                if len(batch) >= BATCH_SIZE:
                    conn.executemany(
                        "INSERT INTO passages(text, book, section, path, line_start, line_end) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        batch,
                    )
                    batch.clear()
            if file_index % 50 == 0:
                conn.commit()
                print(f"  indexed {file_index}/{len(tex_files)} books...", file=sys.stderr)

        if batch:
            conn.executemany(
                "INSERT INTO passages(text, book, section, path, line_start, line_end) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                batch,
            )

        conn.execute(
            "INSERT INTO meta(key, value) VALUES ('corpus_root', ?)", (str(root),)
        )
        conn.execute(
            "INSERT INTO meta(key, value) VALUES ('built_at', ?)",
            (datetime.now(timezone.utc).isoformat(),),
        )
        conn.execute(
            "INSERT INTO meta(key, value) VALUES ('tex_files', ?)", (str(len(tex_files)),)
        )
        conn.execute(
            "INSERT INTO meta(key, value) VALUES ('passages', ?)", (str(passage_count),)
        )
        conn.execute("INSERT INTO passages(passages) VALUES ('optimize')")
        conn.commit()
    finally:
        conn.close()

    return len(tex_files), passage_count


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the PhysicsOcean FTS5 search index.")
    parser.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_ROOT,
        help="PhysicsOcean root directory (default: ~/sandbox/PhysicsOcean)",
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=None,
        help="Output SQLite path (default: <root>/search.db)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.expanduser().resolve()
    db_path = args.db.expanduser().resolve() if args.db else root / "search.db"

    if not root.is_dir():
        raise SystemExit(f"PhysicsOcean root does not exist or is not a directory: {root}")

    book_count, passage_count = build_index(root, db_path)
    print(f"Indexed {passage_count} passages from {book_count} books into {db_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

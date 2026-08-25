#!/usr/bin/env python3
"""Build a lightweight Markdown index for persisted PhysicsOcean arXiv papers."""

from __future__ import annotations

import argparse
import os
import re
from dataclasses import dataclass
from pathlib import Path

_sandbox_home = Path(os.environ.get("SANDBOX_HOME", str(Path.home() / "sandbox")))
DEFAULT_ROOT = _sandbox_home / "PhysicsOcean" / "arxiv"


@dataclass(frozen=True)
class ArxivEntry:
    arxiv_id: str
    title: str
    source_type: str
    saved_at: str
    path: str
    abstract: str


INDEX_DESCRIPTION = (
    "Lightweight paper index for persisted arXiv papers. Use this file to find relevant papers, "
    "then use `grep` and `read` on the saved paper files themselves."
)

ENTRY_PATTERN = re.compile(
    r"^- arxiv_id: (?P<arxiv_id>.*?) \| title: (?P<title>.*?) \| source_type: (?P<source_type>.*?) "
    r"\| saved_at: (?P<saved_at>.*?) \| path: (?P<path>.*?) \| abstract: (?P<abstract>.*)$"
)


def _collapse_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _escape_field(value: str) -> str:
    return value.replace("|", r"\|")


def _read_lines(path: Path) -> list[str]:
    try:
        return path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return []


def _header_lines(root: Path, paper_count: int) -> list[str]:
    return [
        "# PhysicsArxiv Index",
        "",
        INDEX_DESCRIPTION,
        "",
        f"- corpus_root: {root}",
        f"- paper_files: {paper_count}",
        "",
        "## Entries",
        "",
    ]


def _extract_metadata(lines: list[str], key: str) -> str:
    prefix = f"- {key}:"
    for line in lines[:20]:
        stripped = line.strip()
        if stripped.startswith(prefix):
            return stripped[len(prefix) :].strip()
    return ""


def _extract_title(lines: list[str], path: Path) -> str:
    for line in lines[:10]:
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
    return path.stem


def _extract_abstract(lines: list[str]) -> str:
    for index, line in enumerate(lines):
        stripped = line.strip()
        lower = stripped.lower()
        if lower in {"## abstract", "# abstract", "abstract"}:
            snippet_lines: list[str] = []
            for candidate in lines[index + 1 :]:
                candidate_stripped = candidate.strip()
                if not candidate_stripped:
                    if snippet_lines:
                        break
                    continue
                if candidate_stripped.startswith("## ") or candidate_stripped.startswith("# "):
                    break
                snippet_lines.append(candidate_stripped)
                if len(_collapse_whitespace(" ".join(snippet_lines))) >= 500:
                    break
            snippet = _collapse_whitespace(" ".join(snippet_lines))
            if snippet:
                return snippet[:500]

    body_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("# ") or stripped.startswith("## ") or stripped.startswith("- "):
            continue
        body_lines.append(stripped)
        if len(_collapse_whitespace(" ".join(body_lines))) >= 500:
            break
    return _collapse_whitespace(" ".join(body_lines))[:500]


def build_entry(path: Path) -> ArxivEntry | None:
    if not path.is_file() or path.name == "index.md":
        return None

    lines = _read_lines(path)
    if not lines:
        return None

    return ArxivEntry(
        arxiv_id=_escape_field(_extract_metadata(lines, "arxiv_id") or path.stem),
        title=_escape_field(_extract_title(lines, path)),
        source_type=_escape_field(_extract_metadata(lines, "source_type") or "unknown"),
        saved_at=_escape_field(_extract_metadata(lines, "saved_at")),
        path=_escape_field(str(path)),
        abstract=_escape_field(_extract_abstract(lines)),
    )


def render_entry(entry: ArxivEntry) -> str:
    return (
        f"- arxiv_id: {entry.arxiv_id} | title: {entry.title} | source_type: {entry.source_type} "
        f"| saved_at: {entry.saved_at} | path: {entry.path} | abstract: {entry.abstract}"
    )


def _parse_entry_line(line: str) -> dict[str, str] | None:
    match = ENTRY_PATTERN.match(line.strip())
    return match.groupdict() if match else None


def upsert_index_entry(root: Path, output: Path, paper_path: Path) -> None:
    entry = build_entry(paper_path)
    if entry is None:
        return

    rendered_entry = render_entry(entry)
    existing_lines = _read_lines(output)
    existing_entries: list[str] = []
    in_entries = False

    for line in existing_lines:
        if line.strip() == "## Entries":
            in_entries = True
            continue
        if not in_entries:
            continue
        stripped = line.strip()
        if stripped.startswith("- arxiv_id:"):
            existing_entries.append(stripped)

    updated_entries: list[str] = []
    replaced = False
    for line in existing_entries:
        parsed = _parse_entry_line(line)
        if parsed and (parsed["path"] == entry.path or parsed["arxiv_id"] == entry.arxiv_id):
            if not replaced:
                updated_entries.append(rendered_entry)
                replaced = True
            continue
        updated_entries.append(line)

    if not replaced:
        updated_entries.append(rendered_entry)

    document_lines = _header_lines(root, len(updated_entries))
    document_lines.extend(updated_entries)
    document_lines.append("")
    output.write_text("\n".join(document_lines), encoding="utf-8")


def iter_arxiv_entries(root: Path) -> list[ArxivEntry]:
    entries: list[ArxivEntry] = []
    for path in sorted(root.glob("*.md")):
        entry = build_entry(path)
        if entry is None:
            continue
        entries.append(entry)
    return entries


def render_index(root: Path, entries: list[ArxivEntry]) -> str:
    lines = _header_lines(root, len(entries))
    lines.extend(render_entry(entry) for entry in entries)
    lines.append("")
    return "\n".join(lines)


def build_index(root: Path, output: Path) -> None:
    entries = iter_arxiv_entries(root)
    output.write_text(render_index(root, entries), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a lightweight PhysicsArxiv index.")
    parser.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_ROOT,
        help="PhysicsArxiv root directory (default: ~/sandbox/PhysicsOcean/arxiv)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output Markdown path (default: <root>/index.md)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.expanduser().resolve()
    output = args.output.expanduser().resolve() if args.output else root / "index.md"

    root.mkdir(parents=True, exist_ok=True)

    build_index(root=root, output=output)
    print(f"Wrote arXiv index to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

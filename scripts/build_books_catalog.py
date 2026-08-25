#!/usr/bin/env python3
"""Build books.md — a greppable one-line-per-book catalog of PhysicsOcean.

Each line carries controlled-vocabulary subject tags, level, and kind so an
agent can route with `grep -i "relativity" books.md` (~10 lines of output)
instead of scanning filenames or reading anything large.

Tags are derived heuristically from filenames. Per-book corrections live in an
optional `<root>/books.json` override file:

    { "Some Book.tex": {"subjects": ["gr"], "level": "grad",
                         "kind": "textbook", "author": "A. Author",
                         "note": "canonical reference"} }

Usage:
    python build_books_catalog.py [--root ~/sandbox/PhysicsOcean]
"""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

_sandbox_home = Path(os.environ.get("SANDBOX_HOME", str(Path.home() / "sandbox")))
DEFAULT_ROOT = _sandbox_home / "PhysicsOcean"

# Controlled vocabulary: keyword (regex, case-insensitive) -> subject tag.
SUBJECT_RULES: list[tuple[str, str]] = [
    (r"classical mechanic|analytical mechanic|lagrangian|hamiltonian|celestial|statics and dynamics|brownian|variation", "classical-mechanics"),
    (r"electrodynam|electromagnet|electricity|magneti|maxwell|antenna|microwave", "electromagnetism"),
    (r"quantum mechanic|quantum theory|quantum physics|schr|angular momentum|scattering|hilbert|dirac equation|atomic structure", "quantum-mechanics"),
    (r"field theor|qft|qed|quantum electrodynamics|quantum chromodynamics|feynman diagram|renormalization|gauge", "qft"),
    (r"statistical (mechanic|physic)|spin glass|nonequilibrium|entropy|ising|boltzmann", "statistical-mechanics"),
    (r"thermodynamic|heat transfer|thermal", "thermodynamics"),
    (r"fluid|hydrodynamic|gas dynamics|viscous|vortic|turbulen|wave motion|acoustic", "fluids"),
    (r"relativit|spacetime|space-time|gravitation|black hole|wormhole|geodesic", "relativity-gr"),
    (r"cosmolog|early universe|big bang|inflation|dark matter|milky way|cosmic", "cosmology"),
    (r"astrophysic|astronomy|stellar|galactic|neutrino astro|radio astronomy|solar system", "astrophysics"),
    (r"optic|laser|photonic|fiber|waveguide|spectroscop|raman|interferometr", "optics"),
    (r"condensed matter|solid state|solid-state|semiconductor|superconduct|nanostructure|nanotech|crystallog|dislocation|elasticity|magnetism molecules|many-particle|mesoscopic", "condensed-matter"),
    (r"nuclear|nuclei|reactor|fusion|fission", "nuclear"),
    (r"particle|quark|lepton|hep|collider|standard model|supersymmetr", "particle-physics"),
    (r"plasma|charged particle beam|particle acceleration", "plasma"),
    (r"string theor|superstring|brane|m-theory|conformal field", "string-theory"),
    (r"quantum gravity|loop quantum|twistor", "quantum-gravity"),
    (r"quantum optic|cavity quantum|quantum information|decoherence|entangle|bose-einstein", "quantum-optics-info"),
    (r"mathematical (method|physic|tool|model|approach|theory|principle|introduction)|math method|tensor|differential geometry|group|topolog|functional analysis|fourier|determinant|calculus|geometric algebra|equations of|inverse problem|singularit|path integral|stochastic|operator algebra", "math-methods"),
    (r"computational|numerical|finite element|finite difference|monte carlo|algorithm|visualization|computer algebra|mathematica", "computational"),
    (r"chaos|nonlinear|fractal|soliton|complex system", "chaos-nonlinear"),
    (r"geophysic|seismolog|earth|mineral|rock physics|atmospher|hydrogeol|ocean", "geophysics"),
    (r"biophysic|biolog", "biophysics"),
    (r"electronic|circuit|electro-optic|impedance", "electronics"),
]

KIND_RULES: list[tuple[str, str]] = [
    (r"problems|solutions|solved|answer|guide to physics problems|schaum", "problems-solutions"),
    (r"handbook|encyclopedia|dictionary|formular|reference shelf|recipes|tables", "handbook-reference"),
    (r"lecture|course notes|notes on|study materials|\[.*course.*\]", "lecture-notes"),
    (r"thesis|\[thesis\]", "thesis"),
    (r"elegant universe|fabric of the cosmos|tao of physics|first three minutes|brief|idiot|demystified|story of|road to reality|mad about|great physicists|perfect symmetry", "popular"),
]

LEVEL_RULES: list[tuple[str, str]] = [
    (r"idiot|demystified|crash course|everyday|teach yourself|popular|tao of|elegant universe|fabric of|abc of", "popular"),
    (r"introduction to|introductory|first course|elementary|undergraduate|college|basics of|primer", "undergrad"),
    (r"advanced|graduate|modern course|treatise|monograph|proceedings|workshop", "grad"),
]

CATALOG_HEADER = """# PhysicsOcean Books Catalog

One line per book. Grep this file to route searches before querying search.db.

Format: `- file: <file> | subjects: <tags> | level: <level> | kind: <kind> | author: <author>`
Subject tags: classical-mechanics, electromagnetism, quantum-mechanics, qft,
statistical-mechanics, thermodynamics, fluids, relativity-gr, cosmology,
astrophysics, optics, condensed-matter, nuclear, particle-physics, plasma,
string-theory, quantum-gravity, quantum-optics-info, math-methods,
computational, chaos-nonlinear, geophysics, biophysics, electronics, unknown
Levels: popular, undergrad, grad, unknown. Kinds: textbook, lecture-notes,
problems-solutions, handbook-reference, popular, thesis.

Examples:
    grep -i "relativity-gr" books.md
    grep -i "problems-solutions" books.md | grep -i quantum

## Books
"""


def guess_author(stem: str) -> str:
    parts = re.split(r"\s+-\s+", stem)
    if len(parts) >= 2:
        candidate = parts[-1].strip()
        # Avoid obvious non-author tails like "3rd ed" or "Vol 2".
        if not re.search(r"\b(ed|edition|vol|volume|part)\b\.?\s*\d*$", candidate, re.IGNORECASE):
            return candidate
    return ""


def apply_rules(stem: str, rules: list[tuple[str, str]]) -> list[str]:
    found: list[str] = []
    for pattern, tag in rules:
        if re.search(pattern, stem, re.IGNORECASE) and tag not in found:
            found.append(tag)
    return found


def classify(stem: str) -> tuple[list[str], str, str]:
    subjects = apply_rules(stem, SUBJECT_RULES) or ["unknown"]
    kinds = apply_rules(stem, KIND_RULES)
    kind = kinds[0] if kinds else "textbook"
    levels = apply_rules(stem, LEVEL_RULES)
    level = levels[0] if levels else ("popular" if kind == "popular" else "unknown")
    if kind == "popular":
        level = "popular"
    return subjects, level, kind


def load_overrides(root: Path) -> dict[str, dict[str, object]]:
    override_path = root / "books.json"
    if not override_path.is_file():
        return {}
    try:
        data = json.loads(override_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Invalid books.json overrides at {override_path}: {exc}")
    return data if isinstance(data, dict) else {}


def render_line(
    filename: str,
    subjects: list[str],
    level: str,
    kind: str,
    author: str,
    note: str,
) -> str:
    line = (
        f"- file: {filename} | subjects: {', '.join(subjects)} "
        f"| level: {level} | kind: {kind} | author: {author or 'unknown'}"
    )
    if note:
        line += f" | note: {note}"
    return line


def build_catalog(root: Path, output: Path) -> tuple[int, int]:
    overrides = load_overrides(root)
    tex_files = sorted(p for p in root.rglob("*.tex") if p.is_file())

    lines: list[str] = []
    unknown_count = 0
    for path in tex_files:
        stem = path.stem
        subjects, level, kind = classify(stem)
        author = guess_author(stem)
        note = ""

        override = overrides.get(path.name)
        if isinstance(override, dict):
            raw_subjects = override.get("subjects")
            if isinstance(raw_subjects, list) and raw_subjects:
                subjects = [str(s) for s in raw_subjects]
            level = str(override.get("level", level))
            kind = str(override.get("kind", kind))
            author = str(override.get("author", author))
            note = str(override.get("note", ""))

        if subjects == ["unknown"]:
            unknown_count += 1
        lines.append(render_line(path.name, subjects, level, kind, author, note))

    document = CATALOG_HEADER + "\n".join(lines) + "\n"
    output.write_text(document, encoding="utf-8")
    return len(tex_files), unknown_count


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the PhysicsOcean books.md catalog.")
    parser.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_ROOT,
        help="PhysicsOcean root directory (default: ~/sandbox/PhysicsOcean)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output path (default: <root>/books.md)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.expanduser().resolve()
    output = args.output.expanduser().resolve() if args.output else root / "books.md"

    if not root.is_dir():
        raise SystemExit(f"PhysicsOcean root does not exist or is not a directory: {root}")

    book_count, unknown_count = build_catalog(root, output)
    print(f"Cataloged {book_count} books into {output} ({unknown_count} tagged unknown)")
    if unknown_count:
        print(f"Add entries to {root / 'books.json'} to fix unknown-tagged books.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# PhysicsOcean Knowledge Base Workflow

PhysicsOcean is the SANDBOX physics knowledge base, not application runtime. End users install prepared packs through the native npm CLI; maintainers use the standalone Python scripts in this repository to rebuild indexes, refresh the arXiv mirror, and produce those packs.

## Installed layout

`SANDBOX_HOME` defaults to the `sandbox` directory under the user's home.

| Path | Role |
|---|---|
| `PhysicsOcean/*.tex` | Physics knowledge-base source of truth. |
| `PhysicsOcean/books.md` | Greppable one-line-per-source catalog consumed by `physics_catalog`. |
| `PhysicsOcean/books.json` | Optional hand-authored knowledge-base catalog overrides. |
| `PhysicsOcean/search.db` | SQLite FTS5 passage index consumed by `physics_search`. |
| `PhysicsOcean/arxiv_meta.db` | Local arXiv metadata mirror consumed by `arxiv_search`. |
| `PhysicsOcean/arxiv/*.md` | User papers persisted by `arxiv_fetch`. |
| `PhysicsOcean/arxiv/index.md` | Lightweight index of persisted papers. |
| `shared/sandbox-runtime.db` | Disposable native request throttle and response cache. |

The npm importer can replace the top-level knowledge-base files. It deliberately does not package or replace `PhysicsOcean/arxiv/`, so a new distributed dataset cannot overwrite a user's saved papers.

## End-user installation

Place each checksum beside its local archive:

```text
physicsocean-textbooks-<date>.tar.gz
physicsocean-textbooks-<date>.tar.gz.sha256
physicsocean-arxiv-<date>.tar.gz
physicsocean-arxiv-<date>.tar.gz.sha256
```

Then run:

```bash
sandbox data install ./physicsocean-textbooks-<date>.tar.gz ./physicsocean-arxiv-<date>.tar.gz
sandbox data status
```

The installer accepts local files only. Downloading, authentication, and multipart transport are deliberately left to the distribution channel.

## Physics knowledge-base retrieval

The agent normally follows this native sequence:

1. `physics_catalog` narrows candidate knowledge-base sources by controlled metadata.
2. `physics_search` performs BM25-ranked FTS5 retrieval, optionally constrained with its `book` filter.
3. `physics_read` reads the exact `.tex` line range for equations and surrounding context.

Search snippets are routing aids. Equations and quotations should come from `physics_read`, which is bounded to a flat `.tex` filename and a limited line range.

## arXiv retrieval

`arxiv_search` prefers `arxiv_meta.db` when the mirror is sufficiently complete and covers the requested date range. Advanced arXiv query syntax, dates newer than the mirror, an incomplete/missing mirror, or no local matches cause a live arXiv API fallback.

Live arXiv responses and citation enrichment are cached for 24 hours. Cross-process request slots are stored in `shared/sandbox-runtime.db` to respect upstream pacing.

`arxiv_fetch`:

1. returns an already saved paper unless `force_refresh` is requested;
2. downloads and extracts arXiv LaTeX source when available;
3. falls back to bounded native PDF text extraction;
4. writes a Markdown paper under `PhysicsOcean/arxiv/`; and
5. updates `PhysicsOcean/arxiv/index.md`.

The npm launcher does not run an automatic Python metadata synchronization job. Dataset maintainers refresh `arxiv_meta.db` before producing an updated pack; users retain live API fallback between releases.

## Maintainer prerequisites

The retained scripts use only the Python standard library. Python is required on the dataset-production machine, not on end-user systems.

Set a non-default knowledge-base location with `--root`, `--db`, or `SANDBOX_HOME` as supported by each script. Inspect `--help` before production runs.

## Rebuild knowledge-base accelerators

After adding or replacing knowledge-base `.tex` sources:

```bash
python3 scripts/build_search_index.py --root ~/sandbox/PhysicsOcean
python3 scripts/build_books_catalog.py --root ~/sandbox/PhysicsOcean
```

`search.db` and `books.md` are disposable accelerators. The `.tex` files and any curated `books.json` entries remain the source of truth.

## Maintain saved-paper index

The native plugin updates `arxiv/index.md` whenever it saves a paper. Maintainers can reconstruct the index from existing Markdown files:

```bash
python3 scripts/build_arxiv_index.py --root ~/sandbox/PhysicsOcean/arxiv
```

## Maintain the arXiv metadata mirror

Inspect status:

```bash
python3 scripts/arxiv_oai_sync.py --status
```

Bootstrap a new mirror, which can take several hours:

```bash
python3 scripts/arxiv_oai_sync.py --bootstrap
```

Resume an interrupted bootstrap or perform an incremental update:

```bash
python3 scripts/arxiv_oai_sync.py --resume
python3 scripts/arxiv_oai_sync.py
```

The harvester commits each OAI batch, uses upserts, honors arXiv's earliest datestamp, and applies polite delay and retry behavior. Do not remove the pacing to make a bootstrap appear faster.

## Produce distributable packs

After checking the knowledge base and mirror:

```bash
python3 scripts/make_physicsocean_pack.py \
  --root ~/sandbox/PhysicsOcean \
  --out-dir ./physicsocean-packs
```

The producer creates separate knowledge-base and arXiv archives, sibling SHA-256 files, and a shared manifest. SQLite WAL data is checkpointed before packing; saved user papers are excluded.

Build just one pack when needed:

```bash
python3 scripts/make_physicsocean_pack.py --only textbooks --out-dir ./physicsocean-packs
python3 scripts/make_physicsocean_pack.py --only arxiv --out-dir ./physicsocean-packs
```

## Release checks

Before distribution:

1. Run `sandbox data install` against both newly produced packs in a temporary home.
2. Run `sandbox data status --json` and verify both databases and the knowledge-base source count.
3. Exercise `physics_catalog`, `physics_search`, and a local `arxiv_search` through OpenCode.
4. Confirm a pre-existing file under `PhysicsOcean/arxiv/` survives reinstallation.
5. Distribute archives and checksums together; never recommend `--allow-unverified` for downloaded data.

## Recovery

A failed native import stages data privately and rolls replacements back. If an operator interruption leaves hidden `.sandbox-data-*` directories under `PhysicsOcean/`, first ensure no import is running, inspect the installed top-level files, then remove only abandoned hidden staging/backup directories. Never delete the knowledge base or saved-paper directory as a generic recovery step.

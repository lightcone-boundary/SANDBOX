# `@lightcone-boundary/sandbox`

Native OpenCode plugin and command-line launcher for the SANDBOX physics research assistant.

## Install

Install OpenCode and SANDBOX globally with a supported Node.js release:

```bash
npm install -g opencode-ai @lightcone-boundary/sandbox
sandbox setup
sandbox doctor
```

Supported Node lines are `^22.22.2`, `^24.15.0`, and `>=26`. OpenCode `1.18.22` or newer must be available on `PATH`.

## CLI

```text
sandbox                         Start OpenCode web mode
sandbox [web options]           Start web mode with options such as --port
sandbox tui [options]           Start the OpenCode terminal interface
sandbox <opencode command> ...  Forward another OpenCode command
sandbox setup [--home PATH]     Create SANDBOX data directories
sandbox data install PACK ...   Install local PhysicsOcean packs
sandbox data status             Inspect installed PhysicsOcean data
sandbox doctor                  Check Node, OpenCode, plugin, home, and data
```

The launcher builds an `OPENCODE_CONFIG_CONTENT` overlay for its child process. It preserves existing inline configuration, removes duplicate SANDBOX plugin entries, appends this installed plugin, and selects `sandbox-physics`. It does not write global configuration files or replace `OPENCODE_CONFIG_DIR`.

## PhysicsOcean packs

Install one or more local `.tar.gz` packs with sibling `.sha256` files:

```bash
sandbox data install ./physicsocean-textbooks-<date>.tar.gz ./physicsocean-arxiv-<date>.tar.gz
```

The importer:

- streams SHA-256 verification;
- rejects links, nested/traversal paths, non-portable names, unexpected files, duplicates, and oversized input;
- accepts only the known catalogs, databases, and flat `.tex` sources;
- validates extracted sizes and SQLite headers;
- installs through private staging and rollback-backed replacement; and
- preserves saved papers in `PhysicsOcean/arxiv/`.

`--allow-unverified` is only for trusted, locally produced development packs.

## Tools

The plugin registers seven native OpenCode tools:

- `physics_catalog`
- `physics_search`
- `physics_read`
- `arxiv_search`
- `arxiv_fetch`
- `paper_references`
- `paper_citations`

PhysicsOcean knowledge-base retrieval uses the packaged runtime's native SQLite interface against `PhysicsOcean/search.db`. arXiv search prefers a sufficiently complete local `arxiv_meta.db` and falls back to the live API. Paper fetching prefers arXiv LaTeX source and uses `unpdf` for PDF text fallback. Semantic Scholar powers citation traversal.

## Local state

`SANDBOX_HOME` defaults to the `sandbox` directory under the current user's home:

```text
PhysicsOcean/search.db
PhysicsOcean/books.md
PhysicsOcean/arxiv_meta.db
PhysicsOcean/arxiv/
shared/sandbox-runtime.db
shared/research/
artifacts/
```

The runtime database stores request throttling and 24-hour response caches. It contains no PhysicsOcean knowledge-base content.

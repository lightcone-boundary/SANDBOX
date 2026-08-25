# `@lightcone-boundary/sandbox`

Native OpenCode plugin and command-line launcher for the SANDBOX physics research assistant.

The published package contains the complete end-user runtime. At runtime it does not spawn Python, create a virtual environment, install a scientific stack, or depend on files from the repository root.

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

`--json` is available for setup, data, and doctor automation. Data commands and doctor also accept `--home PATH`.

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

## Development

The tests require Bun because the OpenCode runtime provides `bun:sqlite`. From this package directory:

```bash
npm install
npm test
npm run typecheck
npm run build
npm run test:package
npm pack --dry-run
```

Builds remove `dist/` before invoking TypeScript, preventing deleted modules from surviving in a later tarball. `postbuild` restores executable permissions on `dist/cli.js`. `test:package` rebuilds, compares the canonical and bundled agent prompts, exercises the compiled plugin, and checks the npm tarball layout.

The repository has one OpenCode discovery root. Its local shim, `../.opencode/plugins/physics.ts`, re-exports this package's plugin source, while `../.opencode/agents/sandbox-physics.md` is the canonical agent definition. The tools are defined in `src/physics-tools.ts` and registered by the `tool` hook in `src/index.ts`; they are not duplicated in a project custom-tools directory. `postbuild` copies the canonical agent into `dist/assets/agents/` so an installed npm package can load it without repository-root files.

Python files under the repository's `scripts/` directory are offline dataset-maintainer utilities only. They are not part of this package.

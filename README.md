# SANDBOX Physics

[English](README.md) | [简体中文](README.zh-CN.md)

SANDBOX is a native OpenCode extension for physics research from 光锥边界（南京）科技有限公司. It adds local PhysicsOcean retrieval, arXiv search and persistence, citation-graph exploration, and a physics-focused primary agent on top of OpenCode's normal capabilities.

## Native tools

| Tool               | Purpose                                                                                  |
|--------------------|------------------------------------------------------------------------------------------|
| `physics_catalog`  | Filter the PhysicsOcean knowledge-base catalog by subject, title, author, level, or kind. |
| `physics_search`   | Search the local FTS5 knowledge-base index or inspect a source's table of contents.       |
| `physics_read`     | Read a bounded line range from a PhysicsOcean LaTeX source.                              |
| `arxiv_search`     | Search a local arXiv metadata mirror, with a live arXiv API fallback.                    |
| `arxiv_fetch`      | Save an arXiv paper locally, preferring LaTeX and falling back to native PDF extraction. |
| `paper_references` | Follow a paper's references through Semantic Scholar.                                    |
| `paper_citations`  | Find later papers that cite a selected paper.                                            |

## Requirements

- macOS, Linux, or Windows.
- OpenCode `1.18.22` or newer, available as `opencode`.
- A supported Node.js release:
  - Node 22 from `22.22.2` onward;
  - Node 24 from `24.15.0` onward; or
  - Node 26 or newer.
- npm for installation.
- Python is optional for the packaged runtime, but recommended for scientific-computing workflows inside OpenCode.

## Quick start

Install OpenCode:

```bash
npm install -g opencode-ai
```

Then install SANDBOX:

```bash
npm install -g @lightcone-boundary/sandbox
```

Create the local data directories and verify the environment:

```bash
sandbox setup
sandbox doctor
```

Start SANDBOX in OpenCode's web interface:

```bash
sandbox
```

## Install PhysicsOcean

PhysicsOcean is distributed separately because the complete dataset is about 3.6 GB. Obtain the physics knowledge-base and arXiv packs plus their matching checksum files:

```text
physicsocean-textbooks-<date>.tar.gz
physicsocean-textbooks-<date>.tar.gz.sha256
physicsocean-arxiv-<date>.tar.gz
physicsocean-arxiv-<date>.tar.gz.sha256
```

Keep each `.sha256` file beside its archive, then install both local files:

```bash
sandbox data install \
  ./physicsocean-textbooks-<date>.tar.gz \
  ./physicsocean-arxiv-<date>.tar.gz
```

PowerShell uses the same command without the shell line continuations:

```powershell
sandbox data install .\physicsocean-textbooks-<date>.tar.gz .\physicsocean-arxiv-<date>.tar.gz
```

The importer:

- streams SHA-256 verification;
- rejects links, nested or traversal paths, non-portable names, unexpected files, duplicates, and oversized input;
- accepts only known catalogs, databases, and flat `.tex` sources;
- validates extracted sizes and SQLite headers;
- installs through private staging and rollback-backed replacement; and
- preserves existing saved papers under `PhysicsOcean/arxiv/`.

Inspect the result:

```bash
sandbox data status
sandbox doctor
```

## CLI

```text
sandbox                         Start the OpenCode web interface
sandbox [web options]           Start web mode with options such as --port
sandbox tui [options]           Start the OpenCode terminal interface
sandbox <opencode command> ...  Forward another OpenCode command
sandbox setup [--home PATH]     Create SANDBOX data directories
sandbox data install PACK ...   Install local PhysicsOcean packs
sandbox data status             Inspect installed PhysicsOcean data
sandbox doctor                  Check Node, OpenCode, plugin, home, and data
```

Run `sandbox --help` for the complete CLI summary.

## Data locations

The default SANDBOX home is `~/sandbox` on macOS/Linux and the `sandbox` directory under the user's home on Windows.

```text
PhysicsOcean/search.db          native FTS5 physics knowledge-base index
PhysicsOcean/books.md           searchable knowledge-base catalog
PhysicsOcean/arxiv_meta.db      local arXiv metadata mirror
PhysicsOcean/arxiv/             papers saved by arxiv_fetch
shared/sandbox-runtime.db       request throttling and 24-hour response caches
shared/research/                durable task-specific work
artifacts/                      other generated outputs
```

## Remove SANDBOX

Remove the npm package without touching local data:

```bash
npm uninstall -g @lightcone-boundary/sandbox
```

Delete the data separately only when it is no longer needed:

```bash
rm -rf ~/sandbox
```

```powershell
Remove-Item -Recurse -Force "$HOME\sandbox"
```

## Maintainer tooling

Python is retained for offline dataset production. The scripts under `scripts/` use the Python standard library:

- `arxiv_oai_sync.py`
- `build_search_index.py`
- `build_books_catalog.py`
- `build_arxiv_index.py`
- `make_physicsocean_pack.py`

See [KNOWLEDGE_BASE_WORKFLOW.md](KNOWLEDGE_BASE_WORKFLOW.md) for the maintainer workflow.

## WeChat

Scan the QR code to connect with us on WeChat.

<img src="wechat_qr.png" alt="WeChat QR code" width="240">

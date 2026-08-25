PANDOC ?= pandoc
PDF_ENGINE ?= xelatex
PYTHON ?= python3
DOCS_DIR ?= docs
PDF_OUT_DIR ?= docs/pdf

.PHONY: help install-plugin test typecheck build publish search-index books-catalog arxiv-index arxiv-sync data-packs pdf docs-pdf

help:
	@echo "Available commands:"
	@echo "  install-plugin - Install npm package dependencies"
	@echo "  test           - Run the native plugin and CLI tests"
	@echo "  search-index  - Build ~/sandbox/PhysicsOcean/search.db"
	@echo "  books-catalog - Build ~/sandbox/PhysicsOcean/books.md"
	@echo "  arxiv-index   - Build ~/sandbox/PhysicsOcean/arxiv/index.md"
	@echo "  arxiv-sync    - Incrementally update arxiv_meta.db (maintainers)"
	@echo "  data-packs    - Build distributable PhysicsOcean packs (maintainers)"
	@echo "  typecheck      - Run TypeScript typecheck for physics-opencode"
	@echo "  build          - Build the publishable npm package"
	@echo "  publish        - Publish @lightcone-boundary/sandbox to npm"
	@echo "  pdf            - Build docs/SYSTEM_OVERVIEW.pdf from SYSTEM_OVERVIEW.md (Eisvogel)"
	@echo "  docs-pdf       - Build PDFs for all docs/*.md"

install-plugin:
	npm --prefix physics-opencode install

test:
	npm --prefix physics-opencode test

search-index:
	$(PYTHON) scripts/build_search_index.py

books-catalog:
	$(PYTHON) scripts/build_books_catalog.py

arxiv-index:
	$(PYTHON) scripts/build_arxiv_index.py

typecheck:
	npm --prefix physics-opencode run typecheck

build:
	npm --prefix physics-opencode run build

publish:
	npm --prefix physics-opencode publish --access public

arxiv-sync:
	$(PYTHON) scripts/arxiv_oai_sync.py

data-packs:
	$(PYTHON) scripts/make_physicsocean_pack.py

pdf:
	@mkdir -p $(PDF_OUT_DIR)
	@command -v $(PANDOC) >/dev/null 2>&1 || { echo "pandoc not found. Install: brew install pandoc"; exit 1; }
	@test -f $(HOME)/.pandoc/templates/eisvogel.latex || { echo "Eisvogel template missing at ~/.pandoc/templates/eisvogel.latex"; exit 1; }
	$(PANDOC) $(DOCS_DIR)/SYSTEM_OVERVIEW.md \
		--from markdown \
		--template eisvogel \
		--pdf-engine=$(PDF_ENGINE) \
		--listings \
		--highlight-style=tango \
		--columns=140 \
		-V geometry:left=0.7in,right=0.7in,top=1in,bottom=1in \
		-V mainfont="Helvetica Neue" \
		-V monofont="Menlo" \
		-V CJKmainfont="PingFang SC" \
		-o $(PDF_OUT_DIR)/SYSTEM_OVERVIEW.pdf
	@echo "Built $(PDF_OUT_DIR)/SYSTEM_OVERVIEW.pdf"

docs-pdf:
	@mkdir -p $(PDF_OUT_DIR)
	@for f in $(DOCS_DIR)/*.md; do \
		out=$(PDF_OUT_DIR)/$$(basename $${f%.md}).pdf; \
		echo "-> $$f -> $$out"; \
		$(PANDOC) $$f \
			--from markdown \
			--template eisvogel \
			--pdf-engine=$(PDF_ENGINE) \
			--listings \
			--highlight-style=tango \
			--columns=140 \
			-V geometry:left=0.7in,right=0.7in,top=1in,bottom=1in \
			-V mainfont="Helvetica Neue" \
			-V monofont="Menlo" \
			-V CJKmainfont="PingFang SC" \
			-o $$out || exit 1; \
	done
	@echo "Built all docs PDFs into $(PDF_OUT_DIR)/"

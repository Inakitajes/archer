BIN := convoy
INSTALL_DIR := $(HOME)/.local/bin

.PHONY: build install uninstall clean test test-coverage coverage-badge release tidy

build:
	bun run build

install: build
	@mkdir -p $(INSTALL_DIR)
	@install -m 755 $(BIN) $(INSTALL_DIR)/$(BIN)
	@$(INSTALL_DIR)/$(BIN) init --global --quiet
	@echo "✓ Installed at $(INSTALL_DIR)/$(BIN)"
	@echo "  Make sure $(INSTALL_DIR) is on your PATH."

uninstall:
	@rm -f $(INSTALL_DIR)/$(BIN)
	@echo "✓ Uninstalled $(INSTALL_DIR)/$(BIN)"

clean:
	@rm -f $(BIN) src/$(BIN) dist/$(BIN)-*
	@rm -rf coverage/

test:
	bun run typecheck
	bun test

test-coverage:
	bun run test:coverage

coverage-badge:
	bun run coverage:badge

release:
	@if [ -z "$(BUMP)" ]; then \
		echo "Usage: make release BUMP=<patch|minor|major|version>"; \
		echo "  make release BUMP=patch       # e.g. 0.5.0 → 0.5.1"; \
		echo "  make release BUMP=minor       # e.g. 0.5.0 → 0.6.0"; \
		echo "  make release BUMP=major       # e.g. 0.5.0 → 1.0.0"; \
		echo "  make release BUMP=1.0.0       # explicit version"; \
		echo ""; \
		echo "Or call directly for more options:"; \
		echo "  bun run scripts/release.ts <patch|minor|major|version> [--pre <id>] [--dry-run] [--yes]"; \
		exit 1; \
	fi
	bun run scripts/release.ts $(BUMP)

tidy:
	bun install

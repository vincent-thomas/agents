.DEFAULT_GOAL := all

.PHONY: all build test clean format

all: build test

build:
	bun run --filter ./packages/agent build
	bun run --filter ./packages/vaultkeeper build

test:
	bun test

format:
	bun x oxfmt

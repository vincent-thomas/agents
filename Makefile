.PHONY: build test clean format

all: build test

build:
	bun run --filter ./packages/agent build

test:
	bun test

format:
	bun x oxfmt

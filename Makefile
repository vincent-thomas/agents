.PHONY: build test clean

all: build test

build:
	bun run --workspaces build

test:
	bun test

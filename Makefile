.DEFAULT_GOAL := all

.PHONY: all test format audit

all: deps-install format-check test

deps-install:
	bun install

audit:
	bun audit

test:
	bun test

format:
	bun x oxfmt

format-check:
	bun x oxfmt --check

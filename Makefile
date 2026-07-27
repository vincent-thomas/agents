.DEFAULT_GOAL := all

.PHONY: all test format audit

all: format-check test

audit:
	bun audit

test:
	bun test

format:
	bun x oxfmt

format-check:
	bun x oxfmt --check

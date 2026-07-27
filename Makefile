.DEFAULT_GOAL := all

.PHONY: all test format audit

all: test

audit:
	bun audit

test:
	bun test

format:
	bun x oxfmt

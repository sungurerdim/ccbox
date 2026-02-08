.PHONY: build test lint clean dev fmt tidy

VERSION ?= dev
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "unknown")

MODULE  := github.com/sungur/ccbox/internal/cli
LDFLAGS := -s -w \
	-X $(MODULE).Version=$(VERSION) \
	-X $(MODULE).Commit=$(COMMIT) \
	-X $(MODULE).Date=$(DATE)

build:
	go build -ldflags "$(LDFLAGS)" -o ccbox ./cmd/ccbox

dev:
	go run ./cmd/ccbox

test:
	go test -race ./...

lint:
	go vet ./...
	golangci-lint run

clean:
	rm -f ccbox
	go clean -cache

fmt:
	gofmt -w .

tidy:
	go mod tidy

# Native module build and test targets for Volyx Lens
#
# This Makefile provides targets for building and testing the Swift native helpers.
# The native modules (macos-system-audio.swift, macos-vision-ocr.swift) are compiled
# via swiftc during the Electron build, but can also be built and tested independently.

.PHONY: all native native-test native-test-verbose native-clean help

# Default target
all: native

# Build native helpers (requires macOS)
native:
	@node scripts/build-native.js

# Run Swift unit tests (requires macOS with Swift 5.9+)
native-test:
	@bash scripts/test-native-swift.sh

# Run Swift tests with verbose output
native-test-verbose:
	@bash scripts/test-native-swift.sh --verbose

# Run Swift tests with code coverage
native-test-coverage:
	@bash scripts/test-native-swift.sh --coverage

# Clean native build artifacts
native-clean:
	@rm -rf native-bin
	@rm -rf native/tests/.build
	@echo "Cleaned native build artifacts"

# Show help
help:
	@echo "Volyx Lens - Native Module Targets"
	@echo ""
	@echo "  make native              Build native Swift helpers"
	@echo "  make native-test         Run Swift unit tests"
	@echo "  make native-test-verbose Run tests with verbose output"
	@echo "  make native-test-coverage Run tests with code coverage"
	@echo "  make native-clean        Clean build artifacts"
	@echo "  make help                Show this help"
	@echo ""
	@echo "Note: Native targets require macOS with Xcode/Swift toolchain."

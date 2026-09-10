#!/usr/bin/env bash
# Native Swift test runner for Volyx Lens
#
# Usage:
#   scripts/test-native-swift.sh            # Run all Swift tests
#   scripts/test-native-swift.sh --coverage # Run with code coverage
#
# Requirements:
#   - macOS 13+ (Ventura)
#   - Xcode 15+ or Swift 5.9+
#   - Running on macOS (tests use XCTest framework)
#
# The tests are located in native/tests/ and use the Swift Package Manager.
# They test the pure logic extracted from the native Swift helpers without
# requiring actual ScreenCaptureKit or Vision hardware.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_DIR="${PROJECT_DIR}/native/tests"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $*"; }
log_error() { echo -e "${RED}[FAIL]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }

# Check platform
if [[ "$(uname)" != "Darwin" ]]; then
    log_warn "Native Swift tests can only run on macOS. Skipping on $(uname)."
    exit 0
fi

# Check Swift version
if ! command -v swift &>/dev/null; then
    log_error "Swift is not installed. Install Xcode or Swift toolchain."
    exit 1
fi

SWIFT_VERSION=$(swift --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)
log_info "Using Swift: ${SWIFT_VERSION:-unknown}"

# Parse arguments
COVERAGE=false
VERBOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --coverage)
            COVERAGE=true
            shift
            ;;
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--coverage] [--verbose] [--help]"
            exit 0
            ;;
        *)
            log_error "Unknown argument: $1"
            exit 1
            ;;
    esac
done

cd "${TEST_DIR}"

# Resolve package dependencies
log_info "Resolving Swift package dependencies..."
if [[ "${VERBOSE}" == true ]]; then
    swift package resolve
else
    swift package resolve 2>/dev/null
fi

# Run tests
log_info "Running native Swift tests..."

if [[ "${COVERAGE}" == true ]]; then
    log_info "Running tests with code coverage..."
    if swift test --enable-code-coverage 2>&1; then
        log_success "All Swift tests passed."

        # Generate coverage report
        COVERAGE_DIR=".build/debug/CodeCoverage"
        if [[ -d "${COVERAGE_DIR}" ]]; then
            log_info "Code coverage report available at: ${COVERAGE_DIR}"
            # Find the coverage JSON file
            COVERAGE_JSON=$(find "${COVERAGE_DIR}" -name "*.json" -print -quit 2>/dev/null || true)
            if [[ -n "${COVERAGE_JSON}" ]]; then
                log_info "Coverage data: ${COVERAGE_JSON}"
            fi
        fi
    else
        log_error "Some Swift tests failed."
        exit 1
    fi
else
    if [[ "${VERBOSE}" == true ]]; then
        if swift test 2>&1; then
            log_success "All Swift tests passed."
        else
            log_error "Some Swift tests failed."
            exit 1
        fi
    else
        if swift test 2>&1; then
            log_success "All Swift tests passed."
        else
            log_error "Some Swift tests failed. Run with --verbose for details."
            exit 1
        fi
    fi
fi

log_info "Test directory: ${TEST_DIR}"

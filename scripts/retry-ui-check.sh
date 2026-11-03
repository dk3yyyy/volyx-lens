#!/usr/bin/env bash
# Run one UI harness under xvfb and retry it exactly once on failure.
#
# The retry exists because a cold Electron paint on a shared xvfb runner can take
# several seconds; it is not a way to accept a broken gate. A second failure
# exits non-zero and prints the first attempt's log, so a deterministic failure
# stays a failure with both runs visible in the CI log.
#
# Usage: bash scripts/retry-ui-check.sh <npm-script> [args...]
#   bash scripts/retry-ui-check.sh check:onboarding-ui --no-sandbox
set -uo pipefail

npm_script="${1:?usage: retry-ui-check.sh <npm-script> [args...]}"
shift

max_attempts=2
backoff_seconds=5
log_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
log_dir="${log_root%/}/volyx-ui-checks"
safe_name="$(printf '%s' "$npm_script" | tr ':/' '__')"
mkdir -p "$log_dir"

first_log="$log_dir/${safe_name}-attempt-1.log"
attempt=1
while (( attempt <= max_attempts )); do
  log="$log_dir/${safe_name}-attempt-${attempt}.log"
  echo "::group::${npm_script} (attempt ${attempt}/${max_attempts})"
  xvfb-run -a npm run "$npm_script" -- "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  echo "::endgroup::"

  if (( status == 0 )); then
    if (( attempt > 1 )); then
      echo "${npm_script} passed on attempt ${attempt}; the first attempt failed but its log is at ${first_log}."
    fi
    exit 0
  fi

  if (( attempt == max_attempts )); then
    echo "::error::${npm_script} failed on both attempts (last exit ${status})."
    echo "::group::First attempt log (${first_log})"
    cat "$first_log" || true
    echo "::endgroup::"
    exit "$status"
  fi

  echo "::warning::${npm_script} failed on attempt ${attempt} (exit ${status}); retrying once in ${backoff_seconds}s."
  sleep "$backoff_seconds"
  attempt=$(( attempt + 1 ))
done

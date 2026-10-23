#!/usr/bin/env bash
# Retry a CI download command up to three times, preserving its final status.
# Usage: .github/retry.sh <command> [args...]
# Pass `timeout <duration>` as part of the command to bound each attempt.
set -euo pipefail
if [[ "${1:-}" == "--help" ]]; then sed -n '2,4p' "$0" | cut -c3-; exit 0; fi
if [[ $# == 0 ]]; then echo "usage: $0 <command> [args...]" >&2; exit 2; fi

for attempt in 1 2 3; do
  if "$@"; then exit 0; else status=$?; fi
  echo "Command failed with status $status (attempt $attempt/3): $*" >&2
  if [[ "$attempt" == 3 ]]; then exit "$status"; fi
  sleep $((attempt * 5))
done

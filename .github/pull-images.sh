#!/usr/bin/env bash
# Pull images with retries. Docker Hub's token endpoint times out now and then
# on hosted runners; `docker run` has no retry and fails the job with 125.
set -euo pipefail
for image in "$@"; do
  for attempt in 1 2 3 4 5; do
    if docker pull --quiet "$image" >/dev/null; then break; fi
    if [[ "$attempt" == 5 ]]; then echo "pull failed after 5 attempts: $image" >&2; exit 1; fi
    echo "pull of $image failed (attempt $attempt), retrying" >&2
    sleep $((attempt * 5))
  done
done

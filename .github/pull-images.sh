#!/usr/bin/env bash
# Pull images with retries before `docker run`, Compose or a test fixture
# starts them; registries time out now and then on hosted runners, and
# `docker run` has no retry and fails the job with 125.
#
# A Docker Hub image is never pulled from Docker Hub, whose anonymous pull
# limit failed CI runs. It comes from the mirror at the digest in
# .github/mirror-images.txt and is tagged locally with the name given here,
# so `docker run nats:2.14.3-alpine` finds it without contacting Docker Hub.
# Images of other registries are pulled as given.
#
# Usage: .github/pull-images.sh <image>...
set -euo pipefail
if [[ "${1:-}" == "--help" ]]; then sed -n '2,12p' "$0" | cut -c3-; exit 0; fi

list="$(dirname "$0")/mirror-images.txt"
mirror="${MIRROR:-ghcr.io/k2b-dev/mirror}"

pull() {
  for attempt in 1 2 3 4 5; do
    if docker pull --quiet "$1" >/dev/null; then return; fi
    if [[ "$attempt" == 5 ]]; then echo "pull failed after 5 attempts: $1" >&2; exit 1; fi
    echo "pull of $1 failed (attempt $attempt), retrying" >&2
    sleep $((attempt * 5))
  done
}

for image in "$@"; do
  name="${image#docker.io/}"
  name="${name#library/}"
  # Docker reads the first path component as a registry when it has a dot or a port.
  if [[ "$name" == */* && "${name%%/*}" == *[.:]* ]]; then
    pull "$image"
    continue
  fi
  entry=$(awk -F@ -v name="$name" '$1 == name { print; exit }' "$list")
  if [[ -z "$entry" ]]; then
    echo "$image is a Docker Hub image; add it to $list and pull it through the mirror" >&2
    exit 1
  fi
  pull "$mirror/$entry"
  docker tag "$mirror/$entry" "$image"
done

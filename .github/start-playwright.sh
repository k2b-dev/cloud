#!/usr/bin/env bash
# Install the catalog-pinned server with retries, then start the matching image.
# Usage: .github/start-playwright.sh
# Leaves the `playwright` container running on 127.0.0.1:3333 for the job.
set -euo pipefail
if [[ "${1:-}" == "--help" ]]; then sed -n '2,4p' "$0" | cut -c3-; exit 0; fi

scripts=$(cd -- "$(dirname -- "$0")" && pwd)
version=$(jq -er '.workspaces.catalog.playwright' "$scripts/../package.json")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Playwright catalog version must be exact" >&2; exit 1; }
image="mcr.microsoft.com/playwright:v$version-noble"
"$scripts/pull-images.sh" "$image"

# The image ships browsers, but removes the npm package after installing them.
# Keep the package in the job's temporary directory, mounted read-only; startup
# uses Node directly and cannot fall back to a registry download.
package_dir=$(mktemp -d "${RUNNER_TEMP:?}/playwright-server.XXXXXX")
chmod 755 "$package_dir"
"$scripts/retry.sh" timeout 120s npm install --prefix "$package_dir" \
  --no-audit --no-fund --ignore-scripts --save-exact "playwright@$version"

for attempt in 1 2 3; do
  if docker run --detach --name playwright --network host --init --ipc=host --user pwuser --workdir /home/pwuser \
      --mount "type=bind,source=$package_dir,target=/opt/playwright,readonly" \
      "$image" node /opt/playwright/node_modules/playwright/cli.js run-server --port 3333 --host 127.0.0.1 \
    && timeout 120s bash -c 'until docker logs playwright 2>&1 | grep -q "Listening on"; do sleep 1; done'; then
    exit 0
  fi
  echo "Playwright failed to become ready (attempt $attempt/3)" >&2
  docker logs playwright >&2 || true
  docker rm --force playwright || true
  if [[ "$attempt" != 3 ]]; then sleep $((attempt * 5)); fi
done
exit 1

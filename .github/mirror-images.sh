#!/usr/bin/env bash
# Copy every image of .github/mirror-images.txt from Docker Hub to the mirror.
# The manifest list is copied unchanged, so the mirror serves the same digest
# for every platform; an image the mirror already serves at its digest is
# skipped. For ghcr.io it then checks that each image can be pulled without
# credentials, as CI service containers and operators building from source do.
#
# Usage: .github/mirror-images.sh
#   MIRROR=localhost:5000/mirror .github/mirror-images.sh   copy into a local registry
set -euo pipefail
if [[ "${1:-}" == "--help" ]]; then sed -n '2,9p' "$0" | cut -c3-; exit 0; fi

list="$(dirname "$0")/mirror-images.txt"
mirror="${MIRROR:-ghcr.io/k2b-dev/mirror}"
manifest_types="application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"

digest_of() { docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' 2>/dev/null | jq -r .digest; }

public() {
  local repository="${1#ghcr.io/}" token
  token=$(curl --fail --silent --show-error "https://ghcr.io/token?scope=repository:$repository:pull" | jq -r .token) &&
    curl --fail --silent --show-error --head --output /dev/null \
      -H "Authorization: Bearer $token" -H "Accept: $manifest_types" "https://ghcr.io/v2/$repository/manifests/$2"
}

failed=0
while read -r image; do
  target="$mirror/${image%@*}"
  digest="${image#*@}"
  if [[ "$(digest_of "$target" || true)" == "$digest" ]]; then
    echo "present  $target@$digest"
  else
    echo "copy     docker.io/$image -> $target"
    docker buildx imagetools create --tag "$target" "docker.io/$image"
    actual=$(digest_of "$target" || true)
    if [[ "$actual" != "$digest" ]]; then
      echo "::error::$target serves ${actual:-nothing}, expected $digest" >&2
      failed=1
      continue
    fi
  fi
  if [[ "$mirror" == ghcr.io/* ]] && ! public "${target%:*}" "$digest"; then
    echo "::error::${target%:*} cannot be pulled anonymously. Make the package public: Package settings > Change visibility." >&2
    failed=1
  fi
done < <(grep -vE '^[[:space:]]*(#|$)' "$list")
exit "$failed"

#!/usr/bin/env bash
# Copy every image of .github/mirror-images.txt from Docker Hub to the mirror.
# Consumers pull by digest, so an image is copied only when the mirror does
# not serve its pinned digest yet, and then unchanged; its tag is a label.
# On ghcr.io, every digest must be pullable without credentials, as CI service
# containers and operators building from source pull it. Registry requests
# are retried; an image that still fails is reported, the others are handled,
# and the script exits 1.
# Also keeps the DB-IP snapshot month pinned in the Dockerfile, copied from
# DB-IP only while it still serves that month and the files match the Dockerfile checksums.
#
# Usage: .github/mirror-images.sh
#   MIRROR=localhost:5000/mirror .github/mirror-images.sh   copy into a local registry
set -euo pipefail
if [[ "${1:-}" == "--help" ]]; then sed -n '2,13p' "$0" | cut -c3-; exit 0; fi

list="$(dirname "$0")/mirror-images.txt"
mirror="${MIRROR:-ghcr.io/k2b-dev/mirror}"
manifest_types="application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"
metadata=$(mktemp)
snapshot_dir=""
trap 'rm -f "$metadata"; if [[ -n "$snapshot_dir" ]]; then rm -rf "$snapshot_dir"; fi' EXIT

# curl itself retries timeouts, refused connections and 408, 429 and 5xx
# answers. --fail keeps an error body out of the output; --write-out appends
# the final HTTP status, 000 when no answer came.
http() { curl --fail --silent --show-error --retry 4 --retry-connrefused --max-time 30 --write-out '\n%{http_code}' "$@" || true; }

# Whether the mirror serves repository $1 at digest or tag $2: 0 yes, 1 no, 2 the
# registry kept failing. GHCR is asked without credentials; it refuses the
# token for a package that is missing or private with 403.
served() {
  if [[ "$mirror" != ghcr.io/* ]]; then
    local reference="$1:$2"
    if [[ "$2" == sha256:* ]]; then reference="$1@$2"; fi
    docker buildx imagetools inspect --raw "$reference" >/dev/null 2>&1 || return 1
    return 0
  fi
  local repository="${1#ghcr.io/}" response token
  response=$(http "https://ghcr.io/token?scope=repository:$repository:pull")
  case "${response##*$'\n'}" in 200) ;; 401 | 403 | 404) return 1 ;; *) return 2 ;; esac
  token=$(jq -r .token <<<"${response%$'\n'*}") || return 2
  response=$(http --head --output /dev/null -H "Authorization: Bearer $token" -H "Accept: $manifest_types" \
    "https://ghcr.io/v2/$repository/manifests/$2")
  case "${response##*$'\n'}" in 200) return 0 ;; 401 | 403 | 404) return 1 ;; *) return 2 ;; esac
}

# Copies docker.io/$1 (<name>:<tag>@<digest>) unchanged, also when it is a single manifest.
copy() {
  : >"$metadata"
  for attempt in 1 2 3 4 5; do
    docker buildx imagetools create --prefer-index=false --metadata-file "$metadata" --tag "$mirror/${1%@*}" "docker.io/$1" && return
    if [[ "$attempt" == 5 ]]; then return 1; fi
    echo "copy of $1 failed (attempt $attempt), retrying" >&2
    sleep $((attempt * 5))
  done
}

failed=0
fail() { echo "::error::$1" >&2; failed=1; }
while read -r image; do
  repository="$mirror/${image%%[:@]*}"
  digest="${image#*@}"
  status=0 && served "$repository" "$digest" || status=$?
  if [[ "$status" == 0 ]]; then echo "present  $repository@$digest"; continue; fi
  if [[ "$status" == 2 ]]; then fail "$repository@$digest: the registry kept failing, nothing was copied"; continue; fi
  echo "copy     docker.io/$image -> $repository"
  if ! copy "$image"; then fail "copying docker.io/$image failed"; continue; fi
  # Take the digest from the push, never from the tag: GHCR can answer a tag
  # it accepted a moment ago with "not found" or the digest it had before.
  actual=$(jq -r '."containerimage.descriptor".digest // empty' "$metadata")
  if [[ "$actual" != "$digest" ]]; then fail "$repository received ${actual:-nothing}, expected $digest"; continue; fi
  # A new GHCR package is private, and a pushed digest may take a moment to show.
  for attempt in 1 2 3; do
    status=0 && served "$repository" "$digest" || status=$?
    if [[ "$status" == 0 || "$attempt" == 3 ]]; then break; fi
    sleep 2
  done
  if [[ "$status" != 0 ]]; then
    fail "$repository@$digest cannot be pulled without credentials. If the package is new, make it public: Package settings > Change visibility."
  fi
done < <(grep -vE '^[[:space:]]*(#|$)' "$list")

# Archive the unchanged gzip files while DB-IP still serves this month.
copy_snapshot() {
  local dockerfile="$(dirname "$0")/../Dockerfile" month repository status kind attempt
  local -a months checksums
  mapfile -t months < <(grep -oE 'mirror/dbip-lite:[0-9]{4}-(0[1-9]|1[0-2])' "$dockerfile" | sort -u)
  if [[ "${#months[@]}" != 1 ]]; then fail "$dockerfile: expected one distinct DB-IP snapshot month"; return; fi
  month="${months[0]##*:}"
  repository="$mirror/dbip-lite"
  status=0 && served "$repository" "$month" || status=$?
  if [[ "$status" == 0 ]]; then echo "present  $repository:$month"; return; fi
  if [[ "$status" == 2 ]]; then fail "$repository:$month: the registry kept failing, nothing was copied"; return; fi
  snapshot_dir=$(mktemp -d) || { fail "creating DB-IP snapshot directory failed"; return; }
  for kind in city asn; do
    mapfile -t checksums < <(grep -oE "[a-f0-9]{64}  dbip-$kind-lite\.mmdb\.gz" "$dockerfile")
    if [[ "${#checksums[@]}" != 1 ]]; then fail "$dockerfile: expected one $kind checksum"; return; fi
    printf '%s\n' "${checksums[0]}" >>"$snapshot_dir/SHA256SUMS"
    if ! curl --fail --silent --show-error --retry 4 --retry-connrefused --max-time 300 \
      --output "$snapshot_dir/dbip-$kind-lite.mmdb.gz" "https://download.db-ip.com/free/dbip-$kind-lite-$month.mmdb.gz"; then
      fail "downloading DB-IP $kind snapshot for $month failed"; return
    fi
  done
  if ! (cd "$snapshot_dir" && sha256sum -c SHA256SUMS); then fail "DB-IP snapshot checksums for $month do not match $dockerfile"; return; fi
  printf 'FROM scratch\nCOPY dbip-city-lite.mmdb.gz dbip-asn-lite.mmdb.gz /\n' >"$snapshot_dir/Dockerfile"
  echo "copy     DB-IP $month -> $repository:$month"
  for attempt in 1 2 3 4 5; do
    if docker build --tag "$repository:$month" "$snapshot_dir" && docker push "$repository:$month"; then break; fi
    if [[ "$attempt" == 5 ]]; then fail "copying DB-IP snapshot for $month failed"; return; fi
    echo "copy of DB-IP $month failed (attempt $attempt), retrying" >&2
    sleep $((attempt * 5))
  done
  for attempt in 1 2 3; do
    status=0 && served "$repository" "$month" || status=$?
    if [[ "$status" == 0 || "$attempt" == 3 ]]; then break; fi
    sleep 2
  done
  if [[ "$status" != 0 ]]; then
    fail "$repository:$month cannot be pulled without credentials. If the package is new, make it public: Package settings > Change visibility."
  fi
}
copy_snapshot
exit "$failed"

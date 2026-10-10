#!/usr/bin/env bash
# Poppler's pdftotext, pdfinfo, and pdffonts for CI, from an image pinned by
# digest. Installing Poppler on the runner failed CI twice: apt-get hung on
# the runner's apt mirror, and Homebrew downloads its API index from
# formulae.brew.sh before every install, which timed out. The image is
# pulled with the job's other images, so no extra host is involved.
#
# Usage:
#   .github/poppler.sh install       start the container and link the tools into /usr/local/bin
#   pdftotext|pdfinfo|pdffonts ...   run the tool through one of those links
#
# The container runs without network access, as the calling user, and reads
# only the working directory of `install`, the temporary directory, and
# $RUNNER_TEMP, where the Grids job writes the PDFs it checks. A tool cannot
# open a file anywhere else. It runs through `docker exec`, which starts in a
# tenth of the time of `docker run` and gets the caller's stdin.
#
# The publisher builds the image daily and deletes its date tags after about
# eight months, so move the pin to a newer tag before then.
set -euo pipefail

image=backplane/pdf:20261009@sha256:0e9b353de3fa9f3399d7a5c5e3ab6233ec963e37e1db5c5c8cd5cb2e6b580168
container=ci-poppler
tool=$(basename "$0")

if [[ "$tool" != poppler.sh ]]; then exec docker exec --interactive --workdir "$PWD" "$container" "$tool" "$@"; fi
if [[ "${1:-}" != install ]]; then sed -n '2,19p' "$0" | cut -c3-; [[ "${1:-}" == --help ]]; exit; fi

"$(dirname "$0")/pull-images.sh" "$image"
tmp=$(realpath "${TMPDIR:-/tmp}")
docker run --detach --name "$container" --network none --read-only --user "$(id -u):$(id -g)" \
  --volume "$tmp:$tmp:ro" --volume "$PWD:$PWD:ro" ${RUNNER_TEMP:+--volume "$RUNNER_TEMP:$RUNNER_TEMP:ro"} \
  --entrypoint sleep "$image" infinity >/dev/null
for name in pdftotext pdfinfo pdffonts; do sudo ln -sf "$(realpath "$0")" "/usr/local/bin/$name"; done
pdftotext -v

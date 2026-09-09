#!/bin/sh
# Cloud CLI installer and updater.
#
#   curl -fsSL https://your-cloud.example/cli | sh
#   curl -fsSL https://your-cloud.example/cli | sh -s -- --yes

set -eu

REPO="${CLD_RELEASE_REPO:-k2b-dev/cloud}"
RELEASE_BASE="${CLD_RELEASE_BASE:-https://github.com/${REPO}/releases}"
API_BASE="${CLD_RELEASE_API_BASE:-https://api.github.com/repos/${REPO}}"
PREFIX="${HOME}/.local/bin"
SKILLS_DIR="${HOME}/.agents/skills"
VERSION="${CLD_VERSION:-latest}"
VERIFY=1
ASSUME_YES=0
INSTALL_SKILL=ask
CLAUDE_SYMLINK=ask
CURL_RETRY_COUNT=3
CURL_CONNECT_TIMEOUT=10
CURL_MAX_TIME=60
MAX_RELEASE_PAGES=100
COSIGN_IDENTITY_REGEXP='^https://github\.com/k2b-dev/cloud/\.github/workflows/cli\.yml@refs/tags/cli-v[0-9]+\.[0-9]+\.[0-9]+$'
SKILL_ASSET="cloud-cli-skill.tar.gz"
SKILL_NAME="cloud-cli"

die() { printf 'cld: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
curl_get() {
  curl -fsSL --retry "$CURL_RETRY_COUNT" --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" "$@"
}

stable_version_key() {
  printf '%s\n' "$1" | awk -F. '
    NF == 3 && $1 ~ /^(0|[1-9][0-9]*)$/ && $2 ~ /^(0|[1-9][0-9]*)$/ && $3 ~ /^(0|[1-9][0-9]*)$/ {
      printf "%09d%09d%09d\n", $1, $2, $3
    }
  '
}

latest_release() {
  page=1
  tags=""
  while :; do
    body=$(curl_get "${API_BASE}/releases?per_page=100&page=${page}") || return 1
    [ "$(printf '%s' "$body" | tr -d '[:space:]')" = "[]" ] && break
    page_tags=$(printf '%s\n' "$body" | sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\(cli-v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p')
    tags="${tags}${page_tags}\n"
    [ "$page" -lt "$MAX_RELEASE_PAGES" ] || return 1
    page=$((page + 1))
  done
  printf '%b' "$tags" | while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    key=$(stable_version_key "${tag#cli-v}") || continue
    [ -n "$key" ] && printf '%s %s\n' "$key" "$tag"
  done | sort | tail -n 1 | awk '{ print $2 }'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix=*) PREFIX="${1#--prefix=}"; shift ;;
    --skills-dir=*) SKILLS_DIR="${1#--skills-dir=}"; shift ;;
    --version=*) VERSION="${1#--version=}"; shift ;;
    --no-verify) VERIFY=0; shift ;;
    --no-skills) INSTALL_SKILL=0; shift ;;
    --claude-symlink) CLAUDE_SYMLINK=1; shift ;;
    --no-claude-symlink) CLAUDE_SYMLINK=0; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: install.sh [options]

Install or update Cloud CLI.

  --prefix=DIR       Install into DIR (default: ~/.local/bin)
  --skills-dir=DIR   Install agent skills into DIR (default: ~/.agents/skills)
  --version=VERSION  Install cli-vX.Y.Z or X.Y.Z (default: latest CLI release)
  --no-verify        Skip optional Cosign verification; SHA-256 is still required
  --no-skills        Skip installing the Cloud CLI agent skill
  --claude-symlink   Symlink the skill into ~/.claude/skills/cloud-cli
  --no-claude-symlink
                     Do not symlink the skill into Claude Code
  -y, --yes          Skip the confirmation prompt
  -h, --help         Show this help
EOF
      exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
done

confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  if [ ! -t 0 ] && [ ! -r /dev/tty ]; then
    die "not a terminal; pass --yes to install non-interactively"
  fi
  printf '%s [Y/n] ' "$1"
  if [ -r /dev/tty ]; then
    IFS= read -r reply < /dev/tty || reply=""
  else
    IFS= read -r reply || reply=""
  fi
  case "$reply" in
    ''|y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

confirm_default_no() {
  [ "$ASSUME_YES" = "1" ] && return 1
  if [ ! -t 0 ] && [ ! -r /dev/tty ]; then
    die "not a terminal; pass --yes or an explicit flag to install non-interactively"
  fi
  printf '%s [y/N] ' "$1"
  if [ -r /dev/tty ]; then
    IFS= read -r reply < /dev/tty || reply=""
  else
    IFS= read -r reply || reply=""
  fi
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$OS" in
  linux|darwin) ;;
  *) die "unsupported OS: $OS" ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported architecture: $ARCH" ;;
esac

have curl || die "curl is required"
if [ "$VERSION" = "latest" ]; then
  VERSION=$(latest_release) || die "could not find a Cloud CLI release"
  [ -n "$VERSION" ] || die "could not find a stable Cloud CLI release"
elif [ "${VERSION#cli-v}" = "$VERSION" ]; then
  VERSION="cli-v${VERSION#v}"
fi

VERSION_NUM=${VERSION#cli-v}
TARGET_KEY=$(stable_version_key "$VERSION_NUM")
[ -n "$TARGET_KEY" ] || die "--version must be a stable version such as 1.2.3"
ASSET="cld_${OS}_${ARCH}"
DOWNLOAD_BASE="${RELEASE_BASE}/download/${VERSION}"
CURRENT=""
CURRENT_IS_TARGET=0
if [ -x "$PREFIX/cld" ]; then
  CURRENT=$("$PREFIX/cld" --version 2>/dev/null | awk 'NR == 1 { print $2 }' || true)
fi

if [ "$CURRENT" = "$VERSION_NUM" ]; then
  printf 'cld %s already installed at %s\n' "$VERSION_NUM" "$PREFIX"
  CURRENT_IS_TARGET=1
fi
CURRENT_KEY=$(stable_version_key "$CURRENT")
if [ "$CURRENT_IS_TARGET" = "0" ] && [ "${CLD_VERSION:-latest}" = "latest" ] && [ -n "$CURRENT_KEY" ] && [ "$CURRENT_KEY" \> "$TARGET_KEY" ]; then
  printf 'cld %s is newer than the latest published release (%s)\n' "$CURRENT" "$VERSION_NUM"
  exit 0
fi

printf '\nCloud CLI installer\n'
printf '  target:  %s\n' "$PREFIX"
if [ "$INSTALL_SKILL" = "0" ]; then
  printf '  skill:   skipped\n'
else
  printf '  skill:   %s/%s\n' "$SKILLS_DIR" "$SKILL_NAME"
fi
if [ -n "$CURRENT" ]; then
  printf '  current: %s\n' "$CURRENT"
  if [ "$CURRENT_IS_TARGET" = "1" ]; then
    printf '  new:     already installed\n'
  else
    printf '  new:     %s\n' "$VERSION_NUM"
  fi
else
  printf '  version: %s\n' "$VERSION_NUM"
fi
if [ "$VERIFY" = "1" ] && have cosign; then
  printf '  verify:  SHA-256 + Cosign\n'
elif [ "$VERIFY" = "1" ]; then
  printf '  verify:  SHA-256; Cosign unavailable\n'
else
  printf '  verify:  SHA-256; Cosign disabled\n'
fi
printf '\n'
confirm "proceed?" || { printf 'aborted.\n'; exit 1; }

if [ "$INSTALL_SKILL" = "ask" ]; then
  if [ "$ASSUME_YES" = "1" ]; then
    INSTALL_SKILL=1
  elif confirm "Install the Cloud CLI agent skill? (recommended)"; then
    INSTALL_SKILL=1
  else
    INSTALL_SKILL=0
  fi
fi
if [ "$INSTALL_SKILL" = "1" ] && [ "$CLAUDE_SYMLINK" = "ask" ]; then
  if confirm_default_no "Also symlink the skill to Claude Code at ~/.claude/skills/cloud-cli?"; then
    CLAUDE_SYMLINK=1
  else
    CLAUDE_SYMLINK=0
  fi
fi

TMP=$(mktemp -d)
staged=""
cleanup() {
  rm -rf "$TMP"
  [ -z "$staged" ] || rm -rf "$staged"
}
trap cleanup EXIT

checksum() {
  target="$1"
  value=$(awk -v target="$target" '$2 == target || $2 == "*" target { print $1 }' "$TMP/checksums.txt")
  [ -n "$value" ] || die "$target is not listed in checksums.txt"
  printf '%s\n' "$value"
}

verify_file() {
  file="$1"
  expected="$2"
  if have sha256sum; then
    actual=$(sha256sum "$file" | awk '{ print $1 }')
  elif have shasum; then
    actual=$(shasum -a 256 "$file" | awk '{ print $1 }')
  else
    die "sha256sum or shasum is required"
  fi
  [ "$actual" = "$expected" ] || die "SHA-256 mismatch; refusing to install"
}

install_skill() {
  archive="$1"
  have tar || die "tar is required to install the Cloud CLI skill"
  work="$TMP/skill"
  mkdir -p "$work"
  tar -xzf "$archive" -C "$work"
  [ -f "$work/$SKILL_NAME/SKILL.md" ] || die "skill archive is invalid"
  mkdir -p "$SKILLS_DIR"
  dest="$SKILLS_DIR/$SKILL_NAME"
  backup="$SKILLS_DIR/.$SKILL_NAME.backup.$$"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    mv "$dest" "$backup"
  fi
  if mv "$work/$SKILL_NAME" "$dest"; then
    rm -rf "$backup"
  else
    rm -rf "$dest"
    [ ! -e "$backup" ] && [ ! -L "$backup" ] || mv "$backup" "$dest"
    die "could not install Cloud CLI skill"
  fi
  printf '✓ Cloud CLI skill installed at %s\n' "$dest"

  if [ "$CLAUDE_SYMLINK" = "1" ]; then
    claude_dir="$HOME/.claude/skills"
    claude_dest="$claude_dir/$SKILL_NAME"
    mkdir -p "$claude_dir"
    if [ -L "$claude_dest" ]; then
      current_link=$(readlink "$claude_dest" || true)
      if [ "$current_link" = "$dest" ]; then
        printf '✓ Claude Code skill symlink already points to %s\n' "$dest"
      else
        printf 'cld: Claude Code skill symlink exists and points elsewhere; left unchanged: %s\n' "$claude_dest" >&2
      fi
    elif [ -e "$claude_dest" ]; then
      printf 'cld: Claude Code skill path exists and is not a symlink; left unchanged: %s\n' "$claude_dest" >&2
    else
      ln -s "$dest" "$claude_dest"
      printf '✓ Claude Code skill symlink created at %s\n' "$claude_dest"
    fi
  fi
}

curl_get "${DOWNLOAD_BASE}/checksums.txt" -o "$TMP/checksums.txt" || die "missing checksum manifest"
if [ "$VERIFY" = "1" ] && have cosign; then
  curl_get "${DOWNLOAD_BASE}/checksums.txt.sig" -o "$TMP/checksums.txt.sig" || die "missing checksum signature"
  curl_get "${DOWNLOAD_BASE}/checksums.txt.pem" -o "$TMP/checksums.txt.pem" || die "missing checksum certificate"
  cosign verify-blob \
    --certificate "$TMP/checksums.txt.pem" \
    --signature "$TMP/checksums.txt.sig" \
    --certificate-identity-regexp "$COSIGN_IDENTITY_REGEXP" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "$TMP/checksums.txt" >/dev/null 2>&1 || die "Cosign verification failed"
fi

if [ "$CURRENT_IS_TARGET" = "0" ]; then
  expected=$(checksum "$ASSET")
  curl_get "${DOWNLOAD_BASE}/${ASSET}" -o "$TMP/$ASSET" || die "could not download $ASSET"
  verify_file "$TMP/$ASSET" "$expected"

  mkdir -p "$PREFIX"
  staged="$PREFIX/.cld.installing.$$"
  cp "$TMP/$ASSET" "$staged"
  chmod 755 "$staged"
  mv -f "$staged" "$PREFIX/cld"
  staged=""
  printf '✓ cld %s installed at %s/cld\n' "$VERSION_NUM" "$PREFIX"
fi

if [ "$INSTALL_SKILL" = "1" ]; then
  expected=$(checksum "$SKILL_ASSET")
  curl_get "${DOWNLOAD_BASE}/${SKILL_ASSET}" -o "$TMP/$SKILL_ASSET" || die "could not download $SKILL_ASSET"
  verify_file "$TMP/$SKILL_ASSET" "$expected"
  install_skill "$TMP/$SKILL_ASSET"
fi

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *)
    printf '\n%s is not in your PATH. Add to your shell rc:\n' "$PREFIX"
    printf '    export PATH="%s:$PATH"\n' "$PREFIX"
    ;;
esac

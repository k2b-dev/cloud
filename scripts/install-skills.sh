#!/usr/bin/env bash
# Symlink this repo's skills into the agent skill directories.
#
# Symlinks rather than copies on purpose: edits under skills/ are visible to
# every agent immediately, with no reinstall step. Note that `bunx skills add`
# installs a *copy* and would shadow these links with a frozen snapshot.
#
# Only symlinks are ever replaced. A real directory at a target path is left
# untouched and reported; remove it yourself if the link should supersede it.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/skills"

# Codex and other agents read ~/.agents/skills; Claude reads ~/.claude/skills.
TARGET_DIRS=(
  "${AGENTS_HOME:-$HOME/.agents}/skills"
  "${CLAUDE_HOME:-$HOME/.claude}/skills"
)

status=0
for target_dir in "${TARGET_DIRS[@]}"; do
  mkdir -p "$target_dir"

  for skill_dir in "$SOURCE_DIR"/*; do
    [ -d "$skill_dir" ] || continue

    skill_name="$(basename "$skill_dir")"
    target_path="$target_dir/$skill_name"
    action="linked"

    if [ -L "$target_path" ]; then
      rm "$target_path"
      action="relinked"
    elif [ -e "$target_path" ]; then
      echo "  skipped  $target_path exists and is not a symlink; remove it to install the link" >&2
      status=1
      continue
    fi

    ln -s "$skill_dir" "$target_path"
    echo "  $action  $target_path"
  done
done

echo "done — ${#TARGET_DIRS[@]} directories"
exit "$status"

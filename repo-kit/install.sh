#!/usr/bin/env bash
# Copies the repro-review skill into a target repository, so a Claude Code
# session started on that repository knows how to read a bundle.
#
#   ./repo-kit/install.sh /path/to/your/repo
#
# Skills are loaded from the repository's own .claude/skills/, and a cloud
# session only ever sees committed files, so this has to be committed there.
set -euo pipefail

target="${1:-}"
if [ -z "$target" ]; then
  echo "usage: $0 /path/to/target/repo" >&2
  exit 2
fi
if [ ! -d "$target/.git" ]; then
  echo "warning: $target does not look like a git repository" >&2
fi

here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$target/.claude/skills/repro-review"
cp "$here/.claude/skills/repro-review/SKILL.md" "$target/.claude/skills/repro-review/SKILL.md"
echo "installed .claude/skills/repro-review/SKILL.md into $target"
echo
echo "Next:"
echo "  1. git -C $target add .claude/skills/repro-review/SKILL.md && git -C $target commit -m 'Add repro-review skill'"
echo "  2. Drop a repro-YYYY-MM-DD-HHMM folder into the repo (or let vid2claude commit one for you)."
echo "  3. Tell Claude Code: Read <folder>/README.md and follow it."

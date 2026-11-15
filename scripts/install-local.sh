#!/usr/bin/env bash
# Refresh a local runtime copy of copilot-counterpart from this checkout.
#
#   scripts/install-local.sh [--dir DIR] [--skill-dir DIR]... [--no-skill] [--keep N] [--allow-dirty]
#
# The registered MCP server should point at the runtime copy, not this checkout, so
# editing source never changes a running host by accident. This script: checks the
# checkout is committed, runs the tests here, backs up the current runtime, copies the
# source, installs locked dependencies without lifecycle scripts, runs the tests there,
# records provenance, and copies the skill. Restart host sessions afterwards.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${COPILOT_COUNTERPART_INSTALL_DIR:-$HOME/.local/share/copilot-counterpart}"
SKILL_DIRS=()
DEFAULT_SKILLS=1
KEEP=2
ALLOW_DIRTY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --skill-dir) SKILL_DIRS+=("$2"); DEFAULT_SKILLS=0; shift 2 ;;
    --no-skill) DEFAULT_SKILLS=0; SKILL_DIRS=(); shift ;;
    --keep) KEEP="$2"; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

# By default, update the skill wherever a copilot-delegation skill is already installed
# as a real directory (a symlink to one of these is updated through its target).
if [ "$DEFAULT_SKILLS" = 1 ]; then
  for candidate in "$HOME/.codex/skills/copilot-delegation" "$HOME/.claude/skills/copilot-delegation"; do
    if [ -d "$candidate" ] && [ ! -L "$candidate" ]; then SKILL_DIRS+=("$candidate"); fi
  done
fi

case "$DIR" in /|"$HOME"|"$SRC"|"$SRC"/*) echo "Refusing to install into $DIR" >&2; exit 2 ;; esac

cd "$SRC"
if [ "$ALLOW_DIRTY" = 0 ] && git rev-parse --git-dir >/dev/null 2>&1 && [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes in $SRC; commit them or pass --allow-dirty." >&2; exit 1
fi
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
VERSION="$(node -p "require('./package.json').version")"

echo "Testing source ($VERSION, ${COMMIT:0:7})"
npm test >/dev/null 2>&1 || { echo "Source tests failed; nothing installed. Run npm test for details." >&2; exit 1; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PARENT="$(dirname "$DIR")"; NAME="$(basename "$DIR")"
mkdir -p "$PARENT"
if [ -d "$DIR" ]; then
  BACKUP="$PARENT/$NAME-backup-$STAMP"
  rsync -a --exclude node_modules "$DIR/" "$BACKUP/"
  echo "Backed up current runtime to $BACKUP"
fi

rsync -a --delete --exclude node_modules --exclude .git --exclude .github \
  --exclude INSTALLATION.md --exclude source-sha256.json "$SRC/" "$DIR/"
cd "$DIR"
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
if ! npm test >/dev/null 2>&1; then
  echo "Installed copy failed its tests. Previous runtime: ${BACKUP:-none}." >&2
  echo "Restore with: rsync -a --delete --exclude node_modules '${BACKUP:-}/' '$DIR/' && (cd '$DIR' && npm ci --ignore-scripts)" >&2
  exit 1
fi

node -e '
const { createHash } = require("crypto"), fs = require("fs"), path = require("path");
const files = {};
const walk = d => { if (!fs.existsSync(d)) return; for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else files[p] = createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } };
["src", "test", "vendor", "skills"].forEach(walk);
fs.writeFileSync("source-sha256.json", JSON.stringify({ commit: process.argv[1], files }, null, 2) + "\n");' "$COMMIT"
cat > INSTALLATION.md <<EOF
# Local copilot-counterpart installation

Installed $(date +%Y-%m-%d) by scripts/install-local.sh: v$VERSION.
Source: $SRC (commit ${COMMIT:0:7})
Previous runtime: ${BACKUP:-none}
Dependencies: npm ci --ignore-scripts
EOF

for skill in "${SKILL_DIRS[@]:-}"; do
  [ -n "$skill" ] || continue
  mkdir -p "$skill" && cp "$SRC/skills/copilot-delegation/SKILL.md" "$skill/SKILL.md"
  echo "Updated skill in $skill"
done

# Keep only the newest KEEP backups of this runtime.
{ ls -1d "$PARENT/$NAME"-backup-* 2>/dev/null || true; } | sort | awk -v keep="$KEEP" '{ a[NR] = $0 } END { for (i = 1; i <= NR - keep; i++) print a[i] }' |
  while read -r old; do rm -rf "$old"; echo "Removed old backup $old"; done

echo "Installed v$VERSION (${COMMIT:0:7}) at $DIR. Start new host sessions to load it."

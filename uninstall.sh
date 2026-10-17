#!/usr/bin/env bash
# Deep Connect — remove the plugin from the DSH desktop profile.
#
# Reverses install.sh: drops the Loader row, the bundle entry, the dependency,
# and the profile symlink. Your data under ~/.dsh/deep-connect is KEPT unless you
# pass --purge, because it holds the device identity and the peer conversation
# copies — deleting it is a separate decision from uninstalling the code.
#
#   ./uninstall.sh
#   ./uninstall.sh --purge
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${PROFILE:-desktop}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PKG_NAME="@local/dsh-deep-connect"
PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --help|-h) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

STAMP="$(date +%s)"

if [[ -f "$PROFILE_DIR/package.json" ]]; then
  cp "$PROFILE_DIR/package.json" "$PROFILE_DIR/package.json.bak-dc-$STAMP"
  node - "$PROFILE_DIR/package.json" "$PKG_NAME" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [file, pkgName] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(file, 'utf8'));
let changed = false;
if (pkg.dependencies?.[pkgName] !== undefined) {
  delete pkg.dependencies[pkgName];
  changed = true;
}
const bundles = pkg.dsh?.profile?.bundles;
if (Array.isArray(bundles)) {
  const next = bundles.filter((name) => name !== pkgName);
  if (next.length !== bundles.length) {
    pkg.dsh.profile.bundles = next;
    changed = true;
  }
}
if (changed) {
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log('  removed the dependency and bundle entry from package.json');
} else {
  console.log('  package.json had nothing to remove');
}
NODE
fi

if [[ -f "$PROFILE_DIR/cordis.patch.yml" ]] && grep -q "id: deep-connect" "$PROFILE_DIR/cordis.patch.yml"; then
  cp "$PROFILE_DIR/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml.bak-dc-$STAMP"
  # The row is a YAML block: drop the comment block directly above it plus the
  # `- insert:` block that contains it, and nothing else.
  node - "$PROFILE_DIR/cordis.patch.yml" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [file] = process.argv.slice(2);
const lines = readFileSync(file, 'utf8').split('\n');
const out = [];
for (let i = 0; i < lines.length; i += 1) {
  if (lines[i].trim() === '- insert:') {
    // Find the end of this insert block (next top-level '- ' at column 0).
    let end = i + 1;
    while (end < lines.length && !/^- /.test(lines[end])) end += 1;
    const block = lines.slice(i, end).join('\n');
    if (block.includes('id: deep-connect')) {
      // Also drop an immediately preceding comment block that names Deep Connect.
      while (out.length > 0 && out[out.length - 1].startsWith('#')) out.pop();
      while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
      i = end - 1;
      continue;
    }
  }
  out.push(lines[i]);
}
writeFileSync(file, `${out.join('\n').replace(/\n+$/, '')}\n`);
console.log('  removed the deep-connect row from cordis.patch.yml');
NODE
else
  echo "  cordis.patch.yml had no deep-connect row"
fi

LINK="$PROFILE_DIR/node_modules/@local/dsh-deep-connect"
if [[ -L "$LINK" || -e "$LINK" ]]; then
  rm -rf "$LINK"
  echo "  removed the profile symlink"
fi

if (( PURGE )); then
  DATA_DIR="$DSH_HOME/deep-connect"
  if [[ -d "$DATA_DIR" ]]; then
    # Guard against an unset/odd DSH_HOME turning this into a broad rm.
    case "$DATA_DIR" in
      "$DSH_HOME"/deep-connect) rm -rf "$DATA_DIR"; echo "  purged $DATA_DIR" ;;
      *) echo "  refusing to purge unexpected path: $DATA_DIR" >&2; exit 1 ;;
    esac
  fi
  RELAY_DIR="$DSH_HOME/deep-connect-relay"
  if [[ -d "$RELAY_DIR" ]]; then
    case "$RELAY_DIR" in
      "$DSH_HOME"/deep-connect-relay) rm -rf "$RELAY_DIR"; echo "  purged $RELAY_DIR" ;;
      *) echo "  refusing to purge unexpected path: $RELAY_DIR" >&2; exit 1 ;;
    esac
  fi
  # The copy install.sh downloaded when it ran remotely (absent for a checkout install).
  PLUGIN_SRC="$DSH_HOME/plugins/dsh-deep-connect"
  if [[ -d "$PLUGIN_SRC" ]]; then
    case "$PLUGIN_SRC" in
      "$DSH_HOME"/plugins/dsh-deep-connect) rm -rf "$PLUGIN_SRC"; echo "  purged $PLUGIN_SRC" ;;
      *) echo "  refusing to purge unexpected path: $PLUGIN_SRC" >&2; exit 1 ;;
    esac
  fi
else
  echo "  kept $DSH_HOME/deep-connect (pass --purge to delete it too)"
fi

echo
echo "Uninstalled. Restart the Harness app for it to take effect."

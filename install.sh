#!/usr/bin/env bash
# Deep Connect — install the plugin into a DSH profile.
#
# Two ways to run it:
#
#   1) From a clone/extracted copy:
#        ./install.sh
#
#   2) Straight from GitHub, with no clone (what another machine runs):
#        curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | bash
#      In this mode the script first downloads the repository into
#      <DSH_HOME>/plugins/dsh-deep-connect, then installs from there.
#
# What it changes (each file is backed up first, and re-running is a no-op):
#   1. links the plugin into the profile's @local scope,
#   2. adds the dependency to the profile's package.json,
#   3. adds the bundle to dsh.profile.bundles,
#   4. appends the Loader row to cordis.patch.yml.
#
# Environment:
#   DSH_HOME     default ~/.dsh
#   PROFILE      default desktop
#   RELAY_URL    set the relay address while installing (written as a literal;
#                otherwise the Loader row reads $DSH_DEEP_CONNECT_RELAY)
#   DC_OWNER     default zengpu987-ctrl   (remote mode)
#   DC_REPO      default dsh-deep-connect (remote mode)
#   DC_REF       default main             (remote mode; branch or tag)
#   DC_SRC       install from this checkout instead of downloading (remote mode)
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${PROFILE:-desktop}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PKG_NAME="@local/dsh-deep-connect"
DC_OWNER="${DC_OWNER:-zengpu987-ctrl}"
DC_REPO="${DC_REPO:-dsh-deep-connect}"
DC_REF="${DC_REF:-main}"
INSTALL_ROOT="${INSTALL_ROOT:-$DSH_HOME/plugins}"
TARGET_DIR="$INSTALL_ROOT/dsh-deep-connect"

# Where this script lives, when it has a real path. Under `curl | bash` it does
# not, which is how remote mode is recognised.
SELF="${BASH_SOURCE[0]:-}"
HERE=""
if [[ -n "$SELF" && -f "$SELF" ]]; then
  HERE="$(cd "$(dirname "$SELF")" && pwd)"
fi

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Download the repository, trying the mirrors that actually work from mainland
# China first and the direct route last.
download_repo() {
  local dest="$1"
  # Order is measured, not guessed: codeload and the two mirrors answered from
  # mainland China; github.com/archive redirects and github.com git transport is
  # blocked, so both are last.
  local urls=(
    "https://codeload.github.com/$DC_OWNER/$DC_REPO/tar.gz/refs/heads/$DC_REF"
    "https://ghproxy.net/https://github.com/$DC_OWNER/$DC_REPO/archive/refs/heads/$DC_REF.tar.gz"
    "https://gh-proxy.com/https://github.com/$DC_OWNER/$DC_REPO/archive/refs/heads/$DC_REF.tar.gz"
    "https://github.com/$DC_OWNER/$DC_REPO/archive/refs/heads/$DC_REF.tar.gz"
  )
  local tmpdir
  tmpdir="$(mktemp -d)"
  local tarball="$tmpdir/repo.tar.gz"
  for url in "${urls[@]}"; do
    say "  downloading ${url}"
    if curl -fsSL --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 15 --max-time 180 \
        -o "$tarball" "$url" 2>/dev/null \
      && tar -tzf "$tarball" >/dev/null 2>&1; then
      tar -xzf "$tarball" -C "$tmpdir"
      local extracted
      extracted="$(find "$tmpdir" -mindepth 1 -maxdepth 1 -type d -name 'dsh-deep-connect-*' | head -1)"
      if [[ -n "$extracted" && -f "$extracted/plugin/index.js" ]]; then
        mkdir -p "$INSTALL_ROOT"
        rm -rf "$dest"
        mv "$extracted" "$dest"
        rm -rf "$tmpdir"
        return 0
      fi
      say "  archive did not contain plugin/index.js; trying the next route"
    else
      say "  route failed, trying the next one"
    fi
  done
  rm -rf "$tmpdir"
  return 1
}

# ---------------------------------------------------------------- locate source
if [[ -n "$HERE" && -f "$HERE/plugin/index.js" && -f "$HERE/plugin/client.js" ]]; then
  PLUGIN_DIR="$HERE/plugin"
  say "Installing from this checkout: $HERE"
elif [[ -n "${DC_SRC:-}" && -f "$DC_SRC/plugin/index.js" ]]; then
  PLUGIN_DIR="$DC_SRC/plugin"
  say "Installing from $DC_SRC"
else
  [[ "$EUID" -eq 0 ]] && die "do not run this as root; run it as the user who runs DSH"
  command -v curl >/dev/null 2>&1 || die "curl is required to download the plugin"
  command -v tar >/dev/null 2>&1 || die "tar is required to unpack the plugin"
  say "Downloading Deep Connect ($DC_OWNER/$DC_REPO@$DC_REF) into $TARGET_DIR"
  download_repo "$TARGET_DIR" || die "could not download the repository from GitHub or either mirror.
Check your network, then retry. As a fallback, download the repository archive in
a browser and run:  DC_SRC=/path/to/extracted ./install.sh"
  PLUGIN_DIR="$TARGET_DIR/plugin"
fi

[[ -f "$PLUGIN_DIR/index.js" && -f "$PLUGIN_DIR/client.js" ]] || die "plugin/ is incomplete (index.js and client.js are required)"
[[ -f "$PROFILE_DIR/package.json" ]] || {
  printf 'error: no DSH profile at %s\n' "$PROFILE_DIR" >&2
  printf 'Known profiles:\n' >&2
  ls -1 "$DSH_HOME/profiles" 2>/dev/null >&2 || printf '  (none)\n' >&2
  printf 'Set PROFILE=<name> to pick one, or DSH_HOME if DSH lives elsewhere.\n' >&2
  exit 1
}

STAMP="$(date +%s)"
backup() {
  local target="$1"
  if [[ -f "$target" && ! -f "$target.bak-dc-$STAMP" ]]; then
    cp "$target" "$target.bak-dc-$STAMP"
    say "  backed up $(basename "$target") -> $(basename "$target").bak-dc-$STAMP"
  fi
}

say "Installing $PKG_NAME into profile '$PROFILE'"

# ---------------------------------------------------------------- 1. link
mkdir -p "$PROFILE_DIR/node_modules/@local"
LINK="$PROFILE_DIR/node_modules/@local/dsh-deep-connect"
if [[ -L "$LINK" ]]; then
  CURRENT="$(readlink "$LINK" 2>/dev/null || true)"
  if [[ "$CURRENT" == "$PLUGIN_DIR" ]]; then
    say "  link already points at $PLUGIN_DIR"
  else
    say "  repointing link ($CURRENT -> $PLUGIN_DIR)"
    rm -rf "$LINK"
    ln -s "$PLUGIN_DIR" "$LINK"
  fi
elif [[ -e "$LINK" ]]; then
  say "  replacing a real directory at $LINK"
  rm -rf "$LINK"
  ln -s "$PLUGIN_DIR" "$LINK"
else
  ln -s "$PLUGIN_DIR" "$LINK"
  say "  linked $LINK -> $PLUGIN_DIR"
fi

# ---------------------------------------------------------------- 2 + 3. manifest
# The manifest edit needs a JSON-capable interpreter. A freshly set-up Mac may
# have neither Node nor the DSH CLI on PATH, but almost always has python3, so
# accept either instead of requiring the one this project happens to be written in.
JSON_EDITOR=""
for candidate in node python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then JSON_EDITOR="$candidate"; break; fi
done
[[ -n "$JSON_EDITOR" ]] || die "need node or python3 to update $PROFILE_DIR/package.json (install either, then re-run)"

backup "$PROFILE_DIR/package.json"
if [[ "$JSON_EDITOR" == "node" ]]; then
node - "$PROFILE_DIR/package.json" "$PLUGIN_DIR" "$PKG_NAME" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [file, pluginDir, pkgName] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(file, 'utf8'));
pkg.dependencies ??= {};
const wanted = `link:${pluginDir}`;
let changed = false;
if (pkg.dependencies[pkgName] !== wanted) {
  pkg.dependencies[pkgName] = wanted;
  changed = true;
}
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
if (!pkg.dsh.profile.bundles.includes(pkgName)) {
  pkg.dsh.profile.bundles.push(pkgName);
  changed = true;
}
if (changed) {
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log('  updated package.json (dependency + bundle)');
} else {
  console.log('  package.json already up to date');
}
NODE
else
"$JSON_EDITOR" - "$PROFILE_DIR/package.json" "$PLUGIN_DIR" "$PKG_NAME" <<'PYEOF'
import json, sys
path, plugin_dir, pkg_name = sys.argv[1:4]
with open(path, encoding="utf-8") as fh:
    pkg = json.load(fh)
deps = pkg.setdefault("dependencies", {})
wanted = "link:" + plugin_dir
changed = False
if deps.get(pkg_name) != wanted:
    deps[pkg_name] = wanted
    changed = True
profile = pkg.setdefault("dsh", {}).setdefault("profile", {})
bundles = profile.setdefault("bundles", [])
if pkg_name not in bundles:
    bundles.append(pkg_name)
    changed = True
if changed:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(pkg, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print("  updated package.json (dependency + bundle)")
else:
    print("  package.json already up to date")
PYEOF
fi

# ---------------------------------------------------------------- 4. Loader row
backup "$PROFILE_DIR/cordis.patch.yml"
if grep -q "id: deep-connect" "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null; then
  say "  cordis.patch.yml already has a deep-connect row"
else
  if [[ -n "${RELAY_URL:-}" ]]; then
    RELAY_LINE="        relayUrl: '${RELAY_URL}'"
  else
    RELAY_LINE="        relayUrl: !!js process.env.DSH_DEEP_CONNECT_RELAY ?? ''"
  fi
  {
    printf '\n# Deep Connect: one Host row owning the relay socket, the derived frame key,\n'
    printf '# the conversation index of this machine, and the peer-facing request/response.\n'
    printf -- '- insert:\n'
    printf '    - id: deep-connect\n'
    printf "      name: '@local/dsh-deep-connect'\n"
    printf '      config:\n'
    printf "        root: !!js dshHomePath('deep-connect')\n"
    printf '%s\n' "$RELAY_LINE"
    printf '        # Optional shared passphrase; empty derives from the signed-in account.\n'
    printf "        secret: !!js process.env.DSH_DEEP_CONNECT_SECRET ?? ''\n"
    printf '        indexIntervalMs: 15000\n'
  } >>"$PROFILE_DIR/cordis.patch.yml"
  say "  appended the deep-connect row to cordis.patch.yml"
fi

say ""
say "Installed $PKG_NAME"
say ""
say "Next:"
say "  1. Quit and reopen the Harness app."
say "  2. Open Deep Connect Pro: click 一键生成中继站 on ONE machine, then paste the"
say "     invite link into 加入别人的中继站 on every other machine."
say "  3. Both sides must show the SAME 6-digit key fingerprint."

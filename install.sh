#!/bin/sh
# Convoy installer.
#
#   curl -fsSL https://github.com/Inakitajes/convoy/releases/latest/download/install.sh | sh
#
# Downloads the release binary for the current platform, verifies it against the
# release's SHA256SUMS, and installs it into ~/.local/bin. Mirrors the guarantees
# `convoy update` makes in src/update.ts: nothing is installed unverified, and the
# candidate must report its own version before it replaces anything.
#
# Options (also accepted as flags via `| sh -s -- --version v0.1.0`):
#   CONVOY_VERSION       release tag to install, or "latest" (default: latest)
#   CONVOY_INSTALL_DIR   destination directory (default: $HOME/.local/bin)
#   CONVOY_NO_INIT       set to any value to skip `convoy init --global`

set -eu

REPO="Inakitajes/convoy"
BIN="convoy"

VERSION="${CONVOY_VERSION:-latest}"
INSTALL_DIR="${CONVOY_INSTALL_DIR:-$HOME/.local/bin}"
NO_INIT="${CONVOY_NO_INIT:-}"

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m')
  DIM=$(printf '\033[2m')
  RED=$(printf '\033[31m')
  GREEN=$(printf '\033[32m')
  YELLOW=$(printf '\033[33m')
  RESET=$(printf '\033[0m')
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" RESET=""
fi

info() { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
warn() { printf '%swarning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
err() {
  printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
convoy installer

usage: install.sh [--version <tag>] [--dir <path>] [--no-init]

  --version <tag>   install a specific release (default: latest)
  --dir <path>      install into <path> (default: \$HOME/.local/bin)
  --no-init         skip creating ~/.convoy/config.yaml
  --help            show this message
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || err "--version needs a release tag"
      VERSION="$2"
      shift 2
      ;;
    --dir)
      [ $# -ge 2 ] || err "--dir needs a path"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --no-init)
      NO_INIT=1
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *) err "unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------- platform ---

os=$(uname -s)
case "$os" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) err "unsupported operating system: $os (Convoy ships macOS and Linux binaries)" ;;
esac

machine=$(uname -m)
case "$machine" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) err "unsupported architecture: $machine" ;;
esac

# A shell running under Rosetta reports x86_64 on Apple Silicon; installing the
# translated binary would work but run slower than the native one.
if [ "$platform" = "darwin" ] && [ "$arch" = "x64" ] &&
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  arch="arm64"
fi

asset="${BIN}-${platform}-${arch}"

# ------------------------------------------------------------------- tools ---

if command -v curl >/dev/null 2>&1; then
  # Errors are reported by the caller with actionable context, so curl's own
  # diagnostics would only add noise ahead of them.
  download() { curl -fsSL --proto '=https' --tlsv1.2 "$1" -o "$2" 2>/dev/null; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -qO "$2" "$1"; }
else
  err "neither curl nor wget is available"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v openssl >/dev/null 2>&1; then
  sha256() { openssl dgst -sha256 "$1" | awk '{print $NF}'; }
else
  err "no SHA-256 tool found (need sha256sum, shasum or openssl)"
fi

# ----------------------------------------------------------------- release ---

case "$VERSION" in
  latest) base="https://github.com/${REPO}/releases/latest/download" ;;
  v*) base="https://github.com/${REPO}/releases/download/${VERSION}" ;;
  # Accept a bare SemVer; release tags carry the conventional leading "v".
  *) base="https://github.com/${REPO}/releases/download/v${VERSION}" ;;
esac

tmp=$(mktemp -d "${TMPDIR:-/tmp}/convoy-install.XXXXXX") || err "could not create a temporary directory"
staged=""
# Also clears the staging file below, so an interrupt between staging and the
# final rename cannot leave a stray dotfile in the install directory.
cleanup() {
  rm -rf "$tmp"
  [ -n "$staged" ] && rm -f "$staged"
  return 0
}
trap cleanup EXIT INT TERM HUP

step "Downloading ${BOLD}${asset}${RESET} (${VERSION})"
download "${base}/${asset}" "${tmp}/${asset}" ||
  err "could not download ${base}/${asset}
  Check the tag exists at https://github.com/${REPO}/releases"
download "${base}/SHA256SUMS" "${tmp}/SHA256SUMS" ||
  err "could not download the SHA256SUMS for this release"

expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "${tmp}/SHA256SUMS" | head -n 1)
[ -n "$expected" ] || err "SHA256SUMS does not list ${asset}"
actual=$(sha256 "${tmp}/${asset}")

if [ "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" != "$(printf '%s' "$actual" | tr 'A-F' 'a-f')" ]; then
  err "checksum verification failed for ${asset}
  expected ${expected}
  got      ${actual}
  The download was corrupted or tampered with; nothing was installed."
fi
step "Checksum verified"

# ----------------------------------------------------------------- install ---

mkdir -p "$INSTALL_DIR" || err "could not create ${INSTALL_DIR}"
[ -w "$INSTALL_DIR" ] || err "${INSTALL_DIR} is not writable
  Re-run with a different destination, for example:
  curl -fsSL ${base}/install.sh | CONVOY_INSTALL_DIR=\"\$HOME/bin\" sh"

target="${INSTALL_DIR}/${BIN}"
previous=""
if [ -x "$target" ]; then
  previous=$("$target" --version 2>/dev/null | head -n 1 || true)
fi

# Stage inside the destination directory so the final rename is atomic: readers
# either see the old binary or the new one, never a half-written file.
staged="${INSTALL_DIR}/.${BIN}.install-$$"
cp "${tmp}/${asset}" "$staged" || err "could not write to ${INSTALL_DIR}"
chmod 755 "$staged"

# Do not pipe: POSIX sh has no `pipefail`, so a pipeline would report `head`'s
# status and hide a binary that fails to execute at all.
if ! staged_output=$("$staged" --version 2>/dev/null); then
  rm -f "$staged"
  err "the downloaded binary did not run on this machine; nothing was installed"
fi

installed_version=$(printf '%s\n' "$staged_output" | head -n 1)
case "$installed_version" in
  "$BIN "*) ;;
  *)
    rm -f "$staged"
    err "the downloaded binary did not identify itself as ${BIN}; nothing was installed"
    ;;
esac

mv -f "$staged" "$target" || {
  rm -f "$staged"
  err "could not install into ${target}"
}

step "Installed ${GREEN}${installed_version}${RESET} to ${target}"
if [ -n "$previous" ] && [ "$previous" != "$installed_version" ]; then
  info "  ${DIM}replaced ${previous}${RESET}"
fi

# Creates ~/.convoy/config.yaml when absent, matching what `make install` does
# for source installs. Never overwrites existing config, and never writes agent
# prompts -- those are ejected one at a time with `convoy agents eject`.
if [ -z "$NO_INIT" ]; then
  if "$target" init --global --quiet 2>/dev/null; then
    step "Default configuration ready at ~/.convoy"
  else
    warn "could not write the default configuration; run \`${BIN} init --global\` yourself"
  fi
fi

# -------------------------------------------------------------------- PATH ---

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) on_path=1 ;;
  *) on_path="" ;;
esac

if [ -z "$on_path" ]; then
  case "$(basename "${SHELL:-sh}")" in
    zsh) profile="~/.zshrc" ;;
    bash) profile="~/.bashrc" ;;
    fish) profile="~/.config/fish/config.fish" ;;
    *) profile="your shell profile" ;;
  esac
  info ""
  warn "${INSTALL_DIR} is not on your PATH. Add it to ${profile}:"
  if [ "$profile" = "~/.config/fish/config.fish" ]; then
    info "  fish_add_path ${INSTALL_DIR}"
  else
    info "  export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi
fi

info ""
info "Next: authenticate a provider in OpenCode, then run ${BOLD}${BIN}${RESET} in a repo."
info "  ${DIM}opencode auth login${RESET}"
info "  ${DIM}${BIN} --help${RESET}"

#!/bin/sh
# Agent Connect per-user installer for macOS and Linux.
# Usage: curl -fsSL https://raw.githubusercontent.com/1naruto-1/agent-connect/main/scripts/install.sh | sh
set -eu

REPOSITORY="${AGENT_CONNECT_REPOSITORY:-1naruto-1/agent-connect}"
VERSION="${AGENT_CONNECT_VERSION:-latest}"
INSTALL_DIR="${AGENT_CONNECT_BIN_DIR:-$HOME/.local/bin}"

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
  else
    echo 'Agent Connect installer requires curl or wget.' >&2
    exit 1
  fi
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  else
    wget -qO "$2" "$1"
  fi
}

is_semver() {
  version="$1"
  printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' || return 1
  core="${version%%-*}"
  core="${core%%+*}"
  old_ifs="$IFS"; IFS='.'; set -- $core; IFS="$old_ifs"
  for identifier in "$@"; do
    case "$identifier" in 0|[1-9]|[1-9][0-9]*) ;; *) return 1 ;; esac
  done
  without_build="${version%%+*}"
  case "$without_build" in
    *-*)
      prerelease="${without_build#*-}"
      old_ifs="$IFS"; IFS='.'; set -- $prerelease; IFS="$old_ifs"
      for identifier in "$@"; do
        case "$identifier" in *[!0-9]*|'') ;; 0|[1-9]|[1-9][0-9]*) ;; *) return 1 ;; esac
      done
      ;;
  esac
}

if [ "$VERSION" = 'latest' ]; then
  VERSION="$(fetch "https://api.github.com/repos/$REPOSITORY/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
fi
VERSION="${VERSION#v}"
if ! is_semver "$VERSION"; then
  echo "Invalid or unavailable SemVer release: $VERSION" >&2
  exit 1
fi

case "$(uname -s)" in
  Linux) OS='linux' ;;
  Darwin) OS='darwin' ;;
  *) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH='x64' ;;
  aarch64|arm64) ARCH='arm64' ;;
  *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac

ASSET="agent-connect-v$VERSION-$OS-$ARCH"
BASE_URL="https://github.com/$REPOSITORY/releases/download/v$VERSION"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT INT TERM

mkdir -p "$INSTALL_DIR"
CHECKSUMS="$TMP_DIR/SHA256SUMS"
STAGE="$INSTALL_DIR/.agent-connect-$VERSION-$$"
download "$BASE_URL/SHA256SUMS" "$CHECKSUMS"
download "$BASE_URL/$ASSET" "$STAGE"

EXPECTED="$(grep -E "^[[:xdigit:]]{64}[[:space:]]+\*?$ASSET$" "$CHECKSUMS" | awk '{print $1}' | head -n 1)"
if [ -z "$EXPECTED" ]; then
  echo "SHA256SUMS does not contain $ASSET." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$STAGE" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$STAGE" | awk '{print $1}')"
else
  echo 'No SHA-256 tool found (need sha256sum or shasum).' >&2
  exit 1
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "Checksum mismatch for $ASSET." >&2
  exit 1
fi

chmod 755 "$STAGE"
mv -f "$STAGE" "$INSTALL_DIR/agent-connect"

PATH_NOTE=''
persist_path() {
  profile="$1"
  if ! grep -F "$INSTALL_DIR" "$profile" >/dev/null 2>&1; then
    {
      printf '\n# Added by Agent Connect installer\n'
      printf 'export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    } >> "$profile"
    PATH_NOTE="Added $INSTALL_DIR to PATH in $profile. Start a new shell after installation."
  fi
}

case "${SHELL:-}" in
  */zsh) persist_path "${ZDOTDIR:-$HOME}/.zshrc" ;;
  */bash)
    persist_path "$HOME/.bashrc"
    [ ! -f "$HOME/.bash_profile" ] || persist_path "$HOME/.bash_profile"
    ;;
  */fish) PATH_NOTE="Add $INSTALL_DIR to fish PATH manually: fish_add_path $INSTALL_DIR" ;;
  *) persist_path "$HOME/.profile" ;;
esac

printf 'Installed Agent Connect %s to %s/agent-connect\n' "$VERSION" "$INSTALL_DIR"
[ -z "$PATH_NOTE" ] || printf '%s\n' "$PATH_NOTE"
printf 'Run: agent-connect --version\n'

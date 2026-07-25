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
  RELEASE_TAG="$(fetch "https://api.github.com/repos/$REPOSITORY/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  case "$RELEASE_TAG" in
    v*) VERSION="${RELEASE_TAG#v}" ;;
    *) echo "Invalid or unavailable release tag: $RELEASE_TAG" >&2; exit 1 ;;
  esac
else
  VERSION="${VERSION#v}"
fi
if ! is_semver "$VERSION"; then
  echo "Invalid or unavailable SemVer release: $VERSION" >&2
  exit 1
fi

case "$(uname -s)" in
  Linux) OS='linux' ;;
  Darwin) OS='darwin' ;;
  *) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac
if [ "$OS" = 'linux' ] && { [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; }; then
  echo 'Unsupported Linux runtime: the current release requires glibc (Alpine/musl is not supported).' >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64|amd64) ARCH='x64' ;;
  aarch64|arm64) ARCH='arm64' ;;
  *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac

ASSET="agent-connect-v$VERSION-$OS-$ARCH"
BASE_URL="https://github.com/$REPOSITORY/releases/download/v$VERSION"
TMP_DIR="$(mktemp -d)"
STAGE=''
cleanup() {
  [ -z "$STAGE" ] || rm -f "$STAGE"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p "$INSTALL_DIR"
CHECKSUMS="$TMP_DIR/SHA256SUMS"
STAGE="$(mktemp "$INSTALL_DIR/.agent-connect-$VERSION.XXXXXXXX")"
download "$BASE_URL/SHA256SUMS" "$CHECKSUMS"
download "$BASE_URL/$ASSET" "$STAGE"

EXPECTED="$(awk -v asset="$ASSET" '
  NF == 2 {
    name = $2
    sub(/^\*/, "", name)
    if (name == asset && $1 ~ /^[[:xdigit:]]{64}$/) {
      print tolower($1)
      exit
    }
  }
' "$CHECKSUMS")"
if [ -z "$EXPECTED" ]; then
  echo "SHA256SUMS does not contain $ASSET." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum < "$STAGE" | awk '{print tolower($1)}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 < "$STAGE" | awk '{print tolower($1)}')"
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
  mkdir -p "$(dirname "$profile")"
  quoted_dir="$(printf '%s' "$INSTALL_DIR" | sed "s/'/'\\\\''/g")"
  path_line="export PATH='$quoted_dir':\$PATH"
  if ! grep -F -x "$path_line" "$profile" >/dev/null 2>&1; then
    {
      printf '\n# Added by Agent Connect installer\n'
      printf '%s\n' "$path_line"
    } >> "$profile"
    PATH_NOTE="Added $INSTALL_DIR to PATH in $profile. Start a new shell after installation."
  fi
}

case ":${PATH:-}:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    case "${SHELL:-}" in
      */zsh) persist_path "${ZDOTDIR:-$HOME}/.zshrc" ;;
      */bash)
        if [ "$OS" = 'darwin' ]; then persist_path "$HOME/.bash_profile"; else persist_path "$HOME/.bashrc"; fi
        ;;
      */fish)
        fish_quoted="$(printf '%s' "$INSTALL_DIR" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\$/\\$/g')"
        PATH_NOTE="Add $INSTALL_DIR to fish PATH manually: fish_add_path -- \"$fish_quoted\""
        ;;
      *) persist_path "$HOME/.profile" ;;
    esac
    ;;
esac

printf 'Installed Agent Connect %s to %s/agent-connect\n' "$VERSION" "$INSTALL_DIR"
[ -z "$PATH_NOTE" ] || printf '%s\n' "$PATH_NOTE"
printf 'Run: agent-connect --version\n'

# Distribution and releases

[Development environment](development-environment.md) · [Development workflow](development.md)

Agent Connect ships as Bun standalone executables through GitHub Releases. Users do not install an npm package, Node.js, or Bun.

## Install locations

| Platform | Binary | Agent Connect data and reports |
| --- | --- | --- |
| Windows | `%USERPROFILE%\.local\bin\agent-connect.exe` | `%APPDATA%\agent-connect` |
| macOS | `~/.local/bin/agent-connect` | `~/Library/Application Support/agent-connect` |
| Linux | `~/.local/bin/agent-connect` | `${XDG_DATA_HOME:-~/.local/share}/agent-connect` |

The installers never set Agent Connect-specific environment variables. They use the standard paths above unless an advanced user explicitly supplies `AGENT_CONNECT_DATA_DIR` or `AGENT_CONNECT_BIN_DIR`. Windows adds the binary directory to the user `PATH` only when absent; the Unix installer persists it at the front of the relevant shell startup file so the newly installed binary wins.

## Install commands

```powershell
# Windows
irm https://raw.githubusercontent.com/1naruto-1/agent-connect/main/scripts/install.ps1 | iex
```

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/1naruto-1/agent-connect/main/scripts/install.sh | sh
```

The Unix installer detects the operating system and CPU architecture. Windows currently installs the x64 binary, which is compatible with Windows-on-ARM emulation. Each installer verifies the downloaded asset against the release `SHA256SUMS` file, then atomically installs it in the per-user binary directory.

For a reproducible installation, download a tagged installer and set a specific SemVer version instead of using `latest`. `SHA256SUMS` detects corruption and mismatched downloads; it is not an independent trust signature because it is published with the release assets. Verify GitHub release provenance/attestations when available, and inspect the tagged installer before executing a pipe-to-shell command.

## Release artifacts

| Artifact | Bun compile target |
| --- | --- |
| `agent-connect-vX.Y.Z-windows-x64.exe` | `bun-windows-x64-baseline` |
| `agent-connect-vX.Y.Z-linux-x64` | `bun-linux-x64-baseline` |
| `agent-connect-vX.Y.Z-linux-arm64` | `bun-linux-arm64` |
| `agent-connect-vX.Y.Z-darwin-x64` | `bun-darwin-x64` |
| `agent-connect-vX.Y.Z-darwin-arm64` | `bun-darwin-arm64` |
| `SHA256SUMS` | SHA-256 hashes of every release binary |

The baseline x64 targets avoid requiring AVX2. Linux artifacts target glibc systems; Alpine/musl support is a future release target. macOS and Windows code signing/notarization are also future distribution enhancements, so users may see platform trust prompts before those credentials are configured.

## Semantic versioning

`package.json` is the sole version source. Versions use `major.minor.patch` Semantic Versioning and release tags must be `v<package-version>`.

```sh
# Example: prepare a minor pre-1.0 release
bun pm version minor
bun run check
bun run build -- --all
git push origin main --follow-tags
```

The release workflow validates that the pushed tag matches `package.json`, runs checks, builds every target, produces `SHA256SUMS`, and publishes the GitHub Release.

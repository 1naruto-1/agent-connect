# Distribution and releases

[Development environment](development-environment.md) · [Development workflow](development.md) · [Architecture](architecture.md)

Agent Connect ships as Bun standalone executables through GitHub Releases. Users do not install an npm package, Node.js, or Bun.

## Install locations

| Platform | Binary | Agent Connect data and reports |
| --- | --- | --- |
| Windows | `%USERPROFILE%\.local\bin\agent-connect.exe` | `%APPDATA%\agent-connect` |
| macOS | `~/.local/bin/agent-connect` | `~/Library/Application Support/agent-connect` |
| Linux | `~/.local/bin/agent-connect` | `${XDG_DATA_HOME:-~/.local/share}/agent-connect` |

The installer honors `AGENT_CONNECT_BIN_DIR` for the executable destination. Agent Connect honors `AGENT_CONNECT_DATA_DIR` at runtime for its own data and reports. Installers persist neither variable. Windows adds the binary directory to the user `PATH` only when absent. The Unix installer writes one safely quoted entry to the relevant POSIX shell startup file; fish users receive a `fish_add_path` command to run manually.

## How installers resolve a release

The default install commands use the installer script from `main`, but the script downloads a versioned binary from GitHub Releases:

1. Query `https://api.github.com/repos/1naruto-1/agent-connect/releases/latest`.
2. Validate and remove the `v` prefix from the returned SemVer tag.
3. Detect the host operating system and CPU architecture. Windows currently selects x64, including Windows-on-ARM emulation; Linux releases require glibc and reject Alpine/musl.
4. Download the matching binary and `SHA256SUMS` from `releases/download/v<version>/`.
5. Verify SHA-256, then atomically replace the per-user executable.

A Git tag by itself is not installable: the release workflow must finish and publish the corresponding assets first. GitHub's `latest` endpoint selects the latest published stable release, not a draft or prerelease.

```powershell
# Windows: latest stable release
irm https://raw.githubusercontent.com/1naruto-1/agent-connect/main/scripts/install.ps1 | iex
```

```sh
# macOS / Linux: latest stable release
curl -fsSL https://raw.githubusercontent.com/1naruto-1/agent-connect/main/scripts/install.sh | sh
```

For a reproducible installation, use both the tagged installer and the same explicit version. Explicit versions may select a published prerelease; the default `latest` lookup never does.

```powershell
$installer = [scriptblock]::Create(
  (irm https://raw.githubusercontent.com/1naruto-1/agent-connect/v0.2.0/scripts/install.ps1)
)
& $installer -Version 0.2.0
```

```sh
curl -fsSL https://raw.githubusercontent.com/1naruto-1/agent-connect/v0.2.0/scripts/install.sh |
  AGENT_CONNECT_VERSION=0.2.0 sh
```

`SHA256SUMS` detects corruption and mismatched downloads; it is not an independent trust signature because it is published with the release assets. Verify GitHub release provenance/attestations when available, and inspect the tagged installer before executing a pipe-to-shell command.

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

`package.json` is the sole version source. Versions follow SemVer 2.0.0, release tags must be `v<package-version>`, and `scripts/check-release.ts` rejects a mismatch.

## Continuous integration

`.github/workflows/ci.yml` is the source of truth for pull-request and `main` validation. It runs on Ubuntu, Windows, and macOS with Bun pinned to the repository version. Each matrix job performs:

- frozen-lockfile installation;
- whitespace, strict TypeScript, and Bun test checks;
- a native installer syntax/fixture test for that operating system;
- CLI help validation;
- a current-platform standalone build;
- execution of the built binary with `--version` and `--help`;
- verification of every entry in the generated `SHA256SUMS`.

`.github/workflows/release.yml` runs only for pushed `v*` tags. Its unprivileged Ubuntu build job requires an annotated or signed tag, exact agreement with `package.json.version`, ancestry from `main`, and a successful `CI` workflow run for the tagged SHA containing `Check (ubuntu-latest)`, `Check (windows-latest)`, and `Check (macos-latest)`. It then reruns repository/Unix-installer checks, builds all five targets, and verifies the complete checksum manifest. The exact five release binaries are downloaded from the workflow artifact and executed with `--version` and `--help` on matching x64/arm64 GitHub-hosted runners before publication.

A separate narrowly privileged job downloads the immutable workflow artifact, reverifies its exact inventory and checksums, confirms the remote annotated tag still targets the built commit, creates provenance attestations, uploads only the six expected release files to a newly normalized draft, compares the remote bytes with the workflow artifact, and then publishes the release. SemVer prereleases are marked as GitHub prereleases. A rerun may repair a draft; an already-published release is accepted only when its assets are byte-identical.

Local commands corresponding to the important CI stages are:

```sh
bun install --frozen-lockfile
bun run check
bun run build
bun run smoke:build
bun run verify:checksums
```

## Maintainer release checklist

Release only from a clean commit that is already on the protected `main` branch.

1. Choose the next SemVer version and update `package.json`. Do not reuse a version that has ever been published.
2. Update both root READMEs and relevant documentation for user-visible changes.
3. Run the complete local preflight:

   ```sh
   VERSION=X.Y.Z
   bun install --frozen-lockfile
   bun run check
   bun run src/cli.ts --help
   bun run build -- --all
   bun run smoke:build
   bun run verify:checksums -- --all
   bun run scripts/check-release.ts "v$VERSION"
   git diff --check
   git diff --cached --check
   ```

4. Commit the release preparation and merge it into `main` through a pull request, or push directly only when repository rules permit. Wait for all three CI jobs on that exact `origin/main` SHA to pass.
5. Fetch the green commit and create an annotated tag on it. Use a signed tag instead when signing is configured:

   ```sh
   VERSION=X.Y.Z
   git fetch origin main
   RELEASE_SHA="$(git rev-parse origin/main)"
   git tag -a "v$VERSION" "$RELEASE_SHA" -m "Agent Connect v$VERSION"
   git push origin "v$VERSION"
   ```

6. Watch the `Release` workflow. Confirm that the published release contains exactly five binaries, `SHA256SUMS`, and generated notes; separately confirm that GitHub provenance attestations are available.
7. Test both the latest installer and one pinned-version installer with a sandboxed home and binary directory. On Unix, sandbox `HOME` so the test cannot modify a real shell profile; on Windows, pass `-SkipPathUpdate`. Confirm the sandboxed binary reports the release version.
8. Announce the release only after those installation checks pass.

Pinned installer sandbox examples:

```sh
VERSION=X.Y.Z
TEST_HOME="$(mktemp -d)"
curl -fsSL "https://raw.githubusercontent.com/1naruto-1/agent-connect/v$VERSION/scripts/install.sh" |
  HOME="$TEST_HOME" AGENT_CONNECT_BIN_DIR="$TEST_HOME/bin" AGENT_CONNECT_VERSION="$VERSION" sh
"$TEST_HOME/bin/agent-connect" --version
```

```powershell
$Version = 'X.Y.Z'
$Sandbox = Join-Path $env:TEMP "agent-connect-$Version-test"
$env:AGENT_CONNECT_BIN_DIR = Join-Path $Sandbox 'bin'
$Installer = [scriptblock]::Create(
  (irm "https://raw.githubusercontent.com/1naruto-1/agent-connect/v$Version/scripts/install.ps1")
)
& $Installer -Version $Version -SkipPathUpdate
& (Join-Path $env:AGENT_CONNECT_BIN_DIR 'agent-connect.exe') --version
Remove-Item Env:AGENT_CONNECT_BIN_DIR
```

Repeat once with the `main` installer and its default `latest` selection before announcing the release.

Do not use `git push --follow-tags` as the first validation step: pushing `main` separately allows branch CI to finish before the release tag starts publication.

## Failed release policy

- For a transient GitHub or network failure with unchanged source and tag, rerun the failed workflow job. The workflow may repair its draft, but it never overwrites a published asset.
- If source, workflow, binary, or documentation changes are required after a public tag or release exists, fix the issue and publish the next patch version. Never force-move, overwrite, or reuse a published tag.
- Do not manually upload binaries built from a different commit under an existing tag.
- Keep `dist/` out of Git; GitHub Actions rebuilds release assets from the tagged commit.

## Recommended repository rules

Configure GitHub rulesets so that:

- `main` requires `Check (ubuntu-latest)`, `Check (windows-latest)`, and `Check (macos-latest)`, blocks force pushes, and is changed through reviewed pull requests when more than one maintainer is active;
- the `release` environment requires maintainer approval when the repository needs a manual publication gate;
- tags matching `v*` cannot be updated or deleted after creation;
- only release maintainers may create `v*` tags;
- GitHub Actions is allowed to create releases and provenance attestations using the workflow's explicitly declared permissions.

Workflow actions are pinned to reviewed commit SHAs. `.github/dependabot.yml` opens weekly GitHub Actions update pull requests so those pins can be reviewed and advanced deliberately.

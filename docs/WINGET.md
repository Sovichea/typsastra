# Windows Package Manager (winget)

Typsastra ships a [winget](https://learn.microsoft.com/windows/package-manager/winget/)
manifest. Once it is merged into the
[winget-pkgs](https://github.com/microsoft/winget-pkgs) community repository,
Windows users can install the x64 or ARM64 build with the standard client:

```powershell
winget install --id Typsastra.Typsastra
```

`winget` picks the installer matching the host architecture automatically. Use
`winget install --id Typsastra.Typsastra --architecture arm64` to force a
specific one.

## Repository layout

Manifests live under `winget/`, mirroring the directory layout that
winget-pkgs expects. Each version gets its own directory containing three YAML
files plus the package icon:

```
winget/manifests/t/Typsastra/Typsastra/<version>/
  Typsastra.Typsastra.yaml               # version manifest
  Typsastra.Typsastra.locale.en-US.yaml  # locale manifest
  Typsastra.Typsastra.installer.yaml     # installer manifest
  Typsastra.Typsastra.png                # package icon
  README.md                              # local notes, not submitted
```

The folder path is significant. `PackageIdentifier` is
`Typsastra.Typsastra`, and winget-pkgs requires the manifest path to match it
case-sensitively. Filenames carry the full identifier as a prefix for the same
reason.

## Publishing a new version

Every release needs its own pull request to winget-pkgs. The repository stores
one manifest directory per version and the client resolves to the highest
semantic version, so there is no single manifest to keep updated. Manifest
submissions must contain exactly one package version and manifest files only,
which the repository enforces.

Do not copy manifest values between versions. `InstallerSha256` changes with
every build, `ProductCode` changes with every build, and `ReleaseDate` follows
the release. Generate the directory instead:

```powershell
# After publishing the release
bun run generate:winget-manifest 0.10.0
```

The script downloads both MSIs from the published release, hashes them, reads
each `Property` table for `ProductCode` and `UpgradeCode`, reads the publication
date, and rewrites the version directory. It then runs `winget validate`. It
requires Windows because MSI property inspection uses the Windows Installer COM
API, and `gh` on the `PATH` for downloading release assets.

Useful flags:

- `--dry-run` reports whether each file would change and writes nothing.
- `--release-date YYYY-MM-DD` overrides the date read from the release.

The script refuses to write when the two architectures or the preceding
checked-in version disagree on `UpgradeCode`, since that breaks upgrades, and
it warns when the generated `ShortDescription` drifts from the previous manifest. Edit
`LOCALE_METADATA` in the script when prose metadata changes intentionally.

Then submit to winget-pkgs:

1. Copy the three YAML files from
   `winget/manifests/t/Typsastra/Typsastra/<version>/` into a winget-pkgs
   checkout at `manifests/t/Typsastra/Typsastra/<version>/`. Do not copy the
   local icon or `README.md`; winget-pkgs populates icon metadata during
   validation and accepts manifest files only. Filenames already have the full
   package identifier prefix.
2. Open a pull request from a branch. No separate issue is required for a
   routine version bump.
3. Microsoft validation runs on the PR. Response labels and failures are
   documented in the
   [Validation Failure Guide](https://github.com/microsoft/winget-pkgs/blob/master/doc/ValidationFailureGuide.md).
   Unsigned packages typically wait on the installer scan while SmartScreen
   reputation accrues, which can take days on a first submission.

### Recomputing installer identity

`UpgradeCode` must appear under `AppsAndFeaturesEntries`, not at the installer
top level. The schema has no top-level `UpgradeCode`, so a misplaced value is
reported as an unknown field and `winget validate` fails.

`UpgradeCode` is stable for a given product identity, and Typsastra shares one
across architectures so upgrading switches architecture correctly. The values
published for v0.9.1, read from the MSI `Property` table:

| Architecture | ProductCode |
| --- | --- |
| x64 | `{9EE6BED8-BE0F-490E-8E49-80994ED972B9}` |
| arm64 | `{F0726CCE-9ACF-475E-93FA-0E11D8E49E31}` |
| both | `{552C8F47-DD8F-586E-B36F-B23E2CEC2A14}` (`UpgradeCode`) |

### Package icons

Icon metadata is populated during Microsoft's validation, not authored in
manifest PRs. The generated PNG is kept locally for project use only.

## Validating before submitting

`winget validate` is the fastest way to catch schema mistakes:

```powershell
$check = Join-Path $env:TEMP "winget-check"
Remove-Item -Recurse -Force $check -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $check | Out-Null
Copy-Item "winget/manifests/t/Typsastra/Typsastra/<version>/*.yaml" $check
winget validate --manifest $check
```

Point it at a directory of YAML copies rather than the manifest directory
itself, because `validate` parses every file it finds and the icon is binary.

Two requirements that are easy to miss:

- Every YAML file needs a `# yaml-language-server: $schema=` header matching its
  manifest type. Without it validation warns.
- `Platform` is a list of `Windows.Desktop` or `Windows.Universal`, not the
  string `Windows.Latest`.

The manifest tests run `winget validate` when the CLI is present, so CI-style
local runs catch these too.

## Silent installation

Both installers are MSI packages built by WiX, so `msiexec` handles them and
the switches are the standard ones:

| Mode | Switch |
| --- | --- |
| silent | `/quiet` |
| silent with progress | `/passive` |

The manifest requests `elevationRequired`. The MSI sets `ALLUSERS=1`, which
makes it a per-machine install writing to Program Files, so administrator rights
are unavoidable. winget validates installers first as a standard user and
fails without this declaration.

## Code signing

Windows installers are not code signed, so SmartScreen shows a warning on
first launch regardless of the install path. winget does not remove that
warning, and only MSIX packages are required by Microsoft to be signed. A
signed release would need an OV or EV certificate from a public CA; see
`docs/INSTALL.md` for the current macOS signing position.

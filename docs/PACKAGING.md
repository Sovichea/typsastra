# Packaging and distribution

Typsastra publishes prebuilt Windows and Linux packages from GitHub Releases.
This page covers the repository-side metadata for the package managers that can
reuse those artifacts:

| Channel | Platform | Artifact | Publish target |
| --- | --- | --- | --- |
| Chocolatey | Windows | x64 and ARM64 MSI | [chocolatey.org](https://community.chocolatey.org/) |
| Scoop | Windows | x64 and ARM64 MSI, extracted into the Scoop app directory | A Scoop bucket or [ScoopInstaller/Extras](https://github.com/ScoopInstaller/Extras) |
| AUR | Arch Linux | x86_64 and aarch64 `.deb`, repacked as `typsastra-bin` | [AUR](https://aur.archlinux.org/) |

macOS is not listed because the current DMG is unsigned and unnotarized.
Homebrew Cask requires a Gatekeeper-compliant app; see
[INSTALL.md](./INSTALL.md#open-an-unsigned-macos-release).

## Generated metadata

The files under `packaging/` are generated from a published GitHub release:

```bash
bun run generate:packaging 0.10.0
```

The generator reads the release assets from GitHub, takes each asset's SHA-256
digest, and rewrites the Chocolatey, Scoop, and AUR files. It requires the
[GitHub CLI](https://cli.github.com/) on the `PATH` and an authenticated
session (`gh auth login`). Publish the release before generating metadata; the
script refuses to guess hashes for missing assets.

Use `--dry-run` to see which files would change without writing them:

```bash
bun run generate:packaging 0.10.0 --dry-run
```

Do not edit the generated files by hand. Change the generator, then regenerate.
Packaging metadata is generated from a published release, so it may still
describe the previous version until the new release is published. The packaging
tests validate that the checked-in files agree with each other.

### Layout

```text
packaging/
├── chocolatey/
│   ├── typsastra.nuspec
│   └── tools/
│       ├── chocolateyinstall.ps1
│       ├── chocolateyuninstall.ps1
│       └── VERIFICATION.txt
├── scoop/
│   └── typsastra.json
└── aur/
    ├── PKGBUILD
    └── .SRCINFO
```

## Chocolatey

The Chocolatey package downloads the official per-machine MSI. It selects the
ARM64 MSI on ARM64 Windows and the x64 MSI everywhere else. The MSI is not code
signed, so SmartScreen may warn on first launch even after a successful
Chocolatey install.

Build the package:

```powershell
choco pack packaging/chocolatey/typsastra.nuspec --output-directory dist/chocolatey
```

Test it locally from an elevated shell:

```powershell
choco install typsastra --source dist/chocolatey --version 0.10.0 -y
choco uninstall typsastra -y
```

Publish to the Chocolatey community repository:

```powershell
$env:CHOCOLATEY_API_KEY = "<your API key>"
choco push dist/chocolatey/typsastra.0.10.0.nupkg `
  --source https://push.chocolatey.org/ `
  --api-key $env:CHOCOLATEY_API_KEY
```

The first submission goes through moderation. Include the generated
`VERIFICATION.txt`; it records both installer URLs and their SHA-256 hashes.

## Scoop

The Scoop manifest uses the MSI's administrative install to extract the
application into the Scoop app directory. It does not install the MSI
system-wide, so `scoop uninstall` removes the files normally. The manifest notes
that the Microsoft Edge WebView2 Runtime is required; it is included with
Windows 11 and most Windows 10 installations.

Test the manifest locally:

```powershell
scoop install .\packaging\scoop\typsastra.json
typsastra
scoop uninstall typsastra
```

To publish, either add `typsastra.json` to a personal bucket repository or open
a pull request against `ScoopInstaller/Extras`. A personal bucket is the
low-effort option:

```text
scoop bucket add typsastra https://github.com/<owner>/scoop-typsastra
scoop install typsastra
```

The manifest includes `checkver` and `autoupdate` entries. Future releases can
be picked up by the bucket's update workflow; the hash is read from the GitHub
release asset's `digest` field. Run `scoop checkver` in the bucket repository to
verify the update path before relying on it.

## AUR

The AUR package is `typsastra-bin`. It repacks the published `.deb` for x86_64
and aarch64, so users do not need to build the Rust application. The package
depends on `gtk3`, `webkit2gtk-4.1`, and `xdg-utils`, provides `typsastra`, and
conflicts with a source-built `typsastra` package.

Test on Arch Linux:

```bash
cd packaging/aur
makepkg --printsrcinfo > .SRCINFO
makepkg -si
typsastra
```

Publish to the AUR:

```bash
git clone ssh://aur@aur.archlinux.org/typsastra-bin.git
cp packaging/aur/PKGBUILD packaging/aur/.SRCINFO typsastra-bin/
cd typsastra-bin
git add PKGBUILD .SRCINFO
git commit -m "Update to 0.10.0"
git push
```

The AUR repository contains only `PKGBUILD` and `.SRCINFO`. Do not commit the
downloaded `.deb` files or a `src/` directory.

## Release checklist

1. Publish the GitHub release with the MSI, `.deb`, and AppImage assets.
2. Bump `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`
   to the release version.
3. Run `bun run generate:packaging <version>`.
4. Run `bun test tests/packagingManifests.test.ts`.
5. Build and test the Chocolatey package with `choco pack`.
6. Test the Scoop manifest in a disposable Windows environment.
7. Test the AUR package with `makepkg -si` on Arch Linux.
8. Publish Chocolatey, Scoop, and AUR metadata.

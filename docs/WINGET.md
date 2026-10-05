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
  Typsastra.yaml               # version manifest
  Typsastra.locale.en-US.yaml  # locale manifest
  Typsastra.installer.yaml     # installer manifest
  Typsastra.png                # package icon
```

The folder path is significant. `PackageIdentifier` is
`Typsastra.Typsastra`, and winget-pkgs requires the manifest path to match it
case-sensitively.

## Publishing a new version

The manifest is submitted to winget-pkgs, so a new version means a new
directory, a new pull request there, and an update to the icon path. The steps:

1. Publish the release so the MSI assets are downloadable.
2. Copy the previous version directory and rename it to the new version.
3. Update `PackageVersion` in all three YAML files.
4. Update the release URLs and asset filenames to the new version.
5. Recompute `InstallerSha256` for each architecture:

   ```powershell
   gh release download v<version> --pattern "Typsastra_<version>_*_en-US.msi"
   winget hash "Typsastra_<version>_x64_en-US.msi"
   winget hash "Typsastra_<version>_arm64_en-US.msi"
   ```

6. Update `ReleaseDate` to the release date in `YYYY-MM-DD` form.
7. Set `LicenseUrl` and the documentation URLs to the matching tag, not `main`,
   so they resolve to the code that shipped.
8. Copy the manifest directory into a winget-pkgs checkout and run
   `wingetcreate` or open a pull request manually.

### Recomputing installer identity

`ProductCode` changes with every build and must be read from the published MSI
rather than copied from an older manifest. `UpgradeCode` stays stable for a
given product identity, and Typsastra uses one `UpgradeCode` shared by both
architectures, so upgrading switches architecture correctly.

The values currently published were read from the MSI `Property` table:

| Architecture | ProductCode |
| --- | --- |
| x64 | `{9EE6BED8-BE0F-490E-8E49-80994ED972B9}` |
| arm64 | `{F0726CCE-9ACF-475E-93FA-0E11D8E49E31}` |
| both | `{552C8F47-DD8F-586E-B36F-B23E2CEC2A14}` (`UpgradeCode`) |

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
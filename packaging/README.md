# Packaging metadata

This directory contains generated package-manager metadata for Typsastra:

- `chocolatey/` — Chocolatey package for the Windows MSI
- `scoop/` — Scoop manifest for the Windows MSI
- `aur/` — `typsastra-bin` PKGBUILD for Arch Linux

Regenerate everything after publishing a release:

```bash
bun run generate:packaging 0.10.0
```

Do not edit the generated files by hand. See
[`docs/PACKAGING.md`](../docs/PACKAGING.md) for build, test, and publishing
instructions.

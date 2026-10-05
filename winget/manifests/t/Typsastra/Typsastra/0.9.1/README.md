# Typsastra v0.9.1 winget manifest
#
# Copy this directory to winget-pkgs under manifests/t/Typsastra/Typsastra/0.9.1
# and open a pull request there. Paths and filenames must match exactly.
#
# The SHA-256 values below were computed from the published release assets:
#   https://github.com/Sovichea/typsastra/releases/tag/v0.9.1
#
# InstallerSha256 must be recomputed for every release. Refresh it with:
#   gh release download v<version> --pattern "Typsastra_<version>_*_en-US.msi"
#   winget hash Typsastra_<version>_<arch>_en-US.msi
#
# ProductCode and UpgradeCode were read from the MSI Property table. UpgradeCode
# is identical across x64 and arm64, so upgrades move between architectures.
# UpgradeCode belongs under AppsAndFeaturesEntries; a top-level UpgradeCode is an
# unknown field and winget validate rejects it.
#
# Verify before submitting (the icon is skipped because validate only reads YAML):
#   Copy-Item winget/manifests/t/Typsastra/Typsastra/0.9.1/*.yaml $env:TEMP/winget-check
#   winget validate --manifest $env:TEMP/winget-check
# Install Typsastra

## Download a release

Pre-built desktop packages are available from the GitHub releases page:

[Download the latest release](https://github.com/Sovichea/typsastra/releases/latest)

Available packages:

- Windows: `.msi`
- Linux: `.AppImage` and `.deb`
- macOS: experimental, unsigned and unnotarized build

Typsastra is currently beta software. The latest release is v0.5.2.

### Open an unsigned macOS release

Typsastra is an open-source project and does not plan to purchase Apple
Developer ID signing or notarization. When the experimental macOS release is
downloaded through a browser, Gatekeeper may therefore report that
`Typsastra.app` is damaged and cannot be opened even when the bundle is intact.

Only continue if the app came from the official
[Typsastra GitHub releases page](https://github.com/Sovichea/typsastra/releases).
Delete and download it again if its origin or integrity is uncertain.

1. Move `Typsastra.app` to `/Applications`.
2. Open Terminal and remove the quarantine attribute from this app only:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Typsastra.app"
   ```

3. Launch Typsastra:

   ```bash
   open "/Applications/Typsastra.app"
   ```

If the app is stored elsewhere, type
`xattr -dr com.apple.quarantine ` with a trailing space, drag the app from
Finder into Terminal to insert its exact path, and press Return.

This workaround does not disable Gatekeeper system-wide. Do not use commands
that globally disable Gatekeeper. If Typsastra still cannot be opened after a
fresh download and this targeted removal, report the release filename, Mac
model, processor architecture, and macOS version.

### Automatic updates on macOS

Typsastra's in-app update artifacts are cryptographically signed and verified
by Tauri before installation. Updater signing is mandatory and remains enabled;
it is independent of Apple Developer ID signing and notarization.

An in-app update normally should not require the quarantine workaround again
because it is not downloaded through a browser. This behavior remains
experimental until it has been validated through real unsigned updates on
macOS. A release downloaded manually through a browser may require the targeted
workaround again.

## Build from source

Typsastra supports native development on Windows, Linux, and macOS. Node.js and the standalone `typst` CLI are not required. Bun runs the frontend toolchain, while Typsastra downloads and manages Tinymist on first launch.

### Windows

Effective minimum: Windows 10 version 1809 or later, as required by Bun.

1. Install [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/). Select **Desktop development with C++** and a Windows 10 or 11 SDK.
2. Ensure the [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) is installed. It is normally already present on supported Windows versions.
3. Install Rust with the MSVC toolchain:

   ```powershell
   winget install --id Rustlang.Rustup
   rustup default stable-msvc
   ```

4. Install Bun:

   ```powershell
   powershell -c "irm bun.sh/install.ps1|iex"
   ```

5. Restart the terminal so the new `PATH` entries are visible.

If MSI packaging fails with `light.exe` or VBSCRIPT errors, enable **VBSCRIPT** under Windows Optional Features. This is needed only for MSI generation.

### macOS

Effective minimum: macOS 13 or later, as required by current Bun releases. Both Apple Silicon and Intel hosts are supported.

1. Install the Xcode Command Line Tools:

   ```bash
   xcode-select --install
   ```

2. Install Rust and Bun:

   ```bash
   curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
   curl -fsSL https://bun.com/install | bash
   ```

3. Restart the terminal or load the shell profile updated by the installers.

### Linux

Install the WebKitGTK 4.1 and native build dependencies for your distribution.

Debian/Ubuntu:

```bash
sudo apt update
sudo apt install pkg-config libglib2.0-dev libwebkit2gtk-4.1-dev \
  build-essential curl wget file libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev unzip
```

Fedora:

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel libxdo-devel unzip
sudo dnf group install "c-development"
```

Arch Linux:

```bash
sudo pacman -Syu
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg xdotool unzip
```

Then install Rust and Bun:

```bash
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
curl -fsSL https://bun.com/install | bash
```

For other distributions, use the equivalent packages from the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

### Project setup

```bash
git clone --recurse-submodules https://github.com/Sovichea/typsastra.git
cd typsastra
bun install --frozen-lockfile
```

For an existing clone, initialize or update the pinned segmenter with:

```bash
git submodule update --init --recursive
```

Start the complete desktop development environment:

```bash
bun run tauri dev
```

`bun run dev` starts only Vite in a browser. It is useful for isolated styling work, but native filesystem access, dialogs, settings persistence, Tinymist, and Tauri IPC will not work there.

### Native release build

Build on each target operating system; a normal local Tauri build does not produce installers for the other operating systems.

```bash
bun run tauri build
```

The native executable is written under `src-tauri/target/release/`. Installers and application bundles are written under `src-tauri/target/release/bundle/`, with platform-specific subdirectories such as `nsis`/`msi`, `deb`/`rpm`/`appimage`, or `dmg`/`macos`.

Platform signing is not required for local development. Typsastra's release
pipeline always signs automatic-update artifacts with the separate Tauri
updater key. Public macOS builds intentionally remain without Apple Developer
ID signing or notarization and consequently do not receive native Gatekeeper
trust.

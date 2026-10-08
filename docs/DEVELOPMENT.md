# Development

## Tech stack

- Core framework: [Tauri v2](https://v2.tauri.app/)
- Backend: Rust in `src-tauri/`
- Frontend: Bun + Vite + TypeScript in `src/`
- Editor: CodeMirror 6
- Typst preview and diagnostics: Tinymist

## Local development

```bash
git clone --recurse-submodules https://github.com/Sovichea/typsastra.git
cd typsastra
bun install --frozen-lockfile
bun run tauri:dev
```

The first launch requires internet access to retrieve the selected stable Tinymist binary from GitHub. Later launches use the managed copy in the platform application-data directory.

### Tauri CLI fallback

`bun run tauri:dev` and `bun run tauri:build` normally use the bundled
`@tauri-apps/cli`. If that native CLI executable is missing, has an incompatible
format, or crashes, the launcher reads the locked CLI version, installs the
matching Rust `tauri-cli` through Cargo when necessary, and retries the same
command with `cargo tauri`. It does not retry ordinary frontend/Rust build
failures or a development session stopped with Ctrl+C. Rust and Cargo must be
available on `PATH` for the fallback.

## Dependency lockfiles

`bun.lock` is committed and is the reproducible dependency source for local development and CI. After changing `package.json`, run `bun install` and commit both files. Routine setup and CI should keep using:

```bash
bun install --frozen-lockfile
```

## Validation

Run the frontend and Rust checks before submitting changes:

```bash
bun test
bun run build
cargo fmt --manifest-path src-tauri/Cargo.toml --package typsastra -- --check
cargo check --manifest-path src-tauri/Cargo.toml --lib
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Changes to Khmer editing policies, Unicode utilities, spellcheck, completion, native segmentation, dictionaries, or the pinned segmenter must also keep the focused reference suite passing:

```bash
bun run test:khmer
cargo test --manifest-path src-tauri/Cargo.toml --lib khmer_reference_provider_fixtures_are_locked
```

## Architecture notes

- Tauri handles native windows, filesystem access, dialogs, settings persistence, and the LSP lifecycle.
- CodeMirror owns editor state, syntax behavior, autocomplete, selection, and decorations.
- Tinymist provides Typst diagnostics, preview, export, and source synchronization.
- Language analysis is handled by the Rust provider registry. Bundled providers include custom Khmer support and English Hunspell support.
- Public positioning, feature names, and Basic/Enhanced/Deep language-support criteria are defined in [PRODUCT_DIRECTION.md](./PRODUCT_DIRECTION.md).
- Script-aware cursor movement and deletion use the frontend policy registry documented in [SCRIPT_EDITING_POLICIES.md](./SCRIPT_EDITING_POLICIES.md).
- Khmer is the locked reference implementation documented in [KHMER_SPELLCHECK.md](./KHMER_SPELLCHECK.md); its fixtures record the pinned upstream commit and exact editing, normalization, segmentation, and completion behavior.
- Settings are stored in a versioned `settings.json` in the platform application-config directory.

### Developer log API

Debug builds expose the structured developer log over a loopback-only HTTP API at
`http://127.0.0.1:17342`. Set `TYPSASTRA_DEV_LOG_API_ADDR` before launching the
debug app to use another loopback bind address. The API is not started in release builds.

- `GET /health` returns `{ "ok": true }`.
- `GET /logs?after=<sequence>` returns buffered entries after the optional sequence number.
- `GET /settings` returns `developerMode` and the `developerLogs` category flags.
- `PATCH /settings` updates either setting, for example:
  `{"developerMode":true,"developerLogs":{"preview":false}}`.
- `POST /project/open` with `{"path":"<project-folder>"}` opens a project in the app.
- `GET /project/files` returns the current project's files as root-relative paths and marks the main document.
- `PUT /project/main` with `{"path":"chapter.typ"}` sets a project-relative or absolute `.typ` file as main.
- `POST /project/open-document` with `{"path":"main.typ","approveLargePreview":true}` opens a Typst document in the editor and can explicitly accept its large-preview confirmation.

Project open/main requests return `202 Accepted` after being handed to the app; the
frontend performs the normal workspace operation and reflects its result. Project
file listings omit `.git`, `node_modules`, `target`, and `.typsastra` folders and
are capped at 50,000 files.

The log buffer retains up to 10,000 entries. Settings changes are persisted to
the application's normal `settings.json` and applied in the running app.

## Preview behavior

Each preview root has a uniquely identified Tinymist task whose iframe is cached across tab switches. Imported files normally preview through the top-level `main.typ` and update on save.

Imported chapters currently use the configured main document's preview. The former `// @standalone-preview` directive remains disabled because independent preview roots made source synchronization unreliable. A portable Full Document/Active File replacement is deferred to a dedicated future milestone; it is not part of v0.8.0.

PDF preview and source-map synchronization are documented in [PREVIEW_INTERCEPTION.md](./PREVIEW_INTERCEPTION.md).

## Release builds

```bash
bun run tauri:build
```

Build on each target operating system. Cross-platform installer output is not produced by a normal local Tauri build.

To bypass the bundled CLI explicitly, install the version resolved in
`bun.lock` and run Cargo directly. For the current lockfile:

```bash
cargo install tauri-cli --version 2.11.3 --locked
cargo tauri build
```

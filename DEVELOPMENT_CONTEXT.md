# Typstry Development Context & Design Constraints

This file serves as a consolidated reference for the architectural decisions, parser configurations, and custom editor behaviors implemented in Typstry. It is intended to prevent regression and ensure rapid context alignment across development sessions.

---

## 1. Core Architecture
- **Tech Stack**: Tauri v2 (Rust backend for system/file operations and Tinymist LSP lifecycle) + Bun/Vite (Frontend) + CodeMirror 6 (Editor).
- **Run Commands**: `bun install`, `bun run tauri dev`, `bun run tauri build`; frontend build is `tsc && vite build`.
- **TypeScript Mode**: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`; unused imports/params fail build.
- **Core Files**:
  - `index.html`: Single-page DOM scaffold. `src/main.ts` binds hardcoded element IDs directly, so DOM ID changes must be paired with controller updates.
  - `src/main.ts`: Main app orchestrator (`TypstryWorkspaceController`), workspace/tabs, commands, preview sync, WYSIWYM mode, diagnostics, localStorage state.
  - `src/components/explorer.ts`: Recursive workspace file tree, inline create/rename input, direct `read_workspace_dir` IPC use.
  - `src/compiler/lsp.ts`: Tinymist JSON-RPC client over Tauri IPC events/commands, not a browser WebSocket.
  - `src/editor/typstLanguage.ts`: StreamLanguage-based parser for Typst.
  - `src/editor/extensions.ts`: Custom CodeMirror extensions (autoclose overrides, LSP bridges, themes).
  - `src/editor/themes.ts`: Global HighlightStyle and editor layouts.
  - `src/editor/bracketColorizer.ts`: Rainbow bracket decorator.
  - `src/editor/autocomplete.ts`: LSP completions with snippet fallback; flushes pending LSP text sync before completion requests.
  - `src/editor/hover.ts`: LSP hover renderer with small local markdown parser and external-link shell open.
  - `src/editor/diagnostics.ts`: CodeMirror diagnostic underline decorations via `StateEffect`/`StateField`.
  - `src-tauri/src/lib.rs`: IPC commands, filesystem operations, toolchain download, Typst check/compile, Tinymist child-process bridge.
  - `src-tauri/capabilities/default.json`: Grants broad FS/plugin permissions; frontend assumes these commands are available.

### A. Frontend Controller Flow (`src/main.ts`)
- `bootstrap()` order matters: recent projects, CodeMirror, explorer, toolbar, events/resizers/theme/wrap/context menu/logs, show window, `ensureDependencies()`, then `initLsp()`.
- App visibility: welcome/editor/preview/explorer are toggled by `updateWorkspaceViewportVisibility()` based on `workspaceRootPath` and `activeFilePath`.
- Open tabs are in-memory `EditorTab` objects with `content`, `savedContent`, dirty flag, preview root, versions, selection, and scroll positions.
- Workspace persistence is localStorage-only under `typstry-workspace-${workspaceRootPath}`. It stores tab paths/selection/scroll/split widths, then reloads content from disk; unsaved tab contents are not persisted across app restart.
- Recent projects are localStorage-only under `typstry-recent-projects`, max 5 entries.
- Word wrap and theme are localStorage settings (`typstry-word-wrap`, `typstry-theme`) wired through CodeMirror compartments and CSS variables.
- Unicode editor font detection scans active text for non-ASCII script ranges; Khmer bundled fonts load via `FontFace`, other script candidates depend on installed fonts and may require restart.

### B. Tauri IPC Contract (`src-tauri/src/lib.rs`)
- File commands: `read_workspace_file`, `save_workspace_file`, `create_workspace_dir`, `rename_workspace_file`, `copy_workspace_file`, `read_workspace_dir`, `move_to_trash`, `reveal_in_explorer`.
- Preview/document commands: `resolve_preview_main`, `check_typst_document`, `compile_typst_document`.
- Toolchain/LSP commands: `ensure_toolchain`, `start_tinymist_lsp`, `send_lsp_message`.
- `ensure_toolchain()` downloads Windows `tinymist.exe` v0.15.2 and `typst.exe` v0.15.0 into Tauri app local data via PowerShell. This path is Windows-centric.
- `start_tinymist_lsp()` kills any prior child, increments a generation guard, spawns local `tinymist.exe lsp`, and forwards stdio JSON-RPC as `lsp-rx`/`lsp-status` events.
- `send_lsp_message()` pushes JSON strings into an MPSC channel; frontend must send fully serialized JSON-RPC payloads.
- `check_typst_document()` writes a hidden sibling `.stem.typstry-check.typ`, compiles SVG with short diagnostics, parses stderr, then deletes temp files.
- `compile_typst_document()` currently writes `.stem.preview.typ`, compiles SVG page files, returns combined SVG markup, and deletes temp SVGs. Despite the UI label "Export PDF", this command does not currently produce a PDF path.

### C. LSP/Preview Flow (`src/compiler/lsp.ts`)
- Frontend does not connect directly to `ws://127.0.0.1:8589`; Rust owns Tinymist stdio and frontend listens to `lsp-rx`.
- `connect()` starts Tinymist, subscribes to `lsp-status` and `lsp-rx`, sends `initialize`, then `initialized`.
- Initialization disables Tinymist auto export (`exportPdf/exportSvg/exportPng: "never"`) and enables preview background host `127.0.0.1:8589`.
- `startPreview(path)` must pass raw OS paths, not file URIs. It sends `tinymist.pinMain`, `tinymist.focusMain`, then `tinymist.doStartPreview` with `arguments: [[path]]`.
- Preview result normalization handles string results and object shapes containing `staticServerAddr`, `staticServerPort`, or `dataPlanePort`.
- Server requests handled locally: capability registration, message requests, workspace configuration, and `window/showDocument` for inverse sync.
- LSP positions use UTF-8 byte offsets; all CodeMirror conversions must go through the helper methods, especially for Khmer/CJK/emoji/non-ASCII content.

### D. Live Sync, Diagnostics, and Preview Highlight
- Typing calls `handleContentMutation()`, queues `pendingLspSyncText`, and debounces `textDocument/didChange` by 350 ms.
- Completion flushes pending text sync before asking Tinymist for completions so server state matches the typed prefix.
- Fallback diagnostics run via `typst compile --diagnostic-format short --format svg` after each sync and are ignored if version/path is stale.
- LSP diagnostics are ignored for stale versions, temporary preview-only versions, package/preview files, and the known multi-image page template message.
- Forward preview sync is a controlled hack: selected word is temporarily wrapped with `#text(fill:rgb("#fe0102"))[...]`, sent as a preview-only version, scrolled into view in the iframe, then reverted to editor text.
- Preview highlight only runs when `activeFilePath === previewRootPath`; library/template files receive diagnostics but no live preview highlight.
- Highlightable ranges exclude comments, raw inline code, math, block comments, and Typst code-expression spans (`#set`, `#show`, function calls, etc.).
- Inverse sync maps Tinymist `window/showDocument` source positions back through the temporary highlight mapping when present, then suppresses the next forward sync to avoid loops.

### E. WYSIWYM Mode
- WYSIWYM is a secondary DOM editing view, not the source of truth. Switching from Code to WYSIWYM calls `mapMarkupToWysiwym()`, switching back serializes with `mapWysiwymToMarkup()`.
- Block parsing is lightweight and line-oriented: headings, tables, quotes, math blocks, raw blocks, functions, lists, and body text. It is not a full Typst AST.
- Inline formatting is regex-based after HTML escaping. Markup markers are hidden in normal view and revealed during serialization with `.serialize-mode`.
- Table parsing preserves named args in `dataset.namedArgs`, tracks columns in `dataset.cols`, and serializes each cell back as `[cell]`.
- Toolbar behavior has two branches: WYSIWYM mutates DOM selection/blocks then serializes to CodeMirror; Code mode inserts Typst snippets/wrappers directly into CodeMirror.
- Ctrl-click WYSIWYM links ask for confirmation before opening external URLs through Tauri shell.

---

## 2. Editor & Syntax Highlight Rules

### A. Font Fallbacks & Monospace Rendering
- **Latin Monospace Stack**: Latin monospace fonts are placed *before* language-specific Unicode fallback fonts (like *MiSans Khmer*) in the CSS font stack. This prevents the Unicode font (which has non-monospace Latin glyphs) from overriding monospace rendering for code.
- **String Literals**: Rendered using a monospace font (`var(--editor-code-font)`) because they serve as internal parameters/code arguments rather than output text.
- **Equations & Raw Blocks**: Rendered in monospace. Both are assigned a unified theme-aware monospace color (`--ui-monospace-color`).

### B. Bracket Colorizer Exclusions
- Rainbow bracket styling is restricted **only** to nodes classified as `"punctuation"`.
- It skips comments, strings, equations/raw blocks (`"monospace"`), and plain text parentheses/brackets (`"content"`).

### C. Context-Aware Bracket Stack (`typstLanguage.ts`)
- **Code Mode vs Markup Mode**:
  - `isCodeMode` is active if `state.inCodeLine` is true or if the top of the bracket stack is a code bracket (i.e., not a content block `[`).
  - Parentheses `(` and curly braces `{` are **only** pushed to the bracket stack if `isCodeMode` is active. Standing parentheses/braces in normal text markup (like prose parentheses) are ignored by the stack, rendered in sans-serif, and not colored.
- **Content Blocks (`[...]`)**:
  - When matched, they reset `inCodeLine = false`.
  - Pushed as `[` if matched in code mode (represents a code content block; returns `"punctuation"`, colored).
  - Pushed as `"[standalone]"` if matched in markup/text mode (returns `"content"`, not colored).
  - Popping matches either `[` or `[standalone]`, preserving correct token types.

### D. Keywords and Functions in Nested Code
- **Without Hash (`#`)**: Inside code mode (e.g. inside function arguments), keywords like `none`, `auto`, `true`, `false`, `let`, etc. are highlighted without requiring the `#` prefix.
- **Nested Functions**: Functions called inside code blocks or parameters (e.g., `cetz.canvas(...)` or `draw-line(...)`) are matched using `/[A-Za-z_][\w.-]*(?=\s*(?:\(|\[))/` and highlighted as function names. Note that function names in code mode can contain hyphens and dots.

### E. Escape Sequences & Edge Cases
- **High-Priority Escape Matching**: Escaped characters (`\\.` like `\$`) are parsed first. They return `"content"` (or `null` in code), ensuring a literal `\$` does not prematurely trigger or close equation blocks.
- **URLs as Comments**: To prevent URLs like `https://example.com` from starting single-line comments via `//`, comments are only parsed if not immediately preceded by a colon (`:`).
- **Email Domain References**: To prevent domain names in email addresses (`user@example.com`) from being matched as label references (`@example`), references starting with `@` are only matched if they are not preceded by an alphanumeric character.

### F. Escaped Symbol Auto-Close Blocking
- A custom input handler in `src/editor/extensions.ts` intercepts characters that typically auto-close (like `$`, `(`, `[`, `{`, `"`, `'`, `*`, `_`).
- If the character is preceded by `\`, the handler manually inserts only the single character, blocking CodeMirror's auto-close mechanism.

---

## 3. UI Theme System
- CSS custom variables (`--ui-bg`, `--ui-text`, `--ui-monospace-color`, etc.) are updated dynamically on theme switch via `applyUIThemeVariables` in `src/editor/extensions.ts`.
- Themes define a custom `monospace` hex value to ensure that equation/code block text matches the active editor theme palette.

---

## 4. Architectural Lessons & Pitfalls Log

| Feature / Bug | Failed Approach (Anti-pattern) | Working Pattern / Fix | Rationale / Gotcha |
| :--- | :--- | :--- | :--- |
| **Text Parentheses** | Pushing `(` and `{` globally to `bracketStack`. | Only push in `isCodeMode`. | Prose parentheses (e.g. `(text)`) were treated as code parameters, making their text monospace. |
| **Escaped Symbols** | Parsing escape `\` and symbol separately. | High-priority `\\.` match at start of loop. | Escaped `\$` was split, leaving `$` to start an equation block that consumed the line. |
| **URL Comments** | Generic `//` comment matching. | Require preceding char `!== ":"`. | URLs like `https://example.com` matched `//` and turned the rest of the line green. |
| **Email References** | Matching all `@identifier` globally. | Reject if preceded by alphanumeric. | Email domain names (`user@example.com`) were colored as label references. |
| **String Font** | Sans-serif font for `tags.string`. | Monospace font (`var(--editor-code-font)`). | Strings are internal configuration arguments (e.g. `lang: "en"`), not output visual content. |
| **Escaped Auto-Close**| Keymaps or custom command overrides. | `EditorView.inputHandler` checking `from - 1 === "\\"`. | Keymaps didn't intercept autocomplete insertions; `inputHandler` filters them first. |
| **Tinymist Transport** | Frontend raw WebSocket client assumptions. | Rust spawns Tinymist stdio and frontend uses `lsp-rx`/`send_lsp_message` IPC. | CSP allows local sockets for preview assets, but JSON-RPC currently flows through Tauri events/commands. |
| **LSP Positions** | Treating LSP `character` as JS string offset. | Convert UTF-8 byte offsets to/from JS offsets before moving CodeMirror selections. | Non-ASCII scripts break cursor, diagnostic, completion, and inverse-sync positions if byte offsets are ignored. |
| **Preview Highlight Sync** | Persisting the red `#text(...)` wrapper as document content. | Track preview-only versions, suppress diagnostics briefly, then immediately send a revert `didChange`. | Forward sync mutates only Tinymist's transient document state; saved/editor text must stay untouched. |
| **Preview Root Files** | Starting preview from any opened `.typ` file. | `resolve_preview_main` chooses `main.typ`, `index.typ`, `document.typ`, nearest workspace ancestor candidate, or renderable current file. | Template/library files can be active editor files but should not always become the preview root. |
| **Workspace Restore** | Assuming unsaved tabs survive restart. | Restore tab paths and reload file contents from disk. | `localStorage` stores layout/selection only; dirty content is intentionally not serialized. |
| **Export PDF Action** | Trusting `compile_typst_document` to return a PDF path. | Current command compiles SVG preview pages and returns combined SVG markup. | UI says "Export PDF", but backend behavior is SVG-oriented; fix command/UI together before relying on export status. |

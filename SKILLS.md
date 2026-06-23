# Typstry Editor - Developer & AI Skills Reference

This document serves as the core knowledge base and skill reference for the Typstry Editor repository. AI agents and developers should read this file to understand the framework, technology stack, architecture boundaries, and best practices.

## 1. Technology Stack
- **Package Manager:** Bun (`bun install`, `bun run tauri dev`)
- **Desktop Framework:** Tauri v2 (Rust + Webview)
- **Frontend Core:** Vite + Vanilla TypeScript (No UI frameworks like React or Vue)
- **Editor Engine:** CodeMirror 6
- **Language Server:** Tinymist LSP (WebSocket connection to `127.0.0.1:8589`)
- **CLI Dependency:** The host machine must have the `typst` CLI installed and available in the system PATH.

## 2. Architecture & Process Boundaries
The application operates across distinct processes and contexts:

### 2.1 Rust Native Layer (`src-tauri/`)
- **Entry Point:** `src/main.rs` hands off to `lib::run()`.
- **Tauri Plugins:** Relies heavily on `@tauri-apps/plugin-fs` (file system), `@tauri-apps/plugin-shell` (CLI invocation), and `@tauri-apps/plugin-dialog` (OS file pickers).
- **Compilation Engine:** The native backend exposes a `compile_typst_document` command that orchestrates local `typst` CLI compilations inside a `tempfile` isolated directory and pipes back the resulting PDF buffer.
- **Security:** `tauri.conf.json` enforces a strict CSP that explicitly allows `ws://127.0.0.1:8589` for Tinymist LSP SVG streaming.

### 2.2 Webview Frontend Layer (`src/`)
- **Orchestrator (`main.ts`):** Handles the global application state (`TypstryWorkspaceController`). Toggles between `CODE` (CodeMirror) and `WYSIWYM` (Rich Text Block) views. Listens to native Tauri menu events (`menu-toggle-layout`, `menu-open-folder`).
- **File Explorer (`components/explorer.ts`):** A custom virtual DOM tree renderer that uses `tauri-plugin-fs` to scan and traverse workspace directories locally.
- **CodeMirror Integration (`editor/`):** Contains `extensions.ts` and `themes.ts`. Implements a highly customized, dark-themed Unicode-compliant editor layout with basic Typst token matching.
- **LSP Interface (`compiler/lsp.ts`):** Connects to the standalone Tinymist LSP via raw WebSockets. Maps `textDocument/didChange` events and intercepts `tinymist/preview/svgStream` to render live visual feedback inside the Webview DOM.

## 3. Implementation Rules & Best Practices
1. **Never use React/Vue/Svelte:** This project strictly uses `document.createElement`, `DocumentFragment`, and Vanilla TS/HTML/CSS for maximum performance and minimum footprint.
2. **File Paths:** All frontend file paths interacting with the system must be resolved via `@tauri-apps/api/path` to guarantee cross-platform compatibility.
3. **Event Driven:** Always use Tauri's IPC `listen()` and `emit()` mechanisms or explicit WebSocket JSON-RPC calls instead of tight coupling.
4. **WYSIWYM Parsing:** When mutating content in the WYSIWYM blocks, remember to map structural elements back to standard Typst markup prefixes (e.g., heading blocks prefix with `= `).

## 4. Common Troubleshooting
- **LSP Offline Warnings:** If the Tinymist client emits offline warnings, verify that the Tinymist LSP is actually active on port `8589`.
- **LNK1104 msvcrt.lib / Rust Compile Errors on Windows:** Tauri requires the MSVC toolchain. Ensure that **Desktop development with C++** and the **Windows 10/11 SDK** are installed via the Visual Studio Installer.

*(This file should be continually updated as the project's architectural scope expands).*

# Typstry Development Context & Design Constraints

This file serves as a consolidated reference for the architectural decisions, parser configurations, and custom editor behaviors implemented in Typstry. It is intended to prevent regression and ensure rapid context alignment across development sessions.

---

## 1. Core Architecture
- **Tech Stack**: Tauri v2 (Rust backend for system/file operations and Tinymist LSP lifecycle) + Bun/Vite (Frontend) + CodeMirror 6 (Editor).
- **Core Files**:
  - `src/editor/typstLanguage.ts`: StreamLanguage-based parser for Typst.
  - `src/editor/extensions.ts`: Custom CodeMirror extensions (autoclose overrides, LSP bridges, themes).
  - `src/editor/themes.ts`: Global HighlightStyle and editor layouts.
  - `src/editor/bracketColorizer.ts`: Rainbow bracket decorator.

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

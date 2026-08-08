# Settings

Open Settings from **File → Settings**, the status bar, or `Ctrl + ,`. Changes apply immediately and are persisted to `settings.json`; the panel displays the exact platform-specific file path and can reveal it in the system file manager.

```json
{
  "version": 2,
  "appearance": {
    "theme": "default",
    "editorFontSize": 14,
    "editorLineHeight": 1.7
  },
  "editor": {
    "codeFont": "Fira Mono",
    "textFont": "same-as-code",
    "textFontScale": 1.08,
    "unicodeFont": "auto",
    "spellcheck": true,
    "wordCompletion": true,
    "userDictionary": [],
    "wordWrap": true,
    "tabSize": 2,
    "lineNumbers": true,
    "highlightActiveLine": true,
    "autoCloseBrackets": true,
    "indentationGuides": true,
    "formatOnSave": false,
    "autoSave": true,
    "autoSaveIntervalSeconds": 30
  },
  "preview": {
    "renderMode": "on-save",
    "cursorSync": true,
    "syncDebounceMs": 500,
    "forwardSyncTimeoutMs": 5000,
    "highlightDurationMs": 2200,
    "khmerRenderPreparation": false
  },
  "compatibility": {
    "disableWebkitDmabufRenderer": false
  },
  "toolchain": {
    "tinymistVersion": null
  }
}
```

Invalid or missing fields fall back to bounded defaults. Existing theme and word-wrap values from older releases are migrated from `localStorage` the first time the settings file is created.

## Saving

**Auto save** writes dirty open files at the configured interval, which accepts
5–300 seconds and defaults to 30 seconds. Automatic saves persist the current
editor contents without running Format on save, sending a Tinymist save
notification, or requesting an **On save** preview compilation.

**Save** and `Ctrl+S` remain explicit author actions. They run Format on save
when enabled, notify Tinymist, and request preview compilation for the active
preview document. This remains true when auto-save has already written the
latest revision and the tab is no longer marked dirty.

## Project-local workspace state

Workspace-specific state lives under the project’s `.typsastra/` directory. `config.json` is portable and stores project identity, the relative main document, and the recommended toolchain. `workspace.json` stores the local editing session using relative paths, including tabs, cursor/scroll state, explicitly user-created folds, explorer expansion, layout, sidebar visibility, the selected toolchain override, and the preview refresh/content modes. Files open fully unfolded until the user folds them; legacy automatic fold ranges are discarded because they cannot be distinguished safely from manual folds. The session file and preview cache are ignored by the managed `.gitignore`; `config.json` may be committed. Generated fonts never reside in this directory. `.typsastra/project.json` remains reserved for the signed Typsastra project-archive manifest.

Typsastra project exports include `config.json` and `workspace.json` only from this directory. Every live-preview mirror, generated preview PDF, source map, and temporary compiler artifact is confined to `.typsastra/cache`; none is created beside user sources. Non-Typst cache assets use regular hard links when supported, avoiding duplicate storage while retaining a copy fallback and never introducing symbolic links. If a workspace is copied or moved together with `.typsastra/cache`, Typsastra detects that the cache belongs to another path and discards it before starting Tinymist; portable workspace settings remain intact and the cache is rebuilt on demand. A user-facing PDF is written into the workspace only after explicit confirmation through **Export PDF**. Render caches, generated PDFs, maps, generated fonts, and other internal metadata are never included in project exports. Font binaries are excluded everywhere in project and source ZIP exports regardless of location or license; recipients install required fonts separately.

## Toolchain

The Toolchain panel installs stable Tinymist releases and shows each release's embedded Typst version. Tinymist is the only toolchain download: its embedded compiler handles diagnostics, fallback SVG compilation, and PDF export, so a separate Typst installation is not required.

## Preview

The workspace `previewRenderMode` accepts `"on-type"` and `"on-save"`.
On-type keeps editor changes in memory and starts a PDF update after
`syncDebounceMs`; on-save updates only after a successful save. The selection
is restored independently for each workspace. The global `renderMode` value in
`settings.json` is used only as the initial default when a workspace has no
saved selection. Both modes compile from a private mirror under
`.typsastra/cache`, so live preview never creates `main.pdf` beside the source.
Use on-save for long or resource-intensive documents.

The live-preview toolbar also offers **Normal** and **Draft** content modes.
Normal Preview compiles the original images. Draft Preview replaces eligible
static local image calls only in Typsastra's private render mirror with
lightweight placeholders that keep the source image's exact intrinsic aspect
ratio. Explicit `width` and `height` values are transferred to the placeholder
block; image-only fitting options are omitted. Hover or keyboard-focus a
placeholder to inspect the original image on demand.

The selected content mode is stored per workspace. Dynamic, remote, package,
missing, and unsupported images remain unchanged and are listed in the Draft
Preview details dialog. Final PDF export always uses the original images,
regardless of the selected preview mode.

Draft placeholder geometry and interaction are qualified for standalone
`image(...)` calls and images inside a `block` with `clip: true`. Images used
through other layout compositions may produce a differently sized or
positioned placeholder, or an imprecise hover or click area. Switch to Normal
Preview to validate exact image layout and interaction.

Imported files continue to preview through their configured main document. The
former standalone-preview directive remains disabled; its portable replacement
is planned for v0.8.0 and hardened in v1.x.

`syncDebounceMs` controls how long on-type mode waits after the latest edit
before starting a preview update. It does not affect on-save mode.

`forwardSyncTimeoutMs` is the total time a manual **Reveal Cursor in Preview**
request may spend preparing the source-map session and locating a matching PDF
position. It defaults to 5000 ms and accepts 1000-30000 ms. A shorter timeout
returns control sooner when the selected Typst source has no representable
preview position. Background source-map warm-up retains its longer independent
window and does not block the editor.

Automatic cursor-to-preview sync is temporarily disabled. Its reliability
redesign and re-enablement are scheduled for the v0.9.0 prerelease; manual
forward sync remains available from the preview toolbar and keyboard shortcut.

### Linux preview compatibility

On Linux, the Preview panel reports the desktop session, WebKitGTK version, graphics vendor when detectable, CPU architecture, and whether the DMA-BUF renderer is active. A Wayland, AMD, and WebKitGTK 2.52.x combination is marked as a reported-risk profile for an all-white preview that may flash briefly while resizing. Detection is advisory and never changes the renderer automatically.

**Disable WebKitGTK DMA-BUF renderer** persists `compatibility.disableWebkitDmabufRenderer` globally. After confirmation and restart, Typsastra sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` before creating the WebKit webview. This workaround may reduce rendering performance and should remain off unless the preview is affected. An environment variable supplied by an AppImage manager, shell, or desktop launcher remains authoritative and is identified separately in the compatibility status.

## Fonts and typography

Only MiSans Latin and Fira Mono are bundled. Typsastra installs them in the current user's font directory on first launch, avoiding administrator access on Windows, Linux, and macOS.

Settings enumerates the operating system's fonts:

- The code-font selector contains monospace families.
- The document-text selector accepts any installed family and applies it only
  to prose. **Same as code font** preserves the traditional all-monospace
  editor.
- **Document text size** adjusts prose from 80–140% of the code-font size. Its
  default is 108% to compensate for the smaller apparent x-height common in
  proportional fonts. **Same as code font** always renders at 100%.
- The Unicode fallback selector accepts any installed family.
- Automatic detection recommends the matching MiSans family when one exists and a script-specific Noto Sans family otherwise.

**Private local font directories** add global folders that Typsastra may pass
directly to Typst and Tinymist without installing their fonts into the operating
system. Typsastra validates a directory before adding it and rejects family
names that collide with a system font or another configured private directory.

For a folder needed by only one project, use **Document Typography → Workspace
private fonts**. A folder inside the project is stored as a safe relative path;
one outside the project remains an absolute machine-local path. Workspace font
paths live in ignored `.typsastra/local.json`, and are never exported or added
to a project archive.

Document Typography groups available families in this order: **Typst
built-in**, **Private local**, then **System fonts**. Private local fonts are
available consistently to diagnostics, preview, source synchronization,
generated scale variants, and PDF export. Changing the directory list restarts
the active Tinymist session. These compiler-only paths do not add fonts to the
CodeMirror code-font or Unicode UI-font selectors because the WebView cannot
load an arbitrary filesystem font as an installed browser font.

Private directory discovery supports `.ttf`, `.otf`, `.ttc`, and `.otc`.
Collections are available at their original scale but cannot be transformed
into scaled variants. WOFF and WOFF2 files are ignored; a directory containing
only those web-font formats is rejected. Variable TTF and OTF files are
available at `1.0×`, but Document Typography does not expose arbitrary
variation axes and non-unit scaling remains experimental. See
[Document typography](DOCUMENT_TYPOGRAPHY.md#supported-private-font-formats).

Typsastra never downloads fonts without confirmation and does not repeat a recommendation the user declines. MiSans downloads and use are subject to Xiaomi's [MiSans license agreement](https://hyperos.mi.com/font/en/download/); Noto fonts use the [SIL Open Font License](https://openfontlicense.org/).

The selected Unicode fallback follows both editor stacks: Typst syntax starts
with the selected monospace code font, while document prose starts with the
selected text font. Complex-script fallbacks remain available to both. Strings,
comments, raw blocks, equations, function names, arguments, and punctuation
remain in the code font. The fallback is also included in Typsastra's own UI
font stack for app-rendered text such as search controls, hover popups, and
preview status messages.

The typography toolbar controls the fonts used by the compiled document, separately from the editor font settings. Enable either the Latin family, the complex-script fallback family, or both. **Apply to document** writes a source-preserving fallback stack in a managed `typsastra:typography` block. **Apply as template** updates the local function used by the main document's `#show: ...with(...)` rule, or creates `typsastra-template.typ` when no editable local template can be identified.

Document Typography records one default text font per configured script and can prepare additional explicitly called fonts for the same script at independent scales. Typsastra writes only default text rows as an ordinary ordered Typst fallback stack; list order determines glyph priority, including numbers, punctuation, and fonts whose coverage overlaps another configured script. A **Prepared font only** row remains available by its normal family name, such as `#text(font: "Moul")[...]`, without entering that stack or owning language tools. Strict script-specific font enforcement is deferred for later exploration. Values other than `1.0` use a render-only variant from Typsastra's private global application-data cache and restart Tinymist with only the selected cache directories as font paths. Compiler-embedded fonts remain locked to `1.0` unless the same family is installed locally; manually assigning them another scale produces an error and resets the directive to `1.0` because Typsastra does not extract embedded font files. Matching variants are reused across projects without rescaling, and no font data is stored in `.typsastra`. Typsastra recommends at most 10 cached scale variants per font face and asks before creating another; it never deletes variants automatically. Non-unit scaling is experimental for PDF output because Typst may normalize generated fonts while subsetting them; use `1.0` when dependable PDF export is required. Typsastra does not create script-matching show rules because they break character-level inverse sync, and it does not patch the resulting PDF or make preview differ from export. Raw code keeps Typst's original raw font. See [Document typography](DOCUMENT_TYPOGRAPHY.md).

## Language tools

Script-aware editing, spellcheck, correction suggestions, and typing word suggestions are independent capabilities. Script-aware editing is applied automatically where Typsastra has a tested policy; it does not depend on a dictionary or on spellcheck being enabled.

Spellcheck and typing word suggestions can be controlled independently in Editor settings. Corrections are shown only when the active provider advertises reliable correction support.

Settings installs language providers globally. A provider participates in a
document only after its language is assigned to a script through the Typography
toolbar and stored in the configured main file's `typsastra:document-scripts`.
That one assignment is inherited by included chapters, imported templates, and
imported local libraries; it does not need to be copied into those files.
Unrelated files inherit nothing and may declare their own routing.

**Add language...** opens the catalog dialog to download additional Hunspell dictionaries. Each catalog entry row displays detailed onboarding metadata:
- **Provider Type:** Displays the type level (e.g. `Deep provider` or `Dictionary only`).
- **Support Level:** Displays support depth (Basic, Enhanced, Deep) and stability (Stable, Experimental).
- **Download Size:** The combined byte size of the `.aff` and `.dic` files.
- **License & Version:** Explicit license terms (e.g. `MPL 2.0 / GPL` or `LGPL`) and dictionary version.

Each installed downloadable language can be uninstalled from this menu. Clicking the red **Remove** button deletes the files from the local storage folder and cleanly unregisters the language provider dynamically.

Installed languages display both support depth and stability:

- **Basic** provides dictionary-backed spelling with general boundaries and does not imply reliable segmentation or completion.
- **Enhanced** adds a tested tokenizer, word completion, or another language-aware capability.
- **Deep** combines dedicated language tooling with script-aware editing where the script requires tailoring.
- **Experimental** is a separate stability label and may appear alongside any depth level.

Bundled providers include:

- Khmer through the custom Khmer segmenter.
- English (US) through Hunspell-format dictionary resources.

Khmer is currently **Deep · Experimental** (advertised as `Deep provider`). Bundled English is **Enhanced · Stable** (advertised as `Dictionary only`). Downloaded Hunspell-compatible dictionaries are **Basic · Stable** unless a tested language-specific provider supersedes them.

Provider architecture is documented in [LANGUAGE_TOOLS.md](./LANGUAGE_TOOLS.md), and modern Khmer encoding policy is documented in [KHMER_SPELLCHECK.md](./KHMER_SPELLCHECK.md).

Khmer render preparation leaves source files unchanged and, when explicitly enabled, generates preview/export input with zero-width word-break opportunities. This renderer path is experimental, defaults off, and its Settings row is shown only in dev builds.

## WebView storage monitoring

Typsastra monitors its embedded-browser profile in the background without
placing directory traversal on the UI thread. Settings reports total size,
disposable cache, recent growth, and the resolved platform-specific location.
Routine measurements will not interrupt editing.

Windows WebView2 and Linux WebKitGTK are qualified read-only monitoring targets.
Typsastra performs the first full scan after the workspace UI is ready, refreshes
disposable-cache measurements after idle periods, and retains at most 32
aggregate local samples. Use **Settings → Storage → Scan now** for an immediate
full scan or **Reveal folder** to inspect the resolved storage location.

On Linux, WebKitGTK shares Typsastra's application-local data root. Monitoring
therefore counts only allowlisted WebKit-owned categories. Managed Typst and
Tinymist toolchains, dictionaries, generated fonts, and update data are excluded.
WebKit's HTTP cache is classified as disposable; CacheStorage, Local Storage,
and other website data remain persistent.

Monitoring does not authorize deleting the complete WebView profile. Normal
maintenance will preserve persistent application state and offer cleanup only
for qualified disposable categories in a later phase. The current implementation
is read-only. See the
[WebView storage monitoring and maintenance policy](./WEBVIEW_STORAGE_POLICY.md)
for cadence, thresholds, warning behavior, cleanup boundaries, and validation
gates.

## Formatting

Typst formatting is available from **Edit → Format Document** or `Ctrl+Shift+F`. **Format on save** is an Editor setting and defaults off.

## Keyboard shortcuts

- `Ctrl + N`: New File
- `Ctrl + K`, `Ctrl + O`: Open Project
- `Ctrl + B`: Toggle Explorer Sidebar
- `Ctrl + ,`: Open Settings
- `Ctrl + Shift + F`: Format Document
- `Alt + Z`: Toggle Word Wrap
- `Ctrl + ~`: Toggle Log Console

Shortcuts are matched by physical key position, so they continue to work under Khmer and other non-Latin keyboard layouts.

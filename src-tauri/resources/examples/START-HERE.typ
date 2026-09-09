#set document(title: "Typsastra Examples")
#set page(margin: 24mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1,"language":"en-US"}]
#set text(
  font: ("New Computer Modern",),
  size: 11pt,
)
// typsastra:typography:end
#set heading(numbering: "1.")

= Learn Typsastra

These writable examples progress from ordinary Typst source to multilingual,
multi-file research projects. Start with the first two sections, then open the
example that matches the feature you want to learn.

== 01. Basics

- `01-writing-basics`: markup, tables, references, and equations.
- `02-unicode-math`: Unicode symbols and mathematical notation.
- `03-diacritic-aware-search`: exact and accent-insensitive search across
  composed Unicode, decomposed Unicode, and complex-script marks.

== 02. Multilingual writing

- `01-script-font-assignments`: ordered font fallback and independent visual
  scaling.
- `02-language-scoped-spellcheck`: explicit per-script language providers,
  provider-off behavior, and terminology.
- `03-keyboard-language-completion`: document-script word completion without
  keyboard-layout detection (the folder name is retained for compatibility).
- `04-complex-script-typography`: shaping samples for several complex scripts.
- `05-script-and-direction-samples`: mixed scripts, CJK, and bidirectional
  rendering samples. First-class RTL editing is planned for v0.9.0.

== 03. Language providers

English and Khmer are bundled. Optional providers are installed from Settings
(`Ctrl+,` on Windows/Linux or `Cmd+,` on macOS).

- `01-khmer-deep-support`: Khmer editing, spellcheck, and completion.
- `02-khmer-justification-comparison`: native Typst Khmer paragraph layouts.
- `03-lao-enhanced-support`: Lao segmentation with optional spellcheck.
- `04-optional-dictionaries`: installation and unavailable-provider recovery.

== 04. Research projects

- `01-multilingual-article`: a complete multilingual document-language workflow.
- `02-simple-thesis`: chapters, labels, and cross-file references.
- `03-khmer-folklore-book`: a long-form multi-file Khmer project.
- `04-typsastra-readme`: templates, imports, bibliography, images, and chapters.

== 05. Project portability

- `01-main-and-included-files`: main-document preview ownership.
- `02-portable-workspace-state`: what Typsastra stores in `.typsastra`.
- `03-font-free-project-export`: lightweight archives and external font requirements.

== 06. v0.6.0 feature showcase

- `01-draft-preview-and-image-guidance`: Normal/Draft preview, cached hover
  thumbnails, direct placeholder inverse sync, and image diagnostics.
- `02-preview-navigation`: manual forward sync plus internal and external
  clickable references.
- `03-private-local-fonts`: machine-local font directories, source portability,
  fallback order, and export boundaries.

== 07. v0.7.0 feature showcase

- `01-markdown-live-preview/README.md`: sanitized Markdown rendering, common
  GFM structures, workspace links and images, mixed scripts, and blocked remote
  resources.
- Open `06-v0.6-feature-showcase/01-draft-preview-and-image-guidance/main.typ`,
  then choose Image Tools to inspect its bundled raster assets and preview an
  optimized copy.
- Revisit `01-basics/03-diacritic-aware-search` for wrapped search highlights
  and exact scrollbar-marker navigation.
- Open `05-project-portability/01-main-and-included-files` to verify one shared
  preview page across the main document and included chapter.
- After compiling an example, open Settings and inspect its machine-local cache
  under Storage.

Open a `main.typ` file from Explorer. Set it as the project main file when the
example contains included files. Your installed examples are writable. Each
Typsastra release uses a new versioned examples folder, so a future update does
not overwrite or silently reopen anything you edited here.

The full tutorials are available at
`https://github.com/Sovichea/typsastra/tree/main/docs/tutorials`.

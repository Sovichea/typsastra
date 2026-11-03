#set document(title: "Typsastra Examples")
#set page(margin: 24mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1}]
#set text(
  font: ("New Computer Modern",),
  size: 11pt,
)
// typsastra:typography:end
#set heading(numbering: "1.")

= Learn Typsastra

These writable examples follow the capabilities of the current Typsastra
release rather than a historical release number. Start with the first two
sections, then open the exercise that matches the workflow you want to learn.
Every exercise is ordinary Typst source; the matching walkthroughs are in the
#link("https://docs.typsastra.com/")[Typsastra documentation].

== Recommended path

1. `01-basics`: markup, mathematics, and diacritic-aware search.
2. `02-multilingual-writing`: document-script fonts, spellcheck, completion,
   complex-script shaping, and direction samples.
3. `03-language-providers`: bundled, optional, and unavailable providers.
4. `04-research-projects`: complete multi-file articles, theses, and books.
5. `05-project-portability`: main documents, workspace state, and font-free
   export.
6. `06-preview-and-media`: Normal/Draft preview, image helpers, preview links,
   private fonts, and Markdown notes.
7. `07-editor-workflows`: project search, reviewed replacement, recovery,
   shared outline, Back/Forward navigation, and language defaults.
8. `08-tools-and-templates`: linked Table Tools blocks, CSV/TSV import, table
   export, and project creation from templates.

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
  rendering samples. First-class RTL editing remains a future pre-1.0 milestone.

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
- `03-font-free-project-export`: lightweight archives and external font
  requirements.

== 06. Preview and media

- `01-draft-preview-and-image-guidance`: Normal/Draft preview, cached hover
  thumbnails, image diagnostics, and a non-destructive Image Tools workflow.
- `02-image-helper-chains`: inverse sync follows nested `image()` helpers to the
  outermost call, and Draft Preview substitutes that same call while forwarding
  helper width and height parameters.
- `03-preview-navigation`: manual forward sync, inverse sync, internal
  references, external links, page jumps, and preserved scroll position.
- `04-private-local-fonts`: machine-local font directories, fallback order, and
  the project-export boundary.
- `05-markdown-notes/README.md`: sanitized Markdown preview, GFM structures,
  workspace resources, mixed scripts, and blocked remote content.

== 07. Editor workflows

- `01-project-search-and-recovery`: search a three-file notebook with literal,
  regex, and fuzzy modes; review a cross-file replacement; inspect unsaved-work
  recovery; follow the shared main-document outline; and retrace jumps with
  Back and Forward.
- `02-language-defaults`: compare per-project script-language assignments with
  the global defaults used by new projects.

== 08. Tools and templates

- `01-linked-table`: recover or create a Table Tools model, link it to a
  `//@table:` anchor, edit cells, and inspect the generated Typst block.
- `02-project-templates/README.md`: browse Typst Universe, downloaded, and user
  templates; create a project; and save a reusable template.

== Current feature map

#table(
  columns: (1fr, 2fr),
  inset: 7pt,
  stroke: 0.5pt + luma(185),
  table.header([Feature], [Example]),
  [Project search and reviewed replacement], [`07-editor-workflows/01-project-search-and-recovery`],
  [Unsaved-work recovery], [`07-editor-workflows/01-project-search-and-recovery`],
  [Shared main-document outline and tab list], [`07-editor-workflows/01-project-search-and-recovery`],
  [Back/Forward source navigation], [`07-editor-workflows/01-project-search-and-recovery`],
  [Global document-language defaults], [`07-editor-workflows/02-language-defaults`],
  [Nested image helpers and inverse sync], [`06-preview-and-media/02-image-helper-chains`],
  [Draft Preview and image diagnostics], [`06-preview-and-media/01-draft-preview-and-image-guidance`],
  [Preview links and synchronization], [`06-preview-and-media/03-preview-navigation`],
  [Markdown live preview], [`06-preview-and-media/05-markdown-notes/README.md`],
  [Private fonts and script typography], [`06-preview-and-media/04-private-local-fonts`, `02-multilingual-writing/01-script-font-assignments`],
  [Language providers], [`03-language-providers`],
  [Linked Table Tools blocks], [`08-tools-and-templates/01-linked-table`],
  [Project templates], [`08-tools-and-templates/02-project-templates/README.md`],
  [Low-Memory Mode], [`04-research-projects/03-khmer-folklore-book`],
  [Main-file preview ownership], [`05-project-portability/01-main-and-included-files`],
)

Open a `main.typ` file from Explorer. Set it as the project main file when the
example contains included files. Your installed examples are writable. Each
Typsastra release uses a new versioned examples folder, so a future update does
not overwrite or silently reopen anything you edited here.

The full tutorials are available at
`https://github.com/Sovichea/typsastra/tree/main/docs/tutorials`.

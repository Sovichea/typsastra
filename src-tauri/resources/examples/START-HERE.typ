#set document(title: "Typsastra Examples")
#set page(margin: 24mm)
// typsastra:typography:start
// typsastra:script-fonts [{"family":"MiSans Latin","script":"latin","scale":1}]
#set text(
  font: ((name: "MiSans Latin", covers: regex("\p{scx=Latin}")),),
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

== 02. Multilingual writing

- `01-script-font-assignments`: script-specific fonts, Unicode coverage, and
  independent visual scaling.
- `02-language-scoped-spellcheck`: Typst language scopes, same-script isolation,
  terminology, and missing-provider warnings.
- `03-keyboard-language-completion`: typing suggestions selected independently
  from the document's spellcheck scope.
- `04-complex-script-typography`: shaping samples for several complex scripts.
- `05-script-and-direction-samples`: mixed scripts, CJK, and bidirectional
  rendering samples. First-class RTL editing is planned for v0.9.0.

== 03. Language providers

English and Khmer are bundled. Optional providers are installed from Settings
(`Ctrl+,` on Windows/Linux or `Cmd+,` on macOS).

- `01-khmer-deep-support`: Khmer editing, spellcheck, and completion.
- `02-khmer-segmentation-comparison`: ordinary and prepared Khmer layout.
- `03-lao-enhanced-support`: Lao segmentation with optional spellcheck.
- `04-optional-dictionaries`: installation and unavailable-provider recovery.

== 04. Research projects

- `01-multilingual-article`: the complete multilingual language-scope workflow.
- `02-simple-thesis`: chapters, labels, and cross-file references.
- `03-khmer-folklore-book`: a long-form multi-file Khmer project.
- `04-typsastra-readme`: templates, imports, bibliography, images, and chapters.

== 05. Project portability

- `01-main-and-included-files`: main-document preview ownership.
- `02-portable-workspace-state`: what Typsastra stores in `.typsastra`.
- `03-font-free-project-export`: lightweight archives and external font requirements.

Open a `main.typ` file from Explorer. Set it as the project main file when the
example contains included files. Your installed examples are writable. Each
Typsastra release uses a new versioned examples folder, so a future update does
not overwrite or silently reopen anything you edited here.

The full tutorials are available at
`https://github.com/Sovichea/typsastra/tree/main/docs/tutorials`.

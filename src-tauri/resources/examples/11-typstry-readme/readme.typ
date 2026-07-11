#import "import.typ" as imp

= Introduction to #imp.project-name <intro>

#align(center)[
  #image("assets/typstry-wordmark.png", width: 75%)
]

#imp.project-name is a complex-script-first Typst environment for research and long-form multilingual writing.

== What is #imp.project-name?

#imp.project-name is a local-first writing environment for Typst, designed for research papers, technical documentation, theses, books, and other long-form documents.

It serves writers and researchers whose languages are not always well supported by traditional technical-writing tools. #imp.project-name focuses on Unicode-safe editing, script-aware interaction, responsive PDF preview, extensible language tools, and multi-file project workflows while keeping the underlying Typst source portable.

Khmer is the first language with deep support, including tailored cursor and deletion behavior, spellcheck, and word completion. Khmer demonstrates the depth #imp.project-name aims to provide; it is not the boundary of the project. The editing-policy and language-provider architecture is designed so other languages can add their own behavior without changing or weakening Khmer support.

== Highlights

- Local-first desktop authoring with ordinary, portable Typst source files.
- CodeMirror editing with Unicode-safe ranges and complex-script font fallback.
- Script-aware editing-policy registry with deeply tailored Khmer behavior.
- Khmer spellcheck and word completion through the pinned Khmer segmenter.
- English spellcheck bundled by default, with optional Hunspell-compatible dictionaries for additional languages.
- Independent controls for script-aware editing, spellcheck, and typing suggestions.
- Tinymist diagnostics and managed Typst tooling.
- Virtualized PDF preview designed for long documents and constrained memory use.
- Main-document and standalone-preview workflows for multi-file projects.
- Workspace support for templates, chapters, includes, bibliography files, figures, and external assets.

== Language support

Language support is capability-based rather than all-or-nothing:

- *Deep support* can include a script editing policy, reliable segmentation, spellcheck, and word completion. Khmer is the first deep implementation.
- *Enhanced support* can add a tokenizer or other language-specific boundary logic without requiring custom editor behavior.
- *Basic support* uses a compatible dictionary where available. This can provide useful spellcheck, but it is not presented as reliable segmentation for languages that require a dedicated tokenizer.

For more information, see the official publication @typst2024 and our repository @typstry2026.

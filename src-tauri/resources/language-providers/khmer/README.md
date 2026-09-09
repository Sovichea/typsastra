# Khmer runtime dictionaries

These compiled artifacts are generated from the language data pinned by the
`third_party/khmer_segmenter` submodule:

- `khmer_dictionary.kdict` is the unified KDIC v2 artifact used by the v0.2.0
  provider. It supplies deterministic analysis plus the curated spellcheck,
  completion, and correction metadata used by Typsastra's language tools.
  Typsastra selects visual spelling accuracy, so legacy COENG DA and COENG TA
  forms are accepted as equivalent while corrections and completion retain the
  curated spelling.

It is application runtime data, not an independent editable source of Khmer
vocabulary. Replace it with the bundled Rust KDIC artifact whenever the pinned
submodule release changes.

The source attribution, usage terms, and rebuild procedure are documented in
the pinned submodule's `docs/DATA.md` and `docs/EMBEDDED_DICTIONARY.md` files.

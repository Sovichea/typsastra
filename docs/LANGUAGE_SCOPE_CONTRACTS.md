# Superseded language-scope contracts

The v0.5.0 Typst-scope and keyboard-language routing contracts were replaced by
the document-script model during v0.5.x development. They are not runtime
contracts.

The current contract is documented in
[Document language tools](SCOPE_AWARE_LANGUAGE_TOOLS.md): portable project
metadata assigns at most one language to each ambiguous script, while scripts
with one catalog language resolve automatically. Typst `lang` scopes and
operating-system keyboard layouts do not reroute spellcheck or word completion.

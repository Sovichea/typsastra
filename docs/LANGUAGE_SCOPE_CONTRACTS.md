# Superseded language-scope contracts

The v0.5.0 Typst-scope and keyboard-language routing contracts were replaced by
the document-script model during v0.5.x development. They are not runtime
contracts.

The current contract is documented in
[Document-script language tools](SCOPE_AWARE_LANGUAGE_TOOLS.md): the configured
main file's `typsastra:document-scripts` directive assigns at most one language
provider to each script. Typst `lang` scopes and operating-system keyboard
layouts do not reroute spellcheck or word completion.

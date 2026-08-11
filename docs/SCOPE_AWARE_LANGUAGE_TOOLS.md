# Document language tools

Typsastra keeps language-tool routing in a small directive that is independent
from the document's ordinary Typst font configuration:

```typst
// typsastra:document-languages [{"script":"latin","language":"en-US"},{"script":"khmer","language":"km"},{"script":"arabic","language":"ar"}]
```

Each entry selects the spellcheck and word-completion provider for one Unicode
script. The Typography toolbar writes this directive. Font order and size stay
in an ordinary `#set text(...)` rule; prepared font variants are managed by
Font Tools and do not appear in this metadata.

## Routing contract

- A script with a configured language uses exactly one matching installed
  provider.
- A script without `language` receives no Typsastra spellcheck or word
  completion.
- A configured language whose provider is not installed also receives no
  analysis. The Typography toolbar identifies the unavailable provider.
- Typsastra never substitutes another same-script dictionary. French does not
  fall through to English merely because both use Latin.
- Typst `lang` scopes and the operating-system keyboard layout do not select
  Typsastra language providers.
- IME candidates remain owned by the operating system and are independent of
  Typsastra word completion.

The configured main file owns this project-level setting. Typsastra inherits it
across the main document's local dependency graph, including included chapters,
imported templates, and imported local libraries. Authors do not copy the
directive into those files, and a dependency-local directive does not override
the main document's language routing.

Files outside that dependency graph do not inherit the main setting. An
unrelated file can opt in with its own `document-languages` directive; otherwise
Typsastra leaves its spellcheck and word completion disabled. When a workspace
has no configured main file, the active standalone document owns its setting.

## Why this model is deliberately simple

Script detection is deterministic, whereas keyboard-layout detection varies by
platform and static analysis of Typst style scopes cannot evaluate every
dynamic program. The document directive therefore gives authors one visible,
portable source of truth and fails closed when it is incomplete.

One script can select one language at a time. A document that mixes English,
French, and Spanish cannot spellcheck all three simultaneously under this
model because all three use Latin. Choose the document's principal Latin
language, then change it from the Typography toolbar when reviewing another
language. Typst `#set text(lang: ...)` remains useful for Typst's own shaping,
hyphenation, and localization behavior; it simply does not reroute Typsastra's
dictionary.

## Provider installation and terminology

Provider binaries and dictionaries are installed globally under Settings.
Installation makes a provider available; it does not activate it for every
project. The main file's `document-scripts` directive activates it for that
document and its local dependencies.

Global and project terminology continue to recognize accepted names. Language-
family terminology is applied only when its matching configured provider owns
the script being checked.

# Multilingual spellcheck and completion

## Configure document languages

1. Install optional providers from **Settings → Language → Language providers**.
2. Open a Typst document and select the language item in the status bar.
3. In **Document Languages**, choose a language for each listed script.
4. Select **Apply**.

The dialog lists only scripts that have multiple possible languages. Latin may
need an English, French, Spanish, or another configured choice. Khmer is not
listed because `Khmr` has one available language and resolves automatically.
Move the caret between scripts to see the current pair in real time.

Assignments apply to the whole project and travel in
`.typsastra/config.json`. They are independent from Document Typography and are
not written into Typst source.

If a selected provider is unavailable, the selection is retained but receives
no spellcheck or completion until that provider is installed. Typsastra never
falls through to another language that uses the same script.

## Same-script languages

English, French, and Spanish all use Latin. A project can select only one of
them for `Latn` at a time. Choosing French means English is not used as a
fallback, even if the English provider is installed. Change the Latin language
when you intentionally want to review the document with another dictionary.

Typst `lang` still controls Typst behavior such as hyphenation. It does not
change Typsastra's provider selection. The operating-system keyboard layout and
IME candidates are also independent.

Typsastra scans proven Typst prose before requesting analysis. The native
registry loads only the provider for a detected, resolved language; Typst code
syntax does not activate a dictionary.

## Terminology

Use the spelling context menu to accept a product or proper name globally, for
the project, or for the configured language family. Project terminology is
stored in `.typsastra/config.json`.

## User dictionary versus terminology

Both lists suppress spelling warnings and both feed word completion, but they
have different purposes.

Use the **user dictionary** for personal spellings that should be accepted in
every project. It is a global accepted-word list. A mixed-case entry such as
`LaTeX` is accepted only with that exact spelling; a lowercase entry is accepted
case-insensitively. The context menu adds the exact text you typed, not its
lowercase form.

Use **terminology** for names, brands, acronyms, identifiers, and domain terms
that belong to a project, language family, or your general writing. Terminology
has explicit scope:

- **Global terminology** applies in every project and language.
- **Project terminology** follows the current project.
- **Language terminology** applies only to that language family.

Terminology preserves case by default, so accepting `LaTeX` does not
automatically accept `latex` or `LATEX`. It is also preferred over generic
dictionary casing in correction suggestions.

In short:

- Use the **user dictionary** for personal words you always want accepted.
- Use **terminology** for scoped vocabulary whose meaning or capitalization
  should follow a project or language.

**Settings → Language → Dictionary and terminology files** shows the plain-text
storage and opens each file in your external editor:

- `user_dict.txt` stores the personal user dictionary.
- `terminology.txt` stores global terminology and `[en]`-style language sections.
- `.typsastra/terminology.txt` stores project terminology.

Write one entry per line. In terminology files, prefix a term with `~` to make
it case-insensitive. Existing JSON entries are migrated automatically, and
`settings.json` keeps a compatibility copy for older Typsastra versions.
Restart Typsastra after editing application files; reopen the project after
editing its terminology file.

Try `02-multilingual-writing/02-language-scoped-spellcheck` and
`04-research-projects/01-multilingual-article`.

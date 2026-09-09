# Document language tools

Typsastra keeps document language tools independent from document typography.
Fonts, visual scale, fallback order, and prepared font roles remain in Typst
source. Spellcheck and typing word-completion languages are portable project
metadata in `.typsastra/config.json`:

```json
{
  "scriptLanguages": [
    { "script": "Latn", "languageTag": "en-US" },
    { "script": "Arab", "languageTag": "ar" }
  ]
}
```

Assignments use ISO 15924 script codes and BCP 47 language tags. They apply to
the configured document/project rather than to a font or Typst style scope.

## Status-bar workflow

The language item in the status bar shows the script-language pair nearest the
caret. For example, Latin text configured as United States English displays
**English — United States**. Khmer text displays **Khmer**.

Select the item to open **Document Languages**. The dialog lists only ambiguous
scripts that can represent more than one available language, such as Latin or
Arabic. A script with exactly one catalog language resolves automatically, so
Khmer does not appear in the dialog even though its resolved language appears
in the status bar.

The complete provider catalog determines whether a script is ambiguous.
Installed providers determine whether its selected language is ready. A saved
selection that is not installed remains visible and is never silently replaced
or discarded.

Script detection follows Unicode script properties. Greek (`Grek`), Cyrillic
(`Cyrl`), Han (`Hani`), Hiragana (`Hira`), Katakana (`Kana`), Bopomofo (`Bopo`),
and Hangul (`Hang`) remain distinct. Kana is strong evidence of Japanese,
Bopomofo of a Chinese usage context, and Hangul of Korean, but a Han ideograph
alone does not encode whether its language is Japanese, Simplified Chinese,
Traditional Chinese, or Korean. Typsastra may identify Han near kana, Hangul, or
Bopomofo from that neighboring Unicode evidence, but reports pure Han as Han.
It does not inspect or trust user-authored Typst `lang` settings for detection.

## Routing contract

- An explicit project assignment wins for its script.
- A script with exactly one catalog language resolves automatically.
- A script with multiple possible languages requires an explicit assignment.
- An unavailable selected provider receives no analysis or completion.
- Typsastra never substitutes another same-script dictionary. French does not
  fall through to English merely because both use Latin.
- Typst `lang` scopes and the operating-system keyboard layout do not select
  Typsastra language providers.
- IME candidates remain owned by the operating system and are independent of
  Typsastra word completion.

Typsastra first detects matching language text in proven Typst prose. It then
sends an explicit provider ID to the native language registry. Dictionaries and
segmenters are loaded lazily only for detected, resolved languages; Typst syntax
such as `#set` does not load a Latin provider in an otherwise Khmer document.

One script can select one language at a time. A document that mixes English,
French, and Spanish cannot spellcheck all three simultaneously because all
three use Latin. Choose the document's principal Latin language and change the
project assignment when reviewing another language. Typst `#set text(lang: ...)`
continues to control Typst shaping, hyphenation, and localization, but it does
not reroute Typsastra's dictionary.

## Migration

Older `typsastra:document-scripts` and `typsastra:script-fonts` comments may
contain a `language` field. If a project has no `scriptLanguages` metadata,
Typsastra reads those fields once as migration input and saves the assignments
to `.typsastra/config.json`. Opening an older document does not rewrite its
Typst source. New typography writes omit language fields.

## Provider installation and terminology

Provider binaries and dictionaries are installed globally under Settings.
Installation makes a provider available but does not activate it for every
project. Use **Document Languages** from the status bar for ambiguous scripts.

Global and project terminology continue to recognize accepted names.
Language-family terminology is applied only when its matching resolved provider
owns the text being checked.

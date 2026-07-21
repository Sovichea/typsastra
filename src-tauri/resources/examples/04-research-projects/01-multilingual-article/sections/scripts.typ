= Document scripts

The main document assigns language tools to Latin, Khmer, and Arabic. That
single configuration remains active while this included file is edited.

== English, Khmer, and Arabic

This English sentance intentionally demonstrates spellcheck.

សួស្តី ពិភពលោក។

#text(dir: rtl)[مرحبًا بالعالم.]

== Same-script languages

#text(lang: "fr")[Le français conserve les règles linguistiques de Typst.]

#text(lang: "es")[El español conserva las reglas lingüísticas de Typst.]

The `lang` values above affect Typst, but they do not switch Typsastra's Latin
dictionary. Select French or Spanish for the Latin document-script entry when
reviewing one of those languages. This avoids silently accepting a typo because
another Latin-script dictionary happens to recognize the word.

== Terminology

Accepted global terminology applies throughout the document. Project terms
travel in `.typsastra/config.json`, while language-family terms are used only
by their configured provider.

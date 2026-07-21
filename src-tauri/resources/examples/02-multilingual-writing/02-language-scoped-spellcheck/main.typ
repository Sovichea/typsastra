#set document(title: "Document-script Language Tools")
#set page(margin: 24mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"MiSans Latin","script":"latin","scale":1,"language":"en-US"},{"family":"MiSans Khmer","script":"khmer","scale":1,"language":"km"},{"family":"MiSans Arabic","script":"arabic","scale":1,"language":"ar"}]
#set text(
  font: (
    (name: "MiSans Latin", covers: regex("\p{scx=Latin}")),
    (name: "MiSans Khmer", covers: regex("\p{scx=Khmer}")),
    (name: "MiSans Arabic", covers: regex("\p{scx=Arabic}")),
  ),
  size: 11pt,
)
// typsastra:typography:end
#set heading(numbering: "1.")

= Document-script language tools

The directive above assigns English to Latin, Khmer to Khmer, and Arabic to
Arabic. Spellcheck and word completion use those assignments directly.

== Three configured scripts

This English sentance contains an intentional typo.

សួស្តី ពិភពលោក។

#text(dir: rtl)[مرحبًا بالعالم.]

== Typst language remains independent

#text(lang: "fr")[Le français conserve le comportement linguistique de Typst,
mais Typsastra utilise toujours le fournisseur anglais assigné au script latin.]

Change the Latin language to French in the Typography toolbar when you want
Typsastra to review the Latin text with the French provider. It never silently
substitutes English or French for the other.

== Tools off

Remove a language selection while retaining its script font. Typsastra then
leaves that script untouched: no warning, spellcheck, or word completion.

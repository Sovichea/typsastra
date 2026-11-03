#set document(title: "Document Language Defaults", author: "Typsastra Examples")
#set page(paper: "a4", margin: 22mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1},{"family":"MiSans Khmer","script":"khmer","scale":1},{"family":"MiSans Arabic","script":"arabic","scale":1}]
#set text(
  font: (
    "New Computer Modern",
    "MiSans Khmer",
    "MiSans Arabic",
  ),
  size: 11pt,
)
// typsastra:typography:end
#set heading(numbering: "1.")
#set par(justify: true)

= Document language defaults

Typsastra separates document typography from language tools. Fonts decide how
text is shaped; script-language assignments decide which spellchecker and word
completion provider review it.

== Project assignments

This project starts with Latin set to English (United States). Khmer and Arabic
are available from the document-script metadata above, but their language tools
remain off until you assign a provider.

Open the `Aa` Typography toolbar and inspect the three rows:

#table(
  columns: (auto, 1fr, 1fr),
  inset: 7pt,
  stroke: 0.5pt + luma(185),
  table.header([Script], [Font], [Language]),
  [Latin], [New Computer Modern], [English (United States)],
  [Khmer], [MiSans Khmer], [Not assigned],
  [Arabic], [MiSans Arabic], [Not assigned],
)

The assignments belong to this project. They are stored in
`.typsastra/config.json` and travel with the project state, not with the source
file.

== English

This English paragraph is reviewed with the Latin provider. Changing the
project's Latin language to French changes the provider for this script; it does
not silently fall back to English when French is unavailable.

== Khmer

#text(lang: "km")[
  ភាសាខ្មែរមានតួអក្សរដែលភ្ជាប់គ្នា។ ការសរសេរត្រូវរក្សាលំដាប់តួអក្សរ
  និងសញ្ញាបានត្រឹមត្រូវ។
]

Assign Khmer to a Khmer provider in the `Aa` toolbar to review this paragraph.
Khmer is bundled, so the provider is available without a download.

== French

#text(lang: "fr")[
  Le français utilise des accents et des signes de ponctuation spécifiques. La
  vérification orthographique doit respecter la langue choisie.
]

Typst's `lang` parameter controls Typst language behavior. Typsastra's provider
routing remains a separate setting that you can inspect and change.

== Arabic

#text(lang: "ar", dir: rtl)[
  اللغة العربية تُكتب من اليمين إلى اليسار. يحافظ المحرر على ترتيب النص عند
  التحديد والنسخ.
]

First-class right-to-left editing remains a future milestone. This paragraph
exercises Typst and browser rendering, selection, and copy behavior.

== Global defaults for new projects

The `Aa` toolbar changes the current project. To choose the starting assignments
for future projects, open *Settings → Language → Default document languages*.
Latin defaults to English (United States). A new project inherits the global
defaults; an existing project keeps its own assignments.

Try changing the Latin default, create a blank project, and inspect its `Aa`
toolbar. Return the default to English (United States) when you are done so
later projects start from the documented baseline.

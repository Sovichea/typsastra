#set page(width: 20cm, height: 17cm, margin: (x: 1.2cm, top: 1cm, bottom: 1cm))

#set document(
  title: "Khmer Justification Comparison",
  author: "Typsastra Examples",
)

// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1},{"family":"MiSans Khmer","script":"khmer","scale":1}]
#set text(
  font: (
    "New Computer Modern",
    "MiSans Khmer",
  ),
  size: 10pt,
)
// typsastra:typography:end

#align(center)[
  #text(size: 14pt, weight: "bold", fill: rgb("#1d3557"))[
    Khmer Justification Comparison
  ]
]

#v(0.3em)

This example compares the same Khmer paragraph using three native Typst paragraph settings. Typsastra passes the source through unchanged; its Khmer language provider is used only for typing suggestions and spellcheck.

#v(0.8em)

#grid(
  columns: (1fr, 1fr, 1fr),
  gutter: 14pt,
  align: top,
  [
    #block(
      fill: rgb("#f8fafc"),
      inset: 9pt,
      radius: 4pt,
      stroke: rgb("#cbd5e1"),
      width: 100%,
      [
        #align(center)[#strong[1. ragged]]
        #v(0.35em)
        #set text(size: 8.8pt)
        #set par(justify: false)

        ភាសាខ្មែរគឺជាភាសាផ្លូវការរបស់ប្រទេសកម្ពុជា។ ប្រជាជនខ្មែរប្រើប្រាស់ភាសានេះក្នុងជីវិតប្រចាំថ្ងៃ ទាំងក្នុងវិស័យអប់រំ សេដ្ឋកិច្ច និងវប្បធម៌។ ការអភិវឌ្ឍប្រព័ន្ធបច្ចេកវិទ្យាព័ត៌មានវិទ្យាដែលគាំទ្រភាសាខ្មែរ ជាអាទិភាពដ៏សំខាន់ក្នុងការអភិវឌ្ឍប្រទេស។ និស្សិតសិក្សានៅសាកលវិទ្យាល័យភូមិន្ទភ្នំពេញតែងខិតខំប្រឹងប្រែង។
      ],
    )
  ],
  [
    #block(
      fill: rgb("#f0fdf4"),
      inset: 9pt,
      radius: 4pt,
      stroke: rgb("#86efac"),
      width: 100%,
      [
        #align(center)[#strong[2. default justify]]
        #v(0.35em)
        #set text(size: 8.8pt)
        #set par(justify: true)

        ភាសាខ្មែរគឺជាភាសាផ្លូវការរបស់ប្រទេសកម្ពុជា។ ប្រជាជនខ្មែរប្រើប្រាស់ភាសានេះក្នុងជីវិតប្រចាំថ្ងៃ ទាំងក្នុងវិស័យអប់រំ សេដ្ឋកិច្ច និងវប្បធម៌។ ការអភិវឌ្ឍប្រព័ន្ធបច្ចេកវិទ្យាព័ត៌មានវិទ្យាដែលគាំទ្រភាសាខ្មែរ ជាអាទិភាពដ៏សំខាន់ក្នុងការអភិវឌ្ឍប្រទេស។ និស្សិតសិក្សានៅសាកលវិទ្យាល័យភូមិន្ទភ្នំពេញតែងខិតខំប្រឹងប្រែង។
      ],
    )
  ],
  [
    #block(
      fill: rgb("#eff6ff"),
      inset: 9pt,
      radius: 4pt,
      stroke: rgb("#93c5fd"),
      width: 100%,
      [
        #align(center)[#strong[3. tuned justify]]
        #v(0.35em)
        #set text(size: 8.8pt)
        #set par(
          justify: true,
          justification-limits: (
            spacing: (min: 85%, max: 115%),
            tracking: (min: -0.8pt, max: 0pt),
          ),
        )

        ភាសាខ្មែរគឺជាភាសាផ្លូវការរបស់ប្រទេសកម្ពុជា។ ប្រជាជនខ្មែរប្រើប្រាស់ភាសានេះក្នុងជីវិតប្រចាំថ្ងៃ ទាំងក្នុងវិស័យអប់រំ សេដ្ឋកិច្ច និងវប្បធម៌។ ការអភិវឌ្ឍប្រព័ន្ធបច្ចេកវិទ្យាព័ត៌មានវិទ្យាដែលគាំទ្រភាសាខ្មែរ ជាអាទិភាពដ៏សំខាន់ក្នុងការអភិវឌ្ឍប្រទេស។ និស្សិតសិក្សានៅសាកលវិទ្យាល័យភូមិន្ទភ្នំពេញតែងខិតខំប្រឹងប្រែង។
      ],
    )
  ],
)

#v(0.75em)

#block(
  fill: rgb("#f8fafc"),
  inset: 8pt,
  radius: 4pt,
  width: 100%,
  [
    #set text(size: 8.5pt)
    - *Column 1*: Leaves the right edge ragged with `justify: false`.
    - *Column 2*: Uses Typst's default justified paragraph behavior.
    - *Column 3*: Bounds spacing and allows slight negative tracking through `justification-limits`.
  ],
)

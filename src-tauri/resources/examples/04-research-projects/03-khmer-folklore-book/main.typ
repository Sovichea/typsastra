#import "template.typ": khmer_folklore_book

// typsastra:document-scripts [{"family":"MiSans Khmer","script":"khmer","scale":1},{"family":"New Computer Modern","script":"latin","scale":1}]

#set document(
  title: "រឿងព្រេងនិទានខ្មែរ",
  author: "Typsastra Examples",
)

#show: khmer_folklore_book

#align(center + horizon)[
  #v(-2cm)
  #text(size: 20pt, weight: "bold", fill: rgb("#800020"))[រឿងព្រេងនិទានខ្មែរ]

  #v(1.5cm)
  #text(size: 10pt, style: "italic", fill: luma(100))[រក្សាសិទ្ធិដោយ Typsastra Examples]
]

#pagebreak()

#outline(title: "មាតិកា", indent: auto)

#pagebreak()

= សេចក្តីផ្តើម

រឿងព្រេងនិទានខ្មែរ គឺជារតនសម្បត្តិវប្បធម៌ដ៏មានតម្លៃ ដែលត្រូវបាននិទានតៗគ្នាចាប់តាំងពីបុរាណកាលមក។ រឿងនីមួយៗមិនត្រឹមតែផ្តល់នូវការកម្សាន្តសប្បាយប៉ុណ្ណោះទេ ប៉ុន្តែថែមទាំងបង្កប់នូវទស្សនវិជ្ជាជីវិត អប់រំសីលធម៌ និងការប្រុងប្រយ័ត្នខ្ពស់ក្នុងការរស់នៅក្នុងសង្គម។

នៅក្នុងសៀវភៅដ៏តូចនេះ យើងសូមលើកយករឿងព្រេងនិទានខ្មែរចំនួនប្រាំមកបង្ហាញ។ រឿងទាំងនេះមានទម្រង់ខ្លី ងាយអាន និងសមស្របសម្រាប់សាកល្បងឯកសារ Typst ពហុឯកសារ ជាមួយអត្ថបទខ្មែរដែលត្រូវការការតម្រឹមបន្ទាត់ និងការបំបែកពាក្យឱ្យបានត្រឹមត្រូវ។

#pagebreak()

#include "stories/01-rabbit-and-snail.typ"

#pagebreak()

#include "stories/02-crab-and-heron.typ"

#pagebreak()

#include "stories/03-three-sons.typ"

#pagebreak()

#include "stories/04-four-bald-men.typ"

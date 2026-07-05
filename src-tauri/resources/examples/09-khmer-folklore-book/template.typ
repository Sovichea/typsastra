#let khmer_digits(value) = {
  str(value)
    .replace("0", "០")
    .replace("1", "១")
    .replace("2", "២")
    .replace("3", "៣")
    .replace("4", "៤")
    .replace("5", "៥")
    .replace("6", "៦")
    .replace("7", "៧")
    .replace("8", "៨")
    .replace("9", "៩")
}

#let khmer_folklore_book(body) = {
  // typstry:typography:start
  set text(font: "MiSans Latin", size: 11pt)
  show regex("[\u1780-\u17ff]+"): set text(font: "MiSans Khmer", size: 1.05em)
  // typstry:typography:end

  set page(
    paper: "a5",
    margin: (top: 2.5cm, bottom: 2.5cm, left: 2cm, right: 2cm),
    header: align(right)[
      #text(size: 8.5pt, fill: luma(120))[រឿងព្រេងនិទានខ្មែរ]
    ],
    footer: context {
      let page_number = counter(page).get().first()
      align(center)[#text(size: 9pt)[#khmer_digits(page_number)]]
    },
  )

  set par(
    justify: true,
    leading: 0.8em,
    first-line-indent: 1.5em,
    justification-limits: (
      spacing: (min: 85%, max: 115%),
      tracking: (min: -0.8pt, max: 0pt),
    ),
  )

  show heading: set text(fill: rgb("#800020"))

  body
}

#set document(title: "Image Helper Chains", author: "Typsastra Examples")
#set page(margin: 22mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1}]
#set text(
  font: ("New Computer Modern",),
  size: 11pt,
)
// typsastra:typography:end
#set heading(numbering: "1.")

= Image helper chains <top>

Most real projects do not place every `image()` call directly in the document.
They wrap it in a helper so that sizing, captions, and styling stay consistent.
Typsastra follows a path forwarded through nested helpers when you click the
rendered image, and Draft Preview replaces the outermost call with a placeholder.

== A forwarded path and width

#let framed(src, width: 46%) = image(src, width: width)
#let cover(src, width: 46%) = framed(src, width: width)

#figure(
  cover("assets/typsastra-icon.png"),
  caption: [The call site that supplies this image is #raw("#cover(...)").],
) <nested-cover>

Switch the preview toolbar to *Normal*. Double-click the icon, or click it with
the inverse-sync modifier, and inspect the editor selection. It should land on
`#cover("assets/typsastra-icon.png")` above, not on the reusable `image(src)`
inside `framed`. Draft Preview resolves the same outer call and substitutes the
helper's `width` parameter into the placeholder.

== A second chain with an intermediate width

#let plate(src, width: 58%) = image(src, width: width)
#let wordmark(src) = plate(src, width: 58%)

#align(center)[
  #wordmark("assets/typsastra-wordmark.png")
]

Both calls forward the path and a layout parameter. Inverse sync also follows
renamed parameters, parameter defaults, named arguments, and helper calls in
reachable Typst files. Ambiguous calls are left at the original image
definition instead of guessing.

== Path portability

This example uses project-relative paths such as `assets/typsastra-icon.png`.
Typst also accepts `./assets/typsastra-icon.png`, but Typsastra underlines that
form and offers *Use root path* so references keep working when a file moves.
Try the quick fix in a scratch copy; keep this example's paths unchanged.

== What to try

- Click each image in Normal preview and confirm that inverse sync selects the
  helper call in this file.
- Switch to Draft preview and confirm that both images become placeholders
  without changing the source or exported PDF.
- Move the cursor onto a helper call and press `Alt+Enter` (`Option+Enter` on
  macOS) for forward sync.
- Temporarily change one path to start with `./` and use the path warning to
  inspect the quick fix.

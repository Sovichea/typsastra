#set document(title: "Preview Navigation")
#set page(margin: 24mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1}]
#set text(
  font: ("New Computer Modern",),
  size: 11pt,
)
// typsastra:typography:end
#set heading(numbering: "1.")

= Preview navigation <navigation-start>

Typsastra keeps ordinary Typst labels and links interactive in its PDF preview.
Put the editor cursor in this paragraph and press `Alt+Enter` on Windows or
Linux, or `Option+Enter` on macOS, to reveal it in the preview.

Jump to @internal-destination from this internal reference.

Visit #link("https://github.com/Sovichea/typsastra")[the Typsastra repository]
through this external web link, or use
#link("mailto:example@example.com")[#raw("example@example.com")] to inspect an email
link without sending anything.

#pagebreak()

== Internal destination <internal-destination>

Hold `Ctrl` on Windows or Linux, or `Command` on macOS, while the pointer is
inside the preview. Typsastra highlights clickable items currently in the
viewport and visually distinguishes internal references from external links.

Use the modified click on @navigation-start to return to the first section.
Ordinary preview clicks remain available for inverse sync to the corresponding
source.

The preview toolbar also accepts a page number, preserves the scroll position
across recompilation and project reopening, and provides a floating return-to-
first-page button after you scroll away from the beginning.

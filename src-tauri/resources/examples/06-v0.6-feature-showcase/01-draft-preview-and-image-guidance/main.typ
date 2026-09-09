#set document(title: "Draft Preview and Image Guidance")
#set page(margin: 22mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1}]
#set text(
  font: ("New Computer Modern",),
  size: 11pt,
)
// typsastra:typography:end
#set heading(numbering: "1.")

= Draft Preview and image guidance <draft-preview>

This document uses ordinary raster-image calls that remain portable Typst.
Compile it once in *Normal* mode, then switch the preview toolbar to *Draft*.
Draft Preview changes only Typsastra's private render mirror; the source and
exported PDF continue to use the original images.

== Standalone figure

#figure(
  image("assets/typsastra-wordmark.png", width: 82%),
  caption: [A directly placed image with an explicit width.],
) <wordmark>

In Draft mode, hover over the placeholder for Figure @wordmark. The hover card
uses a cached thumbnail and reports the original image dimensions and encoded
source size. Click the placeholder normally to inverse-sync to the `image`
call. Press `Alt+Enter` from the source call to move in the other direction.

#pagebreak()

== Image inside a clipped block

The following image is inside a block whose width, height, and clipping behavior
define the final layout:

#block(width: 100%, height: 52mm, clip: true, stroke: 0.8pt + luma(160))[
  #align(center + horizon)[
    #image("assets/typsastra-icon.png", width: 38%)
  ]
]

Draft Preview recognizes standalone image calls and common clipped-block
layouts. More unusual image composition can produce a placeholder whose size
or interaction differs from Normal Preview.

== Optimization diagnostics

Typsastra profiles all reachable raster images together and flags individual
sources whose decoded pixel workload is unusually expensive. A compressed
photograph can be small on disk but expand to hundreds of megabytes when
decoded.

To exercise the warning flow, replace one path above with your own very
high-resolution photograph. Check:

- the warning column beside its `image` call;
- the *Images* category in Problems;
- the warning triangle at the left of the preview toolbar.

Typsastra reports the issue but never resizes or re-encodes the source
automatically. Optimize a copy manually when the document does not need the
original resolution.

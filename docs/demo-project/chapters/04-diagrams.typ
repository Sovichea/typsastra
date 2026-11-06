// Fletcher examples: https://github.com/Jollywatt/typst-fletcher
// CeTZ example: https://github.com/cetz-package/cetz/blob/v0.5.2/gallery/karls-picture.typ

= Diagrams with Fletcher and CeTZ

Draft Preview can replace supported Fletcher diagrams and CeTZ canvases with
layout-preserving placeholders, just as it does for images. The examples below
are ordinary Typst source and render normally in Normal Preview.

#import "@preview/fletcher:0.5.8" as fletcher: diagram, edge, node
#import "@preview/cetz:0.5.2"

== A flowchart

#figure(
  diagram(
    node-stroke: 1pt,
    node((0, 0), [Start], corner-radius: 2pt, extrude: (0, 3)),
    edge("-|>"),
    node((0, 1), align(center)[
      Hey, wait,\ this flowchart\ is a trap!
    ], shape: fletcher.shapes.diamond),
    edge("d,r,u,l", "-|>", [Yes], label-pos: 0.1),
  ),
  caption: [A flowchart from Fletcher's README example.],
)

== A commutative diagram

#figure(
  diagram(cell-size: 15mm, $
    G edge(f, ->) edge("d", pi, ->>) & im(f) \
    G slash ker(f) edge("ur", tilde(f), "hook-->")
  $),
  caption: [The first isomorphism theorem from Fletcher's README example.],
)

== A CeTZ canvas

#figure(
  cetz.canvas(length: 3cm, {
    import cetz.draw: *

    set-style(
      mark: (fill: black, scale: 2),
      stroke: (thickness: 0.4pt, cap: "round"),
      angle: (
        radius: 0.3,
        label-radius: .22,
        fill: green.lighten(80%),
        stroke: (paint: green.darken(50%)),
      ),
      content: (padding: 1pt),
    )

    grid((-1.5, -1.5), (1.4, 1.4), step: 0.5, stroke: gray + 0.2pt)
    circle((0, 0), radius: 1)

    line((-1.5, 0), (1.5, 0), mark: (end: "stealth"))
    content((), $x$, anchor: "west")
    line((0, -1.5), (0, 1.5), mark: (end: "stealth"))
    content((), $y$, anchor: "south")

    for (x, ct) in ((-1, $ -1 $), (-0.5, $ -1/2 $), (1, $ 1 $)) {
      line((x, 3pt), (x, -3pt))
      content((), anchor: "north", ct)
    }
    for (y, ct) in ((-1, $ -1 $), (-0.5, $ -1/2 $), (0.5, $ 1/2 $), (1, $ 1 $)) {
      line((3pt, y), (-3pt, y))
      content((), anchor: "east", ct)
    }

    cetz.angle.angle((0, 0), (1, 0), (1, calc.tan(30deg)),
      label: text(green, [#sym.alpha]))
    line((0, 0), (1, calc.tan(30deg)))

    set-style(stroke: (thickness: 1.2pt))
    line((30deg, 1), ((), "|-", (0, 0)), stroke: (paint: red), name: "sin")
    content(("sin.start", 50%, "sin.end"), text(red)[$sin alpha$])
    line("sin.end", (0, 0), stroke: (paint: blue), name: "cos")
    content(("cos.start", 50%, "cos.end"), text(blue)[$cos alpha$], anchor: "north")
    line((1, 0), (1, calc.tan(30deg)), name: "tan", stroke: (paint: orange))
    content("tan.end", $text(#orange, tan alpha) = text(#red, sin alpha) / text(#blue, cos alpha)$, anchor: "west")
  }),
  caption: [Karl's picture from the CeTZ gallery: sine, cosine, and tangent on the unit circle.],
)

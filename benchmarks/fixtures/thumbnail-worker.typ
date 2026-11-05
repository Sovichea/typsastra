// Fletcher diagram pages used to measure dedicated Tinymist thumbnail workers.
// Six pages match the app's current diagram-thumbnail chunk size.
#import "@preview/fletcher:0.5.8" as fletcher: diagram, edge, node
#set page(width: auto, height: auto, margin: 0pt)
#set text(size: 14pt)

#for index in range(6) {
  if index > 0 { pagebreak() }
  diagram(
    node((0, 0), $D^r(M)$),
    node((1, 0), $D^r(N)$),
    edge((0, 0), (1, 0), "->", $g mapsto h g h^(-1)$),
  )
}

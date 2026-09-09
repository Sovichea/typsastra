#import "template.typ": project
#import "import.typ" as imp

// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1},{"family":"MiSans Khmer","script":"khmer","scale":1}]

#show: project.with(
  title: imp.project-name + " README Documentation",
  authors: imp.authors,
  logo: "assets/typsastra-icon.png",
)

#include "readme.typ"
#include "chapters/research-workflow.typ"
#include "chapters/khmer-research.typ"

#bibliography("refs.bib", style: "apa")

#import "template.typ": project
#import "import.typ" as imp

#show: project.with(
  title: imp.project-name + " README Documentation",
  authors: imp.authors,
  logo: "assets/typstry-icon.png",
)

#include "readme.typ"

#bibliography("refs.bib", style: "apa")

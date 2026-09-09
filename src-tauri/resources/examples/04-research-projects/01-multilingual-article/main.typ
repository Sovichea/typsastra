#import "template.typ": multilingual-article

// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1},{"family":"MiSans Khmer","script":"khmer","scale":1},{"family":"MiSans Arabic","script":"arabic","scale":1}]

#show: multilingual-article.with(
  title: "A Multilingual Article",
  author: "Your Name",
)

#include "sections/introduction.typ"
#include "sections/scripts.typ"

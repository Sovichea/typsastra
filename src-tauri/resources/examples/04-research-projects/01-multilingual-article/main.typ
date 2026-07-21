#import "template.typ": multilingual-article

// typsastra:document-scripts [{"family":"MiSans Latin","script":"latin","scale":1,"language":"en-US"},{"family":"MiSans Khmer","script":"khmer","scale":1,"language":"km"},{"family":"MiSans Arabic","script":"arabic","scale":1,"language":"ar"}]

#show: multilingual-article.with(
  title: "A Multilingual Article",
  author: "Your Name",
)

#include "sections/introduction.typ"
#include "sections/scripts.typ"

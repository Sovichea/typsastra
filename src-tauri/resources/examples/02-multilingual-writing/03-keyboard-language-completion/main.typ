#set document(title: "Document-script Word Completion")
#set page(margin: 24mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1},{"family":"MiSans Khmer","script":"khmer","scale":1}]
#set text(
  font: (
    "New Computer Modern",
    "MiSans Khmer",
  ),
  size: 11pt,
)
// typsastra:typography:end

= Document-script word completion

Place the cursor after an English or Khmer prefix and request completion.
Typsastra selects the provider assigned to the prefix's script. It does not
inspect the operating-system keyboard layout.

English prefix: doc

Khmer prefix: ខ្មែ

Turn the language off for either script in the Typography toolbar to disable
Typsastra completion for that script. IME candidate composition remains
independent.

#set document(title: "Diacritic-Aware Search")
#set page(margin: 22mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1},{"family":"Khmer OS Content","script":"khmer","scale":1}]
#set text(
  font: ("New Computer Modern", "Khmer OS Content"),
  size: 11pt,
)
// typsastra:typography:end
#set heading(numbering: "1.")

= Diacritic-aware editor search

This file tests Typsastra's _Match diacritics_ search option. Open the search
panel with `Ctrl+F` on Windows/Linux or `Cmd+F` on macOS. The option is enabled
by default and is independent from _Match case_.

== Exact matching

With _Match diacritics_ enabled, search for `cafe`. Compare the highlighted
sample rows: the unaccented spelling matches, while the accented spelling does
not.

#table(
  columns: (1fr, 2fr),
  inset: 7pt,
  stroke: 0.5pt + luma(190),
  [*Source form*], [*Search sample*],
  [Unaccented], [cafe],
  [Accented], [café],
)

Disable _Match diacritics_ and repeat the same search. Both sample spellings
should now match.

== Canonically equivalent text

The next two words look identical. The first uses a precomposed accented
character; the second uses a base letter followed by a combining accent.
Searching for `résumé` with _Match diacritics_ enabled should find both forms
and select each complete word.

#table(
  columns: (1fr, 2fr),
  inset: 7pt,
  stroke: 0.5pt + luma(190),
  [*Encoding*], [*Search sample*],
  [Precomposed], [résumé],
  [Decomposed], [résumé],
)

== Match case remains independent

Search for `angstrom` with both _Match case_ and _Match diacritics_ disabled.
All three sample rows should match. Enable _Match case_ to restrict results by
capitalization, or enable _Match diacritics_ to distinguish the accented form.

#table(
  columns: (1fr, 2fr),
  inset: 7pt,
  stroke: 0.5pt + luma(190),
  [*Variation*], [*Search sample*],
  [Lowercase], [angstrom],
  [Capitalized], [Angstrom],
  [Accented], [ångström],
)

== Complex-script marks remain meaningful

Turning off _Match diacritics_ ignores generic accent marks used by scripts
such as Latin and Greek. It does not remove Khmer, Lao, or Arabic marks, where
those marks can be part of a meaningful orthographic sequence.

#table(
  columns: (1fr, 1fr, 1fr),
  inset: 7pt,
  stroke: 0.5pt + luma(190),
  [*Script*], [*Without mark*], [*With mark*],
  [Khmer], [ក], [កំ],
  [Lao], [ກ], [ກິ],
  [Arabic], [علم], [عَلَم],
)

Try searching for a complete marked form, such as `កំ` or `عَلَم`, with the
option disabled. Typsastra should still require those script-specific marks.

== Wrapped matches and scrollbar navigation

Search for `navigation` in this deliberately long sentence and narrow the
editor until it wraps across several visual lines: navigation markers should
remain aligned with the text even when navigation appears near a wrap boundary.

Select one occurrence of `navigation` directly in the editor. Typsastra should
find the other exact occurrences without treating whitespace-only selections as
queries. Blue information markers appear in the editor scrollbar for every
match. Select a marker and confirm that the editor reveals its exact source
range rather than only the containing line.

The active result uses a distinct theme-aware highlight. Moving with **Next** or
**Previous** changes that active result without adding a second highlight over
the currently selected text.

== Regular-expression searches

Enable _Regexp_. The _Match diacritics_ option becomes unavailable because a
regular expression must remain authoritative. For example, the expression
`café|cafe` explicitly chooses the two accepted spellings.

== Replacement check

Disable _Regexp_ and _Match diacritics_, search for `facade`, and use Replace
on the sample `façade`. The complete accented word should be replaced without
leaving a combining mark behind. Undo afterward to restore the fixture.

#quote(block: true)[façade]

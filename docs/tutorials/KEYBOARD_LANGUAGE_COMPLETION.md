# Document-script word completion

Typsastra word completion no longer follows the operating-system keyboard
layout. Keyboard detection was unreliable across platforms and could conflict
with users who type several languages through one layout.

Completion now follows the language assigned to the matching script in the
`typsastra:document-scripts` directive. Open the `Aa` Typography toolbar,
select a language for the script, and enable **Typing word suggestions** in
Settings. No assignment means no Typsastra completion for that script.

IME candidate windows remain independent and always take priority while text
composition is active.

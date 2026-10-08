= Plan the research workflow

Start by keeping the project structure legible. Place the configured entry point
at `main.typ`, and use included files for sections that benefit from independent
editing or review.

== A repeatable sequence

1. Establish the question and the audience.
2. Gather evidence and record sources.
3. Draft sections in the order that best supports the argument.
4. Compile the main document and review the rendered pages.

The preview stays attached to `main.typ` while a chapter is active in the
editor. Source navigation can move between a rendered location and its Typst
source without giving each chapter an unrelated preview session.

== Keep source portable

Relative includes and project-local assets make a project easier to move,
review, and share. Typsastra's generated preview data is kept outside this
source tree.

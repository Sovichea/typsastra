# Khmer folklore book

Set `main.typ` as the project main file. This multi-file Khmer book exercises
long-form navigation, included stories, an outline, language tools, and bounded
PDF preview rendering. Generated preview/cache files are not part of the bundled
example and must not be exported.

Its `typsastra:document-scripts` directive places MiSans Khmer before New
Computer Modern because Khmer is the dominant script. The template applies the
same ordinary ordered Typst fallback to the complete book.

For a memory-constrained or very long session, try **Low-Memory Mode** from the
preview controls. Typsastra generates the PDF and a cached navigation index with
a one-shot compiler process, then releases the resident compiler. Manual
forward sync and PDF-click inverse sync remain available through the index.

Tutorials:
<https://github.com/Sovichea/typsastra/blob/main/docs/tutorials/LONG_DOCUMENT_WORKFLOW.md>
and
<https://github.com/Sovichea/typsastra/blob/main/docs/tutorials/LOW_MEMORY_MODE.md>

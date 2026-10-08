= Write across scripts

Typsastra treats script-aware editing as more than a font choice. Cursor
movement, deletion, selection, spellcheck, and completion can follow the
boundaries of the language being written.

== A Khmer sample

The following short excerpt is included to demonstrate complex-script content
inside an ordinary multi-file Typst project:

កម្ពុជាមានប្រវត្តិសាស្ត្រ វប្បធម៌ និងអក្សរសាស្ត្រដ៏សម្បូរបែប។

Use the caret and word boundaries in the editor to explore language-aware
movement and spelling support.

== Export complex-script PDFs

For an optional export comparison, compile this multilingual document with the
Enhanced Unicode Engine. It aims to improve logical Unicode text extraction for
complex-script PDFs, including Khmer and mixed-script text. The engine is
experimental and applies only to explicit PDF export; Tinymist remains in charge
of live preview, diagnostics, completion, and source synchronization.

Enable **Enhanced Unicode PDF engine** under **Settings → Developer**, then
choose that engine when exporting. Compare extracted text as well as visual
rendering; this sample does not require the engine for ordinary preview.

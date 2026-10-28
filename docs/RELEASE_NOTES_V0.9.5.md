# Typsastra v0.9.5 release notes

Typsastra v0.9.5 focuses on everyday usability and app performance, especially
file switching, multi-file editing, and reliable preview navigation.

## Faster editing and preview reuse

- Reduced file-opening and tab-switching delays, fixed activation races, and
  ensured newly opened tabs start at the top of the document.
- Returning from images, standalone PDFs, non-project files, or Image/Table Tools
  restores the existing live preview without unnecessary compilation. Unsaved
  source edits keep their outdated status instead of triggering compilation on
  navigation.
- Auto-save triggers compilation in On save mode.
- PDF generations remain available while preview readers still use them.

## More reliable previews

- Preserve the mouse-scrolled viewport across main/include tabs, recompilation,
  and project reopen, including horizontal panning.
- Keep the completed viewport visible while its replacement renders. Repair
  stale or blank visible pages and protect them from background-page eviction.
- Monitor external source changes independently of compilation. A persistent
  banner overlays the preview without shifting its layout and indicates when
  the rendered document is outdated, compiling, or failed.
- Undoing edits clears the outdated indicator when the source matches the
  preview again. Files outside the main preview do not show its status banner.
- The preview error panel is configurable and off by default, leaving the last
  successful preview visible. Errors remain in Logs. LSP source errors disable
  manual Recompile actions until the errors are resolved.
- Open in External Viewer opens the displayed PDF, including cached live PDFs.

## Navigation and workspace usability

- Search the live preview and highlight matches without moving the source
  editor automatically. Click a match to use inverse sync where supported.
  Tinymist live previews do not provide Enhanced Unicode Engine logical-unit
  search; complex-script search retains that limitation.
- Use touchscreen pinch or Ctrl/Cmd + mouse wheel to zoom across previews and
  Image/Table Tools. Ctrl/Cmd-wheel increments are configurable, defaulting to
  10%; touchscreen pinch uses 5% and manual buttons use 25%. Touchpad pinch
  remains unsupported.
- Configure landscape page scaling, with a default increase of 30%.
- Undocked previews add a draggable outline navigator and remember their window
  size per project.
- Remove individual recent projects or clear the list. Long project names are
  truncated, and context-menu font sizing is consistent across the app.
- Unused bindings appear in the gutter and scrollbar; informational image
  warnings also appear in the scrollbar.

## Compatibility

v0.9.5 does not change the `.typsastra` project archive schema. Existing projects
remain compatible.

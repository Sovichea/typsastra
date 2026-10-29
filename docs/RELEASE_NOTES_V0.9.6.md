# Typsastra v0.9.6 release notes

Typsastra v0.9.6 improves language-provider compatibility, provider management,
and everyday editing reliability, with further preview and diagnostic fixes.

## Language providers

- Load legacy-encoded Hunspell dictionaries and support additional LibreOffice
  spelling variants.
- Find missing providers directly from document-language settings: open the
  provider catalog filtered to the selected language.
- Preserve the language selection while managing providers.
- Stabilize provider row layout and align download/remove actions consistently.

## Editing and preview reliability

- Wrap the whole selected range and limit automatic bracket closing.
- Paste text when a browser clipboard event does not contain a text payload.
- Keep preview freshness and source synchronization scoped to the configured
  main document.
- Clear stale LSP errors when source revisions change, avoiding outdated error
  state after edits.

## Compatibility

v0.9.6 does not change the `.typsastra` project archive schema. Existing projects
remain compatible. The planned v0.10 search, navigation, and recovery features
are described in the [implementation plan](V0_10_0_IMPLEMENTATION_PLAN.md) and
are not part of this release.

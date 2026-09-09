# Installing language providers

Open **Settings → Editor → Language providers**. English and Khmer are bundled;
other catalog providers can be downloaded or removed independently.

Installation is global, but language selection is per project. After installing
an optional provider:

1. open a Typst document;
2. select the language item in the status bar;
3. choose the language for its ambiguous script in **Document Languages**;
4. select **Apply**.

The selection is stored in portable `.typsastra/config.json`. Scripts with one
available language resolve automatically and are omitted from the dialog. An
installed provider that is not selected for an ambiguous script does not
spellcheck or complete that script. A selected provider is loaded lazily only
when its language is detected in Typst prose.

Support labels retain their existing meaning: Basic provides dictionary
spellcheck, Enhanced adds language-specific boundaries, and Deep may add
segmentation, completion, and a tested script-editing policy.

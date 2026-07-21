# Installing language providers

Open Settings → Editor → Language Providers. English and Khmer are bundled;
other catalog providers can be downloaded or removed independently.

Installation is global, but activation is per document. After installation:

1. open the `Aa` Typography toolbar;
2. add the script that the provider supports;
3. select the provider's language for that script;
4. apply the configuration to the main document.

The toolbar stores the selection in `typsastra:document-scripts`. A provider
that is installed but not assigned does not spellcheck or complete text. A
script with **Language tools off** is intentionally ignored.

Support labels retain their existing meaning: Basic provides dictionary
spellcheck, Enhanced adds language-specific boundaries, and Deep may add
segmentation, completion, and a tested script-editing policy.

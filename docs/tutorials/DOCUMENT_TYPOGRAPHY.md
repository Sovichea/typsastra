# Configure document typography

Use Document Typography for portable document settings. Use Font Tools only when an existing font needs a machine-local optical adjustment.

## Set ordinary document fonts

1. Open a Typst document related to the configured main file.
2. Select **Document Typography** from the `Aa` toolbar.
3. Add the font families the document should use.
4. Drag them into Typst fallback order.
5. Set the base text size.
6. Optionally assign a language provider to a writing script.
7. Choose **Apply to document**.

Typsastra writes an ordinary `#set text` rule. You can continue editing it by hand.

Font order matters. If a Khmer family also contains Latin glyphs, placing it before the Latin family may prevent the later family from being used. Choose the order that best matches the document's dominant typography and inspect the compiled result.

## Prepare an optically adjusted family

1. Open **Font Tools** from the sidebar.
2. Select the source family.
3. Enter a whole percentage, such as `95` or `105`.
4. Edit the specimen to include the scripts and glyphs you care about.
5. Inspect the compiled specimen preview.
6. Choose **Prepare font**.
7. Choose **Activate in project**.

For example, preparing Moul at 95% creates the family `Moul 95`. It can then be selected in Document Typography or used directly:

```typst
#text(font: "Moul 95")[Heading text]
```

To apply it quickly, select existing text in the editor and choose **Apply to selection** in Font Tools.

## Enable language tools

Assign a provider in Document Typography only when the script should receive spellcheck and word completion. Typsastra stores language routing separately from the font stack:

```typst
// typsastra:document-languages [{"script":"latin","language":"en-US"},{"script":"khmer","language":"km"}]
```

Changing fonts does not silently change language providers, and changing a provider does not rewrite the document's font choices.

## Work with private fonts

Use **Workspace private fonts** in Document Typography when a project needs a font that should not be installed system-wide. Use a folder inside the workspace for a portable relative configuration, or an external folder for a machine-local absolute configuration.

Typsastra never copies these fonts into project exports. Confirm that you have permission to use and share every font dependency.

## Move a legacy document

When a legacy main file contains scale factors in Typsastra metadata, accept the migration prompt to create named prepared families and rewrite the source to the new model. Review the generated aliases in Font Tools afterward.

For storage, format, cache, and portability details, see [Document typography and Font Tools](../DOCUMENT_TYPOGRAPHY.md).

# Markdown notes

This file is an editable Markdown preview fixture. It is not compiled by Typst
and does not change the configured Typst main file.

## Common GFM content

- [x] Headings, lists, emphasis, and tables render in the selected theme.
- [x] Local images remain inside the workspace resource boundary.
- [ ] Edit this item and confirm that the preview updates after a short delay.

| Surface | Compiler | Existing PDF session |
| --- | --- | --- |
| Markdown | Sanitized HTML renderer | Preserved |
| Typst | Tinymist and PDF renderer | Active |

> Markdown is useful for project notes and documentation while ordinary Typst
> remains the authoritative typesetting source.

```typst
#text(lang: "km")[ឯកសារពហុភាសា]
```

Mixed scripts remain selectable: English, Français, Español, ខ្មែរ, ລາວ, العربية.

## Workspace resources

The image below is loaded from another bundled example without leaving this
workspace:

![Typsastra icon](../01-draft-preview-and-image-guidance/assets/typsastra-icon.png)

Hold `Ctrl` on Windows/Linux or `Command` on macOS when opening this local
[example guide](../README.md).

Remote images are intentionally not fetched automatically:

![Blocked remote example](https://example.invalid/remote-image.png)

Raw scripts and event handlers are sanitized rather than executed:

<script>document.body.textContent = "This must never run";</script>


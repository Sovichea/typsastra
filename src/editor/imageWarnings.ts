import { RangeSet, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { GutterMarker, gutter } from "@codemirror/view";
import { createAppIcon } from "../ui/icons";
import { editorDiagnosticsStateField } from "./diagnostics";

export type ImageOptimizationWarning = {
  from: number;
  to: number;
  message: string;
  imagePath?: string;
  /**
   * `warning` marks an image the optimizer recommends changing; `info` marks an
   * ordinary image that can still be opened in Image Tools to shrink the PDF.
   */
  severity?: "warning" | "info";
};

export const setImageOptimizationWarningsEffect = StateEffect.define<ImageOptimizationWarning[]>({
  map(warnings, mapping) {
    return warnings.map((warning) => ({
      ...warning,
      from: mapping.mapPos(warning.from),
      to: mapping.mapPos(warning.to)
    }));
  }
});

export class ImageOptimizationMarker extends GutterMarker {
  constructor(
    readonly message: string,
    readonly imagePath?: string,
    readonly severity: "warning" | "info" = "warning",
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof ImageOptimizationMarker
      && other.message === this.message
      && other.imagePath === this.imagePath
      && other.severity === this.severity;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "cm-image-optimization-marker";
    marker.appendChild(
      this.severity === "info"
        ? createAppIcon("info", { size: 15 })
        : createAppIcon("triangleAlert", { size: 17 })
    );
    if (this.severity === "info") marker.classList.add("cm-image-info-marker");
    marker.title = this.message;
    marker.setAttribute("aria-label", this.message);
    if (this.imagePath) {
      marker.classList.add("clickable");
      marker.title = `${this.message}\n\nClick to open this image in Image Tools.`;
      marker.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        window.dispatchEvent(new CustomEvent("typsastra-open-image-tool", {
          detail: { imagePath: this.imagePath },
        }));
      });
    }
    return marker;
  }
}

class LspErrorMarker extends GutterMarker {
  constructor(readonly message: string) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof LspErrorMarker && other.message === this.message;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    const icon = createAppIcon("circleX", { size: 17 });
  
    marker.className = "cm-lsp-error-marker";
    marker.title = this.message;
    marker.setAttribute("aria-label", this.message);
  
    icon.style.color = "#f14c4c";
  
    Object.assign(marker.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      verticalAlign: "middle",
      color: "#f14c4c"
    });
  
    marker.appendChild(icon);
  
    return marker;
  }
}

class RelatedErrorMarker extends GutterMarker {
  constructor(readonly message: string) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof RelatedErrorMarker && other.message === this.message;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "cm-related-error-marker";
    marker.appendChild(createAppIcon("circleX", { size: 15 }));
    marker.title = this.message;
    marker.setAttribute("aria-label", this.message);
    return marker;
  }
}

class ImageOptimizationSpacerMarker extends GutterMarker {
  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "cm-image-optimization-marker-spacer";
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }
}

export const imageOptimizationWarningField = StateField.define<RangeSet<GutterMarker>>({
  create() {
    return RangeSet.empty;
  },

  update(markers, transaction) {
    let next = markers.map(transaction.changes);

    for (const effect of transaction.effects) {
      if (!effect.is(setImageOptimizationWarningsEffect)) continue;

      const byLine = new Map<number, {
        messages: string[];
        imagePath?: string;
        severity: "warning" | "info";
      }>();

      for (const warning of effect.value) {
        const position = Math.max(0, Math.min(warning.from, transaction.state.doc.length));
        const line = transaction.state.doc.lineAt(position);
        const entry = byLine.get(line.from) ?? {
          messages: [],
          imagePath: warning.imagePath,
          severity: warning.severity ?? "warning",
        };
        if (!entry.messages.includes(warning.message)) entry.messages.push(warning.message);
        entry.imagePath ??= warning.imagePath;
        if ((warning.severity ?? "warning") === "warning") entry.severity = "warning";
        byLine.set(line.from, entry);
      }

      const builder = new RangeSetBuilder<GutterMarker>();

      for (const [lineFrom, entry] of [...byLine].sort((left, right) => left[0] - right[0])) {
        builder.add(
          lineFrom,
          lineFrom,
          new ImageOptimizationMarker(entry.messages.join("\n\n"), entry.imagePath, entry.severity)
        );
      }

      next = builder.finish();
    }

    return next;
  }
});

const sharedWarningGutter = gutter({
  class: "cm-warningGutter",

  markers(view) {
    const imageMarkers = view.state.field(imageOptimizationWarningField);
    const diagnostics = view.state.field(editorDiagnosticsStateField, false) ?? [];

    const byLine = new Map<number, {
      severity: "error" | "related" | "image";
      message: string;
      imagePath?: string;
      imageSeverity?: "warning" | "info";
    }>();

    imageMarkers.between(0, view.state.doc.length, (from, _to, marker) => {
      if (marker instanceof ImageOptimizationMarker) {
        byLine.set(from, {
          severity: "image",
          message: marker.message,
          imagePath: marker.imagePath,
          imageSeverity: marker.severity,
        });
      }
    });

    for (const diagnostic of diagnostics) {
      if (diagnostic.severity !== "error" && diagnostic.severity !== "related") continue;

      const position = Math.max(0, Math.min(diagnostic.from, view.state.doc.length));
      const line = view.state.doc.lineAt(position);
      const existing = byLine.get(line.from);

      if (existing?.severity === "error" || existing?.severity === diagnostic.severity) {
        if (!existing.message.includes(diagnostic.message)) {
          existing.message += `\n\n${diagnostic.message}`;
        }
      } else if (diagnostic.severity === "error" || !existing || existing.severity === "image") {
        byLine.set(line.from, {
          severity: diagnostic.severity,
          message: diagnostic.message
        });
      }
    }

    const builder = new RangeSetBuilder<GutterMarker>();

    for (const [lineFrom, marker] of [...byLine].sort((left, right) => left[0] - right[0])) {
      builder.add(
        lineFrom,
        lineFrom,
        marker.severity === "error"
          ? new LspErrorMarker(marker.message)
          : marker.severity === "related"
            ? new RelatedErrorMarker(marker.message)
            : new ImageOptimizationMarker(marker.message, marker.imagePath, marker.imageSeverity)
      );
    }

    return builder.finish();
  },

  initialSpacer: () => new ImageOptimizationSpacerMarker()
});

export const imageOptimizationWarningsExtension: Extension = [
  imageOptimizationWarningField,
  sharedWarningGutter
];

import { confirm, message } from "@tauri-apps/plugin-dialog";
import { fileNameFromPath } from "../platform/paths";
import {
  documentScriptsEdit,
  parseTypographyBlock,
  typographyEdit,
  type DocumentTypography,
} from "../editor/documentTypography";
import type { TypographyController } from "./typographyController";
import { t } from "../i18n";

export interface PinnedMainTypographyDependencies {
  typography(): TypographyController;
  workspaceRootPath(): string | null;
  readWorkspaceText(path: string): Promise<string>;
  writeWorkspaceText(path: string, text: string): Promise<void>;
  appendLog(kind: "error", source: "typography", message: string): void;
}

/** Owns the confirmation and preparation workflow required before pinning a Typst main file. */
export class PinnedMainTypographyController {
  constructor(private readonly dependencies: PinnedMainTypographyDependencies) {}

  async prepare(path: string): Promise<DocumentTypography | null | false> {
    const typographyController = this.dependencies.typography();
    try {
      let source = await this.dependencies.readWorkspaceText(path);
      let config = typographyController.fromText(source);
      if (config) {
        const unsupportedInternalScale = await typographyController.unsupportedInternalScaleError(config);
        if (unsupportedInternalScale) {
          this.dependencies.appendLog("error", "typography", unsupportedInternalScale.message);
          await message(unsupportedInternalScale.message, {
            title: t("Unsupported Built-in Font Scale"),
            kind: "error",
          });
          config = typographyController.resetUnsupportedInternalScales(config, unsupportedInternalScale.fonts);
          const edit = parseTypographyBlock(source)
            ? typographyEdit(source, config)
            : documentScriptsEdit(source, config.fonts);
          source = this.applyEdit(source, edit);
          await this.dependencies.writeWorkspaceText(path, source);
        }
      }
      if (!this.dependencies.workspaceRootPath()) return await typographyController.effective(path, source) ?? config;
      const typography = config ?? { baseSizePt: 11, fonts: [] };
      const status = await typographyController.scaledFontSetStatus(typography);
      if (!status.updateRequired) return await typographyController.effective(path, source) ?? config;

      const scaledFonts = config?.fonts.filter(font => Math.abs(font.scale - 1) > 0.0001) ?? [];
      if (scaledFonts.length > 0 && status.generationRequired) {
        const outsideFineRange = typographyController.scaleRangeWarning(typography) !== null;
        const variantWarning = typographyController.variantLimitWarning(status);
        const accepted = await confirm(
          t`${fileNameFromPath(path)} contains a document typography directive that requires local font scaling:\n\n${scaledFonts.map(font => `${font.family}: ${font.scale}×`).join("\n")}\n\nTypsastra will generate the fonts in its private global cache before setting this file as main. No font data will be written into the project. Font scaling is intended for fine optical adjustment${outsideFineRange ? "; one or more values also exceed the recommended ±10% range, where accurate representation is not guaranteed and varies between fonts" : ""}.${variantWarning ? `\n\n${variantWarning}` : "\n\nPrepare the fonts and continue?"}`,
          {
            title: t("Prepare Document Fonts?"),
            kind: "warning",
            okLabel: t("Prepare and Continue"),
            cancelLabel: t("Cancel"),
          },
        );
        if (!accepted) return false;
      }

      await typographyController.prepareMainFileFonts(typography);
      return await typographyController.effective(path, source) ?? config;
    } catch (error) {
      this.dependencies.appendLog(
        "error",
        "typography",
        `Could not prepare typography for ${fileNameFromPath(path)}: ${String(error)}`,
      );
      await message(String(error), { title: t("Unable to Prepare Document Fonts"), kind: "error" });
      return false;
    }
  }

  private applyEdit(text: string, edit: { from: number; to: number; insert: string }): string {
    return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  }
}

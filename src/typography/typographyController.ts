import { invoke } from "@tauri-apps/api/core";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { dirname, join } from "@tauri-apps/api/path";
import {
  parseDocumentScripts,
  parseTypographyBlock,
  documentScriptsEdit,
  typographyEdit,
  typographyScaleExceedsFineAdjustment,
  unsupportedTypstInternalFontScales,
  type DocumentScriptFont,
  type DocumentTypography,
} from "../editor/documentTypography";
import {
  effectiveTemplateTypography,
  findLocalTemplateApplication,
} from "../editor/templateTypography";
import { relativeFilePath } from "../platform/paths";
import { filePathKey } from "../platform/paths";
import { participatesInPreviewCompilation } from "../preview/previewPolicy";
import { t } from "../i18n";

export interface FontVariantLimitWarning {
  family: string;
  cachedVariants: number;
  requestedScale: number;
  recommendedLimit: number;
}

export interface ScaledFontSetStatus {
  updateRequired: boolean;
  generationRequired: boolean;
  variantLimitWarnings: FontVariantLimitWarning[];
}

export interface TypographyControllerPort {
  getWorkspaceRootPath(): string | null;
  readWorkspaceText(path: string): Promise<string>;
  logWarning(message: string): void;
  getActiveFilePath(): string | null;
  getActiveDocumentText(): string;
  dispatchDocumentEdit(edit: { from: number; to: number; insert: string }, userEvent: string): void;
  synchronizeDocumentTypography(config: DocumentTypography): void;
  isPinnedMainFile(path: string): boolean;
  getPinnedMainFilePath(): string | null;
  isPreviewImported(): boolean;
  getPreviewDebounceMs(): number;
  getPreviewRootPath(): string | null;
  getPreviewMainPath(): string | null;
  isPreviewStandalone(): boolean;
  isLargePreviewBlocked(): boolean;
  hasLspClient(): boolean;
  restartTinymistSession(status: string): Promise<void>;
  restoreActiveDocumentAfterRestart(): Promise<void>;
  refreshActivePreviewRoot(force: boolean): Promise<void>;
  updatePinnedMain(path: string | null, force: boolean): Promise<boolean>;
  recheckActiveDocumentAfterPin(text: string): Promise<void>;
  resetSourceMap(): void;
  setPreviewLoading(message: string): void;
  appendLog(kind: "info" | "warning" | "error", source: string, message: string): void;
}

/** Owns document typography resolution, validation, and confirmation policy. */
export class TypographyController {
  private readonly acceptedScales = new Map<string, DocumentScriptFont[]>();
  private scaleCheckTimer: number | null = null;
  private scaleCheckGeneration = 0;
  private scaleConfirmationOpen = false;
  private lastInternalScaleError = "";
  private suppressScaleConfirmation = false;
  private fontUpdateInProgressValue = false;
  private deferredPreviewContentsValue: string | null = null;

  constructor(private readonly port: TypographyControllerPort) {}

  get fontUpdateInProgress(): boolean { return this.fontUpdateInProgressValue; }

  deferPreview(contents: string): void {
    this.deferredPreviewContentsValue = contents;
  }

  acceptedFonts(path: string): readonly DocumentScriptFont[] {
    return this.acceptedScales.get(filePathKey(path)) ?? [];
  }

  setAcceptedFonts(path: string, fonts: readonly DocumentScriptFont[]): void {
    this.acceptedScales.set(filePathKey(path), fonts.map(font => ({ ...font })));
  }

  renameDocument(oldPath: string, newPath: string): void {
    const fonts = this.acceptedScales.get(filePathKey(oldPath));
    this.acceptedScales.delete(filePathKey(oldPath));
    if (fonts) this.acceptedScales.set(filePathKey(newPath), fonts);
  }

  closeDocument(path: string): void {
    this.acceptedScales.delete(filePathKey(path));
  }

  resetRuntime(): void {
    if (this.scaleCheckTimer !== null) window.clearTimeout(this.scaleCheckTimer);
    this.scaleCheckTimer = null;
    this.scaleCheckGeneration += 1;
    this.scaleConfirmationOpen = false;
    this.lastInternalScaleError = "";
    this.suppressScaleConfirmation = false;
    this.fontUpdateInProgressValue = false;
    this.deferredPreviewContentsValue = null;
    this.acceptedScales.clear();
  }

  public fromText(text: string): DocumentTypography | null {
    const managed = parseTypographyBlock(text);
    if (managed) return managed;
    const fonts = parseDocumentScripts(text);
    return fonts.length > 0 ? { baseSizePt: 11, fonts } : null;
  }

  public async effective(path: string, text: string): Promise<DocumentTypography | null> {
    const localTypography = parseTypographyBlock(text);
    if (localTypography) return localTypography;

    const application = findLocalTemplateApplication(text);
    if (application) {
      try {
        const templatePath = await join(await dirname(path), application.importPath);
        const workspaceRoot = this.port.getWorkspaceRootPath();
        const insideWorkspace = !workspaceRoot
          || relativeFilePath(workspaceRoot, templatePath) !== null;
        if (insideWorkspace && await invoke<boolean>("workspace_path_exists", { path: templatePath })) {
          const templateText = await this.port.readWorkspaceText(templatePath);
          const templateTypography = effectiveTemplateTypography(text, templateText);
          if (templateTypography) return templateTypography;
        }
      } catch (error) {
        this.port.logWarning(
          `Could not resolve typography from ${application.importPath}: ${String(error)}`,
        );
      }
    }

    return this.fromText(text);
  }

  public scaleRangeWarning(config: DocumentTypography): string | null {
    const outsideFineRange = config.fonts.filter(font =>
      typographyScaleExceedsFineAdjustment(font.scale)
    );
    if (outsideFineRange.length === 0) return null;
    return `The following font scales exceed the recommended 0.90×–1.10× fine-adjustment range:\n\n${outsideFineRange.map(font => `${font.family}: ${font.scale}×`).join("\n")}\n\nFont scaling is intended for small optical adjustments between script families, not for doubling or substantially changing text size. Beyond ±10%, accurate representation is not guaranteed and results vary from one font to another. Use the document text size for larger size changes.\n\nContinue anyway?`;
  }

  public async confirmScaleRange(config: DocumentTypography): Promise<boolean> {
    const warning = this.scaleRangeWarning(config);
    if (!warning) return true;
    return confirm(warning, { title: t("Large Font Scale Adjustment"), kind: "warning" });
  }

  public async unsupportedInternalScaleError(config: DocumentTypography): Promise<{
    message: string;
    fonts: DocumentScriptFont[];
  } | null> {
    const catalog = await invoke<{ all: string[] }>("list_system_fonts", {
      workspaceRootPath: this.port.getWorkspaceRootPath(),
    });
    const unsupported = unsupportedTypstInternalFontScales(config.fonts, catalog.all);
    if (unsupported.length === 0) return null;
    return {
      fonts: unsupported,
      message: `The following fonts are provided internally by the Typst compiler and cannot be scaled by Typsastra:\n\n${unsupported.map(font => `${font.family}: ${font.scale}×`).join("\n")}\n\nTypsastra will reset their scale to 1×. Install the corresponding font family locally before using a custom scale. Typsastra will not generate or extract variants from compiler-embedded fonts.`,
    };
  }

  public resetUnsupportedInternalScales(
    config: DocumentTypography,
    unsupported: readonly DocumentScriptFont[],
  ): DocumentTypography {
    return {
      ...config,
      fonts: config.fonts.map(font => ({
        ...font,
        scale: unsupported.some(candidate =>
          candidate.script === font.script && candidate.family === font.family
        ) ? 1 : font.scale,
      })),
    };
  }

  public async scaledFontSetStatus(config: DocumentTypography): Promise<ScaledFontSetStatus> {
    const workspaceRootPath = this.port.getWorkspaceRootPath();
    if (!workspaceRootPath) {
      return { updateRequired: false, generationRequired: false, variantLimitWarnings: [] };
    }
    return invoke<ScaledFontSetStatus>("scaled_workspace_font_set_status", {
      workspaceRootPath,
      fonts: config.fonts,
    });
  }

  public variantLimitWarning(status: ScaledFontSetStatus): string | null {
    if (status.variantLimitWarnings.length === 0) return null;
    const variants = status.variantLimitWarnings.map(warning =>
      `${warning.family}: ${warning.cachedVariants} cached variants; requested ${warning.requestedScale}×`
    ).join("\n");
    const limit = Math.min(...status.variantLimitWarnings.map(warning => warning.recommendedLimit));
    return `Typsastra recommends keeping no more than ${limit} scaled variants per font face. This change would add another variant for:\n\n${variants}\n\nExisting variants will not be deleted automatically. Advanced font-variant management is planned for a future update, where variants can be deleted or renewed.\n\nCreate the additional variant anyway?`;
  }

  public async confirmVariantLimit(config: DocumentTypography): Promise<boolean> {
    const warning = this.variantLimitWarning(await this.scaledFontSetStatus(config));
    if (!warning) return true;
    return confirm(warning, {
      title: t("Font Variant Cache Limit"),
      kind: "warning",
      okLabel: t("Create Variant"),
      cancelLabel: t("Cancel"),
    });
  }

  private async prepareWorkspaceFonts(config: DocumentTypography): Promise<boolean> {
    const workspaceRootPath = this.port.getWorkspaceRootPath();
    if (!workspaceRootPath) return false;
    const scaled = config.fonts.filter(font => Math.abs(font.scale - 1) > 0.0001);
    const status = await this.scaledFontSetStatus(config);
    if (!status.updateRequired) return false;
    this.fontUpdateInProgressValue = true;
    if (scaled.length === 0) {
      return invoke<boolean>("clear_scaled_workspace_fonts", { workspaceRootPath });
    }
    let changed = false;
    if (status.generationRequired) {
      this.port.setPreviewLoading(
        `Scaling ${scaled.length} document font${scaled.length === 1 ? "" : "s"}… The result will be stored in Typsastra's global cache.`,
      );
    }
    for (const font of scaled) {
      const result = await invoke<{ changed: boolean }>("prepare_scaled_workspace_font", {
        workspaceRootPath,
        family: font.family,
        scale: font.scale,
      });
      changed ||= result.changed;
    }
    const activationChanged = await invoke<boolean>("activate_scaled_workspace_fonts", {
      workspaceRootPath,
      fonts: config.fonts,
    });
    return changed || activationChanged;
  }

  public async prepareMainFileFonts(config: DocumentTypography): Promise<boolean> {
    try {
      return await this.prepareWorkspaceFonts(config);
    } finally {
      this.fontUpdateInProgressValue = false;
      this.deferredPreviewContentsValue = null;
    }
  }

  public async updateWorkspaceFonts(config: DocumentTypography): Promise<boolean> {
    let changed = false;
    try {
      changed = await this.prepareWorkspaceFonts(config);
      if (changed) await this.reloadWorkspaceFonts();
    } finally {
      this.fontUpdateInProgressValue = false;
    }
    const hadDeferredPreview = this.deferredPreviewContentsValue !== null;
    this.deferredPreviewContentsValue = null;
    return changed || hadDeferredPreview;
  }

  public async reloadTemplateContext(config: DocumentTypography): Promise<void> {
    if (this.port.getWorkspaceRootPath() && this.port.getPinnedMainFilePath()) {
      try {
        await this.prepareWorkspaceFonts(config);
      } finally {
        this.fontUpdateInProgressValue = false;
        this.deferredPreviewContentsValue = null;
      }
    }
    if (this.port.isLargePreviewBlocked()) return;
    if (this.port.hasLspClient()) {
      await this.port.restartTinymistSession("Reloading template typography...");
      await this.port.restoreActiveDocumentAfterRestart();
    } else {
      await this.port.refreshActivePreviewRoot(true);
    }
  }

  public async reloadWorkspaceFonts(): Promise<void> {
    if (!this.port.hasLspClient() || !this.port.getWorkspaceRootPath()) return;
    await this.port.restartTinymistSession("Reloading project fonts...");
    const lspMainPath = this.port.isPreviewStandalone()
      ? this.port.getPreviewRootPath()
      : (this.port.getPreviewMainPath() ?? this.port.getPreviewRootPath());
    await this.port.updatePinnedMain(lspMainPath, true);
    if (this.port.getActiveFilePath()) {
      await this.port.recheckActiveDocumentAfterPin(this.port.getActiveDocumentText());
    }
    this.port.resetSourceMap();
  }

  public async privateFontDirectoriesChanged(): Promise<void> {
    if (!this.port.getWorkspaceRootPath() || this.port.isLargePreviewBlocked()) return;
    if (this.port.hasLspClient()) {
      await this.reloadWorkspaceFonts();
      return;
    }
    await this.port.refreshActivePreviewRoot(true);
  }

  public scheduleManualScaleCheck(): void {
    if (this.suppressScaleConfirmation || !this.port.getActiveFilePath()) return;
    if (this.scaleCheckTimer !== null) window.clearTimeout(this.scaleCheckTimer);
    const generation = ++this.scaleCheckGeneration;
    const delay = Math.max(600, this.port.getPreviewDebounceMs());
    this.scaleCheckTimer = window.setTimeout(() => {
      this.scaleCheckTimer = null;
      if (generation !== this.scaleCheckGeneration) return;
      void this.checkManualScaleChange();
    }, delay);
  }

  public async checkManualScaleChange(): Promise<void> {
    const activeFilePath = this.port.getActiveFilePath();
    if (!activeFilePath || this.scaleConfirmationOpen) {
      if (this.scaleConfirmationOpen) this.scheduleManualScaleCheck();
      return;
    }
    const documentKey = filePathKey(activeFilePath);
    const config = this.fromText(this.port.getActiveDocumentText());
    if (!config) return;
    const previousFonts = this.acceptedScales.get(documentKey) ?? [];
    const signature = (fonts: readonly DocumentScriptFont[]) => JSON.stringify(fonts.map(font => ({
      family: font.family,
      script: font.script,
      scale: Number(font.scale.toFixed(4)),
      defaultText: font.defaultText !== false,
    })));
    if (signature(previousFonts) === signature(config.fonts)) return;
    this.port.synchronizeDocumentTypography(config);
    if (!this.port.isPinnedMainFile(activeFilePath)) {
      this.setAcceptedFonts(activeFilePath, config.fonts);
      return;
    }
    if (!participatesInPreviewCompilation(
      activeFilePath,
      this.port.getPinnedMainFilePath(),
      this.port.isPreviewImported(),
    )) {
      this.port.appendLog(
        "info",
        "preview scheduler",
        `On-type schedule skipped: ${activeFilePath} does not own the configured main preview.`,
      );
      return;
    }
    const unsupportedInternalScale = await this.unsupportedInternalScaleError(config);
    if (unsupportedInternalScale) {
      const errorKey = `${documentKey}\u0000${signature(config.fonts)}`;
      if (this.lastInternalScaleError !== errorKey) {
        this.lastInternalScaleError = errorKey;
        this.port.appendLog("error", "typography", unsupportedInternalScale.message);
        await message(unsupportedInternalScale.message, {
          title: t("Unsupported Built-in Font Scale"),
          kind: "error",
        });
      }
      if (filePathKey(this.port.getActiveFilePath() ?? "") !== documentKey) return;
      const currentText = this.port.getActiveDocumentText();
      const currentConfig = this.fromText(currentText);
      if (!currentConfig || signature(currentConfig.fonts) !== signature(config.fonts)) {
        this.scheduleManualScaleCheck();
        return;
      }
      const corrected = this.resetUnsupportedInternalScales(
        currentConfig,
        unsupportedInternalScale.fonts,
      );
      const edit = parseTypographyBlock(currentText)
        ? typographyEdit(currentText, corrected)
        : documentScriptsEdit(currentText, corrected.fonts);
      this.suppressScaleConfirmation = true;
      try {
        this.port.dispatchDocumentEdit(edit, "input.typography-scale-correction");
      } finally {
        this.suppressScaleConfirmation = false;
      }
      this.lastInternalScaleError = "";
      this.setAcceptedFonts(activeFilePath, corrected.fonts);
      await this.applyManualFontChange(corrected, activeFilePath);
      return;
    }
    this.lastInternalScaleError = "";
    const requiresConfirmation = config.fonts.some(font => {
      if (Math.abs(font.scale - 1) <= 0.0001) return false;
      const previous = previousFonts.find(candidate =>
        candidate.script === font.script && candidate.family === font.family
      );
      return !previous || Math.abs(previous.scale - font.scale) > 0.0001;
    });
    if (!requiresConfirmation) {
      this.setAcceptedFonts(activeFilePath, config.fonts);
      await this.applyManualFontChange(config, activeFilePath);
      return;
    }

    this.scaleConfirmationOpen = true;
    let accepted = false;
    try {
      const rangeWarning = this.scaleRangeWarning(config);
      const variantWarning = this.variantLimitWarning(await this.scaledFontSetStatus(config));
      const warning = [rangeWarning, variantWarning]
        .filter((value): value is string => Boolean(value))
        .join("\n\n");
      accepted = await confirm(
        warning || `Apply these document font scales?\n\n${config.fonts.map(font => `${font.family}: ${font.scale}×`).join("\n")}\n\nTypsastra will prepare the required variants in its private global font cache and restart the preview compiler. No font data is written into the project. Non-1× scaling is experimental for PDF output because Typst may normalize scaled fonts while subsetting them. Use 1× for dependable PDF export.`,
        {
          title: variantWarning
            ? "Font Variant Cache Limit"
            : (rangeWarning ? "Large Font Scale Adjustment" : "Confirm Font Scaling"),
          kind: "warning",
        },
      );
    } finally {
      this.scaleConfirmationOpen = false;
    }

    if (filePathKey(this.port.getActiveFilePath() ?? "") !== documentKey) return;
    const currentText = this.port.getActiveDocumentText();
    const currentConfig = this.fromText(currentText);
    if (!currentConfig || signature(currentConfig.fonts) !== signature(config.fonts)) {
      this.scheduleManualScaleCheck();
      return;
    }
    if (accepted) {
      this.setAcceptedFonts(activeFilePath, currentConfig.fonts);
      await this.applyManualFontChange(currentConfig, activeFilePath);
      return;
    }

    const revertedConfig = {
      ...currentConfig,
      fonts: currentConfig.fonts.map(font => ({
        ...font,
        scale: previousFonts.find(candidate =>
          candidate.script === font.script && candidate.family === font.family
        )?.scale ?? 1,
      })),
    };
    const edit = parseTypographyBlock(currentText)
      ? typographyEdit(currentText, revertedConfig)
      : documentScriptsEdit(currentText, revertedConfig.fonts);
    this.suppressScaleConfirmation = true;
    try {
      this.port.dispatchDocumentEdit(edit, "input.typography-scale-revert");
    } finally {
      this.suppressScaleConfirmation = false;
    }
  }

  private async applyManualFontChange(config: DocumentTypography, filePath: string): Promise<void> {
    try {
      const fontsChanged = await this.updateWorkspaceFonts(config);
      if (!fontsChanged) return;
      if (filePathKey(this.port.getActiveFilePath() ?? "") === filePathKey(filePath)) {
        await this.port.refreshActivePreviewRoot(true);
      }
    } catch (error) {
      this.port.appendLog(
        "error",
        "typography",
        `Unable to prepare the manually selected font scale: ${String(error)}`,
      );
      await message(String(error), { title: t("Unable to Scale Font"), kind: "error" });
    }
  }
}

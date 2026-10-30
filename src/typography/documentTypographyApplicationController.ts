import { invoke } from "@tauri-apps/api/core";
import { dirname, join } from "@tauri-apps/api/path";
import { message } from "@tauri-apps/plugin-dialog";
import type { EditorView } from "@codemirror/view";
import type { LspLogEntry, LspStatus } from "../compiler/lsp";
import {
  documentScriptsEdit,
  typographyEdit,
  type DocumentTypography,
} from "../editor/documentTypography";
import {
  ensureTypographyTemplateApplication,
  findLocalTemplateApplication,
  findTemplateFunctionName,
  newTypographyTemplate,
  templateTypographyEdit,
} from "../editor/templateTypography";
import { relativeFilePath } from "../platform/paths";
import type { WorkspaceTextController } from "../workspace/workspaceTextController";
import type { TypographyController } from "./typographyController";
import { t } from "../i18n";

export interface DocumentTypographyApplicationDependencies {
  activeFilePath(): string | null;
  editor(): EditorView;
  typography(): TypographyController;
  workspaceText(): WorkspaceTextController;
  isPinnedMainFile(path: string): boolean;
  previewStandalone(): boolean;
  previewMainPath(): string | null;
  workspaceRootPath(): string | null;
  saveActiveFile(): Promise<void>;
  refreshActivePreviewRoot(fontsChanged: boolean): Promise<void>;
  configureDocumentLanguageTools(text: string): void;
  setMainDocumentScripts(fonts: DocumentTypography["fonts"]): void;
  setLspStatus(status: LspStatus): void;
  appendLspLog(entry: LspLogEntry): void;
}

/** Owns document/template typography application and workspace template edits. */
export class DocumentTypographyApplicationController {
  constructor(private readonly deps: DocumentTypographyApplicationDependencies) {}

  async apply(config: DocumentTypography, target: "document" | "template"): Promise<boolean> {
    const activeFilePath = this.deps.activeFilePath();
    if (!activeFilePath) return false;
    const typography = this.deps.typography();
    const ownsWorkspaceTypography = this.deps.isPinnedMainFile(activeFilePath);
    if (ownsWorkspaceTypography && !await typography.confirmScaleRange(config)) return false;
    if (ownsWorkspaceTypography && !await typography.confirmVariantLimit(config)) return false;
    const previousAcceptedScale = typography.acceptedFonts(activeFilePath);
    typography.setAcceptedFonts(activeFilePath, config.fonts);

    try {
      if (target === "document") {
        const editor = this.deps.editor();
        const edit = typographyEdit(editor.state.doc.toString(), config);
        editor.dispatch({
          changes: edit,
          selection: { anchor: edit.from },
          scrollIntoView: true,
          userEvent: "input",
        });
        await this.deps.saveActiveFile();
        const fontsChanged = ownsWorkspaceTypography
          ? await typography.updateWorkspaceFonts(config)
          : false;
        if (ownsWorkspaceTypography) await this.deps.refreshActivePreviewRoot(fontsChanged);
        editor.focus();
        return true;
      }

      const editor = this.deps.editor();
      const activeText = editor.state.doc.toString();
      const hasExistingBlock = activeText.includes("// typsastra:typography:start");
      const detectedTemplateFunc = findTemplateFunctionName(activeText);

      if (hasExistingBlock || detectedTemplateFunc) {
        const funcName = detectedTemplateFunc || "typsastra-typography";
        const edit = templateTypographyEdit(activeText, funcName, config);
        if (edit) {
          editor.dispatch({
            changes: { from: edit.from, to: edit.to, insert: edit.insert },
            selection: { anchor: edit.from },
            scrollIntoView: true,
            userEvent: "input",
          });
          await this.deps.saveActiveFile();
          await typography.reloadTemplateContext(config);
          editor.focus();
          this.deps.setLspStatus({ kind: "preview-ready", message: t("Typography applied to template") });
          return true;
        }
      }

      const mainPath = this.deps.previewStandalone()
        ? activeFilePath
        : (this.deps.previewMainPath() ?? activeFilePath);
      const workspaceText = this.deps.workspaceText();
      const mainText = await workspaceText.read(mainPath);
      const application = findLocalTemplateApplication(mainText);
      let updatedLocalTemplate = false;

      if (application) {
        const candidate = await join(await dirname(mainPath), application.importPath);
        const workspaceRootPath = this.deps.workspaceRootPath();
        const relativeToWorkspace = workspaceRootPath
          ? relativeFilePath(workspaceRootPath, candidate)
          : "";
        const insideWorkspace = !workspaceRootPath || relativeToWorkspace !== null;
        if (insideWorkspace && await invoke<boolean>("workspace_path_exists", { path: candidate })) {
          const templateText = await workspaceText.read(candidate);
          const edit = templateTypographyEdit(templateText, application.functionName, config);
          if (edit) {
            await workspaceText.write(candidate, applyEdit(templateText, edit));
            updatedLocalTemplate = true;
          }
        }
      }

      if (!updatedLocalTemplate) {
        const mainDirectory = await dirname(mainPath);
        const templatePath = await join(mainDirectory, "typsastra-template.typ");
        const exists = await invoke<boolean>("workspace_path_exists", { path: templatePath });
        let templateText = exists ? await workspaceText.read(templatePath) : newTypographyTemplate(config);
        if (exists) {
          const edit = templateTypographyEdit(templateText, "typsastra-typography", config);
          templateText = edit ? applyEdit(templateText, edit) : newTypographyTemplate(config);
        }
        await workspaceText.write(templatePath, templateText);

        const applicationEdit = ensureTypographyTemplateApplication(mainText);
        if (applicationEdit.insert || applicationEdit.from !== applicationEdit.to) {
          await workspaceText.write(mainPath, applyEdit(mainText, applicationEdit));
        }
      }

      const latestMainText = await workspaceText.read(mainPath);
      const metadataEdit = documentScriptsEdit(latestMainText, config.fonts);
      const mainWithDocumentScripts = applyEdit(latestMainText, metadataEdit);
      if (mainWithDocumentScripts !== latestMainText) {
        await workspaceText.write(mainPath, mainWithDocumentScripts);
      }
      if (this.deps.isPinnedMainFile(mainPath)) {
        this.deps.setMainDocumentScripts(config.fonts.map(font => ({ ...font })));
        this.deps.configureDocumentLanguageTools(editor.state.doc.toString());
      }

      await typography.reloadTemplateContext(config);
      this.deps.setLspStatus({ kind: "preview-ready", message: t("Typography applied to template") });
      editor.focus();
      return true;
    } catch (error) {
      typography.setAcceptedFonts(activeFilePath, previousAcceptedScale);
      this.deps.appendLspLog({
        kind: "error",
        source: "typography",
        message: `Failed to apply template typography: ${String(error)}`,
      });
      await message(String(error), { title: t("Unable to apply typography"), kind: "error" });
      return false;
    }
  }
}

function applyEdit(text: string, edit: { from: number; to: number; insert: string }): string {
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}

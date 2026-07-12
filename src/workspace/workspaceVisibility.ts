export type WorkspaceViewportState = {
  showWelcome: boolean;
  showEditor: boolean;
  showWorkspaceChrome: boolean;
};

export function workspaceViewportState(
  activeFilePath: string | null,
  workspaceRootPath: string | null
): WorkspaceViewportState {
  return {
    showWelcome: activeFilePath === null && workspaceRootPath === null,
    showEditor: activeFilePath !== null,
    showWorkspaceChrome: workspaceRootPath !== null
  };
}

import { readDir } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";

export interface FileNode { name: string; path: string; isDirectory: boolean; children?: FileNode[]; }

export class WorkspaceExplorer {
  constructor(private container: HTMLElement, private onFileSelected: (filePath: string) => void) {}

  public async loadWorkspace(rootPath: string) {
    this.container.innerHTML = `<div class="explorer-loading">Scanning Workspace...</div>`;
    try {
      const nodes = await this.readDirectoryRecursive(rootPath);
      this.container.innerHTML = "";
      this.container.appendChild(this.renderTree(nodes));
    } catch {
      this.container.innerHTML = `<div class="explorer-error">Access Refused.</div>`;
    }
  }

  private async readDirectoryRecursive(dirPath: string): Promise<FileNode[]> {
    const entries = await readDir(dirPath);
    const nodes: FileNode[] = [];
    for (const entry of entries) {
      const childPath = await join(dirPath, entry.name);
      const node: FileNode = { name: entry.name, path: childPath, isDirectory: entry.isDirectory };
      if (entry.isDirectory) { node.children = await this.readDirectoryRecursive(childPath); }
      nodes.push(node);
    }
    return nodes.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
  }

  private renderTree(nodes: FileNode[]): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const ul = document.createElement("ul");
    ul.className = "file-tree-branch";

    for (const node of nodes) {
      const li = document.createElement("li");
      li.className = node.isDirectory ? "tree-folder" : "tree-file";
      const label = document.createElement("span");
      label.className = "tree-label";
      label.textContent = (node.isDirectory ? "📁 " : "📄 ") + node.name;

      if (!node.isDirectory) {
        label.addEventListener("click", () => this.onFileSelected(node.path));
      } else if (node.children) {
        const childBranch = this.renderTree(node.children);
        label.addEventListener("click", () => li.classList.toggle("collapsed"));
        li.appendChild(childBranch);
      }
      li.insertBefore(label, li.firstChild);
      ul.appendChild(li);
    }
    fragment.appendChild(ul);
    return fragment;
  }
}

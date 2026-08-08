import * as vscode from 'vscode';
import {
  discoverWorktrees,
  resolveWatchRoots,
  type DiscoveredWorktree,
} from '../discovery/scanner';

export type TreeNode = WorktreeItem | MessageItem;

export class WorktreeTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private worktrees: DiscoveredWorktree[] = [];
  private loading = false;
  private readonly disposables: vscode.Disposable[] = [];
  private folderWatchers: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly output: vscode.OutputChannel) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rewatch();
        this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('worktreeCompare')) {
          this.rewatch();
          this.refresh();
        }
      }),
    );
    this.rewatch();
    void this.refresh();
  }

  refresh(): void {
    // Debounce filesystem events
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      void this.load();
    }, 150);
  }

  private async load(): Promise<void> {
    this.loading = true;
    this._onDidChangeTreeData.fire();
    try {
      this.worktrees = await discoverWorktrees(this.output);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Discovery failed: ${message}`);
      this.worktrees = [];
    } finally {
      this.loading = false;
      this._onDidChangeTreeData.fire();
    }
  }

  private rewatch(): void {
    for (const w of this.folderWatchers) {
      w.dispose();
    }
    this.folderWatchers = [];

    for (const root of resolveWatchRoots()) {
      // Watch the folder itself and one level of children (add/remove worktrees)
      const pattern = new vscode.RelativePattern(root, '*');
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.folderWatchers.push(
          watcher,
          watcher.onDidCreate(() => this.refresh()),
          watcher.onDidDelete(() => this.refresh()),
          // Rename / git metadata sometimes shows as change
          watcher.onDidChange(() => this.refresh()),
        );
        this.output.appendLine(`Watching ${root}`);
      } catch {
        // Root may not exist yet — discovery still runs on refresh
        this.output.appendLine(`Watch root not ready: ${root}`);
      }
    }
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element) {
      // Nested compare tree lands in a later commit
      return [];
    }

    if (this.loading && this.worktrees.length === 0) {
      return [new MessageItem('Scanning worktrees…', 'loading')];
    }

    if (this.worktrees.length === 0) {
      const folders =
        vscode.workspace
          .getConfiguration('worktreeCompare')
          .get<string[]>('watchFolders', ['.claude/worktrees'])
          .join(', ') || '.claude/worktrees';
      return [
        new MessageItem(
          'No worktrees found',
          'empty',
          `Watched: ${folders}`,
        ),
      ];
    }

    return this.worktrees.map((wt) => new WorktreeItem(wt));
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    for (const w of this.folderWatchers) {
      w.dispose();
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}

export class WorktreeItem extends vscode.TreeItem {
  readonly worktreePath: string;

  constructor(worktree: DiscoveredWorktree) {
    super(worktree.name, vscode.TreeItemCollapsibleState.None);
    this.worktreePath = worktree.path;
    this.contextValue = 'worktree';
    this.iconPath = new vscode.ThemeIcon('repo');
    this.description = worktree.branch + (worktree.detached ? ' (detached)' : '');
    this.tooltip = new vscode.MarkdownString(
      [
        `**${worktree.name}**`,
        '',
        `Path: \`${worktree.path}\``,
        `Branch: \`${worktree.branch}\``,
        worktree.relativePath ? `Relative: \`${worktree.relativePath}\`` : '',
        worktree.mainWorktreePath
          ? `Main: \`${worktree.mainWorktreePath}\``
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    this.command = {
      command: 'worktreeCompare.openWorktree',
      title: 'Reveal Worktree',
      arguments: [this],
    };
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(
    label: string,
    kind: 'loading' | 'empty',
    description?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = kind;
    this.iconPath = new vscode.ThemeIcon(kind === 'loading' ? 'loading~spin' : 'info');
  }
}

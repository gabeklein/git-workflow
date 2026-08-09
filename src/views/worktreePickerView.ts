import * as vscode from 'vscode';
import type { DiscoveredWorktree } from '../discovery/scanner';
import type { WorktreeTreeProvider } from './worktreeTree';

/**
 * Compact webview above the tree: real &lt;select&gt; for the focused worktree.
 */
export class WorktreePickerViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'worktreeCompare.picker';

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly tree: WorktreeTreeProvider) {
    this.disposables.push(
      tree.onDidChangeWorktrees(() => {
        this.postState();
      }),
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.html = this.html();

    webviewView.webview.onDidReceiveMessage(
      async (msg: { type?: string; path?: string }) => {
        if (msg?.type === 'ready') {
          this.postState();
          return;
        }
        if (msg?.type === 'select' && typeof msg.path === 'string' && msg.path) {
          await this.tree.setSelectedPath(msg.path);
        }
      },
      undefined,
      this.disposables,
    );

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    // Initial state once scripts run (also handled by 'ready')
    this.postState();
  }

  private postState(): void {
    if (!this.view) {
      return;
    }
    const worktrees = this.tree.getWorktrees().map((w) => toOption(w));
    const selected = this.tree.getSelectedPath() ?? '';
    void this.view.webview.postMessage({
      type: 'state',
      worktrees,
      selected,
    });
  }

  private html(): string {
    // CSP: no external resources; only inline script for the select bridge
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
    }
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .wrap {
      padding: 8px 10px 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    label {
      font-size: 11px;
      opacity: 0.75;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    select {
      width: 100%;
      box-sizing: border-box;
      padding: 5px 8px;
      border-radius: 2px;
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border, transparent));
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      outline: none;
    }
    select:focus {
      border-color: var(--vscode-focusBorder);
    }
    .empty {
      opacity: 0.7;
      font-size: 12px;
      padding: 4px 0;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <label for="wt">Worktree</label>
    <select id="wt" aria-label="Select worktree"></select>
    <div id="empty" class="empty" hidden>No worktrees found</div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const select = document.getElementById('wt');
    const empty = document.getElementById('empty');

    function applyState(state) {
      const list = state.worktrees || [];
      const selected = state.selected || '';
      select.innerHTML = '';
      if (list.length === 0) {
        select.hidden = true;
        empty.hidden = false;
        return;
      }
      select.hidden = false;
      empty.hidden = true;
      for (const w of list) {
        const opt = document.createElement('option');
        opt.value = w.path;
        opt.textContent = w.label;
        if (w.path === selected) opt.selected = true;
        select.appendChild(opt);
      }
      if (selected && !list.some(w => w.path === selected) && select.options.length) {
        select.selectedIndex = 0;
      }
    }

    select.addEventListener('change', () => {
      vscode.postMessage({ type: 'select', path: select.value });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'state') applyState(msg);
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function toOption(w: DiscoveredWorktree): { path: string; label: string } {
  const branch = w.branch + (w.detached ? ' (detached)' : '');
  // branch primary, folder secondary — fits a narrow select
  return {
    path: w.path,
    label: `${branch}  ·  ${w.name}`,
  };
}

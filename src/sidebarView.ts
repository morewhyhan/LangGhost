import { ItemView, MarkdownView, WorkspaceLeaf } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type { MarkStore } from './markStore';
import type { Dispatcher } from './dispatcher';
import type LangGhostPlugin from '../main';
import type { ErrorMark } from './types';

const TYPE_LABELS: Record<string, string> = {
  grammar: '语法',
  spelling: '拼写',
  expression: '表达',
  translation: '翻译',
};

export class LangGhostSidebarView extends ItemView {
  static VIEW_TYPE = 'langghost-sidebar';

  private markStore: MarkStore;
  private dispatcher: Dispatcher;
  private plugin: LangGhostPlugin;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private boundRefresh: () => void;
  private boundOnLeafChange: () => void;
  /** Track the last known markdown file path so we can still show content
   *  when the sidebar itself has focus (getActiveViewOfType would return null). */
  private lastFilePath: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    markStore: MarkStore,
    dispatcher: Dispatcher,
    plugin: LangGhostPlugin
  ) {
    super(leaf);
    this.markStore = markStore;
    this.dispatcher = dispatcher;
    this.plugin = plugin;
    this.boundRefresh = () => this.scheduleRefresh();
    this.boundOnLeafChange = () => this.scheduleRefresh();
  }

  getViewType(): string {
    return LangGhostSidebarView.VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'LangGhost';
  }

  getIcon(): string {
    return 'languages';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.classList.add('langghost-sidebar');

    this.emptyEl = container.createDiv({ cls: 'langghost-sidebar-empty' });
    this.emptyEl.textContent = '没有发现错误';

    this.listEl = container.createDiv({ cls: 'langghost-sidebar-list' });

    this.markStore.addListener(this.boundRefresh);
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', this.boundOnLeafChange)
    );
    // Also refresh when the active file changes within the same leaf
    // (e.g. quick-switcher, Ctrl+Tab, clicking search results)
    this.registerEvent(
      this.app.workspace.on('file-open', this.boundOnLeafChange)
    );

    this.refresh();
  }

  async onClose(): Promise<void> {
    this.markStore.removeListener(this.boundRefresh);
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 50);
  }

  /** Public method to trigger a refresh from outside (e.g., toggle command). */
  requestRefresh(): void {
    this.scheduleRefresh();
  }

  private refresh(): void {
    const filePath = this.getActiveFilePath();
    if (!filePath) {
      this.showEmpty();
      return;
    }
    if (!this.plugin.settings.enabled) {
      this.showEmpty('LangGhost: 检查已禁用');
      return;
    }

    const marks = this.markStore.getMarks(filePath);
    if (marks.length === 0) {
      this.showEmpty();
      return;
    }

    // Sort by position
    marks.sort((a, b) => a.from - b.from);

    this.emptyEl.style.display = 'none';
    this.listEl.style.display = 'block';
    this.listEl.empty();

    for (const mark of marks) {
      this.listEl.appendChild(this.createItem(mark, filePath));
    }
  }

  private createItem(mark: ErrorMark, filePath: string): HTMLElement {
    const item = document.createElement('div');
    item.className = 'langghost-sidebar-item';

    // Fix line: original → corrected
    const fix = document.createElement('div');
    fix.className = 'langghost-sidebar-fix';

    const orig = document.createElement('span');
    orig.className = 'langghost-sidebar-original';
    orig.textContent = mark.error.original;

    const arrow = document.createElement('span');
    arrow.className = 'langghost-sidebar-arrow';
    arrow.textContent = ' → ';

    const corr = document.createElement('span');
    corr.className = 'langghost-sidebar-corrected';
    corr.textContent = mark.error.corrected;

    fix.appendChild(orig);
    fix.appendChild(arrow);
    fix.appendChild(corr);
    item.appendChild(fix);

    // Meta: type tag + explanation
    const meta = document.createElement('div');
    meta.className = 'langghost-sidebar-meta';

    const typeTag = document.createElement('span');
    typeTag.className = `langghost-sidebar-type langghost-sidebar-type-${mark.error.type}`;
    typeTag.textContent = TYPE_LABELS[mark.error.type] || mark.error.type;

    const explain = document.createElement('span');
    explain.className = 'langghost-sidebar-explain';
    explain.textContent = mark.error.explanation;

    meta.appendChild(typeTag);
    meta.appendChild(explain);
    item.appendChild(meta);

    // Alternatives
    if (mark.error.alternatives && mark.error.alternatives.length > 0) {
      const alt = document.createElement('div');
      alt.className = 'langghost-sidebar-alt';
      alt.textContent = '或: ' + mark.error.alternatives.join(', ');
      item.appendChild(alt);
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'langghost-sidebar-actions';

    const errorId = mark.error.id;

    const applyBtn = document.createElement('button');
    applyBtn.className = 'langghost-sidebar-apply';
    applyBtn.textContent = '应用';
    applyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Look up the LATEST mark position from the store, not the stale closure
      this.applyFix(errorId, filePath);
    });

    const ignoreBtn = document.createElement('button');
    ignoreBtn.className = 'langghost-sidebar-ignore';
    ignoreBtn.textContent = '忽略';
    ignoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.markStore.ignore(filePath, errorId);
    });

    actions.appendChild(applyBtn);
    actions.appendChild(ignoreBtn);
    item.appendChild(actions);

    // Click to navigate — use errorId to look up fresh position
    item.addEventListener('click', () => {
      this.navigateToError(errorId, filePath);
    });

    return item;
  }

  /** Get the CM6 EditorView for a given file path by scanning all markdown
   *  leaves — does NOT depend on "active" view so it works when the sidebar
   *  itself has focus. */
  private getEditorForFile(filePath: string): EditorView | null {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view as MarkdownView;
      if (view.file?.path === filePath) {
        const cm = (view.editor as any).cm as EditorView;
        if (cm) return cm;
      }
    }
    return null;
  }

  /** Find a fresh (non-ignored) mark by errorId from the store. */
  private findFreshMark(errorId: string, filePath: string): ErrorMark | null {
    return this.markStore.getMarks(filePath).find(m => m.error.id === errorId) ?? null;
  }

  private applyFix(errorId: string, filePath: string): void {
    const mark = this.findFreshMark(errorId, filePath);
    if (!mark) { console.warn('[LG sidebar] mark not found:', errorId, filePath); return; }

    const cm = this.getEditorForFile(filePath);
    if (!cm) { console.warn('[LG sidebar] no editor for:', filePath); return; }

    const doc = cm.state.doc;
    const from = Math.min(mark.from, doc.length);
    const to = Math.min(mark.to, doc.length);

    // Validate position: text at mark must still match
    if (from >= to) { console.warn('[LG sidebar] invalid range:', from, to); return; }
    const currentText = doc.sliceString(from, to);
    if (currentText !== mark.error.original) {
      console.warn('[LG sidebar] text mismatch:', JSON.stringify({ expected: mark.error.original, actual: currentText, from, to, docLen: doc.length }));
      return;
    }

    // Remove mark BEFORE dispatching the text change.
    // If we dispatch first, the CM6 update runs synchronously and
    // validateMarks sees the replaced text, thinks the mark is stale,
    // and records it to the error book — causing a duplicate entry.
    this.markStore.removeMark(filePath, mark.error.id);

    // Replace text
    cm.dispatch({
      changes: { from, to, insert: mark.error.corrected },
    });

    // Record to error book
    this.plugin.errorBook.appendError(mark.error);

    // Do NOT recheck — recheck clears ALL marks in the sentence range
    // (including other unrelated errors), causing wavy lines to vanish.
    // The decorations plugin's validateMarks handles stale marks,
    // and position mapping adjusts the surviving ones.
  }

  private navigateToError(errorId: string, filePath: string): void {
    const mark = this.findFreshMark(errorId, filePath);
    if (!mark) return;

    const cm = this.getEditorForFile(filePath);
    if (!cm) return;

    const pos = Math.min(mark.from, cm.state.doc.length);
    cm.dispatch({
      selection: { anchor: pos },
      scrollIntoView: true,
    });

    // Focus the editor
    cm.focus();
  }

  private showEmpty(msg?: string): void {
    this.emptyEl.textContent = msg ?? '没有发现错误';
    this.emptyEl.style.display = 'block';
    this.listEl.style.display = 'none';
  }

  /** Get current file path — uses lastFilePath as fallback when the
   *  sidebar itself has focus and getActiveViewOfType returns null. */
  private getActiveFilePath(): string | null {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.file?.path) {
      this.lastFilePath = activeView.file.path;
      return this.lastFilePath;
    }
    // Sidebar has focus — fall back to the last known markdown file
    return this.lastFilePath;
  }
}

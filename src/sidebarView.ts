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
  private scanBtn: HTMLButtonElement;
  private hintEl: HTMLElement;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private boundRefresh: () => void;
  private boundOnLeafChange: () => void;
  private lastFilePath: string | null = null;
  /** Files that have been checked at least once (by typing or scan). */
  private checkedFiles: Set<string> = new Set();
  /** Error IDs seen in the last refresh, for fresh-item animation tracking. */
  private lastErrorIds: Set<string> = new Set();

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

    // Scan button — manually trigger full-document check
    this.scanBtn = container.createEl('button', {
      cls: 'langghost-sidebar-scan-btn',
      text: '检查全文',
    });
    this.scanBtn.addEventListener('click', () => this.scanDocument());

    // Hint for first-time users
    this.hintEl = container.createDiv({ cls: 'langghost-sidebar-hint' });
    this.hintEl.textContent = '以 . ? ! 结尾自动触发检查';

    this.emptyEl = container.createDiv({ cls: 'langghost-sidebar-empty' });
    this.emptyEl.textContent = '没有发现错误';

    this.listEl = container.createDiv({ cls: 'langghost-sidebar-list' });

    this.markStore.addListener(this.boundRefresh);
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', this.boundOnLeafChange)
    );
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
    // Use microtask: batches rapid changes, executes before next frame,
    // so sidebar is always in sync with decorations.
    this.refreshTimer = setTimeout(() => this.refresh(), 0);
  }

  /** Public method to trigger a refresh from outside (e.g., toggle command). */
  requestRefresh(): void {
    this.scheduleRefresh();
  }

  /** Scan the entire current document and check all sentences.
   *  Triggered manually by the user via the sidebar button. */
  private scanDocument(): void {
    const filePath = this.getActiveFilePath();
    if (!filePath) return;
    if (!this.plugin.settings.enabled) return;

    const cm = this.getEditorForFile(filePath);
    if (!cm) return;

    this.checkedFiles.add(filePath);
    this.scanBtn.classList.add('langghost-scanning');
    this.scanBtn.textContent = '检查中...';
    this.scanBtn.disabled = true;

    const count = this.dispatcher.scanFile(filePath, cm.state.doc);

    // Show count feedback, then restore button after results start coming in
    this.scanBtn.textContent = `已检查 ${count} 句`;
    setTimeout(() => {
      this.scanBtn.classList.remove('langghost-scanning');
      this.scanBtn.textContent = '检查全文';
      this.scanBtn.disabled = false;
      this.requestRefresh();
    }, 2000);
  }

  private refresh(): void {
    const filePath = this.getActiveFilePath();
    if (!filePath) {
      this.showEmpty('langghost-empty-no-file', '打开文件即可开始');
      this.scanBtn.style.display = 'none';
      this.hintEl.style.display = 'none';
      return;
    }
    if (!this.plugin.settings.enabled) {
      this.showEmpty('langghost-empty-disabled', '检查已禁用');
      this.scanBtn.style.display = 'none';
      this.hintEl.style.display = 'none';
      return;
    }

    const marks = this.markStore.getMarks(filePath);
    if (marks.length > 0) {
      this.checkedFiles.add(filePath);
    }

    // Track new error IDs for fresh-item animation
    const currentIds = new Set(marks.map(m => m.error.id));
    const newIds = new Set([...currentIds].filter(id => !this.lastErrorIds.has(id)));
    this.lastErrorIds = currentIds;

    if (marks.length === 0) {
      if (this.checkedFiles.has(filePath)) {
        this.showEmpty('langghost-empty-none', '没有发现错误');
      } else {
        this.showEmpty('langghost-empty-idle', '输入英文，句号结尾自动检查');
        this.hintEl.style.display = 'none';
      }
      this.scanBtn.style.display = 'block';
      return;
    }

    // Group marks by sentence, sort groups by position
    const groups = new Map<number, ErrorMark[]>();
    for (const m of marks) {
      const list = groups.get(m.sentenceFrom) || [];
      list.push(m);
      groups.set(m.sentenceFrom, list);
    }
    const sortedGroups = [...groups.entries()].sort((a, b) => a[0] - b[0]);

    this.emptyEl.style.display = 'none';
    this.hintEl.style.display = 'none';
    this.listEl.style.display = 'flex';
    this.listEl.empty();
    this.scanBtn.style.display = 'block';

    for (const [sentenceFrom, groupMarks] of sortedGroups) {
      groupMarks.sort((a, b) => a.from - b.from);
      this.listEl.appendChild(
        this.createSentenceGroup(sentenceFrom, groupMarks, filePath, newIds)
      );
    }
  }

  /** Create a collapsible sentence group: header with text + apply-all, then error items. */
  private createSentenceGroup(sentenceFrom: number, marks: ErrorMark[], filePath: string, newIds: Set<string>): HTMLElement {
    const group = document.createElement('div');
    group.className = 'langghost-sentence-group';

    // Header
    const header = document.createElement('div');
    header.className = 'langghost-sentence-header';

    const toggle = document.createElement('span');
    toggle.className = 'langghost-sentence-toggle';
    toggle.textContent = '▼';

    const text = document.createElement('span');
    text.className = 'langghost-sentence-text';
    const raw = marks[0]?.error.sentence || '';
    text.textContent = raw.length > 60 ? raw.substring(0, 57) + '...' : raw;

    const count = document.createElement('span');
    count.className = 'langghost-sentence-count';
    count.textContent = `${marks.length} errors`;

    const applyAll = document.createElement('button');
    applyAll.className = 'langghost-sentence-apply-all';
    applyAll.textContent = '应用整句';
    applyAll.addEventListener('click', (e) => {
      e.stopPropagation();
      this.plugin.applyAllInSentence(filePath, sentenceFrom);
    });

    header.appendChild(toggle);
    header.appendChild(text);
    header.appendChild(count);
    header.appendChild(applyAll);

    // Error list
    const errorList = document.createElement('div');
    errorList.className = 'langghost-sentence-errors';

    for (const mark of marks) {
      errorList.appendChild(this.createErrorItem(mark, filePath, newIds.has(mark.error.id)));
    }

    // Toggle collapse
    header.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      const collapsed = errorList.style.display === 'none';
      errorList.style.display = collapsed ? 'block' : 'none';
      toggle.textContent = collapsed ? '▼' : '▶';
    });

    group.appendChild(header);
    group.appendChild(errorList);
    return group;
  }

  /** Create a single error item inside a sentence group. */
  private createErrorItem(mark: ErrorMark, filePath: string, isNew: boolean): HTMLElement {
    const item = document.createElement('div');
    item.className = isNew ? 'langghost-error-item langghost-error-fresh' : 'langghost-error-item';

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
    corr.textContent = mark.error.corrected || '[需翻译]';

    fix.appendChild(orig);
    fix.appendChild(arrow);
    fix.appendChild(corr);
    item.appendChild(fix);

    // Meta: type tag + explanation
    const meta = document.createElement('div');
    meta.className = 'langghost-sidebar-meta';

    const typeTag = document.createElement('span');
    typeTag.className = `langghost-sidebar-type langghost-sidebar-type-${mark.error.type}`;
    typeTag.textContent = TYPE_LABELS[mark.error.type?.toLowerCase()] || mark.error.type;

    const explain = document.createElement('span');
    explain.className = 'langghost-sidebar-explain';
    explain.textContent = mark.error.explanation || TYPE_LABELS[mark.error.type?.toLowerCase()] || mark.error.type;

    meta.appendChild(typeTag);
    meta.appendChild(explain);
    item.appendChild(meta);

    // Actions: apply + ignore (no apply-all here, that's on the group header)
    const actions = document.createElement('div');
    actions.className = 'langghost-sidebar-actions';

    const errorId = mark.error.id;

    const hasCorrection = !!mark.error.corrected;

    const applyBtn = document.createElement('button');
    applyBtn.className = 'langghost-sidebar-apply';
    applyBtn.textContent = '应用';
    applyBtn.disabled = !hasCorrection;
    if (hasCorrection) {
      applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.plugin.applyFix(filePath, errorId);
      });
    }

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

    // Click to navigate
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

  private navigateToError(errorId: string, filePath: string): void {
    const mark = this.markStore.getMarks(filePath).find(m => m.error.id === errorId);
    if (!mark) return;

    const cm = this.getEditorForFile(filePath);
    if (!cm) return;

    const pos = Math.min(mark.from, cm.state.doc.length);
    cm.dispatch({
      selection: { anchor: pos },
      scrollIntoView: true,
    });

    cm.focus();
  }

  private showEmpty(state: string, msg?: string): void {
    this.emptyEl.textContent = msg ?? '没有发现错误';
    this.emptyEl.className = `langghost-sidebar-empty langghost-empty-${state}`;
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

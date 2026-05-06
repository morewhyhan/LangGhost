import { Plugin, MarkdownView } from 'obsidian';
import { StateField, type Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS, type LangGhostSettings, type ErrorMark, markStoreChangedEffect } from './src/types';
import { LangGhostSettingTab } from './src/settings';
import { MarkStore } from './src/markStore';
import { AIChecker } from './src/checker';
import { Dispatcher } from './src/dispatcher';
import { LocalLinter } from './src/linter';
import { ErrorBook } from './src/errorBook';
import { Persistence } from './src/persistence';
import { createDetectorExtension } from './src/detector';
import { createDecorationsExtension } from './src/decorations';
import { createTooltipExtension } from './src/tooltip';
import { LangGhostSidebarView } from './src/sidebarView';

export default class LangGhostPlugin extends Plugin {
  settings: LangGhostSettings = DEFAULT_SETTINGS;
  statusBarEl: HTMLElement;
  markStore: MarkStore;
  checker: AIChecker;
  linter: LocalLinter;
  dispatcher: Dispatcher;
  errorBook: ErrorBook;
  persistence: Persistence;

  async onload() {
    await this.loadSettings();

    // Status bar
    this.statusBarEl = this.addStatusBarItem();

    // Status update callback
    const updateStatus = (msg: string) => {
      // Preserve linter init error when other modules try to clear status
      if (msg === '' && this.linter?.initError) {
        this.statusBarEl.setText(this.linter.initError);
      } else {
        this.statusBarEl.setText(msg);
      }
    };

    // Create core modules
    this.markStore = new MarkStore();
    this.checker = new AIChecker(() => this.settings, updateStatus);

    // Read WASM binary and create Blob URL (avoids app://local/ URL issues)
    const adapter = this.app.vault.adapter as any;
    const wasmRelPath = `${this.app.vault.configDir}/plugins/${this.manifest.id}/harper_wasm_bg.wasm`;
    const wasmBinary = await adapter.readBinary(wasmRelPath);
    const wasmBlob = new Blob([wasmBinary], { type: 'application/wasm' });
    const wasmUrl = URL.createObjectURL(wasmBlob);

    this.linter = new LocalLinter(updateStatus, wasmUrl);
    this.dispatcher = new Dispatcher(this.markStore, this.checker, this.linter, () => this.settings);
    this.errorBook = new ErrorBook(this.app, () => this.settings);
    this.persistence = new Persistence(this, this.markStore);

    // Initialize local linter in background (non-blocking)
    this.linter.init();

    // Restore ignored state on startup (must be before any addMarks calls)
    await this.persistence.restore();

    // Connect markStore changes to persistence + force decoration rebuild
    this.markStore.addListener((filePath: string) => {
      this.persistence.scheduleSave();
      // Use setTimeout(0) instead of queueMicrotask to avoid racing with
      // CM6 update cycle — queueMicrotask can dispatch while the current
      // update is still flushing, causing position desync.
      setTimeout(() => {
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
          const view = leaf.view as MarkdownView;
          if (view.file?.path === filePath) {
            const cm = (view.editor as any).cm as EditorView;
            if (cm) {
              cm.dispatch({ effects: markStoreChangedEffect.of() });
            }
          }
        }
      }, 0);
    });

    // Create CM6 StateFields for sharing references
    const markStoreField = StateField.define<MarkStore>({
      create: () => this.markStore,
      update: (v) => v,
    });
    const dispatcherField = StateField.define<Dispatcher>({
      create: () => this.dispatcher,
      update: (v) => v,
    });
    const pluginField = StateField.define<LangGhostPlugin>({
      create: () => this,
      update: (v) => v,
    });

    // Register CM6 extensions
    this.registerEditorExtension([
      markStoreField,
      dispatcherField,
      pluginField,
      createDetectorExtension(
        markStoreField,
        dispatcherField,
        () => this.settings
      ),
      createDecorationsExtension(markStoreField, dispatcherField, pluginField),
      createTooltipExtension(markStoreField, dispatcherField, pluginField),
    ]);

    // Keyboard shortcut: apply fix at cursor
    this.addCommand({
      id: 'apply-fix',
      name: 'LangGhost: Apply fix at cursor',
      editorCallback: (_editor, view) => {
        if (!view.file) return;
        const cm = (view.editor as any).cm as EditorView;
        if (!cm) return;
        const pos = cm.state.selection.main.head;
        const marks = this.markStore.getMarks(view.file.path);
        // Find mark whose range contains or is nearest to cursor
        const mark = marks.find(m => pos >= m.from && pos <= m.to);
        if (mark) {
          this.applyFix(view.file.path, mark.error.id);
        }
      },
    });

    // Keyboard shortcut: apply all fixes in current sentence
    this.addCommand({
      id: 'apply-sentence',
      name: 'LangGhost: Apply all fixes in sentence',
      editorCallback: (_editor, view) => {
        if (!view.file) return;
        const cm = (view.editor as any).cm as EditorView;
        if (!cm) return;
        const pos = cm.state.selection.main.head;
        const marks = this.markStore.getMarks(view.file.path);
        // Find the mark at or nearest to cursor, get its sentence
        const mark = marks.find(m => pos >= m.from && pos <= m.to);
        if (mark) {
          this.applyAllInSentence(view.file.path, mark.sentenceFrom);
        }
      },
    });

    // Settings tab
    this.addSettingTab(new LangGhostSettingTab(this.app, this));

    // Toggle command
    this.addCommand({
      id: 'toggle-langghost',
      name: 'LangGhost: Enable/Disable checking',
      callback: () => {
        this.settings.enabled = !this.settings.enabled;
        this.saveSettings();
        this.statusBarEl.setText(
          this.settings.enabled ? '' : 'LangGhost: off'
        );
        // Force decoration rebuild on all editors
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
          const view = leaf.view as MarkdownView;
          const cm = (view.editor as any).cm as EditorView;
          if (cm) {
            cm.dispatch({ effects: markStoreChangedEffect.of() });
          }
        }
        // Force sidebar refresh
        for (const leaf of this.app.workspace.getLeavesOfType(LangGhostSidebarView.VIEW_TYPE)) {
          (leaf.view as LangGhostSidebarView).requestRefresh();
        }
      },
    });

    // Sidebar
    this.registerView(LangGhostSidebarView.VIEW_TYPE, (leaf) =>
      new LangGhostSidebarView(leaf, this.markStore, this.dispatcher, this)
    );
    // Defer opening until workspace layout is ready
    // Only auto-open on first run; after that let Obsidian handle workspace restoration
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.firstRun) {
        if (!this.app.workspace.getLeavesOfType(LangGhostSidebarView.VIEW_TYPE).length) {
          this.app.workspace.getRightLeaf(false).setViewState({
            type: LangGhostSidebarView.VIEW_TYPE,
            active: false,
          });
        }
        this.settings.firstRun = false;
        this.saveSettings();
      }
    });

    // Restore marks from persistence when a file is opened / becomes active,
    // and force a decoration + sidebar refresh.  This covers tab switches,
    // quick-switcher, search clicks, and split-pane focus changes.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (!leaf) return;
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file) {
          const filePath = view.file.path;
          const cm = (view.editor as any).cm as EditorView;
          // Only restore if we have NO raw marks at all for this file.
          // Use hasMarks() (unfiltered) — NOT getMarks() which filters
          // ignored marks and would trigger false restores + duplicates.
          if (!this.markStore.hasMarks(filePath)) {
            const docText = cm?.state?.doc?.toString() ?? '';
            if (docText) {
              this.persistence.restoreFile(filePath, docText).then((marks) => {
                if (marks.length > 0) {
                  this.markStore.addMarks(filePath, marks);
                }
              });
            }
          }
          // Force decoration rebuild for the newly active editor
          if (cm) {
            cm.dispatch({ effects: markStoreChangedEffect.of() });
          }
        }
      })
    );

    // Clear ignored state when a file is opened — starts a new editing session.
    // Per PRD: close and reopen a file means errors reappear.
    // Note: we keep marks for persistence; only clear the in-memory ignored set.
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file) {
          this.markStore.onFileOpen(file.path);
        }
      })
    );

    console.log('LangGhost loaded');
  }

  /** Apply a single error fix by errorId. Used by tooltip, sidebar, and
   *  keyboard shortcut. Returns true if the fix was applied. */
  applyFix(filePath: string, errorId: string): boolean {
    const mark = this.markStore.getMarks(filePath).find(m => m.error.id === errorId);
    if (!mark) return false;

    const cm = this.getEditorForFile(filePath);
    if (!cm) return false;

    const doc = cm.state.doc;
    const from = Math.min(mark.from, doc.length);
    const to = Math.min(mark.to, doc.length);
    if (from >= to) return false;
    if (doc.sliceString(from, to) !== mark.error.original) return false;

    this.markStore.removeMark(filePath, mark.error.id);

    cm.dispatch({ changes: { from, to, insert: mark.error.corrected } });
    this.errorBook.appendError(mark.error);
    return true;
  }

  /** Apply all fixes in one sentence at once in a single CM6 transaction. */
  applyAllInSentence(filePath: string, sentenceFrom: number): boolean {
    const allMarks = this.markStore.getMarks(filePath);
    const sentenceMarks = allMarks.filter(
      m => m.sentenceFrom === sentenceFrom && m.from < m.to
    );
    if (sentenceMarks.length === 0) return false;

    const cm = this.getEditorForFile(filePath);
    if (!cm) return false;

    const doc = cm.state.doc;
    // Sort right-to-left so earlier changes don't shift later positions
    sentenceMarks.sort((a, b) => b.from - a.from);

    const changes: { from: number; to: number; insert: string }[] = [];
    const validMarks: ErrorMark[] = [];

    for (const m of sentenceMarks) {
      const f = Math.min(m.from, doc.length);
      const t = Math.min(m.to, doc.length);
      if (f >= t) continue;
      if (doc.sliceString(f, t) !== m.error.original) continue;
      changes.push({ from: f, to: t, insert: m.error.corrected });
      validMarks.push(m);
    }

    if (changes.length === 0) return false;

    // Remove all marks, dispatch combined change
    for (const m of validMarks) {
      this.markStore.removeMark(filePath, m.error.id);
    }
    cm.dispatch({ changes });
    for (const m of validMarks) {
      this.errorBook.appendError(m.error);
    }
    // Recheck: pass empty replaceIds since all sentence marks were already removed
    this.dispatcher.recheckAroundSeamless(
      filePath,
      changes[changes.length - 1].from + changes[changes.length - 1].insert.length,
      cm.state.doc,
      []
    );
    return true;
  }

  /** Get the CM6 EditorView for a given file path. */
  getEditorForFile(filePath: string): EditorView | null {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view as MarkdownView;
      if (view.file?.path === filePath) {
        const cm = (view.editor as any).cm as EditorView;
        if (cm) return cm;
      }
    }
    return null;
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(LangGhostSidebarView.VIEW_TYPE);
    await this.persistence.save();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

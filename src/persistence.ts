import type { Plugin } from 'obsidian';
import type { ErrorItem, ErrorMark, PersistedError } from './types';
import { MarkStore } from './markStore';

const MAX_ERRORS = 1000;
const MAX_PER_FILE = 50;
const MAX_AGE_DAYS = 30;

export class Persistence {
  private plugin: Plugin;
  private markStore: MarkStore;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(plugin: Plugin, markStore: MarkStore) {
    this.plugin = plugin;
    this.markStore = markStore;
  }

  async save(): Promise<void> {
    const data = await this.plugin.loadData() ?? {};
    const marks = this.markStore.getAllMarks();
    const persisted = this.toPersisted(marks);
    data.langghostErrors = persisted;
    // Persist ignored state so marks don't reappear after restart
    data.langghostIgnored = this.markStore.getIgnoredSnapshot();
    await this.plugin.saveData(data);

    // Clean up in-memory marks for files no longer open in any pane
    this.cleanupClosedFiles();
  }

  scheduleSave(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.save();
    }, 1000);
  }

  async restore(): Promise<void> {
    // Restore ignored state on startup so previously-ignored marks
    // stay hidden across Obsidian restarts.
    const data = await this.plugin.loadData() ?? {};
    const ignoredSnapshot: Record<string, string[]> | undefined = data.langghostIgnored;
    if (ignoredSnapshot) {
      this.markStore.restoreIgnored(ignoredSnapshot);
    }
  }

  async restoreFile(filePath: string, docText: string): Promise<ErrorMark[]> {
    const data = await this.plugin.loadData() ?? {};
    const persisted: PersistedError[] = data.langghostErrors ?? [];
    const now = Date.now();
    const cutoff = now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

    const marks: ErrorMark[] = [];

    for (const pe of persisted) {
      if (pe.filePath !== filePath) continue;
      if (pe.createdAt < cutoff) continue;

      // Validate surrounding text
      const start = Math.max(0, pe.from - 25);
      const end = Math.min(docText.length, pe.to + 25);
      const currentSurrounding = docText.substring(start, end);

      if (!currentSurrounding.includes(pe.error.original)) continue;

      // Recalculate positions by finding the original text in the document
      const idx = findBestMatch(docText, pe.error.original, pe.from);
      if (idx === -1) continue;

      const sentOffset = pe.error.sentence.indexOf(pe.error.original);
      marks.push({
        error: pe.error,
        from: idx,
        to: idx + pe.error.original.length,
        sentenceFrom: sentOffset !== -1 ? Math.max(0, idx - sentOffset) : Math.max(0, idx - 50),
        sentenceTo: sentOffset !== -1 ? Math.max(0, idx - sentOffset) + pe.error.sentence.length : idx + pe.error.original.length + 50,
      });

      if (marks.length >= MAX_PER_FILE) break;
    }

    return marks;
  }

  private cleanupClosedFiles(): void {
    const openPaths = new Set<string>();
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view?.file?.path) {
        openPaths.add(view.file.path);
      }
    }
    this.markStore.cleanupClosedFiles(openPaths);
  }

  private toPersisted(allMarks: Map<string, ErrorMark[]>): PersistedError[] {
    const result: PersistedError[] = [];
    const now = Date.now();

    for (const [filePath, marks] of allMarks) {
      for (const mark of marks) {
        const start = Math.max(0, mark.from - 25);
        const end = start + 50;
        result.push({
          error: mark.error,
          from: mark.from,
          to: mark.to,
          surroundingText: '', // Will be validated against live doc
          filePath,
          createdAt: mark.error.createdAt || now,
        });
      }
    }

    // Trim to max
    if (result.length > MAX_ERRORS) {
      result.sort((a, b) => b.createdAt - a.createdAt);
      result.length = MAX_ERRORS;
    }

    return result;
  }
}

/** Find the best match for `original` in `text`, preferring positions near `hintPos`.
 *  1. Try near the hinted position first
 *  2. If not found, search the entire document and pick the closest match */
function findBestMatch(text: string, original: string, hintPos: number): number {
  // Try near the hinted position first (±50 chars window)
  const nearIdx = text.indexOf(original, Math.max(0, hintPos - 50));
  if (nearIdx !== -1 && nearIdx <= hintPos + 50) return nearIdx;

  // Search entire document, pick occurrence closest to hintPos
  let bestIdx = -1;
  let bestDist = Infinity;
  let searchFrom = 0;
  while (searchFrom <= text.length) {
    const found = text.indexOf(original, searchFrom);
    if (found === -1) break;
    const dist = Math.abs(found - hintPos);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = found;
    }
    searchFrom = found + 1;
  }
  return bestIdx;
}

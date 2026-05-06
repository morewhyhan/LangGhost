import type { ErrorMark } from './types';

export class MarkStore {
  private marks: Map<string, ErrorMark[]> = new Map();
  private ignored: Map<string, Set<string>> = new Map();
  private listeners: Set<(filePath: string) => void> = new Set();
  /** Per-file fingerprint of the last mapped change — prevents double-mapping
   *  when the same file is open in multiple split panes. */
  private lastMappedKey: Map<string, string> = new Map();

  /** Serialize ignored state for persistence (filePath → errorIds). */
  getIgnoredSnapshot(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [filePath, ids] of this.ignored) {
      if (ids.size > 0) result[filePath] = [...ids];
    }
    return result;
  }

  /** Restore ignored state from persistence. */
  restoreIgnored(snapshot: Record<string, string[]>): void {
    for (const [filePath, ids] of Object.entries(snapshot)) {
      this.ignored.set(filePath, new Set(ids));
    }
  }

  addListener(fn: (filePath: string) => void): void {
    this.listeners.add(fn);
  }

  removeListener(fn: (filePath: string) => void): void {
    this.listeners.delete(fn);
  }

  addMarks(filePath: string, marks: ErrorMark[]): void {
    const existing = this.marks.get(filePath) ?? [];
    const accepted: ErrorMark[] = [];
    const newMarks = marks.filter(m => {
      // Dedup by error.id
      if (existing.some(e => e.error.id === m.error.id)) return false;
      // Skip if overlapping with an existing or already-accepted mark
      const all = existing.concat(accepted);
      if (all.some(e => m.from < e.to && m.to > e.from)) return false;
      accepted.push(m);
      return true;
    });
    if (newMarks.length === 0) return;
    this.marks.set(filePath, [...existing, ...newMarks]);
    this.notify(filePath);
  }

  removeMark(filePath: string, errorId: string): void {
    const marks = this.marks.get(filePath);
    if (marks) {
      this.marks.set(filePath, marks.filter(m => m.error.id !== errorId));
      this.notify(filePath);
    }
  }

  removeMarksById(filePath: string, errorIds: string[]): void {
    const marks = this.marks.get(filePath);
    if (!marks || errorIds.length === 0) return;
    const idSet = new Set(errorIds);
    this.marks.set(filePath, marks.filter(m => !idSet.has(m.error.id)));
    this.notify(filePath);
  }

  getMarks(filePath: string): ErrorMark[] {
    const marks = this.marks.get(filePath) ?? [];
    const ignoredSet = this.ignored.get(filePath);
    if (!ignoredSet) return marks;
    return marks.filter(m => !ignoredSet.has(m.error.id));
  }

  /** Check if raw (unfiltered) marks exist for a file — used to decide
   *  whether persistence restore is needed.  Unlike getMarks() this does
   *  NOT filter out ignored marks. */
  hasMarks(filePath: string): boolean {
    const marks = this.marks.get(filePath);
    return !!marks && marks.length > 0;
  }

  clearSentenceMarks(filePath: string, from: number, to: number): void {
    const marks = this.marks.get(filePath);
    if (marks) {
      this.marks.set(
        filePath,
        marks.filter(m => m.from < from || m.to > to)
      );
      this.notify(filePath);
    }
  }

  clearAllMarks(filePath: string): void {
    this.marks.set(filePath, []);
    this.notify(filePath);
  }

  ignore(filePath: string, errorId: string): void {
    if (!this.ignored.has(filePath)) {
      this.ignored.set(filePath, new Set());
    }
    this.ignored.get(filePath)!.add(errorId);
    this.notify(filePath);
  }

  isIgnored(filePath: string, errorId: string): boolean {
    return this.ignored.get(filePath)?.has(errorId) ?? false;
  }

  findOverlap(filePath: string, from: number, to: number): ErrorMark | null {
    const marks = this.marks.get(filePath) ?? [];
    return marks.find(m => m.from < to && m.to > from) ?? null;
  }

  getAllMarks(): Map<string, ErrorMark[]> {
    return new Map(this.marks);
  }

  /** Map mark positions through document changes (called during CM6 update, no notify).
   *  changeKey is a fingerprint of the change (fromA:toA:insertedLength) used to
   *  prevent double-mapping when the same file is open in multiple panes —
   *  each pane's CM6 sync produces the same fingerprint, so the second call is a no-op. */
  mapPositions(filePath: string, mapFn: (pos: number) => number, changeKey: string): void {
    const marks = this.marks.get(filePath);
    if (!marks) return;
    // Guard: skip if this exact change was already mapped (split-pane sync)
    if (this.lastMappedKey.get(filePath) === changeKey) return;
    this.lastMappedKey.set(filePath, changeKey);
    for (const mark of marks) {
      mark.from = mapFn(mark.from);
      mark.to = mapFn(mark.to);
      mark.sentenceFrom = mapFn(mark.sentenceFrom);
      mark.sentenceTo = mapFn(mark.sentenceTo);
    }
    // Remove collapsed marks (text was deleted within mark range)
    this.marks.set(filePath, marks.filter(m => m.from < m.to));
  }

  onFileOpen(filePath: string): void {
    // Placeholder for persistence restore
  }

  onFileClose(filePath: string): void {
    // Only clear ignored set on file close, keep marks for persistence
    this.ignored.delete(filePath);
  }

  /** Remove in-memory marks for files no longer open in any pane. */
  cleanupClosedFiles(openPaths: Set<string>): void {
    for (const path of [...this.marks.keys()]) {
      if (!openPaths.has(path)) {
        this.marks.delete(path);
        this.ignored.delete(path);
        this.lastMappedKey.delete(path);
      }
    }
  }

  private notify(filePath: string): void {
    for (const fn of this.listeners) {
      fn(filePath);
    }
  }
}

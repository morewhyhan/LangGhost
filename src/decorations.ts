import { ViewPlugin, Decoration, type DecorationSet, type ViewUpdate, type EditorView, type Range } from '@codemirror/view';
import { type StateField } from '@codemirror/state';
import { editorInfoField } from 'obsidian';
import type { MarkStore } from './markStore';
import type { Dispatcher } from './dispatcher';
import type LangGhostPlugin from '../main';
import { markStoreChangedEffect, highlightErrorEffect, type SentenceRange } from './types';

const CLASS_MAP: Record<string, string> = {
  grammar: 'langghost-grammar',
  spelling: 'langghost-spelling',
  expression: 'langghost-expression',
  translation: 'langghost-translation',
};

export function createDecorationsExtension(
  markStoreField: StateField<MarkStore>,
  dispatcherField: StateField<Dispatcher>,
  pluginField: StateField<LangGhostPlugin>
): unknown {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        // Map mark positions through document changes FIRST, so all positions
        // are in the post-change coordinate system.
        const ms = update.state.field(markStoreField);
        const info = update.state.field(editorInfoField);
        const fp = (info as any).file?.path;
        if (fp) {
          // Build a fingerprint of this change so markStore can detect
          // and skip the duplicate mapping that occurs when the same file
          // is open in a second split pane (Obsidian syncs the change there).
          let changeKey = '';
          update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
            changeKey += `${fromA}:${toA}:${inserted.length}|`;
          });
          // Clamp stale positions to document length before mapping.
          // Restored marks may have positions from a different document version
          // that exceed the current length — mapPos would throw RangeError.
          const docLen = update.startState.doc.length;
          ms.mapPositions(fp, (pos) => update.changes.mapPos(Math.min(pos, docLen)), changeKey);
        }

        // After mapping, validate marks near the change against the CURRENT
        // (post-change) document.  This catches ALL stale marks in one pass:
        //  - marks that were already stale before this change
        //  - marks that became stale because of this change (user edited the word)
        this.validateMarks(update);
      }

      const marksChanged = update.transactions.some(tr =>
        tr.effects.some(e => e.is(markStoreChangedEffect))
      );

      if (update.docChanged || update.viewportChanged || marksChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    /** Validate ALL marks against the post-change document.
     *  Always checks text match (cheap) for every mark — catches stale marks
     *  that slipped through mapPositions due to edge cases (changeKey collision,
     *  file.path null, split-pane sync race, etc.).
     *  Sentence rechecks (expensive AI) are still gated by nearChange. */
    private validateMarks(update: ViewUpdate) {
      const markStore = update.state.field(markStoreField);
      const info = update.state.field(editorInfoField);
      const filePath = (info as any).file?.path;
      if (!filePath) return;

      // Use unfiltered to include resolved marks (for undo detection)
      const allMarks = markStore.getAllMarksUnfiltered(filePath);
      const doc = update.state.doc;

      const changedRanges: { from: number; to: number }[] = [];
      update.changes.iterChanges((_fromA, _toA, fromB, toB) => {
        changedRanges.push({ from: fromB, to: toB });
      });

      const toRemove: string[] = [];
      const plugin = update.state.field(pluginField);
      const dispatcher = update.state.field(dispatcherField);
      const pendingRechecks: Map<number, SentenceRange> = new Map();

      for (const mark of allMarks) {
        const from = Math.min(mark.from, doc.length);
        const to = Math.min(mark.to, doc.length);
        if (from >= to) {
          toRemove.push(mark.error.id);
          continue;
        }
        const currentText = doc.sliceString(from, to);

        if (mark.resolved) {
          // Resolved mark: if user undid the fix (text matches original again),
          // un-resolve it so the error reappears.
          if (currentText === mark.error.original) {
            mark.resolved = false;
            markStore.notify(filePath);
          }
          continue;
        }

        // Non-resolved mark: text no longer matches → stale or user edited it.
        if (currentText !== mark.error.original) {
          if (mark.error.corrected && currentText === mark.error.corrected) {
            // User manually applied the suggested fix → resolve it so
            // undo can revive the mark (same as clicking "应用").
            mark.resolved = true;
            plugin.errorBook.appendError(mark.error);
            markStore.notify(filePath);
          } else {
            // User wrote something else → remove mark permanently.
            toRemove.push(mark.error.id);
            plugin.errorBook.appendError(mark.error);
          }

          // Only recheck sentence for marks near the change (expensive AI call)
          // AND only when user typed new content (not a fix application).
          // This prevents recheck loops where AI keeps finding false positives.
          const nearChange = changedRanges.some(
            r => mark.from <= r.to && mark.to >= r.from
          );
          if (!nearChange || !plugin.settings.enabled) continue;
          // Skip recheck if the current text matches the corrected form —
          // that means the user applied a fix, not typed new content.
          if (mark.error.corrected && currentText === mark.error.corrected) continue;
          const sentenceStart = mark.sentenceFrom;
          if (!pendingRechecks.has(sentenceStart)) {
            const sentenceEnd = Math.min(mark.sentenceTo, doc.length);
            const sentenceText = doc.sliceString(
              Math.max(0, sentenceStart),
              sentenceEnd
            );
            if (sentenceText) {
              pendingRechecks.set(sentenceStart, {
                text: sentenceText,
                from: Math.max(0, sentenceStart),
                to: sentenceEnd,
              });
            }
          }
        }
      }

      for (const id of toRemove) {
        markStore.removeMark(filePath, id);
      }

      for (const [, sentence] of pendingRechecks) {
        dispatcher.recheck(sentence, filePath);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const markStore = view.state.field(markStoreField);
      const info = view.state.field(editorInfoField);
      const plugin = view.state.field(pluginField);
      const filePath = (info as any).file?.path;
      if (!filePath) return Decoration.none;
      if (!plugin.settings.enabled) return Decoration.none;

      const marks = markStore.getMarks(filePath);
      if (marks.length === 0) return Decoration.none;

      // Validate marks against current document — catches stale marks from
      // async persistence restore that slipped through mapPositions.
      const doc = view.state.doc;
      const staleIds: string[] = [];
      const validMarks = marks.filter(m => {
        if (m.from >= doc.length || m.to > doc.length || m.from >= m.to) {
          staleIds.push(m.error.id);
          return false;
        }
        if (doc.sliceString(m.from, m.to) !== m.error.original) {
          staleIds.push(m.error.id);
          return false;
        }
        return true;
      });

      // Defer removal to avoid side effects during decoration build
      if (staleIds.length > 0) {
        const ms = markStore;
        const fp = filePath;
        setTimeout(() => {
          for (const id of staleIds) ms.removeMark(fp, id);
        }, 0);
      }

      if (validMarks.length === 0) return Decoration.none;

      // Build decorations with try-catch per mark to prevent any crash
      const decorations: Range<Decoration>[] = [];
      for (const mark of validMarks) {
        if (mark.from < 0 || mark.from >= mark.to || mark.to > doc.length) continue;
        try {
          const cls = CLASS_MAP[mark.error.type?.toLowerCase()] || 'langghost-grammar';
          decorations.push(Decoration.mark({ class: cls }).range(mark.from, mark.to));
        } catch (e) {
          console.warn('LangGhost: skip invalid mark', mark.from, mark.to, mark.error.original);
        }
      }

      if (decorations.length === 0) return Decoration.none;
      return Decoration.set(decorations, true);
    }
  }, {
    decorations: (v: any) => v.decorations,
  });
}

/** Brief highlight flash for keyboard navigation between errors. */
export function createHighlightExtension(): unknown {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    timer: ReturnType<typeof setTimeout> | null = null;

    update(update: ViewUpdate) {
      for (const tr of update.transactions) {
        for (const e of tr.effects) {
          if (e.is(highlightErrorEffect) && e.value) {
            const { from, to } = e.value;
            const deco = Decoration.mark({
              class: 'langghost-highlight'
            }).range(from, to);
            this.decorations = Decoration.set([deco]);
            if (this.timer) clearTimeout(this.timer);
            this.timer = setTimeout(() => {
              this.decorations = Decoration.none;
              update.view.dispatch();
            }, 300);
          }
        }
      }
    }

    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  }, {
    decorations: (v: any) => v.decorations,
  });
}

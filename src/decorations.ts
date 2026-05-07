import { ViewPlugin, Decoration, type DecorationSet, type ViewUpdate, type EditorView } from '@codemirror/view';
import { type StateField } from '@codemirror/state';
import { editorInfoField } from 'obsidian';
import type { MarkStore } from './markStore';
import type { Dispatcher } from './dispatcher';
import type LangGhostPlugin from '../main';
import { markStoreChangedEffect, type SentenceRange } from './types';

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

    /** Check marks near the change region against the post-change document.
     *  If the text at a mark's mapped position no longer matches the original,
     *  the user edited it → remove the mark, record to error book, recheck.
     *
     *  Resolved marks: if the text now matches the original again (user undid
     *  a fix), un-resolve the mark so the error reappears. */
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
        const nearChange = changedRanges.some(
          r => mark.from <= r.to && mark.to >= r.from
        );
        if (!nearChange) continue;

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

        // Non-resolved mark: user edited the error word.
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

          if (!plugin.settings.enabled) continue;
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

      const decorations = marks.map(mark => {
        const cls = CLASS_MAP[mark.error.type?.toLowerCase()] || 'langghost-grammar';
        return Decoration.mark({
          class: cls,
        }).range(mark.from, mark.to);
      });

      return Decoration.set(decorations, true);
    }
  }, {
    decorations: (v: any) => v.decorations,
  });
}

import { ViewPlugin, hoverTooltip, type ViewUpdate, type EditorView } from '@codemirror/view';
import { type StateField } from '@codemirror/state';
import { editorInfoField } from 'obsidian';
import type { MarkStore } from './markStore';
import type { Dispatcher } from './dispatcher';
import type LangGhostPlugin from '../main';

export function createTooltipExtension(
  markStoreField: StateField<MarkStore>,
  dispatcherField: StateField<Dispatcher>,
  pluginField: StateField<LangGhostPlugin>
): unknown {
  return hoverTooltip(
    (view: EditorView, pos: number) => {
      const markStore = view.state.field(markStoreField);
      const info = view.state.field(editorInfoField);
      const filePath = (info as any).file?.path;
      if (!filePath) return null;

      const marks = markStore.getMarks(filePath);
      const mark = marks.find(m => pos >= m.from && pos <= m.to);
      if (!mark) return null;

      return {
        pos: mark.from,
        end: mark.to,
        create() {
          const dom = document.createElement('div');
          dom.className = 'langghost-tooltip';

          // Fix line
          const fix = document.createElement('div');
          fix.className = 'langghost-fix';
          fix.textContent = `${mark.error.original} → ${mark.error.corrected}`;
          dom.appendChild(fix);

          // Alternatives
          if (mark.error.alternatives && mark.error.alternatives.length > 0) {
            const alt = document.createElement('div');
            alt.className = 'langghost-alt';
            alt.textContent = '或: ' + mark.error.alternatives.join(', ');
            dom.appendChild(alt);
          }

          // Explanation
          const explain = document.createElement('div');
          explain.className = 'langghost-explain';
          explain.textContent = mark.error.explanation;
          dom.appendChild(explain);

          // Actions
          const actions = document.createElement('div');
          actions.className = 'langghost-actions';

          const applyBtn = document.createElement('button');
          applyBtn.className = 'langghost-apply';
          applyBtn.textContent = '应用';
          applyBtn.addEventListener('click', () => {
            const plugin = view.state.field(pluginField);
            const doc = view.state.doc;
            const freshMarks = markStore.getMarks(filePath);
            const freshMark = freshMarks.find(m => m.error.id === mark.error.id);
            if (!freshMark) return;

            const from = Math.min(freshMark.from, doc.length);
            const to = Math.min(freshMark.to, doc.length);
            if (from >= to) return;
            if (doc.sliceString(from, to) !== freshMark.error.original) return;

            // Remove mark BEFORE dispatching the text change to prevent
            // validateMarks from recording a duplicate error book entry.
            markStore.removeMark(filePath, freshMark.error.id);

            // Replace text
            view.dispatch({
              changes: { from, to, insert: freshMark.error.corrected }
            });

            // Record to error book
            plugin.errorBook.appendError(freshMark.error);

            // Do NOT recheck here — recheck clears ALL marks in the sentence
            // range (including other unrelated errors), causing wavy lines to
            // vanish. The decorations plugin's validateMarks handles stale
            // marks, and position mapping adjusts the surviving ones.
            // A new check will trigger on the next sentence-end character.
          });

          const ignoreBtn = document.createElement('button');
          ignoreBtn.className = 'langghost-ignore';
          ignoreBtn.textContent = '忽略';
          ignoreBtn.addEventListener('click', () => {
            markStore.ignore(filePath, mark.error.id);
          });

          actions.appendChild(applyBtn);
          actions.appendChild(ignoreBtn);
          dom.appendChild(actions);

          return { dom };
        },
        above: true,
      };
    },
    { hoverTime: 200 }
  );
}

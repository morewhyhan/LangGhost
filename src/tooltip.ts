import { hoverTooltip, type EditorView } from '@codemirror/view';
import { type StateField } from '@codemirror/state';
import { editorInfoField } from 'obsidian';
import type { MarkStore } from './markStore';
import type { Dispatcher } from './dispatcher';
import type LangGhostPlugin from '../main';
import type { ErrorMark } from './types';

const TYPE_LABELS: Record<string, string> = {
  grammar: '语法', spelling: '拼写', expression: '表达', translation: '翻译',
};

/** Build the fully corrected sentence by applying all marks' fixes. */
function buildCorrectedSentence(original: string, marks: ErrorMark[]): string {
  const patches = marks.map(m => ({
    pos: m.from - m.sentenceFrom,
    len: m.error.original.length,
    text: m.error.corrected,
  }));
  // Sort right-to-left so replacements don't shift earlier positions
  patches.sort((a, b) => b.pos - a.pos);
  let result = original;
  for (const p of patches) {
    if (p.pos < 0 || p.pos + p.len > result.length) continue;
    result = result.substring(0, p.pos) + p.text + result.substring(p.pos + p.len);
  }
  return result;
}

export function createTooltipExtension(
  markStoreField: StateField<MarkStore>,
  _dispatcherField: StateField<Dispatcher>,
  pluginField: StateField<LangGhostPlugin>
): unknown {
  return hoverTooltip(
    (view: EditorView, pos: number) => {
      const markStore = view.state.field(markStoreField);
      const info = view.state.field(editorInfoField);
      const filePath = (info as any).file?.path;
      if (!filePath) return null;

      const marks = markStore.getMarks(filePath);
      const mark = marks.find(m => pos >= m.from && pos < m.to);
      if (!mark) return null;

      // Get all marks in the same sentence for the preview
      const sentenceMarks = marks.filter(m => m.sentenceFrom === mark.sentenceFrom);
      const correctedSentence = buildCorrectedSentence(mark.error.sentence, sentenceMarks);

      return {
        pos: mark.from,
        end: mark.to,
        create() {
          const plugin = view.state.field(pluginField);
          const dom = document.createElement('div');
          dom.className = 'langghost-tooltip';

          // Sentence preview: original → corrected (only if there are changes)
          if (correctedSentence !== mark.error.sentence) {
            const preview = document.createElement('div');
            preview.className = 'langghost-preview';
            const originalLine = document.createElement('div');
            originalLine.className = 'langghost-preview-original';
            originalLine.textContent = mark.error.sentence;
            const arrow = document.createElement('div');
            arrow.className = 'langghost-preview-arrow';
            arrow.textContent = '↓';
            const correctedLine = document.createElement('div');
            correctedLine.className = 'langghost-preview-corrected';
            correctedLine.textContent = correctedSentence;
            preview.appendChild(originalLine);
            preview.appendChild(arrow);
            preview.appendChild(correctedLine);
            dom.appendChild(preview);
          }

          // Fix line: original → corrected
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
          explain.textContent = mark.error.explanation || TYPE_LABELS[mark.error.type?.toLowerCase()] || mark.error.type;
          dom.appendChild(explain);

          // Actions
          const actions = document.createElement('div');
          actions.className = 'langghost-actions';

          const applyBtn = document.createElement('button');
          applyBtn.className = 'langghost-apply';
          applyBtn.textContent = '应用';
          applyBtn.addEventListener('click', () => {
            plugin.applyFix(filePath, mark.error.id);
          });

          const applyAllBtn = document.createElement('button');
          applyAllBtn.className = 'langghost-apply-all';
          applyAllBtn.textContent = '应用整句';
          applyAllBtn.addEventListener('click', () => {
            plugin.applyAllInSentence(filePath, mark.sentenceFrom);
          });

          const ignoreBtn = document.createElement('button');
          ignoreBtn.className = 'langghost-ignore';
          ignoreBtn.textContent = '忽略';
          ignoreBtn.addEventListener('click', () => {
            markStore.ignore(filePath, mark.error.id);
          });

          actions.appendChild(applyBtn);
          actions.appendChild(applyAllBtn);
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

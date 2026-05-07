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

const BAR_COLORS: Record<string, string> = {
  grammar: '#e55', spelling: '#68f', expression: '#c90', translation: '#4a4',
};

/** Build the fully corrected sentence by applying all marks' fixes. */
function buildCorrectedSentence(original: string, marks: ErrorMark[]): string {
  const patches = marks.map(m => ({
    pos: m.from - m.sentenceFrom,
    len: m.error.original.length,
    text: m.error.corrected,
  }));
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

      const sentenceMarks = marks.filter(m => m.sentenceFrom === mark.sentenceFrom);
      const correctedSentence = buildCorrectedSentence(mark.error.sentence, sentenceMarks);
      const type = mark.error.type?.toLowerCase() || 'grammar';
      const barColor = BAR_COLORS[type] || BAR_COLORS.grammar;

      return {
        pos: mark.from,
        end: mark.to,
        create() {
          const plugin = view.state.field(pluginField);
          const dom = document.createElement('div');
          dom.className = 'langghost-tooltip';

          // Left color bar
          const bar = document.createElement('div');
          bar.className = 'langghost-tooltip-bar';
          bar.style.backgroundColor = barColor;
          dom.appendChild(bar);

          // Content wrapper
          const content = document.createElement('div');
          content.className = 'langghost-tooltip-content';

          // Type badge + explanation on one line
          const header = document.createElement('div');
          header.className = 'langghost-tooltip-header';

          const typeBadge = document.createElement('span');
          typeBadge.className = `langghost-tooltip-type langghost-tooltip-type-${type}`;
          typeBadge.textContent = TYPE_LABELS[type] || type;
          header.appendChild(typeBadge);

          const explainLabel = document.createElement('span');
          explainLabel.className = 'langghost-tooltip-explain';
          explainLabel.textContent = mark.error.explanation || '';
          header.appendChild(explainLabel);
          content.appendChild(header);

          // Fix line: original → corrected
          const fix = document.createElement('div');
          fix.className = 'langghost-fix';
          const origSpan = document.createElement('span');
          origSpan.className = 'langghost-fix-original';
          origSpan.textContent = mark.error.original;
          const arrSpan = document.createElement('span');
          arrSpan.className = 'langghost-fix-arrow';
          arrSpan.textContent = ' → ';
          const corrSpan = document.createElement('span');
          corrSpan.className = 'langghost-fix-corrected';
          corrSpan.textContent = mark.error.corrected || '[需翻译]';
          fix.appendChild(origSpan);
          fix.appendChild(arrSpan);
          fix.appendChild(corrSpan);
          content.appendChild(fix);

          // Alternatives
          if (mark.error.alternatives && mark.error.alternatives.length > 0) {
            const alt = document.createElement('div');
            alt.className = 'langghost-alt';
            alt.textContent = '或: ' + mark.error.alternatives.join(', ');
            content.appendChild(alt);
          }

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
            content.appendChild(preview);
          }

          // Actions
          const actions = document.createElement('div');
          actions.className = 'langghost-actions';

          const hasCorrection = !!mark.error.corrected;

          const applyBtn = document.createElement('button');
          applyBtn.className = 'langghost-apply';
          applyBtn.textContent = '应用';
          applyBtn.disabled = !hasCorrection;
          if (hasCorrection) {
            applyBtn.addEventListener('click', () => {
              // Fade tooltip out immediately — CM6 will clean up the DOM
              // on the next re-evaluation.
              dom.style.opacity = '0';
              dom.style.transition = 'opacity 80ms';
              plugin.applyFix(filePath, mark.error.id);
            });
          }

          const applyAllBtn = document.createElement('button');
          applyAllBtn.className = 'langghost-apply-all';
          applyAllBtn.textContent = '应用整句';
          applyAllBtn.addEventListener('click', () => {
            dom.style.opacity = '0';
            dom.style.transition = 'opacity 80ms';
            plugin.applyAllInSentence(filePath, mark.sentenceFrom);
          });

          const ignoreBtn = document.createElement('button');
          ignoreBtn.className = 'langghost-ignore';
          ignoreBtn.textContent = '忽略';
          ignoreBtn.addEventListener('click', () => {
            dom.style.opacity = '0';
            dom.style.transition = 'opacity 80ms';
            markStore.ignore(filePath, mark.error.id);
          });

          actions.appendChild(applyBtn);
          actions.appendChild(applyAllBtn);
          actions.appendChild(ignoreBtn);
          content.appendChild(actions);

          dom.appendChild(content);

          return { dom };
        },
        above: true,
      };
    },
    { hoverTime: 200 }
  );
}

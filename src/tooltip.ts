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
              dom.style.opacity = '0';
              dom.style.transition = 'opacity 80ms';
              plugin.applyFix(filePath, mark.error.id);
            });
          }

          const ignoreBtn = document.createElement('button');
          ignoreBtn.className = 'langghost-ignore';
          ignoreBtn.textContent = '忽略';
          ignoreBtn.addEventListener('click', () => {
            dom.style.opacity = '0';
            dom.style.transition = 'opacity 80ms';
            markStore.ignore(filePath, mark.error.id);
          });

          actions.appendChild(applyBtn);
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

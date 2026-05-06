import { ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { type StateField } from '@codemirror/state';
import { editorInfoField } from 'obsidian';
import { extractSentence } from './extractor';
import type { MarkStore } from './markStore';
import type { Dispatcher } from './dispatcher';
import type { LangGhostSettings } from './types';

const SENTENCE_END_CHARS = new Set(['.', '?', '!', '\u3002', '\uff1f', '\uff01', '\n']);

export function createDetectorExtension(
  markStoreField: StateField<MarkStore>,
  dispatcherField: StateField<Dispatcher>,
  getSettings: () => LangGhostSettings
): unknown {
  return ViewPlugin.fromClass(class {
    update(update: ViewUpdate) {
      if (!update.docChanged) return;

      const settings = getSettings();
      if (!settings.enabled) return;

      const dispatcher = update.state.field(dispatcherField);
      const info = update.state.field(editorInfoField);
      const filePath = (info as any).file?.path;
      if (!filePath) return;

      // Check if any change added a sentence-ending character
      update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        const insertedText = inserted.toString();
        for (const ch of insertedText) {
          if (SENTENCE_END_CHARS.has(ch)) {
            const triggerPos = fromB + insertedText.indexOf(ch);
            const sentence = extractSentence(update.state.doc, triggerPos);
            if (sentence) {
              dispatcher.dispatch(sentence, filePath);
            }
            return; // Only trigger once per change
          }
        }
      });
    }
  });
}

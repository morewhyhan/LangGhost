import { StateEffect } from '@codemirror/state';

/** Dispatch this effect to force the decorations ViewPlugin to rebuild */
export const markStoreChangedEffect = StateEffect.define<void>();

// LangGhost Type Definitions

export interface ErrorItem {
  id: string;
  original: string;
  corrected: string;
  alternatives?: string[];
  type: 'grammar' | 'spelling' | 'expression' | 'translation';
  explanation: string;
  source: 'local' | 'ai';
  context: string;
  sentence: string;
  createdAt: number;
}

export interface ErrorMark {
  error: ErrorItem;
  from: number;
  to: number;
  sentenceFrom: number;  // Document position of the sentence start, mapped through changes
  sentenceTo: number;    // Document position of the sentence end, mapped through changes
}

export interface SentenceRange {
  text: string;
  from: number;
  to: number;
}

export interface PersistedError {
  error: ErrorItem;
  from: number;
  to: number;
  surroundingText: string;
  filePath: string;
  createdAt: number;
}

export interface LangGhostSettings {
  apiKey: string;
  apiEndpoint: string;
  model: string;
  errorBookPath: string;
  enabled: boolean;
  autoScan: boolean;
  firstRun: boolean;
}

export const DEFAULT_SETTINGS: LangGhostSettings = {
  apiKey: '',
  apiEndpoint: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  errorBookPath: 'LangGhost/errors.md',
  enabled: true,
  autoScan: false,
  firstRun: true,
};

// harper.js raw format
export interface HarperLint {
  span: { start: number; end: number };
  suggestions: { replacement_text: string }[];
  rule_name: string;
}

// AI response format
export interface AICorrection {
  original: string;
  corrected: string;
  alternatives?: string[];
  context: string;
  type: 'expression' | 'translation';
  explanation: string;
}

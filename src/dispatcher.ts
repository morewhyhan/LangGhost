import type { ErrorItem, ErrorMark, SentenceRange, LangGhostSettings } from './types';
import type { MarkStore } from './markStore';
import type { AIChecker } from './checker';
import type { LocalLinter } from './linter';

export class Dispatcher {
  private markStore: MarkStore;
  private checker: AIChecker;
  private linter: LocalLinter;
  private getSettings: () => LangGhostSettings;
  private activeChecks: Map<string, Promise<void>> = new Map();
  private aiConcurrency = 0;
  private readonly AI_CONCURRENCY_LIMIT = 3;
  private aiQueue: Array<() => void> = [];

  constructor(markStore: MarkStore, checker: AIChecker, linter: LocalLinter, getSettings: () => LangGhostSettings) {
    this.markStore = markStore;
    this.checker = checker;
    this.linter = linter;
    this.getSettings = getSettings;
  }

  async dispatch(sentence: SentenceRange, filePath: string): Promise<void> {
    const key = filePath + ':' + sentence.text;

    if (this.activeChecks.has(key)) {
      return;
    }

    const promise = this.runCheck(sentence, filePath);
    this.activeChecks.set(key, promise);

    try {
      await promise;
    } catch (e) {
      console.error('LangGhost dispatch: error', e);
    } finally {
      this.activeChecks.delete(key);
    }
  }

  async recheck(sentence: SentenceRange, filePath: string): Promise<void> {
    this.markStore.clearSentenceMarks(filePath, sentence.from, sentence.to);
    await this.dispatch(sentence, filePath);
  }

  private async runCheck(sentence: SentenceRange, filePath: string): Promise<void> {
    // Phase 1: Local lint (fast, provides instant feedback)
    let localMarkIds: string[] = [];
    if (this.linter.isReady()) {
      try {
        const localErrors = await this.linter.lint(sentence.text);
        if (localErrors.length > 0) {
          const localMarks = errorsToMarks(localErrors, sentence);
          localMarkIds = localMarks.map(m => m.error.id);
          if (localMarks.length > 0) {
            this.markStore.addMarks(filePath, localMarks);
          }
        }
      } catch (e) {
        console.error('LangGhost: local lint error', e);
      }
    }

    // Phase 2: AI check (authoritative — supersedes local results)
    const settings = this.getSettings();
    if (!settings.apiKey) return; // No API key, keep local marks as fallback

    const aiErrors = await this.enqueueAI(() => this.checker.check(sentence.text));

    // Remove local marks by ID (position-safe), then add AI marks
    if (localMarkIds.length > 0) {
      this.markStore.removeMarksById(filePath, localMarkIds);
    }
    if (aiErrors.length > 0) {
      const aiMarks = errorsToMarks(aiErrors, sentence);
      if (aiMarks.length > 0) {
        this.markStore.addMarks(filePath, aiMarks);
      }
    }
  }

  /** Enqueue an AI task with concurrency limiting (max 3 concurrent). */
  private async enqueueAI<T>(fn: () => Promise<T>): Promise<T> {
    if (this.aiConcurrency >= this.AI_CONCURRENCY_LIMIT) {
      await new Promise<void>(resolve => this.aiQueue.push(resolve));
    }
    this.aiConcurrency++;
    try {
      return await fn();
    } finally {
      this.aiConcurrency--;
      const next = this.aiQueue.shift();
      if (next) next();
    }
  }
}

/** Find the correct position of `original` in `sentence`, using `context` to
 *  disambiguate when there are multiple occurrences. */
function findOriginalInSentence(sentence: string, original: string, context?: string): number {
  const positions: number[] = [];
  let searchFrom = 0;
  while (searchFrom <= sentence.length) {
    const idx = sentence.indexOf(original, searchFrom);
    if (idx === -1) break;
    positions.push(idx);
    searchFrom = idx + 1;
  }

  if (positions.length === 0) return -1;
  if (positions.length === 1) return positions[0];

  // Multiple occurrences: try to use context to find the right one
  if (context) {
    // First try: find context region in sentence, then pick occurrence inside it
    const ctxIdx = sentence.indexOf(context);
    if (ctxIdx !== -1) {
      for (const pos of positions) {
        if (pos >= ctxIdx && pos + original.length <= ctxIdx + context.length) {
          return pos;
        }
      }
    }
    // Second try: check if context appears near each occurrence
    for (const pos of positions) {
      const ctxStart = Math.max(0, pos - 30);
      const ctxEnd = Math.min(sentence.length, pos + original.length + 30);
      const surrounding = sentence.substring(ctxStart, ctxEnd);
      if (surrounding.includes(context)) {
        return pos;
      }
    }
  }

  // Fallback: return first occurrence
  return positions[0];
}

function errorsToMarks(errors: ErrorItem[], sentence: SentenceRange): ErrorMark[] {
  return errors.map(err => {
    const idx = findOriginalInSentence(sentence.text, err.original, err.context);
    if (idx === -1) {
      console.warn('LangGhost errorsToMarks: could not find original in sentence:', err.original, 'in:', sentence.text);
      return null;
    }
    return {
      error: err,
      from: sentence.from + idx,
      to: sentence.from + idx + err.original.length,
      sentenceFrom: sentence.from,
      sentenceTo: sentence.to,
    };
  }).filter((m): m is ErrorMark => m !== null);
}

import type { ErrorItem } from './types';

// Chinese explanations for common rules
const RULE_EXPLANATIONS: Record<string, string> = {
  'Spelling': '拼写错误',
  'Capitalization': '首字母大写',
  'A/An': '冠词 a/an',
  'SubjectVerbAgreement': '主谓一致',
  'WrongVerbForm': '动词形式错误',
  'PronounContractions': '代词缩写',
  'RepeatedWords': '重复词',
  'ItIs': 'it is',
  'OxfordComma': '牛津逗号',
  'LinkingVerbs': '系动词',
  'ComparisonConversions': '比较级',
  'PronounCase': '代词格',
  'TenseSequence': '时态一致',
  'Articles': '冠词',
  'Preposition': '介词',
  'Plural': '复数形式',
  'Possessive': '所有格',
  'Conjunction': '连词',
  'Adverb': '副词',
  'Punctuation': '标点',
  'Homophone': '同音词',
  'WordChoice': '用词选择',
  'Determiner': '限定词',
  'Inflection': '词形变化',
  'Ellipsis': '省略号',
  'Avoid': '避免用法',
};

function getExplanation(lintKind: string, message: string): string {
  for (const [key, value] of Object.entries(RULE_EXPLANATIONS)) {
    if (lintKind.includes(key)) {
      return value;
    }
  }
  const msg = message.replace(/<[^>]*>/g, '').trim();
  return msg.length > 15 ? msg.substring(0, 15) + '...' : msg;
}

export class LocalLinter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private linter: any = null;
  private _ready = false;
  private _initError: string | null = null;
  private onStatusChange: (msg: string) => void;
  private wasmUrl: string;

  constructor(onStatusChange: (msg: string) => void, wasmUrl: string) {
    this.onStatusChange = onStatusChange;
    this.wasmUrl = wasmUrl;
  }

  async init(): Promise<void> {
    this.onStatusChange('LangGhost loading...');

    try {
      const harper = await import('harper.js');

      const BinaryModule = harper.BinaryModule;
      const LocalLinterClass = harper.LocalLinter;

      if (!BinaryModule || !LocalLinterClass) {
        console.error('LangGhost: BinaryModule or LocalLinter not found');
        this.onStatusChange('LangGhost: init failed');
        return;
      }

      const binary = new BinaryModule(this.wasmUrl);
      const linter = new LocalLinterClass({ binary });

      await linter.setup();

      this.linter = linter;
      this._ready = true;
      this._initError = null;
      this.onStatusChange('');
    } catch (e) {
      console.error('LangGhost: failed to load harper.js', e);
      this._initError = 'LangGhost: 本地检查加载失败';
      this.onStatusChange(this._initError);
    } finally {
      URL.revokeObjectURL(this.wasmUrl);
    }
  }

  isReady(): boolean {
    return this._ready;
  }

  get initError(): string | null {
    return this._initError;
  }

  async lint(text: string): Promise<ErrorItem[]> {
    if (!this.linter || !this._ready) return [];

    try {
      // For mixed Chinese-English text, replace CJK + digits with spaces
      // so harper.js can parse the English portions. Positions stay 1:1.
      // Digits are included because "2点" → "2 " makes "from 2" look valid
      // to harper.js; replacing the digit too exposes "from" as an error.
      const mixedRegex = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u2e80-\u2eff\u3400-\u4dbf\uf900-\ufaff0-9]/;
      const hasCJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(text);
      const lintText = hasCJK ? text.replace(mixedRegex, ' ') : text;

      const lints = await this.linter.lint(lintText, { language: 'plaintext' });
      const results: ErrorItem[] = [];

      for (const lint of lints) {
        const span = lint.span();
        const suggestions = lint.suggestions();
        const kind = lint.lint_kind();
        const message = lint.message();
        const harperProblemText = lint.get_problem_text();

        if (suggestions.length === 0) continue;

        // For mixed text: only keep errors in English portions.
        // If harper's problem text differs from the original at the same
        // position, the error spans a CJK area — skip it.
        const originalText = text.substring(span.start, span.end);
        if (hasCJK && harperProblemText !== originalText) continue;

        const isSpelling = kind.toLowerCase().includes('spelling');
        const corrected = suggestions[0].get_replacement_text();
        const alternatives = suggestions.length > 1
          ? suggestions.slice(1).map((s: any) => s.get_replacement_text())
          : undefined;

        results.push({
          id: crypto.randomUUID(),
          original: hasCJK ? originalText : harperProblemText,
          corrected,
          alternatives,
          type: isSpelling ? 'spelling' : 'grammar',
          explanation: getExplanation(kind, message),
          source: 'local',
          context: text.substring(
            Math.max(0, span.start - 10),
            Math.min(text.length, span.end + 10)
          ),
          sentence: text,
          createdAt: Date.now(),
        });
      }

      return results;
    } catch (e) {
      console.error('LangGhost: lint error', e);
      return [];
    }
  }

  async destroy(): Promise<void> {
    this.linter = null;
    this._ready = false;
  }
}

import type { ErrorItem, LangGhostSettings, AICorrection } from './types';

const SYSTEM_PROMPT = `You are an English writing assistant. Find English errors; translate any Chinese.

Types:
- spelling: wrong letters (recieve→receive)
- grammar: wrong tense, agreement, article, preposition, verb form
- expression: awkward or wordy
- translation: Chinese text → English

Rules:
- Return ONE error per distinct problem. Split grammar and translation into separate errors.
- Any Chinese character → type "translation", provide English. Always a separate error from grammar.
- Check every English fragment; short ones often hide errors (e.g. "I from", "very like", "he don't")
- "original" must be the exact substring from the input. Chinese: exact Chinese chars. English: exact English word(s).
- explanation ≤15 Chinese chars (e.g. "过去时")
- context ≈20 surrounding chars
- no errors → return []
- output JSON: one object per error [{"original":"…","corrected":"…","type":"…","explanation":"…","context":"…"}]`;

const TRANSLATE_PROMPT = `Translate this Chinese text to English.
Return JSON: [{"original":"<Chinese>","corrected":"<English>","type":"translation","explanation":"翻译","context":"<Chinese>"}]`;

export class AIChecker {
  private getSettings: () => LangGhostSettings;
  private onStatusChange: (msg: string) => void;

  constructor(
    getSettings: () => LangGhostSettings,
    onStatusChange: (msg: string) => void
  ) {
    this.getSettings = getSettings;
    this.onStatusChange = onStatusChange;
  }

  async check(text: string): Promise<ErrorItem[]> {
    // Pure Chinese with no English: use translation-only prompt to avoid
    // the model misinterpreting imperative phrases (e.g. "检查全文") as commands.
    const settings = this.getSettings();
    if (!settings.apiKey) return [];
    const isPureChinese = !/[a-zA-Z]/.test(text) && /[\u4e00-\u9fff]/.test(text);
    const systemPrompt = isPureChinese ? TRANSLATE_PROMPT : SYSTEM_PROMPT;

    this.onStatusChange('AI checking...');
    const startTime = Date.now();

    try {
      let base = settings.apiEndpoint.replace(/\/$/, '');
      if (!base.endsWith('/chat/completions')) {
        base += '/chat/completions';
      }
      const endpoint = base;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model,
          max_tokens: 1024,
          temperature: 0,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: isPureChinese ? `Sentence: ${text}` : text },
          ],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        console.error('LangGhost checker: API error', response.status, errText);
        if (response.status === 401) {
          this.onStatusChange('Invalid API Key');
        } else if (response.status === 429) {
          this.onStatusChange('Rate limited, try later');
        } else {
          this.onStatusChange('AI check failed: ' + response.status);
        }
        return [];
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content ?? '';

      const corrections = parseJSON(content);
      if (!corrections) return [];

      return corrections.map((c): ErrorItem => {
        const t = ((c.type as string) || 'grammar').toLowerCase();
        const typeLabels: Record<string, string> = {
          grammar: '语法', spelling: '拼写', expression: '表达', translation: '翻译',
        };
        return {
          id: crypto.randomUUID(),
          original: c.original,
          corrected: c.corrected,
          alternatives: c.alternatives,
          type: t,
          explanation: c.explanation || typeLabels[t] || t,
          source: 'ai',
          context: c.context,
          sentence: text,
          createdAt: Date.now(),
        };
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        this.onStatusChange('AI check timed out');
      } else if (e instanceof TypeError) {
        this.onStatusChange('Network error');
      } else {
        this.onStatusChange('AI check failed');
      }
      return [];
    } finally {
      const elapsed = Date.now() - startTime;
      if (elapsed > 3000) {
        this.onStatusChange('');
      } else {
        setTimeout(() => this.onStatusChange(''), 500);
      }
    }
  }
}

function parseJSON(text: string): AICorrection[] | null {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
    return null;
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        return null;
      }
    }

    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        return JSON.parse(arrMatch[0]);
      } catch {
        return null;
      }
    }

    return null;
  }
}

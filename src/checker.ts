import type { ErrorItem, LangGhostSettings, AICorrection } from './types';

const SYSTEM_PROMPT = `You are an English grammar checker for Chinese speakers. Find ALL errors in the sentence.

CRITICAL — classify each error into ONE of these types:
- "spelling": misspelled word (wrong letters). Examples: "recieve"→"receive", "teh"→"the", "writen"→"written"
- "grammar": tense, agreement, verb form, article, preposition, pronoun, word order, redundancy. Examples: "he go"→"he goes", "can able"→"can", "I has"→"I have"
- "expression": correct grammar but wordy, awkward, or unnatural. Examples: "make a discussion"→"discuss", "at this point in time"→"now", "in my opinion I think"→"I think"
- "translation": Chinese text that should be written in English. Provide the English translation as "corrected".

RULES:
- If you see Chinese characters mixed in, classify as "translation".
- Spelling errors are ONLY about wrong letters. Verb form errors (writed→wrote) are "grammar".
- Explain in ≤15 Chinese chars, state only the rule (e.g. "过去时" not "你描述的是过去所以用过去时").
- Include "context" (≈20 chars of surrounding text).
- If no errors, return [].
- Return ONLY a JSON array, no other text.`;

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
    const settings = this.getSettings();
    if (!settings.apiKey) return [];

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
          max_tokens: 256,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text },
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
    return JSON.parse(text);
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

import type { ErrorItem, LangGhostSettings, AICorrection } from './types';

const SYSTEM_PROMPT = `English grammar checker for Chinese speakers. Find errors in the given sentence.

Types: grammar, spelling, expression (unnatural), translation (Chinese→English).
Explain in ≤15 Chinese chars (rule only). Include "context" (surrounding text).
No errors → return [].
Return JSON: [{"original","corrected","alternatives?","context","type","explanation"}]`;

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
      const endpoint = settings.apiEndpoint.replace(/\/$/, '') + '/chat/completions';
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

      return corrections.map((c): ErrorItem => ({
        id: crypto.randomUUID(),
        original: c.original,
        corrected: c.corrected,
        alternatives: c.alternatives,
        type: (c.type as any) || 'grammar',
        explanation: c.explanation,
        source: 'ai',
        context: c.context,
        sentence: text,
        createdAt: Date.now(),
      }));
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

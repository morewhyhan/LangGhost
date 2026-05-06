import type { Text } from '@codemirror/state';
import type { SentenceRange } from './types';

// Abbreviations that end with a period but aren't sentence endings
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr',
  'vs', 'etc', 'e.g', 'i.e',
  'u.s', 'u.k', 'a.m', 'p.m',
  'inc', 'corp', 'ltd', 'co',
  'no', 'viz', 'ca', 'est', 'approx',
]);

const SENTENCE_END = new Set(['.', '?', '!', '\u3002', '\uff1f', '\uff01']);

function isInsideFrontmatter(text: string, pos: number): boolean {
  if (!text.startsWith('---\n')) return false;
  const secondDash = text.indexOf('---\n', 4);
  if (secondDash === -1) return false;
  return pos < secondDash + 4;
}

function isInsideCodeBlock(text: string, pos: number): boolean {
  let inCode = false;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text.substring(i, i + 3) === '```') {
      inCode = !inCode;
      i += 2;
    }
  }
  return inCode;
}

function isInsideDoubleLink(text: string, pos: number): boolean {
  const before = text.substring(0, pos);
  const lastOpen = before.lastIndexOf('[[');
  if (lastOpen === -1) return false;
  const lastCloseBefore = before.lastIndexOf(']]');
  if (lastCloseBefore > lastOpen) return false; // link already closed before pos

  // Check if there's a closing ]] after pos (search up to 500 chars ahead)
  const after = text.substring(pos);
  const closeAfter = after.indexOf(']]');
  if (closeAfter === -1) return false; // unclosed — don't block all subsequent text
  // Ensure no [[ between pos and ]] (otherwise pos is between two separate links)
  const openBetween = after.substring(0, closeAfter).indexOf('[[');
  if (openBetween !== -1) return false;

  return true; // pos is inside [[...]]
}

function isInsideTag(text: string, pos: number): boolean {
  // Valid Obsidian tag characters: letters, digits, hyphens, underscores,
  // forward slashes (for nested tags), and CJK characters.
  // Sentence-ending chars (., ?, !, etc.) are NOT valid tag chars,
  // so this check will only return true if pos genuinely points inside a tag.
  if (pos >= text.length) return false;
  const ch = text[pos];
  if (!/^[a-zA-Z0-9\u4e00-\u9fff\-_\/]$/.test(ch)) return false;

  // Walk backwards from pos to find #
  for (let i = pos - 1; i >= 0; i--) {
    if (text[i] === '#') return true;
    if (!/^[a-zA-Z0-9\u4e00-\u9fff\-_\/]$/.test(text[i])) return false;
  }
  return false;
}

export function extractSentence(doc: Text, triggerPos: number): SentenceRange | null {
  // Only extract text up to triggerPos+1 — the backward scan never looks beyond it.
  // This avoids copying the entire document on every sentence-end detection.
  const text = doc.sliceString(0, triggerPos + 1);
  const lineCount = doc.lines;

  // Skip frontmatter
  if (isInsideFrontmatter(text, triggerPos)) return null;

  // Skip code blocks
  if (isInsideCodeBlock(text, triggerPos)) return null;

  // Skip double links
  if (isInsideDoubleLink(text, triggerPos)) return null;

  // Skip tags
  if (isInsideTag(text, triggerPos)) return null;

  // Find sentence start: scan backwards from triggerPos
  let sentenceStart = 0;
  for (let i = triggerPos - 1; i >= 0; i--) {
    const ch = text[i];

    // Empty line = paragraph boundary
    if (ch === '\n' && i > 0 && text[i - 1] === '\n') {
      sentenceStart = i + 1;
      break;
    }
    if (ch === '\n' && i === 0) {
      sentenceStart = i + 1;
      break;
    }

    // Sentence-ending punctuation
    if (SENTENCE_END.has(ch)) {
      // Check if it's an abbreviation
      const wordStart = findWordStart(text, i);
      const wordBeforePeriod = text.substring(wordStart, i).toLowerCase();
      if (ch === '.' && ABBREVIATIONS.has(wordBeforePeriod)) {
        continue; // Not a real sentence end
      }
      sentenceStart = i + 1;
      break;
    }
  }

  // Trim leading whitespace
  const rawText = text.substring(sentenceStart, triggerPos + 1);
  const trimmedStart = sentenceStart + rawText.length - rawText.trimStart().length;
  const sentenceText = text.substring(trimmedStart, triggerPos + 1).trim();

  if (!sentenceText) return null;

  return {
    text: sentenceText,
    from: trimmedStart,
    to: triggerPos + 1,
  };
}

function findWordStart(text: string, periodPos: number): number {
  let i = periodPos - 1;
  while (i >= 0 && /[a-zA-Z.]/.test(text[i])) {
    i--;
  }
  return i + 1;
}

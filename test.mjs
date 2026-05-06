/**
 * LangGhost comprehensive test suite (~100 cases)
 * Tests: extractor, CJK cleaning, harper.js, LLM (DeepSeek)
 *
 * Usage: node test.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Test runner ─────────────────────────────────────────────────

let passed = 0, failed = 0, total = 0;
const failures = [];

function assert(condition, msg) {
  total++;
  if (condition) { passed++; console.log(`  ✓ #${total} ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ #${total} ${msg}`); }
}

function section(title) { console.log(`\n${'─'.repeat(50)}\n  ${title}\n${'─'.repeat(50)}`); }

// ── Extractor (mirrors extractor.ts) ────────────────────────────

function extractSentence(text, triggerPos) {
  const ABBR = new Set(['mr','mrs','ms','dr','prof','sr','jr','vs','etc','e.g','i.e','u.s','u.k','a.m','p.m','inc','corp','ltd','co']);
  const END = new Set(['.','?','!','\u3002','\uff1f','\uff01']);
  function findWordStart(t, p) { let i = p-1; while (i>=0 && /[a-zA-Z]/.test(t[i])) i--; return i+1; }
  let ss = 0;
  for (let i = triggerPos - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '\n' && i > 0 && text[i-1] === '\n') { ss = i+1; break; }
    if (ch === '\n' && i === 0) { ss = i+1; break; }
    if (END.has(ch)) {
      const ws = findWordStart(text, i);
      const wb = text.substring(ws, i).toLowerCase();
      if (ch === '.' && ABBR.has(wb)) continue;
      ss = i + 1; break;
    }
  }
  const raw = text.substring(ss, triggerPos + 1);
  const ts = ss + raw.length - raw.trimStart().length;
  const st = text.substring(ts, triggerPos + 1).trim();
  if (!st) return null;
  return { text: st, from: ts, to: triggerPos + 1 };
}

// Helper: find trigger position by character
function lastChar(text, ch) { const i = text.lastIndexOf(ch); return i === -1 ? -1 : i; }

// ── CJK cleaning ────────────────────────────────────────────────

const MIXED_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u2e80-\u2eff\u3400-\u4dbf\uf900-\ufaff0-9]/g;
const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

function cleanForHarper(text) {
  if (!CJK_RE.test(text)) return { cleaned: text, hasCJK: false };
  return { cleaned: text.replace(MIXED_RE, ' '), hasCJK: true };
}

// ══════════════════════════════════════════════════════════════════
// SECTION 1: Extractor tests (20 cases)
// ══════════════════════════════════════════════════════════════════

section('1. Extractor: basic boundaries');

{
  const d = 'Hello world. How are you?';
  assert(extractSentence(d, lastChar(d, '?'))?.text === 'How are you?', 'Period boundary');
}
{
  const d = 'Really? Yes!';
  assert(extractSentence(d, lastChar(d, '?'))?.text === 'Really?', 'Question mark boundary');
}
{
  const d = 'Stop! Wait.';
  assert(extractSentence(d, lastChar(d, '!'))?.text === 'Stop!', 'Exclamation boundary');
}
{
  const d = '你好。谢谢。';
  assert(extractSentence(d, d.indexOf('\u3002'))?.text === '你好。', 'CJK period boundary');
}

section('2. Extractor: mixed punctuation & triggers');

{
  const d = 'Hello world。\nI from 2点开始一直在 coding。';
  assert(extractSentence(d, lastChar(d, '\u3002'))?.text === 'I from 2点开始一直在 coding。', 'CJK period after newline');
}
{
  const d = 'First sentence.\nI from 2点开始一直在 coding\n';
  assert(extractSentence(d, lastChar(d, '\n'))?.text === 'I from 2点开始一直在 coding', 'Newline as trigger');
}
{
  const d = 'I from 2点开始一直在 coding\n';
  assert(extractSentence(d, lastChar(d, '\n'))?.text === 'I from 2点开始一直在 coding', 'Standalone newline trigger');
}

section('3. Extractor: abbreviations');

{
  const d = 'Dr. Smith went home. He was tired.';
  assert(extractSentence(d, lastChar(d, '.'))?.text === 'He was tired.', 'Skip "Dr." abbreviation');
}
{
  const d = 'Mr. and Mrs. Lee came. They left.';
  assert(extractSentence(d, lastChar(d, '.'))?.text === 'They left.', 'Skip "Mr." and "Mrs."');
}
{
  const d = 'Visit us at e.g. the main office. Call us.';
  assert(extractSentence(d, lastChar(d, '.'))?.text === 'Call us.', 'Skip "e.g." abbreviation');
}

section('4. Extractor: edge cases');

{
  const d = 'Line one.\nLine two.\n';
  assert(extractSentence(d, lastChar(d, '\n')) === null, 'Newline after period → null');
}
{
  const d = 'Hello world.';
  assert(extractSentence(d, lastChar(d, '.'))?.text === 'Hello world.', 'Single sentence, period at end');
}
{
  const d = '   Hello world.  ';
  assert(extractSentence(d, d.indexOf('.'))?.text === 'Hello world.', 'Leading whitespace trimmed');
}
{
  const d = 'Word';
  assert(extractSentence(d, d.length - 1)?.text === 'Word', 'No sentence-ending char → whole text');
}
{
  const d = 'First.\n\nSecond sentence.';
  assert(extractSentence(d, lastChar(d, '.'))?.text === 'Second sentence.', 'Blank line as paragraph boundary');
}

section('5. Extractor: CJK mixed');

{
  const d = '这是中文。English sentence here.';
  assert(extractSentence(d, lastChar(d, '.'))?.text === 'English sentence here.', 'CJK period → English');
}
{
  const d = 'English text。混合text。';
  assert(extractSentence(d, lastChar(d, '\u3002'))?.text === '混合text。', 'CJK period in mixed text');
}
{
  const d = '我昨天去了store。今天也是。\nHe go to school。\n';
  assert(extractSentence(d, d.indexOf('school') + 6)?.text === 'He go to school。', 'Mixed with CJK period');
}

// ══════════════════════════════════════════════════════════════════
// SECTION 2: CJK cleaning tests (15 cases)
// ══════════════════════════════════════════════════════════════════

section('6. CJK cleaning: length & position preservation');

const cleanTests = [
  'I from 2点开始一直在 coding.',
  'He go to 北京 last week.',
  "She don't like 这个方案 because it too expensive.",
  'I am agree with 你的观点.',
  'We should discussion about 这个问题 tomorrow.',
  'The project 已经 delayed for 2个星期了.',
  'He very like 这个 idea.',
  'Yesterday I go to 看电影 with my 朋友.',
  '2个人 went to the store.',
  '今天是 Monday.',
];

for (const t of cleanTests) {
  const { cleaned, hasCJK } = cleanForHarper(t);
  assert(cleaned.length === t.length && hasCJK, `length preserved (${t.length}): "${t.substring(0, 25)}..."`);
}

section('7. CJK cleaning: pure text unchanged');

const pureTests = [
  'Hello world.',
  'I have been coding since yesterday.',
  'The quick brown fox jumps over the lazy dog.',
  'coding',
  '2 + 2 = 4',
];

for (const t of pureTests) {
  const { cleaned, hasCJK } = cleanForHarper(t);
  assert(cleaned === t && !hasCJK, `unchanged: "${t}"`);
}

// ══════════════════════════════════════════════════════════════════
// SECTION 3: Harper.js tests (15 cases)
// ══════════════════════════════════════════════════════════════════

section('8. Harper.js: detection');

async function runHarperTests() {
  let linter;
  try {
    const wasmPath = join(__dirname, 'node_modules/harper.js/dist/harper_wasm_bg.wasm');
    const wasmBinary = readFileSync(wasmPath);
    const wasmBlob = new Blob([wasmBinary], { type: 'application/wasm' });
    const wasmUrl = URL.createObjectURL(wasmBlob);
    const harper = await import('harper.js');
    const binary = new harper.BinaryModule(wasmUrl);
    linter = new harper.LocalLinter({ binary });
    await linter.setup();
    URL.revokeObjectURL(wasmUrl);
  } catch (e) {
    console.log(`  ⚠ Skipping harper tests: ${e.message}`);
    return;
  }

  const spellingTests = [
    { text: 'I hav been working hard.', word: 'hav' },
    { text: 'She writed a letter.', word: 'writed' },
    { text: 'He is vry tall.', word: 'vry' },
    { text: 'The cocument is ready.', word: 'cocument' },
    { text: 'We went to teh store.', word: 'teh' },
  ];

  for (const t of spellingTests) {
    const lints = await linter.lint(t.text, { language: 'plaintext' });
    const found = lints.some(l => l.get_problem_text().toLowerCase().includes(t.word));
    assert(found, `harper spelling: "${t.word}" → ${found ? 'found' : 'missed'}`);
  }

  console.log('\n  [Harper grammar capability (info only)]');
  for (const text of [
    'I has been working on this project.',
    "He don't knows nothing about this issue.",
    'She can able to finish the work.',
    'The developer are writing codes.',
    'I from coding everyday.',
  ]) {
    const lints = await linter.lint(text, { language: 'plaintext' });
    console.log(`    ${lints.length > 0 ? '✓' : '✗'} "${text}" → ${lints.length} error(s)`);
  }

  const correctTests = [
    "I've been coding since 2 o'clock.",
    'He went to Beijing last week for a conference.',
    'The project has been delayed for two weeks.',
    'She likes this idea and wants to start immediately.',
    'We should discuss this problem tomorrow.',
  ];

  for (const text of correctTests) {
    const lints = await linter.lint(text, { language: 'plaintext' });
    assert(lints.length === 0, `harper no false positive: "${text.substring(0, 40)}..."`);
  }
}

await runHarperTests();

// ══════════════════════════════════════════════════════════════════
// SECTION 4: LLM (DeepSeek) tests (50 cases)
// ══════════════════════════════════════════════════════════════════

const API_KEY = 'sk-b5e6b78aa08b4c4ab37e75e26d1e0e6c';
const API_ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages';
const MODEL = 'deepseek-v4-pro[1m]';

function buildPrompt(sentence) {
  return `You are an expert English grammar checker. The user is a Chinese speaker who mixes Chinese and English in their writing.

CRITICAL: Focus on ENGLISH grammar errors FIRST. Check every English word fragment carefully, even short ones surrounded by Chinese. Common mistakes:
- Wrong verb forms: "I go"→"I went", "he don't"→"he doesn't", "I from"→"I've been from"
- Missing verbs: "I from" needs a verb, "it too expensive"→"it's too expensive"
- Wrong parts of speech: "discussion about"→"discuss", "can able"→"can"
- Tense/aspect: "have went"→"have been/went", "will going"→"will go"
- Double comparatives: "more better"→"better"
- Passive voice: "is schedule"→"is scheduled"

Error types:
1. Grammar errors (tense, agreement, missing verbs, wrong forms) → type: "grammar"
2. Spelling errors → type: "spelling"
3. Expression suggestions (correct but unnatural) → type: "expression"
4. Chinese that should be English → type: "translation"

Rules:
- Keep explanations under 15 Chinese characters, state the grammar rule only
- Check EACH English fragment independently — a 2-word fragment like "I from" can still be wrong
- Do NOT flag correct English (e.g. "learning programming" is correct)
- If no errors, return empty array

Return strict JSON array:
[
  {
    "original": "error text",
    "corrected": "correction",
    "alternatives": ["other options"],
    "context": "surrounding text",
    "type": "grammar|spelling|expression|translation",
    "explanation": "under 15 chars in Chinese"
  }
]

Sentence:
${sentence}`;
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) try { return JSON.parse(m[1]); } catch {}
  const a = text.match(/\[[\s\S]*\]/);
  if (a) try { return JSON.parse(a[0]); } catch {}
  return null;
}

async function checkLLM(sentence) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content: buildPrompt(sentence) }] }),
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!res.ok) return { error: `HTTP ${res.status}: ${await res.text().catch(() => '')}` };
    const data = await res.json();
    const tb = data.content?.find(b => b.type === 'text');
    return { corrections: parseJSON(tb?.text ?? '') || [] };
  } catch (e) { clearTimeout(tid); return { error: e.message }; }
}

async function runLLMTests() {
  const tests = [
    // A: Mixed Chinese-English grammar (20)
    { s: 'I from 2点开始一直在 coding.', err: true, cat: 'A', hint: 'I from → missing verb' },
    { s: 'He go to 北京 last week.', err: true, cat: 'A', hint: 'He go → went' },
    { s: "She don't like 这个方案 because it too expensive.", err: true, cat: 'A', hint: "don't→doesn't; it too→it's too" },
    { s: 'Yesterday I go to 看电影 with my 朋友.', err: true, cat: 'A', hint: 'I go → I went' },
    { s: 'The project 已经 delayed for 2个星期了, we need 加班.', err: true, cat: 'A', hint: 'delayed → has been delayed' },
    { s: 'I am agree with 你的观点.', err: true, cat: 'A', hint: 'am agree → agree' },
    { s: 'He very like 这个 idea and want to 立刻开始.', err: true, cat: 'A', hint: 'very like → likes; want→wants' },
    { s: 'We should discussion about 这个问题 tomorrow.', err: true, cat: 'A', hint: 'discussion → discuss' },
    { s: 'She can able to 完成 the task.', err: true, cat: 'A', hint: 'can able → can / is able to' },
    { s: 'I am interesting in 学习 AI.', err: true, cat: 'A', hint: 'interesting → interested' },
    { s: 'He suggested to 去 the mall.', err: true, cat: 'A', hint: 'suggested to → suggested going' },
    { s: 'The 会议 is schedule in 明天.', err: true, cat: 'A', hint: 'schedule → scheduled' },
    { s: 'I have went to 上海 three times.', err: true, cat: 'A', hint: 'have went → have been/went' },
    { s: 'She is good in 英语 and also 数学.', err: true, cat: 'A', hint: 'good in → good at' },
    { s: 'He did not went to 工作 yesterday.', err: true, cat: 'A', hint: 'did not went → did not go' },
    { s: 'They is working on 新的项目 now.', err: true, cat: 'A', hint: 'They is → They are' },
    { s: 'I will going to 学习 programming next 年.', err: true, cat: 'A', hint: 'will going → will go/am going' },
    { s: 'The teacher told me 不要 to be late.', err: true, cat: 'A', hint: '不要 → not to' },
    { s: 'She has more better 发音 than me.', err: true, cat: 'A', hint: 'more better → better' },
    { s: 'I need to discuss about 我的计划 with him.', err: true, cat: 'A', hint: 'discuss about → discuss' },

    // B: Pure English grammar (10)
    { s: 'I has been working on this project since last month.', err: true, cat: 'B', hint: 'I has → I have' },
    { s: "He don't knows nothing about this issue.", err: true, cat: 'B', hint: "don't knows→doesn't know; double neg" },
    { s: 'The developer are writing codes in the morning.', err: true, cat: 'B', hint: 'developer are→is; codes→code' },
    { s: 'Each of the students have their own book.', err: true, cat: 'B', hint: 'have → has' },
    { s: 'If I was you, I will accept the offer.', err: true, cat: 'B', hint: 'was→were; will→would' },
    { s: 'She is one of the best player in the team.', err: true, cat: 'B', hint: 'player → players' },
    { s: 'He suggested to go to the park yesterday.', err: true, cat: 'B', hint: 'suggested to go → suggested going' },
    { s: 'Neither the teacher nor the students was present.', err: true, cat: 'B', hint: 'was → were' },
    { s: 'The number of participants are increasing.', err: true, cat: 'B', hint: 'are → is' },
    { s: 'I look forward to hear from you soon.', err: true, cat: 'B', hint: 'hear → hearing' },

    // C: Spelling (5)
    { s: 'I recieve many messges every day.', err: true, cat: 'C', hint: 'recieve→receive; messges→messages' },
    { s: 'She is a very succesful buisness woman.', err: true, cat: 'C', hint: 'succesful→successful; buisness→business' },
    { s: 'The goverment announced new pollcies.', err: true, cat: 'C', hint: 'goverment→government; pollcies→policies' },
    { s: 'He acomplished his neccessary tasks.', err: true, cat: 'C', hint: 'acomplished→accomplished; neccessary→necessary' },
    { s: 'The enviorment is defintely getting better.', err: true, cat: 'C', hint: 'enviorment→environment; defintely→definitely' },

    // D: Expression (5)
    { s: 'I want to make a discussion about this topic.', err: true, cat: 'D', hint: 'make a discussion → discuss' },
    { s: 'In my opinion, I think this is a good idea.', err: true, cat: 'D', hint: 'redundant: opinion + think' },
    { s: 'Due to the fact that it was raining, we stayed home.', err: true, cat: 'D', hint: 'Due to the fact that → Because' },
    { s: 'At this point in time, we need to move forward.', err: true, cat: 'D', hint: 'At this point in time → Now' },
    { s: 'He is a person who always likes to help other people.', err: true, cat: 'D', hint: 'wordy' },

    // E: Correct sentences — should NOT flag (10)
    { s: "I've been coding since 2 o'clock.", err: false, cat: 'E' },
    { s: 'He went to Beijing last week for a conference.', err: false, cat: 'E' },
    { s: 'The project has been delayed for two weeks, so we need to work overtime.', err: false, cat: 'E' },
    { s: 'She likes this idea and wants to start immediately.', err: false, cat: 'E' },
    { s: 'We should discuss this problem tomorrow morning.', err: false, cat: 'E' },
    { s: 'I have been learning programming for three months.', err: false, cat: 'E' },
    { s: 'The teacher told the students not to be late.', err: false, cat: 'E' },
    { s: 'Neither the teacher nor the students were present.', err: false, cat: 'E' },
    { s: 'She is one of the best players on the team.', err: false, cat: 'E' },
    { s: 'I look forward to hearing from you soon.', err: false, cat: 'E' },
  ];

  section('4. LLM (DeepSeek) comprehensive tests');
  console.log(`  Running ${tests.length} LLM checks (concurrency=5)...\n`);

  // Concurrency limiter
  let conc = 0;
  const waitQ = [];
  const MAX = 5;
  function enqueue(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => { conc++; try { resolve(await fn()); } catch(e) { reject(e); } finally { conc--; waitQ.length > 0 ? waitQ.shift()() : undefined; } };
      if (conc < MAX) run();
      else waitQ.push(run);
    });
  }

  // Run all tests in parallel with concurrency limit
  const results = await Promise.all(tests.map(t =>
    enqueue(async () => {
      const r = await checkLLM(t.s);
      return { ...t, ...r };
    })
  ));

  // Report by category
  const cats = [...new Set(tests.map(t => t.cat))];
  const catNames = { A: 'Mixed Chinese-English errors', B: 'Pure English grammar', C: 'Spelling', D: 'Expression/style', E: 'Correct (no false positives)' };

  for (const cat of cats) {
    console.log(`\n  [${cat}: ${catNames[cat]}]`);
    for (const r of results.filter(r => r.cat === cat)) {
      if (r.error) {
        total++; failed++;
        console.log(`    ✗ #${total} API ERROR: "${r.s.substring(0, 45)}..." → ${r.error}`);
        continue;
      }
      const found = r.corrections.length > 0;
      const short = r.s.length > 45 ? r.s.substring(0, 42) + '...' : r.s;
      if (r.err) {
        assert(found, `LLM [${cat}]: "${short}" → ${found ? r.corrections.map(c => `${c.original}→${c.corrected}`).join(', ') : 'MISSED'}`);
        if (!found) console.log(`       expected: ${r.hint}`);
      } else {
        assert(!found, `LLM [${cat}]: "${short}" → ${found ? 'FALSE POS: ' + r.corrections.map(c => c.original).join(', ') : 'OK'}`);
      }
    }
  }
}

await runLLMTests();

// ══════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
if (failures.length > 0 && failures.length <= 20) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  - ${f}`));
} else if (failures.length > 20) {
  console.log(`\n(${failures.length} failures, first 20 shown)`);
  failures.slice(0, 20).forEach(f => console.log(`  - ${f}`));
}
if (failed > 0) process.exit(1);

# LangGhost Bug Report

基于PRD、代码和逻辑分析的结果，以下列出所有已在代码库中发现的问题。

---

## 一、逻辑Bug（行为不正确）

### B1. `isInsideTag` 误判 `#tag.` 为标签，跳过句子检测

**文件**: `src/extractor.ts:44-46`  
**严重程度**: 中等  
**影响**: 以 `#tag.` 结尾的句子不会被检查

```typescript
function isInsideTag(text: string, pos: number): boolean {
  const before = text.substring(0, pos);
  const lastHash = before.lastIndexOf('#');
  if (lastHash === -1) return false;
  const afterHash = before.substring(lastHash + 1);
  return /^\S*$/.test(afterHash);  // ← BUG
}
```

`/^\S*$/` 匹配任意非空格字符，但 Obsidian 标签的合法字符仅为 `[a-zA-Z0-9\-_/]`。当用户写 `I like #tag. New sentence.` 时，`isInsideTag` 认为 `.` 仍在标签内，返回 true → `extractSentence` 返回 null → 该句不被检测。

**修复**: 改为 `/^[a-zA-Z0-9\u4e00-\u9fff\-_\/]*$/` 或类似Obsidian合法的标签正则。

---

### B2. `isInsideDoubleLink` 遇到未闭合的 `[[` 会跳过后续所有文本

**文件**: `src/extractor.ts:32-37`  
**严重程度**: 中等  
**影响**: 一个未闭合的 `[[` 导致后续所有句子检测全部跳过

```typescript
function isInsideDoubleLink(text: string, pos: number): boolean {
  const before = text.substring(0, pos);
  const lastOpen = before.lastIndexOf('[[');
  const lastClose = before.lastIndexOf(']]');
  return lastOpen !== -1 && lastOpen > lastClose;
}
```

只检查 `pos` **之前**是否有 `]]`。如果用户在文档中间写了 `[[broken link` 但还没补上 `]]`，从该位置开始一直到最后的所有句子检测都会被阻断。尤其是在打字过程中，这种未闭合状态非常常见。

**修复**: 同时检查 `pos` 之后的文本中是否有 `]]`，若有且 `[[` 和 `]]` 之间没有另一个 `[[`，则说明链接已闭合。

---

### B3. `clearSentenceMarks` 边界逻辑可能保留跨句子标记

**文件**: `src/markStore.ts:83-91`  
**严重程度**: 低  
**影响**: 跨句子边界的陈旧标记不会被清除

```typescript
clearSentenceMarks(filePath: string, from: number, to: number): void {
  const marks = this.marks.get(filePath);
  if (marks) {
    this.marks.set(
      filePath,
      marks.filter(m => m.from < from || m.to > to)
    );
    this.notify(filePath);
  }
}
```

过滤条件 `m.from < from || m.to > to` 保留所有**不完全**在 `[from, to]` 范围内的标记。对于完全在范围内的标记才删除。但如果一个标记被映射后刚好跨过句子边界（如 from=5, to=15，句子范围=[10, 100]），则会被保留，而实际上它应该被清除。

---

### B4. `parseJSON` 贪婪正则可能匹配非预期内容

**文件**: `src/checker.ts:115`  
**严重程度**: 低  
**影响**: AI 返回多个 JSON 数组时可能解析失败

```typescript
const arrMatch = text.match(/\[[\s\S]*\]/);
```

`[\s\S]*` 是贪婪匹配。如果 AI 返回类似 `[{"original":"a"}]\nSome text\n[{"original":"b"}]`，会从第一个 `[` 匹配到最后一个 `]`，整个字符串不是合法 JSON，解析失败返回 null。

**修复**: 改为非贪婪 `/\[[\s\S]*?\]/`，或改用逐个 JSON 解析器。

---

### B5. `isInsideCodeBlock` 不处理 4-backtick 包围的代码块

**文件**: `src/extractor.ts:21-30`  
**严重程度**: 低（边缘情况）  
**影响**: 4-backtick 代码块中若包含 3-backtick 内容，会错误切换 "在代码块中" 状态

```typescript
if (text.substring(i, i + 3) === '```') {
  inCode = !inCode;
}
```

当用户使用 ```` `````` ````（4 个反引号）来包围含有 3 个反引号的代码块时，函数会把围栏误认为代码块开始，随后遇到内部的 ` ``` ` 时误认为代码块结束，导致后续内容被当作普通文本检测。

**修复**: 记录围栏标记的反引号数量，只匹配同样数量的反引号。

---

### B6. API endpoint 重复拼接 `/chat/completions`

**文件**: `src/checker.ts:30`  
**严重程度**: 低  
**影响**: 用户配置完整 URL 时会 404

```typescript
const endpoint = settings.apiEndpoint.replace(/\/$/, '') + '/chat/completions';
```

如果用户配置的 endpoint 已经包含 `/chat/completions`（如 `https://api.deepseek.com/v1/chat/completions`），最终请求会发到 `/v1/chat/completions/chat/completions`，导致 404。

**修复**: 检查是否已以 `/chat/completions` 结尾，若是则不再拼接。

---

## 二、PRD 行为不符

### B7. 应用修正后不重新检查句子（与 PRD 矛盾）

**文件**: `src/decorations.ts:82`, `src/tooltip.ts:82-86`, `src/sidebarView.ts:260-264`  
**严重程度**: 中等  
**影响**: 用户改完一个错误后，同句其他错误不更新

PRD 第 74 行明确要求：
> "一句话有多处错误时，应用一处修正后，其余波浪线暂时消失，自动重新检查这句话，重新标注剩余错误"

但代码中故意**没有**实现此功能。`tooltip.ts` 注释说：
```typescript
// Do NOT recheck here — recheck clears ALL marks in the sentence
// range (including other unrelated errors), causing wavy lines to
// vanish. The decorations plugin's validateMarks handles stale
// marks, and position mapping adjusts the surviving ones.
// A new check will trigger on the next sentence-end character.
```

实际行为：应用修正后，剩余标记保持原状（可能因文本改变而位置偏移），直到用户手动输入下一个句末标点才会触发新的检查。这意味着用户修正一个错误后，其他错误不会自动更新。

---

### B8. "忽略"按钮的波浪线在文件关闭再打开后会重新出现

**文件**: `src/markStore.ts:144-147`, `main.ts:192-198`  
**严重程度**: 中等  
**影响**: 与 PRD 行为一致，但有内存泄漏风险

PRD 第 76 行：
> "点'忽略'：波浪线消失，只在当前编辑会话有效。关掉文件再打开，同样的错误会重新标出来"

当前实现：ignored 状态存储在 `markStore.ignored` 内存 Map 中，文件关闭后由 `cleanupClosedFiles` 清理，这是正确的行为。但存在以下问题：

1. `onFileClose()` 方法存在但**从未被调用**（死代码）——只删 ignored，标记保留供持久化
2. `file-open` 事件调用 `onFileOpen()` 是空方法（死代码）
3. 注释说"Clean up ignored set when a file is closed (prevents memory leak)"，但关闭逻辑在 `cleanupClosedFiles` 中，且只在 `save()` 时调用
4. 若用户在两次 `save()` 之间打开关闭大量文件，ignored 状态会累积在内存中

---

## 三、竞态条件与异步问题

### B9. `validateMarks` 中 fire-and-forget `appendError` 可能丢失错题记录

**文件**: `src/decorations.ts:109`  
**严重程度**: 低  
**影响**: 手动修改错误文字时，错题记录可能未写入

```typescript
// validateMarks(), 在 CM6 的同步 update callback 中
plugin.errorBook.appendError(mark.error);  // async 但未 await
```

`validateMarks` 在 CM6 同步 `update` 回调中运行，无法 `await`。如果多个标记同时变为陈旧（如粘贴或大段删除），会导致多个 `appendError` 并发调用。虽然 Obsidian 的 `vault.process` 是原子操作，但 fire-and-forget 意味着失败静默丢失。

---

### B10. `Dispatcher.recheck` 使用可能已过时的句子位置

**文件**: `src/dispatcher.ts:42-44`  
**严重程度**: 低  
**影响**: 陈旧位置可能导致清除错误的标记范围

```typescript
async recheck(sentence: SentenceRange, filePath: string): Promise<void> {
  this.markStore.clearSentenceMarks(filePath, sentence.from, sentence.to);
  await this.dispatch(sentence, filePath);
}
```

调用者（`validateMarks`）传入了从当前文档重新提取的句子范围，所以 `sentence.from` 和 `sentence.to` 是新的。但 `dispatch` 中的 `runCheck` 是异步的——在 `await` AI 结果期间，文档可能再次改变，导致 AI 返回的标记位置再次过时。这个问题由 `mapPositions` 部分缓解，但并非完全可靠。

---

### B11. AI 检查返回后本地标记状态可能与文档脱节

**文件**: `src/dispatcher.ts:47-81`  
**严重程度**: 低  
**影响**: 极少情况下的标记位置不正确

`runCheck` 的执行流程：
1. 运行本地检查 → `addMarks(localMarks)` → `notify()` → 触发装饰重建和持久化
2. 等待 AI 结果（可能有网络延迟）
3. 删除本地标记 → `removeMarksById`
4. 添加 AI 标记 → `addMarks(aiMarks)`

在步骤 1-3 之间，用户可能已经编辑了文档。步骤 3 按 ID 删除本地标记（安全），但步骤 4 的 AI 标记位置基于 `sentence.from` 计算，此时可能已过时。后续由 `mapPositions` 处理，但由于 `addMarks` 和 `notify` 在同一事件循环中，AI 标记的位置可能在下次 `mapPositions` 前短暂错误。

---

## 四、内存管理

### B12. `findOverlap` 方法从未被调用——死代码

**文件**: `src/markStore.ts:111-114`  
**严重程度**: 极低  
**影响**: 仅代码卫生

```typescript
findOverlap(filePath: string, from: number, to: number): ErrorMark | null {
  const marks = this.marks.get(filePath) ?? [];
  return marks.find(m => m.from < to && m.to > from) ?? null;
}
```

在整个代码库中没有调用者。应该是删除的或未完成的功能残留。

---

### B13. `PersistedError.surroundingText` 始终为空字符串

**文件**: `src/persistence.ts:110`  
**严重程度**: 极低  
**影响**: 持久化数据有一个无用的字段

```typescript
result.push({
  error: mark.error,
  from: mark.from,
  to: mark.to,
  surroundingText: '', // Will be validated against live doc
  ...
});
```

`surroundingText` 字段在 `PersistedError` 接口中定义，但序列化时始终设为空字符串。恢复时（`restoreFile`）用文档当前状态重新验证，不使用存储的 `surroundingText`。这是设计选择但浪费存储空间。

---

## 五、稳健性问题

### B14. `findOriginalInSentence` 和 `findBestMatch` 对空字符串的处理

**文件**: `src/dispatcher.ts:101-109`, `src/persistence.ts:130-149`  
**严重程度**: 极低  
**影响**: 仅在 AI 返回空 `original` 时触发 O(n) 行为

```typescript
while (searchFrom <= sentence.length) {
  const idx = sentence.indexOf(original, searchFrom);
  if (idx === -1) break;
  positions.push(idx);
  searchFrom = idx + 1;
}
```

如果 `original` 为空字符串 `""`，`indexOf("", n)` 返回 `n`（永远不等于 -1），循环会执行 `sentence.length + 1` 次。虽然目前 AI 和 harper.js 不太可能返回空的 `original`，但缺少防御性检查。

---

### B15. CJK 正则表达式拼写具有误导性

**文件**: `src/linter.ts:105`  
**严重程度**: 极低  
**影响**: 功能正确但代码可读性差

```typescript
const mixedRegex = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u2e80-\u2eff\u3400-\u4dbf\uf900-\ufaff0-9]/;
```

`\uf900-\ufaff0-9` 实际上由两个字符范围组成：`\uf900-\ufaff`（CJK 兼容表意文字）和 `0-9`（ASCII 数字）。但从视觉上看像是一个拼写错误。建议增加空格或注释分隔。

---

### B16. 粘贴多句文本只检查第一句

**文件**: `src/detector.ts:37`  
**严重程度**: 低  
**影响**: 粘贴的多句英文只检测第一句

```typescript
for (const ch of insertedText) {
  if (SENTENCE_END_CHARS.has(ch)) {
    ...
    return; // Only trigger once per change
  }
}
```

注释声明 "Only trigger once per change" 是故意的。但用户粘贴一整段英文时，其余句子不会被检测。用户需要再手动输入一个句末标点才会触发后续句子的检测。

---

### B17. `isInsideFrontmatter` 不处理 `\r\n` 和 BOM

**文件**: `src/extractor.ts:14-19`  
**严重程度**: 极低（Obsidian 仅使用 `\n`）  
**影响**: 理论上 YAML frontmatter 可能不被跳过

```typescript
function isInsideFrontmatter(text: string, pos: number): boolean {
  if (!text.startsWith('---\n')) return false;
```

Obsidian 在所有平台上使用 `\n` 行结束，所以 `\r\n` 不是问题。但若文件有 BOM（字节序标记），`startsWith('---\n')` 也会失败。

---

## 六、安全/配置问题

### B18. API Key 明文存储

**文件**: `src/settings.ts`, Obsidian data.json  
**严重程度**: 信息  
**影响**: API Key 以明文存储在 `.obsidian/plugins/langghost/data.json`

这是 Obsidian 插件系统的固有限制——没有为插件提供安全存储 API。所有需要 API Key 的插件都有这个问题。建议在设置描述中提醒用户。

---

### B19. 测试文件中硬编码了 API 密钥

**文件**: `test.mjs:264`  
**严重程度**: 中等（安全）  
**影响**: API 密钥已提交至 git 历史

```javascript
const API_KEY = 'REDACTED_API_KEY';
```

已提交到 git 的 API 密钥，任何可以访问该仓库的人都能看到。建议：
1. 轮换该密钥（在 DeepSeek 控制台吊销）
2. 改用 `process.env.API_KEY` 环境变量
3. 使用 `git filter-branch` 或 `BFG Repo-Cleaner` 清理 git 历史中的密钥

---

### B20. 构建配置：开发模式下 WASM 文件不自动复制

**文件**: `esbuild.config.mjs:51-63`  
**严重程度**: 极低  
**影响**: 首次开发设置需要先运行 `npm run build`

```javascript
if (prod) {
  await context.rebuild();
  cpSync("node_modules/harper.js/dist/harper_wasm_bg.wasm", "harper_wasm_bg.wasm");
} else {
  await context.watch();
}
```

WASM 文件仅在 production 构建时复制。如果是全新 clone 后直接 `npm run dev`，可能缺少 WASM 文件导致插件加载失败。

---

## 七、tooltip 与 sidebarView 的问题

### B21. Tooltip 的 hover 边界：`pos <= m.to` 过于宽松

**文件**: `src/tooltip.ts:21`  
**严重程度**: 极低  
**影响**: 光标在标记文字后方时也可能弹出 tooltip

```typescript
const mark = marks.find(m => pos >= m.from && pos <= m.to);
```

CM6 的 `Decoration.mark().range(from, to)` 作用范围是 `[from, to)`（左闭右开），所以下划线不覆盖位置 `to`。但 tooltip 使用 `<=`，光标在 `to` 位置（标记后一个字符）时也会弹出。虽然是 UX 细节，但可能导致 annoying 的误触发。

---

### B22. Sidebar 的 `getActiveFilePath` 在侧边栏聚焦时回退到旧文件

**文件**: `src/sidebarView.ts:292-300`  
**严重程度**: 极低  
**影响**: 侧边栏聚焦时显示已关闭文件的错误（短暂）

```typescript
private getActiveFilePath(): string | null {
  const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
  if (activeView?.file?.path) {
    this.lastFilePath = activeView.file.path;
    return this.lastFilePath;
  }
  return this.lastFilePath;
}
```

当用户点击侧边栏后关闭当前文件（Ctrl+W），`activeView` 可能为 null，`lastFilePath` 仍指向已关闭的文件。侧边栏会短暂显示已关闭文件的残余标记，直到下一次刷新事件触发。

---

## 八、性能考虑

### B23. `isInsideCodeBlock` 每次句子检测都重新扫描全文（至 triggerPos）

**文件**: `src/extractor.ts:21-30`  
**严重程度**: 极低  
**影响**: 大文档中频繁输入句末标点时有微小延迟

```typescript
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
```

每次检测句子时，从头扫描到触发位置（`O(pos)` 的 `substring` 调用）。对于 10 万字符的文档，若用户在第 5 万字符处输入句号，会产生 5 万次 `substring` 调用。实际延迟可忽略不计（微秒级），但存在优化空间（如缓存最近代码块状态）。

---

### B24. `persistence.restoreFile` 对每个已持久化的错误进行全文档搜索

**文件**: `src/persistence.ts:130-149`  
**严重程度**: 极低  
**影响**: 含大量已持久化错误的大文件在打开时可能有延迟

```typescript
function findBestMatch(text: string, original: string, hintPos: number): number {
  // 先在提示位置附近搜索，找不到则搜索整个文档
  let searchFrom = 0;
  while (searchFrom <= text.length) {
    const found = text.indexOf(original, searchFrom);
    if (found === -1) break;
    ...
    searchFrom = found + 1;
  }
  return bestIdx;
}
```

如果一个文件有 50 个已持久化错误（上限），每个都在大文档中搜索，最坏情况下是 `50 * O(n)`。这在实践中是可接受的，但值得注意。

---

## 建议的修复优先级

| 优先级 | Bug | 说明 |
|--------|-----|------|
| 高 | B1 | `#tag.` 跳过检测——日常使用容易触发 |
| 高 | B2 | 未闭合 `[[` 阻断检测——写作中极常见 |
| 高 | B19 | API 密钥泄露——安全风险 |
| 中 | B7 | 与 PRD 行为不符——产品需求 |
| 中 | B8 | 内存清理逻辑不完整 |
| 中 | B6 | 配置完整 endpoint 404 |
| 低 | B3 | 边界标记清理 |
| 低 | B4 | JSON 解析贪心 |
| 低 | B9 | fire-and-forget 错题记录 |
| 低 | B16 | 粘贴多句检测不全 |
| 极低 | B5, B10-B15, B17, B20-B24 | 边缘场景，罕见触发 |

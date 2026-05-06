# LangGhost 用户体验Bug报告

逐流程逐场景追踪，挖掘用户真实会遇到的问题。

---

## 流程一：写句子 → 自动检测 → 波浪线

### 场景1：用户在标签后写句子

```
用户输入: "我喜欢用 #obsidian. 这个插件很好用。"
                           ^ 用户敲了这个句号
```

**期望**: 检测 "这个插件很好用。"  
**实际**: 整句不检测  
**原因**: `extractor.ts:44` 的 `isInsideTag()` 用 `/^\S*$/` 匹配 `obsidian` → 认为句号在标签内 → `extractSentence` 返回 null  
**影响**: 高频场景。Obsidian 用户写标签极其常见，`#tag.` 后的第一篇英语内容不会被检查。

### 场景2：用户在写 wikilink 的过程中

```
用户输入: "参考 [[some page. 另外 He go to school."
                   ^ 未闭合的链接            ^ 这个句子不会被检测
```

**期望**: "He go to school." 被检测  
**实际**: 从 `[[` 开始到文件末尾，所有句子的检测都被跳过  
**原因**: `extractor.ts:35` 的 `isInsideDoubleLink()` 只检查 `pos` 之前有没有 `]]`，不管后面。用户写到一半的链接未闭合，导致之后**所有的**句子都不检测。  
**影响**: 极高频场景。用户写 wikilink 时几乎是必然先打 `[[` 再慢慢补 `]]`。在此期间输入的所有句子都不会被检测。

### 场景3：用户粘贴一段多句英文

```
用户粘贴: "I has a cat. She are very cute. They is playing."
```

**期望**: 三句都检测  
**实际**: 只检测第一句 "I has a cat."  
**原因**: `detector.ts:37` 在找到第一个句末标点后立即 `return`。注释写 "Only trigger once per change"。  
**影响**: 从别处粘贴英文段落是常见操作，其余句子会在编辑器中存在但不显示波浪线。用户需要手动打一个空格或标点才能触发后续检测。

### 场景4：用户在4-backtick代码块中含3-backtick内容

````
用户写:
````markdown
some text.
````

```` 后面的 "some text." 会被误检测  
**原因**: `extractor.ts:24` 的 `isInsideCodeBlock` 遇到 ```` ``` ```` 就切换状态，不区分围栏的反引号数量。4-backtick 的 ```` `````` ```` 围栏中若有3-backtick的 ` ``` `，会错误切换"在代码块中"状态。  
**影响**: 较低频，但写技术文档（如这篇）时常遇到。

### 场景5：用户设置API endpoint时填写了完整URL

```
用户在设置里填: "https://api.deepseek.com/v1/chat/completions"
```

**期望**: 正常调用 AI  
**实际**: 请求发到 `https://api.deepseek.com/v1/chat/completions/chat/completions` → 404 → 状态栏显示 "AI check failed: 404"  
**原因**: `checker.ts:30` 无条件拼接 `/chat/completions`  
**影响**: 用户困惑为什么 AI 不工作，状态栏错误信息不直观。

### 场景6：用户在YAML frontmatter里写东西

```
文件内容:
---
title: Hello world. This is frontmatter.
---
I has a apple.  ← 这个应该被检测
```

**期望**: "Hello world. This is frontmatter." 不被检测，"I has a apple." 被检测  
**实际**: frontmatter 内的句号确实不触发检测 ✓，但 frontmatter 外的正常检测 ✓  
**验证**: `isInsideFrontmatter` 正确处理 ✓

但有一个边缘情况：如果文档首行是 `---\r\n`（Windows 行尾），`startsWith('---\n')` 返回 false → frontmatter 不被跳过。不过 Obsidian 在所有平台统一用 `\n`，所以实际不会触发。

---

## 流程二：悬停波浪线 → 点击应用/忽略

### 场景7：用户应用修正后，同句其他错误不更新

```
原句: "He don't have nothing to lose."
AI 检测: "don't" → "doesn't" (语法), "have nothing" → "have anything" (表达)
用户点击 "don't" 的 [应用] → 文本变成 "He doesn't have nothing to lose."
```

**期望（PRD第74行）**: "have nothing" 的黄色波浪线暂时消失，自动重新检查，重新标注剩余错误 "have nothing" → "have anything"  
**实际**: "have nothing" 的黄色波浪线保持原样，不重新检查。用户需要再手动打一个句号才触发重新检查。  
**原因**: 代码故意不做 recheck，注释：`// Do NOT recheck here — recheck clears ALL marks in the sentence range... A new check will trigger on the next sentence-end character.`  
**影响**: 违反了 PRD 的核心产品逻辑。用户应用修正后，如果文中的其他错误因为修正而改变了上下文（比如语法修复后表达建议不再适用），旧标记会残留。

### 场景8：用户快速关闭再打开文件，忽略的标记不会重新出现

```
操作顺序:
1. 打开文件A，"writed" 被标蓝
2. 点击 [忽略] → 波浪线消失
3. 立刻 Ctrl+W 关闭文件A
4. 立刻重新打开文件A（<1秒内）
```

**期望（PRD第76行）**: "关掉文件再打开，同样的错误会重新标出来"  
**实际**: 文件A的 "writed" 波浪线**不出现**（仍处于忽略状态）  
**原因**: 
- 忽略标记的状态存储在内存 `markStore.ignored` 
- 关闭文件时，`onFileClose()` 虽然存在但从未被调用（死代码，`main.ts:192-198`）
- 忽略状态的清理只在 `save()` → `cleanupClosedFiles()` 中进行，有1秒 debounce
- 用户在 1 秒内关闭并重开文件，`save()` 尚未触发 → `cleanupClosedFiles` 没执行 → 忽略状态仍在内存 → 重开后标记被过滤

**影响**: 用户困惑：明明关了文件，为什么忽略的标记没回来？和直觉行为不符。

### 场景9：用户关闭文件后，侧边栏仍显示已关闭文件的状态

```
操作顺序:
1. 打开文件A，有错误，侧边栏显示错误列表
2. 点击侧边栏（让侧边栏获得焦点）
3. Ctrl+W 关闭文件A
```

**期望**: 侧边栏显示当前活跃文件的错误（或显示"没有发现错误"）  
**实际**: 侧边栏短暂显示文件A的残余内容（因为 `lastFilePath` 回退）  
**原因**: `sidebarView.ts:300` 的 `getActiveFilePath()` 在侧边栏有焦点时，`getActiveViewOfType(MarkdownView)` 返回 null，回退到 `lastFilePath`（仍指向已关闭的文件A）。直到下一次 `active-leaf-change` 或 `file-open` 事件触发刷新，侧边栏才会更新。

### 场景10：光标刚好在波浪线后方时误弹 tooltip

```
文本: "He go[to] school."
         ^^^    ^
         mark   cursor here
```

**期望**: 光标在 `]` (position 5) 时不应该弹 tooltip（下划线只覆盖 `[3, 5)`）  
**实际**: Tooltip 弹出  
**原因**: `tooltip.ts:21` 使用 `pos <= m.to`（而非 `pos < m.to`），position 5 即使是标记的结束位置（不包含在 decoration 内），也会触发 tooltip。

---

## 流程三：侧边栏操作

### 场景11：在侧边栏点[应用]时文本已经不匹配了

```
操作顺序:
1. 文件A有错误 "writed" 在位置 10-16，侧边栏显示此错误
2. 用户切到编辑器，手动修改 "writed" → "wrote"
3. 错误标记被 validateMarks 移除
4. 用户切回侧边栏，侧边栏因 debounce(50ms) 尚未刷新
5. 用户点击侧边栏中 "writed" 条目的 [应用] 按钮
```

**期望**: 什么都不发生，或提示"文本已变更"  
**实际**: 静默失败，`findFreshMark` 返回 null → `console.warn` → 按钮无反应。用户看不到 console，不知道发生了什么。  
**代码**: `sidebarView.ts:230` — 找不到 mark 时只是 warn + return，没有用户可见的反馈。

### 场景12：侧边栏点了[应用]但编辑器不在屏幕内

```
操作顺序:
1. 文件A有错误，文件在后台的 split pane 中
2. 用户看到侧边栏，点击 [应用]
```

**期望**: 修改生效  
**实际**: `getEditorForFile` 遍历所有 markdown leaves 找到文件A的编辑器，`cm.dispatch` 替换文字 ✓  
**验证**: 代码正确处理了后台编辑器的场景 ✓

---

## 流程四：手动改文字 → 波浪线消失 → 进错题本

### 场景13：用户改了错误词，但改错了

```
原句: "He writed a letter." → "writed" 被标蓝
用户手动改成: "He writted a letter."
```

**期望**: "writed" 波浪线消失（文本变了），错误记入错题本，新文本重新检查  
**实际**: 
- `validateMarks` 检测到 `doc.sliceString(from, to)` = "writted" ≠ "writed" → 移除标记 ✓
- `appendError` 记录到错题本（fire-and-forget）✓ 但不 await
- 但句子不 recheck（禁用了）→ 用户需要手动打标点触发新检测
- **问题**: 如果 `appendError` 失败（比如文件被锁定），错题记录丢失，用户不会知道

### 场景14：用户删除了错误词，没有替换

```
原句: "I has a apple." → "has" 和 "a apple" 两条波浪线
用户删除 "has " → 句子变成 "I a apple."
```

**期望**: "has" 的波浪线消失（因为文本被删了），"a apple" 的波浪线自动位移  
**实际**: 
- `mapPositions` 将 "a apple" 标记的位置从 `[4, 11]` 调整为 `[2, 9]` ✓
- "has" 标记的 from=2, to=5 → 删除后 from=2, to=2（from < to 不成立）→ `mapPositions` 的最后一步 `marks.filter(m => m.from < m.to)` 自动移除 ✓
- "a apple" 标记移位到 `[2, 9]` → `validateMarks` 校验 `sliceString(2, 9)` = "a apple" = 原始文本 → 保留 ✓

正确处理。

---

## 流程五：开关切换

### 场景15：禁用期间修改文本，重新启用后波浪线部分消失

```
操作顺序:
1. 有错误 "writed" 显示波浪线
2. 用户禁用 LangGhost（状态栏显示 "LangGhost: off"）
3. 用户手动改 "writed" → "wrote"
4. 用户重新启用 LangGhost
```

**期望**: "writed" 的波浪线不出现（用户已手动修正）  
**实际**: 波浪线不出现，错误记入错题本 ✓  
**验证**: 
- 禁用期间 `decorations.ts update()` 仍然运行，`validateMarks` 照常移除陈旧标记 ✓
- `validateMarks` 中 `plugin.settings.enabled` 只控制 recheck，不影响 `toRemove` 和 `appendError` ✓
- 重新启用后 `buildDecorations` 返回现有标记，已移除的标记不会出现 ✓

正确处理。

### 场景16：禁用后再启用，在此期间其他文件产生的新错误

```
操作顺序:
1. 文件A有错误，LangGhost 开启
2. 用户禁用了 LangGhost → A的波浪线消失
3. 在文件B中输入 "She don't know." → 无检测
4. 重新启用 LangGhost
```

**期望**: 文件B不显示错误（因为禁用期间未检测），文件A恢复显示错误  
**实际**: 
- 文件B: 禁用期间 `detector` 跳过，没有 dispatch → 无标记 → 重新启用后文件B确实没有错误 ✓
- 文件A: 旧标记保留在 markStore → 重新启用后恢复显示 ✓

正确处理。但文件B中已有的错误不会自动检测，用户需要再输入一个句末标点触发检测。用户可能以为"启用后该自动检查"但不会。

---

## 流程六：关闭重启 Obsidian → 持久化

### 场景17：重启 Obsidian 后，波浪线位置偏移

```
操作顺序:
1. 文件开头 "He go to school." 中 "go" 被标红
2. 用户保存并退出 Obsidian
3. 重开 Obsidian，在文件开头插入新的段落 "My diary.\n\n"
4. 打开该文件
```

**期望**: "go" 的波浪线随文本下移  
**实际**: 
- 持久化时 `PersistedError.from = 2, to = 4` ✓
- 重开文件，docText 已变为 "My diary.\n\nHe go to school."
- `findBestMatch("My diary.\n\nHe go to school.", "go", 2)`: 
  - 在 `hintPos - 50 = 0` 附近搜索 "go" → 找到位置 18 → 在 `hintPos + 50` 范围内 → 返回 18 ✓
- 波浪线位置正确 ✓

但如果原始 mark 的 `sentenceFrom` 和 `sentenceTo` 计算依赖 `sentOffset`：
```typescript
sentenceFrom: sentOffset !== -1 ? Math.max(0, idx - sentOffset) : Math.max(0, idx - 50),
sentenceTo: sentOffset !== -1 ? Math.max(0, idx - sentOffset) + pe.error.sentence.length : idx + pe.error.original.length + 50,
```
`sentOffset` 从持久化的 `pe.error.sentence.indexOf(pe.error.original)` 计算。持久化的 `sentence` 是原始句子 "He go to school."。在新的文档中，`idx` 是 "go" 的新位置 (18)，`sentOffset` 是 "go" 在 "He go to school." 中的位置 (3)。所以 `sentenceFrom = 18 - 3 = 15`，指向新 "He" 的位置。`sentenceTo = 15 + 19 = 34`（句子长度 19）。这是"某个大致是正确句子的范围"。"He go to school." 在新文档中确实从位置 15 开始。✓

正确处理。

### 场景18：关闭 Obsidian 前一刻，忽略操作未保存到磁盘

```
操作顺序:
1. 打开文件A，"writed" 标蓝
2. 点击 [忽略] → 波浪线消失
3. 立刻退出 Obsidian（Ctrl+Q）
```

**期望**: 忽略操作持久化到磁盘，下次启动时仍忽略  
**实际**: 取决于退出时机  
- 如果 Obsidian 在 1 秒后退出（debounce 顺利完成）→ `save()` 已执行 → 持久化 ✓
- 如果 Obsidian 在 1 秒内退出 → `scheduleSave` 的 debounce 还没触发 → `onunload()` 的 `await this.persistence.save()` 会执行 → 持久化 ✓
- **但**：`save()` → `cleanupClosedFiles()` 会删除文件A的 marks + ignored 状态。如果 Obsidian 关闭时文件A的 leaf 已被销毁 → `cleanupClosedFiles` 删除 ignored 状态 → 下次启动时 "writed" 不会被忽略

**验证**: `onunload()` 调用 `save()` → `cleanupClosedFiles()` → 如果 markdown leaves 在 onunload 时还存在（Obsidian 关闭流程），则 ignored 状态保留。如果 Obsidian 先销毁 leaf 再调 onunload，则 ignored 状态丢失。

这取决于 Obsidian 的生命周期顺序，不同版本可能不同。存在不确定性。

---

## 流程七：句子提取的边界情况

### 场景19：拉丁缩写（e.g. / i.e. / a.m. 等）导致错误断句

```
用户输入: "We use e.g. this method. Another sentence."
                              ^ 这个句号被错误当作句子结束
```

**期望**: "We use e.g. this method." 作为完整句子被提取并检测  
**实际**: 只提取了 "this method."，"We use e.g." 部分丢失  
**原因**: `extractor.ts:108` 的 `findWordStart` 函数：
```typescript
function findWordStart(text: string, periodPos: number): number {
  let i = periodPos - 1;
  while (i >= 0 && /[a-zA-Z]/.test(text[i])) { i--; } // ← 遇到 . 就停
  return i + 1;
}
```
对于 "e.g."，当扫描到 "g" 后面的句号时，`findWordStart` 从 `g` 向前扫，遇到 `.`（`[a-zA-Z]` 不匹配）就停止，得到单词 `"g"` → `ABBREVIATIONS.has("g")` → false → 句号被当作句子结束。

**受影响的所有缩写**: `e.g.`、`i.e.`、`a.m.`、`p.m.`、`u.s.`、`u.k.`、`vs.` —— **全部失效**。只有单字母缩写（`Dr.`、`Mr.`、`Ms.`）能正常工作。

**影响**: 高频。英语写作中使用 "e.g." / "i.e." / "etc." 极为常见，导致包含这些缩写的句子被截断，前半部分不被检测。

### 场景20：缩写列表不完整

```
"No. 1 bus. This is it."
  ^ 被错误当作句子结束
```

`ABBREVIATIONS` 集合缺少 `"no"`（number 的缩写）。同样缺少 `viz.`、`ca.`、`est.`、`approx.` 等常见缩写。

### 场景21：同一文件中两个完全相同的句子，第二个可能不被检测

```
文件内容:
"He go to school. He go to school."
```

用户在 2 秒内输入两句相同的 "He go to school."。

**期望**: 两句都检测  
**实际**: 如果第一句的 AI 检查还在进行中（~2秒），第二句的 dispatch 因其 key 相同被去重跳过  
**原因**: `dispatcher.ts:24` 的去重 key 是 `filePath + ':' + sentence.text`，不含位置信息。当两句文本相同时 key 碰撞。第一句检查完成后 key 才释放，但第二个 dispatch 已经因为 `this.activeChecks.has(key)` 提前 return 了。  
**影响**: 低频但存在——用户在同一个文件里重复输入同样句子，且间隔小于 AI 响应时间（~2秒）。如果 AI 很快（< 500ms）或间隔较大，则不会触发。

### 场景22：`prevMarks` 字段——死代码

**文件**: `src/decorations.ts:23,143,150`  
`prevMarks: Map<string, string>` 在 `snapshotMarks()` 中被填充（每帧调用），但 **从未被读取**。纯粹浪费 CPU。

### 场景23：侧边栏双击 [应用] 按钮

```
操作:
1. 侧边栏有错误条目
2. 用户双击 [应用] 按钮（或快速点击两个不同条目的应用）
```

**期望**: 第二次点击被忽略或给出提示  
**实际**: 
- 第一次点击：`removeMark` + `dispatch` + `scheduleRefresh(50ms)`
- 第二次点击在 50ms 内 → 侧边栏列表还是旧的 → `findFreshMark` 找不到已删除的 mark → `console.warn` → 静默失败
- 用户看到按钮点了但"没反应"

---

## 流程八：错误标记的边界情况

### 场景24：一句话里有多个相同错误词

```
用户输入: "He go. She go. We go."
AI 对每句分别返回 "go" → "goes/went" 的修正
```

**期望**: 三个 "go" 分别正确标注  
**实际**: 
- `errorsToMarks` 使用 `findOriginalInSentence` 定位 "go" 在句子中的位置
- 每个句子都只有一处 "go" → `positions.length === 1` → 返回唯一位置 ✓
- 但如果 AI 返回的 context 不匹配（比如 AI 给的 context 是另一个句子中的），`findOriginalInSentence` 可能选错位置
- 每个句子的 "go" 被独立 dispatch → 三个 dispatch 并发 → AI 并发 3 ✓

正确处理。

### 场景20：用户在同一位置反复修改产生重叠标记

```
操作顺序:
1. AI 检查 "He writed a letter." → "writed" 标蓝
2. 用户忽略 → 蓝线消失
3. 用户又写了一句导致 document 变化 → 同一位置被 re-extract → 新的 AI 检查又标出 "writed"
```

**期望**: "writed" 重新出现（因为上下文变了，这是新错误）  
**实际**: 
- 第一次忽略 → `markStore.ignore(filePath, errorId)` → `ignored` set 包含该 errorId
- 第二次检查 → 生成新的 ErrorItem → 有新的 `crypto.randomUUID()` → 新的 errorId
- `getMarks()` 检查 `ignoredSet.has(m.error.id)` → 新 errorId 不在 ignored 中 → 标记显示 ✓
- 忽略是基于 error ID 的，不是基于位置。所以新检查产生新 ID，旧忽略不影响。✓

正确处理。

### 场景21：忽略后再手动在相同位置打错产生同样错误

```
"writed" → 忽略 → 同一位置又打 "writed"（AI重新检查同一句）→ AI 标记 "writed"
```

**期望**: 新标记显示（新的 error ID）  
**实际**: 同场景20，新的检查产生新的 errorId → 显示 ✓

---

## Bug 汇总（按影响严重程度）

| # | 场景 | 触发频率 | 影响 |
|---|------|---------|------|
| 1 | `#tag.` 后的句子不检测 | 极高 | 标签后的英语不检测 |
| 2 | 未闭合 `[[` 阻断所有后续检测 | 极高 | wikilink 写作中所有句子检测被阻断 |
| 3 | e.g./i.e./a.m. 等缩写全部不生效 | 极高 | 包含这些缩写的句子被截断 |
| 4 | 粘贴多句只检测第一句 | 高 | 粘贴英文段落大部分句子未被检测 |
| 5 | 应用修正后不 recheck（PRD矛盾） | 高 | 修改一个错误后其他错误不自动更新 |
| 6 | 关闭再打开文件，忽略标记不回来 | 中 | 和用户直觉和PRD不符 |
| 7 | API endpoint 重复拼接 | 中 | 配错endpoint的用户完全用不了AI |
| 8 | 同一文件两个相同句子第二个可能漏检 | 低 | dispacher去重key不含位置 |
| 9 | `isInsideCodeBlock` 不处理4-backtick | 低 | 技术文档写作者受影响 |
| 10 | 缩写列表缺 "No." 等 | 低 | 少数缩写导致断句错误 |
| 11 | tooltip hover 边界 `<=` 误触发 | 极低 | 光标在文字边界处弹出tooltip |
| 12 | 侧边栏动作失败/双击静默无反馈 | 极低 | 用户困惑按钮点了没反应 |
| 13 | `prevMarks` 死代码 | — | 每帧徒劳填充从未读取的Map |

## 根本原因诊断

| 根本原因 | 涉及场景 |
|---------|---------|
| `isInsideTag` 正则表达式过于宽泛 (`\S`) | 1 |
| `isInsideDoubleLink` 只向前看、不向后看 | 2 |
| `findWordStart` 扫描遇到 `.` 就停 | 3, 10 |
| detector 单次触发限制 (`return`) | 4 |
| 故意不做 recheck（与PRD矛盾） | 5 |
| `onFileClose` 死代码 + debounce 时序 | 6 |
| endpoint 无条件拼接 | 7 |
| dispatcher 去重 key 不含位置信息 | 8 |
| 代码块检测不区分围栏长度 | 9 |
| tooltip 边界 `<=` | 11 |
| 静默 `console.warn` / fire-and-forget | 12 |
| 重构残留未清理 | 13 |

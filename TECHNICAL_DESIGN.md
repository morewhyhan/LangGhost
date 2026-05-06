# LangGhost — 技术设计文档

## 双层检查架构

```
用户写完一句话
       │
       ▼
  ┌─────────────┐
  │ harper.js    │  第一层：本地检查（毫秒级，免费，离线可用）
  │ 本地语法库   │  → 拼写错误（蓝色）
  └──────┬──────┘  → 语法错误（红色）
         │         结果立即写入 markStore
         ▼
  ┌─────────────┐
  │ AI API      │  第二层：语义检查（1-2秒，按次收费，需联网）
  │ DeepSeek 等 │  → 表达建议（黄色）+ 中译英建议（绿色）
  └──────┬──────┘  → 也会检查拼写/语法（与本地重叠的自动跳过）
         │
         ▼
    合并结果，渲染波浪线
```

执行顺序：本地先跑（毫秒级），结果立即写入 markStore 渲染波浪线。AI 后跑（1-2 秒），返回后重叠去重再追加。断网时只有第一层工作。

## 非功能性要求

| 指标 | 目标 | 说明 |
|------|------|------|
| 插件启动 | < 3 秒 | WASM 在后台加载，不阻塞 Obsidian |
| WASM 加载 | < 5 秒 | 加载期间状态栏提示"加载中"，不影响编辑 |
| 本地检查延迟 | < 100ms | 用户敲完句号到波浪线出现 |
| AI 检查延迟 | < 3 秒 | 超过 3 秒状态栏提示"AI 检查较慢" |
| 并发 AI 请求上限 | 3 个 | 信号量 + 等待队列，超出的排队 |
| 内存占用 | < 50MB | 包括 WASM 运行时和错误数据 |
| 持久化错误上限 | 1000 条 | 超过后按 createdAt 清理最旧的 |
| 持久化清理 | 恢复时 | 丢弃超过 30 天的错误 |
| 持久化每文件 | 50 条 | 超过则截断 |
| 错题本大小 | 不限 | 用户自己管理，插件不自动清理 |

## 项目结构

```
LangGhost/
├── main.ts              入口，注册所有模块，初始化依赖
├── src/
│   ├── types.ts         类型定义 + 设置默认值
│   ├── linter.ts        harper.js 封装（本地检查）
│   ├── checker.ts       AI API 调用 + Prompt + 响应解析
│   ├── detector.ts      CM6 ViewPlugin：句末检测
│   ├── extractor.ts     句子提取 + frontmatter/代码块/双链过滤
│   ├── dispatcher.ts    检查调度器：本地→AI 顺序执行 + 并发控制
│   ├── decorations.ts   CM6 ViewPlugin：波浪线渲染 + 手动编辑检测
│   ├── tooltip.ts       CM6 Extension：悬浮气泡（应用/忽略）
│   ├── sidebarView.ts   Obsidian ItemView：侧边栏错误列表
│   ├── markStore.ts     错误标记容器（增删查、去重、忽略、位置映射）
│   ├── persistence.ts   持久化（保存/恢复/清理/关闭文件内存回收）
│   ├── errorBook.ts     错题本写入（Markdown，按日期分节）
│   └── settings.ts      设置页 UI
├── styles.css           波浪线 + tooltip + 侧边栏样式
├── manifest.json        插件清单
├── esbuild.config.mjs   构建配置
└── package.json
```

## 模块依赖关系

```
                    main.ts
                   （持有所有单例）
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
      settings     markStore    dispatcher
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
                extractor      linter       checker
                                  │             │
                                  ▼             ▼
                            (harper.js)    (AI API)
                                  │             │
                                  └──────┬──────┘
                                         ▼
                                    markStore
                                         │
                    ┌──────────┬──────────┼───────────┐
                    ▼          ▼          ▼           ▼
               persistence  sidebarView  errorBook   decorations
                              │                           │
                              │                           ▼
                              └─── 订阅 onChange ────── tooltip
```

**通信方式：** main.ts 持有所有模块实例，通过依赖注入传递。CM6 扩展通过 StateField 获取 markStore/dispatcher/plugin 引用。

**不用的方式：** 不用全局变量、不用事件总线。CM6 扩展之间不直接通信，都通过 markStore 和 dispatcher 间接交互。

**CM6 扩展获取上下文的方式：**
- 文件路径：`view.state.field(editorInfoField).file?.path`
- markStore / dispatcher / plugin：通过 main.ts 注册的 StateField

## 数据结构

### ErrorItem（错误描述，可序列化）

```typescript
interface ErrorItem {
  id: string;                    // uuid
  original: string;              // 错误原文 "go"
  corrected: string;             // 修正 "went"
  alternatives?: string[];       // 其他修正选项 ["am going"]
  type: 'grammar' | 'spelling' | 'expression' | 'translation';
  explanation: string;           // 15 字以内中文解释
  source: 'local' | 'ai';       // 来源
  context: string;               // 错误周围文本，用于多出现消歧
  sentence: string;              // 完整句子
  createdAt: number;             // 创建时间戳，持久化时保留原始值
}
```

### ErrorMark（运行时，含文档位置）

```typescript
interface ErrorMark {
  error: ErrorItem;
  from: number;                  // CM6 文档位置
  to: number;                    // CM6 文档位置
  sentenceFrom: number;          // 句子起始位置（随编辑映射）
  sentenceTo: number;            // 句子结束位置（随编辑映射）
}
```

### 错误生命周期

```
detected（已检测）
   │
   ├─→ displayed（显示中，有波浪线）
   │      ├─→ applied（用户点了应用）
   │      ├─→ ignored（用户点了忽略）
   │      ├─→ dismissed（用户手动改了那个区域）
   │      └─→ expired（文件内容变了，恢复时 surroundingText 不匹配）
   │
   └─→ discarded（检查结果被丢弃：内容已变 / 结果冲突 / 解析失败）
```

`applied` 和 `dismissed` 记入错题本。`ignored` 加入忽略列表。

### 持久化格式

```typescript
interface PersistedError {
  error: ErrorItem;
  from: number;
  to: number;
  surroundingText: string;       // 错误周围 50 字
  filePath: string;
  createdAt: number;             // 继承自 ErrorItem.createdAt
}
```

### 插件设置

```typescript
interface LangGhostSettings {
  apiKey: string;                // 默认 ''
  apiEndpoint: string;           // 默认 https://api.deepseek.com/anthropic
  model: string;                 // 默认 deepseek-v4-flash
  errorBookPath: string;         // 默认 LangGhost/errors.md
  enabled: boolean;              // 默认 true
  firstRun: boolean;             // 默认 true，首次安装打开侧边栏后置 false
}
```

## 模块设计

### main.ts — 入口

职责：创建所有模块实例，注入依赖，注册 Obsidian 扩展和事件。

启动顺序：
1. 加载设置
2. 创建 markStore、checker、linter、dispatcher、errorBook、persistence
3. `linter.init()` 后台加载 WASM（不阻塞）
4. `persistence.restore()` 恢复 ignored 状态
5. 注册 markStore listener → 持久化 + 强制 decoration 重建
6. 创建 CM6 StateField（markStore / dispatcher / plugin）
7. 注册 CM6 扩展（detector / decorations / tooltip）
8. 注册设置页、toggle 命令、侧边栏
9. 注册 `active-leaf-change` → 恢复文件 marks + 重建 decoration
10. 注册 `file-open` → markStore.onFileOpen

共享的 `updateStatus` 回调：当消息为空且 linter 有加载错误时，回退显示 linter 错误（保护持久性消息不被 AI 检查的 finally 块覆盖）。

Toggle 命令：切换 `settings.enabled`，向所有 markdown leaf dispatch `markStoreChangedEffect`，向所有 sidebar leaf 调用 `requestRefresh()`。

### linter.ts — 本地检查（harper.js）

职责：封装 harper.js WASM，提供统一的 `lint()` 接口。

```typescript
class LocalLinter {
  async init(): Promise<void>;         // 后台加载 WASM
  async lint(text: string): Promise<ErrorItem[]>;
  isReady(): boolean;
  get initError(): string | null;      // 加载失败时保留错误信息
  async destroy(): void;
}
```

WASM 加载：通过 `app://local/` 协议从插件目录加载。加载失败时设置 `initError`，状态栏持续显示错误。

规则映射：
- 拼写相关规则 → `type: 'spelling'`（蓝色）
- 其他所有规则 → `type: 'grammar'`（红色）
- explanation：维护规则名→中文映射表，未覆盖的用英文原文截断 15 字

### checker.ts — AI 调用

职责：构造 prompt，发送请求（15s 超时），解析响应（兼容 markdown code block）。

```typescript
class AIChecker {
  async check(text: string): Promise<ErrorItem[]>;
}
```

- 无 API Key 时直接返回 `[]`，不发请求
- `max_tokens: 1024`（容纳 ~30 条修正）
- 响应解析：`JSON.parse` → code block 提取 → 数组正则提取（三级 fallback）
- 错误处理：401/429/网络错误/超时 → 状态栏提示
- 超时后 finally：>3s 立即清状态栏，<3s 延迟 500ms（避免闪烁）

### extractor.ts — 句子提取 + 内容过滤

职责：从文档中提取一句话，跳过不需要检查的区域。

```typescript
function extractSentence(doc: Text, triggerPos: number): SentenceRange | null;
```

- 从 triggerPos 往前扫描，找到上一个句末标点（`.?!。？！`）或空行或文件开头
- 跳过缩写词中的句号（Mr. Mrs. Dr. etc. e.g. i.e. ...）
- 只 `sliceString(0, triggerPos + 1)`，不拷贝整个文档

跳过规则：YAML frontmatter / 代码块 / 双链 `[[...]]` / 标签 `#tag`

### detector.ts — 句末检测

CM6 ViewPlugin。监听文档变化，检测新增的句末标点，触发 dispatcher.dispatch。

每次 change 只处理第一个句末标点（`return` 提前退出）。

### dispatcher.ts — 检查调度器

职责：接收句子，顺序执行本地+AI检查，合并结果，更新 markStore。

```typescript
class Dispatcher {
  async dispatch(sentence, filePath): Promise<void>;
  async recheck(sentence, filePath): Promise<void>;
}
```

**dispatch 逻辑：**
1. 同句子去重：`activeChecks: Map<filePath:text, Promise>` 防止重复检查
2. 本地检查：`linter.lint()` → `errorsToMarks()` → `markStore.addMarks()`（立即渲染）
3. AI 检查：`enqueueAI(() => checker.check())`（信号量限制 3 并发）
4. AI 结果通过 `addMarks` 重叠去重自动跳过已被本地覆盖的位置

**recheck 逻辑：** `clearSentenceMarks` → `dispatch`

**errorsToMarks：** `findOriginalInSentence()` 处理同一词多次出现——用 AI 返回的 `context` 消歧。

### markStore.ts — 错误标记容器

纯粹的标记容器。不含持久化逻辑、不含调度逻辑。

```typescript
class MarkStore {
  addMarks(filePath, marks): void;        // 按 id 去重 + 按位置重叠去重
  removeMark(filePath, errorId): void;
  getMarks(filePath): ErrorMark[];        // 排除已忽略的
  hasMarks(filePath): boolean;            // 不过滤 ignored（用于 restore 判断）
  clearSentenceMarks(filePath, from, to): void;
  ignore(filePath, errorId): void;
  mapPositions(filePath, mapFn, changeKey): void;  // CM6 update 内调用
  cleanupClosedFiles(openPaths): void;    // 清理已关闭文件的内存数据
  addListener / removeListener(fn): void;
}
```

位置映射防重入：`lastMappedKey` 用 change fingerprint 防止分屏同文件时双重映射。

### decorations.ts — 波浪线渲染 + 手动编辑检测

CM6 ViewPlugin。

**buildDecorations：** 检查 `plugin.settings.enabled`，禁用时返回空。从 markStore 读取 marks，按 type 分配 CSS class。

**update 流程：**
1. `mapPositions` — 映射所有 mark 位置到新坐标系
2. `validateMarks` — 检查 change 区域附近的 marks，文本不匹配则：
   - 记录到错题本
   - 收集 recheck（用 `Map<sentenceFrom>` 去重，每句只 recheck 一次）
   - 批量删除 marks
3. 重建 decorations

### tooltip.ts — 悬浮气泡

CM6 hoverTooltip。悬停 200ms 触发。

**应用流程：**
1. 用 `errorId` 从 markStore 查找最新 mark（避免闭包过期）
2. 位置验证：`doc.sliceString(from, to) !== original` → 放弃
3. `removeMark`（先删，防止 validateMarks 重复记录错题本）
4. `view.dispatch` 替换文本
5. 用 `offsetInSentence = from - sentenceFrom` 精确构造修正后句子
6. `dispatcher.recheck`

**忽略流程：** `markStore.ignore(filePath, errorId)`

### sidebarView.ts — 侧边栏错误列表

Obsidian ItemView。订阅 markStore listener + `active-leaf-change` + `file-open` 刷新列表。

- 50ms 防抖合并多次刷新
- 禁用时显示"LangGhost: 检查已禁用"（不是"没有发现错误"）
- `lastFilePath` 缓存：侧边栏有焦点时回退到上次文件
- 按钮只捕获 `errorId`，点击时从 markStore 查找最新位置（避免闭包过期）
- `getEditorForFile()` 按 `getLeavesOfType('markdown')` 查找，不依赖 active view

### persistence.ts — 持久化

```typescript
class Persistence {
  async save(): Promise<void>;           // 防抖 1 秒，保存后清理已关闭文件
  scheduleSave(): void;                  // 防抖调用 save
  async restore(): Promise<void>;        // 启动时恢复 ignored 状态
  async restoreFile(filePath, docText): Promise<ErrorMark[]>;  // 文件切换时恢复
}
```

- `toPersisted` 用 `error.createdAt || now` 保留原始时间（30 天清理依赖此字段）
- `restoreFile` 用 `findBestMatch()` 宽容匹配位置（±50 → 全文最近匹配）
- 每次 save 后调用 `cleanupClosedFiles()` 释放已关闭文件的内存

### errorBook.ts — 错题本

追加错误记录到 Markdown 文件。`app.vault.process()` 原子读写。按 `## YYYY-MM-DD` 分节。`escapeMd()` 转义用户文本中的 Markdown 特殊字符。

### settings.ts — 设置页

| 设置项 | 控件 | 默认值 |
|--------|------|--------|
| API Key | TextComponent (password) | '' |
| API Endpoint | TextComponent | https://api.deepseek.com/anthropic |
| Model | TextComponent | deepseek-v4-flash |
| Error Book Path | TextComponent | LangGhost/errors.md |

不填 API Key 也能用本地检查。

## 关键流程

### 句子检测 → 标注（双层）

```
用户输入 "."
  → detector 检测到句末标点
  → extractor.extractSentence(doc, pos)
  → dispatcher.dispatch(sentence, filePath)
     ├─ linter.lint(sentence.text)         ← 毫秒级
     │  → errorsToMarks() → markStore.addMarks()
     │  → markStore.onChange → decorations 渲染红/蓝波浪线
     │
     └─ enqueueAI(checker.check)           ← 1-2 秒，并发限制 3
        → errorsToMarks()（重叠去重）
        → markStore.addMarks(非重叠的)
        → markStore.onChange → decorations 追加黄/绿波浪线
```

### 应用修正（tooltip / sidebar 共用逻辑）

```
用户点击 [应用]
  → 用 errorId 从 markStore 查找最新 mark（避免闭包过期）
  → 验证 doc.sliceString(from, to) === original
  → markStore.removeMark()                  // 先删，防止 validateMarks 重复记录
  → cm.dispatch({ changes: 替换文本 })
  → errorBook.appendError()
  → 用 offsetInSentence = from - sentenceFrom 精确构造修正后句子
  → dispatcher.recheck(correctedSentence)
     → clearSentenceMarks() → dispatch()   // 同"句子检测"流程
```

### 手动编辑检测

```
用户编辑波浪线区域的文字
  → decorations.update()
     → mapPositions()                       // 映射所有 mark 到新坐标系
     → validateMarks()                      // 检查 change 附近 marks
        → doc.sliceString(from, to) !== original?
           → errorBook.appendError()
           → 检查 enabled：禁用时只删 mark 不 recheck
           → 收集 recheck（每句去重，只触发一次）
           → 批量 removeMark()
        → 批量 dispatcher.recheck()         // 仅 enabled 时
```

### 文件切换

```
active-leaf-change 事件
  → markStore.hasMarks(filePath)? 已有则跳过
  → persistence.restoreFile(filePath, docText)
     → findBestMatch() 宽容匹配位置
     → markStore.addMarks(filePath, marks)
  → cm.dispatch(markStoreChangedEffect)     // 强制重建 decoration
```

### 插件启动

```
main.onload()
  → 加载设置
  → 创建所有模块
  → linter.init()                          // 后台加载 WASM
  → persistence.restore()                  // 恢复 ignored 状态
  → 注册 CM6 扩展 + 事件 + 命令 + 侧边栏
  → 首次安装时自动打开侧边栏（firstRun flag）
```

## 技术风险与对策

| 风险 | 对策 |
|------|------|
| harper.js WASM 加载慢 | WorkerLinter 后台加载，加载期间状态栏提示 |
| harper.js 规则描述是英文 | 维护常见规则中文映射表，未覆盖的用英文截断 |
| 修正后波浪线闪烁 | 本地检查毫秒级返回，几乎无感；AI 波浪线短暂消失可接受 |
| 两层结果重叠 | addMarks 按位置重叠去重，本地先到优先 |
| 并发 AI 请求 | 信号量（max 3）+ 等待队列 |
| 分屏同文件 mapPositions 双重映射 | change fingerprint 去重 |
| 与其他语法插件冲突 | 设置页提示建议禁用其他语法检查插件 |

## 设计原则

### 闭包与状态

1. **不在闭包中持有 mark 对象**：按钮/回调只捕获 `errorId` 和 `filePath`，操作时从 markStore 查找最新数据。
2. **不依赖 `getActiveViewOfType`**：侧边栏交互中用 `getLeavesOfType('markdown')` 按路径查找，避免侧边栏有焦点时返回 null。
3. **侧边栏和编辑器状态必须同步**：toggle 等全局状态变更时，decorations 和 sidebar 都要刷新。

### CM6 集成

4. **CM6 dispatch 不能用 `queueMicrotask`**：必须用 `setTimeout` 延迟到 update cycle 结束后。
5. **先 mapPositions 再 validateMarks**：映射后才能用 `doc.sliceString` 对比。不要反过来。
6. **区间重叠检测用闭区间**：删除操作产生零长度范围，开区间永远不包含。用 `<=`/`>=`。
7. **共享状态的位置映射必须防重入**：多个 CM6 view 可能触发同一 change 的映射。用 change fingerprint 去重。
8. **同句多 mark 失效只 recheck 一次**：用 `Map<sentenceFrom>` 去重。

### 字符串与位置

9. **字符串定位用位置偏移而非 indexOf/replace**：同一文本多次出现时，用 `mark.from - mark.sentenceFrom` 计算精确偏移。
10. **不要 doc.toString() 拷贝整个文档**：CM6 Text 支持 `sliceString` 高片。

### 持久化与内存

11. **判断是否需要 restore 用原始数据**：用 `hasMarks()`（不过滤），不能用 `getMarks()`（过滤 ignored 后可能误判为空）。
12. **ErrorItem 携带 createdAt**：跟随 ErrorItem 流传，不再在每次 save 时覆盖。
13. **持久化保存后清理内存**：先写后删确保数据不丢失。
14. **插件首次行为与常态行为分离**：`firstRun` flag 控制一次性引导。

### 外部依赖

15. **外部 API 调用必须限并发**：信号量 + 等待队列。
16. **fetch 必须设超时**：AbortController + setTimeout。
17. **共享状态栏要保护持久性消息**：linter 加载失败等消息，空消息时回退显示。
18. **错题本输出要转义 Markdown**：AI 返回的文本可能含 `*`、`[`、`` ` `` 等。
19. **生产代码不留 console.log**：只保留 `console.warn` 和 `console.error`。
20. **禁用时禁止触发 API 调用**：`validateMarks` 检查 `enabled`，只删过期 mark 不 recheck。
21. **addMarks 去重要覆盖同批**：累积 `accepted` 数组，批内也做重叠检查。

## Bug 修复历史

### 第一轮：波浪线与侧边栏随机消失

- **Bug 1**: `queueMicrotask` 装饰刷新竞态 → 改用 `setTimeout(0)`
- **Bug 2**: `onFileClose` 删除所有 marks → 只清 ignored
- **Bug 3**: 切换文件时侧边栏不刷新 → 增加 `file-open` 监听
- **Bug 4**: 侧边栏闭包捕获过时 mark → 改为只捕获 errorId

### 第二轮：侧边栏按钮操作导致消失

- **Bug 7**: 点击按钮后侧边栏空白 → `lastFilePath` 缓存回退
- **Bug 8**: 侧边栏应用按钮静默失败 → `getEditorForFile` 按路径查找
- **Bug 10**: Persistence restore 导致 mark 重复 → `hasMarks()` 原始数据判断
- **Bug 12**: ignored 状态不持久化 → `getIgnoredSnapshot` / `restoreIgnored`

### 第三轮：recheck 位置计算 + 数据完整性

- **Bug 13**: recheck 传了错误的句子范围 → 使用 `sentenceFrom` 字段
- **Bug 14**: `addMarks` 无去重 → 按 error.id 去重
- **Bug 16**: 分屏同文件 `mapPositions` 双重映射 → change fingerprint
- **Bug 17**: `detectManualEdits` 漏检第一次编辑 → 移到 mapPositions 之后
- **Bug 18**: `sentenceStart` 公式在句内编辑后失效 → `sentenceFrom` 随编辑映射
- **Bug 19**: 删除 mark 边界字符时 overlap check 漏检 → 改用闭区间
- **Bug 20**: `sentenceEnd` 在句内编辑后长度过时 → `sentenceTo` 随编辑映射

### 第四轮：不同领域的 bug

- **Bug 21**: `extractSentence` 每次拷贝整个文档 → `sliceString(0, triggerPos + 1)`
- **Bug 22**: fetch 无超时 → AbortController + 15s
- **Bug 23**: 错题本 Markdown 特殊字符 → `escapeMd()`

### 第五轮：体验改善与架构缺陷

- **Bug 24**: 本地检查从未被调用 → 接入 LocalLinter，addMarks 重叠去重
- **Bug 25**: indexOf 首次匹配位置错误 → `findOriginalInSentence` context 消歧
- **Bug 26**: replace 首次替换 recheck 文本错误 → 位置偏移构造字符串
- **Bug 27**: toggle 不清标记 → decorations 检查 enabled + 强制重建
- **Bug 28**: 侧边栏强制打开 → firstRun flag + workspace restoration
- **Bug 29**: marks 内存泄漏 → `cleanupClosedFiles` 在 save 后执行
- **Bug 30**: 持久化位置匹配不准 → `findBestMatch` 宽容搜索

### 第六轮：体验打磨

- **Bug 31**: 禁用后侧边栏仍显示错误 → refresh 检查 enabled + requestRefresh
- **Bug 32**: console.log 性能开销 → 移除所有调试日志
- **Bug 33**: createdAt 每次保存被覆盖 → ErrorItem 携带 createdAt
- **Bug 34**: 无 AI 并发限制 → `enqueueAI` 信号量 + 等待队列
- **Bug 35**: max_tokens 截断 → 256 提高到 1024

### 第七轮：细节打磨

- **Bug 36**: 禁用时显示"没有发现错误" → `showEmpty` 支持自定义文案
- **Bug 37**: linter 加载失败提示一闪而过 → `initError` 属性 + `updateStatus` 回退保护
- **Bug 38**: 同句多 mark 重复 recheck → `Map<sentenceFrom>` 去重批量 recheck

### 第八轮：禁用状态行为修正

- **Bug 39**: 禁用检查时编辑仍触发 AI API 调用 → `validateMarks` 检查 `enabled`，禁用时只删 mark 不 recheck
- **Bug 40**: 同批新 marks 互相重叠 → `addMarks` 用 `accepted` 累积数组检查批内重叠

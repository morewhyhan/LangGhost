# LangGhost

Obsidian 英语写作辅助插件。写完一句自动检查，快捷键一键修复。

## 安装

[**> 点此下载最新版 <**](https://github.com/morewhyhan/LangGhost/releases/latest/download/langghost.zip)

1. 下载 zip，解压到 vault 的 `.obsidian/plugins/langghost/`
2. 设置 → 第三方插件 → 启用 LangGhost
3. 设置 → LangGhost → 填入 API Key（不填也能用本地检查）
4. 开始写

## 怎么用

**写句子。** 以 `.` `?` `!` `。` 结尾自动触发检查。错误出现在句子里和右侧面板。

**修错误。** 三种方式：
- `Ctrl+.` 修复光标前最近的一个错误
- `Ctrl+Shift+.` 一键修复整句
- 鼠标悬停波浪线，点气泡里的「应用」

**自定义快捷键。** 设置 → 快捷键 → 搜索 `LangGhost` → 点 `+` 绑定你习惯的键。

**中英混写。** 写着写着冒出中文？插件会把中文标绿，AI 自动给出英文翻译，点一下应用。

**检查全文。** 打开文件后侧边栏点「检查全文」扫描已有内容。或者设置里开「Auto-scan on file open」，每次打开自动扫前 10 句。

**错题本。** 每次修正自动记到 `LangGhost/errors.md`，按日期分组，翻着回顾。

## 设置

| 设置 | 默认值 | 说明 |
|------|--------|------|
| API Key | *空* | DeepSeek 或 OpenAI 兼容 API 的 key。不填只用本地检查 |
| API Endpoint | `https://api.deepseek.com/v1` | 换成任何 OpenAI 兼容地址 |
| Model | `deepseek-chat` | 模型名 |
| Error Book Path | `LangGhost/errors.md` | 记录修正历史的位置 |
| Auto-scan on file open | 关 | 打开文件时自动检查已有文本 |

## 错误类型

| 颜色 | 类型 | 来源 | 示例 |
|------|------|------|------|
| 蓝色波浪线 | 拼写 | 本地 harper.js | `recieve` → `receive` |
| 红色波浪线 | 语法 | 本地 harper.js | `he go` → `he goes` |
| 黄色波浪线 | 表达 | AI | `make a discussion` → `discuss` |
| 绿色波浪线 | 翻译 | AI / 本地 | `你好` → `Hello` |

## 快捷键

| 默认快捷键 | 命令 |
|-----------|------|
| `Ctrl+.` | Fix nearest error — 修复光标前最近的错误 |
| `Ctrl+Shift+.` | Fix all in sentence — 修复光标所在整句 |

想改的话去 Obsidian 设置 → 快捷键 → 搜 `LangGhost`。

## 工作方式

两层检查，先本地后 AI：

1. **本地**（毫秒级，离线）— harper.js WASM 引擎，拼写 + 基础语法
2. **AI**（1-2秒，需 API Key）— 表达建议 + 中译英 + 复杂语法

本地结果立刻出现，AI 结果随后更新替换。纯中文自动走翻译提示词，保证可靠性。

## 环境

- Obsidian 1.5.0+
- 仅桌面端（需要 WASM）

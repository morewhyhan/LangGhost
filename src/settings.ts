import { App, PluginSettingTab, Setting } from 'obsidian';
import type LangGhostPlugin from '../main';
import { DEFAULT_SETTINGS } from './types';

export class LangGhostSettingTab extends PluginSettingTab {
  plugin: LangGhostPlugin;

  constructor(app: App, plugin: LangGhostPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'LangGhost' });

    // ── AI Settings ──────────────────────────────────────
    containerEl.createEl('h3', { text: 'AI 设置' });

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('DeepSeek 或 OpenAI 兼容 API 的 Key。留空则仅使用本地检查。')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.inputEl.placeholder = 'sk-...';
        text.setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
            // Refresh the whole settings to update cost card
            this.display();
          });
      });

    new Setting(containerEl)
      .setName('API Endpoint')
      .setDesc('支持任何 OpenAI 兼容 API 地址。会自动拼接 /chat/completions。')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.apiEndpoint)
          .setValue(this.plugin.settings.apiEndpoint)
          .onChange(async (value) => {
            this.plugin.settings.apiEndpoint = value || DEFAULT_SETTINGS.apiEndpoint;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Model')
      .setDesc('模型名称，如 deepseek-chat、gpt-4o-mini 等。')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.model)
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value || DEFAULT_SETTINGS.model;
            await this.plugin.saveSettings();
          })
      );

    // ── Behavior ─────────────────────────────────────────
    containerEl.createEl('h3', { text: '行为' });

    new Setting(containerEl)
      .setName('Error Book Path')
      .setDesc('错题本在 Vault 中的路径，修正记录会自动追加到此文件。')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.errorBookPath)
          .setValue(this.plugin.settings.errorBookPath)
          .onChange(async (value) => {
            this.plugin.settings.errorBookPath = value || DEFAULT_SETTINGS.errorBookPath;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Auto-scan on file open')
      .setDesc('打开文件时自动检查已有文本（前 10 句）。会产生 AI 费用。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoScan)
          .onChange(async (value) => {
            this.plugin.settings.autoScan = value;
            await this.plugin.saveSettings();
          })
      );

    // ── About ────────────────────────────────────────────
    containerEl.createEl('h3', { text: '关于' });

    // Cost estimate card
    const hasKey = !!this.plugin.settings.apiKey;
    const model = this.plugin.settings.model || DEFAULT_SETTINGS.model;
    const costCard = containerEl.createDiv({ cls: 'langghost-cost-card' });

    const costIcon = costCard.createSpan({ cls: 'langghost-cost-icon' });
    costIcon.textContent = hasKey ? '💡' : '⚠️';

    const costText = costCard.createDiv({ cls: 'langghost-cost-text' });
    if (hasKey) {
      costText.textContent = `每日写日记，预估 $1-5/月（${model}）`;
    } else {
      costText.textContent = '未配置 API Key，仅使用本地检查（拼写 + 基础语法）。填写 Key 后可启用 AI 表达建议和中译英。';
    }

    // Version info
    const versionInfo = containerEl.createDiv({ cls: 'langghost-version' });
    versionInfo.textContent = `LangGhost v${this.plugin.manifest.version}`;
  }
}

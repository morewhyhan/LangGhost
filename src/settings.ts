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

    containerEl.createEl('h2', { text: 'LangGhost Settings' });

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('Your AI API key. Leave empty to use local checking only.')
      .addText((text) =>
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('API Endpoint')
      .setDesc('Custom API endpoint URL.')
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
      .setDesc('AI model to use.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.model)
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value || DEFAULT_SETTINGS.model;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Error Book Path')
      .setDesc('Path to the error book markdown file in your vault.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.errorBookPath)
          .setValue(this.plugin.settings.errorBookPath)
          .onChange(async (value) => {
            this.plugin.settings.errorBookPath = value || DEFAULT_SETTINGS.errorBookPath;
            await this.plugin.saveSettings();
          })
      );

    // Cost estimate
    const model = this.plugin.settings.model || DEFAULT_SETTINGS.model;
    const isHaiku = model.toLowerCase().includes('haiku');
    const costEstimate = isHaiku
      ? '~$1-2/month (daily diary with Claude Haiku)'
      : '~$5-10/month (daily diary with ' + model + ')';

    new Setting(containerEl)
      .setName('Estimated Cost')
      .setDesc(costEstimate);
  }
}

import { Modal, App } from 'obsidian';

export class OnboardingModal extends Modal {
  private onChooseLocal: () => void;
  private onChooseAI: () => void;

  constructor(app: App, onChooseLocal: () => void, onChooseAI: () => void) {
    super(app);
    this.onChooseLocal = onChooseLocal;
    this.onChooseAI = onChooseAI;
  }

  onOpen(): void {
    this.titleEl.setText('欢迎使用 LangGhost');
    this.modalEl.classList.add('langghost-onboarding');

    const desc = this.contentEl.createDiv({ cls: 'langghost-onboarding-desc' });
    desc.textContent = '英语写作辅助：写完一句自动检查，一键修复错误。';

    const features = this.contentEl.createDiv({ cls: 'langghost-onboarding-features' });
    const items = [
      { text: '本地拼写 + 基础语法（无需 API，开箱即用）' },
      { text: 'AI 表达建议 + 中译英（需要 API Key）' },
    ];
    for (const item of items) {
      const row = features.createDiv({ cls: 'langghost-onboarding-feature-row' });
      row.textContent = item.text;
    }

    const buttons = this.contentEl.createDiv({ cls: 'langghost-onboarding-buttons' });

    const localBtn = buttons.createEl('button', { cls: 'langghost-onboarding-btn-local', text: '开始使用（本地检查）' });
    localBtn.addEventListener('click', () => {
      this.close();
      this.onChooseLocal();
    });

    const aiBtn = buttons.createEl('button', { cls: 'langghost-onboarding-btn-ai', text: '配置 AI 增强' });
    aiBtn.addEventListener('click', () => {
      this.close();
      this.onChooseAI();
    });
  }
}

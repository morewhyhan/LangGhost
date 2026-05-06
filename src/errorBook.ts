import { App, normalizePath, TFile } from 'obsidian';
import type { ErrorItem, LangGhostSettings } from './types';

const TYPE_LABELS: Record<string, string> = {
  grammar: '语法',
  spelling: '拼写',
  expression: '表达',
  translation: '翻译',
};

/** Escape Markdown special characters in user-provided text to prevent
 *  formatting breakage in the error book. */
function escapeMd(text: string): string {
  return text.replace(/([*\[\]`|\\_~>#+-])/g, '\\$1');
}

export class ErrorBook {
  private app: App;
  private getSettings: () => LangGhostSettings;

  constructor(app: App, getSettings: () => LangGhostSettings) {
    this.app = app;
    this.getSettings = getSettings;
  }

  async appendError(error: ErrorItem): Promise<void> {
    const settings = this.getSettings();
    const path = normalizePath(settings.errorBookPath);

    // Ensure file exists
    let file = this.app.vault.getFileByPath(path);
    if (!file) {
      // Create parent folder if needed
      const folderPath = path.substring(0, path.lastIndexOf('/'));
      if (folderPath) {
        const folder = this.app.vault.getFolderByPath(folderPath);
        if (!folder) {
          await this.app.vault.createFolder(folderPath);
        }
      }
      file = await this.app.vault.create(path, '');
    }

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const typeLabel = TYPE_LABELS[error.type] || error.type;
    const entry = `- **${escapeMd(error.original)} → ${escapeMd(error.corrected)}** \`${typeLabel}\` ${escapeMd(error.explanation)}\n`;
    const heading = `## ${today}\n`;

    await this.app.vault.process(file, (content) => {
      // Check if today's heading exists
      if (content.includes(heading)) {
        // Find the heading and append after it
        const headingIndex = content.indexOf(heading);
        const afterHeading = headingIndex + heading.length;
        return content.substring(0, afterHeading) + entry + content.substring(afterHeading);
      } else {
        // Append heading + entry at the end
        return content + (content.endsWith('\n') ? '' : '\n') + heading + entry;
      }
    });
  }
}

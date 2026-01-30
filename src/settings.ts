import { App, PluginSettingTab, Setting } from 'obsidian';
import GraphMindPlugin from '../main';
import { OllamaService } from './services/ollamaService';

export interface GraphMindSettings {
    ollamaBaseUrl: string;
    llmModel: string;
    embeddingModel: string;
}

export const DEFAULT_SETTINGS: GraphMindSettings = {
    ollamaBaseUrl: 'http://localhost:11434',
    llmModel: 'llama3.2:latest',
    embeddingModel: 'nomic-embed-text'
};

export class GraphMindSettingTab extends PluginSettingTab {
    plugin: GraphMindPlugin;
    private availableModels: string[] = [];

    constructor(app: App, plugin: GraphMindPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async loadAvailableModels(): Promise<void> {
        try {
            const ollamaService = new OllamaService(this.plugin.settings.ollamaBaseUrl);
            const models = await ollamaService.listModels();
            this.availableModels = models.map(m => m.name);
        } catch (error) {
            console.error("Failed to load Ollama models:", error);
            this.availableModels = [];
        }
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        void this.loadAvailableModels().then(() => {
            this.renderSettings();
        });
    }

    private renderSettings(): void {
        const { containerEl } = this;

        containerEl.empty();

        // Ollama Base URL
        new Setting(containerEl)
            .setName('Ollama base URL')
            .setDesc('Ollama server URL')
            .addText(text => text
                .setPlaceholder('http://localhost:11434')
                .setValue(this.plugin.settings.ollamaBaseUrl)
                .onChange((value) => {
                    this.plugin.settings.ollamaBaseUrl = value || DEFAULT_SETTINGS.ollamaBaseUrl;
                    void this.plugin.saveSettings().then(() => {
                        // Reload models when URL changes
                        void this.loadAvailableModels().then(() => {
                            this.renderSettings(); // Refresh the settings page
                        });
                    });
                }));

        // LLM Model Dropdown
        const llmSetting = new Setting(containerEl)
            .setName('Language model')
            .setDesc('Model for chat and answer generation');

        if (this.availableModels.length > 0) {
            llmSetting.addDropdown(dropdown => {
                // Add all available models
                this.availableModels.forEach(model => {
                    dropdown.addOption(model, model);
                });
                
                // Set current value or default
                const currentValue = this.plugin.settings.llmModel;
                if (this.availableModels.includes(currentValue)) {
                    dropdown.setValue(currentValue);
                } else if (this.availableModels.length > 0) {
                    dropdown.setValue(this.availableModels[0]);
                }
                
                dropdown.onChange((value) => {
                    this.plugin.settings.llmModel = value;
                    void this.plugin.saveSettings();
                });
            });
        } else {
            llmSetting.addText(text => text
                .setPlaceholder('No models found')
                .setValue(this.plugin.settings.llmModel)
                .setDisabled(true));
            llmSetting.descEl.createDiv({
                text: 'Cannot connect to Ollama. Make sure it is running.',
                cls: 'setting-item-description mod-warning'
            });
        }

        // Embedding Model Dropdown
        const embeddingSetting = new Setting(containerEl)
            .setName('Embedding model')
            .setDesc('Model for text embeddings and semantic search');

        if (this.availableModels.length > 0) {
            embeddingSetting.addDropdown(dropdown => {
                // Add all available models
                this.availableModels.forEach(model => {
                    dropdown.addOption(model, model);
                });
                
                // Set current value or default
                const currentValue = this.plugin.settings.embeddingModel;
                if (this.availableModels.includes(currentValue)) {
                    dropdown.setValue(currentValue);
                } else if (this.availableModels.length > 0) {
                    dropdown.setValue(this.availableModels[0]);
                }
                
                dropdown.onChange((value) => {
                    this.plugin.settings.embeddingModel = value;
                    void this.plugin.saveSettings();
                });
            });
        } else {
            embeddingSetting.addText(text => text
                .setPlaceholder('No models found')
                .setValue(this.plugin.settings.embeddingModel)
                .setDisabled(true));
            embeddingSetting.descEl.createDiv({
                text: 'Cannot connect to Ollama. Make sure it is running.',
                cls: 'setting-item-description mod-warning'
            });
        }

        // Refresh button
        new Setting(containerEl)
            .setName('Refresh models')
            .setDesc('Reload the list of available Ollama models.')
            .addButton(button => button
                .setButtonText('Refresh')
                .onClick(() => {
                    void this.loadAvailableModels().then(() => {
                        this.renderSettings(); // Refresh the page to show updated models
                    });
                }));
    }
}

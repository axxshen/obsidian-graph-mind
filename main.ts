import { Plugin, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import { Indexer } from './src/indexer';
import { SearchService } from './src/services/searchService';
import { ChatView, VIEW_TYPE_CHAT } from './src/views/chatView';
import { GraphMindSettings, DEFAULT_SETTINGS, GraphMindSettingTab } from './src/settings';
import workerCode from "virtual:worker";

const DEBUG = true;
const debugLog = (...args: unknown[]) => {
    if (DEBUG) console.debug(...args);
};

export default class GraphMindPlugin extends Plugin {
    worker: Worker;
    indexer: Indexer;
    searchService: SearchService;
    statusBarItem: HTMLElement;
    settings: GraphMindSettings;

    async onload() {
        await this.loadSettings();

        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.setText('Idle');

        // Register View
        this.registerView(
            VIEW_TYPE_CHAT,
            (leaf) => new ChatView(leaf, this)
        );

        // Ribbon Icon to Open Chat
        this.addRibbonIcon('bot', 'Open chat', () => {
            void this.activateView();
        });

        this.initWorker();

        this.indexer = new Indexer(this.app.vault, this.worker);
        this.searchService = new SearchService(this.worker);

        // Auto-index on startup
        this.statusBarItem.setText('Indexing...');
        void this.indexer.buildIndex((completed, total) => {
            this.statusBarItem.setText(`Indexing (${completed}/${total})`);
            if (completed === total) {
                this.statusBarItem.setText('Ready');
                debugLog("Graph Mind indexing complete");
            }
        }).catch((error: unknown) => {
            console.error("Graph Mind indexing failed:", error);
        });

        // Register Vault Events for Auto-Indexing
        this.registerEvent(this.app.vault.on('create', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                void this.indexer.indexFile(file);
            }
        }));

        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                this.indexer.deleteFile(file.path);
            }
        }));

        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                void this.indexer.indexFile(file);
            }
        }));

        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (file instanceof TFile && file.extension === 'md') {
                this.indexer.deleteFile(oldPath);
                void this.indexer.indexFile(file);
            }
        }));

        this.addCommand({
            id: 'build-index',
            name: 'Build index',
            callback: () => {
                void this.runBuildIndex();
            }
        });

        this.addCommand({
            id: 'open-brain-chat',
            name: 'Open chat',
            callback: () => {
                void this.activateView();
            }
        });

        // Add settings tab
        this.addSettingTab(new GraphMindSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_CHAT);

        if (leaves.length > 0) {
            // A leaf with our view already exists, use that
            leaf = leaves[0];
        } else {
            // Our view could not be found in the workspace, create a new leaf
            // in the right sidebar
            leaf = workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
            }
        }

        // "Reveal" the leaf in case it is in a collapsed sidebar
        if (leaf) {
            void workspace.revealLeaf(leaf);
        }
    }

    initWorker() {
        try {
            // Load Worker Blob
            const pluginDir = this.manifest.dir;
            if (!pluginDir) throw new Error("Plugin directory not found");

            // Create worker from inline bundle
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            const workerUrl = URL.createObjectURL(blob);
            
            this.worker = new Worker(workerUrl);

            // Init Worker
            this.worker.postMessage({ 
                command: 'init', 
                payload: {},
                id: 'init-0' 
            });

            // Handle worker messages using addEventListener to allow SearchService to also listen
            this.worker.addEventListener('message', (e) => {
                const { status, error, data } = e.data;
                if (status === 'error') {
                    console.error("Worker Error:", error);
                    new Notice("Graph Mind worker error: " + error);
                } else if (data && data.message === 'Worker initialized') {
                    debugLog("Graph Mind worker initialized");
                    this.statusBarItem.setText('Ready');
                }
            });

        } catch (error) {
            console.error("Failed to initialize Graph Mind worker:", error);
            new Notice("Failed to initialize Graph Mind worker. Check console.");
        }
    }

    private async runBuildIndex(): Promise<void> {
        this.statusBarItem.setText('Indexing...');
        new Notice('Starting indexing...');
        await this.indexer.buildIndex((completed, total) => {
            this.statusBarItem.setText(`Indexing (${completed}/${total})`);
        });
        this.statusBarItem.setText('Ready');
        new Notice('Indexing complete.');
    }

    onunload() {
        if (this.worker) this.worker.terminate();
    }
}

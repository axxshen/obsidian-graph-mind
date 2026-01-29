import { ItemView, WorkspaceLeaf, MarkdownRenderer, ButtonComponent, TextAreaComponent, setIcon } from "obsidian";
import { GraphMindAgent, AgentEvent } from "../agent";
import { Message } from "../services/ollamaService";
import GraphMindPlugin from "../../main";

export const VIEW_TYPE_CHAT = "graph-mind-chat";

export class ChatView extends ItemView {
    plugin: GraphMindPlugin;
    messageContainer: HTMLElement;
    inputContainer: HTMLElement;
    agent: GraphMindAgent;
    history: Message[] = [];

    constructor(leaf: WorkspaceLeaf, plugin: GraphMindPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.agent = new GraphMindAgent(plugin, (msg) => {}); // Notify handled via stream
    }

    getViewType(): string {
        return VIEW_TYPE_CHAT;
    }

    getDisplayText(): string {
        return "Graph Mind chat";
    }

    getIcon(): string {
        return "bot";
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass("chat-view-container");

        // Message Area
        this.messageContainer = container.createDiv({ cls: "chat-messages" });

        // Handle internal link clicks
        this.messageContainer.addEventListener("click", (e) => {
            const target = e.target as HTMLElement;
            if (target.hasClass("internal-link")) {
                e.preventDefault();
                const href = target.getAttribute("href");
                if (href) {
                    this.plugin.app.workspace.openLinkText(href, "", false);
                }
            }
        });

        // Initial Greeting
        this.addMessage("assistant", "Hello! I am Graph Mind. Ask me anything about your vault.");

        // Input Area
        this.inputContainer = container.createDiv({ cls: "chat-input-area" });
        
        const inputEl = new TextAreaComponent(this.inputContainer)
            .setPlaceholder("Ask Graph Mind...")
            .then((ta) => {
                ta.inputEl.addClass("chat-input");
                // Handle Enter key to submit (Shift+Enter for newline)
                ta.inputEl.addEventListener("keydown", (e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        this.handleSubmit(ta.getValue());
                        ta.setValue("");
                    }
                });
            });

        new ButtonComponent(this.inputContainer)
            .setButtonText("Send")
            .setCta()
            .onClick(() => {
                this.handleSubmit(inputEl.getValue());
                inputEl.setValue("");
            });
    }

    async handleSubmit(query: string) {
        if (!query.trim()) return;

        // User Message
        this.addMessage("user", query);

        // Create placeholder for Assistant Message
        const assistantBubble = this.messageContainer.createDiv({ cls: "chat-bubble chat-bubble-assistant" });
        
        // Thinking Process UI
        const thinkingContainer = assistantBubble.createDiv({ cls: "thinking-process-container" });
        const thinkingHeader = thinkingContainer.createDiv({ cls: "thinking-header" });
        const thinkingIcon = thinkingHeader.createDiv({ cls: "thinking-icon" });
        setIcon(thinkingIcon, "brain-circuit");
        const thinkingText = thinkingHeader.createDiv({ cls: "thinking-text", text: "Thinking..." });
        const thinkingCollapse = thinkingHeader.createDiv({ cls: "thinking-collapse-icon" });
        setIcon(thinkingCollapse, "chevron-down");

        const thinkingContent = thinkingContainer.createDiv({ cls: "thinking-content" });
        const thinkingSteps = thinkingContent.createDiv({ cls: "thinking-steps" });
        const thinkingProgressBar = thinkingContent.createDiv({ cls: "thinking-progress-bar" });
        const thinkingProgressFill = thinkingProgressBar.createDiv({ cls: "thinking-progress-fill" });
        thinkingProgressBar.style.display = "none"; // Hide initially
        const thinkingSources = thinkingContent.createDiv({ cls: "thinking-sources" });

        // Toggle collapse
        thinkingHeader.addEventListener("click", () => {
            thinkingContainer.toggleClass("is-collapsed", !thinkingContainer.hasClass("is-collapsed"));
        });

        const contentContainer = assistantBubble.createDiv({ cls: "chat-content" });
        
        // Add copy button container (will be shown after content is generated)
        const copyButtonContainer = assistantBubble.createDiv({ cls: "copy-button-container" });
        copyButtonContainer.style.display = "none"; // Hide initially

        let fullAnswer = "";
        let sources: any[] = [];
        let stepCount = 0;
        let currentStepEl: HTMLElement | null = null;

        try {
            const stream = this.agent.chatStream(query, this.history);
            
            for await (const event of stream) {
                if (event.type === 'thought') {
                    // Complete previous step if exists
                    if (currentStepEl) {
                        const prevIcon = currentStepEl.querySelector('.thinking-step-icon') as HTMLElement;
                        if (prevIcon) {
                            prevIcon.empty();
                            setIcon(prevIcon, "check-circle");
                        }
                    }
                    
                    // Add new step with loading icon
                    const stepEl = thinkingSteps.createDiv({ cls: "thinking-step" });
                    const stepIcon = stepEl.createDiv({ cls: "thinking-step-icon" });
                    setIcon(stepIcon, "circle");
                    stepEl.createSpan({ text: event.content });
                    
                    currentStepEl = stepEl;
                    stepCount++;
                    this.scrollToBottom();
                } else if (event.type === 'progress') {
                    // Show and update progress bar
                    thinkingProgressBar.style.display = "block";
                    const progress = event.content; // Expecting { current: number, total: number }
                    const percentage = (progress.current / progress.total) * 100;
                    thinkingProgressFill.style.width = `${percentage}%`;
                    this.scrollToBottom();
                } else if (event.type === 'token') {
                    fullAnswer += event.content;
                    // Re-render markdown incrementally
                    contentContainer.empty();
                    
                    // Pre-process citations: [1] -> [[File|1]]
                    let processedAnswer = fullAnswer;
                    if (sources.length > 0) {
                        processedAnswer = fullAnswer.replace(/\[(\d+)\]/g, (match, id) => {
                            const index = parseInt(id) - 1;
                            if (sources[index]) {
                                return `[[${sources[index].path}|${id}]]`;
                            }
                            return match;
                        });
                    }

                    MarkdownRenderer.render(
                        this.plugin.app,
                        processedAnswer,
                        contentContainer,
                        "",
                        this.plugin
                    );
                    this.scrollToBottom();
                } else if (event.type === 'sources') {
                    // Complete last step if exists
                    if (currentStepEl) {
                        const prevIcon = currentStepEl.querySelector('.thinking-step-icon') as HTMLElement;
                        if (prevIcon) {
                            prevIcon.empty();
                            setIcon(prevIcon, "check-circle");
                        }
                    }
                    
                    sources = event.content;
                    
                    // Hide progress bar when sources are ready
                    thinkingProgressBar.style.display = "none";
                    
                    // Update text only after completion
                    if (sources.length > 0) {
                        thinkingText.setText(`Reviewed ${sources.length} sources`);
                    }
                    
                    // Add sources to UI
                    thinkingSources.empty();
                    sources.forEach((source, index) => {
                        const sourceEl = thinkingSources.createEl("a", { 
                            cls: "thinking-source-item",
                            href: source.path 
                        });
                        const sourceIcon = sourceEl.createDiv({ cls: "thinking-source-icon" });
                        setIcon(sourceIcon, "file-text");
                        sourceEl.createSpan({ text: source.path });
                        
                        // Handle click to open file
                        sourceEl.addEventListener("click", (e) => {
                            e.preventDefault();
                            this.plugin.app.workspace.openLinkText(source.path, "", false);
                        });
                    });
                } else if (event.type === 'done') {
                    // Complete last step if exists
                    if (currentStepEl) {
                        const prevIcon = currentStepEl.querySelector('.thinking-step-icon') as HTMLElement;
                        if (prevIcon) {
                            prevIcon.empty();
                            setIcon(prevIcon, "check-circle");
                        }
                    }
                    
                    // Add finished step
                    const stepEl = thinkingSteps.createDiv({ cls: "thinking-step" });
                    const stepIcon = stepEl.createDiv({ cls: "thinking-step-icon" });
                    setIcon(stepIcon, "check-circle");
                    stepEl.createSpan({ text: "Finished" });
                    
                    // Collapse by default when done, unless it was empty (direct chat)
                    if (sources.length > 0) {
                        thinkingContainer.addClass("is-collapsed");
                    } else {
                        // If no sources, maybe just hide the thinking container or keep it minimal
                        thinkingText.setText("Finished");
                        thinkingContainer.addClass("is-collapsed");
                    }
                    
                    // Show copy button when done
                    if (fullAnswer.trim()) {
                        copyButtonContainer.style.display = "flex";
                        const copyBtn = copyButtonContainer.createEl("button", { 
                            cls: "copy-answer-button",
                            text: "Copy"
                        });
                        setIcon(copyBtn, "copy");
                        
                        copyBtn.addEventListener("click", async () => {
                            await navigator.clipboard.writeText(fullAnswer);
                            copyBtn.textContent = "Copied!";
                            setTimeout(() => {
                                copyBtn.empty();
                                setIcon(copyBtn, "copy");
                            }, 2000);
                        });
                    }
                }
            }

            // Note: Stateless mode - no history tracking
            // Each query is independent and only relies on vault content

        } catch (e) {
            contentContainer.createDiv({ cls: "error-message", text: `Error: ${e.message}` });
        }
    }

    addMessage(role: string, text: string) {
        const bubble = this.messageContainer.createDiv({ cls: `chat-bubble chat-bubble-${role}` });
        
        // Render Markdown
        MarkdownRenderer.render(
            this.plugin.app,
            text,
            bubble,
            "",
            this.plugin
        );

        this.scrollToBottom();
    }

    addThought(text: string) {
        // Legacy support
    }

    scrollToBottom() {
        this.messageContainer.scrollTop = this.messageContainer.scrollHeight;
    }

    async onClose() {
        // Cleanup if needed
    }
}

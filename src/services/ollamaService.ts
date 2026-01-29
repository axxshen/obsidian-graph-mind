import { Notice } from 'obsidian';

export interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export class OllamaService {
    private baseUrl: string;
    private defaultModel: string;
    private defaultEmbeddingModel: string;

    constructor(
        baseUrl: string = 'http://localhost:11434', 
        defaultModel: string = 'llama3.2:latest',
        defaultEmbeddingModel: string = 'nomic-embed-text'
    ) {
        this.baseUrl = baseUrl;
        this.defaultModel = defaultModel;
        this.defaultEmbeddingModel = defaultEmbeddingModel;
    }

    async chat(messages: Message[], model?: string): Promise<string> {
        const selectedModel = model || this.defaultModel;
        
        try {
            const response = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: selectedModel,
                    messages: messages,
                    stream: false 
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Ollama Error (${response.status}): ${errorText}`);
            }

            const data = await response.json();
            return data.message.content;

        } catch (error) {
            console.error("Ollama Service Error:", error);
            throw error;
        }
    }

    async *chatStream(messages: Message[], model?: string): AsyncGenerator<string, void, unknown> {
        const selectedModel = model || this.defaultModel;
        
        try {
            const response = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: selectedModel,
                    messages: messages,
                    stream: true 
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Ollama Error (${response.status}): ${errorText}`);
            }

            if (!response.body) throw new Error("No response body");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const json = JSON.parse(line);
                        if (json.message && json.message.content) {
                            yield json.message.content;
                        }
                        if (json.done) return;
                    } catch (e) {
                        console.warn("Error parsing JSON chunk", e);
                    }
                }
            }

        } catch (error) {
            console.error("Ollama Service Error:", error);
            throw error;
        }
    }

    async getEmbeddings(prompt: string, model?: string, retries: number = 3): Promise<number[]> {
        const selectedModel = model || this.defaultEmbeddingModel;
        
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const response = await fetch(`${this.baseUrl}/api/embeddings`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: selectedModel,
                        prompt: prompt
                    })
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Ollama Embedding Error (${response.status}): ${errorText}`);
                }

                const data = await response.json();
                return data.embedding;
            } catch (error) {
                if (attempt === retries - 1) {
                    console.error("Ollama Embedding Error (final attempt):", error);
                    throw error;
                }
                // Exponential backoff: wait 500ms, 1000ms, 1500ms...
                const waitTime = 500 * (attempt + 1);
                console.warn(`Embedding failed (attempt ${attempt + 1}/${retries}), retrying in ${waitTime}ms...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
        throw new Error("Embedding failed after all retries");
    }

    async listModels(): Promise<{ name: string; size: number; modified: string }[]> {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`);
            if (!response.ok) {
                throw new Error(`Failed to fetch models: ${response.status}`);
            }
            const data = await response.json();
            return data.models || [];
        } catch (error) {
            console.error("Failed to list Ollama models:", error);
            return [];
        }
    }
}

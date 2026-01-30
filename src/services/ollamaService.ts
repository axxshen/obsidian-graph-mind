import { requestUrl } from 'obsidian';

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
            const response = await requestUrl({
                url: `${this.baseUrl}/api/chat`,
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

            if (response.status >= 400) {
                const errorText = response.text ?? JSON.stringify(response.json ?? {});
                throw new Error(`Ollama Error (${response.status}): ${errorText}`);
            }

            const data = response.json as { message?: { content?: string } };
            return data.message?.content ?? "";

        } catch (error) {
            console.error("Ollama Service Error:", error);
            throw error;
        }
    }

    async *chatStream(messages: Message[], model?: string): AsyncGenerator<string, void, unknown> {
        const content = await this.chat(messages, model);
        if (content) yield content;
    }

    async getEmbeddings(prompt: string, model?: string, retries: number = 3): Promise<number[]> {
        const selectedModel = model || this.defaultEmbeddingModel;
        
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const response = await requestUrl({
                    url: `${this.baseUrl}/api/embeddings`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: selectedModel,
                        prompt: prompt
                    })
                });

                if (response.status >= 400) {
                    const errorText = response.text ?? JSON.stringify(response.json ?? {});
                    throw new Error(`Ollama Embedding Error (${response.status}): ${errorText}`);
                }

                const data = response.json as { embedding?: number[] };
                return data.embedding ?? [];
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
            const response = await requestUrl({ url: `${this.baseUrl}/api/tags` });
            if (response.status >= 400) {
                throw new Error(`Failed to fetch models: ${response.status}`);
            }
            const data = response.json as { models?: { name: string; size: number; modified: string }[] };
            return data.models || [];
        } catch (error) {
            console.error("Failed to list Ollama models:", error);
            return [];
        }
    }
}

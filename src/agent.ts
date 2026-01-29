import { Notice, TFile } from "obsidian";
import { OllamaService, Message } from "./services/ollamaService";
import { webSearchResponsePrompt, webSearchRetrieverPrompt, webSearchRetrieverFewShots } from "./prompts";
import { parseQuery, matchesFilters, type ParsedQuery } from "./search/queryParser";
import { MDocument } from "@mastra/rag";

const DEBUG = true;
const debugLog = (...args: unknown[]) => {
    if (DEBUG) console.log(...args);
};

export type AgentEvent = 
    | { type: 'thought', content: string }
    | { type: 'token', content: string }
    | { type: 'sources', content: any[] }
    | { type: 'progress', content: { current: number, total: number } }
    | { type: 'done' };

export class GraphMindAgent {
    private ollama: OllamaService;
    private plugin: any;
    private notify: (msg: string) => void;
    private progressCallback: ((progress: { current: number, total: number }) => void) | null = null;

    constructor(plugin: any, notify: (msg: string) => void) {
        this.plugin = plugin;
        this.notify = notify;
        // Initialize OllamaService with settings from plugin
        this.ollama = new OllamaService(
            plugin.settings.ollamaBaseUrl,
            plugin.settings.llmModel,
            plugin.settings.embeddingModel
        );
    }

    /**
     * Process items in batches with concurrency control
     * This prevents overwhelming Ollama when switching between models
     */
    private async processInBatches<T, R>(
        items: T[],
        batchSize: number,
        fn: (item: T, index: number) => Promise<R>,
        onProgress?: (current: number, total: number) => void
    ): Promise<R[]> {
        const results: R[] = [];
        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize);
            // Process current batch in parallel
            const batchResults = await Promise.all(
                batch.map((item, idx) => fn(item, i + idx))
            );
            results.push(...batchResults);
            
            // Report progress
            if (onProgress) {
                onProgress(i + batch.length, items.length);
            }
            
            // Small delay between batches to allow Ollama to stabilize
            if (i + batchSize < items.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        return results;
    }

    async *chatStream(userQuery: string, history: Message[]): AsyncGenerator<AgentEvent, void, unknown> {
        // Parse advanced query features
        const parsedQuery: ParsedQuery = parseQuery(userQuery);
        
        // Extract clean search text (remove operators for intent analysis)
        const cleanQuery = [...parsedQuery.text, ...parsedQuery.exactTerms].join(' ');
        
        // 1. Intent Analysis (Stateless - only analyze current question)
        debugLog("[Graph Mind] Stage: intent-analysis");
        yield { type: 'thought', content: "Analyzing your intent..." };
        const generatedQuery = await this.generateQuery(cleanQuery.length > 0 ? cleanQuery : userQuery, []);
        debugLog(`[Graph Mind] Intent Analysis Result: "${generatedQuery}"`);
        
        // If not_needed, skip vault search and just chat
        if (generatedQuery === 'not_needed') {
            yield { type: 'thought', content: "Direct chat (no vault search needed)..." };
            const stream = this.ollama.chatStream([{ role: 'user', content: userQuery }]);
            for await (const token of stream) {
                yield { type: 'token', content: token };
            }
            yield { type: 'done' };
            return;
        }
        
        debugLog(`[Graph Mind] Search query: "${generatedQuery}"`);
        yield { type: 'thought', content: `Search Query: "${generatedQuery}"` };

        // 2. Keyword Search (Always perform search to ground answers in vault)
        debugLog("[Graph Mind] Stage: keyword-search + rerank");
        yield { type: 'thought', content: `Searching vault for relevant notes...` };
        let searchResults: any[] = [];
        try {
            // Inline the search with progress reporting
            const searchGen = this.searchVaultWithProgress(generatedQuery, parsedQuery);
            for await (const event of searchGen) {
                if (event.type === 'progress') {
                    debugLog(`[Graph Mind] Progress: ${event.content.current}/${event.content.total}`);
                    yield { type: 'progress', content: event.content };
                } else if (event.type === 'result') {
                    searchResults = event.content;
                }
            }
            
            if (searchResults.length > 0) {
                yield { type: 'thought', content: `Embedding complete` };
            }
        } catch (e) {
            console.error("Search failed:", e);
            yield { type: 'token', content: "I encountered an error while searching your vault." };
            yield { type: 'done' };
            return;
        }

        if (searchResults.length === 0) {
            yield { type: 'token', content: "I couldn't find any relevant notes in your vault regarding this topic. Would you like to search for something else or add notes about this?" };
            yield { type: 'done' };
            return;
        }

        // Emit sources found
        debugLog(`[Graph Mind] Sources selected: ${searchResults.length}`);
        yield { type: 'sources', content: searchResults };

        // 3. Process Context
        const context = searchResults.map((doc, index) => {
            return `[${index + 1}] Title: ${doc.path}\nContent: ${doc.content}`;
        }).join("\n\n");

        // 4. Generate Answer (Stateless - only use vault content + current question)
        debugLog("[Graph Mind] Stage: answer-synthesis");
        yield { type: 'thought', content: "Synthesizing answer with citations..." };
        const systemPrompt = webSearchResponsePrompt
            .replace("{context}", context)
            .replace("{date}", new Date().toISOString());

        const messages: Message[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userQuery }
        ];

        const stream = this.ollama.chatStream(messages);
        for await (const token of stream) {
            yield { type: 'token', content: token };
        }
        yield { type: 'done' };
    }

    // Keep non-streaming version for compatibility if needed, but prefer stream
    async chat(userQuery: string, history: Message[]): Promise<string> {
        let fullAnswer = "";
        for await (const event of this.chatStream(userQuery, history)) {
            if (event.type === 'token') fullAnswer += event.content;
        }
        return fullAnswer;
    }

    private async *searchVaultWithProgress(query: string, parsedQuery: ParsedQuery): AsyncGenerator<{ type: 'progress' | 'result', content: any }, void, unknown> {
        // Use internal search service with improved logic
        debugLog("[Graph Mind] Step 1: keyword-search");
        
        // 1. Get Keyword Candidates from Worker (Top 50 for better recall)
        const candidates = await this.plugin.searchService.search(query, 100);
        
        if (candidates.length === 0) {
            yield { type: 'result', content: [] };
            return;
        }

        debugLog(`[Graph Mind] ✓ Found ${candidates.length} keyword candidates (already pre-chunked by Indexer)`);
        debugLog("[Graph Mind] Step 2: embedding + rerank");

        // Note: candidates are already chunked by Indexer using Mastra 512/50
        // Each candidate is a chunk, not a full document
        const chunks = candidates.map((doc: any) => ({
            id: doc.id,
            path: doc.path,
            content: doc.content,
            keywordScore: doc.keywordScore
        }));
        
        debugLog(`[Graph Mind] Processing ${chunks.length} pre-chunked candidates...`);

        try {
            // 3. Generate Embeddings (JIT) - Now on chunks instead of full docs
            // Embed Query
            debugLog(`[Graph Mind] Embedding query: "${query}"`);
            const queryEmbedding = await this.ollama.getEmbeddings(query);
            debugLog(`[Graph Mind] Query embedding generated (dim: ${queryEmbedding.length})`);

            // Embed Chunks (with batch processing to prevent Ollama crashes)
            debugLog(`[Graph Mind] Embedding ${chunks.length} chunks with batch processing...`);
            
            // Batch size: 3 chunks at a time
            // First request will be slower (model switching), subsequent ones are fast
            const BATCH_SIZE = 1;
            
            const scoredChunks: any[] = [];
            
            for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
                const batch = chunks.slice(i, i + BATCH_SIZE);
                
                // Process current batch in parallel
                debugLog(`[Graph Mind] Batch ${Math.floor(i / BATCH_SIZE) + 1} start (${batch.length} chunks)`);
                const batchResults = await Promise.all(
                    batch.map(async (chunk: any, idx: number) => {
                        const index = i + idx;
                        // 1. SANITIZATION: Clean the content first
                        // Remove null bytes and trim whitespace
                        const cleanContent = (chunk.content || "").replace(/\0/g, '').trim();

                        // 2. GUARDRAIL: Skip empty chunks immediately
                        if (cleanContent.length === 0) {
                            // Return a dummy low score so we don't crash
                            return { 
                                ...chunk, 
                                finalScore: -100, 
                                similarity: 0, 
                                chunkLen: 0 
                            };
                        }

                        try {
                            // 3. EMBEDDING: Use the cleaned content
                            const chunkEmbedding = await this.ollama.getEmbeddings(cleanContent);
                            
                            // Progress indicator every 10 chunks
                            if ((index + 1) % 10 === 0) {
                                debugLog(`[Graph Mind]   Processed ${index + 1}/${chunks.length} chunks...`);
                            }
                            
                            const similarity = this.cosineSimilarity(queryEmbedding, chunkEmbedding);
                            const finalScore = (chunk.keywordScore * 0.1) + (similarity * 10);
                            
                            return { 
                                ...chunk, 
                                finalScore, 
                                similarity, 
                                chunkLen: cleanContent.length 
                            };
                        } catch (e) {
                            // 4. DIAGNOSTIC LOGGING: Detect the "Poison" Chunk
                            console.error(`[Graph Mind] ⚠️ OLLAMA CRASH on Chunk ID ${chunk.id} from file: "${chunk.path}"`);
                            console.error(`[Graph Mind] ⚠️ Bad Content Preview: >>>${cleanContent.substring(0, 100)}...<<<`);
                            
                            // Return dummy result to keep the rest of the search alive
                            return { 
                                ...chunk, 
                                finalScore: -999,
                                similarity: 0,
                                chunkLen: cleanContent.length 
                            };
                        }
                    })
                );
                
                scoredChunks.push(...batchResults);
                debugLog(`[Graph Mind] Batch ${Math.floor(i / BATCH_SIZE) + 1} done`);
                
                // Emit progress event
                yield { type: 'progress', content: { current: i + batch.length, total: chunks.length } };
                
                // Small delay between batches to allow Ollama to stabilize
                if (i + BATCH_SIZE < chunks.length) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }

            // 4. Sort by Final Score
            debugLog("[Graph Mind] Step 3: sort by final score");
            scoredChunks.sort((a, b) => b.finalScore - a.finalScore);

            // Log top results for debugging
            debugLog("[Graph Mind] ✓ Reranking complete. Top 10 Chunks:");
            scoredChunks.slice(0, 10).forEach((chunk, i) => {
                debugLog(`  #${i+1} ${chunk.path} [${chunk.id}] | Final: ${chunk.finalScore.toFixed(4)} (Sim: ${chunk.similarity?.toFixed(4)}, Key: ${chunk.keywordScore.toFixed(4)})`);
            });

            // 5. Apply advanced query filters (ext:, path:, exact match, excludes)
            let filteredChunks = scoredChunks;
            if (parsedQuery.extensions.length > 0 || 
                parsedQuery.pathIncludes.length > 0 || 
                parsedQuery.pathExcludes.length > 0 ||
                parsedQuery.exactTerms.length > 0 ||
                parsedQuery.textExcludes.length > 0) {
                
                debugLog("[Graph Mind] Step 4: advanced filters");
                filteredChunks = scoredChunks.filter(chunk => 
                    matchesFilters({ path: chunk.path, id: chunk.id }, parsedQuery, chunk.content)
                );
                debugLog(`[Graph Mind] ✓ Filtered to ${filteredChunks.length} chunks after advanced filters`);
            }

            // 6. Tag boost: 100x boost for chunks matching tag queries
            if (parsedQuery.tags.length > 0) {
                debugLog("[Graph Mind] Step 5: tag boost");
                for (const chunk of filteredChunks) {
                    const chunkLower = chunk.content.toLowerCase();
                    if (parsedQuery.tags.some((tag: string) => chunkLower.includes(tag.toLowerCase()))) {
                        chunk.finalScore *= 100;
                    }
                }
                filteredChunks.sort((a, b) => b.finalScore - a.finalScore);
            }

            // 7. Group chunks by document and return top documents with their best chunks
            debugLog("[Graph Mind] Step 6: group by doc");
            const docMap = new Map<string, any>();
            for (const chunk of filteredChunks.slice(0, 50)) { // Take top 50 chunks
                if (!docMap.has(chunk.path)) {
                    docMap.set(chunk.path, {
                        path: chunk.path,
                        content: chunk.content,
                        keywordScore: chunk.keywordScore,
                        finalScore: chunk.finalScore,
                        similarity: chunk.similarity,
                        chunks: [chunk]
                    });
                } else {
                    const doc = docMap.get(chunk.path);
                    doc.chunks.push(chunk);
                    // Update doc score to be the max of its chunks
                    if (chunk.finalScore > doc.finalScore) {
                        doc.finalScore = chunk.finalScore;
                        doc.similarity = chunk.similarity;
                        doc.content = chunk.content; // Use best chunk as representative
                    }
                }
            }

            // Convert map to array and sort by best chunk score
            const topDocs = Array.from(docMap.values())
                .sort((a, b) => b.finalScore - a.finalScore)
                .slice(0, 20);

            debugLog(`[Graph Mind] ✓ Selected ${topDocs.length} documents from top chunks`);
            
            yield { type: 'result', content: topDocs };

        } catch (e) {
            console.error("[Graph Mind] Reranking failed, falling back to keyword order:", e);
            yield { type: 'result', content: candidates.slice(0, 12) };
        }
    }



    private cosineSimilarity(a: number[], b: number[]) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    private async generateQuery(userQuery: string, history: Message[]): Promise<string> {
        // Format history for the prompt
        const conversationHistory = history.map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n');

        const messages: Message[] = [
            { role: 'system', content: webSearchRetrieverPrompt },
            ...webSearchRetrieverFewShots as Message[],
            {
                role: 'user',
                content: `
<conversation>
${conversationHistory}
</conversation>
<query>
${userQuery}
</query>`
            }
        ];

        const response = await this.ollama.chat(messages);
        
        // Parse XML
        const match = response.match(/<question>([\s\S]*?)<\/question>/);
        if (match && match[1]) {
            return match[1].trim();
        }

        // Fallback if no XML found (sometimes models are chatty)
        if (response.includes('not_needed')) return 'not_needed';
        return userQuery;
    }
}

// Legacy wrapper for compatibility with ChatView
export async function runAgentLoop(userQuery: string, plugin: any, onThought?: (msg: string) => void): Promise<string> {
    const notify = onThought || ((msg: string) => new Notice(msg));
    const agent = new GraphMindAgent(plugin, notify);
    
    return await agent.chat(userQuery, []);
}

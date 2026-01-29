// @ts-ignore - MiniSearch is available at runtime
import MiniSearch from 'minisearch';

// @ts-ignore - nodejieba may not be available in all environments
let jieba: any = null;
const DEBUG = true;
const debugLog = (...args: unknown[]) => {
    if (DEBUG) console.log(...args);
};
try {
    jieba = require('nodejieba');
    debugLog('[Worker] nodejieba loaded successfully');
} catch (e) {
    console.warn('[Worker] nodejieba not available, using fallback CJK tokenization');
}

export type WorkerCommand = 'init' | 'index' | 'delete' | 'search';

export interface WorkerMessage {
    command: WorkerCommand;
    payload: any;
    id: string;
}

export interface WorkerResponse {
    id: string;
    status: 'success' | 'error';
    data?: any;
    error?: string;
}

// State holders
let miniSearch: MiniSearch | null = null;
let documents: Map<string, { title: string, path: string, content: string }> = new Map();

const initMiniSearch = () => {
    if (!miniSearch) {
        debugLog("Initializing MiniSearch...");
        miniSearch = new MiniSearch({
            fields: ['basename', 'aliases', 'path', 'content', 'h1', 'h2', 'h3', 'tags', 'urls', 'links'], // Comprehensive indexing
            storeFields: ['basename', 'aliases', 'path', 'content', 'h1', 'h2', 'h3', 'tags', 'urls', 'links', 'mtime', 'frontmatter'], // Store for retrieval and boosting
            searchOptions: {
                boost: { title: 2 },
                fuzzy: 0.2,
                prefix: true
            },
            tokenize: (string: string) => {
                // Enhanced tokenizer with Graph Mind-style features + Chinese segmentation
                const tokens: string[] = [];
                let currentToken = "";
                
                // Helper: Remove diacritics (café → cafe)
                const removeDiacritics = (str: string) => 
                    str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                
                // Helper: Split camelCase (myVariable → my, Variable)
                const splitCamelCase = (word: string): string[] => {
                    if (word.length < 3) return [word];
                    const parts = word.split(/(?=[A-Z])/);
                    return parts.length > 1 ? parts : [word];
                };
                
                // Helper: Split hyphens (hello-world → hello, world)
                const splitHyphens = (word: string): string[] => {
                    return word.includes('-') ? word.split('-') : [word];
                };
                
                // Helper: Check if string contains CJK characters
                const hasCJK = (str: string) => /[\u4e00-\u9fa5]/.test(str);
                
                // Step 1: Basic tokenization with CJK detection
                for (const char of string) {
                    if (char.match(/[\u4e00-\u9fa5]/)) {
                        if (currentToken) {
                            tokens.push(currentToken);
                            currentToken = "";
                        }
                        tokens.push(char);
                    } else if (char.match(/\s/)) {
                        if (currentToken) {
                            tokens.push(currentToken);
                            currentToken = "";
                        }
                    } else {
                        currentToken += char;
                    }
                }
                if (currentToken) tokens.push(currentToken);
                
                // Step 2: Apply Chinese segmentation if available
                let processedTokens = tokens;
                if (jieba) {
                    processedTokens = [];
                    for (const token of tokens) {
                        if (hasCJK(token)) {
                            // Use jieba for Chinese text
                            const segments = jieba.cut(token, true); // search mode
                            processedTokens.push(...segments);
                        } else {
                            processedTokens.push(token);
                        }
                    }
                }
                
                // Step 3: Expand tokens with camelCase and hyphen splits
                const expandedTokens: string[] = [];
                for (const token of processedTokens) {
                    // Original token (with diacritics removed)
                    const normalized = removeDiacritics(token.toLowerCase());
                    expandedTokens.push(normalized);
                    
                    // Skip splitting for CJK tokens
                    if (hasCJK(token)) continue;
                    
                    // Add camelCase splits
                    const camelSplits = splitCamelCase(token);
                    if (camelSplits.length > 1) {
                        expandedTokens.push(...camelSplits.map(t => removeDiacritics(t.toLowerCase())));
                    }
                    
                    // Add hyphen splits
                    const hyphenSplits = splitHyphens(token);
                    if (hyphenSplits.length > 1) {
                        expandedTokens.push(...hyphenSplits.map(t => removeDiacritics(t.toLowerCase())));
                    }
                }
                
                // Remove empty and duplicates
                return [...new Set(expandedTokens.filter(Boolean))];
            }
        });
        debugLog("MiniSearch initialized.");
    }
};

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
    const { command, payload, id } = event.data;

    try {
        let result;

        switch (command) {
            case 'init':
                initMiniSearch();
                result = { message: "Worker initialized" };
                break;

            case 'index':
                if (!miniSearch) initMiniSearch();
                const { id: docId, content, meta } = payload;

                // Build rich document object
                const doc = {
                    id: docId,
                    basename: meta.basename || meta.filePath.split('/').pop()?.replace(/\.md$/, '') || 'Untitled',
                    aliases: meta.aliases || '',
                    path: meta.filePath,
                    content: content,
                    h1: meta.h1 || '',
                    h2: meta.h2 || '',
                    h3: meta.h3 || '',
                    tags: meta.tags || '',
                    urls: meta.urls || '',
                    links: meta.links || '',
                    mtime: meta.mtime || Date.now(),
                    frontmatter: meta.frontmatter || {}
                };

                // Store full content for retrieval
                if (miniSearch!.has(docId)) {
                    miniSearch!.replace(doc);
                } else {
                    miniSearch!.add(doc);
                }
                documents.set(docId, { title: doc.basename, path: doc.path, content: content });
                
                result = { message: "Indexed", docId };
                break;

            case 'delete':
                if (!miniSearch) initMiniSearch();
                const { path } = payload;
                
                // Find all docs with this path
                const idsToDelete: string[] = [];
                documents.forEach((doc, key) => {
                    if (doc.path === path) {
                        idsToDelete.push(key);
                    }
                });

                idsToDelete.forEach(did => {
                    miniSearch!.remove({ id: did });
                    documents.delete(did);
                });

                result = { message: "Deleted", count: idsToDelete.length };
                break;

            // ================= SEARCH LOGIC =================
            case 'search':
                debugLog(`[Worker] 🔍 Search request received: "${payload.query}"`);
                const searchStart = performance.now();

                if (!miniSearch) initMiniSearch();

                const { query, topK = 30 } = payload; // Default to higher topK for reranking candidates

            // --- Step 1: Keyword Search (Graph Mind-style) ---
                debugLog("[Worker] 1. Keyword Search...");
                const miniResults = miniSearch!.search(query, { 
                    boost: { 
                        basename: 4,   // Filename gets highest boost (increased from 3)
                        aliases: 3.5,  // Aliases very important (people search by aliases)
                        h1: 2.5,       // H1 headings very important
                        h2: 2,         // H2 moderately important
                        h3: 1.5,       // H3 slightly important
                        tags: 3,       // Tags very important for categorization (increased from 2)
                        links: 1.8,    // Internal links provide context
                        urls: 1.3,     // External URLs less important
                        path: 1.2,     // Path provides context
                        content: 1     // Default weight for content
                    }, 
                    // Dynamic fuzzy: short terms = exact, long terms = fuzzy
                    fuzzy: (term: string) => term.length <= 3 ? 0 : term.length <= 5 ? 0.1 : 0.2,
                    // Only prefix for terms >= 2 chars
                    prefix: (term: string) => term.length >= 2,
                    // Boost recent documents (Graph Mind-style recency)
                    boostDocument: (docId: string, term: string, storedFields: any) => {
                        if (!storedFields?.mtime) return 1;
                        
                        const now = Date.now();
                        const mtime = storedFields.mtime;
                        const daysElapsed = (now - mtime) / (24 * 3600_000);
                        
                        // Exponential decay: recent docs get higher boost
                        // 1 day old: ~1.3x, 7 days: ~1.1x, 30 days: ~1.0x
                        return 1 + Math.exp(-0.1 * daysElapsed / 1000);
                    }
                });
                
                // Return candidates with full content for the main thread to rerank
                const candidates = miniResults.slice(0, topK).map((r: any) => {
                    const info = documents.get(r.id);
                    return {
                        id: r.id,
                        content: info ? info.content : "Unknown",
                        path: info ? info.path : r.id,
                        score: r.score, // Include generic score for compatibility
                        keywordScore: r.score,
                        source: 'keyword'
                    };
                });

                debugLog(`[Worker] Found ${candidates.length} candidates.`);
                result = { results: candidates };
                debugLog(`[Worker] Search finished in ${(performance.now() - searchStart).toFixed(2)}ms`);
                break;

            default:
                throw new Error(`Unknown command: ${command}`);
        }

        const response: WorkerResponse = {
            id,
            status: 'success',
            data: result
        };
        self.postMessage(response);

    } catch (error: any) {
        console.error(`Error in worker [${command}]:`, error);
        const response: WorkerResponse = {
            id,
            status: 'error',
            error: error.message || String(error)
        };
        self.postMessage(response);
    }
};

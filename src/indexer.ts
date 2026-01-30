import { Vault, TFile } from "obsidian";
import { WorkerMessage } from "./worker/worker";
import { MDocument } from "@mastra/rag";

export class Indexer {
    private vault: Vault;
    private worker: Worker;
    private debug: boolean = true;

    constructor(vault: Vault, worker: Worker) {
        this.vault = vault;
        this.worker = worker;
    }

    async buildIndex(onProgress?: (completed: number, total: number) => void) {
        const files = this.vault.getMarkdownFiles();
        let processedCount = 0;
        const total = files.length;
        if (this.debug) console.debug(`[Graph Mind] Indexing start: ${total} files`);

        for (const file of files) {
            await this.indexFile(file);
            processedCount++;
            if (onProgress) onProgress(processedCount, total);
            if (this.debug) console.debug(`[Graph Mind] Indexing progress: ${processedCount}/${total} (${file.path})`);
        }
    }

    async indexFile(file: TFile) {
        try {
            // First delete existing chunks for this file to avoid duplicates if re-indexing
            this.deleteFile(file.path);

            const content = await this.vault.read(file);
            
            // Extract rich metadata (Graph Mind-style)
            const metadata = this.extractMetadata(content, file);
            
            const chunks = await this.chunkContent(content, file.path, metadata);
            if (this.debug) console.debug(`[Graph Mind] Indexing file: ${file.path} (${chunks.length} chunks)`);

            // Process chunks
            for (const chunk of chunks) {
                const message: WorkerMessage = {
                    command: 'index',
                    id: chunk.id,
                    payload: {
                        id: chunk.id,
                        content: chunk.text,
                        meta: chunk.meta
                    }
                };
                this.worker.postMessage(message);
            }
        } catch (error) {
            console.error(`Failed to process file ${file.path}:`, error);
        }
    }

    private extractMetadata(content: string, file: TFile): ExtractedMetadata {
        // Extract frontmatter (YAML between ---)
        const frontmatter: Record<string, string> = {};
        const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (frontmatterMatch) {
            try {
                // Simple YAML parsing for common fields
                const yamlContent = frontmatterMatch[1];
                const lines = yamlContent.split('\n');
                for (const line of lines) {
                    const [key, ...valueParts] = line.split(':');
                    if (key && valueParts.length > 0) {
                        const value = valueParts.join(':').trim();
                        const cleanedValue = value
                            .replace(/["']/g, "")
                            .replace(/\[/g, "")
                            .replace(/\]/g, "");
                        frontmatter[key.trim()] = cleanedValue; // Remove quotes/brackets
                    }
                }
            } catch (e) {
                console.warn('Failed to parse frontmatter for', file.path, e);
            }
        }
        
        // Extract headings
        const h1Matches = content.match(/^# (.+)$/gm) || [];
        const h2Matches = content.match(/^## (.+)$/gm) || [];
        const h3Matches = content.match(/^### (.+)$/gm) || [];
        
        // Extract tags (both #tag and frontmatter tags)
        const inlineTagMatches = content.match(/#[a-zA-Z][a-zA-Z0-9_/-]*/g) || [];
        const frontmatterTags = frontmatter.tags ? frontmatter.tags.split(/[,\s]+/).filter(Boolean) : [];
        const allTags = [...new Set([...inlineTagMatches, ...frontmatterTags.map((t: string) => t.startsWith('#') ? t : '#' + t)])];
        
        // Extract aliases from frontmatter
        const aliases = frontmatter.aliases || frontmatter.alias || '';
        
        // Extract markdown links/URLs
        const urlMatches = content.match(/https?:\/\/[^\s)]+/g) || [];
        const wikiLinks = content.match(/\[\[([^]]+)\]\]/g) || [];
        
        return {
            basename: file.basename,
            aliases,
            h1: h1Matches.map(h => h.replace(/^# /, '')).join(' '),
            h2: h2Matches.map(h => h.replace(/^## /, '')).join(' '),
            h3: h3Matches.map(h => h.replace(/^### /, '')).join(' '),
            tags: allTags.join(' '),
            urls: urlMatches.join(' '),
            links: wikiLinks.map(l => l.replace(/\[/g, "").replace(/\]/g, "")).join(' '),
            mtime: file.stat.mtime,
            // Include all frontmatter fields for custom property boosting
            frontmatter
        };
    }

    deleteFile(path: string) {
        const message: WorkerMessage = {
            command: 'delete',
            id: `delete-${path}`,
            payload: { path }
        };
        this.worker.postMessage(message);
    }

    private async chunkContent(content: string, filePath: string, metadata: ExtractedMetadata): Promise<Array<{ id: string, text: string, meta: ExtractedMetadata }>> {
        // Use Mastra's semantic chunking for consistent, high-quality chunks
        // Same strategy used in agent reranking - unified approach
        try {
            const doc = MDocument.fromText(content);
            
            const mastraChunks = await doc.chunk({
                strategy: "recursive",
                maxSize: 1024,        // Characters per chunk (optimal for nomic-embed-text)
                overlap: 50,         // Overlap to maintain context continuity
                separators: ["\n\n", "\n", " "],  // Split on paragraph breaks, then lines, then spaces
            });

            // Transform Mastra chunks to our format with consistent IDs and rich metadata
            return mastraChunks.map((chunk, index) => ({
                id: `${filePath}::${index}`,
                text: chunk.text.trim(),
                meta: { 
                    filePath,
                    chunkIndex: index,
                    ...metadata  // Include all extracted metadata
                }
            })).filter(chunk => chunk.text.length > 0); // Filter empty chunks
            
        } catch (error) {
            console.warn(`[Indexer] Mastra chunking failed for ${filePath}, using fallback:`, error);
            
            // Fallback: simple paragraph-based chunking if Mastra fails
            const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 0);
            return paragraphs.map((para, index) => ({
                id: `${filePath}::${index}`,
                text: para.trim().substring(0, 600), // Limit to 600 chars
                meta: { 
                    filePath,
                    chunkIndex: index,
                    ...metadata  // Include all extracted metadata
                }
            }));
        }
    }
}

interface ExtractedMetadata {
    basename: string;
    aliases: string;
    h1: string;
    h2: string;
    h3: string;
    tags: string;
    urls: string;
    links: string;
    mtime: number;
    frontmatter: Record<string, string>;
    filePath?: string;
    chunkIndex?: number;
}

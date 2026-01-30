import { WorkerMessage, WorkerResponse } from '../worker/worker';

export interface SearchResult {
    id: string;
    content: string;
    path: string;
    score: number;
    keywordScore?: number;
    rerankScore?: number;
    source: string;
}

export class SearchService {
    private worker: Worker;
    private pendingRequests: Map<string, { resolve: (data: unknown) => void, reject: (error: Error) => void }>;
    private idCounter: number = 0;

    constructor(worker: Worker) {
        this.worker = worker;
        this.pendingRequests = new Map();
        
        this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
            const { id, status, data, error } = event.data;
            if (this.pendingRequests.has(id)) {
                const { resolve, reject } = this.pendingRequests.get(id)!;
                if (status === 'success') {
                    resolve(data);
                } else {
                    reject(new Error(error));
                }
                this.pendingRequests.delete(id);
            }
        });
    }

    private finalizeRequest(id: string): void {
        this.pendingRequests.delete(id);
    }

    public async search(query: string, topK: number = 15, timeoutMs: number = 30000): Promise<SearchResult[]> {
        const id = `search-${this.idCounter++}`;
        
        const timeoutPromise = new Promise<SearchResult[]>((_, reject) => {
            setTimeout(() => reject(new Error('Search timeout exceeded')), timeoutMs);
        });
        
        const searchPromise = new Promise<unknown>((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            
            const message: WorkerMessage = {
                command: 'search',
                id: id,
                payload: { query, topK }
            };
            
            this.worker.postMessage(message);
        }).then((response) => (response as unknown as { results: SearchResult[] }).results);
        
        return Promise.race([searchPromise, timeoutPromise]).finally(() => {
            // Clean up pending request if timeout occurred
            this.finalizeRequest(id);
        });
    }

    // Add utility for raw index command if needed via service
    public async indexDocument(id: string, content: string, meta: Record<string, unknown>): Promise<void> {
         const msgId = `index-${this.idCounter++}`;
         return new Promise((resolve, reject) => {
             this.pendingRequests.set(msgId, { resolve, reject });
             this.worker.postMessage({
                 command: 'index',
                 id: msgId,
                 payload: { id, content, meta }
             });
         });
    }
}

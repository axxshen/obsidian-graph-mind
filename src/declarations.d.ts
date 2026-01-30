declare module "voy-search/voy_search_bg.js" {
    export class Voy {
        constructor(resource?: unknown);
        add(resource: unknown): void;
        search(embedding: number[], k: number): unknown;
    }
    export function __wbg_set_wasm(val: unknown): void;
}

declare module "virtual:worker" {
    const workerCode: string;
    export default workerCode;
}

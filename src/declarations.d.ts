declare module "voy-search/voy_search_bg.js" {
    export class Voy {
        constructor(resource?: any);
        add(resource: any): void;
        search(embedding: number[], k: number): any;
    }
    export function __wbg_set_wasm(val: any): void;
}

declare module "virtual:worker" {
    const workerCode: string;
    export default workerCode;
}

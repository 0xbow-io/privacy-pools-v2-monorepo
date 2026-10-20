import type { ICircuitArtifacts } from "@privacy-pools-v2/evm-sdk";

/**
 * Browser-compatible circuit artifact loader that fetches WASM/zkey files from a URL.
 *
 * Expects the following directory structure at the base URL:
 *   {baseUrl}/{circuitName}/{circuitName}_js/{circuitName}.wasm
 *   {baseUrl}/{circuitName}/groth16_pkey.zkey
 *   {baseUrl}/{circuitName}/groth16_vkey.json
 */
export class FetchCircuitArtifacts implements ICircuitArtifacts {
    private readonly baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
    }

    async getWasm(circuitName: string): Promise<Uint8Array> {
        const url = `${this.baseUrl}/${circuitName}/${circuitName}_js/${circuitName}.wasm`;
        return this.fetchBinary(url);
    }

    async getProvingKey(circuitName: string): Promise<Uint8Array> {
        const url = `${this.baseUrl}/${circuitName}/groth16_pkey.zkey`;
        return this.fetchBinary(url);
    }

    async getVerificationKey(circuitName: string): Promise<Uint8Array> {
        const url = `${this.baseUrl}/${circuitName}/groth16_vkey.json`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
        const text = await response.text();
        return new TextEncoder().encode(text);
    }

    private async fetchBinary(url: string): Promise<Uint8Array> {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
    }
}

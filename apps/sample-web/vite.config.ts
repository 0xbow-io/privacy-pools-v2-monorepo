import { resolve } from "path";
import { defineConfig, type Plugin } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const root = resolve(__dirname, "../..");

/**
 * Intercepts Node.js built-in module imports and replaces them with empty stubs.
 * Runs before vite-plugin-node-polyfills to prevent it from trying to sub-path
 * resolve things like "node:fs/promises" (which breaks node-stdlib-browser).
 */
function nodeStubs(): Plugin {
    const STUBS = new Set([
        "fs", "fs/promises", "node:fs", "node:fs/promises",
        "path", "node:path",
        "assert", "node:assert",
        "events", "node:events",
        "stream", "util", "os",
    ]);
    const PREFIX = "\0node-stub:";

    return {
        name: "node-stubs",
        enforce: "pre",
        resolveId(id) {
            if (STUBS.has(id)) return PREFIX + id;
        },
        load(id) {
            if (!id.startsWith(PREFIX)) return;
            return `
export default {};
export const readFile = () => Promise.resolve("");
export const writeFile = () => Promise.resolve();
export const mkdir = () => Promise.resolve();
export const rename = () => Promise.resolve();
export const join = (...parts) => parts.join("/");
export const dirname = (p) => p.split("/").slice(0, -1).join("/");
export const resolve = (...parts) => parts.join("/");
export class EventEmitter {}
export class Readable {}
`;
        },
    };
}

export default defineConfig({
    resolve: {
        alias: {
            "@privacy-pools-v2/evm-sdk": resolve(root, "packages/evm-sdk/src/external.ts"),
        },
    },
    build: {
        rollupOptions: {
            input: {
                main: resolve(__dirname, "index.html"),
                deposit: resolve(__dirname, "deposit.html"),
            },
        },
    },
    plugins: [
        nodeStubs(),
        // Only inject Buffer/process globals — module polyfills handled by nodeStubs above.
        nodePolyfills({ include: ["buffer"], globals: { Buffer: true, global: true, process: true } }),
    ],
});

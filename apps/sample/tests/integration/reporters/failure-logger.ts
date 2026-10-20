import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Reporter } from "vitest/reporters";

const LOG_DIR = resolve(import.meta.dirname, "..", "logs");
const LOG_FILE = resolve(LOG_DIR, `failures-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);

interface TaskResult {
    state?: string;
    duration?: number;
    errors?: Array<{ message?: string; stack?: string; diff?: string }>;
}

interface TaskLike {
    name: string;
    type: string;
    result?: TaskResult;
    tasks?: TaskLike[];
}

interface FileLike {
    name: string;
    tasks: TaskLike[];
}

/**
 * Custom Vitest reporter that writes only test failures to a timestamped log file.
 * Produces no file if all tests pass.
 */
export default class FailureLogger implements Reporter {
    private failures: string[] = [];

    onFinished(files?: FileLike[]): void {
        if (!files) return;

        for (const file of files) {
            this.collectFailures(file.tasks, file.name);
        }

        if (this.failures.length === 0) return;

        // Ensure log directory exists
        if (!existsSync(LOG_DIR)) {
            mkdirSync(LOG_DIR, { recursive: true });
        }

        const header = [
            "=".repeat(80),
            `  Integration Test Failures — ${new Date().toISOString()}`,
            "=".repeat(80),
            "",
        ].join("\n");

        writeFileSync(LOG_FILE, header + this.failures.join("\n"), "utf-8");

        console.log(`\n  [failure-logger] ${this.failures.length} failure(s) written to:`);
        console.log(`  ${LOG_FILE}\n`);
    }

    private collectFailures(tasks: TaskLike[], filePath: string): void {
        for (const task of tasks) {
            // Recurse into suites (describe blocks)
            if (task.type === "suite" && task.tasks) {
                this.collectFailures(task.tasks, filePath);
                continue;
            }

            const result = task.result;
            if (!result || result.state !== "fail") continue;

            const errors = result.errors ?? [];
            const entry = [
                "-".repeat(80),
                `TEST:  ${task.name}`,
                `FILE:  ${filePath}`,
                `STATE: ${result.state}`,
                `TIME:  ${result.duration != null ? `${result.duration}ms` : "N/A"}`,
                "",
                ...errors.map((err: { message?: string; stack?: string; diff?: string }) => {
                    const parts: string[] = [];
                    if (err.message) parts.push(`  Error: ${err.message}`);
                    if (err.stack) parts.push(`  Stack:\n${indent(err.stack, 4)}`);
                    if (err.diff) parts.push(`  Diff:\n${indent(err.diff, 4)}`);
                    return parts.join("\n");
                }),
                "",
            ];

            this.failures.push(entry.join("\n"));
        }
    }
}

function indent(text: string, spaces: number): string {
    const pad = " ".repeat(spaces);
    return text
        .split("\n")
        .map((line) => pad + line)
        .join("\n");
}

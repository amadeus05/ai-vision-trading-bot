import * as fs from "fs";
import * as path from "path";

export type StructuredLogStatus = "success" | "failure" | "skip" | "retry" | "start";

export interface StructuredLogEvent {
    symbol?: string;
    phase: string;
    status: StructuredLogStatus;
    duration_ms?: number;
    screenshot_path?: string;
    selector_used?: string;
    ai_key_used?: string;
    retry_count?: number;
    message?: string;
    error?: string;
    meta?: Record<string, unknown>;
}

const LOG_DIR = "./logs";
const LOG_FILE = path.join(LOG_DIR, "bot-events.jsonl");

export function logEvent(event: StructuredLogEvent): void {
    const payload = {
        ts: new Date().toISOString(),
        ...event,
    };

    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }

        fs.appendFileSync(LOG_FILE, `${JSON.stringify(payload)}\n`, "utf-8");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[structured-log] failed to write event: ${message}`);
    }
}

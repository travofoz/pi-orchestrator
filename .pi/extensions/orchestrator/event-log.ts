/**
 * JSON-lines event log for the orchestrator.
 * Append-only, zero dependencies, grep-able with jq.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface OrchestratorEvent {
	ts: string;
	type: string;
	data: Record<string, unknown>;
}

export class EventLog {
	private logPath: string;
	private stream: fs.WriteStream | null = null;

	constructor(orchestratorDir: string) {
		this.logPath = path.join(orchestratorDir, "events.jsonl");
	}

	/** Append an event to the log. Safe to call from any phase. */
	append(type: string, data: Record<string, unknown> = {}): void {
		const event: OrchestratorEvent = {
			ts: new Date().toISOString(),
			type,
			data,
		};
		const line = JSON.stringify(event) + "\n";

		if (this.stream) {
			this.stream.write(line);
		} else {
			fs.appendFileSync(this.logPath, line, "utf-8");
		}
	}

	/** Read the last N events (newest first). */
	tail(n: number = 20): OrchestratorEvent[] {
		if (!fs.existsSync(this.logPath)) return [];
		const content = fs.readFileSync(this.logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		const last = lines.slice(-n);
		return last.map((line) => JSON.parse(line) as OrchestratorEvent);
	}

	/** Read all events matching a type. */
	filter(type: string): OrchestratorEvent[] {
		if (!fs.existsSync(this.logPath)) return [];
		const content = fs.readFileSync(this.logPath, "utf-8");
		return content
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as OrchestratorEvent)
			.filter((e) => e.type === type);
	}

	/** Start streaming (write stream for performance during active runs). */
	open(): void {
		if (this.stream) return;
		this.stream = fs.createWriteStream(this.logPath, { flags: "a" });
	}

	/** Close the write stream. */
	close(): void {
		if (this.stream) {
			this.stream.end();
			this.stream = null;
		}
	}
}

/**
 * JSON-lines event log for the bake pipeline.
 * Append-only, zero dependencies, grep-able with jq.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface BakeEvent {
	ts: string;
	type: string;
	data: Record<string, unknown>;
}

export class EventLog {
	private logPath: string;
	private stream: fs.WriteStream | null = null;

	constructor(bakeDir: string) {
		this.logPath = path.join(bakeDir, "events.jsonl");
	}

	/** Append an event to the log. Safe to call from any phase. */
	append(type: string, data: Record<string, unknown> = {}): void {
		const event: BakeEvent = {
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

	/**
	 * Read the last N events (newest first).
	 *
	 * When the write stream is active, reads the on-disk log file directly.
	 * The OS page cache typically provides sub-ms reads, so no explicit
	 * fsync is needed for diagnostic visibility.
	 * Malformed lines are silently skipped.
	 */
	tail(n: number = 20): BakeEvent[] {
		if (!fs.existsSync(this.logPath)) return [];
		const content = fs.readFileSync(this.logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		const last = lines.slice(-n);
		const result: BakeEvent[] = [];
		for (const line of last) {
			try {
				result.push(JSON.parse(line) as BakeEvent);
			} catch {
				// Skip malformed lines (e.g. partial write during crash)
			}
		}
		return result;
	}

	/** Read all events matching a type. */
	filter(type: string): BakeEvent[] {
		if (!fs.existsSync(this.logPath)) return [];
		const content = fs.readFileSync(this.logPath, "utf-8");
		return content
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line) as BakeEvent;
				} catch {
					return null;
				}
			})
			.filter((e): e is BakeEvent => e !== null)
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

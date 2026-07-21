/**
 * Bake — manages the phase execution loop.
 *
 * Coordinates: phase loading → executor → auditor → remediation → repeat/circuit-breaker.
 *
 * State and orchestration live here. Execution, audit, and remediation
 * logic are extracted to bake-executor.ts and bake-audit.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { EventLog } from "./event-log.ts";
import { RpcAgent } from "./rpc-agent.ts";
import type { AuditFinding } from "./auditor.ts";
import { runBakePipeline, type BakeEnv } from "./bake-machine.ts";

export interface PhaseSpec {
	name: string;
	filePath: string;
	content: string;
	/** Unique ID from phase file metadata or dag.json, falls back to name */
	phaseId: string;
	/** Phase IDs this phase depends on (empty = no deps, runnable immediately) */
	dependsOn: string[];
	/** Ordered implementation steps parsed from the Plan section */
	planSteps: string[];
}

export interface BakeState {
	currentPhase: string | null;
	currentAttempt: number;
	maxAttempts: number;
	status: "idle" | "running" | "paused" | "done" | "failed";
	completedPhases: string[];
	skippedPhases: string[];
	pendingSteer: string | null;
	/** Phase names currently being executed (for UI with parallel phases) */
	activePhases: string[];
}

export interface PhaseResult {
	phase: string;
	/** true = passed, false = circuit-breaker, "paused" = user requested pause */
	passed: boolean | "paused";
	attempts: number;
	findings: AuditFinding[];
}

export class Bake {
	private bakeDir: string;
	private workspaceDir: string;
	private rulesDir: string;
	private phasesDir: string;
	private completedDir: string;
	private stateFile: string;
	private log: EventLog;
	private state: BakeState;
	private _onStateChange?: (state: BakeState) => void;
	private _onStatus?: (msg: string) => void;
	private _onLoader?: (show: boolean, msg: string) => void;
	private rpcAgent: RpcAgent;
	/** Phase IDs whose most recent attempt should be retried (transient, not serialized). */
	private pendingRetry: string[] = [];

	constructor(baseDir: string, workspaceDir: string, rulesDir: string) {
		this.bakeDir = path.join(baseDir, ".bake");
		this.workspaceDir = workspaceDir;
		this.rulesDir = rulesDir;
		this.phasesDir = path.join(this.bakeDir, "phases");
		this.completedDir = path.join(this.bakeDir, "completed");
		this.stateFile = path.join(this.bakeDir, "state.json");
		this.log = new EventLog(this.bakeDir);

		// Ensure dirs exist
		for (const dir of [this.bakeDir, this.completedDir, this.workspaceDir]) {
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		}

		this.state = this.loadState();

		// Initialize the long-lived RPC subprocess
		this.rpcAgent = new RpcAgent({
			cwd: this.workspaceDir,
			noExtensions: true,
			promptTimeout: 2 * 60 * 60 * 1000, // 2hr default per prompt
		});
	}

	get stateSnapshot(): Readonly<BakeState> {
		return { ...this.state };
	}

	get eventLog(): EventLog {
		return this.log;
	}

	onStateChange(cb: (state: BakeState) => void): void {
		this._onStateChange = cb;
	}

	onStatus(cb: (msg: string) => void): void {
		this._onStatus = cb;
	}

	onLoader(cb: (show: boolean, msg: string) => void): void {
		this._onLoader = cb;
	}

	private saveState(): void {
		fs.writeFileSync(
			this.stateFile,
			JSON.stringify(this.state, null, 2),
			"utf-8",
		);
	}

	/**
	 * Full cleanup: abort running operations, wipe workspace, completed dir,
	 * event log, archive, spec-context, and reset state to idle.
	 * Keeps phases/ intact.
	 */
	clean(): void {
		this.abort();
		try {
			this.rpcAgent.close();
		} catch {
			/* non-fatal during cleanup */
		}
		try {
			this.log.close();
		} catch {
			/* non-fatal during cleanup */
		}

		// Nuke and recreate workspace
		try {
			fs.rmSync(this.workspaceDir, { recursive: true, force: true });
		} catch {
			/* non-fatal during cleanup */
		}
		try {
			fs.mkdirSync(this.workspaceDir, { recursive: true });
		} catch {
			/* non-fatal during cleanup */
		}

		// Nuke completed dir
		try {
			fs.rmSync(this.completedDir, { recursive: true, force: true });
		} catch {
			/* non-fatal during cleanup */
		}
		try {
			fs.mkdirSync(this.completedDir, { recursive: true });
		} catch {
			/* non-fatal during cleanup */
		}

		// Nuke event log
		try {
			fs.rmSync(path.join(this.bakeDir, "events.jsonl"), { force: true });
		} catch {
			/* non-fatal during cleanup */
		}

		// Nuke archive and spec-context (decomposed specs from prior runs)
		try {
			fs.rmSync(path.join(this.bakeDir, "archive"), {
				recursive: true,
				force: true,
			});
		} catch {
			/* non-fatal during cleanup */
		}
		try {
			fs.rmSync(path.join(this.bakeDir, "spec-context.md"), { force: true });
		} catch {
			/* non-fatal during cleanup */
		}

		// Nuke phases dir — reset means reset
		try {
			fs.rmSync(this.phasesDir, { recursive: true, force: true });
		} catch {
			/* non-fatal during cleanup */
		}
		try {
			fs.mkdirSync(this.phasesDir, { recursive: true });
		} catch {
			/* non-fatal during cleanup */
		}

		this.pendingRetry = [];
		this.resetState();
	}

	/** Reset state to clean idle — used when stale state is detected on startup. */
	resetState(): void {
		this.state = {
			currentPhase: null,
			currentAttempt: 0,
			maxAttempts: 3,
			status: "idle",
			completedPhases: [],
			skippedPhases: [],
			pendingSteer: null,
			activePhases: [],
		};
		this.emitState();
	}

	private loadState(): BakeState {
		if (fs.existsSync(this.stateFile)) {
			try {
				const raw = fs.readFileSync(this.stateFile, "utf-8");
				const parsed = JSON.parse(raw) as BakeState;
				// Ensure activePhases field exists on deserialized old state
				if (!parsed.activePhases) parsed.activePhases = [];
				return parsed;
			} catch {
				// Corrupted state — start fresh (log not available at construction time)
			}
		}
		return {
			currentPhase: null,
			currentAttempt: 0,
			maxAttempts: 3,
			status: "idle",
			completedPhases: [],
			skippedPhases: [],
			pendingSteer: null,
			activePhases: [],
		};
	}

	/** Load enabled rules from rules-state.json. Returns undefined (all enabled) if no state file. */
	private getEnabledRules(): Set<string> | undefined {
		const stateFile = path.join(this.bakeDir, "rules-state.json");
		if (!fs.existsSync(stateFile)) return undefined;
		try {
			const state: Record<string, boolean> = JSON.parse(
				fs.readFileSync(stateFile, "utf-8"),
			);
			const enabled = new Set<string>();
			for (const [rule, on] of Object.entries(state)) {
				if (on) enabled.add(rule);
			}
			return enabled.size > 0 ? enabled : undefined;
		} catch {
			return undefined;
		}
	}

	private emitState(): void {
		this.saveState();
		this._onStateChange?.(this.state);
	}

	/** Load dag.json manifest and return a map of phaseId → dependsOn. */
	private loadDagManifest(): Map<string, string[]> {
		const dagPath = path.join(this.phasesDir, "dag.json");
		if (!fs.existsSync(dagPath)) return new Map();
		try {
			const data: Array<{ id: string; depends_on: string[] }> = JSON.parse(
				fs.readFileSync(dagPath, "utf-8"),
			);
			return new Map(data.map((entry) => [entry.id, entry.depends_on || []]));
		} catch {
			return new Map();
		}
	}

	private getPendingPhases(): PhaseSpec[] {
		if (!fs.existsSync(this.phasesDir)) return [];
		const dag = this.loadDagManifest();
		return fs
			.readdirSync(this.phasesDir)
			.filter((f) => f.endsWith(".md") && f !== "dag.json")
			.sort()
			.map((file) => {
				const filePath = path.join(this.phasesDir, file);
				const content = fs.readFileSync(filePath, "utf-8");
				const name = file.replace(/\.md$/, "");

				// Parse Phase ID from file metadata
				const idMatch = content.match(/^## Phase ID\n([^\n]+)/m);
				const phaseId = idMatch ? idMatch[1].trim() : name;

				// Get dependencies from DAG manifest or phase content
				let dependsOn: string[] = [];
				if (dag.has(phaseId)) {
					dependsOn = dag.get(phaseId)!;
				} else {
					const depsMatch = content.match(
						/^## Depends On\n([\s\S]*?)(?:\n##|$)/m,
					);
					if (depsMatch) {
						dependsOn = depsMatch[1]
							.split(",")
							.map((s) => s.trim())
							.filter((s) => s !== "(none)" && s.length > 0);
					}
				}

				// Parse plan steps from phase content
				const planMatch = content.match(/^## Plan\n([\s\S]*?)(?:\n##|$)/m);
				const planSteps: string[] = [];
				if (planMatch) {
					for (const line of planMatch[1].split("\n")) {
						const trimmed = line.replace(/^[-*\s]+/, "").trim();
						if (trimmed && trimmed !== "(none)") planSteps.push(trimmed);
					}
				}

				return { name, filePath, content, phaseId, dependsOn, planSteps };
			});
	}

	/** Steer: inject guidance into the next executor run. */
	steer(message: string): void {
		this.state.pendingSteer = message;
		this.emitState();
		this.log.append("steer", { message });
	}

	/**
	 * Provide context to unblock a NEEDS_CONTEXT phase.
	 * Called from the XState machine's PROVIDE_CONTEXT action.
	 */
	provideContext(info: string): void {
		this.state.pendingSteer = info;
		this.emitState();
	}

	/** Pause the pipeline after the current attempt. */
	pause(): void {
		this.state.status = "paused";
		this.emitState();
		this.log.append("pause", {});
	}

	/** Resume from pause — restart the pipeline. */
	async resume(): Promise<void> {
		if (this.state.status === "paused") {
			this.state.status = "running";
			this.emitState();
			this.log.append("resume", {});
			// Re-enter the pipeline; it will skip completed/skipped phases
			await this.runPipeline();
		}
	}

	/** Skip a phase by name, or the current phase if no name given. */
	skipPhase(phaseName?: string): void {
		// Cancel any in-flight operation so we don't race with a completing phase
		this.rpcAgent.abort();

		const target = phaseName || this.state.currentPhase;
		if (target && !this.state.skippedPhases.includes(target)) {
			this.state.skippedPhases.push(target);
			this.log.append("skip_phase", { phase: target });
		}
		if (!phaseName || phaseName === this.state.currentPhase) {
			this.state.currentPhase = null;
			this.state.currentAttempt = 0;
			this.state.pendingSteer = null;
		}
		// Clear all pending retries — the abort reset state, any retry is moot
		this.pendingRetry = [];
		this.emitState();
	}

	/**
	 * Retry the current attempt (re-run executor).
	 *
	 * Sets a pending-retry flag so runBakePipeline can re-create the phase actor.
	 * The XState actor in flight will be aborted and treated as skipped-for-retry
	 * by the outer loop, which then picks up the phase again in the next iteration.
	 */
	retryAttempt(): void {
		if (!this.state.currentPhase) {
			this.log.append("retry_attempt_noop", { reason: "no active phase" });
			return;
		}

		// Look up the phaseId for the current phase name
		const phases = this.getPendingPhases();
		const current = phases.find((p) => p.name === this.state.currentPhase);
		if (current) {
			this.pendingRetry.push(current.phaseId);
			this.log.append("retry_attempt", {
				phase: this.state.currentPhase,
				phaseId: current.phaseId,
				attempt: this.state.currentAttempt,
			});
		} else {
			this.log.append("retry_attempt_noop", {
				phase: this.state.currentPhase,
				reason: "phase not found in pending list",
			});
			return;
		}

		// Cancel in-flight executor so the outer loop picks up the retry
		this.rpcAgent.abort();
		this.state.currentAttempt = 0;
		this.emitState();
	}

	/**
	 * Run the full pipeline: process all pending phases.
	 * This is the main entry point for the bake pipeline.
	 */
	async runPipeline(): Promise<void> {
		this.state.status = "running";
		this.emitState();

		// Start the RPC agent (idempotent)
		this.rpcAgent.start();
		this.log.open();
		this.log.append("pipeline_start", {});

		const phases = this.getPendingPhases();
		if (phases.length === 0) {
			this.state.status = "done";
			this.emitState();
			this.log.append("pipeline_empty", {});
			this.log.close();
			this.rpcAgent.close();
			return;
		}

		try {
			const env: BakeEnv = {
				workspaceDir: this.workspaceDir,
				rulesDir: this.rulesDir,
				completedDir: this.completedDir,
				rpcAgent: this.rpcAgent,
				getEnabledRules: () => this.getEnabledRules(),
				onStatus: (msg) => this._onStatus?.(msg),
				onLoader: (show, msg) => this._onLoader?.(show, msg),
				log: this.log,
				pendingSteer: () => this.state.pendingSteer,
				provideContext: (info: string) => this.provideContext(info),
				consumeRetry: (phaseId: string) => {
					const idx = this.pendingRetry.indexOf(phaseId);
					if (idx !== -1) {
						this.pendingRetry.splice(idx, 1);
						return true;
					}
					return false;
				},
				isSkipped: (phaseName: string) =>
					this.state.skippedPhases.includes(phaseName),
				maxAttempts: this.state.maxAttempts,
				onProgress: (_completed, _total, active) => {
					this.state.activePhases = active;
					this.state.currentPhase = active.length === 1 ? active[0] : null;
					this.emitState();
				},
			};

			const { passed, results } = await runBakePipeline(phases, env);

			// Map results back to BakeState for persistence + UI
			this.state.completedPhases = [];
			this.state.activePhases = [];
			for (const phase of phases) {
				const r = results[phase.phaseId];
				if (r?.passed === true) {
					this.state.completedPhases.push(phase.name);
				}
			}

			if (passed) {
				this.state.status = "done";
				this.log.append("pipeline_complete", {});
			} else {
				this.state.status = "failed";
				this.log.append("pipeline_halted", { reason: "phase_failed" });
			}
		} finally {
			this.state.activePhases = [];
			this.emitState();
			this.log.close();
			this.rpcAgent.close();
		}
	}

	/**
	 * Run a one-shot prompt through the shared RPC agent.
	 * Uses a fresh session per call, wires status/loader/delta callbacks.
	 * Throws on failure — caller handles error reporting.
	 */
	async runPrompt(prompt: string, label: string): Promise<string> {
		this._onStatus?.(label);
		this._onLoader?.(true, label);

		// Ensure the RPC agent is running (idempotent)
		this.rpcAgent.start();
		await this.rpcAgent.newSession();

		let previewBuf = "";
		let lastStatusUpdate = 0;
		const output = await this.rpcAgent.prompt(prompt, (delta) => {
			previewBuf += delta;
			const now = Date.now();
			if (now - lastStatusUpdate > 300) {
				lastStatusUpdate = now;
				const preview = previewBuf.trimEnd().slice(-80).replace(/\n/g, " ");
				this._onStatus?.(`${label}  ➜ ${preview}`);
			}
		});

		return output;
	}

	/** Show/hide the loader indicator with a status message. */
	setLoader(show: boolean, msg: string): void {
		this._onLoader?.(show, msg);
	}

	/** Abort the current RPC agent operation. */
	abort(): void {
		this.rpcAgent.abort();
	}
}

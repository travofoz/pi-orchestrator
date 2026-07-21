/**
 * Bake — manages the phase execution loop.
 *
 * Coordinates: phase loading → XState BakeMachine (event-driven DAG scheduler)
 *
 * The BakeMachine handles all orchestration internally via spawnChild / sendParent.
 * This class is a thin shell: it loads phases, creates the actor, sends events
 * from commands, and syncs state for the UI widget.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { EventLog } from "./event-log.ts";
import { RpcAgent } from "./rpc-agent.ts";
import type { AuditFinding } from "./auditor.ts";
import {
	startBakePipeline,
	type BakeEnv,
	type PhaseResult,
	type BakeMachineActor,
	type BakeContextSnapshot,
} from "./bake-machine.ts";

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

	/** Reference to the running BakeMachine actor (null when idle). */
	private bakeActor: BakeMachineActor | null = null;

	/**
	 * PhaseId of the phase currently waiting for context (from latest snapshot).
	 * Used by provideContext() to target the right child.
	 */
	private waitingPhaseId: string | null = null;

	constructor(baseDir: string, workspaceDir: string, rulesDir: string) {
		this.bakeDir = path.join(baseDir, ".bake");
		this.workspaceDir = workspaceDir;
		this.rulesDir = rulesDir;
		this.phasesDir = path.join(this.bakeDir, "phases");
		this.completedDir = path.join(this.bakeDir, "completed");
		this.stateFile = path.join(this.bakeDir, "state.json");
		this.log = new EventLog(this.bakeDir);

		// Ensure dirs exist
		for (const dir of [
			this.bakeDir,
			this.completedDir,
			this.workspaceDir,
		]) {
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

		this.bakeActor = null;
		this.resetState();
	}

	/** Reset state to clean idle. */
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
				if (!parsed.activePhases) parsed.activePhases = [];
				return parsed;
			} catch {
				// Corrupted state — start fresh
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

	/** Load enabled rules from rules-state.json. */
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

				return {
					name,
					filePath,
					content,
					phaseId,
					dependsOn,
					planSteps,
				};
			});
	}

	// ─── Commands (send events to BakeMachine) ────────────────────────

	/** Steer: inject guidance into the next executor run. */
	steer(message: string): void {
		this.state.pendingSteer = message;
		this.emitState();
		this.bakeActor?.send({ type: "STEER", message });
		this.log.append("steer", { message });
	}

	/** Pause the pipeline after the current attempt. */
	pause(): void {
		this.state.status = "paused";
		this.emitState();
		this.bakeActor?.send({ type: "ABORT" });
		this.log.append("pause", {});
	}

	/** Resume from pause — restart the pipeline. */
	async resume(): Promise<void> {
		if (this.state.status === "paused") {
			this.state.status = "running";
			this.emitState();
			this.log.append("resume", {});
			await this.runPipeline();
		}
	}

	/** Skip a phase by name, or the current phase if no name given. */
	skipPhase(phaseName?: string): void {
		const target = phaseName || this.state.currentPhase;
		if (!target) return;

		// Resolve name → phaseId
		const phases = this.getPendingPhases();
		const spec = phases.find((p) => p.name === target);
		if (!spec) {
			this.log.append("skip_phase_not_found", { name: target });
			return;
		}

		if (!this.state.skippedPhases.includes(target)) {
			this.state.skippedPhases.push(target);
		}
		this.state.currentPhase = null;
		this.state.currentAttempt = 0;
		this.emitState();

		this.bakeActor?.send({ type: "SKIP_PHASE", phaseId: spec.phaseId });
		this.log.append("skip_phase", { phase: target, phaseId: spec.phaseId });
	}

	/** Provide context to unblock a phase waiting for information. */
	provideContext(info: string): boolean {
		if (this.waitingPhaseId && this.bakeActor) {
			this.bakeActor.send({
				type: "PROVIDE_CONTEXT",
				phaseId: this.waitingPhaseId,
				info,
			});
			this.log.append("context_provided", {
				phase: this.waitingPhaseId,
			});
			this.waitingPhaseId = null;
			return true;
		}
		return false;
	}

	/**
	 * Retry the current or named phase.
	 *
	 * Sends RETRY_PHASE to the BakeMachine, which cascades:
	 * the phase and all its transitive dependents are removed from
	 * completed and re-spawned.
	 */
	retryAttempt(phaseName?: string): void {
		const target = phaseName || this.state.currentPhase;
		if (!target) {
			this.log.append("retry_attempt_noop", { reason: "no active phase" });
			return;
		}

		const phases = this.getPendingPhases();
		const spec = phases.find((p) => p.name === target);
		if (!spec) {
			this.log.append("retry_attempt_noop", {
				phase: target,
				reason: "phase not found",
			});
			return;
		}

		this.state.currentAttempt = 0;
		this.emitState();
		this.bakeActor?.send({ type: "RETRY_PHASE", phaseId: spec.phaseId });
		this.log.append("retry_attempt", {
			phase: target,
			phaseId: spec.phaseId,
		});
	}

	// ─── Pipeline execution ──────────────────────────────────────────

	/**
	 * Run the full pipeline: create the BakeMachine actor, start it,
	 * and wait for it to finish.
	 *
	 * The actor subscribes to snapshot changes to update BakeState for UI.
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

		// Build the env object (all deps the PhaseMachine actors need via closure)
		const env: BakeEnv = {
			workspaceDir: this.workspaceDir,
			rulesDir: this.rulesDir,
			completedDir: this.completedDir,
			rpcAgent: this.rpcAgent,
			getEnabledRules: () => this.getEnabledRules(),
			onStatus: (msg) => this._onStatus?.(msg),
			onLoader: (show, msg) => this._onLoader?.(show, msg),
			log: this.log,
		};

		try {
			const { actor, done } = startBakePipeline(
				phases,
				env,
				this.state.maxAttempts,
			);
			this.bakeActor = actor;

			// Subscribe to snapshot changes for UI state sync
			actor.subscribe({
				next: (snapshot: any) => this.syncState(snapshot),
				error: (err: unknown) => {
					this.log.append("pipeline_crash", { error: String(err) });
				},
			});

			// Wait for pipeline to reach a final state
			const output = await done;

			// Map results to BakeState
			this.state.completedPhases = [];
			this.state.activePhases = [];
			for (const phase of phases) {
				const r = output.results[phase.phaseId];
				if (r?.passed === true) {
					this.state.completedPhases.push(phase.name);
				}
			}
			this.state.status = this.state.status === "paused"
				? "paused"
				: output.passed
				? "done"
				: "failed";
			this.log.append(
				output.passed ? "pipeline_complete" : "pipeline_halted",
				{},
			);
		} finally {
			this.bakeActor = null;
			this.emitState();
			this.log.close();
			this.rpcAgent.close();
		}
	}

	/**
	 * Sync BakeState from the BakeMachine's latest snapshot.
	 * Called on every actor state change via subscribe.
	 */
	private syncState(snapshot: {
		context: BakeContextSnapshot;
		status: string;
		output?: { passed: boolean; results: Record<string, PhaseResult> };
	}): void {
		const ctx = snapshot.context;

		// Build a lookup from phaseId → PhaseSpec (available from the last loaded phases)
		// We rebuild this each time; in practice it's a tiny array.
		const phases = this.getPendingPhases();
		const idToSpec = new Map(phases.map((p) => [p.phaseId, p]));

		this.state.completedPhases = Object.entries(ctx.completed)
			.filter(([, r]) => r.passed === true)
			.map(([id]) => idToSpec.get(id)?.name ?? id);

		this.state.skippedPhases = ctx.skipped.map(
			(id) => idToSpec.get(id)?.name ?? id,
		);

		this.state.activePhases = ctx.activePhaseIds.map(
			(id) => idToSpec.get(id)?.name ?? id,
		);

		this.state.currentPhase =
			ctx.activePhaseIds.length === 1
				? idToSpec.get(ctx.activePhaseIds[0])?.name ?? null
				: null;

		this.state.currentAttempt = 0;

		// Track which phase is waiting for context
		this.waitingPhaseId = ctx.waitingPhaseId;

		// Keep paused status if we aborted
		if (this.state.status !== "paused") {
			this.state.status =
				snapshot.status === "done"
					? snapshot.output?.passed
						? "done"
						: "failed"
					: "running";
		}

		this._onStateChange?.(this.state);
	}

	// ─── One-shot prompt ─────────────────────────────────────────────

	/**
	 * Run a one-shot prompt through the shared RPC agent.
	 * Uses a fresh session per call, wires status/loader/delta callbacks.
	 * Throws on failure — caller handles error reporting.
	 */
	async runPrompt(prompt: string, label: string): Promise<string> {
		this._onStatus?.(label);
		this._onLoader?.(true, label);

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

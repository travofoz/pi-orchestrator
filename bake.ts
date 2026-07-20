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
import {
	runStructuralAudit,
	type AuditFinding,
} from "./auditor.ts";
import { runExecutor, type ExecutorDeps } from "./bake-executor.ts";
import { runSemanticAudit, runRemediation } from "./bake-audit.ts";

export interface PhaseSpec {
	name: string;
	filePath: string;
	content: string;
	/** Unique ID from phase file metadata or dag.json, falls back to name */
	phaseId: string;
	/** Phase IDs this phase depends on (empty = no deps, runnable immediately) */
	dependsOn: string[];
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
		fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), "utf-8");
	}

	/**
	 * Full cleanup: abort running operations, wipe workspace, completed dir,
	 * event log, archive, spec-context, and reset state to idle.
	 * Keeps phases/ intact.
	 */
	clean(): void {
		this.abort();
		try { this.rpcAgent.close(); } catch { /* ignore */ }
		try { this.log.close(); } catch { /* ignore */ }

		// Nuke and recreate workspace
		try { fs.rmSync(this.workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
		try { fs.mkdirSync(this.workspaceDir, { recursive: true }); } catch { /* ignore */ }

		// Nuke completed dir
		try { fs.rmSync(this.completedDir, { recursive: true, force: true }); } catch { /* ignore */ }
		try { fs.mkdirSync(this.completedDir, { recursive: true }); } catch { /* ignore */ }

		// Nuke event log
		try { fs.rmSync(path.join(this.bakeDir, "events.jsonl"), { force: true }); } catch { /* ignore */ }

		// Nuke archive and spec-context (decomposed specs from prior runs)
		try { fs.rmSync(path.join(this.bakeDir, "archive"), { recursive: true, force: true }); } catch { /* ignore */ }
		try { fs.rmSync(path.join(this.bakeDir, "spec-context.md"), { force: true }); } catch { /* ignore */ }

		// Nuke phases dir — reset means reset
		try { fs.rmSync(this.phasesDir, { recursive: true, force: true }); } catch { /* ignore */ }
		try { fs.mkdirSync(this.phasesDir, { recursive: true }); } catch { /* ignore */ }

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
					const depsMatch = content.match(/^## Depends On\n([^\n]+)/m);
					if (depsMatch) {
						dependsOn = depsMatch[1]
							.split(",")
							.map((s) => s.trim())
							.filter((s) => s !== "(none)" && s.length > 0);
					}
				}

				return { name, filePath, content, phaseId, dependsOn };
			});
	}

	/**
	 * Compute the next batch of phases whose dependencies are all satisfied.
	 * Returns phases in a deterministic order.
	 */
	private getReadyPhases(
		phases: PhaseSpec[],
		completed: Set<string>,
		skipped: Set<string>,
	): PhaseSpec[] {
		const ready: PhaseSpec[] = [];
		for (const p of phases) {
			if (completed.has(p.phaseId) || skipped.has(p.phaseId)) continue;
			const depsMet = p.dependsOn.every(
				(d) => completed.has(d) || skipped.has(d),
			);
			if (depsMet) ready.push(p);
		}
		return ready;
	}

	/** Build the ExecutorDeps object from current Bake state. */
	private executorDeps(): ExecutorDeps {
		return {
			workspaceDir: this.workspaceDir,
			rpcAgent: this.rpcAgent,
			log: this.log,
			onStatus: (msg) => this._onStatus?.(msg),
			onLoader: (show, msg) => this._onLoader?.(show, msg),
		};
	}

	/** Steer: inject guidance into the next executor run. */
	steer(message: string): void {
		this.state.pendingSteer = message;
		this.emitState();
		this.log.append("steer", { message });
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
		this.emitState();
	}

	/** Retry the current attempt (re-run executor). */
	retryAttempt(): void {
		// Cancel any in-flight operation so a completing executor doesn't race past the retry
		this.rpcAgent.abort();

		this.log.append("retry_attempt", {
			phase: this.state.currentPhase,
			attempt: this.state.currentAttempt,
		});
		// Don't increment attempt — re-run same attempt
	}

	/**
	 * Run the full pipeline: process all pending phases.
	 * This is the main entry point for the bake pipeline.
	 */
	async runPipeline(): Promise<void> {
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
			const completed = new Set(this.state.completedPhases);
			const skipped = new Set(this.state.skippedPhases);

			// DAG scheduler: run ready phases concurrently in batches
			while (completed.size + skipped.size < phases.length) {
				// Check pause before each batch
				if (this.state.status === "paused") {
					this.log.append("pipeline_paused", {});
					return;
				}

				const ready = this.getReadyPhases(phases, completed, skipped);
				if (ready.length === 0) {
					// No ready phases but still pending = deadlock
					this.state.status = "failed";
					this.emitState();
					this.log.append("pipeline_deadlock", {});
					return;
				}

				// Update state for UI
				this.state.activePhases = ready.map((p) => p.name);
				this.state.currentPhase = ready.length === 1 ? ready[0].name : null;
				this.state.status = "running";
				this.emitState();
				this._onStatus?.(`Active: ${ready.map((p) => p.name).join(", ")}`);

				this.log.append("batch_start", {
					phases: ready.map((p) => p.phaseId),
					count: ready.length,
				});

				// Run all ready phases concurrently
				const results = await Promise.allSettled(
					ready.map((p) => this.runPhaseIsolated(p)),
				);

				let anyFailed = false;
				for (let i = 0; i < results.length; i++) {
					const r = results[i];
					const p = ready[i];

					if (r.status === "rejected") {
						anyFailed = true;
						this.log.append("phase_crashed", {
							phase: p.phaseId,
							error: String(r.reason),
						});
						continue;
					}

					const result = r.value;
					if (result.passed === "paused") {
						this.log.append("pipeline_paused", { phase: p.phaseId });
						return;
					}
					if (result.passed === true) {
						completed.add(p.phaseId);
						this.state.completedPhases.push(p.name);
						this.log.append("phase_pass", { phase: p.phaseId });
						this.archivePhaseFile(p);
					} else {
						anyFailed = true;
						this.log.append("phase_failed", {
							phase: p.phaseId,
							attempts: result.attempts,
						});
					}
				}

				if (anyFailed) {
					this.state.status = "failed";
					this.state.activePhases = [];
					this.emitState();
					this.log.append("pipeline_halted", { reason: "circuit_breaker" });
					return;
				}
			}

			this.state.status = "done";
			this.state.activePhases = [];
			this.emitState();
			this.log.append("pipeline_complete", {});
		} finally {
			this.state.activePhases = [];
			this.emitState();
			this.log.close();
			this.rpcAgent.close();
		}
	}

	/**
	 * Run a single phase with isolated state — no writes to this.state.
	 * Audits run in parallel via Promise.all.
	 */
	private async runPhaseIsolated(phase: PhaseSpec): Promise<PhaseResult> {
		this.log.append("phase_start", { phase: phase.phaseId });
		this._onStatus?.(`Phase: ${phase.name}`);

		const allFindings: AuditFinding[] = [];
		const deps = this.executorDeps();
		let attempt = 0;

		while (attempt < this.state.maxAttempts) {
			// Check for pause
			if (this.state.status === "paused") {
				this.log.append("phase_paused", {
					phase: phase.phaseId,
					attempt,
				});
				return {
					phase: phase.name,
					passed: "paused",
					attempts: attempt,
					findings: allFindings,
				};
			}

			this.log.append("attempt_start", {
				phase: phase.phaseId,
				attempt,
			});

			// --- EXECUTOR ---
			const executorPassed = await runExecutor(
				phase,
				attempt,
				this.state.pendingSteer,
				deps,
			);
			if (!executorPassed) {
				attempt++;
				this.log.append("attempt_executor_failed", {
					phase: phase.phaseId,
					attempt,
				});
				continue;
			}

			// --- PARALLEL AUDITS (structural + semantic concurrent) ---
			this._onStatus?.(`Auditing: ${phase.name}`);
			this.log.append("audit_parallel_start", { phase: phase.phaseId });

			const [structuralFindings, semanticFindings] = await Promise.all([
				runStructuralAudit(
					this.workspaceDir,
					this.rulesDir,
					this.getEnabledRules(),
				),
				runSemanticAudit({
					workspaceDir: this.workspaceDir,
					rpcAgent: this.rpcAgent,
					onStatus: (msg) => this._onStatus?.(msg),
					onLoader: (show, msg) => this._onLoader?.(show, msg),
					log: this.log,
				}),
			]);

			const combinedFindings = [
				...structuralFindings,
				...semanticFindings,
			];

			if (combinedFindings.length > 0) {
				allFindings.push(...combinedFindings);
				this.log.append("audit_parallel_fail", {
					phase: phase.phaseId,
					structural: structuralFindings.length,
					semantic: semanticFindings.length,
				});

				const remediated = await runRemediation(
					phase,
					allFindings,
					attempt,
					this.state.maxAttempts,
					deps,
				);
				if (!remediated) {
					return {
						phase: phase.name,
						passed: false,
						attempts: attempt + 1,
						findings: allFindings,
					};
				}
				attempt++;
				continue;
			}

			// --- PASS ---
			this.log.append("audit_parallel_pass", { phase: phase.phaseId });
			return { phase: phase.name, passed: true, attempts: attempt, findings: [] };
		}

		// Hit max attempts
		this.log.append("circuit_breaker", {
			phase: phase.phaseId,
			attempts: attempt,
			findings: allFindings.length,
		});
		return { phase: phase.name, passed: false, attempts: attempt, findings: allFindings };
	}

	/**
	 * Archive a passed phase file to the completed directory.
	 */
	private archivePhaseFile(phase: PhaseSpec): void {
		const destPath = path.join(this.completedDir, `${phase.phaseId}_PASS.md`);
		try {
			fs.copyFileSync(phase.filePath, destPath);
			fs.unlinkSync(phase.filePath);
		} catch {
			/* file may already be archived */
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

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
}

export interface BakeState {
	currentPhase: string | null;
	currentAttempt: number;
	maxAttempts: number;
	status: "idle" | "running" | "paused" | "done" | "failed";
	completedPhases: string[];
	skippedPhases: string[];
	pendingSteer: string | null;
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
		};
		this.emitState();
	}

	private loadState(): BakeState {
		if (fs.existsSync(this.stateFile)) {
			try {
				const raw = fs.readFileSync(this.stateFile, "utf-8");
				return JSON.parse(raw) as BakeState;
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

	private getPendingPhases(): PhaseSpec[] {
		if (!fs.existsSync(this.phasesDir)) return [];
		return fs
			.readdirSync(this.phasesDir)
			.filter((f) => f.endsWith(".md"))
			.sort()
			.map((file) => {
				const filePath = path.join(this.phasesDir, file);
				return {
					name: file.replace(/\.md$/, ""),
					filePath,
					content: fs.readFileSync(filePath, "utf-8"),
				};
			});
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
			for (const phase of phases) {
				// Skip already-completed phases
				if (this.state.completedPhases.includes(phase.name)) continue;
				if (this.state.skippedPhases.includes(phase.name)) continue;

				const result = await this.runPhase(phase);
				if (result.passed === "paused") {
					// User paused — exit pipeline cleanly, don't mark as failed
					this.log.append("pipeline_paused", { phase: phase.name });
					// Don't close agent or log — resume() will restart
					return;
				}
				if (!result.passed) {
					this.state.status = "failed";
					this.emitState();
					this.log.append("pipeline_halted", {
						phase: phase.name,
						reason: "circuit_breaker",
					});
					this.log.close();
					this.rpcAgent.close();
					return;
				}
			}

			this.state.status = "done";
			this.emitState();
			this.log.append("pipeline_complete", {});
		} finally {
			this.log.close();
			this.rpcAgent.close();
		}
	}

	/**
	 * Run a single phase through executor → audit → remediation loop.
	 */
	private async runPhase(phase: PhaseSpec): Promise<PhaseResult> {
		this.state.currentPhase = phase.name;
		this.state.currentAttempt = 0;
		this.state.status = "running";
		this.emitState();
		this.log.append("phase_start", { phase: phase.name });
		this._onStatus?.(`Phase: ${phase.name}`);

		const allFindings: AuditFinding[] = [];
		const deps = this.executorDeps();

		while (this.state.currentAttempt < this.state.maxAttempts) {
			// Check for pause
			if (this.state.status === "paused") {
				this.log.append("phase_paused", {
					phase: phase.name,
					attempt: this.state.currentAttempt,
				});
				return {
					phase: phase.name,
					passed: "paused",
					attempts: this.state.currentAttempt,
					findings: allFindings,
				};
			}

			this.log.append("attempt_start", {
				phase: phase.name,
				attempt: this.state.currentAttempt,
			});

			// --- EXECUTOR ---
			const executorPassed = await runExecutor(
				phase,
				this.state.currentAttempt,
				this.state.pendingSteer,
				deps,
			);
			if (!executorPassed) {
				this.state.currentAttempt++;
				this.emitState();
				this.log.append("attempt_executor_failed", {
					phase: phase.name,
					attempt: this.state.currentAttempt,
				});
				continue;
			}

			// --- STRUCTURAL AUDIT (ast-grep) ---
			this.log.append("audit_structural_start", { phase: phase.name });
			this._onStatus?.(`Audit (structural): ${phase.name}`);
			const structuralFindings = await runStructuralAudit(
				this.workspaceDir,
				this.rulesDir,
				this.getEnabledRules(),
			);

			if (structuralFindings.length > 0) {
				allFindings.push(...structuralFindings);
				this.log.append("audit_structural_fail", {
					phase: phase.name,
					findings: structuralFindings.length,
				});
				// Fast-fail to remediation — no need for semantic audit
				const remediated = await runRemediation(
					phase,
					allFindings,
					this.state.currentAttempt,
					this.state.maxAttempts,
					deps,
				);
				if (!remediated) {
					return {
						phase: phase.name,
						passed: false,
						attempts: this.state.currentAttempt + 1,
						findings: allFindings,
					};
				}
				this.state.currentAttempt++;
				this.emitState();
				continue;
			}

			this.log.append("audit_structural_pass", { phase: phase.name });

			// --- SEMANTIC AUDIT (LLM) ---
			this.log.append("audit_semantic_start", { phase: phase.name });
			const semanticFindings = await runSemanticAudit({
				workspaceDir: this.workspaceDir,
				rpcAgent: this.rpcAgent,
				onStatus: (msg) => this._onStatus?.(msg),
				onLoader: (show, msg) => this._onLoader?.(show, msg),
				log: this.log,
			});

			if (semanticFindings.length > 0) {
				allFindings.push(...semanticFindings);
				this.log.append("audit_semantic_fail", {
					phase: phase.name,
					findings: semanticFindings.length,
				});
				const remediated = await runRemediation(
					phase,
					allFindings,
					this.state.currentAttempt,
					this.state.maxAttempts,
					deps,
				);
				if (!remediated) {
					return {
						phase: phase.name,
						passed: false,
						attempts: this.state.currentAttempt + 1,
						findings: allFindings,
					};
				}
				this.state.currentAttempt++;
				this.emitState();
				continue;
			}

			// --- PASS ---
			this.log.append("audit_semantic_pass", { phase: phase.name });
			this.state.completedPhases.push(phase.name);
			const finalAttempt = this.state.currentAttempt;
			this.state.currentPhase = null;
			this.state.currentAttempt = 0;
			this.state.pendingSteer = null;
			this.emitState();
			this.log.append("phase_pass", { phase: phase.name });

			// Archive the phase file
			const destPath = path.join(this.completedDir, `${phase.name}_PASS.md`);
			fs.copyFileSync(phase.filePath, destPath);
			fs.unlinkSync(phase.filePath);

			return { phase: phase.name, passed: true, attempts: finalAttempt, findings: [] };
		}

		// Hit max attempts
		this.log.append("circuit_breaker", {
			phase: phase.name,
			attempts: this.state.currentAttempt,
			findings: allFindings.length,
		});
		return { phase: phase.name, passed: false, attempts: this.state.currentAttempt, findings: allFindings };
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

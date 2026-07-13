/**
 * Orchestrator core — manages the phase execution loop.
 *
 * Coordinates: phase loading → executor → auditor → remediation → repeat/circuit-breaker.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { EventLog } from "./event-log.ts";
import {
	runStructuralAudit,
	buildSemanticAuditPrompt,
	parseSemanticAuditOutput,
	type AuditFinding,
} from "./auditor.ts";

export interface PhaseSpec {
	name: string;
	filePath: string;
	content: string;
}

export interface OrchestratorState {
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
	passed: boolean;
	attempts: number;
	findings: AuditFinding[];
}

export class Orchestrator {
	private orchestratorDir: string;
	private workspaceDir: string;
	private phasesDir: string;
	private completedDir: string;
	private stateFile: string;
	private log: EventLog;
	private state: OrchestratorState;
	private _onStateChange?: (state: OrchestratorState) => void;

	constructor(baseDir: string, workspaceDir: string) {
		this.orchestratorDir = path.join(baseDir, ".orchestrator");
		this.workspaceDir = workspaceDir;
		this.phasesDir = path.join(baseDir, "phases");
		this.completedDir = path.join(this.orchestratorDir, "completed");
		this.stateFile = path.join(this.orchestratorDir, "state.json");
		this.log = new EventLog(this.orchestratorDir);

		// Ensure dirs exist
		for (const dir of [this.orchestratorDir, this.completedDir, this.phasesDir, this.workspaceDir]) {
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		}

		this.state = this.loadState();
	}

	get stateSnapshot(): Readonly<OrchestratorState> {
		return { ...this.state };
	}

	get eventLog(): EventLog {
		return this.log;
	}

	onStateChange(cb: (state: OrchestratorState) => void): void {
		this._onStateChange = cb;
	}

	private saveState(): void {
		fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), "utf-8");
	}

	private loadState(): OrchestratorState {
		if (fs.existsSync(this.stateFile)) {
			try {
				const raw = fs.readFileSync(this.stateFile, "utf-8");
				return JSON.parse(raw) as OrchestratorState;
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

	/** Resume from pause. */
	resume(): void {
		if (this.state.status === "paused") {
			this.state.status = "running";
			this.emitState();
			this.log.append("resume", {});
		}
	}

	/** Skip the current phase and move to the next. */
	skipPhase(): void {
		if (this.state.currentPhase) {
			this.state.skippedPhases.push(this.state.currentPhase);
			this.log.append("skip_phase", { phase: this.state.currentPhase });
		}
		this.state.currentPhase = null;
		this.state.currentAttempt = 0;
		this.state.pendingSteer = null;
		this.emitState();
	}

	/** Retry the current attempt (re-run executor). */
	retryAttempt(): void {
		this.log.append("retry_attempt", {
			phase: this.state.currentPhase,
			attempt: this.state.currentAttempt,
		});
		// Don't increment attempt — re-run same attempt
	}

	/**
	 * Run the full pipeline: process all pending phases.
	 * This is the main entry point for the orchestrator.
	 */
	async runPipeline(): Promise<void> {
		this.log.open();
		this.log.append("pipeline_start", {});

		const phases = this.getPendingPhases();
		if (phases.length === 0) {
			this.state.status = "done";
			this.emitState();
			this.log.append("pipeline_empty", {});
			this.log.close();
			return;
		}

		for (const phase of phases) {
			// Skip already-completed phases
			if (this.state.completedPhases.includes(phase.name)) continue;
			if (this.state.skippedPhases.includes(phase.name)) continue;

			const result = await this.runPhase(phase);
			if (!result.passed) {
				this.state.status = "failed";
				this.emitState();
				this.log.append("pipeline_halted", {
					phase: phase.name,
					reason: "circuit_breaker",
				});
				this.log.close();
				return;
			}
		}

		this.state.status = "done";
		this.emitState();
		this.log.append("pipeline_complete", {});
		this.log.close();
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

		const allFindings: AuditFinding[] = [];

		while (this.state.currentAttempt < this.state.maxAttempts) {
			// Check for pause
			if (this.state.status === "paused") {
				this.log.append("phase_paused", { phase: phase.name, attempt: this.state.currentAttempt });
				// In a real extension, we'd await a resume signal here
				// For now, we break out and let the caller check state
				break;
			}

			this.log.append("attempt_start", {
				phase: phase.name,
				attempt: this.state.currentAttempt,
			});

			// --- EXECUTOR ---
			const executorPassed = await this.runExecutor(phase);
			if (!executorPassed) {
				// Executor failed (pi crash, timeout, etc.)
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
			const structuralFindings = runStructuralAudit(this.workspaceDir);

			if (structuralFindings.length > 0) {
				allFindings.push(...structuralFindings);
				this.log.append("audit_structural_fail", {
					phase: phase.name,
					findings: structuralFindings.length,
				});
				// Fast-fail to remediation — no need for semantic audit
				const remediated = await this.runRemediation(phase, allFindings);
				if (!remediated) {
					return { phase: phase.name, passed: false, attempts: this.state.currentAttempt + 1, findings: allFindings };
				}
				this.state.currentAttempt++;
				this.emitState();
				continue;
			}

			this.log.append("audit_structural_pass", { phase: phase.name });

			// --- SEMANTIC AUDIT (LLM) ---
			this.log.append("audit_semantic_start", { phase: phase.name });
			const semanticFindings = await this.runSemanticAudit();

			if (semanticFindings.length > 0) {
				allFindings.push(...semanticFindings);
				this.log.append("audit_semantic_fail", {
					phase: phase.name,
					findings: semanticFindings.length,
				});
				const remediated = await this.runRemediation(phase, allFindings);
				if (!remediated) {
					return { phase: phase.name, passed: false, attempts: this.state.currentAttempt + 1, findings: allFindings };
				}
				this.state.currentAttempt++;
				this.emitState();
				continue;
			}

			// --- PASS ---
			this.log.append("audit_semantic_pass", { phase: phase.name });
			this.state.completedPhases.push(phase.name);
			this.state.currentPhase = null;
			this.state.currentAttempt = 0;
			this.state.pendingSteer = null;
			this.emitState();
			this.log.append("phase_pass", { phase: phase.name });

			// Archive the phase file
			const destPath = path.join(this.completedDir, `${phase.name}_PASS.md`);
			fs.copyFileSync(phase.filePath, destPath);
			fs.unlinkSync(phase.filePath);

			return { phase: phase.name, passed: true, attempts: this.state.currentAttempt, findings: [] };
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
	 * Run the executor: invoke pi with the phase spec + remediation history + optional steer.
	 */
	private async runExecutor(phase: PhaseSpec): Promise<boolean> {
		const steerNote = this.state.pendingSteer
			? `\n\n## Steering Guidance (from operator)\n\n${this.state.pendingSteer}`
			: "";

		const attemptNote =
			this.state.currentAttempt > 0
				? `\n\n## Remediation Attempt ${this.state.currentAttempt}\n\nThis is a remediation cycle. Fix the issues identified in previous audits. Read the audit findings and address each one specifically.`
				: "";

		const prompt = `Execute the instructions in this specification file for the project at ${this.workspaceDir}. Work through the task checklist. After each task, commit with git. When complete, verify with the project's build/lint/test commands.\n\n${phase.content}${attemptNote}${steerNote}`;

		try {
			const result = spawnSync("pi", ["-p", prompt], {
				cwd: this.workspaceDir,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 2 * 60 * 60 * 1000, // 2hr
				maxBuffer: 1024 * 1024 * 100,
			});

			if (result.error) {
				this.log.append("executor_error", { error: result.error.message });
				return false;
			}

			this.log.append("executor_complete", {
				exitCode: result.status,
				outputLength: result.stdout?.length || 0,
			});

			return result.status === 0;
		} catch (err: any) {
			this.log.append("executor_crash", { error: err.message });
			return false;
		}
	}

	/**
	 * Run the semantic audit: spawn a pi sub-agent with the structured checklist.
	 */
	private async runSemanticAudit(): Promise<AuditFinding[]> {
		const prompt = buildSemanticAuditPrompt(this.workspaceDir);

		try {
			const result = spawnSync("pi", ["-p", prompt], {
				cwd: this.workspaceDir,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 5 * 60 * 1000, // 5min
				maxBuffer: 1024 * 1024 * 10,
			});

			if (result.status !== 0) {
				this.log.append("semantic_audit_error", { exitCode: result.status });
				return [];
			}

			const auditResult = parseSemanticAuditOutput(result.stdout || "");
			return auditResult.findings;
		} catch (err: any) {
			this.log.append("semantic_audit_crash", { error: err.message });
			return [];
		}
	}

	/**
	 * Generate and run a remediation cycle.
	 * Returns true if remediation was applied (loop should continue), false if circuit breaker.
	 */
	private async runRemediation(phase: PhaseSpec, findings: AuditFinding[]): Promise<boolean> {
		this.log.append("remediation_start", {
			phase: phase.name,
			attempt: this.state.currentAttempt,
			findings: findings.length,
		});

		// Build remediation spec from findings
		const findingItems = findings
			.map((f, i) => {
				const prefix = f.source === "ast-grep" ? "[ast-grep]" : "[audit]";
				return `${i + 1}. ${prefix} ${f.detail}`;
			})
			.join("\n");

		const remediationSpec = `# Remediation ${this.state.currentAttempt + 1}: ${phase.name}\n\n## Tasks\n\n${findingItems}\n\nFix each of the above issues. After fixing, run the build to verify.`;

		// Run executor with remediation focus
		const executorPrompt = `The following issues were found in the project at ${this.workspaceDir}. Fix each one specifically.\n\n${remediationSpec}\n\nAfter fixing each issue, commit with a descriptive message. Run build/lint/test to verify.`;

		try {
			const result = spawnSync("pi", ["-p", executorPrompt], {
				cwd: this.workspaceDir,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 2 * 60 * 60 * 1000,
				maxBuffer: 1024 * 1024 * 100,
			});

			const succeeded = result.status === 0;
			this.log.append("remediation_complete", {
				attempt: this.state.currentAttempt,
				succeeded,
			});

			// Check if we've exceeded max attempts
			if (this.state.currentAttempt + 1 >= this.state.maxAttempts) {
				this.log.append("circuit_breaker_reached", {
					phase: phase.name,
					attempts: this.state.currentAttempt + 1,
				});
				return false;
			}

			return succeeded;
		} catch (err: any) {
			this.log.append("remediation_crash", { error: err.message });
			return false;
		}
	}
}

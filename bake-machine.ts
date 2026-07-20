/**
 * bake-machine — XState v5 statechart for the bake pipeline.
 *
 * Replaces the sequential for-loop in Bake.runPipeline() with a
 * state machine supporting:
 *   • DAG-based phase scheduling (parallel independent phases)
 *   • Parallel audit fan-out (ast-grep + LLM concurrent)
 *   • Hierarchical phase lifecycle (nested states per phase)
 *   • Explicit transitions with persistence / crash recovery
 *
 * ─── How it integrates ────────────────────────────────────────────
 *   Bake owns an interpreted machine (interpret(machine).start()).
 *   Phase execution still calls the same runExecutor, runStructuralAudit,
 *   runSemanticAudit, runRemediation functions via fromPromise actors.
 *   The decomposition prompt now emits depends_on[] to build the DAG.
 *
 * ─── State hierarchy ──────────────────────────────────────────────
 *
 *   IDLE ──START──▶ COMPOSING ──DAG_READY──▶ RUNNING ──ALL_DONE──▶ DONE
 *                     │                        │                     │
 *                     │ (decompose spec        │ (spawns phase       │
 *                     │  into DAG phases)      │  actors per ready   │
 *                     │                        │  batch, waits for   │
 *                     ▼                        │  all to finish)     │
 *                   FAILED                     ▼                    ▼
 *                                        ┌──────────────┐       FAILED
 *                                        │  PHASE_ACTOR  │
 *                                        │  (spawned)    │
 *                                        │              │
 *                                        │  EXECUTING   │
 *                                        │    │         │
 *                                        │    ▼         │
 *                                        │ ┌───────┐   │
 *                                        │ │AUDIT  │   │  ← parallel
 *                                        │ │• str  │   │    fan-out
 *                                        │ │• sem  │   │
 *                                        │ └──┬────┘   │
 *                                        │  fail│pass  │
 *                                        │    ▼  ▼     │
 *                                        │ REMEDIATING │
 *                                        │ COMPLETED   │
 *                                        └──────────────┘
 */

import { setup, createMachine, fromPromise, type ActorRefFrom } from "xstate";
import type { PhaseSpec, AuditFinding } from "./bake.ts";
import type { EventLog } from "./event-log.ts";
import type { RpcAgent } from "./rpc-agent.ts";
import { runExecutor, type ExecutorDeps } from "./bake-executor.ts";
import { runStructuralAudit } from "./auditor.ts";
import { runSemanticAudit, runRemediation } from "./bake-audit.ts";

// ─── DAG Phase Model ────────────────────────────────────────────────

/**
 * A phase node in the DAG. Adds depends_on for parallel scheduling.
 * The decomposition prompt emits this shape instead of bare phases.
 */
export interface DagPhase {
	id: string;           // unique, e.g. "02_wifi_state_machine"
	name: string;         // display name
	summary: string;
	done_when: string;
	depends_on: string[]; // phase ids that must complete first
}

export interface Decomposition {
	phases: DagPhase[];
	context: string;
}

// ─── Machine Types ───────────────────────────────────────────────────

/** The full context stored in the parent machine. */
export interface BakeMachineContext {
	phases: DagPhase[];
	phaseSpecs: Map<string, PhaseSpec>;
	completed: Set<string>;
	skipped: Set<string>;
	results: Map<string, PhaseResult>;
	eventLog: EventLog | null;
	failedPhase: string | null;

	// DAG scheduling
	readyQueue: string[];     // phases whose deps are all met, waiting to start
	runningCount: number;     // how many phase actors are currently spawned

	// Pause / steer
	pendingSteer: string | null;
	paused: boolean;
}

export interface PhaseResult {
	passed: boolean | "paused";
	attempts: number;
	findings: AuditFinding[];
}

// ─── Events ──────────────────────────────────────────────────────────

export type BakeEvent =
	| { type: "START" }
	| { type: "PAUSE" }
	| { type: "RESUME" }
	| { type: "STEER"; message: string }
	| { type: "SKIP_PHASE"; phaseId: string }
	| { type: "RETRY" }
	| { type: "PHASE_COMPLETE"; phaseId: string; result: PhaseResult }
	| { type: "DAG_READY"; phases: DagPhase[] }
	| { type: "SCHEDULE_NEXT" }; // internal: check dag after a phase finishes

export type PhaseEvent =
	| { type: "EXEC_COMPLETE" }
	| { type: "EXEC_FAIL" }
	| { type: "AUDIT_PASS" }
	| { type: "AUDIT_FAIL"; findings: AuditFinding[] }
	| { type: "REMEDIATION_COMPLETE" }
	| { type: "REMEDIATION_FAIL" }
	| { type: "ABORT" };

// ─── Phase Machine ───────────────────────────────────────────────────

/**
 * The phase machine is spawned as a child actor for each phase.
 * It runs: EXECUTING → AUDITING (parallel) → REMEDIATING → loop / complete.
 *
 * This maps exactly to the existing runPhase() loop but as explicit
 * states instead of a while() loop.
 */
export const phaseMachine = setup({
	types: {} as {
		context: {
			phase: DagPhase;
			spec: PhaseSpec;
			attempt: number;
			maxAttempts: number;
			findings: AuditFinding[];
		};
		events: PhaseEvent;
		input: { phase: DagPhase; spec: PhaseSpec; maxAttempts: number };
	};
	actors: {
		executeActor: fromPromise<boolean, { phase: DagPhase; spec: PhaseSpec; attempt: number; steer: string | null }>;
		structuralAuditActor: fromPromise<AuditFinding[], { phasesDir: string; rulesDir: string; enabledRules?: Set<string> }>;
		semanticAuditActor: fromPromise<AuditFinding[], { workspaceDir: string; rpcAgent: RpcAgent }>;
		remediationActor: fromPromise<boolean, { phase: DagPhase; spec: PhaseSpec; findings: AuditFinding[]; attempt: number; maxAttempts: number }>;
	};
}).createMachine({
	id: "phase",
	initial: "executing",
	context: ({ input }) => ({
		phase: input.phase,
		spec: input.spec,
		attempt: 0,
		maxAttempts: input.maxAttempts,
		findings: [],
	}),
	states: {
		/** ── EXECUTING: run the coder / executor ── */
		executing: {
			invoke: {
				src: "executeActor",
				input: ({ context }) => ({
					phase: context.phase,
					spec: context.spec,
					attempt: context.attempt,
					steer: null, // injected from parent
				}),
				onDone: {
					target: "auditing",
					actions: ({ context, event }) => {
						if (!event.output) {
							// executor failed — will retry via remediating → loop
						}
					},
				},
				onError: {
					target: "remediating",
					actions: ({ context }) => { context.attempt++; },
				},
			},
		},

		/** ── AUDITING: parallel fan-out of structural + semantic ── */
		auditing: {
			type: "parallel",
			states: {
				structural: {
					initial: "idle",
					states: {
						idle: { on: { EXEC_COMPLETE: "running" } },
						running: {
							invoke: {
								src: "structuralAuditActor",
								onDone: [
									{
										guard: ({ event }) => event.output.length === 0,
										target: "pass",
									},
									{
										target: "fail",
										actions: ({ context, event }) => {
											context.findings.push(...event.output);
										},
									},
								],
								onError: { target: "fail" },
							},
						},
						pass: { type: "final" },
						fail: { type: "final" },
					},
				},
				semantic: {
					initial: "idle",
					states: {
						idle: { on: { EXEC_COMPLETE: "running" } },
						running: {
							invoke: {
								src: "semanticAuditActor",
								onDone: [
									{
										guard: ({ event }) => event.output.length === 0,
										target: "pass",
									},
									{
										target: "fail",
										actions: ({ context, event }) => {
											context.findings.push(...event.output);
										},
									},
								],
								onError: { target: "fail" },
							},
						},
						pass: { type: "final" },
						fail: { type: "final" },
					},
				},
			},
			onDone: [
				{
					// Both passed → phase complete
					guard: ({ context }) => context.findings.length === 0,
					target: "completed",
				},
				{
					// One or both failed → remediate
					target: "remediating",
				},
			],
		},

		/** ── REMEDIATING: fix findings, re-execute ── */
		remediating: {
			invoke: {
				src: "remediationActor",
				input: ({ context }) => ({
					phase: context.phase,
					spec: context.spec,
					findings: context.findings,
					attempt: context.attempt,
					maxAttempts: context.maxAttempts,
				}),
				onDone: [
					{
						guard: ({ event }) => event.output === true,
						target: "executing",
						actions: ({ context }) => {
							context.attempt++;
							context.findings = []; // reset for next audit cycle
						},
					},
					{
						target: "failed",
					},
				],
				onError: {
					target: "failed",
				},
			},
		},

		completed: {
			type: "final",
			output: ({ context }) => ({
				passed: true as const,
				attempts: context.attempt,
				findings: context.findings,
			}),
		},

		failed: {
			type: "final",
			output: ({ context }) => ({
				passed: false as const,
				attempts: context.attempt,
				findings: context.findings,
			}),
		},
	},
});

export type PhaseActor = ActorRefFrom<typeof phaseMachine>;

// ─── Parent Bake Machine ─────────────────────────────────────────────

/**
 * The parent machine manages the overall pipeline lifecycle.
 * It owns the phase DAG and spawns phase actors as dependencies are met.
 */
export const bakeMachine = setup({
	types: {} as {
		context: BakeMachineContext;
		events: BakeEvent;
	};
	actors: {
		decomposeActor: fromPromise<Decomposition, { specPath: string }>;
		phaseActor: typeof phaseMachine;
	};
}).createMachine({
	id: "bake",
	initial: "idle",
	context: {
		phases: [],
		phaseSpecs: new Map(),
		completed: new Set(),
		skipped: new Set(),
		results: new Map(),
		eventLog: null,
		failedPhase: null,
		readyQueue: [],
		runningCount: 0,
		pendingSteer: null,
		paused: false,
	},
	states: {
		/** ── IDLE ── */
		idle: {
			on: {
				START: { target: "composing" },
				SKIP_PHASE: { actions: ({ context, event }) => context.skipped.add(event.phaseId) },
			},
		},

		/** ── COMPOSING: decompose raw spec into DAG ── */
		composing: {
			invoke: {
				src: "decomposeActor",
				onDone: {
					target: "running",
					actions: ({ context, event }) => {
						const decomp = event.output;
						context.phases = decomp.phases;
						// Seed readyQueue with phases that have no deps
						context.readyQueue = decomp.phases
							.filter((p) => p.depends_on.length === 0)
							.map((p) => p.id);
					},
				},
				onError: { target: "failed" },
			},
		},

		/** ── RUNNING: DAG-based phase execution ── */
		running: {
			initial: "scheduling",
			states: {
				/** Check for ready phases and spawn them */
				scheduling: {
					always: {
						guard: ({ context }) => context.readyQueue.length > 0,
						target: "dispatching",
					},
					on: {
						SCHEDULE_NEXT: [
							{
								guard: ({ context }) => context.readyQueue.length > 0,
								target: "dispatching",
							},
							{
								guard: ({ context }) =>
									context.runningCount === 0 &&
									context.completed.size + context.skipped.size === context.phases.length,
								target: "#bake.done",
							},
						],
					},
				},

				/** Spawn phase actors for all currently ready phases */
				dispatching: {
					entry: ({ context, spawnChild }) => {
						const batch = [...context.readyQueue];
						context.readyQueue = [];
						context.runningCount += batch.length;

						for (const phaseId of batch) {
							const dagPhase = context.phases.find((p) => p.id === phaseId);
							if (!dagPhase || context.skipped.has(phaseId)) {
								context.runningCount--;
								continue;
							}
							const spec = context.phaseSpecs.get(phaseId);
							if (!spec) {
								context.runningCount--;
								continue;
							}

							const actor = spawnChild("phaseActor", {
								input: { phase: dagPhase, spec, maxAttempts: 3 },
							});

							// Listen for phase completion
							actor.subscribe((snapshot) => {
								if (snapshot.status === "done") {
									const result = snapshot.output as PhaseResult;
									context.results.set(phaseId, result);
									if (result.passed === true) {
										context.completed.add(phaseId);
									} else {
										context.failedPhase = phaseId;
									}
									context.runningCount--;

									// When a phase completes, check for newly-ready phases
									// by scanning all uncompleted phases
									for (const p of context.phases) {
										if (context.completed.has(p.id) || context.skipped.has(p.id)) continue;
										const depsMet = p.depends_on.every(
											(d) => context.completed.has(d) || context.skipped.has(d),
										);
										if (depsMet && !context.readyQueue.includes(p.id)) {
											context.readyQueue.push(p.id);
										}
									}

									// If batch is exhausted, schedule next
									if (context.runningCount === 0 && !result.passed) {
										// Failure — no need to continue
										return;
									}
								}
							});
						}
					},
					always: { target: "scheduling" },
				},

				/** We're waiting — nothing ready yet, or all done */
				waiting: {
					on: {
						SCHEDULE_NEXT: "#bake.running.scheduling",
						PAUSE: { target: "#bake.running.paused" },
					},
				},

				paused: {
					on: {
						RESUME: { target: "scheduling" },
						SKIP_PHASE: { actions: ({ context, event }) => context.skipped.add(event.phaseId) },
					},
				},
			},
			on: {
				// Phase failure bubbles up
				PHASE_COMPLETE: {
					actions: ({ context, event }) => {
						if (event.result.passed !== true) {
							context.failedPhase = event.phaseId;
						}
					},
				},
				STEER: { actions: ({ context, event }) => { context.pendingSteer = event.message; } },
				PAUSE: { target: ".paused" },
			},
		},

		/** ── DONE / FAILED ── */
		done: { type: "final" },
		failed: { type: "final" },
	},
});

// ─── Integration: How Bake uses the machine ──────────────────────────
//
// 1. Bake creates the machine and interprets it:
//
//    const service = interpret(bakeMachine)
//      .provide({
//        actors: {
//          decomposeActor: fromPromise(async ({ input }) => {
//            const output = await this.runPrompt(decomposePrompt, "Decompose");
//            return parseDecomposition(output);
//          }),
//          executeActor: fromPromise(async ({ input }) => {
//            return runExecutor(input.spec, input.attempt, input.steer, deps);
//          }),
//          structuralAuditActor: fromPromise(async ({ input }) => {
//            return runStructuralAudit(input.phasesDir, input.rulesDir, input.enabledRules);
//          }),
//          semanticAuditActor: fromPromise(async ({ input }) => {
//            return runSemanticAudit({ workspaceDir, rpcAgent, ... });
//          }),
//          remediationActor: fromPromise(async ({ input }) => {
//            return runRemediation(input.spec, input.findings, input.attempt, input.maxAttempts, deps);
//          }),
//        },
//      })
//      .start();
//
// 2. Bake sends events:
//    service.send({ type: "START" });
//    service.send({ type: "PAUSE" });
//    service.send({ type: "SKIP_PHASE", phaseId: "..." });
//
// 3. Bake subscribes to state changes:
//    service.subscribe((state) => {
//      if (state.matches("done"))  cleanup();
//      if (state.matches("failed"))  reportFailure(state.context.failedPhase);
//      emitStateChange(mapState(state));
//    });
// 
/**
 * Orchestrator Extension — pi extension for autonomous phase execution.
 *
 * Provides:
 * - Widget showing current phase/attempt/status
 * - Custom slash commands: status, pause, resume, skip, steer, retry, log
 * - Event log (JSON-lines)
 * - Hybrid audit (ast-grep structural + LLM semantic)
 * - Sub-agent executor via pi child process
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Orchestrator, type OrchestratorState } from "./orchestrator.ts";

const ORCHESTRATOR_DIR = path.join(process.cwd(), ".orchestrator");
const WORKSPACE_DIR = path.join(ORCHESTRATOR_DIR, "workspace");

let orchestrator: Orchestrator | null = null;
let pipelinePromise: Promise<void> | null = null;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// Initialize orchestrator
		orchestrator = new Orchestrator(process.cwd(), WORKSPACE_DIR);
		const log = orchestrator.eventLog;
		const theme = ctx.ui.theme;

		// --- Widget: show current phase/attempt/status ---
		const widgetId = "orchestrator-status";
		const renderWidget = (state: OrchestratorState): string[] => {
			if (state.status === "idle" && !state.currentPhase) {
				return [theme.fg("dim", "Orchestrator idle. Use /orchestrator-start to begin.")];
			}

			const phaseInfo = state.currentPhase
				? `${theme.fg("accent", state.currentPhase)}`
				: theme.fg("dim", "no active phase");

			const attemptInfo =
				state.currentPhase && state.currentAttempt > 0
					? ` attempt ${theme.fg("warning", String(state.currentAttempt + 1))}/${state.maxAttempts}`
					: "";

			const statusIcon =
				state.status === "running"
					? theme.fg("success", "●")
					: state.status === "paused"
					  ? theme.fg("warning", "⏸")
					  : state.status === "failed"
						  ? theme.fg("error", "✗")
						  : state.status === "done"
							  ? theme.fg("success", "✓")
							  : theme.fg("dim", "○");

			const statusText =
				state.status === "running"
					? theme.fg("dim", "running")
					: state.status === "paused"
					  ? theme.fg("warning", "PAUSED")
					  : state.status === "failed"
						  ? theme.fg("error", "FAILED")
						  : state.status === "done"
							  ? theme.fg("success", "complete")
							  : theme.fg("dim", state.status);

			const phasesDone = state.completedPhases.length;
			const phasesTotal = countPhaseFiles();
			const progress = phasesTotal > 0 ? ` [${phasesDone}/${phasesTotal}]` : "";

			return [
				`${statusIcon} ${phaseInfo}${attemptInfo}${progress} — ${statusText}`,
			];
		};

		const countPhaseFiles = (): number => {
			const phasesDir = path.join(process.cwd(), "phases");
			if (!fs.existsSync(phasesDir)) return 0;
			return fs.readdirSync(phasesDir).filter((f) => f.endsWith(".md")).length;
		};

		// Set initial widget
		ctx.ui.setWidget(widgetId, renderWidget(orchestrator.stateSnapshot));

		// Subscribe to state changes for widget updates
		orchestrator.onStateChange((state) => {
			ctx.ui.setWidget(widgetId, renderWidget(state));
		});

		// --- Status line in footer ---
		ctx.ui.setStatus("orchestrator", theme.fg("dim", "⏎ orchestrator ready"));

		// --- Custom commands ---

		// /orchestrator-status — show full status + recent events
		pi.registerCommand("orchestrator-status", {
			description: "Show orchestrator status and recent events",
			handler: async (_args, cmdCtx) => {
				if (!orchestrator) return;
				const state = orchestrator.stateSnapshot;
				const lines: string[] = [];

				lines.push(theme.fg("toolTitle", theme.bold("Orchestrator Status")));
				lines.push(theme.fg("dim", `Status: ${state.status}`));
				if (state.currentPhase) {
					lines.push(theme.fg("text", `Phase: ${state.currentPhase} (attempt ${state.currentAttempt + 1}/${state.maxAttempts})`));
				}
				if (state.completedPhases.length > 0) {
					lines.push(theme.fg("success", `Completed: ${state.completedPhases.join(", ")}`));
				}
				if (state.skippedPhases.length > 0) {
					lines.push(theme.fg("warning", `Skipped: ${state.skippedPhases.join(", ")}`));
				}
				if (state.pendingSteer) {
					lines.push(theme.fg("accent", `Steer pending: ${state.pendingSteer}`));
				}

				// Recent events
				const events = orchestrator.eventLog.tail(10);
				if (events.length > 0) {
					lines.push("");
					lines.push(theme.fg("dim", "Recent events:"));
					for (const event of events) {
						const time = new Date(event.ts).toLocaleTimeString();
						const icon =
							event.type.includes("pass") || event.type.includes("complete")
								? theme.fg("success", "✓")
								: event.type.includes("fail") || event.type.includes("error") || event.type.includes("breaker")
								  ? theme.fg("error", "✗")
								  : theme.fg("dim", "·");
						lines.push(`  ${icon} ${theme.fg("dim", time)} ${theme.fg("muted", event.type)}`);
					}
				}

				cmdCtx.ui.notify(lines.join("\n"), "info");
			},
		});

		// /orchestrator-start — kick off the pipeline
		pi.registerCommand("orchestrator-start", {
			description: "Start or resume the orchestration pipeline",
			handler: async (_args, cmdCtx) => {
				if (!orchestrator) return;
				if (pipelinePromise) {
					cmdCtx.ui.notify(theme.fg("warning", "Pipeline already running"), "info");
					return;
				}
				cmdCtx.ui.notify(theme.fg("success", "Starting pipeline..."), "info");
				pipelinePromise = orchestrator.runPipeline().finally(() => {
					pipelinePromise = null;
				});
			},
		});

		// /orchestrator-pause — pause after current attempt
		pi.registerCommand("orchestrator-pause", {
			description: "Pause the orchestrator after the current attempt",
			handler: async (_args, cmdCtx) => {
				if (!orchestrator) return;
				orchestrator.pause();
				cmdCtx.ui.notify(theme.fg("warning", "Orchestrator paused"), "info");
			},
		});

		// /orchestrator-resume — resume from pause
		pi.registerCommand("orchestrator-resume", {
			description: "Resume a paused orchestrator",
			handler: async (_args, cmdCtx) => {
				if (!orchestrator) return;
				orchestrator.resume();
				cmdCtx.ui.notify(theme.fg("success", "Orchestrator resumed"), "info");
			},
		});

		// /orchestrator-skip — skip current phase
		pi.registerCommand("orchestrator-skip", {
			description: "Skip the current phase and move to the next",
			handler: async (_args, cmdCtx) => {
				if (!orchestrator) return;
				orchestrator.skipPhase();
				cmdCtx.ui.notify(theme.fg("warning", "Phase skipped"), "info");
			},
		});

		// /orchestrator-steer <message> — inject guidance
		pi.registerCommand("orchestrator-steer", {
			description: "Inject guidance into the next executor run",
			usage: "<message>",
			handler: async (args, cmdCtx) => {
				if (!orchestrator) return;
				if (!args) {
					cmdCtx.ui.notify(theme.fg("error", "Usage: /orchestrator-steer <message>"), "info");
					return;
				}
				orchestrator.steer(args);
				cmdCtx.ui.notify(theme.fg("accent", `Steer: ${args}`), "info");
			},
		});

		// /orchestrator-retry — retry current attempt
		pi.registerCommand("orchestrator-retry", {
			description: "Retry the current executor attempt",
			handler: async (_args, cmdCtx) => {
				if (!orchestrator) return;
				orchestrator.retryAttempt();
				cmdCtx.ui.notify(theme.fg("warning", "Retrying current attempt..."), "info");
			},
		});

		// /orchestrator-log [n] — show recent events
		pi.registerCommand("orchestrator-log", {
			description: "Show recent orchestrator events",
			usage: "[count=20]",
			handler: async (args, cmdCtx) => {
				if (!orchestrator) return;
				const count = args ? Math.min(Number(args) || 20, 100) : 20;
				const events = orchestrator.eventLog.tail(count);
				if (events.length === 0) {
					cmdCtx.ui.notify(theme.fg("dim", "No events yet"), "info");
					return;
				}
				const lines = events
					.reverse()
					.map((e) => {
						const time = new Date(e.ts).toLocaleTimeString();
						return `${theme.fg("dim", time)} ${theme.fg("muted", e.type)} ${JSON.stringify(e.data)}`;
					})
					.join("\n");
				cmdCtx.ui.notify(lines, "info");
			},
		});

		// /orchestrator-spec-decompose <path> — decompose a raw spec
		pi.registerCommand("orchestrator-spec-decompose", {
			description: "Decompose a raw spec file into clean phase files",
			usage: "<path-to-raw-spec>",
			handler: async (args, cmdCtx) => {
				if (!args) {
					cmdCtx.ui.notify(theme.fg("error", "Usage: /orchestrator-spec-decompose <path>"), "info");
					return;
				}
				const specPath = path.resolve(args);
				if (!fs.existsSync(specPath)) {
					cmdCtx.ui.notify(theme.fg("error", `File not found: ${specPath}`), "info");
					return;
				}

				cmdCtx.ui.notify(theme.fg("dim", "Decomposing spec..."), "info");
				const specContent = fs.readFileSync(specPath, "utf-8");

				// Delegate to pi sub-agent for decomposition
				const { spawnSync } = await import("node:child_process");
				const prompt = `Read this specification and decompose it into separate phase files. Each phase should have a clear objective, task checklist with checkboxes, and acceptance criteria. Strip narrative, philosophy, out-of-scope sections, and operational caveats into a separate context file.

Output the decomposition as JSON:
{
  "phases": [
    { "name": "01_phase_name", "content": "# Phase Name\\n\\n## Objective\\n...\\n\\n## Tasks\\n- [ ] ..." }
  ],
  "context": "Any narrative/philosophy/out-of-scope content stripped from phases."
}

Raw spec:
${specContent}`;

				const result = spawnSync("pi", ["-p", prompt], {
					encoding: "utf-8",
					timeout: 5 * 60 * 1000,
					maxBuffer: 1024 * 1024 * 10,
				});

				if (result.status !== 0) {
					cmdCtx.ui.notify(theme.fg("error", "Spec decomposition failed"), "info");
					return;
				}

				// Parse JSON from output
				const jsonMatch = result.stdout.match(/\{[\s\S]*"phases"[\s\S]*\}/);
				if (!jsonMatch) {
					cmdCtx.ui.notify(theme.fg("error", "Could not parse decomposition output"), "info");
					return;
				}

				try {
					const decomposition = JSON.parse(jsonMatch[0]);
					const phasesDir = path.join(process.cwd(), "phases");
					if (!fs.existsSync(phasesDir)) fs.mkdirSync(phasesDir, { recursive: true });

					for (const phase of decomposition.phases) {
						const phasePath = path.join(phasesDir, `${phase.name}.md`);
						fs.writeFileSync(phasePath, phase.content, "utf-8");
					}

					// Write context file if present
					if (decomposition.context) {
						const contextPath = path.join(process.cwd(), ".orchestrator", "spec-context.md");
						fs.writeFileSync(contextPath, decomposition.context, "utf-8");
					}

					cmdCtx.ui.notify(
						theme.fg("success", `Decomposed into ${decomposition.phases.length} phases in phases/`),
						"info",
					);
				} catch (err: any) {
					cmdCtx.ui.notify(theme.fg("error", `Parse error: ${err.message}`), "info");
				}
			},
		});
	});
}

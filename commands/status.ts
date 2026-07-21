import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bakeCtx } from "./shared.ts";

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("bake-status", {
		description: "Show bake status and recent events",
		handler: async (_args, cmdCtx) => {
			const bake = bakeCtx.bake;
			if (!bake) return;
			const t = cmdCtx.ui.theme;
			const state = bake.stateSnapshot;
			const lines: string[] = [
				t.fg("toolTitle", t.bold("Bake Status")),
				t.fg("dim", `Status: ${state.status}`),
			];
			if (state.currentPhase) {
				lines.push(
					t.fg("text", `Phase: ${state.currentPhase} (attempt ${state.currentAttempt + 1}/${state.maxAttempts})`),
				);
			}
			if (state.completedPhases.length) {
				lines.push(t.fg("success", `Completed: ${state.completedPhases.join(", ")}`));
			}
			if (state.skippedPhases.length) {
				lines.push(t.fg("warning", `Skipped: ${state.skippedPhases.join(", ")}`));
			}
			if (state.pendingSteer) {
				lines.push(t.fg("accent", `Steer pending: ${state.pendingSteer}`));
			}
			const events = bake.eventLog.tail(10);
			if (events.length) {
				lines.push("", t.fg("dim", "Recent events:"));
				for (const e of events) {
					const icon = e.type.includes("pass") || e.type.includes("complete")
						? t.fg("success", "✓")
						: e.type.includes("fail") || e.type.includes("error") || e.type.includes("breaker")
							? t.fg("error", "✗")
							: t.fg("dim", "·");
					lines.push(
						`  ${icon} ${t.fg("dim", new Date(e.ts).toLocaleTimeString())} ${t.fg("muted", e.type)}`,
					);
				}
			}
			cmdCtx.ui.notify(lines.join("\n"), "info");
		},
	});
}

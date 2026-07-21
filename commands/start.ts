import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bakeCtx } from "./shared.ts";

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("bake-start", {
		description: "Start or resume the bake pipeline",
		handler: async (_args, cmdCtx) => {
			const bake = bakeCtx.bake;
			if (!bake) return;
			const t = cmdCtx.ui.theme;

			// Guard: don't start a second pipeline concurrently
			if (bake.stateSnapshot.status === "running") {
				cmdCtx.ui.notify(t.fg("warning", "Pipeline already running"), "info");
				return;
			}

			cmdCtx.ui.setStatus("bake", t.fg("accent", "○ Starting pipeline..."));
			cmdCtx.ui.notify(t.fg("success", "Pipeline started"), "info");

			// Fire pipeline in background — the handler returns immediately so the
			// TUI stays genuinely responsive. Status, working indicator, and widget
			// updates flow through the existing onStateChange / onStatus / onLoader
			// callbacks wired in index.ts session_start.
			bake.runPipeline().catch((err) => {
				cmdCtx.ui.notify(
					t.fg("error", `Pipeline failed: ${err.message}`),
					"info",
				);
				cmdCtx.ui.setStatus("bake", t.fg("error", "✗ pipeline failed"));
			});
		},
	});
}

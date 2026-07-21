import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bakeCtx } from "./shared.ts";

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("bake-resume", {
		description: "Resume a paused bake pipeline",
		handler: async (_args, cmdCtx) => {
			const bake = bakeCtx.bake;
			if (!bake) return;
			const t = cmdCtx.ui.theme;
			cmdCtx.ui.setStatus("bake", t.fg("accent", "○ Resuming pipeline..."));
			cmdCtx.ui.notify(t.fg("success", "Bake resumed"), "info");
			await bake.resume();
		},
	});
}

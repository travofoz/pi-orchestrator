import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bakeCtx } from "./shared.ts";

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("bake-pause", {
		description: "Pause the bake pipeline after the current attempt",
		handler: async (_args, cmdCtx) => {
			const bake = bakeCtx.bake;
			if (!bake) return;
			bake.pause();
			cmdCtx.ui.notify(cmdCtx.ui.theme.fg("warning", "Bake paused"), "info");
		},
	});
}

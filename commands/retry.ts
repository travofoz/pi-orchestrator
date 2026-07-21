import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bakeCtx } from "./shared.ts";

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("bake-retry", {
		description: "Retry the current executor attempt",
		handler: async (_args, cmdCtx) => {
			const bake = bakeCtx.bake;
			if (!bake) return;
			bake.retryAttempt();
			cmdCtx.ui.notify(cmdCtx.ui.theme.fg("warning", "Retrying current attempt..."), "info");
		},
	});
}

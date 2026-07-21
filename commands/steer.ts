import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bakeCtx } from "./ctx.ts";

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("bake-steer", {
		description:
			"Inject guidance into the next executor run. Usage: /bake-steer <message>",
		handler: async (args, cmdCtx) => {
			const bake = bakeCtx.bake;
			if (!bake) return;
			const t = cmdCtx.ui.theme;
			if (!args) {
				cmdCtx.ui.notify(t.fg("error", "Usage: /bake-steer <message>"), "info");
				return;
			}
			bake.steer(args);
			cmdCtx.ui.notify(t.fg("accent", `Steer: ${args}`), "info");
		},
	});
}

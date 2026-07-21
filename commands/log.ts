import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bakeCtx } from "./ctx.ts";

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("bake-log", {
		description: "Show recent bake events (default: 20, max: 100)",
		handler: async (args, cmdCtx) => {
			const bake = bakeCtx.bake;
			if (!bake) return;
			const t = cmdCtx.ui.theme;
			const count = args ? Math.min(Number(args) || 20, 100) : 20;
			const events = bake.eventLog.tail(count);
			if (!events.length) {
				cmdCtx.ui.notify(t.fg("dim", "No events yet"), "info");
				return;
			}
			const lines = events
				.reverse()
				.map(
					(e) =>
						`${t.fg("dim", new Date(e.ts).toLocaleTimeString())} ${t.fg("muted", e.type)} ${JSON.stringify(e.data)}`,
				)
				.join("\n");
			cmdCtx.ui.notify(lines, "info");
		},
	});
}

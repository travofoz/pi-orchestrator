import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bakeCtx, loadConfig, saveConfig, type WidgetMode } from "./shared.ts";

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("bake-widget", {
		description: "Cycle widget mode: full → compact → hidden → full",
		handler: async (_args, cmdCtx) => {
			const t = cmdCtx.ui.theme;
			const cfg = loadConfig();
			const cycle: WidgetMode[] = ["full", "compact", "hidden"];
			const idx = (cycle.indexOf(cfg.widgetMode) + 1) % cycle.length;
			cfg.widgetMode = cycle[idx];
			saveConfig(cfg);
			bakeCtx.requestWidgetRender?.();
			cmdCtx.ui.notify(t.fg("accent", `Widget: ${cfg.widgetMode}`), "info");
		},
	});
}

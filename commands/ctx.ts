/**
 * /bake-ctx — provide context to unblock a phase waiting for information.
 *
 * When a phase enters NEEDS_CONTEXT (e.g., the agent needs clarification),
 * this command sends PROVIDE_CONTEXT to the BakeMachine, which forwards it
 * to the waiting PhaseMachine child. The phase resumes executing with the
 * provided context as steering guidance.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bakeCtx } from "./shared.ts";

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("bake-ctx", {
		description:
			"Provide context/info to unblock a phase waiting for information. Usage: /bake-ctx <message>",
		handler: async (args, cmdCtx) => {
			const bake = bakeCtx.bake;
			if (!bake) return;
			const t = cmdCtx.ui.theme;

			if (!args) {
				cmdCtx.ui.notify(
					t.fg("error", "Usage: /bake-ctx <message>"),
					"info",
				);
				return;
			}

			const provided = bake.provideContext(args);
			if (provided) {
				cmdCtx.ui.notify(
					t.fg("accent", `Context provided: ${args}`),
					"info",
				);
			} else {
				cmdCtx.ui.notify(
					t.fg("warning", "No phase currently waiting for context"),
					"info",
				);
			}
		},
	});
}

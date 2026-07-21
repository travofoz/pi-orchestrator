/**
 * Command registry — imports and registers all bake commands.
 *
 * Each command module exports a `register(pi)` function.
 * This module calls all of them so index.ts stays thin.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { register as registerStatus } from "./status.ts";
import { register as registerStart } from "./start.ts";
import { register as registerPause } from "./pause.ts";
import { register as registerResume } from "./resume.ts";
import { register as registerSkip } from "./skip.ts";
import { register as registerSteer } from "./steer.ts";
import { register as registerRetry } from "./retry.ts";
import { register as registerLog } from "./log.ts";
import { register as registerDetail } from "./detail.ts";
import { register as registerRules } from "./rules.ts";
import { register as registerReset } from "./reset.ts";
import { register as registerSpecDecompose } from "./spec-decompose.ts";
import { register as registerConfig } from "./config.ts";
import { register as registerWidget } from "./widget.ts";
import { register as registerDoctor } from "./doctor.ts";
import { register as registerCtx } from "./ctx.ts";

export function registerAll(pi: ExtensionAPI): void {
	registerStatus(pi);
	registerStart(pi);
	registerPause(pi);
	registerResume(pi);
	registerSkip(pi);
	registerSteer(pi);
	registerRetry(pi);
	registerLog(pi);
	registerDetail(pi);
	registerRules(pi);
	registerReset(pi);
	registerSpecDecompose(pi);
	registerConfig(pi);
	registerWidget(pi);
	registerDoctor(pi);
	registerCtx(pi);
}

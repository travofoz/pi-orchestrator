/**
 * Overlay wrapper — clean Gaussian taper rule.
 *
 *   ────━━━━━━━━══════════[ Bake Config ]══════════━━━━━━━━────
 *
 *       Widget mode: [full]
 *       ↑↓ navigate  ·  ← → change
 *
 *   ────━━━━━━━━══════════════════════════════════════━━━━━━━━────
 *
 * Single line top and bottom. Thin dashes (─) at edges, medium (━)
 * mid, thick equals (═) at center — Gaussian fat-middle/narrow-edges
 * principle. Charcoal dark grey bg, white text, 2-col margin.
 */

import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";

export type ThemeProxy = {
	fg: (variant: string, text: string) => string;
	bg: (variant: string, text: string) => string;
};

const PANEL_BG = "\x1b[48;5;234m";  // dark grey (256-color)
const RESET_WHITE = "\x1b[0m\x1b[38;5;255m";  // white text

function wrapPanel(text: string): string {
	return PANEL_BG + text + RESET_WHITE;
}

const TAPER_CHARS = ["─", "━", "═"];

function taper(width: number): string {
	if (width <= 0) return "";
	let s = "";
	for (let i = 0; i < width; i++) {
		const ct = (width - 1) / 2;
		const dist = Math.abs(i - ct) / Math.max(1, ct);
		const idx = Math.round((1 - dist) * (TAPER_CHARS.length - 1));
		s += TAPER_CHARS[Math.max(0, Math.min(idx, TAPER_CHARS.length - 1))];
	}
	return s;
}

/** Taper with embedded title: ────━━━━════[ Title ]════━━━━──── */
export function taperTitle(title: string, width: number, fg: (v: string, t: string) => string): string {
	const titleStr = `═[ ${fg("text", title)} ]`;
	const tv = visibleWidth(titleStr);
	const lw = Math.floor((width - tv) / 2);
	const rw = width - tv - lw;
	return fg("accent", taper(lw) + titleStr + taper(rw));
}

export class Overlay {
	private theme: ThemeProxy;
	private title: string;
	private body: Container;
	private footerLines: string[];
	private maxHeight: number;

	constructor(theme: ThemeProxy, opts: { title?: string; maxHeight?: number } = {}) {
		this.theme = theme;
		this.title = opts.title ?? "";
		this.maxHeight = opts.maxHeight ?? 0; // 0 = unlimited
		this.body = new Container();
		this.footerLines = [];
	}

	addBody(component: { render: (w: number) => string[]; invalidate: () => void }): void {
		this.body.addChild(component);
	}

	addFooter(line: string): void {
		this.footerLines.push(line);
	}

	render(fullW: number): string[] {
		const margin = 2;
		const innerW = Math.max(20, fullW - margin * 2);
		const t = this.theme;
		const a = (s: string) => t.fg("accent", s);
		const dim = (s: string) => t.fg("dim", s);
		const result: string[] = [];

		// ── Top rule with title ──
		if (this.title) {
			const titleStr = `═[ ${t.fg("text", this.title)} ]`;
			const titleVis = visibleWidth(titleStr);
			const leftW = Math.floor((innerW - titleVis) / 2);
			const rightW = innerW - titleVis - leftW;
			result.push(a(taper(leftW) + titleStr + taper(rightW)));
		} else {
			result.push(a(taper(innerW)));
		}

		result.push("");

		// ── Body ──
		const indent = 4;
		const bodyLines = this.body.render(innerW - indent);
		for (const line of bodyLines) {
			result.push(" ".repeat(indent) + line);
		}

		if (this.footerLines.length > 0) result.push("");

		// ── Footer ──
		for (const f of this.footerLines) {
			result.push(" ".repeat(indent) + dim(f));
		}

		if (this.footerLines.length > 0) result.push("");

		// ── Bottom rule ──
		result.push(a(taper(innerW)));

		// ── Cap to maxHeight if set ──
		let capped = result;
		if (this.maxHeight > 0 && capped.length > this.maxHeight) {
			capped = capped.slice(0, this.maxHeight);
			capped[capped.length - 1] = dim("  ▼ truncated");
		}

		// ── Pad with dark grey bg + margin ──
		const leftPad = " ".repeat(margin);
		return capped.map((line) => {
			const vis = visibleWidth(line);
			const rightPad = " ".repeat(Math.max(0, fullW - margin - vis - margin));
			return wrapPanel(leftPad + line + rightPad);
		});
	}

	invalidate(): void {
		this.body.invalidate();
	}
}

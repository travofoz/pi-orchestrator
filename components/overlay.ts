/**
 * Overlay wrapper — animated pink/green laser scanner taper.
 *
 *   ────━━━━━━━━══════════[ Title ]══════════━━━━━━━━────
 *   Pink spotlight sweeps from center leftward and rightward
 *   in sync — classic KITT scanner on the taper line.
 *
 *   Dark grey bg, white text, 2-col margin.
 */

import { Container, visibleWidth } from "@earendil-works/pi-tui";

export type ThemeProxy = {
	fg: (variant: string, text: string) => string;
	bg: (variant: string, text: string) => string;
};

const PANEL_BG = "\x1b[48;5;232m";
const RESET_WHITE = "\x1b[0m\x1b[38;5;255m";

function wrapPanel(text: string): string {
	return PANEL_BG + text + RESET_WHITE;
}

const TAPER_CHARS = ["─", "━", "═"];

function taperChars(width: number): string[] {
	const chars: string[] = [];
	for (let i = 0; i < width; i++) {
		const ct = (width - 1) / 2;
		const dist = Math.abs(i - ct) / Math.max(1, ct);
		const idx = Math.round((1 - dist) * (TAPER_CHARS.length - 1));
		chars.push(TAPER_CHARS[Math.max(0, Math.min(idx, TAPER_CHARS.length - 1))]);
	}
	return chars;
}

const GREEN_BRIGHT = "\x1b[38;5;119m";
const GREEN_MID = "\x1b[38;5;108m";
const GREEN_DIM = "\x1b[38;5;65m";
const RESET = "\x1b[0m";
const WHITE_FG = "\x1b[38;5;255m";

/** Build a mirrored green taper with two spots sweeping center→out→center.
 *  All green — bright spots at the moving edges, dim in the middle. */
export function scannerTaper(width: number, scanSpread: number, t: ThemeProxy, title?: string): string {
	if (width <= 0) return "";
	const chars = taperChars(width);
	const ct = (width - 1) / 2;
	// scanSpread 0 = center, 1 = edges
	const leftScan = Math.round(ct - scanSpread * ct);
	const rightScan = Math.round(ct + scanSpread * ct);

	const colorLine = (lineChars: string[], offset: number): string => {
		return lineChars.map((ch, i) => {
			const absIdx = offset + i;
			const minDist = Math.min(Math.abs(absIdx - leftScan), Math.abs(absIdx - rightScan));
			if (minDist <= 5) {
				const c = minDist <= 1 ? GREEN_BRIGHT : minDist <= 3 ? GREEN_MID : GREEN_DIM;
				return `${c}${ch}${RESET}`;
			}
			return `${GREEN_DIM}${ch}${RESET}`;
		}).join("");
	};

	if (title) {
		const titleStr = `[ ${t.fg("text", title)} ]`;
		const tv = visibleWidth(titleStr);
		const lw = Math.floor((width - tv) / 2);
		const rw = width - tv - lw;
		const left = colorLine(chars.slice(0, lw), 0);
		const right = colorLine(chars.slice(lw + tv, lw + tv + rw), lw + tv);
		return left + titleStr + right;
	}

	return colorLine(chars, 0);
}

export function taperTitle(title: string, width: number, fg: (v: string, t: string) => string): string {
	const titleStr = `═[ ${fg("text", title)} ]`;
	const tv = visibleWidth(titleStr);
	const lw = Math.floor((width - tv) / 2);
	const rw = width - tv - lw;
	return fg("accent", taperChars(lw).join("") + titleStr + taperChars(rw).join(""));
}

export class Overlay {
	private theme: ThemeProxy;
	private title: string;
	private body: Container;
	private footerLines: string[];
	private animStart: number;
	private maxHeight: number;

	constructor(theme: ThemeProxy, opts: { title?: string; maxHeight?: number } = {}) {
		this.theme = theme;
		this.title = opts.title ?? "";
		this.body = new Container();
		this.footerLines = [];
		this.animStart = Date.now();
		this.maxHeight = opts.maxHeight ?? 0;
	}

	addBody(component: { render: (w: number) => string[]; invalidate: () => void }): void {
		this.body.addChild(component);
	}

	addFooter(line: string): void {
		this.footerLines.push(line);
	}

	dispose(): void {
		// No individual timer to clean — scan position is time-computed in render()
	}

	render(fullW: number): string[] {
		const margin = 2;
		const innerW = Math.max(20, fullW - margin * 2);
		const t = this.theme;
		const dim = (s: string) => t.fg("dim", s);
		const result: string[] = [];

		// ── Scanner position: time-based ping-pong (0→1→0), no timer needed ──
		// Cycle matches original 0.66s full sweep
		const elapsed = (Date.now() - this.animStart) / 1000;
		const cycle = 0.66;
		const phase = (elapsed % (cycle * 2)) / cycle;
		const scanPos = phase <= 1 ? phase : 2 - phase;

		// ── Top rule with animated scanner + title ──
		result.push(scannerTaper(innerW, scanPos, t, this.title));

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

		// ── Bottom rule (mirrored scan) ──
		result.push(scannerTaper(innerW, scanPos, t));

		// ── Silent cap at maxHeight (no truncation marker) ──
		if (this.maxHeight > 0 && result.length > this.maxHeight) {
			result = result.slice(0, this.maxHeight);
		}

		// ── Pad with dark grey bg + margin ──
		const leftPad = " ".repeat(margin);
		return result.map((line) => {
			const vis = visibleWidth(line);
			const rightPad = " ".repeat(Math.max(0, fullW - margin - vis - margin));
			return wrapPanel(leftPad + line + rightPad);
		});
	}

	invalidate(): void {
		this.body.invalidate();
	}
}

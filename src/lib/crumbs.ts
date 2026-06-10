/**
 * Width-aware breadcrumb collapsing, shared by the SFTP and local file
 * browsers. Crumbs collapse only when the bar is actually too narrow, and
 * only as many as needed: `root › … › deepest ancestors that fit › current`.
 *
 * Widths are estimated with canvas text metrics (same font as the bar) plus
 * the buttons' fixed padding — cheap, no double render. A small slack pad
 * absorbs estimation error; the bar's `overflow-hidden` + per-crumb
 * `max-width` truncation are the graceful fallback if we're still off.
 */

export interface Crumb {
  label: string;
  path: string;
}

export type CrumbItem =
  | { kind: "crumb"; label: string; path: string }
  | { kind: "ellipsis" };

// Mirrors the template: px-1 button padding, max-w-[140px] cap, 11px chevron
// separators, gap-0.5 (2px) between every adjacent item.
const CRUMB_PAD = 8;
const CRUMB_MAX_W = 140;
const SEPARATOR_W = 11 + 2 * 2;
const SLACK = 6;

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, font: string): number {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 7; // canvas unavailable — rough guess
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** Collapse `crumbs` to fit `availWidth` px. Returns all of them (no
 *  ellipsis) when they fit or the width isn't known yet. */
export function fitCrumbs(
  crumbs: Crumb[],
  availWidth: number,
  font: string,
): CrumbItem[] {
  const all = crumbs.map((c) => ({ kind: "crumb" as const, ...c }));
  if (crumbs.length <= 2 || availWidth <= 0) return all;

  const w = crumbs.map((c) =>
    Math.min(textWidth(c.label, font) + CRUMB_PAD, CRUMB_MAX_W),
  );
  const totalAll =
    w.reduce((a, b) => a + b, 0) + (crumbs.length - 1) * SEPARATOR_W;
  if (totalAll + SLACK <= availWidth) return all;

  // Too narrow: root + … + as many trailing crumbs as fit (at least the
  // current dir). Growing the tail keeps the nearest ancestors visible.
  const ellipsisW = textWidth("…", font) + CRUMB_PAD;
  const baseW = w[0] + SEPARATOR_W + ellipsisW;
  let tail = 1;
  let tailW = w[w.length - 1] + SEPARATOR_W;
  while (tail < crumbs.length - 2) {
    const nextW = w[crumbs.length - 1 - tail] + SEPARATOR_W;
    if (baseW + tailW + nextW + SLACK > availWidth) break;
    tailW += nextW;
    tail++;
  }
  return [
    { kind: "crumb" as const, ...crumbs[0] },
    { kind: "ellipsis" as const },
    ...crumbs
      .slice(crumbs.length - tail)
      .map((c) => ({ kind: "crumb" as const, ...c })),
  ];
}

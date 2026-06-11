/**
 * Clickable links in the terminal: hover hit-testing, underline decoration,
 * and cmd/ctrl+click opening.
 *
 * Two sources share this machinery: OSC 8 hyperlinks (resolved on the
 * backend, shipped as `RenderPayload.link_spans`) and plain-text URLs
 * (regex-detected here, lazily, only for the hovered row). Hover state is
 * module-level and imperative like the rest of the draw path — a change just
 * asks for a repaint, and `decoratePayloadForHover` ORs `FLAG_UNDERLINE`
 * into a *copy* of the payload on its way to the renderer (the cached
 * snapshot in tabs.ts is reused across frames and must never be mutated).
 */
import {
  FLAG_UNDERLINE,
  FLAG_WIDE,
  localOpen,
  type RenderPayload,
} from "../ipc";
import { buildRowText, detectUrls, type RowText } from "../lib/urlDetect";

export type LinkSource = "osc8" | "regex";

interface LinkSpan {
  viewportRow: number;
  c0: number;
  c1: number; // inclusive
}

export interface LinkHit {
  url: string;
  source: LinkSource;
  spans: LinkSpan[];
}

interface LinkHover extends LinkHit {
  tabId: number;
  generation: number;
}

let hover: LinkHover | null = null;
/** Last cell the pointer was seen over (+ the generation it was last
 *  hit-tested against), kept so new render generations can re-run the
 *  hit-test under a still pointer (output arriving, scrolling) — and only
 *  new generations, not every repaint. */
let lastPointerCell: {
  tabId: number;
  col: number;
  viewportRow: number;
  generation: number;
} | null = null;

/** How far the regex hit-test chains rows in each direction when a URL looks
 *  soft-wrapped (`is_wrapped` is not on the wire, so "the boundary row is
 *  full" is the best-effort signal). */
const WRAP_CHAIN_CAP = 4;

// Row text is rebuilt at most once per (tab, generation, row) — hover moves
// within one row and repeated revalidations hit the cache.
const rowTextCache = new Map<number, { generation: number; rows: Map<number, RowText> }>();

function rowTextFor(snap: RenderPayload, row: number): RowText {
  let entry = rowTextCache.get(snap.tab_id);
  if (!entry || entry.generation !== snap.generation) {
    if (rowTextCache.size > 16) rowTextCache.clear();
    entry = { generation: snap.generation, rows: new Map() };
    rowTextCache.set(snap.tab_id, entry);
  }
  let rt = entry.rows.get(row);
  if (!rt) {
    rt = buildRowText(snap.cells, snap.cols, row);
    entry.rows.set(row, rt);
  }
  return rt;
}

/** Whether the row's last column holds visible text — the signal that the
 *  line may continue onto the next viewport row. */
function rowFull(snap: RenderPayload, row: number): boolean {
  const cell = snap.cells[row * snap.cols + snap.cols - 1];
  return !!cell && cell.ch !== 0;
}

/** Widen a span's tail over the spacer cell of a trailing wide glyph so the
 *  underline covers both halves. */
function extendOverWideTail(snap: RenderPayload, row: number, c1: number): number {
  const cell = snap.cells[row * snap.cols + c1];
  if (cell && cell.flags & FLAG_WIDE && c1 + 1 < snap.cols) return c1 + 1;
  return c1;
}

function osc8LinkAt(snap: RenderPayload, col: number, viewportRow: number): LinkHit | null {
  const hit = snap.link_spans.find(
    (s) => s.row === viewportRow && col >= s.c0 && col <= s.c1,
  );
  if (!hit) return null;
  const url = snap.links[hit.link];
  if (!url) return null;
  // All spans of the same URI light up together so a wrapped link
  // underlines fully no matter which fragment is hovered.
  const spans = snap.link_spans
    .filter((s) => s.link === hit.link)
    .map((s) => ({
      viewportRow: s.row,
      c0: s.c0,
      c1: extendOverWideTail(snap, s.row, s.c1),
    }));
  return { url, source: "osc8", spans };
}

function regexLinkAt(snap: RenderPayload, col: number, viewportRow: number): LinkHit | null {
  // Chain visually-continuing rows around the hovered one so URLs that
  // soft-wrap are matched whole (best-effort, capped).
  let r0 = viewportRow;
  while (r0 > 0 && viewportRow - r0 < WRAP_CHAIN_CAP && rowFull(snap, r0 - 1)) r0--;
  let r1 = viewportRow;
  while (r1 < snap.rows - 1 && r1 - viewportRow < WRAP_CHAIN_CAP && rowFull(snap, r1)) r1++;

  const rowTexts: RowText[] = [];
  const offsets: number[] = [];
  let joined = "";
  for (let r = r0; r <= r1; r++) {
    const rt = rowTextFor(snap, r);
    offsets.push(joined.length);
    rowTexts.push(rt);
    joined += rt.text;
  }

  // Text index of the hovered cell: its row offset plus the largest local
  // index whose source column is <= col (a spacer-tail col resolves to its
  // wide lead).
  const hoveredRt = rowTexts[viewportRow - r0];
  if (hoveredRt.colOf.length === 0) return null;
  let local = hoveredRt.colOf.length - 1;
  while (local > 0 && hoveredRt.colOf[local] > col) local--;
  const hoverIdx = offsets[viewportRow - r0] + local;

  const match = detectUrls(joined).find(
    (m) => hoverIdx >= m.startIdx && hoverIdx < m.endIdx,
  );
  if (!match) return null;

  // Project the match back onto cells, one span per touched row.
  const byRow = new Map<number, { c0: number; c1: number }>();
  for (let idx = match.startIdx; idx < match.endIdx; idx++) {
    let ri = rowTexts.length - 1;
    while (ri > 0 && offsets[ri] > idx) ri--;
    const cellCol = rowTexts[ri].colOf[idx - offsets[ri]];
    if (cellCol === undefined) continue;
    const row = r0 + ri;
    const span = byRow.get(row);
    if (!span) byRow.set(row, { c0: cellCol, c1: cellCol });
    else {
      span.c0 = Math.min(span.c0, cellCol);
      span.c1 = Math.max(span.c1, cellCol);
    }
  }
  const spans = [...byRow.entries()].map(([row, s]) => ({
    viewportRow: row,
    c0: s.c0,
    c1: extendOverWideTail(snap, row, s.c1),
  }));
  return { url: match.url, source: "regex", spans };
}

export function findLinkAt(
  snap: RenderPayload,
  col: number,
  viewportRow: number,
): LinkHit | null {
  if (viewportRow < 0 || viewportRow >= snap.rows || col < 0 || col >= snap.cols) {
    return null;
  }
  return osc8LinkAt(snap, col, viewportRow) ?? regexLinkAt(snap, col, viewportRow);
}

function sameHit(a: LinkHover | null, b: LinkHover | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.tabId === b.tabId &&
    a.url === b.url &&
    a.spans.length === b.spans.length &&
    a.spans.every(
      (s, i) =>
        s.viewportRow === b.spans[i].viewportRow &&
        s.c0 === b.spans[i].c0 &&
        s.c1 === b.spans[i].c1,
    )
  );
}

/** Re-run the hit-test for the pointer's cell. Returns whether the visible
 *  hover (underline/cursor) changed and a repaint is needed. */
export function updateLinkHover(
  snap: RenderPayload,
  col: number,
  viewportRow: number,
): boolean {
  lastPointerCell = {
    tabId: snap.tab_id,
    col,
    viewportRow,
    generation: snap.generation,
  };
  const hit = findLinkAt(snap, col, viewportRow);
  const next: LinkHover | null = hit
    ? { ...hit, tabId: snap.tab_id, generation: snap.generation }
    : null;
  const changed = !sameHit(hover, next);
  hover = next;
  return changed;
}

export function clearLinkHover(): boolean {
  lastPointerCell = null;
  const had = hover !== null;
  hover = null;
  return had;
}

export function hoverCursor(): "pointer" | "" {
  return hover ? "pointer" : "";
}

/** Called from the draw path: when a new generation arrives for the tab under
 *  the pointer, recompute the hover so the underline follows scroll/output or
 *  clears. Returns whether it changed (caller syncs the CSS cursor). */
export function revalidateLinkHover(snap: RenderPayload): boolean {
  if (!lastPointerCell || lastPointerCell.tabId !== snap.tab_id) return false;
  if (lastPointerCell.generation === snap.generation) return false;
  return updateLinkHover(snap, lastPointerCell.col, lastPointerCell.viewportRow);
}

/** Underline the hovered link by decorating a copy of the payload on its way
 *  to the renderer. Identity when the hover doesn't apply to this payload —
 *  a stale generation renders undecorated rather than misplaced. */
export function decoratePayloadForHover(snap: RenderPayload): RenderPayload {
  if (!hover || hover.tabId !== snap.tab_id || hover.generation !== snap.generation) {
    return snap;
  }
  const cells = snap.cells.slice();
  for (const span of hover.spans) {
    for (let col = span.c0; col <= span.c1; col++) {
      const i = span.viewportRow * snap.cols + col;
      const cell = cells[i];
      if (cell) cells[i] = { ...cell, flags: cell.flags | FLAG_UNDERLINE };
    }
  }
  return { ...snap, cells };
}

/** URL under the most recent right-click, remembered across the context
 *  menu's backend round-trip: the menu only reports "copy_link was clicked"
 *  (`menu:copy_link`), so the frontend keeps the URL it hit-tested when it
 *  opened the menu. */
let contextLink: string | null = null;

export function setContextLink(url: string | null): void {
  contextLink = url;
}

export function copyContextLink(): void {
  if (!contextLink) return;
  void navigator.clipboard
    .writeText(contextLink)
    .catch((err) => console.error("copy link failed:", err));
}

/** Open a detected link with the OS default handler. Schemes are
 *  allowlisted: http/https/mailto from either source, file:// only from
 *  OSC 8 (what `ls --hyperlink` emits — never regex-derived from text). */
export function openDetectedUrl(url: string, source: LinkSource): void {
  const allowed =
    /^(https?|mailto):/i.test(url) || (source === "osc8" && /^file:/i.test(url));
  if (!allowed) {
    console.warn("refusing to open link with disallowed scheme:", url);
    return;
  }
  void localOpen(url).catch((err) => console.error("failed to open link:", err));
}

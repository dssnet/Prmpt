/**
 * Plain-text URL detection over the terminal cell grid.
 *
 * Pure helpers: rebuild a row's text from `CellWire`s (keeping a text-index →
 * column map so regex matches can be projected back onto cells) and find
 * http(s) URLs in it. OSC 8 hyperlinks don't pass through here — they arrive
 * pre-resolved in `RenderPayload.link_spans`.
 */
import { FLAG_SPACER_TAIL, type CellWire } from "../ipc";

/** Scheme-anchored URL candidate: everything up to whitespace or a character
 *  that practically never belongs to a URL in prose (`<>"'` + backtick —
 *  typical delimiters when a URL is quoted or embedded in markup). Trailing
 *  punctuation is handled separately by `trimUrlMatch`. */
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/** Punctuation that ends a sentence around a URL far more often than it ends
 *  the URL itself. Stripped iteratively from the end of a match. */
const TRAILING_PUNCT = new Set([".", ",", ";", ":", "!", "?", "'", '"']);

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Strip trailing sentence punctuation and *unbalanced* closing brackets.
 *  Balanced ones survive so `https://en.wikipedia.org/wiki/Bracket_(disambiguation)`
 *  keeps its paren while `(https://example.com)` loses the stray `)`. */
export function trimUrlMatch(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url[url.length - 1];
    if (last === undefined) break;
    if (TRAILING_PUNCT.has(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener) {
      let depth = 0;
      for (const ch of url) {
        if (ch === opener) depth++;
        else if (ch === last) depth--;
      }
      if (depth < 0) {
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return url;
}

export interface RowText {
  text: string;
  /** Source column of each `text` index. */
  colOf: number[];
}

/** Rebuild one viewport row's text. Spacer tails (second half of a wide
 *  glyph) are skipped; blank cells (ch=0) become spaces so they terminate URL
 *  matches like the visual gap they are. */
export function buildRowText(cells: CellWire[], cols: number, row: number): RowText {
  let text = "";
  const colOf: number[] = [];
  const base = row * cols;
  for (let col = 0; col < cols; col++) {
    const cell = cells[base + col];
    if (!cell || cell.flags & FLAG_SPACER_TAIL) continue;
    text += cell.ch === 0 ? " " : String.fromCodePoint(cell.ch);
    colOf.push(col);
  }
  return { text, colOf };
}

export interface UrlMatch {
  url: string;
  startIdx: number;
  /** Exclusive, after trailing-punctuation trim. */
  endIdx: number;
}

export function detectUrls(text: string): UrlMatch[] {
  const out: UrlMatch[] = [];
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
    const url = trimUrlMatch(m[0]);
    // Anything must remain after the scheme — trimming can eat a bare "http://.".
    if (/^https?:\/\/./i.test(url)) {
      out.push({ url, startIdx: m.index, endIdx: m.index + url.length });
    }
  }
  return out;
}

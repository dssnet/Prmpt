/**
 * Ranking for the host-list search box. Pure — no Vue, no DB access — so the
 * matching rules are unit-testable (`hostSearch.test.ts`) instead of only
 * observable by typing into the running app.
 *
 * Two-tier matching, because a host list is not a command palette: people type
 * a fragment they *know* is in the name or address ("web", "10.0.1", "root@"),
 * so a literal substring must always outrank a scattered subsequence. Fuzzy
 * (borrowed from the command palette) is the fallback that still finds
 * "prod-db-01" from "pdb" — it just never beats a real substring hit.
 *
 * A query is split on whitespace and every term must match *some* field (AND).
 * That's what makes "web prod" work when the name carries one word and the
 * group carries the other.
 */

import type { SshHostRow } from "../db";
import { fuzzyScore } from "../state/commandPalette";

/** Substring hits start an order of magnitude above the fuzzy score range, so
 *  no amount of subsequence bonus can promote a scattered match past one. */
const SUBSTRING = 1000;

/** Score one term against one field. -1 = no match. */
function fieldScore(term: string, text: string): number {
  if (!text) return -1;
  const t = text.toLowerCase();
  const at = t.indexOf(term);
  if (at === 0) return SUBSTRING * 2; // prefix — the strongest signal
  if (at > 0) {
    // Word-boundary hits ("db" in "prod-db") read as intentional; mid-word
    // ones are weaker the further right they sit.
    const boundary = /[\s/\-_.:@]/.test(t[at - 1]) ? 300 : 0;
    return SUBSTRING + boundary - Math.min(at, 100);
  }
  return fuzzyScore(term, t);
}

/** The searchable fields of a host, each with its weight. The combined
 *  `user@host:port` form is listed alongside its parts so a query typed the way
 *  the row is *displayed* ("root@10.0") matches too. */
function fieldsOf(host: SshHostRow, groupLabel: string | null): [string, number][] {
  return [
    [host.label, 3],
    [host.hostname, 3],
    [`${host.username}@${host.hostname}:${host.port}`, 2],
    [host.username, 2],
    [String(host.port), 1],
    [groupLabel ?? "", 1],
    [host.key_label ?? "", 1],
  ];
}

/**
 * How well `host` matches `query`. Higher is better; -1 means "no match, hide
 * it". An empty query scores 0 for everything, which keeps the caller's
 * original (alphabetical) ordering intact.
 */
export function scoreHost(
  query: string,
  host: SshHostRow,
  groupLabel: string | null = null,
): number {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;

  const fields = fieldsOf(host, groupLabel);
  let total = 0;
  for (const term of terms) {
    let best = -1;
    for (const [text, weight] of fields) {
      const s = fieldScore(term, text);
      if (s >= 0) best = Math.max(best, s * weight);
    }
    if (best < 0) return -1; // every term must land somewhere
    total += best;
  }
  return total;
}

/**
 * Filter + rank `hosts` by `query`. Ties keep the input order (the DB's
 * `ORDER BY label`), so an empty or equally-matching query looks unsorted
 * rather than shuffled. `groupLabelOf` supplies the group name for a host's
 * `group_id` — group names are searchable but live in a different table.
 */
export function searchHosts(
  query: string,
  hosts: SshHostRow[],
  groupLabelOf: (groupId: number | null) => string | null,
): SshHostRow[] {
  if (!query.trim()) return hosts;
  const scored: { host: SshHostRow; score: number; i: number }[] = [];
  hosts.forEach((host, i) => {
    const score = scoreHost(query, host, groupLabelOf(host.group_id));
    if (score >= 0) scored.push({ host, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.host);
}

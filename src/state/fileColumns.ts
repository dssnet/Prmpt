/**
 * Shared column widths for the file-browser tables (local + SFTP), so every
 * pane lines up. Like other window-layout state these are per-machine
 * ephemera and live in localStorage, not config.toml.
 */
import { ref, type Ref } from "vue";

const KEY = "prmpt.fileColumns";
const MIN_W = 48;
const MAX_W = 400;

export type FileColumn = "size" | "changed" | "created";

const DEFAULTS: Record<FileColumn, number> = { size: 64, changed: 88, created: 88 };

function loadWidths(): Record<FileColumn, number> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<FileColumn, number>>;
      return {
        size: clamp(Number(parsed.size) || DEFAULTS.size),
        changed: clamp(Number(parsed.changed) || DEFAULTS.changed),
        created: clamp(Number(parsed.created) || DEFAULTS.created),
      };
    }
  } catch {
    /* corrupted value — fall back to defaults */
  }
  return { ...DEFAULTS };
}

function clamp(w: number): number {
  return Math.min(MAX_W, Math.max(MIN_W, w));
}

const widths = loadWidths();

export const columnWidth: Record<FileColumn, Ref<number>> = {
  size: ref(widths.size),
  changed: ref(widths.changed),
  created: ref(widths.created),
};

function persist(): void {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      size: columnWidth.size.value,
      changed: columnWidth.changed.value,
      created: columnWidth.created.value,
    }),
  );
}

/** Drag handler for the grip on a column's left edge. The name column is the
 *  only auto-sized one, so dragging the divider left widens this column. */
export function startColumnResize(col: FileColumn, e: MouseEvent): void {
  e.preventDefault();
  const startX = e.clientX;
  const startW = columnWidth[col].value;
  const prevCursor = document.body.style.cursor;
  const prevSelect = document.body.style.userSelect;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  const onMove = (ev: MouseEvent) => {
    columnWidth[col].value = clamp(startW - (ev.clientX - startX));
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.cursor = prevCursor;
    document.body.style.userSelect = prevSelect;
    persist();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

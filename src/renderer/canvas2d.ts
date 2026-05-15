import {
  CURSOR_BAR,
  CURSOR_BLOCK,
  CURSOR_BLOCK_HOLLOW,
  CURSOR_UNDERLINE,
  FLAG_BOLD,
  FLAG_FAINT,
  FLAG_ITALIC,
  FLAG_SPACER_TAIL,
  FLAG_STRIKETHROUGH,
  FLAG_UNDERLINE,
  type Config,
  type RenderPayload,
  type ThemeConfig,
} from "../ipc";
import {
  measureCell,
  type CursorMode,
  type FontMetrics,
  type PaneViewport,
  type Renderer,
  type SelectionRange,
} from "./index";

function rgbToCss(rgb: number): string {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return `rgb(${r},${g},${b})`;
}

export class Canvas2DRenderer implements Renderer {
  private ctx: CanvasRenderingContext2D;
  private m: FontMetrics;
  private cursorColor: string;

  constructor(
    private canvas: HTMLCanvasElement,
    private config: Config,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    this.m = measureCell(config, window.devicePixelRatio || 1);
    this.cursorColor = config.theme.cursor;
  }

  metrics(): FontMetrics {
    return this.m;
  }

  resize(pxWidth: number, pxHeight: number, _cols: number, _rows: number): void {
    this.canvas.width = Math.max(1, Math.round(pxWidth * this.m.dpr));
    this.canvas.height = Math.max(1, Math.round(pxHeight * this.m.dpr));
    this.canvas.style.width = `${pxWidth}px`;
    this.canvas.style.height = `${pxHeight}px`;
    this.ctx.fillStyle = this.config.theme.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  render(payload: RenderPayload, selection?: SelectionRange | null): void {
    this.paint(
      payload,
      selection ?? null,
      "full",
      this.canvas.width,
      this.canvas.height,
    );
  }

  renderInto(
    payload: RenderPayload,
    selection: SelectionRange | null,
    rect: PaneViewport,
    opts: { cursor: CursorMode },
  ): void {
    const dpr = this.m.dpr;
    const dw = Math.max(1, Math.round(rect.w * dpr));
    const dh = Math.max(1, Math.round(rect.h * dpr));
    const dx = Math.round(rect.x * dpr);
    const dy = Math.round(rect.y * dpr);
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    ctx.translate(dx, dy);
    this.paint(payload, selection, opts.cursor, dw, dh);
    ctx.restore();
  }

  beginFrame(): void {
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  endFrame(): void {
    /* no-op — 2D state is per-call (save/restore) */
  }

  private paint(
    payload: RenderPayload,
    selection: SelectionRange | null,
    cursorMode: CursorMode,
    vpW: number,
    vpH: number,
  ): void {
    const { cells, cols, rows, default_bg, cursor } = payload;
    const cw = this.m.cellWidth;
    const ch = this.m.cellHeight;
    const ctx = this.ctx;

    ctx.fillStyle = rgbToCss(default_bg);
    ctx.fillRect(0, 0, vpW, vpH);

    for (let row = 0; row < rows; row++) {
      let col = 0;
      while (col < cols) {
        const idx = row * cols + col;
        const cell = cells[idx];
        if (!cell) {
          col++;
          continue;
        }
        if (cell.bg !== default_bg) {
          ctx.fillStyle = rgbToCss(cell.bg);
          ctx.fillRect(col * cw, row * ch, cw, ch);
        }
        col++;
      }
    }

    if (selection) {
      ctx.fillStyle = "rgba(120, 160, 255, 0.35)";
      const s = selection.start;
      const e = selection.end;
      for (let row = s.row; row <= e.row && row < rows; row++) {
        const c0 = row === s.row ? s.col : 0;
        const c1Raw = row === e.row ? e.col : cols - 1;
        const c1 = Math.min(c1Raw, cols - 1);
        if (c1 >= c0) {
          ctx.fillRect(c0 * cw, row * ch, (c1 - c0 + 1) * cw, ch);
        }
      }
    }

    ctx.textBaseline = "alphabetic";
    for (let row = 0; row < rows; row++) {
      let col = 0;
      while (col < cols) {
        const idx = row * cols + col;
        const cell = cells[idx];
        if (!cell || cell.ch === 0 || cell.flags & FLAG_SPACER_TAIL) {
          col++;
          continue;
        }
        const ch_char = String.fromCodePoint(cell.ch);
        const bold = cell.flags & FLAG_BOLD;
        const italic = cell.flags & FLAG_ITALIC;
        const faint = cell.flags & FLAG_FAINT;
        const weight = bold ? "bold " : "";
        const slant = italic ? "italic " : "";
        ctx.font = `${slant}${weight}${this.config.font_size * this.m.dpr}px ${this.config.font_family}`;
        ctx.globalAlpha = faint ? 0.6 : 1.0;
        ctx.fillStyle = rgbToCss(cell.fg);
        ctx.fillText(ch_char, col * cw, row * ch + this.m.baseline);
        if (cell.flags & FLAG_UNDERLINE) {
          ctx.fillRect(col * cw, row * ch + ch - 2, cw, 1);
        }
        if (cell.flags & FLAG_STRIKETHROUGH) {
          ctx.fillRect(col * cw, row * ch + Math.floor(ch / 2), cw, 1);
        }
        col++;
      }
    }
    ctx.globalAlpha = 1.0;

    if (cursor && cursor.visible && cursorMode !== "none") {
      ctx.fillStyle = this.cursorColor;
      const x = cursor.x * cw;
      const y = cursor.y * ch;
      const effStyle =
        cursorMode === "hollow" ? CURSOR_BLOCK_HOLLOW : cursor.style;
      switch (effStyle) {
        case CURSOR_BLOCK:
          ctx.globalAlpha = 0.55;
          ctx.fillRect(x, y, cw, ch);
          ctx.globalAlpha = 1.0;
          break;
        case CURSOR_BAR:
          ctx.fillRect(x, y, 2 * this.m.dpr, ch);
          break;
        case CURSOR_UNDERLINE:
          ctx.fillRect(x, y + ch - 2 * this.m.dpr, cw, 2 * this.m.dpr);
          break;
        case CURSOR_BLOCK_HOLLOW:
          ctx.strokeStyle = this.cursorColor;
          ctx.lineWidth = 1 * this.m.dpr;
          ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
          break;
      }
    }
  }

  updateTheme(theme: ThemeConfig): void {
    this.cursorColor = theme.cursor;
    this.config.theme = theme;
  }

  dispose(): void {
    /* no-op */
  }
}

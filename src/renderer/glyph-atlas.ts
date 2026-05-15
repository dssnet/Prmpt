export interface GlyphSlot {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  drawX: number;
  drawY: number;
  drawW: number;
  drawH: number;
  isColor: boolean;
}

export const STYLE_REG = 0;
export const STYLE_BOLD = 1;
export const STYLE_ITALIC = 2;
export const STYLE_BOLD_ITALIC = 3;

const ATLAS_SIZE = 2048;
// Pad between glyphs so neighbours can't bleed into a slot even if a
// glyph's rasterised shape exceeds its declared advance width.
const SLOT_PAD = 1;

export class GlyphAtlas {
  readonly size = ATLAS_SIZE;
  private slots = new Map<string, GlyphSlot>();
  private nextX = 0;
  private nextY = 0;
  private rowH = 0;
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private cellWidth: number;
  private cellHeight: number;
  private baseline: number;
  private fontPx: number;
  private fontFamily: string;
  private fontKey: string;
  private dpr: number;
  dirty = true;

  constructor(opts: {
    cellWidth: number;
    cellHeight: number;
    baseline: number;
    fontPx: number;
    fontFamily: string;
    dpr: number;
  }) {
    this.cellWidth = opts.cellWidth;
    this.cellHeight = opts.cellHeight;
    this.baseline = opts.baseline;
    this.fontPx = opts.fontPx;
    this.fontFamily = opts.fontFamily;
    this.dpr = opts.dpr;
    this.fontKey = `${this.fontPx}px ${this.fontFamily}`;
    const canvas: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(ATLAS_SIZE, ATLAS_SIZE)
        : Object.assign(document.createElement("canvas"), {
            width: ATLAS_SIZE,
            height: ATLAS_SIZE,
          });
    this.canvas = canvas;
    const ctx = (canvas.getContext("2d") as CanvasRenderingContext2D | null);
    if (!ctx) throw new Error("could not create atlas 2d context");
    this.ctx = ctx;
    this.ctx.textBaseline = "alphabetic";
    this.ctx.fillStyle = "#ffffff";
    this.ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  }

  get source(): TexImageSource {
    return this.canvas as unknown as TexImageSource;
  }

  get(codepoint: number, styleVariant: number): GlyphSlot {
    const key = `${codepoint}|${styleVariant}`;
    const cached = this.slots.get(key);
    if (cached) return cached;
    return this.bake(codepoint, styleVariant, key);
  }

  private bake(codepoint: number, styleVariant: number, key: string): GlyphSlot {
    const w = this.cellWidth;
    const h = this.cellHeight;
    const stride = w + SLOT_PAD;
    const rowStride = h + SLOT_PAD;
    if (this.nextX + w > ATLAS_SIZE) {
      this.nextX = 0;
      this.nextY += this.rowH;
      this.rowH = 0;
    }
    if (this.nextY + h > ATLAS_SIZE) {
      console.warn("glyph atlas exhausted; reusing slot 0");
      this.nextX = 0;
      this.nextY = 0;
      this.rowH = 0;
    }
    const x = this.nextX;
    const y = this.nextY;
    this.nextX += stride;
    this.rowH = Math.max(this.rowH, rowStride);

    this.ctx.clearRect(x, y, w, h);
    const isBold = styleVariant & STYLE_BOLD;
    const isItalic = styleVariant & STYLE_ITALIC;
    const slant = isItalic ? "italic " : "";
    const weight = isBold ? "bold " : "";
    this.ctx.font = `${slant}${weight}${this.fontKey}`;
    this.ctx.fillStyle = "#ffffff";
    this.ctx.textBaseline = "alphabetic";
    const ch = codepoint === 0 ? " " : String.fromCodePoint(codepoint);
    this.ctx.fillText(ch, x, y + this.baseline);

    const isColor = this.detectColor(x, y, w, h);

    const slot: GlyphSlot = {
      u0: x / ATLAS_SIZE,
      v0: y / ATLAS_SIZE,
      u1: (x + w) / ATLAS_SIZE,
      v1: (y + h) / ATLAS_SIZE,
      drawX: 0,
      drawY: 0,
      drawW: w,
      drawH: h,
      isColor,
    };
    this.slots.set(key, slot);
    this.dirty = true;
    return slot;
  }

  clear(): void {
    this.slots.clear();
    this.nextX = 0;
    this.nextY = 0;
    this.rowH = 0;
    this.ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    this.dirty = true;
  }

  // Used by the renderer to know cell dims since atlas owns the rasterization.
  cellMetrics() {
    return {
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      baseline: this.baseline,
      dpr: this.dpr,
    };
  }

  // Sample a few points in the rasterized cell; if any pixel has chroma
  // (R/G/B not equal), this is a color glyph (e.g. emoji rendered from
  // Noto Color Emoji's CBDT bitmaps). White-on-transparent monochrome glyphs
  // have R == G == B and can be tinted with the cell foreground color.
  private detectColor(x: number, y: number, w: number, h: number): boolean {
    let data: Uint8ClampedArray;
    try {
      data = this.ctx.getImageData(x, y, w, h).data;
    } catch {
      return false;
    }
    const total = w * h;
    const step = Math.max(1, Math.floor(total / 64));
    for (let i = 0; i < total; i += step) {
      const p = i * 4;
      const a = data[p + 3];
      if (a < 32) continue;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      if (Math.abs(r - g) > 6 || Math.abs(g - b) > 6 || Math.abs(r - b) > 6) {
        return true;
      }
    }
    return false;
  }
}

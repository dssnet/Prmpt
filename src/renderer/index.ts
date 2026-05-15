import type { Config, RenderPayload, ThemeConfig } from "../ipc";

export interface FontMetrics {
  cellWidth: number;
  cellHeight: number;
  baseline: number;
  dpr: number;
}

export interface SelectionRange {
  start: { col: number; row: number };
  end: { col: number; row: number };
}

/** CSS-px rect, relative to the canvas/host top-left. */
export interface PaneViewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CursorMode = "full" | "hollow" | "none";

export interface Renderer {
  resize(pxWidth: number, pxHeight: number, cols: number, rows: number): void;
  render(payload: RenderPayload, selection?: SelectionRange | null): void;
  /** Draw one pane into a sub-rectangle of the canvas. The caller must wrap a
   *  set of these in beginFrame()/endFrame(). */
  renderInto(
    payload: RenderPayload,
    selection: SelectionRange | null,
    rect: PaneViewport,
    opts: { cursor: CursorMode },
  ): void;
  /** Prepare the canvas for a multi-pane frame (clears gutters). */
  beginFrame(): void;
  /** Restore full-canvas viewport/scissor after a multi-pane frame. */
  endFrame(): void;
  metrics(): FontMetrics;
  updateTheme(theme: ThemeConfig): void;
  dispose(): void;
}

export function measureCell(config: Config, dpr: number): FontMetrics {
  const probe = document.createElement("canvas");
  const ctx = probe.getContext("2d")!;
  const fontSizeCss = config.font_size;
  ctx.font = `${fontSizeCss}px ${config.font_family}`;
  ctx.textBaseline = "alphabetic";
  const measurement = ctx.measureText("M");
  const cellWidthCss = Math.max(1, Math.round(measurement.width));
  const cellHeightCss = Math.max(
    1,
    Math.round(fontSizeCss * config.line_height),
  );
  const ascent = measurement.actualBoundingBoxAscent || fontSizeCss * 0.8;
  const baselineCss = Math.round((cellHeightCss + ascent) / 2);
  return {
    cellWidth: Math.round(cellWidthCss * dpr),
    cellHeight: Math.round(cellHeightCss * dpr),
    baseline: Math.round(baselineCss * dpr),
    dpr,
  };
}

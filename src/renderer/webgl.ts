import {
  CURSOR_BAR,
  CURSOR_BLOCK,
  CURSOR_BLOCK_HOLLOW,
  CURSOR_UNDERLINE,
  FLAG_BOLD,
  FLAG_ITALIC,
  FLAG_SPACER_TAIL,
  type Config,
  type RenderPayload,
  type ThemeConfig,
} from "../ipc";
import { GlyphAtlas, STYLE_BOLD, STYLE_BOLD_ITALIC, STYLE_ITALIC, STYLE_REG } from "./glyph-atlas";
import {
  measureCell,
  type CursorMode,
  type FontMetrics,
  type PaneViewport,
  type Renderer,
  type SelectionRange,
} from "./index";
import {
  CURSOR_FRAGMENT_SRC,
  CURSOR_VERTEX_SRC,
  FRAGMENT_SRC,
  VERTEX_SRC,
} from "./shaders";

const INSTANCE_FLOATS = 2 + 4 + 4 + 4 + 1; // pos, uv, fg, bg, flags = 15

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`program link failed: ${log}`);
  }
  return p;
}

function styleVariant(flags: number): number {
  let v = STYLE_REG;
  if (flags & FLAG_BOLD) v |= STYLE_BOLD;
  if (flags & FLAG_ITALIC) v |= STYLE_ITALIC;
  return v as 0 | 1 | 2 | typeof STYLE_BOLD_ITALIC;
}

function hexToRgba(hex: string): [number, number, number, number] {
  let h = hex.trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [r, g, b, 1];
}

function u32ToRgba(c: number): [number, number, number, number] {
  return [((c >> 16) & 0xff) / 255, ((c >> 8) & 0xff) / 255, (c & 0xff) / 255, 1];
}

export class WebGLRenderer implements Renderer {
  private gl: WebGL2RenderingContext;
  private m: FontMetrics;
  private atlas: GlyphAtlas;
  private program: WebGLProgram;
  private cursorProgram: WebGLProgram;
  private quadVBO: WebGLBuffer;
  private instanceVBO: WebGLBuffer;
  private cursorVAO: WebGLVertexArrayObject;
  private cellVAO: WebGLVertexArrayObject;
  private atlasTex: WebGLTexture;
  private uniforms: {
    viewportPx: WebGLUniformLocation;
    cellPx: WebGLUniformLocation;
    underlineY: WebGLUniformLocation;
    underlineH: WebGLUniformLocation;
    strikeY: WebGLUniformLocation;
    strikeH: WebGLUniformLocation;
    maskRect: WebGLUniformLocation;
    maskRadius: WebGLUniformLocation;
  };
  private cursorUniforms: {
    viewportPx: WebGLUniformLocation;
    originPx: WebGLUniformLocation;
    sizePx: WebGLUniformLocation;
    color: WebGLUniformLocation;
    style: WebGLUniformLocation;
    maskRect: WebGLUniformLocation;
    maskRadius: WebGLUniformLocation;
  };
  // Active pane clip, in framebuffer px (gl_FragCoord space). radius <= 0
  // disables it (full-canvas / single-tab draws).
  private maskRect: [number, number, number, number] = [0, 0, 0, 0];
  private maskRadiusPx = 0;
  private instanceCapacity = 0;
  private instanceBuf: Float32Array = new Float32Array(0);
  private cursorColor: [number, number, number, number];
  // Whole-canvas clear color. Painted into the divider gutters between
  // workspace panes; theme background so they don't read as black lines.
  private bgColor: [number, number, number, number];

  constructor(
    private canvas: HTMLCanvasElement,
    config: Config,
  ) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;

    this.m = measureCell(config, window.devicePixelRatio || 1);
    this.atlas = new GlyphAtlas({
      cellWidth: this.m.cellWidth,
      cellHeight: this.m.cellHeight,
      baseline: this.m.baseline,
      fontPx: config.font_size * this.m.dpr,
      fontFamily: config.font_family,
      dpr: this.m.dpr,
    });

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    this.program = linkProgram(gl, vs, fs);
    const cvs = compileShader(gl, gl.VERTEX_SHADER, CURSOR_VERTEX_SRC);
    const cfs = compileShader(gl, gl.FRAGMENT_SHADER, CURSOR_FRAGMENT_SRC);
    this.cursorProgram = linkProgram(gl, cvs, cfs);

    this.quadVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    this.instanceVBO = gl.createBuffer()!;

    this.cellVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.cellVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
    const STRIDE = INSTANCE_FLOATS * 4;
    let off = 0;
    // location 1: aCellPos vec2
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, off);
    gl.vertexAttribDivisor(1, 1);
    off += 2 * 4;
    // location 2: aUV vec4
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE, off);
    gl.vertexAttribDivisor(2, 1);
    off += 4 * 4;
    // location 3: aFg vec4
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, STRIDE, off);
    gl.vertexAttribDivisor(3, 1);
    off += 4 * 4;
    // location 4: aBg vec4
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, STRIDE, off);
    gl.vertexAttribDivisor(4, 1);
    off += 4 * 4;
    // location 5: aFlags float
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, STRIDE, off);
    gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);

    this.cursorVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.cursorVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.atlasTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    // NEAREST: the atlas is baked at native pixel scale, so LINEAR would
    // only blur the text. More importantly, LINEAR samples neighboring
    // texels at slot boundaries — with tightly-packed glyphs, that bleeds
    // the next glyph's edge into the current cell (visible as a vertical
    // bar between adjacent characters).
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this.atlas.size,
      this.atlas.size,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );

    this.uniforms = {
      viewportPx: gl.getUniformLocation(this.program, "uViewportPx")!,
      cellPx: gl.getUniformLocation(this.program, "uCellPx")!,
      underlineY: gl.getUniformLocation(this.program, "uUnderlineY")!,
      underlineH: gl.getUniformLocation(this.program, "uUnderlineH")!,
      strikeY: gl.getUniformLocation(this.program, "uStrikethroughY")!,
      strikeH: gl.getUniformLocation(this.program, "uStrikethroughH")!,
      maskRect: gl.getUniformLocation(this.program, "uMaskRect")!,
      maskRadius: gl.getUniformLocation(this.program, "uMaskRadius")!,
    };
    this.cursorUniforms = {
      viewportPx: gl.getUniformLocation(this.cursorProgram, "uViewportPx")!,
      originPx: gl.getUniformLocation(this.cursorProgram, "uOriginPx")!,
      sizePx: gl.getUniformLocation(this.cursorProgram, "uSizePx")!,
      color: gl.getUniformLocation(this.cursorProgram, "uColor")!,
      style: gl.getUniformLocation(this.cursorProgram, "uStyle")!,
      maskRect: gl.getUniformLocation(this.cursorProgram, "uMaskRect")!,
      maskRadius: gl.getUniformLocation(this.cursorProgram, "uMaskRadius")!,
    };

    this.cursorColor = hexToRgba(config.theme.cursor);
    this.bgColor = hexToRgba(config.theme.background);
  }

  metrics(): FontMetrics {
    return this.m;
  }

  resize(pxWidth: number, pxHeight: number, cols: number, rows: number): void {
    const w = Math.max(1, Math.round(pxWidth * this.m.dpr));
    const h = Math.max(1, Math.round(pxHeight * this.m.dpr));
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${pxWidth}px`;
    this.canvas.style.height = `${pxHeight}px`;
    this.gl.viewport(0, 0, w, h);
    this.ensureCapacity(cols * rows);
  }

  private ensureCapacity(cells: number) {
    if (cells <= this.instanceCapacity) return;
    const cap = Math.max(cells, this.instanceCapacity * 2, 1024);
    this.instanceBuf = new Float32Array(cap * INSTANCE_FLOATS);
    this.instanceCapacity = cap;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceBuf.byteLength, gl.DYNAMIC_DRAW);
  }

  render(payload: RenderPayload, selection?: SelectionRange | null): void {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.maskRect = [0, 0, this.canvas.width, this.canvas.height];
    this.maskRadiusPx = 0;
    this.paintGrid(
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
    opts: { cursor: CursorMode; cornerRadius?: number },
  ): void {
    const gl = this.gl;
    const dpr = this.m.dpr;
    const dw = Math.max(1, Math.round(rect.w * dpr));
    const dh = Math.max(1, Math.round(rect.h * dpr));
    const dx = Math.round(rect.x * dpr);
    // GL's framebuffer origin is bottom-left; the layout rect is top-left.
    // Derive dy from canvas height so panes butt cleanly against the gutter.
    const dy = this.canvas.height - Math.round(rect.y * dpr) - dh;
    gl.enable(gl.SCISSOR_TEST);
    gl.viewport(dx, dy, dw, dh);
    gl.scissor(dx, dy, dw, dh);
    this.maskRect = [dx, dy, dw, dh];
    const r = Math.round((opts.cornerRadius ?? 0) * dpr);
    this.maskRadiusPx = Math.max(0, Math.min(r, Math.floor(Math.min(dw, dh) / 2)));
    this.paintGrid(payload, selection, opts.cursor, dw, dh);
  }

  private pushMask(u: {
    maskRect: WebGLUniformLocation;
    maskRadius: WebGLUniformLocation;
  }): void {
    const gl = this.gl;
    const m = this.maskRect;
    gl.uniform4f(u.maskRect, m[0], m[1], m[2], m[3]);
    gl.uniform1f(u.maskRadius, this.maskRadiusPx);
  }

  beginFrame(): void {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const b = this.bgColor;
    gl.clearColor(b[0], b[1], b[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  endFrame(): void {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private paintGrid(
    payload: RenderPayload,
    selection: SelectionRange | null,
    cursorMode: CursorMode,
    vpW: number,
    vpH: number,
  ): void {
    const { cells, cols, rows, default_fg, default_bg, cursor } = payload;
    const total = cols * rows;
    this.ensureCapacity(total);

    const buf = this.instanceBuf;
    const bg0 = u32ToRgba(default_bg);
    const fg0 = u32ToRgba(default_fg);
    let p = 0;
    let atlasWasDirty = this.atlas.dirty;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cell = cells[row * cols + col];
        let ch = 0;
        let flags = 0;
        let fg = fg0;
        let bg = bg0;
        if (cell) {
          ch = cell.ch;
          flags = cell.flags;
          fg = u32ToRgba(cell.fg);
          bg = u32ToRgba(cell.bg);
        }
        const slot =
          flags & FLAG_SPACER_TAIL
            ? this.atlas.get(0, STYLE_REG)
            : this.atlas.get(ch === 0 ? 32 : ch, styleVariant(flags));
        if (slot.isColor) flags |= 256;
        buf[p++] = col;
        buf[p++] = row;
        buf[p++] = slot.u0;
        buf[p++] = slot.v0;
        buf[p++] = slot.u1;
        buf[p++] = slot.v1;
        buf[p++] = fg[0];
        buf[p++] = fg[1];
        buf[p++] = fg[2];
        buf[p++] = fg[3];
        buf[p++] = bg[0];
        buf[p++] = bg[1];
        buf[p++] = bg[2];
        buf[p++] = bg[3];
        buf[p++] = flags;
      }
    }

    const gl = this.gl;
    if (this.atlas.dirty || atlasWasDirty) {
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.atlas.source as TexImageSource,
      );
      this.atlas.dirty = false;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf, 0, total * INSTANCE_FLOATS);

    // Pane background as a mask-clipped quad instead of gl.clear, so the
    // rounded corners aren't square-filled. beginFrame already cleared the
    // whole canvas to the theme bg, which shows through the rounded-off
    // corner. (radius <= 0 → full rect, identical to the old clear.)
    gl.disable(gl.BLEND);
    gl.useProgram(this.cursorProgram);
    gl.bindVertexArray(this.cursorVAO);
    gl.uniform2f(this.cursorUniforms.viewportPx, vpW, vpH);
    gl.uniform2f(this.cursorUniforms.originPx, 0, 0);
    gl.uniform2f(this.cursorUniforms.sizePx, vpW, vpH);
    gl.uniform4f(this.cursorUniforms.color, bg0[0], bg0[1], bg0[2], 1);
    gl.uniform1i(this.cursorUniforms.style, 0);
    this.pushMask(this.cursorUniforms);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.cellVAO);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.uniform2f(this.uniforms.viewportPx, vpW, vpH);
    gl.uniform2f(this.uniforms.cellPx, this.m.cellWidth, this.m.cellHeight);
    gl.uniform1f(this.uniforms.underlineY, 1 - 2 / this.m.cellHeight);
    gl.uniform1f(this.uniforms.underlineH, 1 / this.m.cellHeight);
    gl.uniform1f(this.uniforms.strikeY, 0.5 - 0.5 / this.m.cellHeight);
    gl.uniform1f(this.uniforms.strikeH, 1 / this.m.cellHeight);
    this.pushMask(this.uniforms);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, total);
    gl.bindVertexArray(null);

    if (selection) {
      this.drawSelection(selection, cols, rows, vpW, vpH);
    }

    if (cursor && cursor.visible && cursorMode !== "none") {
      gl.useProgram(this.cursorProgram);
      gl.bindVertexArray(this.cursorVAO);
      gl.uniform2f(this.cursorUniforms.viewportPx, vpW, vpH);
      this.pushMask(this.cursorUniforms);
      const cw = this.m.cellWidth;
      const ch = this.m.cellHeight;
      const ox = cursor.x * cw;
      const oy = cursor.y * ch;
      let sx = cw;
      let sy = ch;
      let style = 0;
      // An unfocused workspace pane still shows where its cursor is, but as a
      // hollow outline so only the focused pane reads as "active".
      const effStyle = cursorMode === "hollow" ? CURSOR_BLOCK_HOLLOW : cursor.style;
      switch (effStyle) {
        case CURSOR_BLOCK:
          style = 0;
          break;
        case CURSOR_BAR:
          sx = Math.max(1, Math.round(2 * this.m.dpr));
          style = 1;
          break;
        case CURSOR_UNDERLINE:
          sy = Math.max(1, Math.round(2 * this.m.dpr));
          style = 2;
          break;
        case CURSOR_BLOCK_HOLLOW:
          style = 3;
          break;
      }
      if (effStyle === CURSOR_UNDERLINE) {
        gl.uniform2f(
          this.cursorUniforms.originPx,
          ox,
          oy + ch - sy,
        );
      } else {
        gl.uniform2f(this.cursorUniforms.originPx, ox, oy);
      }
      gl.uniform2f(this.cursorUniforms.sizePx, sx, sy);
      const c = this.cursorColor;
      const alpha = effStyle === CURSOR_BLOCK ? 0.55 : 1.0;
      gl.uniform4f(this.cursorUniforms.color, c[0], c[1], c[2], alpha);
      gl.uniform1i(this.cursorUniforms.style, style);
      if (alpha < 1.0) {
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    }
  }

  private drawSelection(
    sel: SelectionRange,
    cols: number,
    rows: number,
    vpW: number,
    vpH: number,
  ): void {
    const gl = this.gl;
    const cw = this.m.cellWidth;
    const ch = this.m.cellHeight;
    const s = sel.start;
    const e = sel.end;
    if (s.row >= rows) return;
    const lastRow = Math.min(e.row, rows - 1);

    gl.useProgram(this.cursorProgram);
    gl.bindVertexArray(this.cursorVAO);
    gl.uniform2f(this.cursorUniforms.viewportPx, vpW, vpH);
    gl.uniform4f(this.cursorUniforms.color, 120 / 255, 160 / 255, 255 / 255, 0.35);
    gl.uniform1i(this.cursorUniforms.style, 0);
    this.pushMask(this.cursorUniforms);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);

    const drawRect = (x: number, y: number, w: number, h: number) => {
      gl.uniform2f(this.cursorUniforms.originPx, x, y);
      gl.uniform2f(this.cursorUniforms.sizePx, w, h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    if (s.row === lastRow) {
      const c0 = s.col;
      const c1 = Math.min(e.col, cols - 1);
      if (c1 >= c0) drawRect(c0 * cw, s.row * ch, (c1 - c0 + 1) * cw, ch);
    } else {
      // First row: c0..cols-1
      if (s.col < cols) {
        drawRect(s.col * cw, s.row * ch, (cols - s.col) * cw, ch);
      }
      // Middle block: full rows
      if (lastRow - s.row > 1) {
        drawRect(0, (s.row + 1) * ch, cols * cw, (lastRow - s.row - 1) * ch);
      }
      // Last row: 0..e.col
      const c1 = Math.min(e.col, cols - 1);
      if (c1 >= 0) drawRect(0, lastRow * ch, (c1 + 1) * cw, ch);
    }

    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  updateTheme(theme: ThemeConfig): void {
    this.cursorColor = hexToRgba(theme.cursor);
    this.bgColor = hexToRgba(theme.background);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteProgram(this.cursorProgram);
    gl.deleteBuffer(this.quadVBO);
    gl.deleteBuffer(this.instanceVBO);
    gl.deleteTexture(this.atlasTex);
    gl.deleteVertexArray(this.cellVAO);
    gl.deleteVertexArray(this.cursorVAO);
    // Contexts are a scarce browser resource (~16/page); release ours now
    // instead of waiting for the detached canvas to be garbage-collected.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

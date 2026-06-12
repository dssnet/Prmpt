// Vertex shader: a single unit quad is reused for every cell via
// instanced draw. Instance attributes carry per-cell geometry and color.
export const VERTEX_SRC = /* glsl */ `#version 300 es
precision highp float;

// Quad vertex (0..1 in both axes)
layout(location = 0) in vec2 aQuad;

// Instance attributes
layout(location = 1) in vec2 aCellPos;     // cell column, row
layout(location = 2) in vec4 aUV;          // u0, v0, u1, v1
layout(location = 3) in vec4 aFg;          // rgba 0..1
layout(location = 4) in vec4 aBg;          // rgba 0..1
layout(location = 5) in float aFlags;      // bit-packed flags

uniform vec2 uViewportPx;
uniform vec2 uCellPx;
// Top-left of the cell grid within the viewport, in px. Non-zero for
// workspace panes, where the grid is inset so the rounded-corner pane mask
// doesn't clip edge glyphs.
uniform vec2 uGridOriginPx;

out vec2 vUV;
out vec4 vFg;
out vec4 vBg;
out float vFlags;
out vec2 vLocal;

void main() {
    vec2 cellOriginPx = uGridOriginPx + aCellPos * uCellPx;
    vec2 posPx = cellOriginPx + aQuad * uCellPx;
    vec2 clip = (posPx / uViewportPx) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
    vUV = mix(aUV.xy, aUV.zw, aQuad);
    vFg = aFg;
    vBg = aBg;
    vFlags = aFlags;
    vLocal = aQuad;
}
`;

export const FRAGMENT_SRC = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uAtlas;
uniform float uUnderlineY;
uniform float uUnderlineH;
uniform float uStrikethroughY;
uniform float uStrikethroughH;

// Rounded-rect clip for the pane this draw belongs to. uMaskRect is
// (x, y, w, h) in framebuffer px (gl_FragCoord space); uMaskRadius the
// corner radius in px. uMaskRadius <= 0 disables the clip.
uniform vec4 uMaskRect;
uniform float uMaskRadius;

bool outsidePaneMask() {
    if (uMaskRadius <= 0.0) return false;
    vec2 hsz = uMaskRect.zw * 0.5;
    vec2 p = gl_FragCoord.xy - (uMaskRect.xy + hsz);
    vec2 d = abs(p) - (hsz - vec2(uMaskRadius));
    float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - uMaskRadius;
    return dist > 0.0;
}

in vec2 vUV;
in vec4 vFg;
in vec4 vBg;
in float vFlags;
in vec2 vLocal;

out vec4 outColor;

const float F_BOLD = 1.0;
const float F_ITALIC = 2.0;
const float F_UNDERLINE = 4.0;
const float F_INVERSE = 8.0;
const float F_FAINT = 16.0;
const float F_STRIKE = 32.0;
const float F_SPACER_TAIL = 128.0;
const float F_COLOR_GLYPH = 256.0;

bool hasFlag(float flags, float bit) {
    return mod(floor(flags / bit), 2.0) >= 1.0;
}

void main() {
    if (outsidePaneMask()) discard;
    if (hasFlag(vFlags, F_SPACER_TAIL)) {
        outColor = vBg;
        return;
    }
    vec4 tex = texture(uAtlas, vUV);
    float alpha = tex.a;
    vec3 fg = vFg.rgb;
    if (hasFlag(vFlags, F_FAINT)) {
        fg *= 0.6;
    }
    vec3 paint = hasFlag(vFlags, F_COLOR_GLYPH) ? tex.rgb : fg;
    vec3 col = mix(vBg.rgb, paint, alpha);

    if (hasFlag(vFlags, F_UNDERLINE)) {
        if (vLocal.y >= uUnderlineY && vLocal.y < uUnderlineY + uUnderlineH) {
            col = fg;
        }
    }
    if (hasFlag(vFlags, F_STRIKE)) {
        if (vLocal.y >= uStrikethroughY && vLocal.y < uStrikethroughY + uStrikethroughH) {
            col = fg;
        }
    }

    outColor = vec4(col, 1.0);
}
`;

export const CURSOR_VERTEX_SRC = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aQuad;
uniform vec2 uViewportPx;
uniform vec2 uOriginPx;
uniform vec2 uSizePx;
out vec2 vLocal;
void main() {
    vec2 posPx = uOriginPx + aQuad * uSizePx;
    vec2 clip = (posPx / uViewportPx) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
    vLocal = aQuad;
}
`;

export const CURSOR_FRAGMENT_SRC = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 uColor;
uniform int uStyle; // 0 block, 1 bar, 2 underline, 3 hollow
uniform vec4 uMaskRect;   // pane clip rect (x,y,w,h) in framebuffer px
uniform float uMaskRadius; // corner radius px; <=0 disables
in vec2 vLocal;
out vec4 outColor;

bool outsidePaneMask() {
    if (uMaskRadius <= 0.0) return false;
    vec2 hsz = uMaskRect.zw * 0.5;
    vec2 p = gl_FragCoord.xy - (uMaskRect.xy + hsz);
    vec2 d = abs(p) - (hsz - vec2(uMaskRadius));
    float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - uMaskRadius;
    return dist > 0.0;
}

void main() {
    if (outsidePaneMask()) discard;
    if (uStyle == 3) {
        float edge = 0.06;
        if (vLocal.x < edge || vLocal.x > 1.0 - edge ||
            vLocal.y < edge || vLocal.y > 1.0 - edge) {
            outColor = uColor;
        } else {
            discard;
        }
        return;
    }
    outColor = uColor;
}
`;

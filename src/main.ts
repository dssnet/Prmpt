import { createApp } from "vue";

import App from "./App.vue";
import { markAllBroken, openDb } from "./db";
import { getConfig } from "./ipc";
import { openSecrets } from "./secrets";
import { initTheme } from "./state/theme";
import nerdFontUrl from "./assets/fonts/NotoMonoNerdFontMono-Regular.ttf?url";
import emojiFontUrl from "./assets/fonts/NotoColorEmoji.ttf?url";

// WKWebView inherits macOS's autocorrect / smart-quote / capitalization unless
// each input opts out at the element level. There are many form fields (host
// editor, key import, settings, prompts) and none of them want any of it —
// patch createElement once so every <input>/<textarea> is born opted out,
// regardless of where Vue or anything else constructs them.
{
  const origCreateElement = document.createElement;
  document.createElement = function (
    this: Document,
    tagName: string,
    options?: ElementCreationOptions,
  ): HTMLElement {
    const el = origCreateElement.call(this, tagName, options);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.setAttribute("autocorrect", "off");
      el.setAttribute("autocapitalize", "off");
      el.setAttribute("autocomplete", "off");
      el.spellcheck = false;
    }
    return el;
  } as typeof document.createElement;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function loadFont(family: string, url: string): Promise<void> {
  const face = new FontFace(family, `url(${url}) format("truetype")`);
  return withTimeout(face.load(), 5000, `font ${family}`)
    .then((loaded) => {
      document.fonts.add(loaded);
    })
    .catch((e) => {
      console.error(`[font] failed to load ${family} from ${url}:`, e);
    });
}

// Only the primary monospace face has to be ready before the renderer
// mounts — cell metrics (advance width, baseline) are measured from it.
// The Noto Color Emoji file is ~10MB and is only a lazy atlas fallback
// for emoji codepoints (rare in an initial shell prompt), so blocking
// first paint on its download was the single biggest startup stall.
// Kick it off in the background instead; the glyph atlas bakes lazily,
// so emoji just fall back for the brief window until it lands.
async function loadBundledFonts() {
  void loadFont("Noto Color Emoji", emojiFontUrl);
  await loadFont("Noto Nerd Font Mono", nerdFontUrl);
}

function ensureBundledFonts(stack: string): string {
  const needs = (name: string) => !stack.toLowerCase().includes(name.toLowerCase());
  const extras: string[] = [];
  if (needs("Noto Nerd Font Mono") && needs("NotoMono NFM")) {
    extras.push('"Noto Nerd Font Mono"');
  }
  if (needs("Noto Color Emoji")) extras.push('"Noto Color Emoji"');
  return extras.length ? `${stack}, ${extras.join(", ")}` : stack;
}

async function init() {
  // These four are independent: config drives theme/font stack/Vue props;
  // openDb runs SQL migrations; openSecrets unlocks Stronghold; font
  // loading reads neither. Running them concurrently instead of one
  // after another removes their summed latency from the critical path
  // before the renderer can mount.
  //
  //  - openDb: SQL plugin migrations + open
  //  - openSecrets: Stronghold unlock (non-fatal; SSH features degrade
  //    but the UI must still mount), then mark rows broken if the
  //    snapshot was quarantined this boot
  //  - loadBundledFonts: FontFace API load so cell metrics and atlas
  //    baking measure against real fonts rather than fallbacks
  const [config] = await Promise.all([
    getConfig(),
    openDb(),
    openSecrets()
      .then((quarantined) => {
        if (quarantined) return markAllBroken();
      })
      .catch((e) => {
        console.error("openSecrets failed — continuing without secrets", e);
      }),
    loadBundledFonts(),
  ]);

  initTheme(config.theme);

  // Always append the bundled fonts so Nerd Font icons / Powerline glyphs /
  // color emoji are available regardless of what's in the user's config.
  // The user's chosen font still wins for codepoints it provides.
  config.font_family = ensureBundledFonts(config.font_family);

  createApp(App, { config }).mount("#app");
}

function runInit() {
  init().catch((e) => {
    console.error("init failed", e);
    document.body.textContent = `init failed: ${e}`;
  });
}

// Module scripts run after the document is parsed, just before
// DOMContentLoaded fires — so by the time main.ts executes the
// `DOMContentLoaded` event may have already fired and the listener never
// hears it, leaving init() unrun and the window blank. Check readiness
// and either run now or wait for the event, whichever applies.
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", runInit);
} else {
  runInit();
}

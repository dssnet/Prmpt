import "./console-forward";

import { createApp } from "vue";
import { type as osType } from "@tauri-apps/plugin-os";

import App from "./App.vue";
import { markAllBroken, openDb } from "./db";
import { getConfig } from "./ipc";
import { openSecrets } from "./secrets";
import { initTheme } from "./state/theme";
import nerdFontUrl from "./assets/fonts/NotoMonoNerdFontMono-Regular.ttf?url";

// Tag <html> with the OS so platform-specific CSS can branch without
// runtime JS. Done synchronously, as early as possible, so the first
// paint already has the right styling.
try {
  document.documentElement.classList.add(`platform-${osType()}`);
} catch (e) {
  console.error("[platform] osType failed:", e);
}

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

// The primary monospace face has to be ready before the renderer mounts —
// cell metrics (advance width, baseline) are measured from it.
async function loadBundledFonts() {
  await loadFont("Noto Nerd Font Mono", nerdFontUrl);
}

function ensureBundledFonts(stack: string): string {
  const needs = (name: string) => !stack.toLowerCase().includes(name.toLowerCase());
  if (needs("Noto Nerd Font Mono") && needs("NotoMono NFM")) {
    return `${stack}, "Noto Nerd Font Mono"`;
  }
  return stack;
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

  // Always append the bundled Nerd Font so icons / Powerline glyphs are
  // available regardless of what's in the user's config. The user's chosen
  // font still wins for codepoints it provides.
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

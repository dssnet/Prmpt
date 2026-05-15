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

async function loadBundledFonts(sizePx: number) {
  const specs: Array<[string, string]> = [
    ["Noto Nerd Font Mono", nerdFontUrl],
    ["Noto Color Emoji", emojiFontUrl],
  ];
  for (const [family, url] of specs) {
    try {
      const face = new FontFace(family, `url(${url}) format("truetype")`);
      const loaded = await withTimeout(face.load(), 5000, `font ${family}`);
      document.fonts.add(loaded);
      console.log(
        `[font] loaded ${family} from ${url} (check=${document.fonts.check(
          `${sizePx}px "${family}"`,
        )})`,
      );
    } catch (e) {
      console.error(`[font] failed to load ${family} from ${url}:`, e);
    }
  }
  try {
    await withTimeout(document.fonts.ready, 3000, "document.fonts.ready");
  } catch (e) {
    console.warn("[font] document.fonts.ready did not settle", e);
  }
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
  const config = await getConfig();
  initTheme(config.theme);

  // Bring up the SQL plugin (runs migrations) and the Stronghold plugin
  // (unlocks the snapshot using the boot password Rust just prepared). If
  // Stronghold quarantined a stale snapshot this boot, stamp every saved
  // row as broken so the UI can prompt for re-entry.
  await openDb();

  try {
    const quarantined = await openSecrets();
    if (quarantined) await markAllBroken();
  } catch (e) {
    // Non-fatal: SSH features will throw when used, but the UI still mounts.
    console.error("openSecrets failed — continuing without secrets", e);
  }

  // Load the bundled fonts via the FontFace API before constructing the
  // renderer, so cell metrics and atlas baking measure against real fonts
  // rather than fallbacks.
  await loadBundledFonts(config.font_size);

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

# Prmpt — agent notes

A desktop terminal emulator. Tauri 2 shell, Ghostty's VT engine driving terminal state, custom WebGL2 renderer in the webview.

## Hard rules

- **Do not run `bun tauri dev` in the background, monitor it, or otherwise launch the GUI from an agent session.** The user runs it manually for visual testing. Compiling (`cargo check`, `bun run build`) is fine; launching the windowed app is not.
- **Do not modify the user's config file** at `~/Library/Application Support/de.dss-net.prmpt/config.toml`. If a new default needs to apply, instruct the user to delete that file (it auto-regenerates) — do not overwrite it.
- **libghostty-vt** types are `!Send + !Sync`. All terminal state access happens on a per-tab dedicated thread. Tauri command handlers post messages via `crossbeam-channel`; they never touch `Terminal` directly. Keep it that way.

## Architecture (one diagram)

```
Tauri webview (TS)
  WebGL2 renderer  ←  IPC event "terminal:render" {cells, cursor, …}
                       ↑
  tab manager  ──── invoke("write_input"|"resize_tab"|…) ──┐
                                                            │
Tauri backend (Rust)                                        ▼
  Tab thread (per tab):
    libghostty_vt::Terminal + RenderState  ← PTY reader thread (bytes)
    on_pty_write callback → PTY writer
    Snapshot → emit "terminal:render"
```

## Layout

| Path | What |
|---|---|
| `src-tauri/src/lib.rs` | Tauri builder, command registration |
| `src-tauri/src/tab.rs` | Per-tab thread, libghostty-vt + portable-pty, `emit_render` |
| `src-tauri/src/commands.rs` | `#[tauri::command]` handlers (thin wrappers over `TabRegistry`) |
| `src-tauri/src/config.rs` | TOML config schema + load |
| `src-tauri/src/protocol.rs` | IPC payload types (`RenderPayload`, `CellWire`, flag bits) |
| `src-tauri/src/error.rs` | `AppError` |
| `src/main.ts` | Frontend entry, event wiring, font preload |
| `src/renderer/webgl.ts` | WebGL2 instanced renderer (default) |
| `src/renderer/canvas2d.ts` | Canvas-2D fallback (force with `?renderer=2d`) |
| `src/renderer/glyph-atlas.ts` | Glyph atlas + color-glyph detection |
| `src/renderer/shaders.ts` | GLSL |
| `src/ipc.ts`, `src/input.ts`, `src/tabs.ts` | IPC bindings, keymap, tab bar |
| `src/assets/fonts/NotoMonoNerdFontMono-Regular.ttf` | Bundled primary mono font, patched with Powerline + Nerd Font icons (SIL OFL 1.1; Nerd Fonts patches are MIT). License at `NerdFonts-OFL.txt`. |
| `src/assets/fonts/NotoColorEmoji.ttf` | Bundled color emoji fallback (SIL OFL 1.1, `OFL.txt` in same dir) |

## Build / run

```bash
bun install                       # once
cd src-tauri && cargo check       # type-check backend
bun run build                     # type-check + bundle frontend
# Launching the GUI: USER does this, not the agent:
bun tauri dev
```

## Toolchain requirements (verified working as of writing)

- **Rust ≥ 1.93** (MSRV from libghostty-vt 0.1.1; this machine is on 1.95)
- **Zig 0.15.x** in PATH. `libghostty-vt-sys` vendors Ghostty's vt sources but invokes Zig at build time. Homebrew's `zig` (0.15.2) works.
- Bun ≥ 1.1 + Tauri 2 CLI. (Bun ships its own runtime, no separate Node required.)

## libghostty-vt cheatsheet (the bits that bit us)

- Get cells via `RenderState::update(&terminal)` → `Snapshot` → `RowIterator::update(&snapshot)` → `CellIterator::update(&row)`. Each iterator is reused across frames (don't recreate per row).
- `CellIteration::style()` returns `Err(InvalidValue)` for cells that have no styling applied. Treat as "use defaults", do not propagate.
- `CursorVisualStyle` is `#[non_exhaustive]`. Always have a `_ => default` arm.
- `on_pty_write` runs synchronously inside `vt_write`. The closure captures the PTY writer (we use `Rc<RefCell<Box<dyn Write>>>` on the tab thread).
- The crate's `set_dirty` plumbing has a known oddity in 0.1.1 (passes `&&T` to a `*const c_void` argument). Returns `InvalidValue` sometimes — use `.ok()` and move on.

## IPC contract

Events backend → frontend:

- `terminal:render` → `RenderPayload { tab_id, cols, rows, default_fg, default_bg, cells: CellWire[], cursor: CursorWire?, generation, title }`. `cells.length === cols * rows`, row-major. Coalesced by an 8ms debounce in `run_tab_loop`.
- `terminal:exit` → `{ tab_id, status }`. Frontend should call `forget_tab` and drop the tab.

Commands frontend → backend: `spawn_tab`, `close_tab`, `write_input`, `resize_tab`, `list_tabs`, `get_config`, `forget_tab`. Argument naming: snake_case in Rust, camelCase in JS for top-level args; struct args keep their internal snake_case field names (e.g. `cell_width_px`).

## Renderer notes

- The cell flags byte from the backend uses bits 0..7 (`FLAG_BOLD`..`FLAG_SPACER_TAIL`). The WebGL pipeline ORs **bit 8 (256)** in JS when the glyph atlas detects a color glyph (via pixel chroma sampling) so the fragment shader can paint the texture RGB instead of tinting `fg`. Keep that contract if you touch the shader.
- Glyph atlas is 2048×2048 RGBA, lazy-baked. Variants are tagged by `(codepoint, styleVariant)`; styleVariant is a 2-bit (bold, italic) tuple. Atlas exhaustion is logged but recycles slot 0 — that's a known limitation.
- Font preload: `main.ts` awaits `document.fonts.load(...)` for **both** bundled fonts (Noto Nerd Font Mono + Noto Color Emoji) before constructing the renderer, so cell metrics and atlas baking use real metrics rather than transient fallback fonts.
- Font stack default (in `Config::default()`): `"Noto Nerd Font Mono", "Noto Color Emoji", Menlo, ui-monospace, monospace`. Nerd Font supplies Latin + Powerline glyphs + icons (U+E000–U+F8FF PUA); Noto Color Emoji handles emoji codepoints; system mono catches anything else. **Do not switch the primary off the Nerd Font without checking that oh-my-zsh / starship / Powerlevel10k themes still render** — they rely heavily on PUA glyphs.

## Where things live at runtime

- Config: `~/Library/Application Support/de.dss-net.prmpt/config.toml`. **Auto-generated with defaults on first run.** Deleting it regenerates. Edit `src-tauri/src/config.rs::Config::default` to change defaults; existing files are not migrated — if a new default is needed, tell the user to delete the file or edit the relevant key themselves (do not edit it from the agent).
- Built frontend: `dist/`.
- Tauri target: `src-tauri/target/`.

## Out of scope for v1 (do not casually add)

Splits/panes, ligatures, sixel/kitty graphics, IME, selection+copy, OSC 8, bell. Tracked in `/Users/yanick/.claude-personal/plans/nifty-crafting-pelican.md`.

## When tests aren't enough

Type-check and frontend build catch a lot, but the GUI is only validated by running it. If you change the IPC contract, snapshot serialization, font metrics, or shader, stop and tell the user to do a `bun tauri dev` smoke before declaring done.

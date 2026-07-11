# Prmpt — agent notes

A desktop terminal emulator. Tauri 2 shell, Ghostty's VT engine driving terminal state, custom WebGL2 renderer in the webview.

## Hard rules

- **Do not run `bun tauri dev` in the background, monitor it, or otherwise launch the GUI from an agent session.** The user runs it manually for visual testing. Compiling (`cargo check`, `bun run build`) is fine; launching the windowed app is not.
- **Do not modify the user's config file** at `~/Library/Application Support/Prmpt/config.toml` (macOS) / `~/.config/Prmpt/config.toml` (Linux) / `%APPDATA%\Prmpt\config.toml` (Windows). If a new default needs to apply, instruct the user to delete that file (it auto-regenerates) — do not overwrite it.
- **Do not bump the version** in `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `package.json`. The user owns the release version and bumps it manually before dispatching the release workflow. Leave the version field alone even when the change you just made is the headline fix for the next release.
- **SQL migrations are append-only and additive.** Never edit, renumber, or delete a shipped entry in `src-tauri/migrations/` / the `MIGRATIONS` array in `lib.rs`; never `DROP` or repurpose columns/tables; new `NOT NULL` columns need a `DEFAULT` valid for existing rows. To change schema, append `NNNN_name.sql` + one `MIGRATIONS` tuple. This is what lets `db_compat.rs` reconcile `_sqlx_migrations` at startup so an *older* binary opens a *newer* DB without erroring (placeholder migrations + checksum re-stamp) — dev and the installed release share `prmpt.db` — and it's required for the planned cross-install DB sync. (Installed builds that predate `db_compat.rs` still error on a newer DB until updated.)
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
| `src/state/sync.ts` + `src-tauri/src/sync.rs` | WebDAV sync: TS merge engine + Rust transport/crypto. See "Sync (WebDAV)" below. |
| `src/state/panels.ts` | Generic panel-pane system: workspace leaves are terminals (backend PTY, positive id) **or** frontend panels (files/git/…, negative id). Tab/slot ids are *also* synthetic negatives (same counter) — a `TabState.id` never names a backend PTY; backend ids live only on leaves (translate via `workspaceOfLeaf`/`owningTabId`, backend commands take leaf ids). Panels are *self-contained* — each picks what it operates on (server / folder / cd-target terminal) from its own controls; `PanelDesc` carries only open-time *seeds*. A pane opens fresh beside the terminal it was launched from (pill button / Cmd+B/+G → `openPanelFromTerminal`, which seeds cwd/server) and lives until closed; it no longer follows or is pruned by any one terminal, but the workspace's last terminal closing still closes it. New panel type = kind here + component in `TerminalView.vue`'s `PANEL_VIEWS` + an `openPanelPane("<kind>", …)` opener; tiling/dividers/focus/drag/close are shared. |
| `src/state/drag.ts` | The drag module — every drag (tab pill, + button, pane titlebar) shares it. Owns the ghost pill (`dragGhost`, rendered once by `DragGhost.vue`), the tab-bar insertion indicator (`barInsertPoint` + TabBar's registered resolver), per-move affordance updates (`dragAffordances`), and the drop routines `dropTabOut` (a whole tab leaves the window — also used when a workspace's *sole* pane is dragged out; same move, different handle) and `dropLeafOut` (one pane of many). Cross-window: the source window owns all mouse events during a drag (implicit capture), so it hit-tests the cursor against a rect snapshot from `window_drag_targets` (focus-ordered — the backend's z-order stand-in) and forwards translated positions to the hovered window via `xdrag:hover/leave/drop` events; the target renders the same affordances locally and buffers the drop placement until `window:tab_attached` lands. Drag sources keep only grip-specific code: strip carry/reorder physics (TabBar), in-workspace re-tiling (TerminalView), spawn-on-landing (+ button). Terminals move across windows by backend id (`attach_tab`); panel panes move *by value* — their `PanelDesc` seeds + live title travel via `xdrag:drop_panel` (or through `open_panel_window`'s desc/title passthrough for a fresh window) and the pane is recreated there and closed here (a files panel's SFTP consumer is released and re-acquired). |
| `src/assets/fonts/NotoMonoNerdFontMono-Regular.ttf` | Bundled primary mono font, patched with Powerline + Nerd Font icons (SIL OFL 1.1; Nerd Fonts patches are MIT). License at `NerdFonts-OFL.txt`. |

## Build / run

```bash
bun install                       # once
bun run setup-vendor              # once (and after any libghostty-rs submodule bump)
cd src-tauri && cargo check       # type-check backend
bun run build                     # type-check + bundle frontend
# Launching the GUI: USER does this, not the agent:
bun tauri dev
```

`PRMPT_DATA_DIR=/some/dir` points an instance at an isolated data dir (config, DB, stronghold snapshot all follow — `paths.rs` honors it). That's how a second instance runs side by side, e.g. for testing WebDAV sync locally: start `bun tauri dev` normally, then launch `PRMPT_DATA_DIR=/tmp/prmpt-b src-tauri/target/debug/prmpt` — the second (debug) instance reuses the first one's Vite dev server.

## Toolchain requirements (verified working as of writing)

- **Rust ≥ 1.93** (MSRV from libghostty-vt 0.1.1; this machine is on 1.95)
- **Zig 0.15.x** in PATH. `libghostty-vt-sys` vendors Ghostty's vt sources but invokes Zig at build time. Homebrew's `zig` (0.15.2) works.
- Bun ≥ 1.1 + Tauri 2 CLI. (Bun ships its own runtime, no separate Node required.)

## libghostty-vt cheatsheet (the bits that bit us)

- Get cells via `RenderState::update(&terminal)` → `Snapshot` → `RowIterator::update(&snapshot)` → `CellIterator::update(&row)`. Each iterator is reused across frames (don't recreate per row).
- `CellIteration::style()` returns `Err(InvalidValue)` for cells that have no styling applied. Treat as "use defaults", do not propagate.
- `CursorVisualStyle` is `#[non_exhaustive]`. Always have a `_ => default` arm.
- `on_pty_write` runs synchronously inside `vt_write`, so it must never block. The closure does a non-blocking `try_send` of the reply bytes onto a bounded queue drained by a dedicated per-tab **writer thread** (`tab-<id>-writer`); replies are dropped if the queue is full. User input (`TabCmd::Write`) uses a reliable blocking send on the same queue. This decoupling stops a child that floods output without reading its stdin (`cat /dev/urandom`) from jamming the PTY input queue and stalling the VT thread / blocking CTRL+C.
- The crate's `set_dirty` plumbing has a known oddity in 0.1.1 (passes `&&T` to a `*const c_void` argument). Returns `InvalidValue` sometimes — use `.ok()` and move on.
- **Key encoding happens on the backend**, not in `input.ts`. The webview sends structured key events (`write_key` → `KeyEventWire`: DOM `code`/`key`/modifiers) and the tab thread encodes them with `libghostty_vt::key::Encoder` + `set_options_from_terminal` — that's what makes DECCKM, keypad mode and the **kitty keyboard protocol** correct without mirroring mode state to JS. `CSI ? u` query replies already flow through `on_pty_write`. Don't reintroduce frontend byte tables.
- **Mouse encoding also happens on the backend**, same pattern: `write_mouse` → `MouseEventWire` (action/button/cell/mods) and the wheel path (`wheel_scroll`, which now carries the pointer cell) are encoded with `libghostty_vt::mouse::Encoder` + `set_options_from_terminal` against the app's live tracking mode + output format (X10/SGR/urxvt). The encoder self-filters (no bytes for events a mode doesn't report). The frontend only forwards when `RenderPayload.mouse_tracking` is set and Shift isn't held; the wheel keeps its non-tracking fallbacks (arrow keys on the alt screen, viewport scroll otherwise). A 1px `EncoderSize` cell makes the surface position equal the cell coordinate. `mouse_encoder`/`MouseEvent` are `!Send`, created and used only on the tab thread like the key encoder. Hover-only (1003 any-event) motion isn't forwarded — drag motion (button held) is.
- `on_bell` fires synchronously inside `vt_write` like `on_pty_write` — same rule: never block, never emit from inside it (the tab loop drains an `Rc<Cell<bool>>` flag instead).
- OSC 9/777 notification *payloads* aren't exposed by the crate's Rust API (and the C API's stream handler treats OSC 7 `report_pwd` as a no-op, so `Terminal::pwd()` never learns it); `osc_notify.rs` scans raw PTY bytes (observe-only, stateful across 8 KB chunks) before `vt_write` for notifications, OSC 7 / OSC 9;9 cwd reports, and OSC 10;? / 11;? default-color queries. The engine has no default-color concept (themes live in Prmpt's config), so the tab loop answers color queries itself with the active theme's fg/bg (`osc_color_reply`, terminator echoed, replies `try_send` like `on_pty_write`) and registers `on_color_scheme` to answer `CSI ? 996 n` from theme-background luma — that's what lets theme-adaptive TUIs (Codex, fzf, nvim `background`) blend against the real background instead of falling back to a generic 16-color look. The cwd feeds the tab's `osc_cwd` (gated on the directory existing locally), which `terminal_cwd` prefers over the OS pid query — that query is exact on macOS/Linux and for cmd.exe (PEB read in `platform.rs`), but pwsh never updates its process cwd on `cd`, so exact tracking there needs an OSC-emitting prompt hook.

## IPC contract

Events backend → frontend:

- `terminal:render` → `RenderPayload { tab_id, cols, rows, default_fg, default_bg, cells: CellWire[], cursor: CursorWire?, generation, title, viewport_top, scrollback_total, kitty_flags, mouse_tracking, links, link_spans }`. `cells.length === cols * rows`, row-major. Coalesced by an 8ms debounce in `run_tab_loop`. `kitty_flags` is only a traffic hint (skip key-release / bare-modifier forwarding when 0). `mouse_tracking` is likewise a hint: when true the app has a mouse-tracking mode on, so the frontend forwards mouse events (`write_mouse` / `wheel_scroll`) to it and suppresses local selection unless Shift is held (Shift = local select/copy, the escape hatch for these apps). `links` (deduped OSC 8 URIs) + `link_spans` (`{row, c0, c1, link}` viewport cell runs) are both empty in the common no-links frame; extraction pre-filters with `Cell::has_hyperlink()` so the slow `grid_ref().hyperlink_uri()` path only runs for cells that carry one. Plain-text URL detection is frontend-only (`src/lib/urlDetect.ts` + `src/state/links.ts`): hover underlines (FLAG_UNDERLINE ORed into a *copy* of the payload — never mutate the cached snapshot), cmd/ctrl+click opens via `local_open` behind an http/https/mailto allowlist (file:// allowed for OSC 8 only). Right-clicking a link adds "Copy Link" to the context menu: `show_context_menu(withLink)` only carries a flag — the frontend remembers the URL (`setContextLink`) and writes it to the clipboard when the click returns as `menu:copy_link`.
- `terminal:exit` → `{ tab_id, status }`. Frontend should call `forget_tab` and drop the tab.
- `terminal:notification` → `NotifyPayload { tab_id, source: "bell"|"osc", title?, body? }`. BEL or OSC 9/777 (how Claude Code signals task completion — Prmpt sets `TERM_PROGRAM=ghostty` so its `auto` channel emits OSC 777). Throttled to 1/s per tab on the backend. Frontend routes it through `src/state/notifications.ts::notify()` — the single dispatch for terminal notifications AND file-transfer completions: chime always (Settings → Notifications); history entry, toast + tab-bar bell badge only when away (window unfocused / tab not active) — events the user watched happen don't enter the notification center. New "finished in the background" signals should call `notify()`, not `showToast` directly. Exception: `source: "bell"` routes to `notifyBell()` instead — a softer one-note blip (same sound toggle) + away-badge only, never logged to the notification center or toasted (shells ring BEL on tab autocomplete, which would flood the history).

Commands frontend → backend: `spawn_tab`, `close_tab`, `write_input` (raw bytes — LocalBrowser command injection etc.), `write_key` (keyboard events, backend-encoded), `write_mouse` (mouse press/release/motion, backend-encoded), `write_paste` (bracketed-paste aware; raw `write_input` would bypass mode 2004), `resize_tab`, `list_tabs`, `get_config`, `forget_tab`. Argument naming: snake_case in Rust, camelCase in JS for top-level args; struct args keep their internal snake_case field names (e.g. `cell_width_px`).

## Sync (WebDAV)

Hosts / keys / groups (incl. port forwards and their Stronghold secrets) sync across installs through **one age-encrypted document** (`prmpt-sync.age`) in a user-supplied WebDAV collection. Split of labor: `src-tauri/src/sync.rs` is transport + crypto only (`sync_webdav_test|pull|push`; optimistic concurrency via ETag `If-Match` / `If-None-Match: *` — a 412 surfaces as the `SYNC_CONFLICT` sentinel and the frontend re-pulls, re-merges, retries). The engine — snapshot, merge, apply, scheduling — is `src/state/sync.ts`. Merge is per-record last-write-wins on `updated_at` with tombstones (`sync_tombstones` table); records are keyed by `sync_id` UUIDs (migration 0008; `db.ts` assigns them on insert, the engine backfills NULLs from older binaries). Invariants:

- The engine's DB writes go through `dbHandle()` raw SQL, preserving remote `updated_at`/`created_at`/`sync_id` verbatim. **Never route them through the db.ts CRUD helpers** — those stamp fresh timestamps, write tombstones, and fire the mutation hook (→ infinite push loop).
- Every new user-facing mutation in `db.ts` must call `notifyMutation()`; deletes of synced rows must `recordTombstone()` first. A new synced table/column means extending the doc format in `state/sync.ts` — bump `DOC_FORMAT` (older clients refuse newer docs, never clobber them).
- Port forwards have no `sync_id`: they're embedded in their host's record, so any forward write must bump the host's `updated_at` (`touchHost`).
- Device-local state stays out of the document: group `open` flags, `broken` markers, the hide-PIN, config.toml.
- The E2E passphrase is mandatory — the doc carries plaintext SSH secrets inside the age layer, and `sync_webdav_push` refuses to upload without one. WebDAV password + passphrase live in Stronghold (`sync:webdav:password`, `sync:e2e:passphrase`); URL/username/enabled/interval/ETag-cursor live in the `sync_meta` table.
- Sync triggers: startup (label `"main"` only, so reserve-pool windows don't multiply traffic), 2 s-debounced after db.ts mutations, window focus (5 s throttle), an interval that only fires while the window has focus, the `online` event (best-effort — unreliable on WebKit), and exponential-backoff retries after failures (15 s → 5 min cap, focus-independent). Offline edits are pending-counter tracked (`mutationCount`/`pushedCount`): a count is only marked pushed when the whole cycle succeeded, so edits made while the server is unreachable keep retrying until they land — don't "simplify" this back to a boolean dirty flag.

## Renderer notes

- The cell flags byte from the backend uses bits 0..7 (`FLAG_BOLD`..`FLAG_SPACER_TAIL`). The WebGL pipeline ORs **bit 8 (256)** in JS when the glyph atlas detects a color glyph (via pixel chroma sampling) so the fragment shader can paint the texture RGB instead of tinting `fg`. Keep that contract if you touch the shader.
- Glyph atlas is 2048×2048 RGBA, lazy-baked. Variants are tagged by `(codepoint, styleVariant)`; styleVariant is a 2-bit (bold, italic) tuple. Atlas exhaustion is logged but recycles slot 0 — that's a known limitation.
- Font preload: `main.ts` awaits `document.fonts.load(...)` for the bundled Noto Nerd Font Mono before constructing the renderer, so cell metrics and atlas baking use real metrics rather than transient fallback fonts.
- Font stack default (in `Config::default()`): `"Noto Nerd Font Mono"` only — bundled and preloaded in the webview, so it always resolves; glyphs it lacks fall through to the engine's system font fallback. Users append explicit fallbacks in Settings → Terminal (chip editor, `FontStackInput.vue`). Nerd Font supplies Latin + Powerline glyphs + icons (U+E000–U+F8FF PUA). Emoji rely on whatever color-emoji font the OS provides (Apple Color Emoji on macOS, Segoe UI Emoji on Windows, Noto Color Emoji on most Linux desktops). **Do not switch the primary off the Nerd Font without checking that oh-my-zsh / starship / Powerlevel10k themes still render** — they rely heavily on PUA glyphs.

## Where things live at runtime

- Data dir — `Prmpt/` under the OS config root (macOS `~/Library/Application Support/`, Linux `~/.config/`, Windows `%APPDATA%`). Holds `config.toml`, `prmpt.db`, `stronghold.key`, `prmpt.stronghold`, and a `data_version` counter for the `data_migrations/` framework. The path is owned by `src-tauri/src/paths.rs`; all consumers (config.rs, stronghold.rs, the SQL plugin URL in lib.rs) go through it. **`config.toml` is auto-generated with defaults on first run.** Deleting it regenerates. Edit `src-tauri/src/config.rs::Config::default` to change defaults; existing files are not migrated — if a new default is needed, tell the user to delete the file or edit the relevant key themselves (do not edit it from the agent).
- Built frontend: `dist/`.
- Tauri target: `src-tauri/target/`.

## Out of scope for v1 (do not casually add)

Splits/panes, ligatures, sixel/kitty graphics, IME, selection+copy. Tracked in `/Users/yanick/.claude-personal/plans/nifty-crafting-pelican.md`. (Bell/OSC-notification handling and clickable links incl. OSC 8 shipped — see IPC contract.)

## When tests aren't enough

Type-check and frontend build catch a lot, but the GUI is only validated by running it. If you change the IPC contract, snapshot serialization, font metrics, or shader, stop and tell the user to do a `bun tauri dev` smoke before declaring done.

# Prmpt

<img src="assets/icon.png" alt="Prmpt icon" width="128" align="right" />

A desktop terminal emulator. Tauri 2 shell, Ghostty's VT engine driving terminal state, custom WebGL2 renderer in the webview.

The 1024×1024 source for the app icon lives at [`assets/icon.png`](assets/icon.png); the per-platform icon set under `src-tauri/icons/` is regenerated from it via `bun tauri icon assets/icon.png`.

## Toolchain

- **Rust** ≥ 1.93 (MSRV from `libghostty-vt`)
- **Zig** 0.15.x in `PATH` (the vendored `libghostty-vt-sys` invokes `zig` at build time; Homebrew's `zig` works)
- **Bun** ≥ 1.1 (ships its own runtime, no separate Node install needed)
- **Tauri 2 CLI**

## Build & run

```bash
bun install                       # once
cd src-tauri && cargo check       # type-check the Rust backend
bun run build                     # type-check + bundle the frontend
bun tauri dev                     # launch the app
```

## Layout

| Path | Role |
|---|---|
| `src/` | TypeScript frontend: WebGL2 renderer, glyph atlas, IPC bindings, tab/input handling |
| `src-tauri/` | Rust backend: per-tab thread driving `libghostty-vt` + portable-pty, Tauri command handlers |
| `index.html` | Single-page shell |

## Where things live at runtime

- Config: `~/Library/Application Support/de.dss-net.prmpt/config.toml` — auto-generated on first run; delete to reset to defaults.
- Compiled frontend: `dist/`
- Cargo target: `src-tauri/target/`

## Renderer

Default is WebGL2 (instanced quads, glyph atlas baked into a 2048×2048 RGBA texture). A Canvas2D fallback is available with `?renderer=2d` in the dev URL.

## License

Copyright © 2026 Digital Services Stephan

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. See [`LICENSE`](LICENSE) for the full text.

import { invoke } from "@tauri-apps/api/core";

// Patch `console.log/info/warn/error/debug` so messages also surface in
// the terminal running `bun tauri dev` (via the `frontend_log` Rust
// command). The original console method is still invoked so devtools
// shows the message normally.
//
// Imported for side effects from `main.ts` before anything else runs.

type Level = "log" | "info" | "warn" | "error" | "debug";

const LEVELS: Level[] = ["log", "info", "warn", "error", "debug"];

function formatArg(a: unknown, seen: WeakSet<object>): string {
  if (a === null) return "null";
  if (a === undefined) return "undefined";
  if (typeof a === "string") return a;
  if (typeof a === "number" || typeof a === "boolean" || typeof a === "bigint") {
    return String(a);
  }
  if (a instanceof Error) {
    return a.stack ? `${a.name}: ${a.message}\n${a.stack}` : `${a.name}: ${a.message}`;
  }
  if (typeof a === "function") return `[Function ${a.name || "anonymous"}]`;
  if (typeof a === "object") {
    if (seen.has(a as object)) return "[Circular]";
    seen.add(a as object);
    try {
      return JSON.stringify(a, (_k, v) => {
        if (typeof v === "bigint") return v.toString();
        return v;
      });
    } catch {
      try {
        return String(a);
      } catch {
        return "[Unserializable]";
      }
    }
  }
  return String(a);
}

function formatArgs(args: unknown[]): string {
  const seen = new WeakSet<object>();
  return args.map((a) => formatArg(a, seen)).join(" ");
}

for (const level of LEVELS) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    // Swallow rejection so a failed invoke doesn't surface as an
    // unhandled promise rejection (which would re-enter console.error
    // and loop).
    invoke("frontend_log", { level, message: formatArgs(args) }).catch(() => {});
  };
}

#!/usr/bin/env bun
// Bump the project version in lockstep across:
//   - package.json
//   - src-tauri/tauri.conf.json  (the value users see in the .app bundle)
//   - src-tauri/Cargo.toml       (the [package] entry only — not dep versions)
// then run `cargo check` to refresh src-tauri/Cargo.lock.
//
// Usage: bun run bump <version>
//        e.g. bun run bump 0.1.1

import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const version = process.argv[2];
if (!version) {
  console.error("Usage: bun run bump <version>");
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  console.error(`bump: "${version}" is not a valid semver`);
  process.exit(2);
}

const root = resolve(import.meta.dir, "..");

async function patchJson(relPath: string, key: string) {
  const path = resolve(root, relPath);
  const text = await readFile(path, "utf8");
  const json = JSON.parse(text);
  const prev = json[key];
  if (prev === version) {
    console.log(`${relPath}: already ${version}`);
    return;
  }
  json[key] = version;
  const trailing = text.endsWith("\n") ? "\n" : "";
  await writeFile(path, JSON.stringify(json, null, 2) + trailing);
  console.log(`${relPath}: ${prev} → ${version}`);
}

async function patchCargoToml(relPath: string) {
  const path = resolve(root, relPath);
  const text = await readFile(path, "utf8");
  // Replace `version = "..."` inside the [package] section only — there
  // are other `version = "..."` lines further down (dep declarations)
  // we mustn't touch.
  const sectionMatch = text.match(/^\[package\]\n([\s\S]*?)(?=^\[)/m);
  if (!sectionMatch) {
    console.error(`bump: [package] section not found in ${relPath}`);
    process.exit(1);
  }
  const sectionStart = sectionMatch.index!;
  const sectionEnd = sectionStart + sectionMatch[0].length;
  const section = sectionMatch[0];

  let prev: string | undefined;
  const patched = section.replace(/^version = "([^"]+)"/m, (_, p) => {
    prev = p;
    return `version = "${version}"`;
  });

  if (prev === undefined) {
    console.error(`bump: failed to find version line in [package] of ${relPath}`);
    process.exit(1);
  }
  if (prev === version) {
    console.log(`${relPath}: already ${version}`);
    return;
  }

  await writeFile(
    path,
    text.slice(0, sectionStart) + patched + text.slice(sectionEnd),
  );
  console.log(`${relPath}: ${prev} → ${version}`);
}

await patchJson("package.json", "version");
await patchJson("src-tauri/tauri.conf.json", "version");
await patchCargoToml("src-tauri/Cargo.toml");

console.log("\nRefreshing Cargo.lock...");
const cargo = spawnSync("cargo", ["check", "--quiet"], {
  cwd: resolve(root, "src-tauri"),
  stdio: "inherit",
});
if (cargo.status !== 0) {
  console.error("bump: `cargo check` failed; Cargo.lock may not be updated");
  process.exit(cargo.status ?? 1);
}

console.log(`
Next steps:
  git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
  git commit -m "v${version}"
  git tag v${version}
  git push origin HEAD v${version}
`);

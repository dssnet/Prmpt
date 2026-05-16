#!/usr/bin/env bun
// Bump the project version in lockstep across:
//   - package.json
//   - src-tauri/tauri.conf.json  (the value users see in the .app bundle)
//   - src-tauri/Cargo.toml       (the [package] entry only — not dep versions)
// run `cargo check` to refresh src-tauri/Cargo.lock, then commit the
// bump as "v<version>" and push it to main. Releasing is then a manual
// GitHub Actions dispatch from main (the workflow creates the tag) —
// not a tag push.
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

// Commit the bump automatically. The release workflow no longer
// triggers on a `v*` tag push — it is dispatched manually from `main`
// (see .github/workflows/release.yml). So all we need locally is the
// version commit on main; the tag is created by the workflow itself.
function git(...args: string[]) {
  const r = spawnSync("git", args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`bump: \`git ${args.join(" ")}\` failed`);
    process.exit(r.status ?? 1);
  }
}

const bumpedFiles = [
  "package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];
git("add", ...bumpedFiles);

// Nothing staged means every file was already at this version — skip
// the commit rather than erroring on an empty commit.
const staged = spawnSync("git", ["diff", "--cached", "--quiet", "--", ...bumpedFiles], {
  cwd: root,
});
if (staged.status === 0) {
  console.log(`\nNothing to commit — already at v${version}.`);
} else {
  git("commit", "-m", `v${version}`);
  console.log(`\nCommitted v${version}.`);
}

// Push the bump to main so the dispatched release workflow sees it.
git("push", "origin", "HEAD");
console.log("Pushed to main.");

console.log(`
Next step — start a release in GitHub Actions:
    gh workflow run release.yml --ref main
  (or: GitHub → Actions → "Release" → "Run workflow" → branch: main)

The Release workflow reads the version from src-tauri/tauri.conf.json,
creates the v${version} tag + GitHub release itself, and builds all
three platform bundles. Running it from main keeps its build cache
restorable by the next release.
`);

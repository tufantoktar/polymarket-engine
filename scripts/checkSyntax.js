#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/checkSyntax.js — Layer 1 static check: parse every source file
// ═══════════════════════════════════════════════════════════════════════
//  Runs `node --check` over src/ and scripts/. Catches syntax errors and
//  malformed ESM before any test spends time booting.
//
//  Zero dependencies by design: this must keep working even when
//  node_modules is empty or broken.
//
//  Exit 0 = all files parse. Exit 1 = at least one file is unparseable.
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const roots = ["src", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "archive", ".git"]);

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(path.join(dir, entry.name));
    }
  }
}

const files = [];
for (const r of roots) walk(path.join(repoRoot, r), files);
files.sort();

const failures = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (e) {
    const msg = (e.stderr?.toString() || e.message || "").trim().split("\n").slice(0, 3).join("\n");
    failures.push({ file: path.relative(repoRoot, file), msg });
  }
}

if (failures.length > 0) {
  console.error(`[check:syntax] ${failures.length} file(s) failed to parse:`);
  for (const f of failures) {
    console.error(`  ✗ ${f.file}`);
    console.error(`    ${f.msg.replace(/\n/g, "\n    ")}`);
  }
  process.exit(1);
}

console.log(`[check:syntax] OK (${files.length} files parsed).`);

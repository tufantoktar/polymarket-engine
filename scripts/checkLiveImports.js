#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const scanRoots = [
  path.join(repoRoot, "src", "live"),
  path.join(repoRoot, "scripts"),
];

const bannedTargets = [
  path.join(repoRoot, "src", "live", "config.js"),
  path.join(repoRoot, "src", "live", "logger.js"),
  path.join(repoRoot, "src", "live", "liveExecution.js"),
  path.join(repoRoot, "src", "live", "liveRisk.js"),
  path.join(repoRoot, "src", "live", "liveSignals.js"),
].map((p) => path.normalize(p));

const staticImportRegex = /(?:^|\s)import\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/gm;
const dynamicImportRegex = /import\s*\(\s*["']([^"']+)["']\s*\)/gm;

function walkJsFiles(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".js")) {
      out.push(path.normalize(fullPath));
    }
  }
}

function toResolvedFile(specifier, importerFile) {
  if (!specifier.startsWith(".")) return null;

  const importerDir = path.dirname(importerFile);
  const base = path.resolve(importerDir, specifier);

  if (path.extname(base)) return path.normalize(base);

  const withJs = `${base}.js`;
  if (fs.existsSync(withJs)) return path.normalize(withJs);

  const withIndex = path.join(base, "index.js");
  if (fs.existsSync(withIndex)) return path.normalize(withIndex);

  return path.normalize(base);
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function collectImportMatches(text) {
  const matches = [];

  for (const re of [staticImportRegex, dynamicImportRegex]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({
        specifier: m[1],
        index: m.index,
      });
    }
  }

  return matches;
}

function main() {
  const files = [];
  for (const root of scanRoots) walkJsFiles(root, files);

  const violations = [];

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const matches = collectImportMatches(text);

    for (const match of matches) {
      const resolved = toResolvedFile(match.specifier, file);
      if (!resolved) continue;

      if (bannedTargets.includes(resolved)) {
        violations.push({
          file,
          line: lineOf(text, match.index),
          specifier: match.specifier,
          resolved,
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error("[check:live-imports] Prohibited adapter imports detected:");
    for (const v of violations) {
      console.error(
        `- ${path.relative(repoRoot, v.file)}:${v.line} imports '${v.specifier}' -> ${path.relative(repoRoot, v.resolved)}`
      );
    }
    console.error("Use canonical module entrypoints under src/live/*/index.js instead of adapter files.");
    process.exit(1);
  }

  console.log(`[check:live-imports] OK (${files.length} files scanned).`);
}

main();

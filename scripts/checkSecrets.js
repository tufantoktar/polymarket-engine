#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/checkSecrets.js — no key reaches the repository
// ═══════════════════════════════════════════════════════════════════════
//  A leaked private key is not a bug you fix by deleting the commit. Git
//  keeps history, forks keep copies, and the key controls real funds
//  from the moment it lands. The only workable posture is refusing to
//  let one in.
//
//  The hard part is not detection, it is false positives: this codebase
//  is full of deliberate fake keys like "0x" + "a".repeat(64), and a
//  scanner that cries wolf on those gets switched off within a week.
//
//  So the allow-list is a property, not a path list. A real secp256k1
//  key is 64 hex characters of high-entropy noise; a fixture is
//  something a human typed, which means it repeats. Keys whose hex body
//  uses three or fewer distinct characters are treated as fixtures. A
//  path list would need updating every time a test moves, and would
//  quietly stop covering the file it was written for.
//
//  Usage:
//    node scripts/checkSecrets.js            # tracked files
//    node scripts/checkSecrets.js --staged   # staged diff only
// ═══════════════════════════════════════════════════════════════════════
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const STAGED = process.argv.includes("--staged");

const PATTERNS = [
  { id: "private-key", re: /\b0x[0-9a-fA-F]{64}\b/g,
    why: "looks like a 32-byte private key" },
  // Spaces and tabs only around the '=': \s* would swallow the newline
  // after an empty assignment and report the NEXT line's variable name
  // as this one's value. That false positive is how a scanner earns
  // being switched off.
  { id: "env-assignment", re: /\b(PRIVATE_KEY|CLOB_API_SECRET|CLOB_API_PASSPHRASE|CLOB_API_KEY)[ \t]*=[ \t]*["']?([^\s"'#]{8,})/g,
    why: "a credential appears to be assigned a real value" },
  { id: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g, why: "AWS access key id" },
];

// A value a human typed repeats itself; 32 bytes of entropy does not.
function looksSynthetic(hex) {
  const body = hex.replace(/^0x/, "").toLowerCase();
  const distinct = new Set(body).size;
  if (distinct <= 3) return true;
  if (/^(0123456789abcdef)+$/.test(body)) return true;
  if (/^(dead|beef|cafe|face|feed|0000|1111)+$/.test(body)) return true;
  return false;
}

// Placeholders in example files are the point of those files.
const PLACEHOLDER = /^(your|example|changeme|xxx+|<.*>|\.\.\.|placeholder|dummy|fake|test)/i;

function filesToScan() {
  const args = STAGED
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACM"]
    : ["ls-files"];
  return execFileSync("git", args, { encoding: "utf8" })
    .split("\n").map(s => s.trim()).filter(Boolean)
    .filter(f => fs.existsSync(f) && fs.statSync(f).isFile())
    .filter(f => !/\.(png|jpg|jpeg|gif|pdf|ico|woff2?|ttf|zip|gz)$/i.test(f))
    .filter(f => !f.startsWith("node_modules/"));
}

const findings = [];
let scanned = 0, ignoredSynthetic = 0;

for (const file of filesToScan()) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
  if (text.includes("\0")) continue;             // binary
  scanned++;

  for (const { id, re, why } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const hit = m[0];
      if (id === "private-key" && looksSynthetic(hit)) { ignoredSynthetic++; continue; }
      if (id === "env-assignment") {
        const value = m[2] || "";
        if (PLACEHOLDER.test(value)) continue;
        if (looksSynthetic(value)) { ignoredSynthetic++; continue; }
      }
      const line = text.slice(0, m.index).split("\n").length;
      findings.push({ file, line, id, why, sample: hit.slice(0, 12) + "…" });
    }
  }
}

// A tracked .env is a leak waiting to happen regardless of contents.
for (const file of filesToScan()) {
  if (/(^|\/)\.env(\.|$)/.test(file) && !file.includes("example")) {
    findings.push({ file, line: 1, id: "tracked-env",
      why: "an env file is tracked in git", sample: file });
  }
}

console.log(`  checkSecrets: ${scanned} file(s) scanned` +
  (ignoredSynthetic ? `, ${ignoredSynthetic} obvious fixture(s) ignored` : "") +
  (STAGED ? " [staged only]" : ""));

if (findings.length === 0) {
  console.log("  no credential-shaped strings found");
  process.exit(0);
}

console.log("\n  POSSIBLE SECRETS:");
for (const f of findings) {
  console.log(`    ${f.file}:${f.line}  [${f.id}] ${f.why}  ${f.sample}`);
}
console.log("\n  If one of these is a fixture, make it obviously synthetic");
console.log("  (repeat a character) rather than adding an exception here.");
process.exit(1);

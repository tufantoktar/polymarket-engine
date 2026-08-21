#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  scripts/verify.js — the single mandatory gate before commit + push
// ═══════════════════════════════════════════════════════════════════════
//  WHY THIS EXISTS
//
//  `test:all` used to be one long `&&` shell chain. A single red suite
//  aborted the chain, so every suite after it silently never ran. On
//  2026-08-11 that meant 116 of 420 assertions were dark — including
//  testPaperModeV2, the suite that proves paper mode cannot reach the
//  live order path. A gate that hides tests is worse than no gate.
//
//  This orchestrator therefore ALWAYS runs every stage, even after a
//  failure, and only then decides the exit code.
//
//  STAGE TIERS
//    mandatory   — red here blocks commit and push
//    quarantined — runs and reports, does NOT block. Every quarantined
//                  stage MUST have an entry in docs/KNOWN_ISSUES.md with
//                  a root cause and an expiry date.
//    pending     — declared but not implemented yet. Shown in the matrix
//                  so the gap stays visible instead of being forgotten.
//
//  EXIT CODES
//    0 — every mandatory stage passed
//    1 — at least one mandatory stage failed
// ═══════════════════════════════════════════════════════════════════════

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const repoRoot = process.cwd();

const STAGES = [
  {
    id: "static",
    label: "Static checks",
    tier: "mandatory",
    quick: true,
    steps: [
      { name: "syntax",          script: "scripts/checkSyntax.js" },
      { name: "import-boundary", script: "scripts/checkLiveImports.js" },
      { name: "config-defaults", script: "scripts/checkConfigDefaults.js" },
    ],
  },
  {
    id: "unit",
    label: "Unit tests",
    tier: "mandatory",
    quick: true,
    steps: [
      { name: "state",       script: "scripts/testStateModules.js" },
      { name: "reliability", script: "scripts/testReliabilityModules.js" },
      { name: "hardening",   script: "scripts/testHardeningModules.js" },
      { name: "retry",       script: "scripts/testRetry.js" },
      { name: "price-band",  script: "scripts/testPriceBand.js" },
      { name: "sizing-caps", script: "scripts/testSizingCaps.js" },
      { name: "trade-dedup", script: "scripts/testTradeDedup.js" },
      { name: "calibration", script: "scripts/testCalibration.js" },
      { name: "wallet-score", script: "scripts/testWalletScoring.js" },
      { name: "smart-money", script: "scripts/testSmartMoneyModule.js" },
    ],
  },
  {
    id: "integration",
    label: "Integration tests",
    tier: "mandatory",
    steps: [
      { name: "execution-flow", script: "scripts/testExecutionFlow.js" },
      { name: "paper-mode-v2",  script: "scripts/testPaperModeV2.js" },
      { name: "paper-runtime",  script: "scripts/testPaperRuntime.js" },
      { name: "backtest",       script: "scripts/testBacktestModules.js" },
    ],
  },
  {
    id: "v2",
    label: "CLOB V2 migration",
    tier: "mandatory",
    steps: [
      { name: "v2-migration", script: "scripts/testV2Migration.js" },
    ],
  },
  {
    id: "safety",
    label: "Safety regression gates",
    tier: "mandatory",
    steps: [
      { name: "safety-gates", script: "scripts/testSafetyGates.js" },
    ],
  },
  {
    id: "smoke",
    label: "Smoke (bounded paper loop)",
    tier: "pending",
    pendingNote: "Phase 3 — scripts/smokePaperLoop.js",
    steps: [],
  },
];

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : null;
};

const quickMode = has("--quick");
const onlyStage = valueOf("stage");
const listOnly = has("--list");

if (has("--help") || has("-h")) {
  console.log(`
Usage: node scripts/verify.js [options]

  --quick          static + unit only (fast edit loop)
  --stage=<id>     run a single stage: ${STAGES.map((s) => s.id).join(", ")}
  --list           print the stage plan and exit
  --help           this message
`);
  process.exit(0);
}

let plan = STAGES;
if (onlyStage) {
  plan = STAGES.filter((s) => s.id === onlyStage);
  if (plan.length === 0) {
    console.error(`verify: unknown stage '${onlyStage}'. Known: ${STAGES.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }
} else if (quickMode) {
  plan = STAGES.filter((s) => s.quick);
}

if (listOnly) {
  console.log("\nStage plan:\n");
  for (const s of STAGES) {
    const steps = s.steps.length ? s.steps.map((x) => x.name).join(", ") : (s.pendingNote || "-");
    console.log(`  ${s.id.padEnd(12)} [${s.tier.padEnd(11)}] ${steps}`);
  }
  console.log("");
  process.exit(0);
}

function parseCounts(output) {
  let passed = 0;
  let total = 0;

  const longForm = output.matchAll(/(\d+)\s+total,\s+(\d+)\s+passed,\s+(\d+)\s+failed/g);
  for (const m of longForm) {
    total += Number(m[1]);
    passed += Number(m[2]);
  }

  const shortForm = output.matchAll(/(\d+)\/(\d+)\s+passed/g);
  for (const m of shortForm) {
    passed += Number(m[1]);
    total += Number(m[2]);
  }

  return total > 0 ? { passed, total } : null;
}

function runStep(step) {
  const started = Date.now();
  const scriptPath = path.join(repoRoot, step.script);

  if (!fs.existsSync(scriptPath)) {
    return { ...step, ok: false, ms: 0, counts: null,
      output: `verify: script not found: ${step.script}` };
  }

  const res = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "test" },
  });

  const output = `${res.stdout || ""}${res.stderr || ""}`;
  return {
    ...step,
    ok: res.status === 0,
    ms: Date.now() - started,
    counts: parseCounts(output),
    output,
  };
}

// ─── Coverage self-check ───────────────────────────────────────────────
// A stage plan that silently omits a suite is exactly the failure mode
// this orchestrator exists to prevent. During Phase 1 development
// testHardeningModules.js (72 assertions) was accidentally left out of
// every stage. So the runner now audits itself: every scripts/test*.js
// on disk must be claimed by exactly one stage, or verify refuses to run.

function auditStageCoverage() {
  const scriptsDir = path.join(repoRoot, "scripts");
  if (!fs.existsSync(scriptsDir)) return [];

  const onDisk = fs
    .readdirSync(scriptsDir)
    .filter((f) => /^test.*\.js$/.test(f))
    .map((f) => `scripts/${f}`)
    .sort();

  const claimed = new Set();
  const duplicates = [];
  for (const stage of STAGES) {
    for (const step of stage.steps) {
      if (claimed.has(step.script)) duplicates.push(step.script);
      claimed.add(step.script);
    }
  }

  const problems = [];
  for (const f of onDisk) {
    if (!claimed.has(f)) problems.push(`unclaimed suite (in no stage): ${f}`);
  }
  for (const f of claimed) {
    if (!fs.existsSync(path.join(repoRoot, f))) {
      problems.push(`stage references a missing file: ${f}`);
    }
  }
  for (const f of duplicates) problems.push(`suite claimed by two stages: ${f}`);

  return problems;
}

const coverageProblems = auditStageCoverage();
if (coverageProblems.length > 0) {
  console.error("");
  console.error("  verify: STAGE PLAN IS INCOMPLETE — refusing to run.");
  console.error("  " + "-".repeat(62));
  for (const p of coverageProblems) console.error(`    x ${p}`);
  console.error("");
  console.error("  Every scripts/test*.js must belong to exactly one stage in");
  console.error("  STAGES. An unclaimed suite would never run, which is the");
  console.error("  precise bug this gate was built to eliminate.");
  console.error("");
  process.exit(1);
}

console.log("");
console.log("  Polymarket Engine — verify");
console.log("  " + "─".repeat(62));

const stageResults = [];

for (const stage of plan) {
  if (stage.tier === "pending") {
    stageResults.push({ stage, steps: [], ok: true, skipped: true });
    continue;
  }

  const steps = stage.steps.map(runStep);
  const ok = steps.every((s) => s.ok);
  stageResults.push({ stage, steps, ok, skipped: false });

  for (const s of steps) {
    if (!s.ok) {
      console.log("");
      console.log(`  x ${stage.id}:${s.name} FAILED`);
      console.log("  " + "─".repeat(62));
      const lines = s.output.trimEnd().split("\n");
      for (const line of lines.slice(-25)) console.log("    " + line);
      console.log("");
    }
  }
}

console.log("");
console.log("  RESULTS");
console.log("  " + "─".repeat(62));

let mandatoryFailed = 0;
let quarantinedFailed = 0;
let grandPassed = 0;
let grandTotal = 0;

for (const { stage, steps, ok, skipped } of stageResults) {
  if (skipped) {
    console.log(`   o ${stage.id.padEnd(12)} ${"PENDING".padEnd(9)} ${stage.pendingNote || ""}`);
    continue;
  }

  const passed = steps.reduce((a, s) => a + (s.counts?.passed || 0), 0);
  const total = steps.reduce((a, s) => a + (s.counts?.total || 0), 0);
  const ms = steps.reduce((a, s) => a + s.ms, 0);
  grandPassed += passed;
  grandTotal += total;

  const mark = ok ? "+" : "x";
  const status = ok ? "PASS" : (stage.tier === "quarantined" ? "RED*" : "FAIL");
  const counts = total > 0 ? `${passed}/${total}` : `${steps.length} check(s)`;
  const note = stage.tier === "quarantined" ? `  (quarantined: ${stage.knownIssue})` : "";

  console.log(
    `   ${mark} ${stage.id.padEnd(12)} ${status.padEnd(9)} ${counts.padEnd(12)} ${String(ms + "ms").padStart(7)}${note}`
  );

  if (!ok) {
    if (stage.tier === "mandatory") mandatoryFailed++;
    else if (stage.tier === "quarantined") quarantinedFailed++;
  }
}

console.log("  " + "─".repeat(62));
if (grandTotal > 0) {
  console.log(`   assertions executed: ${grandPassed}/${grandTotal}`);
}

console.log("");
if (mandatoryFailed === 0) {
  if (quarantinedFailed > 0) {
    console.log("  PASSED — with quarantined failures (non-blocking).");
    console.log("  See docs/KNOWN_ISSUES.md. Quarantine is temporary by contract.");
  } else {
    console.log("  PASSED — all mandatory stages green.");
  }
  console.log("  Commit and push are permitted.");
  console.log("");
  process.exit(0);
} else {
  console.log(`  FAILED — ${mandatoryFailed} mandatory stage(s) red.`);
  console.log("");
  console.log("  COMMIT BLOCKED · PUSH BLOCKED");
  console.log("");
  console.log("  Do not weaken or delete the failing assertion to get green.");
  console.log("  If the invariant genuinely changed, that is a human decision.");
  console.log("");
  process.exit(1);
}

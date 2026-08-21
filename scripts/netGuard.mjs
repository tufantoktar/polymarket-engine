// ═══════════════════════════════════════════════════════════════════════
//  scripts/netGuard.mjs — tests may not touch the network
// ═══════════════════════════════════════════════════════════════════════
//  Preloaded into every suite verify runs. Hermeticity was previously a
//  convention, which means it held until someone forgot: a test that
//  quietly reaches Polymarket is slow, flaky, dependent on someone
//  else's uptime, and - worst - can pass for reasons that have nothing
//  to do with the code under test.
//
//  The whole suite already passes with the network removed. This keeps
//  it that way, and turns a future accidental call into an immediate,
//  named failure instead of an intermittent one.
//
//  A suite that genuinely needs a transport must inject a mock, which is
//  what the engine's dependency injection is for.
// ═══════════════════════════════════════════════════════════════════════
const forbid = what => (...args) => {
  const target = typeof args[0] === "string" ? args[0]
    : args[0]?.href || args[0]?.hostname || args[0]?.host || "";
  throw new Error(
    `network access is forbidden in tests (${what}${target ? " -> " + target : ""}). ` +
    `Inject a mock instead.`
  );
};

globalThis.fetch = forbid("fetch");

for (const mod of ["node:http", "node:https"]) {
  try {
    const m = await import(mod);
    const api = m.default ?? m;
    api.request = forbid(`${mod}.request`);
    api.get = forbid(`${mod}.get`);
  } catch { /* module unavailable — nothing to guard */ }
}

try {
  const net = (await import("node:net")).default;
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    // Unix sockets and loopback are left alone: they are how some
    // tooling talks to itself, and blocking them would break the runner
    // rather than the test.
    const opts = typeof args[0] === "object" ? args[0] : null;
    const host = opts?.host ?? (typeof args[1] === "string" ? args[1] : null);
    const isLocal = !host || host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (opts?.path || isLocal) return realConnect.apply(this, args);
    throw new Error(
      `network access is forbidden in tests (socket -> ${host}). Inject a mock instead.`
    );
  };
} catch { /* ignore */ }

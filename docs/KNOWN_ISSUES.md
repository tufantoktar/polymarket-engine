# Known Issues

Every quarantined stage in `scripts/verify.js` **must** have an entry here
with a root cause and an expiry date. Quarantine is a deliberate, visible,
temporary decision — never a silent skip. If an entry passes its expiry
date without resolution, promote the stage back to `mandatory` and let it
block until it is fixed.

---

## KI-001 — CLOB V2 client is constructed with the wrong call shape

- **Stage:** `v2` (quarantined)
- **Failing assertion:** `testV2Migration.js` #18 — "client: error mentions V2 package"
- **Opened:** 2026-08-11
- **Expiry:** 2026-09-11
- **Severity:** HIGH — blocks live mode entirely
- **Money at risk today:** none (engine runs paper/collect only)

### Symptom

    FAIL: client: error mentions V2 package
          (Cannot read properties of undefined (reading 'endsWith'))

Previously misread as "the V2 SDK is not installed — run `npm run install:live`".
That diagnosis was wrong.

### Actual root cause

`@polymarket/clob-client-v2` **is** installed — it is declared in
`optionalDependencies`, so a plain `npm install` pulls it in. The test's
premise ("live mode without the V2 SDK") therefore cannot hold in a normal
install, and execution proceeds past the import into the SDK constructor.

The installed SDK (v1.1.0) takes a single options object:

    // node_modules/@polymarket/clob-client-v2/dist/client.js:46
    constructor({ host, chain, signer, creds, signatureType, funderAddress, ... }) {
      this.host = host.endsWith("/") ? host.slice(0, -1) : host;

but `src/live/polymarketClient.js` calls it positionally:

    // _getClobClient(), lines ~109 and ~120
    const boot = new ClientCtor(c.host, c.chainId, signer);
    this._clob   = new ClientCtor(c.host, c.chainId, signer, creds,
                                  c.signatureType, c.funderAddress || undefined);

The object destructure yields `host === undefined`, so `host.endsWith(...)`
throws immediately.

### Consequence

**The live order path has never worked against SDK v1.1.0.** Any attempt to
place a real order would crash inside `_getClobClient()` before reaching the
exchange. This fails safe (a crash places no order), but it means live mode
is non-functional, not merely untested.

### Why it is quarantined rather than fixed here

The fix touches `src/live/polymarketClient.js` — the order-submission path,
a protected path. Protected changes require an explicit human decision and a
green safety suite, and the safety suite (Phase 2) does not exist yet.
Quarantining keeps the other 66 V2 assertions running and visible while the
gate is built.

### Resolution plan

1. Phase 2: implement `scripts/testSafetyGates.js`, including a gate that
   asserts the SDK constructor is invoked with the object shape it declares.
2. Fix `_getClobClient()` to pass a single options object.
3. Rewrite `testV2Migration` #18 so its premise is real — simulate SDK
   absence explicitly instead of relying on it being uninstalled.
4. Promote stage `v2` back to `mandatory` in `scripts/verify.js` and delete
   this entry.

Do **not** close this by weakening assertion #18.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, type Address } from "viem";
import { deployedAddresses, resolveAddresses, reviewScope, type ScopePolicy } from "../src/index.ts";
import {
  LaneError,
  SURFACE,
  describeSurface,
  laneAllows,
  resolveLane,
  surfaceReport,
  type Lane,
} from "../mcp/lanes.ts";
import {
  PolicyError,
  advisoriesFor,
  listPolicyNames,
  loadPolicy,
  refusalFor,
  resolveToken,
} from "../mcp/policies.ts";

/**
 * The MCP layer's offline gate. No node, no keys, no network, no client.
 *
 * What it is actually protecting: the tool surface is the boundary now. A lane that resolves
 * upward on a missing value, a policy that installs against an address nobody resolved, or a mint
 * tool that grows a `targets` parameter are each a way to lose the containment through the
 * integration while every contract test still passes. So those are the assertions here.
 */

let checks = 0;
const check = (name: string, fn: () => void) => {
  fn();
  checks++;
  console.log(`  ok   ${name}`);
};

const HERE = dirname(fileURLToPath(import.meta.url));
const OWNER = getAddress("0x0cd6724019EFBA2ff175fA05a74E43eb0f4aa847");
const SESSION = getAddress("0x636ba41419248456F4c02EB8825e6835eb0d9524");
const ROUTER = getAddress("0x1111111111111111111111111111111111111111");
const NOW = 1_800_000_000n;

/** Mirrors the server, which always declares @router and leaves it undefined when UNTOLL_ROUTER is unset. */
const ctx = (extras: Record<string, Address | undefined> = { router: undefined }) => ({
  owner: OWNER,
  sessionKey: SESSION,
  addresses: resolveAddresses(),
  now: NOW,
  extras,
});

console.log("\n  MCP layer, offline\n");

// -- 1. lanes ---------------------------------------------------------------------------------

check("an unset UNTOLL_MCP_MODE resolves to the read lane, never upward", () => {
  assert.equal(resolveLane({}), "read");
  assert.equal(resolveLane({ UNTOLL_MCP_MODE: "" }), "read");
});

check("a lane the server does not know is refused rather than guessed", () => {
  assert.throws(() => resolveLane({ UNTOLL_MCP_MODE: "admin" }), LaneError);
  assert.throws(() => resolveLane({ UNTOLL_MCP_MODE: "OWNERSHIP" }), LaneError);
});

check("a declared lane is honoured, case-insensitively", () => {
  assert.equal(resolveLane({ UNTOLL_MCP_MODE: "owner" }), "owner");
  assert.equal(resolveLane({ UNTOLL_MCP_MODE: " Agent " }), "agent");
});

check("lanes nest: owner contains agent contains read, and nothing runs downward", () => {
  assert.ok(laneAllows("owner", "read") && laneAllows("owner", "agent") && laneAllows("owner", "owner"));
  assert.ok(laneAllows("agent", "read") && laneAllows("agent", "agent"));
  assert.ok(!laneAllows("agent", "owner"));
  assert.ok(!laneAllows("read", "agent"));
  assert.ok(!laneAllows("read", "owner"));
});

check("the surface has unique ids and puts minting and revoking in the owner lane", () => {
  const ids = SURFACE.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  const laneOf = (id: string): Lane => SURFACE.find((s) => s.id === id)!.lane;
  assert.equal(laneOf("untoll_mint_scoped_key"), "owner");
  assert.equal(laneOf("untoll_revoke_key"), "owner");
  assert.equal(laneOf("untoll_settle"), "agent");
  assert.equal(laneOf("untoll_check_call"), "read");
});

check("every tool that can send a transaction sits above the read lane", () => {
  for (const spec of SURFACE) {
    if (spec.mutates) assert.notEqual(spec.lane, "read", `${spec.id} mutates but is in the read lane`);
  }
});

check("a read-lane server registers no tool that can move anything", () => {
  const rows = surfaceReport("read");
  for (const row of rows) {
    if (row.spec.mutates) {
      assert.equal(row.registered, false, `${row.spec.id} registered in the read lane`);
      assert.match(row.withheld, /not in the read lane/);
    }
  }
  assert.equal(rows.filter((r) => r.registered).length, 3);
});

check("a withheld reason survives into the surface report and the description", () => {
  const rows = surfaceReport("owner", { untoll_settle: "no UNTOLL_SESSION_KEY" });
  const settle = rows.find((r) => r.spec.id === "untoll_settle")!;
  assert.equal(settle.registered, false);
  assert.equal(settle.withheld, "no UNTOLL_SESSION_KEY");
  assert.match(describeSurface("owner", { untoll_settle: "no UNTOLL_SESSION_KEY" }), /off {2}untoll_settle/);
});

// -- 2. name resolution -----------------------------------------------------------------------

check("@launchHook resolves to the deploy record rather than to a pasted address", () => {
  assert.equal(resolveToken("@launchHook", ctx()), getAddress(deployedAddresses.launchHook));
  assert.equal(resolveToken("@owner", ctx()), OWNER);
  assert.equal(resolveToken("@sessionKey", ctx()), SESSION);
});

check("a literal address is accepted and checksummed", () => {
  assert.equal(resolveToken(ROUTER.toLowerCase(), ctx()), ROUTER);
});

check("a name the server does not know is refused, never resolved to the zero address", () => {
  assert.throws(() => resolveToken("@treasury", ctx()), PolicyError);
  assert.throws(() => resolveToken("@router", ctx()), /no address in this environment/);
  assert.throws(() => resolveToken("0xnotanaddress", ctx()), PolicyError);
});

// -- 3. the shipped policies --------------------------------------------------------------------

check("every policy shipped on disk parses, so no example is a broken one", () => {
  const names = listPolicyNames();
  assert.deepEqual(names, ["claim-only", "trade-through-router"]);
  for (const name of names) {
    loadPolicy(name, ctx({ router: ROUTER }));
  }
});

check("claim-only is one target, three claims, and no value at all", () => {
  const { policy, warnings, advisories } = loadPolicy("claim-only", ctx());
  assert.deepEqual(policy.targets, [getAddress(deployedAddresses.launchHook)]);
  assert.deepEqual(
    policy.calls.map((c) => c.signature),
    [
      "claimRewards(bytes32,uint256)",
      "claimRewardsRange(bytes32,uint256,uint256)",
      "claimCreatorFee(bytes32)",
    ],
  );
  assert.equal(policy.perTxCap, 0n);
  assert.equal(policy.perEpochCap, 0n);
  assert.equal(policy.expiresIn, 86_400n);
  assert.equal(policy.now, NOW);
  assert.equal(warnings.length, 0, "a pull-based claim takes no address argument to redirect");
  assert.equal(advisories.length, 0);
  assert.equal(refusalFor({ file: { name: "x" } as never, policy, warnings, advisories }), "");
});

check("a policy naming a contract this environment cannot resolve refuses to load", () => {
  assert.throws(() => loadPolicy("trade-through-router", ctx()), /no address in this environment/);
});

check("the same policy loads once the router is named, and pins its recipient argument", () => {
  const { policy } = loadPolicy("trade-through-router", ctx({ router: ROUTER }));
  assert.deepEqual(policy.targets, [ROUTER]);
  assert.deepEqual(policy.recipients, [OWNER]);
  assert.equal(policy.calls[0]?.recipientArg, 4);
});

check("wei values survive as integers rather than as JSON numbers", () => {
  const { policy } = loadPolicy("trade-through-router", ctx({ router: ROUTER }));
  assert.equal(policy.perTxCap, 50_000_000_000_000_000n);
  assert.equal(policy.perEpochCap, 200_000_000_000_000_000n);
  assert.equal(typeof policy.perTxCap, "bigint");
});

check("a policy name that is a path, or that disagrees with its file, is refused", () => {
  assert.throws(() => loadPolicy("../src/index", ctx()), /is not a policy name/);
  assert.throws(() => loadPolicy("claim_only", ctx()), /is not a policy name/);
  assert.throws(() => loadPolicy("nope", ctx()), /no policy named/);
});

// -- 4. the mint gate ---------------------------------------------------------------------------

const unconstrained = (over: Partial<ScopePolicy> = {}): ScopePolicy => ({
  owner: OWNER,
  sessionKey: SESSION,
  targets: [ROUTER],
  calls: [{ signature: "transfer(address,uint256)" }],
  recipients: [OWNER],
  perTxCap: 0n,
  perEpochCap: 0n,
  epochLength: 3_600n,
  expiresIn: 3_600n,
  now: NOW,
  ...over,
});

check("an allowed call with an unconstrained destination refuses the mint", () => {
  const policy = unconstrained();
  const warnings = reviewScope(policy);
  assert.equal(warnings.length, 1);
  const refusal = refusalFor({
    file: { name: "hand-made", allowUnconstrainedRecipients: false } as never,
    policy,
    warnings,
    advisories: [],
  });
  assert.match(refusal, /point the output at itself/);
  assert.match(refusal, /transfer\(address,uint256\)/);
  assert.match(refusal, /belongs in the file/);
});

check("the escape hatch lives in the policy file, not in a tool argument", () => {
  const policy = unconstrained();
  const refusal = refusalFor({
    file: { name: "hand-made", allowUnconstrainedRecipients: true } as never,
    policy,
    warnings: reviewScope(policy),
    advisories: [],
  });
  assert.equal(refusal, "");
});

check("a second address argument is reported, because the delegate checks only one per selector", () => {
  const advisories = advisoriesFor(
    unconstrained({ calls: [{ signature: "swap(address,address,uint256,address)", recipientArg: 4 }] }),
  );
  assert.equal(advisories.length, 1);
  assert.match(advisories[0]!.note, /argument 1 and 2/);
  assert.match(advisories[0]!.note, /checks one recipient argument per selector/);
  assert.equal(
    reviewScope(unconstrained({ calls: [{ signature: "swap(address,address,uint256,address)", recipientArg: 4 }] }))
      .length,
    0,
    "reviewScope does not see this case, which is why the advisory exists",
  );
});

check("a call whose only address is the constrained one raises nothing", () => {
  assert.equal(
    advisoriesFor(unconstrained({ calls: [{ signature: "transfer(address,uint256)", recipientArg: 1 }] })).length,
    0,
  );
});

// -- 5. the invariant that makes the whole design hold --------------------------------------------

check("the mint tool takes a policy name and nothing else about the boundary", () => {
  const source = readFileSync(join(HERE, "..", "mcp", "server.ts"), "utf8");
  // Anchored on the registration, not on the name: the name also appears in the withheld table.
  const registration = /registerTool\(\s*"untoll_mint_scoped_key"/.exec(source);
  assert.ok(registration, "the mint tool is no longer registered under that name");
  const start = registration.index;
  const schemaStart = source.indexOf("inputSchema: {", start);
  const schemaEnd = source.indexOf("annotations:", schemaStart);
  assert.ok(schemaStart > 0 && schemaEnd > schemaStart, "could not find the mint tool's input schema");
  const schema = source.slice(schemaStart, schemaEnd);

  for (const banned of ["target", "selector", "signature", "Cap", "expir", "recipient", "epoch"]) {
    assert.ok(
      !schema.toLowerCase().includes(banned.toLowerCase()),
      `the mint tool's input schema mentions "${banned}". A scope authored by the party it ` +
        "constrains is not a boundary: the parameters of a scope belong in a policy file a person " +
        "reviews, and this tool takes only the name of one.",
    );
  }
  for (const expected of ["policy:", "sessionKeyAddress:", "confirm:"]) {
    assert.ok(schema.includes(expected), `the mint tool no longer takes ${expected}`);
  }
});

console.log(`\n  ${checks} checks passed\n`);

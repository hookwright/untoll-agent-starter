// Unit test for the AgentAccount scope builder: it must produce exactly the words AgentAccount checks.
// Word positions are the ones measured in untoll-agents (launch: quote 1, creator 4, crew 16, persona 17;
// router swap 0x2229d0b4: PoolKey 1-5, zeroForOne 6, amountSpecified 7, takeClaims 9, settleUsingBurn 10).
import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, toBytes, zeroAddress, type Address, type Hex } from "viem";
import { Untoll } from "../src/untoll.ts";
import {
  buildBuyKey, refuseLiveReissue, buildLaunchKey, buyCall, buyRule, executeCall, firstPinMismatch, issueKeyCall, launchRule,
  LAUNCH_SELECTOR, SWAP_SELECTOR, agentAccountAbi,
} from "../src/agentAccount.ts";

const A = (h: string) => `0x${h.padStart(40, "0")}` as Address;
const F = "0x80F43505d8d1A739504eB4237Eb15b2e0048Da8d" as Address;
const ACCT = A("a0001");
const CREW = "0xaA647077EDE147676c64DA2d06089c8e0C3FD372" as Address;
const EVIL = A("e0e11");
const HOOK = "0xe7D1762B9406f715771552B5f68912CCCAF4eaCC" as Address;
const TOK = A("b0b0b");
const ROUTER = "0x521fe809562DCDE295A48D017b4571d1cA15041E" as Address;
const pool = { currency0: zeroAddress, currency1: TOK, fee: 0x800000 | 3000, tickSpacing: 60, hooks: HOOK };
const w = (a: string) => `0x${a.toLowerCase().replace("0x", "").padStart(64, "0")}`;
const params = (creator: Address, crew?: Address) => ({
  creator, graduationTarget: 300n * 10n ** 18n, curveSupply: 800_000_000n * 10n ** 18n, snipeWindow: 60n, tradeFeeBps: 100,
  snipeStartBps: 5000, perWalletCapBps: 200, creatorAllocationBps: 0, bucketBps: [2500, 2500, 2500, 2500] as const, crew,
});
const launch = (creator: Address, crew: Address, quote: Address = zeroAddress) =>
  new Untoll({} as never, { tokenFactory: F }).launchCall(quote, "N", "S", params(creator, crew), 10n);
const wordOf = (d: Hex, n: number) => `0x${d.slice(2 + (4 + 32 * (n - 1)) * 2).slice(0, 64)}`;

test("selectors are the measured ones", () => {
  assert.equal(LAUNCH_SELECTOR, "0xf9e40591");
  assert.equal(SWAP_SELECTOR, "0x2229d0b4");
  assert.equal(launch(ACCT, CREW).data.slice(0, 10), LAUNCH_SELECTOR, "the SDK launch call carries the pinned selector");
});

test("launch rule pins exactly words 1, 4, 16, and the SDK launch calldata holds those values there", () => {
  const r = launchRule({ factory: F, account: ACCT, crew: CREW });
  assert.deepEqual(r.pins.map((p) => p.word), [1, 4, 16]);
  assert.deepEqual(r.pins.map((p) => p.value.toLowerCase()), [w(zeroAddress), w(ACCT), w(CREW)]);
  const c = launch(ACCT, CREW);
  assert.equal(wordOf(c.data, 4), w(ACCT));
  assert.equal(wordOf(c.data, 16), w(CREW));
  assert.equal(firstPinMismatch(r, c.data), null);
});

test("launch refusals land on the right word", () => {
  const r = launchRule({ factory: F, account: ACCT, crew: CREW });
  assert.equal(firstPinMismatch(r, launch(ACCT, EVIL).data), 16, "attacker crew");
  assert.equal(firstPinMismatch(r, launch(EVIL, CREW).data), 4, "attacker creator");
  assert.equal(firstPinMismatch(r, launch(ACCT, CREW, TOK).data), 1, "foreign quote");
  assert.throws(() => launchRule({ factory: F, account: ACCT, crew: zeroAddress }), /crew must be a real address/);
});

test("buy rule pins words 1-5, 6, 9, 10 and the router calldata holds those values there", () => {
  const r = buyRule({ router: ROUTER, pool });
  assert.deepEqual(r.pins.map((p) => p.word), [1, 2, 3, 4, 5, 6, 9, 10]);
  assert.equal(r.selector, "0x2229d0b4");
  const c = buyCall(ROUTER, pool, 10n ** 17n);
  assert.equal(c.data.slice(0, 10), "0x2229d0b4");
  assert.equal(wordOf(c.data, 2), w(TOK));
  assert.equal(wordOf(c.data, 5), w(HOOK));
  assert.equal(wordOf(c.data, 6), w("0x1"));
  assert.equal(BigInt(wordOf(c.data, 7)), BigInt.asUintN(256, -(10n ** 17n)), "word 7 is amountSpecified, there is no recipient word");
  assert.equal(firstPinMismatch(r, c.data), null);
});

test("buy refusals land on the right word", () => {
  const r = buyRule({ router: ROUTER, pool });
  assert.equal(firstPinMismatch(r, buyCall(ROUTER, { ...pool, currency1: EVIL }, 1n).data), 2, "foreign pool");
  assert.equal(firstPinMismatch(r, buyCall(ROUTER, { ...pool, hooks: EVIL }, 1n).data), 5, "foreign hook");
  assert.equal(firstPinMismatch(r, buyCall(ROUTER, pool, 1n, { zeroForOne: false }).data), 6, "sell direction");
  assert.equal(firstPinMismatch(r, buyCall(ROUTER, pool, 1n, { takeClaims: true }).data), 9, "claims instead of tokens");
});

test("key configs: launch cap is the creation fee; buy caps are ordered; call cap is nonzero", () => {
  const k = buildLaunchKey({ factory: F, account: ACCT, crew: CREW, creationFee: 10n ** 16n, launches: 3, expiry: 2n ** 40n, persona: "0x01" });
  assert.equal(k.config.perTxCap, 10n ** 16n);
  assert.equal(k.config.lifetimeCap, 3n * 10n ** 16n);
  assert.ok(k.config.perEpochCalls > 0);
  assert.throws(() => buildBuyKey({ router: ROUTER, pool, expiry: 1n, perTxCap: 5n, perEpochCap: 4n, lifetimeCap: 9n, perEpochCalls: 1 }), /perTx <= perEpoch and perTx <= lifetime/);
  const b = buildBuyKey({ router: ROUTER, pool, expiry: 2n ** 40n, perTxCap: 5n, perEpochCap: 80n, lifetimeCap: 9n, perEpochCalls: 4 });
  assert.equal(b.rules.length, 1);
});

test("issueKey and execute calldata use the contract selectors", () => {
  const sel = (sig: string) => keccak256(toBytes(sig)).slice(0, 10);
  const k = buildLaunchKey({ factory: F, account: ACCT, crew: CREW, creationFee: 1n, launches: 1, expiry: 2n ** 40n, persona: "0x01" });
  assert.equal(issueKeyCall(ACCT, EVIL, k).data.slice(0, 10), sel("issueKey(address,(uint64,uint64,uint32,uint128,uint128,uint128,uint128),(address,bytes4,(uint16,bytes32)[])[])"));
  assert.equal(executeCall(ACCT, launch(ACCT, CREW)).data.slice(0, 10), sel("execute(address,uint256,bytes)"));
  assert.ok(agentAccountAbi.length > 10);
});

// round 2: persona pinned by default, shape pins, live re-issue refused
{
  const k = buildLaunchKey({ factory: F, account: ACCT, crew: CREW, creationFee: 1n, launches: 1, expiry: 2n ** 40n, persona: "0x07" });
  const words = k.rules[0]!.pins.map((p) => p.word);
  assert.deepEqual(words, [1, 4, 16, 17], "quote, creator, crew, persona");
  assert.throws(() => buildLaunchKey({ factory: F, account: ACCT, crew: CREW, creationFee: 1n, launches: 1, expiry: 2n ** 40n } as never), /persona is required/);
  const many = Array.from({ length: 5 }, (_, i) => ({ word: 20 + i, value: "0x00" as `0x${string}` }));
  assert.throws(() => buildLaunchKey({ factory: F, account: ACCT, crew: CREW, creationFee: 1n, launches: 1, expiry: 2n ** 40n, persona: "0x07", shape: many }), /at most 8 pins/);
  assert.throws(() => refuseLiveReissue(2000n, 1000n), /refusing to re-issue a live key/);
  refuseLiveReissue(0n, 1000n);
  refuseLiveReissue(900n, 1000n);
  console.log("round 2 sdk checks ok");
}

// Stale-bytecode guard: the embedded creation code must dispatch every function the SDK ABI declares.
// A pre-round-2 build with a round-2 ABI made issueKey revert with empty data; this makes that unshippable.
test("embedded bytecode contains every selector of the ABI the SDK uses", async () => {
  const { agentAccountBytecode } = await import("../src/generated/agent-account-bytecode.ts");
  const { toFunctionSelector } = await import("viem");
  const code = agentAccountBytecode.toLowerCase();
  const fns = (agentAccountAbi as readonly { type: string; name?: string }[]).filter((x) => x.type === "function") as unknown as Array<{ name: string }>;
  const missing: string[] = [];
  for (const f of fns) {
    const sel = toFunctionSelector(f as never).slice(2);
    if (!code.includes(`63${sel}`)) missing.push(`${f.name} 0x${sel}`);
  }
  assert.ok(fns.length >= 12, "ABI function list unexpectedly small");
  assert.deepEqual(missing, [], `embedded AgentAccount bytecode is stale, missing: ${missing.join(", ")}`);
  assert.ok(code.includes("63d0b575f8"), "round 2 issueKey 0xd0b575f8 absent");
});

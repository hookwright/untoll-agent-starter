import assert from "node:assert/strict";
import { getAddress, type Address, type Hex } from "viem";
import {
  DEFAULT_REQUIRED_WEI,
  STEP_ORDER,
  fundingAsk,
  mergeEnv,
  nextStep,
  parseEnvFile,
  renderEnvBlock,
  type OnboardState,
} from "../onboard/plan.ts";

/**
 * The offline gate on onboarding. No node, no keys, no network.
 *
 * What it is actually protecting, and why the ordering assertions carry their own negative
 * controls: every check here is written so that it FAILS if the step it names is removed or
 * reordered. A suite that only ever fed a fully satisfied state would pass against a `nextStep`
 * that returned "done" unconditionally, which is exactly the shape of green that proves nothing.
 * So each ordering check asserts both what the state DOES produce and what it does NOT.
 */

let checks = 0;
const check = (name: string, fn: () => void) => {
  fn();
  checks++;
  console.log(`  ok   ${name}`);
};

const OWNER = getAddress("0x0cd6724019EFBA2ff175fA05a74E43eb0f4aa847") as Address;
const IMPL = getAddress("0x636ba41419248456F4c02EB8825e6835eb0d9524") as Address;
const KEY_A = ("0x" + "11".repeat(32)) as Hex;
const KEY_B = ("0x" + "22".repeat(32)) as Hex;

const full = (over: Partial<OnboardState> = {}): OnboardState => ({
  ownerKey: KEY_A,
  sessionKey: KEY_B,
  ownerAddress: OWNER,
  ownerBalanceWei: DEFAULT_REQUIRED_WEI,
  requiredWei: DEFAULT_REQUIRED_WEI,
  delegateImpl: IMPL,
  delegateImplHasCode: true,
  delegated: true,
  scopeInstalled: true,
  proofPublished: true,
  ...over,
});

console.log("\n  onboarding, offline\n");

check("a fully satisfied state is done, so every check below means something", () => {
  assert.equal(nextStep(full()).id, "done");
});

check("with no keys the first step is keys, and it is the machine's", () => {
  const s = nextStep(full({ ownerKey: undefined, sessionKey: undefined }));
  assert.equal(s.id, "keys");
  assert.equal(s.actor, "machine");
});

check("half a key pair is not a key pair", () => {
  assert.equal(nextStep(full({ sessionKey: undefined })).id, "keys");
  assert.equal(nextStep(full({ ownerKey: undefined })).id, "keys");
});

check("an underfunded owner halts, and funding is the only human step in the list", () => {
  const s = nextStep(full({ ownerBalanceWei: 0n }));
  assert.equal(s.id, "funding");
  assert.equal(s.actor, "human");
  // The negative control: no other reachable step may be a human step, because the whole
  // promise of the command is one halt.
  const others: OnboardState[] = [
    full({ ownerKey: undefined, sessionKey: undefined }),
    full({ delegateImplHasCode: false }),
    full({ delegated: false }),
    full({ scopeInstalled: false }),
    full({ proofPublished: false }),
    full(),
  ];
  for (const st of others) assert.equal(nextStep(st).actor, "machine");
});

check("one wei under the floor still halts, and exactly the floor does not", () => {
  assert.equal(nextStep(full({ ownerBalanceWei: DEFAULT_REQUIRED_WEI - 1n })).id, "funding");
  assert.notEqual(nextStep(full({ ownerBalanceWei: DEFAULT_REQUIRED_WEI })).id, "funding");
});

check("an unmeasured balance is treated as empty rather than as satisfied", () => {
  assert.equal(nextStep(full({ ownerBalanceWei: undefined })).id, "funding");
});

check("a delegate address with no code on this chain is not a delegate", () => {
  // The failure this guards is the one the SDK read-back exists for: a 7702 designator pointing
  // at an empty address is an account that looks delegated and executes nothing.
  assert.equal(nextStep(full({ delegateImplHasCode: false })).id, "delegate-impl");
  assert.equal(nextStep(full({ delegateImpl: undefined })).id, "delegate-impl");
});

check("the delegate deploy comes before the delegation, never after", () => {
  const s = nextStep(full({ delegateImplHasCode: false, delegated: false }));
  assert.equal(s.id, "delegate-impl");
  assert.notEqual(s.id, "delegation");
});

check("the delegation comes before the scope, because initialize calls into delegate code", () => {
  const s = nextStep(full({ delegated: false, scopeInstalled: false }));
  assert.equal(s.id, "delegation");
  assert.notEqual(s.id, "scope");
});

check("the scope comes before the proof, because an account with no scope refuses nothing", () => {
  const s = nextStep(full({ scopeInstalled: false, proofPublished: false }));
  assert.equal(s.id, "scope");
  assert.notEqual(s.id, "proof");
});

check("an installed scope with no proof stops at the proof rather than reporting done", () => {
  assert.equal(nextStep(full({ proofPublished: false })).id, "proof");
});

check("the declared order matches what nextStep actually walks", () => {
  // Walk the state forward one satisfaction at a time and record the ids seen. A reordering in
  // nextStep that STEP_ORDER did not follow shows up here rather than in a stranger's terminal.
  const walked: string[] = [];
  const s: OnboardState = {
    requiredWei: DEFAULT_REQUIRED_WEI,
    ownerAddress: OWNER,
    ownerBalanceWei: 0n,
  };
  walked.push(nextStep(s).id);
  s.ownerKey = KEY_A;
  s.sessionKey = KEY_B;
  walked.push(nextStep(s).id);
  s.ownerBalanceWei = DEFAULT_REQUIRED_WEI;
  walked.push(nextStep(s).id);
  s.delegateImpl = IMPL;
  s.delegateImplHasCode = true;
  walked.push(nextStep(s).id);
  s.delegated = true;
  walked.push(nextStep(s).id);
  s.scopeInstalled = true;
  walked.push(nextStep(s).id);
  s.proofPublished = true;
  walked.push(nextStep(s).id);
  assert.deepEqual(walked, [...STEP_ORDER]);
});

check("the funding ask names the address, the shortfall and what to do next", () => {
  const ask = fundingAsk(full({ ownerBalanceWei: 0n }));
  assert.ok(ask.includes(OWNER), "the ask must name the address to fund");
  assert.ok(ask.includes("0.002"), "the ask must name the amount");
  assert.ok(/run this again/.test(ask), "the ask must name the resume");
  // Negative control: an ask that does not move when the shortfall moves is a template, not a
  // measurement.
  const half = fundingAsk(full({ ownerBalanceWei: DEFAULT_REQUIRED_WEI / 2n }));
  assert.notEqual(ask, half);
  assert.ok(half.includes("0.001"), "the ask must name the REMAINING shortfall");
});

check("the env block carries every variable the agent requires", () => {
  const body = renderEnvBlock({ ownerKey: KEY_A, sessionKey: KEY_B, delegateImpl: IMPL, rpc: "https://x" });
  for (const k of ["UNTOLL_OWNER_KEY", "UNTOLL_SESSION_KEY", "UNTOLL_DELEGATE_IMPL", "UNTOLL_RPC"]) {
    assert.ok(body.includes(k + "="), `${k} must be written`);
  }
  // The pool is the one the proof does not need, so it is written commented rather than blank.
  assert.ok(/^# UNTOLL_POOL_ID=/m.test(body), "an absent pool id is a comment, never an empty value");
  const withPool = renderEnvBlock({
    ownerKey: KEY_A, sessionKey: KEY_B, delegateImpl: IMPL, poolId: ("0x" + "ab".repeat(32)) as Hex,
  });
  assert.ok(/^UNTOLL_POOL_ID=0xabab/m.test(withPool));
});

check("the env parser reads back what the env writer wrote", () => {
  const body = renderEnvBlock({ ownerKey: KEY_A, sessionKey: KEY_B, delegateImpl: IMPL, rpc: "https://x" });
  const parsed = parseEnvFile(body);
  assert.equal(parsed["UNTOLL_OWNER_KEY"], KEY_A);
  assert.equal(parsed["UNTOLL_DELEGATE_IMPL"], IMPL);
  assert.equal(parsed["UNTOLL_RPC"], "https://x");
  assert.equal(parsed["UNTOLL_POOL_ID"], undefined, "a commented line is not a value");
});

check("a value containing an equals sign survives the round trip", () => {
  const parsed = parseEnvFile("UNTOLL_RPC=https://x/?k=v=w\n");
  assert.equal(parsed["UNTOLL_RPC"], "https://x/?k=v=w");
});

check("the environment beats the file, never the other way round", () => {
  // The direction is load-bearing. A stale .env.local overriding an exported delegate address is
  // a delegation to an address with no code on the chain the stranger actually pointed at.
  const merged = mergeEnv({ UNTOLL_DELEGATE_IMPL: "0xfile" }, { UNTOLL_DELEGATE_IMPL: "0xenv" });
  assert.equal(merged["UNTOLL_DELEGATE_IMPL"], "0xenv");
  const blankIgnored = mergeEnv({ UNTOLL_DELEGATE_IMPL: "0xfile" }, { UNTOLL_DELEGATE_IMPL: "   " });
  assert.equal(blankIgnored["UNTOLL_DELEGATE_IMPL"], "0xfile", "an empty export is not an override");
});

console.log(`\n  ${checks} checks passed\n`);

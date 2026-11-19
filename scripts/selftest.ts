import assert from "node:assert/strict";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import {
  Untoll,
  SCOPE_OK,
  reviewScope,
  buildScope,
  decodeReason,
  designatorFor,
  launchHookAbi,
  reasonTag,
  sessionKeyDelegateAbi,
  VIOLATION_REASONS,
  type Call,
  type ScopePolicy,
  type Reader,
  type TryExecuteOutcome,
  type Wallet,
  SessionKey,
} from "../src/index.ts";
import { step, type AgentOptions, type Intent, type Verdict } from "../agent/agent.ts";
import { PublishBudget, publishRefusals, type PublishPolicy } from "../agent/policy.ts";

/**
 * The offline gate. No node, no keys, no network: every assertion here is about encoding and
 * about the scope rules, which is exactly the surface a mistake would ship silently.
 *
 * The reason tags and selectors below were computed by a separate keccak implementation (the
 * pure-python one in the UNTOLL toolchain) and pasted as constants. That is deliberate: checking
 * viem's keccak against viem's keccak proves nothing, and a transcription error in a four-byte
 * tag is precisely the class of bug that turns a decoded violation into "UNKNOWN" at 3am.
 */

let checks = 0;
const check = (name: string, fn: () => void) => {
  fn();
  checks++;
  console.log(`  ok   ${name}`);
};

const OWNER = getAddress("0x0cd6724019EFBA2ff175fA05a74E43eb0f4aa847");
const SESSION = getAddress("0x636ba41419248456F4c02EB8825e6835eb0d9524");
const HOOK = getAddress("0x6793347aE686A80c65BA49204Fe33b5C8bbB6aC8");
const ROUTER = getAddress("0x325407204587605AE974a82406F70dD7A1E5A961");
const NOW = 1_800_000_000n;

const basePolicy = (over: Partial<ScopePolicy> = {}): ScopePolicy => ({
  owner: OWNER,
  sessionKey: SESSION,
  targets: [HOOK],
  calls: Untoll.CLAIM_SIGNATURES.map((signature) => ({ signature })),
  recipients: [OWNER],
  perTxCap: 0n,
  perEpochCap: 0n,
  epochLength: 3_600n,
  expiresIn: 86_400n,
  now: NOW,
  ...over,
});

// -- 1. the reason table, against an independent keccak --------------------------------------
const EXPECTED_TAGS: Record<string, Hex> = {
  TARGET: "0x4b7ad2a9",
  SELECTOR: "0xadfc7895",
  PER_TX: "0xd4b2f4ca",
  PER_EPOCH: "0x5712be56",
  EXPIRED: "0xbd725cfb",
  RECIPIENT: "0xc0cf426a",
  CALLDATA_SHORT: "0x1c059fab",
  // Computed independently of this SDK with `cast keccak UNIT_PER_TX` and
  // `cast keccak UNIT_PER_EPOCH` on 2026-08-31, then truncated to four bytes. That is the whole
  // point of this table: it is a SECOND opinion, so deriving it from reasonTag() would make the
  // assertion compare the code against itself. The two tags already here were reproduced by the
  // same command in the same run, which is what makes the method trustworthy rather than assumed.
  UNIT_PER_TX: "0x55ccf6e5",
  UNIT_PER_EPOCH: "0xda7354a0",
};

check("every violation tag matches the independently computed value", () => {
  for (const reason of VIOLATION_REASONS) {
    assert.equal(reasonTag(reason), EXPECTED_TAGS[reason], `tag for ${reason}`);
  }
  assert.equal(Object.keys(EXPECTED_TAGS).length, VIOLATION_REASONS.length);
});

check("a tag decodes back to its reason, and zero decodes to OK", () => {
  for (const reason of VIOLATION_REASONS) assert.equal(decodeReason(reasonTag(reason)), reason);
  assert.equal(decodeReason("0x00000000"), "OK");
  assert.equal(decodeReason("0xdeadbeef"), "UNKNOWN");
});

// -- 2. the calls an agent routes ------------------------------------------------------------
const EXPECTED_SELECTORS: Record<string, Hex> = {
  "claimRewards(bytes32,uint256)": "0xbe02cf2e",
  "claimRewardsRange(bytes32,uint256,uint256)": "0x04276ae6",
  "claimCreatorFee(bytes32)": "0x25e4f6b7",
  "bindReferrer(address)": "0x04f618cb",
};

const POOL_ID = ("0x" + "11".repeat(32)) as Hex;

check("a routed claim call carries the hook address and the right selector and arguments", () => {
  const untoll = new Untoll({} as never);
  const call = untoll.claimRewardsCall(POOL_ID, 7n);
  assert.equal(call.target, untoll.addresses.launchHook);
  assert.equal(call.data.slice(0, 10), EXPECTED_SELECTORS["claimRewards(bytes32,uint256)"]);
  const decoded = decodeFunctionData({ abi: launchHookAbi, data: call.data });
  assert.equal(decoded.functionName, "claimRewards");
  assert.deepEqual(decoded.args, [POOL_ID, 7n]);
});

check("the claim calls encode to the selectors the deployed hook exposes", () => {
  const scope = buildScope(basePolicy());
  const encoded = scope.selectors;
  assert.deepEqual(encoded, [
    EXPECTED_SELECTORS["claimRewards(bytes32,uint256)"],
    EXPECTED_SELECTORS["claimRewardsRange(bytes32,uint256,uint256)"],
    EXPECTED_SELECTORS["claimCreatorFee(bytes32)"],
  ]);
});

// -- 3. the scope tuple round-trips through the compiled ABI ---------------------------------
check("a built scope encodes for initialize and decodes back unchanged", () => {
  const scope = buildScope(basePolicy());
  const data = encodeFunctionData({
    abi: sessionKeyDelegateAbi,
    functionName: "initialize",
    args: [scope],
  });
  // The Scope struct changed from 11 fields to 15 (perTxUnitCap, perEpochUnitCap,
  // amountSelectors, amountArgs), which changes the function's TYPE and therefore its selector.
  // Computed independently of this SDK on 2026-08-31 with:
  //   cast sig "initialize((address,address,uint64,uint128,uint128,uint256,uint256,uint64,  //             address[],bytes4[],address[],bytes4[],uint256[],bytes4[],uint256[]))"
  // The old value was 0x576eb658, and a consumer still encoding that against current bytecode
  // hits the fallback and reverts with NO reason, which reads as "unknown error" rather than as
  // a version mismatch. That is exactly what plugin-untoll's e2e did for four days.
  assert.equal(data.slice(0, 10), "0x6c624669", "initialize selector");
  const decoded = decodeFunctionData({ abi: sessionKeyDelegateAbi, data });
  assert.equal(decoded.functionName, "initialize");
  const back = decoded.args[0] as typeof scope;
  assert.equal(back.owner, scope.owner);
  assert.equal(back.sessionKey, scope.sessionKey);
  assert.equal(back.expiry, NOW + 86_400n);
  assert.deepEqual([...back.selectors], [...scope.selectors]);
  assert.deepEqual([...back.targets], [...scope.targets]);
});

// -- 4. the rules that stop a bad scope from being installed ----------------------------------
const rejects = (name: string, policy: ScopePolicy, fragment: string) =>
  check(`rejected: ${name}`, () => {
    assert.throws(() => buildScope(policy), (e: Error) => {
      assert.match(e.message, new RegExp(fragment, "i"), `message was: ${e.message}`);
      return true;
    });
  });

rejects("owner and session key are the same", basePolicy({ sessionKey: OWNER }), "constrains nothing");
rejects("no expiry at all", basePolicy({ expiresIn: undefined, expiry: undefined }), "needs an expiry");
rejects("an expiry already in the past", basePolicy({ expiresIn: undefined, expiry: NOW - 1n }), "not in the future");
rejects("no targets", basePolicy({ targets: [] }), "no targets");
rejects(
  "a per-tx cap above the per-epoch cap",
  basePolicy({ perTxCap: parseEther("2"), perEpochCap: parseEther("1") }),
  "can never bind",
);
rejects(
  "a recipient argument pointing at a uint",
  basePolicy({ calls: [{ signature: "swap(address,address,uint256,address)", recipientArg: 3 }] }),
  "not address",
);
rejects(
  "a recipient argument past the end of the signature",
  basePolicy({ calls: [{ signature: "swap(address,address,uint256,address)", recipientArg: 9 }] }),
  "outside its 4 arguments",
);
rejects(
  "a recipient argument sitting behind a dynamic argument",
  basePolicy({ calls: [{ signature: "swap(bytes,address)", recipientArg: 2 }] }),
  "dynamic argument",
);
rejects(
  "a recipient policy with no allowed recipients",
  basePolicy({
    calls: [{ signature: "swap(address,address,uint256,address)", recipientArg: 4 }],
    recipients: [],
  }),
  "allows no recipients",
);
rejects("the same function allowed twice", basePolicy({ calls: [
  { signature: "claimCreatorFee(bytes32)" },
  { signature: "claimCreatorFee(bytes32)" },
] }), "appears twice");

// -- 5. the review that finds the hole ---------------------------------------------------------
check("the review is silent on a claim-only policy", () => {
  assert.deepEqual(reviewScope(basePolicy()), []);
});

check("the review flags an allowed swap whose output address nobody constrained", () => {
  const warnings = reviewScope(
    basePolicy({
      targets: [ROUTER],
      calls: [{ signature: "swap(address,address,uint256,address)" }],
    }),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.note, /argument 1 and 2 and 4/);
  assert.match(warnings[0]!.note, /point that address anywhere/);
});

check("the review is silent once that swap declares its recipient argument", () => {
  const warnings = reviewScope(
    basePolicy({
      targets: [ROUTER],
      calls: [{ signature: "swap(address,address,uint256,address)", recipientArg: 4 }],
    }),
  );
  assert.deepEqual(warnings, []);
});

check("a swap policy carries the recipient argument through to the tuple", () => {
  const scope = buildScope(
    basePolicy({
      targets: [ROUTER],
      calls: [{ signature: "swap(address,address,uint256,address)", recipientArg: 4 }],
    }),
  );
  assert.deepEqual([...scope.selectors], ["0x6e81221c"]);
  assert.deepEqual([...scope.recipientSelectors], ["0x6e81221c"]);
  assert.deepEqual([...scope.recipientArgs], [4n]);
  assert.deepEqual([...scope.recipients], [OWNER]);
});

// -- 6. the 7702 designator -------------------------------------------------------------------
check("the delegation designator is 0xef0100 followed by the implementation", () => {
  const impl = "0x1234567890AbcdEF1234567890aBcdef12345678" as Address;
  assert.equal(designatorFor(impl), "0xef01001234567890abcdef1234567890abcdef12345678");
  assert.equal(designatorFor(impl).length, 2 + 6 + 40);
});

// -- 7. the bucket split guard ----------------------------------------------------------------
check("a launch whose four buckets do not sum to 10000 is refused", () => {
  const untoll = new Untoll({} as never);
  assert.throws(
    () =>
      untoll.launchCall(OWNER, "Name", "SYM", {
        creator: OWNER,
        graduationTarget: 1n,
        curveSupply: 1n,
        snipeWindow: 1n,
        tradeFeeBps: 100,
        snipeStartBps: 0,
        perWalletCapBps: 0,
        creatorAllocationBps: 0,
        bucketBps: [3500, 3000, 2500, 500],
      }),
    /must sum to 10000/,
  );
});

check("the signed 35 / 30 / 25 / 10 split passes that guard and encodes", () => {
  const untoll = new Untoll({} as never);
  const call = untoll.launchCall(OWNER, "Name", "SYM", {
    creator: OWNER,
    graduationTarget: 10n ** 18n,
    curveSupply: 10n ** 24n,
    snipeWindow: 300n,
    tradeFeeBps: 100,
    snipeStartBps: 0,
    perWalletCapBps: 100,
    creatorAllocationBps: 0,
    bucketBps: [3500, 3000, 2500, 1000],
  });
  assert.equal(call.target, untoll.addresses.tokenFactory);
  assert.ok(call.data.length > 10);
});

// -- 8. what the mined receipt says a publication did -------------------------------------------
/**
 * `tryExecute` has three endings and its return tuple can only tell you two.
 *
 * A scope breach returns (false, TAG) and emits ScopeViolation. A downstream revert on a call the
 * scope ALLOWED returns (false, OK) and emits nothing. Reading `ok` alone reports a published
 * refusal over a transaction that published nothing, so these drive the SDK against receipts it
 * has to read rather than against a return value it must not trust.
 */

let asyncChecks: Promise<void> = Promise.resolve();
const checkAsync = (name: string, fn: () => Promise<void>) => {
  asyncChecks = asyncChecks.then(async () => {
    await fn();
    checks++;
    console.log(`  ok   ${name}`);
  });
};

const AGENT = getAddress("0x1111111111111111111111111111111111111111");
const TX_HASH = ("0x" + "ee".repeat(32)) as Hex;
const SOME_SELECTOR = "0xbe02cf2e" as Hex;

const violationLog = (address: Address, reason: Hex) => ({
  address,
  topics: encodeEventTopics({
    abi: sessionKeyDelegateAbi,
    eventName: "ScopeViolation",
    args: { target: ROUTER, selector: SOME_SELECTOR },
  }),
  data: encodeAbiParameters([{ type: "bytes4" }], [reason]),
});

const scopedCallLog = (address: Address) => ({
  address,
  topics: encodeEventTopics({
    abi: sessionKeyDelegateAbi,
    eventName: "ScopedCall",
    args: { target: ROUTER },
  }),
  data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes4" }], [parseEther("1"), SOME_SELECTOR]),
});

const keyOverReceipt = (logs: unknown[], status: "success" | "reverted" = "success") =>
  new SessionKey(
    { waitForTransactionReceipt: async () => ({ status, logs }) } as unknown as Reader,
    AGENT,
  );

const senderStub = { writeContract: async () => TX_HASH } as unknown as Wallet;
const someCall = { target: ROUTER, data: "0xdeadbeef" as Hex };

checkAsync("a receipt carrying ScopeViolation reads as published, with the tag decoded", async () => {
  const key = keyOverReceipt([violationLog(AGENT, reasonTag("PER_EPOCH"))]);
  const result = await key.tryExecute(senderStub, someCall);
  assert.equal(result.outcome, "published");
  assert.equal(result.reason, "PER_EPOCH");
  assert.equal(result.hash, TX_HASH);
});

checkAsync("a receipt carrying ScopedCall reads as settled, never as published", async () => {
  const key = keyOverReceipt([scopedCallLog(AGENT)]);
  const result = await key.tryExecute(senderStub, someCall);
  assert.equal(result.outcome, "settled", "the delegate forwarded the call, so nothing was refused");
  assert.equal(result.reason, "OK");
});

checkAsync("a receipt carrying neither event reads as callReverted", async () => {
  // The ending the return tuple cannot express: scope passed, the target call reverted, no event
  // was emitted, and the epoch budget was charged on the way through.
  const key = keyOverReceipt([]);
  const result = await key.tryExecute(senderStub, someCall);
  assert.equal(result.outcome, "callReverted");
  assert.equal(result.reason, "OK");
});

checkAsync("a ScopeViolation from another address is not read as ours", async () => {
  const key = keyOverReceipt([violationLog(ROUTER, reasonTag("TARGET"))]);
  const result = await key.tryExecute(senderStub, someCall);
  assert.equal(result.outcome, "callReverted", "another agent's record is not our record");
});

checkAsync("a reverted tryExecute transaction throws rather than reading as a refusal", async () => {
  const key = keyOverReceipt([], "reverted");
  await assert.rejects(() => key.tryExecute(senderStub, someCall), /wiring fault rather than a refusal/);
});

/**
 * What a publication price does to the transaction, which is the one place it could go wrong
 * silently. The price is surplus `msg.value`. The delegate rules on the `value` ARGUMENT, so a
 * price folded into that argument would change the call the scope judges, and at the default price
 * of zero the two are the same number and the mistake is invisible. These capture the parameters
 * viem was handed rather than trusting the method to have meant well.
 */
const capturingSender = () => {
  const seen: Array<Record<string, unknown>> = [];
  const wallet = {
    writeContract: async (params: Record<string, unknown>) => {
      seen.push(params);
      return TX_HASH;
    },
  } as unknown as Wallet;
  return { seen, wallet };
};

checkAsync("a publication price rides as surplus transaction value and never enters the scoped argument", async () => {
  const { seen, wallet } = capturingSender();
  const key = keyOverReceipt([violationLog(AGENT, reasonTag("PER_TX"))]);
  const priced: Call = { target: ROUTER, data: "0xdeadbeef" as Hex, value: parseEther("1") };
  await key.tryExecute(wallet, priced, 7n);
  assert.equal(seen.length, 1);
  const args = seen[0]!.args as unknown[];
  assert.equal(args[1], parseEther("1"), "the delegate must rule on the call the brain proposed, never on the price");
  assert.equal(seen[0]!.value, parseEther("1") + 7n, "and the transaction hands over that value plus the price");
});

checkAsync("a price of zero takes the same path as a price of one, and only the amount differs", async () => {
  // The defect this exists for is the one the default hides: a paid path nobody has run, that only
  // breaks the day somebody sets a price. If zero ever earns its own branch, these two transactions
  // stop being the same transaction, and the assertion below is what notices.
  const free = capturingSender();
  const paid = capturingSender();
  const call: Call = { target: ROUTER, data: "0xdeadbeef" as Hex, value: parseEther("1") };
  await keyOverReceipt([violationLog(AGENT, reasonTag("PER_TX"))]).tryExecute(free.wallet, call, 0n);
  await keyOverReceipt([violationLog(AGENT, reasonTag("PER_TX"))]).tryExecute(paid.wallet, call, 1n);
  const a = { ...free.seen[0]! };
  const b = { ...paid.seen[0]! };
  assert.equal(a.value, parseEther("1"), "free is exactly the call's own value, as it was before a price existed");
  assert.equal(b.value, parseEther("1") + 1n, "and one wei more is one wei more, with nothing else moved");
  delete a.value;
  delete b.value;
  assert.deepEqual(a, b, "every other field is identical, so zero is not its own branch");
});

// -- 9. the refusal the agent pays to publish ---------------------------------------------------
/**
 * The loop's third branch, driven against a stub key rather than a chain.
 *
 * The stub decides what the probe says and records both which method the loop reached for and the
 * exact call it handed over. That second record is the point of `sent`: a publication that quietly
 * dropped the intent's native value would satisfy every assertion about method names.
 */

const PUBLISH_HASH = ("0x" + "ab".repeat(32)) as Hex;
const SETTLE_HASH = ("0x" + "cd".repeat(32)) as Hex;

const stubKey = (inScope: boolean, publish: { error?: string; outcome?: TryExecuteOutcome } = {}) => {
  const calls: string[] = [];
  const sent: Call[] = [];
  // Whatever the loop handed over as a publication price, recorded raw. `undefined` here is the
  // shape of a loop that stopped passing the argument at all, which is a different defect from a
  // loop that passed a zero, and the two have to stay distinguishable.
  const paid: Array<bigint | undefined> = [];
  const key = {
    probe: async (_call: Call) => {
      calls.push("probe");
      return inScope
        ? { ok: true, reason: "OK", tag: SCOPE_OK }
        : { ok: false, reason: "TARGET", tag: reasonTag("TARGET") };
    },
    execute: async (_session: unknown, call: Call) => {
      calls.push("execute");
      sent.push(call);
      return SETTLE_HASH;
    },
    tryExecute: async (_session: unknown, call: Call, cost?: bigint) => {
      calls.push("tryExecute");
      sent.push(call);
      paid.push(cost);
      if (publish.error) throw new Error(publish.error);
      const outcome = publish.outcome ?? "published";
      return { hash: PUBLISH_HASH, outcome, reason: outcome === "published" ? "TARGET" : "OK" };
    },
  } as unknown as SessionKey;
  return { key, calls, sent, paid };
};

const stubOptions = (intents: Intent[]): AgentOptions => ({
  reader: { getBlockNumber: async () => 1n } as unknown as Reader,
  agent: OWNER,
  owner: {} as never,
  session: {} as never,
  implementation: HOOK,
  policy: basePolicy(),
  brain: async () => intents,
  log: () => {},
});

const wants = (utility: unknown): Intent => ({
  rationale: "a refused call",
  utility: utility as number,
  call: { target: ROUTER, data: "0xdeadbeef" as Hex },
});

const publishedHash = (v: Verdict): Hex | undefined =>
  v.publish && v.publish.published ? v.publish.hash : undefined;
const publishNote = (v: Verdict): string => (v.publish ? v.publish.note : "no publish outcome at all");

checkAsync("a refusal above the threshold is published, and the verdict carries the hash", async () => {
  const { key, calls } = stubKey(false);
  const budget = new PublishBudget(publishRefusals);
  const verdicts = await step(key, stubOptions([wants(90)]), budget);
  const v = verdicts[0]!;
  assert.equal(verdicts.length, 1);
  assert.equal(v.allowed, false);
  assert.equal(v.publish?.published, true);
  assert.equal(publishedHash(v), PUBLISH_HASH);
  assert.equal(v.hash, undefined, "a published refusal performed nothing, so it settled nothing");
  assert.deepEqual(calls, ["probe", "tryExecute"], "the publication goes through tryExecute, never execute");
  assert.equal(budget.remaining(), 0, "and it spends the window's slot");
});

checkAsync("a published refusal carries the intent's native value, untouched", async () => {
  // The reason this assertion exists: a PER_TX refusal is a refusal ABOUT the value. Publish it at
  // zero and the same check passes, tryExecute forwards, and publishing becomes a way to run a
  // cheaper version of the call the scope just refused. Stripping the value survives every
  // assertion about method names, so the value itself has to be asserted.
  const { key, sent } = stubKey(false);
  const budget = new PublishBudget(publishRefusals);
  const priced: Intent = {
    rationale: "a swap the per-tx cap refuses, where the value is the reason it was refused",
    utility: 90,
    call: { target: ROUTER, data: "0xdeadbeef" as Hex, value: parseEther("1") },
  };
  const v = (await step(key, stubOptions([priced]), budget))[0]!;
  assert.equal(v.publish?.published, true);
  assert.equal(sent.length, 1, "exactly one call reached the chain");
  assert.equal(sent[0]!.value, parseEther("1"), "the publication must carry the value that was refused");
  assert.equal(sent[0]!.target, ROUTER);
  assert.equal(sent[0]!.data, "0xdeadbeef");
});

checkAsync("a publication the chain settled is recorded as settled, not as published", async () => {
  // The epoch-boundary race, measured on a real EVM by an independent seat: the probe refuses on
  // PER_EPOCH, the epoch rolls, tryExecute passes the same check and FORWARDS the call. The
  // receipt carries ScopedCall and no refusal exists.
  const { key, calls } = stubKey(false, { outcome: "settled" });
  const budget = new PublishBudget(publishRefusals);
  const v = (await step(key, stubOptions([wants(90)]), budget))[0]!;
  assert.equal(v.allowed, true, "the chain performed the call, so the verdict says so");
  assert.equal(v.hash, PUBLISH_HASH, "and the hash is the settled call, not a published refusal");
  assert.equal(v.publish, undefined, "nothing was published, because ScopeViolation only fires on a breach");
  assert.deepEqual(calls, ["probe", "tryExecute"]);
  assert.equal(budget.remaining(), 0, "the slot is still spent on the attempt");
});

checkAsync("a publication whose call reverted is recorded as neither published nor settled", async () => {
  const { key } = stubKey(false, { outcome: "callReverted" });
  const budget = new PublishBudget(publishRefusals);
  const v = (await step(key, stubOptions([wants(90)]), budget))[0]!;
  assert.equal(v.allowed, false, "nothing was performed");
  assert.equal(v.publish?.published, false, "and nothing was published, so the record must not claim one");
  assert.equal(v.hash, undefined);
  assert.match(publishNote(v), /no ScopeViolation exists/);
  assert.match(publishNote(v), /epoch budget was charged anyway/);
});

checkAsync("a refusal under the threshold is dropped, and nothing is broadcast", async () => {
  const { key, calls } = stubKey(false);
  const budget = new PublishBudget(publishRefusals);
  const v = (await step(key, stubOptions([wants(publishRefusals.minUtility - 1)]), budget))[0]!;
  assert.equal(v.allowed, false);
  assert.equal(v.publish?.published, false);
  assert.match(publishNote(v), new RegExp(`under the ${publishRefusals.minUtility} publish threshold`));
  assert.deepEqual(calls, ["probe"], "a dropped refusal never reaches the chain");
  assert.equal(budget.remaining(), publishRefusals.slotsPerWindow, "and it spends no slot");
});

checkAsync("an intent naming no utility is never published, because silence is not a bid", async () => {
  const { key, calls } = stubKey(false);
  const budget = new PublishBudget(publishRefusals);
  const v = (await step(key, stubOptions([wants(undefined)]), budget))[0]!;
  assert.equal(v.publish?.published, false);
  assert.match(publishNote(v), /silence is not a bid/);
  assert.deepEqual(calls, ["probe"]);
  assert.equal(budget.remaining(), publishRefusals.slotsPerWindow);
});

checkAsync("the slot budget exhausts inside a window, and refills when the window rolls", async () => {
  let clock = 1_000_000;
  const budget = new PublishBudget(publishRefusals, () => clock);
  const { key, calls } = stubKey(false);
  const two = stubOptions([wants(90), wants(95)]);

  const first = await step(key, two, budget);
  assert.equal(first[0]!.publish?.published, true, "the first refusal takes the slot");
  assert.equal(first[1]!.publish?.published, false, "the second is refused publication, not utility");
  assert.match(publishNote(first[1]!), /slot\(s\) are already spent/);
  assert.deepEqual(calls, ["probe", "tryExecute", "probe"]);

  const second = await step(key, two, budget);
  assert.equal(
    second.every((v) => v.publish?.published === false),
    true,
    "a later pass inside the same window still cannot publish",
  );
  assert.deepEqual(calls, ["probe", "tryExecute", "probe", "probe", "probe"]);

  clock += publishRefusals.windowSeconds * 1_000;
  const third = await step(key, stubOptions([wants(90)]), budget);
  assert.equal(third[0]!.publish?.published, true, "a new window is a new slot");
  assert.equal(publishedHash(third[0]!), PUBLISH_HASH);
});

checkAsync("a publication that dies at the node keeps the loop running and keeps the slot spent", async () => {
  const { key, calls } = stubKey(false, { error: "connection refused" });
  const budget = new PublishBudget(publishRefusals);
  const v = (await step(key, stubOptions([wants(90)]), budget))[0]!;
  assert.equal(v.allowed, false, "the verdict is still a refusal");
  assert.equal(v.publish?.published, false);
  assert.match(publishNote(v), /connection refused/);
  assert.deepEqual(calls, ["probe", "tryExecute"]);
  assert.equal(budget.remaining(), 0, "the slot is spent on the attempt, so a flaky node cannot loop");
});

checkAsync("an in-scope call still settles through execute and carries no publish outcome", async () => {
  const { key, calls } = stubKey(true);
  const budget = new PublishBudget(publishRefusals);
  const v = (await step(key, stubOptions([wants(100)]), budget))[0]!;
  assert.equal(v.allowed, true);
  assert.equal(v.hash, SETTLE_HASH);
  assert.equal(v.publish, undefined, "publishing is a refusal path only");
  assert.deepEqual(calls, ["probe", "execute"]);
  assert.equal(budget.remaining(), publishRefusals.slotsPerWindow, "an allowed call spends no slot");
});

// -- 10. the utility gate, against a brain that is untrusted input ------------------------------
/**
 * A gate that only COMPARES is a gate that coerces. JS relational operators convert both sides, so
 * a string, an array of one number, or an object with a valueOf all clear a numeric threshold, and
 * the last of those runs the brain's own code inside our log line.
 */

const REFUSED_BIDS: Array<[string, unknown]> = [
  // The coercing bids first, because they are the ones a comparing gate lets through.
  ["the string 80", "80"],
  ["a padded string", "  80  "],
  ["an array holding 80", [80]],
  ["an object with a valueOf", { valueOf: () => 100 }],
  ["the bigint 100n", 100n],
  ["Infinity", Number.POSITIVE_INFINITY],
  // And the bids that were already refused, kept so a fix cannot trade one hole for another.
  ["undefined", undefined],
  ["null", null],
  ["NaN", Number.NaN],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["a boolean", true],
];

check("every bid that is not a finite number is refused, and none of them spends a slot", () => {
  for (const [name, bid] of REFUSED_BIDS) {
    const budget = new PublishBudget(publishRefusals);
    const decision = budget.consider(bid);
    assert.equal(decision.publish, false, `${name} must not buy a publication`);
    assert.equal(budget.remaining(), publishRefusals.slotsPerWindow, `${name} must not spend a slot`);
    assert.equal(decision.utility, undefined, `${name} is not a number, so there is nothing to record`);
  }
});


check("a negative number is a real bid, so it is refused on the threshold and still recorded", () => {
  // The line between the two tables above and this one: -5 IS a finite number, so the gate has a
  // real value to compare and to record. Only a bid that is not a number leaves utility absent.
  const budget = new PublishBudget(publishRefusals);
  const decision = budget.consider(-5);
  assert.equal(decision.publish, false);
  assert.equal(decision.utility, -5, "the gate compared it, so the record holds it");
  assert.match(decision.note, /utility -5 is under the 60 publish threshold/);
  assert.equal(budget.remaining(), publishRefusals.slotsPerWindow);
});
check("a note never renders the bid itself, so a valueOf cannot reach the record", () => {
  const budget = new PublishBudget(publishRefusals);
  const hostile = {
    valueOf: () => {
      throw new Error("the brain's code ran inside our log line");
    },
    toString: () => {
      throw new Error("the brain's code ran inside our log line");
    },
  };
  const decision = budget.consider(hostile);
  assert.equal(decision.publish, false);
  assert.match(decision.note, /an object where a number belongs/);
  assert.doesNotMatch(decision.note, /\[object Object\]/);
});

check("a finite number at the threshold publishes, and one below it does not", () => {
  const at = new PublishBudget(publishRefusals);
  assert.equal(at.consider(publishRefusals.minUtility).publish, true);
  const under = new PublishBudget(publishRefusals);
  assert.equal(under.consider(publishRefusals.minUtility - 0.001).publish, false);
});

checkAsync("the verdict records the number that gated it, not whatever the intent says later", async () => {
  // The intent belongs to the brain. A getter, a proxy or a later mutation makes a second read a
  // different number, so a consumer reading verdict.intent.utility would explain the decision with
  // a value that had no part in it.
  let reads = 0;
  const shifty = {
    rationale: "an intent whose utility changes when you look at it twice",
    call: { target: ROUTER, data: "0xdeadbeef" as Hex },
  } as Intent;
  Object.defineProperty(shifty, "utility", {
    get: () => (reads++ === 0 ? 100 : 0),
    enumerable: true,
  });

  const { key } = stubKey(false);
  const budget = new PublishBudget(publishRefusals);
  const v = (await step(key, stubOptions([shifty]), budget))[0]!;
  assert.equal(v.publish?.published, true);
  assert.equal(v.publish?.utility, 100, "the verdict holds the number the gate compared");
  assert.equal(v.intent.utility, 0, "while a second read of the intent gives something else entirely");
  assert.match(publishNote(v), /utility 100 cleared 60/);
});

// -- 11. what a published refusal costs ---------------------------------------------------------
/**
 * The price is CLIENT SIDE, and every assertion below is about a well behaved agent honouring its
 * own policy. None of them is evidence that anybody is made to pay. The delegate carries no
 * publication counter, requires no minimum value on the violation branch, and retains whatever
 * surplus arrives at the agent EOA, so a fork that deletes the price publishes for free and these
 * checks would still be green. The contract-side version is tracked separately.
 *
 * The default is zero, which means the paid path is the one nobody exercises in normal running.
 * That is exactly the path a defect hides in, so it is the path these drive hardest.
 */

const PRICED: PublishPolicy = { ...publishRefusals, publicationCost: 7_000_000_000n };

checkAsync("a paid publication hands the price to the chain and records it on the verdict", async () => {
  const { key, paid } = stubKey(false);
  const v = (await step(key, stubOptions([wants(90)]), new PublishBudget(PRICED)))[0]!;
  assert.equal(v.publish?.published, true);
  assert.equal(v.paid, PRICED.publicationCost, "the verdict says what it cost, so nobody re-derives it");
  assert.deepEqual(paid, [PRICED.publicationCost], "and the loop handed exactly that to tryExecute");
  assert.match(publishNote(v), /at 7000000000 wei/);
});

checkAsync("a free publication records a paid zero, and a refusal that reached no node records nothing", async () => {
  // Zero and absent are different facts and a consumer totalling costs needs them apart: zero is a
  // price that was paid, absent is a transaction that never happened.
  const free = stubKey(false);
  const v = (await step(free.key, stubOptions([wants(90)]), new PublishBudget(publishRefusals)))[0]!;
  assert.equal(v.publish?.published, true);
  assert.equal(v.paid, 0n, "free is a price, not an absence");
  assert.deepEqual(free.paid, [0n], "and the default hands zero down the same argument a price would use");

  const dropped = stubKey(false);
  const under = (
    await step(dropped.key, stubOptions([wants(publishRefusals.minUtility - 1)]), new PublishBudget(PRICED))
  )[0]!;
  assert.equal(under.paid, undefined, "nothing was broadcast, so there is no price to report at all");

  const inScope = stubKey(true);
  const allowed = (await step(inScope.key, stubOptions([wants(100)]), new PublishBudget(PRICED)))[0]!;
  assert.equal(allowed.paid, undefined, "an allowed call buys no record and pays nothing for one");
});

checkAsync("a price does not change the call that is published, only what is attached to it", async () => {
  const { key, sent, paid } = stubKey(false);
  const priced: Intent = {
    rationale: "a swap the per-tx cap refuses, published under a price",
    utility: 90,
    call: { target: ROUTER, data: "0xdeadbeef" as Hex, value: parseEther("1") },
  };
  const v = (await step(key, stubOptions([priced]), new PublishBudget(PRICED)))[0]!;
  assert.equal(v.publish?.published, true);
  assert.equal(sent[0]!.value, parseEther("1"), "the refused value is untouched by the price");
  assert.equal(sent[0]!.target, ROUTER);
  assert.deepEqual(paid, [PRICED.publicationCost], "the price travels beside the call, never inside it");
});

checkAsync("the loop pays the price the gate quoted, not a second read of the policy", async () => {
  // Same argument as the shifty utility above, one field over. The policy is a plain object a
  // caller holds, so a getter, a proxy or a later edit makes a second read a different number, and
  // the loop would pay a price nothing had agreed to.
  let reads = 0;
  const shifty = { ...publishRefusals } as PublishPolicy;
  Object.defineProperty(shifty, "publicationCost", {
    get: () => (reads++ === 0 ? 5n : 999n),
    enumerable: true,
  });
  const { key, paid } = stubKey(false);
  const v = (await step(key, stubOptions([wants(90)]), new PublishBudget(shifty)))[0]!;
  assert.equal(v.publish?.published, true);
  assert.deepEqual(paid, [5n], "what reached the chain is the price the decision committed to");
  assert.equal(v.paid, 5n, "and the record agrees with what was sent");
  assert.equal(reads, 1, "read once, which is what makes those two agree");
});

checkAsync("every ending that broadcast a transaction reports its price, including the two that record nothing", async () => {
  const settled = stubKey(false, { outcome: "settled" });
  const s = (await step(settled.key, stubOptions([wants(90)]), new PublishBudget(PRICED)))[0]!;
  assert.equal(s.allowed, true);
  assert.equal(s.publish, undefined, "still nothing published, and the price must not vanish with it");
  assert.equal(s.paid, PRICED.publicationCost, "the transaction mined, so it was paid");

  const reverted = stubKey(false, { outcome: "callReverted" });
  const r = (await step(reverted.key, stubOptions([wants(90)]), new PublishBudget(PRICED)))[0]!;
  assert.equal(r.publish?.published, false);
  assert.equal(r.paid, PRICED.publicationCost, "paid and got no record for it, the worst ending to lose track of");

  const dead = stubKey(false, { error: "connection refused" });
  const d = (await step(dead.key, stubOptions([wants(90)]), new PublishBudget(PRICED)))[0]!;
  assert.equal(d.publish?.published, false);
  assert.equal(d.paid, "unknown", "it may have been broadcast before the failure, so a zero would be a guess");
  assert.match(publishNote(d), /connection refused/);
});

// -- The amount lane, and the self-call gate ----------------------------
//
// These cover the two rules added when the vendored bytecode was brought back in line with source.
// Both are REFUSALS, and a refusal with only happy-path coverage is a rule nobody has watched say
// no. That is not hypothetical here: the sibling suite in langchain-untoll went green at 56 of 56
// on 2026-08-31 with its allowance refusal disarmed, because every case it had left the unit caps
// at zero and so fired on the second term of a two-term rule. The isolating cases below exist
// because of that, not in spite of it.

const APPROVE = "approve(address,uint256)";
const INCREASE = "increaseAllowance(address,uint256)";

check("an allowance-granting call with no amount policy is refused", () => {
  assert.throws(
    () => buildScope(basePolicy({ calls: [{ signature: APPROVE }], targets: [ROUTER] })),
    /grants a standing allowance/,
  );
});

check("increaseAllowance is refused on the same ground, not just approve", () => {
  assert.throws(
    () => buildScope(basePolicy({ calls: [{ signature: INCREASE }], targets: [ROUTER] })),
    /grants a standing allowance/,
  );
});

check("an approve metered but with no unit caps is still refused", () => {
  // Isolates the CAP term: the policy is present, the caps are absent.
  assert.throws(
    () => buildScope(basePolicy({ calls: [{ signature: APPROVE, amountArg: 2 }], targets: [ROUTER] })),
    /grants a standing allowance/,
  );
});

check("an approve with unit caps but no amount policy is still refused", () => {
  // Isolates the POLICY term: the caps are present, the policy is absent. This is the case that
  // kills a `metered = true` mutant, and the one its sibling suite was missing.
  assert.throws(
    () =>
      buildScope(
        basePolicy({
          calls: [{ signature: APPROVE }],
          targets: [ROUTER],
          perTxUnitCap: 1_000n,
          perEpochUnitCap: 5_000n,
        }),
      ),
    /grants a standing allowance/,
  );
});

check("a metered approve with both unit caps reaches the tuple", () => {
  const scope = buildScope(
    basePolicy({
      calls: [{ signature: APPROVE, amountArg: 2 }],
      targets: [ROUTER],
      perTxUnitCap: 1_000n,
      perEpochUnitCap: 5_000n,
    }),
  );
  assert.deepEqual(scope.amountSelectors, ["0x095ea7b3"]);
  assert.deepEqual(scope.amountArgs, [2n]);
  assert.equal(scope.perTxUnitCap, 1_000n);
  assert.equal(scope.perEpochUnitCap, 5_000n);
});

check("an amountArg pointing at a non-uint argument is refused", () => {
  assert.throws(
    () =>
      buildScope(
        basePolicy({
          calls: [{ signature: APPROVE, amountArg: 1 }],
          targets: [ROUTER],
          perTxUnitCap: 1_000n,
          perEpochUnitCap: 5_000n,
        }),
      ),
    /not a uint/,
  );
});

check("an amountArg outside the argument list is refused", () => {
  assert.throws(
    () =>
      buildScope(
        basePolicy({
          calls: [{ signature: APPROVE, amountArg: 9 }],
          targets: [ROUTER],
          perTxUnitCap: 1_000n,
          perEpochUnitCap: 5_000n,
        }),
      ),
    /outside its 2 arguments/,
  );
});

check("a scope with no allowance selector needs no unit caps", () => {
  // The common case must stay free. Claim calls grant nothing, so an unarmed lane is correct.
  const scope = buildScope(basePolicy());
  assert.equal(scope.perTxUnitCap, 0n);
  assert.deepEqual(scope.amountSelectors, []);
});

// The self-call gate. installScope refuses before it signs, and the two operands fail separately.
// A wallet is only read for `account.address` on these paths, so a minimal stand-in is enough and
// keeps the check offline.
const walletFor = (address: Address) => ({ account: { address } }) as unknown as Wallet;
const NOT_THE_AGENT = getAddress("0x00000000000000000000000000000000000000dd");

checkAsync("installScope refuses a scope whose owner is not the agent EOA", async () => {
  const key = new SessionKey({} as unknown as Reader, OWNER);
  const scope = buildScope(basePolicy({ owner: NOT_THE_AGENT }));
  await assert.rejects(() => key.installScope(walletFor(OWNER), scope), /initialize requires the scope's owner/);
});

checkAsync("installScope refuses a wallet that is not the agent EOA", async () => {
  // The rule the contract actually enforces is msg.sender == address(this), a SELF-call. The old
  // pre-flight compared the wallet to scope.owner, which is the comparison the contract STOPPED
  // making on 2026-08-20 because the caller picks both sides of it.
  const key = new SessionKey({} as unknown as Reader, OWNER);
  const scope = buildScope(basePolicy());
  await assert.rejects(
    () => key.installScope(walletFor(NOT_THE_AGENT), scope),
    /msg.sender == address\(this\)/,
  );
});

await asyncChecks;

console.log(`\n  ${checks} checks passed\n`);

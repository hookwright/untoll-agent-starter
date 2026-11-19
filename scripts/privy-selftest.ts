import assert from "node:assert/strict";
import {
  getAddress,
  numberToHex,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import {
  SCOPE_OK,
  SessionKey,
  Untoll,
  bindPrivySessionKey,
  buildScope,
  privyToViemAccount,
  reasonTag,
  robinhoodTestnet,
  toPrivyTransaction,
  withPrivySessionKey,
  type PrivyEthereumRpc,
  type PrivyServerWallet,
  type Scope,
  type ScopePolicy,
} from "../src/index.ts";
import { PrivyAdapterError } from "../src/privy.ts";

/**
 * The offline gate for the Privy adapter. No Privy app, no keys, no network: a fake that satisfies
 * Privy's documented server-signer shape stands in for the live client, and a reader that models
 * the delegate's on-chain verdict stands in for the chain. What is proven with no simulation at all
 * is the binding: the adapter refuses to bind a Privy wallet whose address is not the scope's
 * session key, which is the address the delegate checks msg.sender against at settlement.
 *
 * What is NOT proven here, and needs the operator's Privy keys plus a wired chain at the Prague
 * hardfork: a real Privy signature landing a real execute on chain, and whether a Privy embedded
 * wallet can sign the owner's EIP-7702 authorization. The authoritative enforcer is the deployed
 * delegate bytecode; the reader below only models its documented reasons so the wiring can run.
 */

let checks = 0;
const check = (name: string, fn: () => void | Promise<void>) => {
  const done = () => {
    checks++;
    console.log(`  ok   ${name}`);
  };
  const r = fn();
  if (r instanceof Promise) return r.then(done);
  done();
  return Promise.resolve();
};

const OWNER = getAddress("0x0cd6724019EFBA2ff175fA05a74E43eb0f4aa847");
const PRIVY_ADDR = getAddress("0x636ba41419248456F4c02EB8825e6835eb0d9524");
const ATTACKER = getAddress("0x00000000000000000000000000000000DeaDBeef");
const HOOK = getAddress("0x6793347aE686A80c65BA49204Fe33b5C8bbB6aC8");
const ROUTER = getAddress("0x325407204587605AE974a82406F70dD7A1E5A961");
const NOW = 1_800_000_000n;
const POOL_ID = ("0x" + "11".repeat(32)) as Hex;

/** A fake Privy server signer: records the transaction it was asked to sign, returns a canned blob. */
function fakePrivyWallet(over: Partial<PrivyServerWallet> = {}): {
  wallet: PrivyServerWallet;
  seen: { transaction?: unknown };
} {
  const seen: { transaction?: unknown } = {};
  const rpc: PrivyEthereumRpc = {
    async signTransaction(walletId, options) {
      seen.transaction = options.params.transaction;
      assert.equal(walletId, "wallet-abc", "the adapter signs with the wallet id it was given");
      return { signed_transaction: "0xdeadbeef", encoding: "hex" };
    },
  };
  return {
    seen,
    wallet: { walletId: "wallet-abc", address: PRIVY_ADDR, rpc, ...over },
  };
}

const claimScope = (): Scope =>
  buildScope({
    owner: OWNER,
    sessionKey: PRIVY_ADDR,
    targets: [HOOK],
    calls: Untoll.CLAIM_SIGNATURES.map((signature) => ({ signature })),
    recipients: [OWNER],
    perTxCap: 0n,
    perEpochCap: 0n,
    epochLength: 3_600n,
    expiresIn: 86_400n,
    now: NOW,
  });

/**
 * A reader that models the delegate's `probe`, in the order and with the reason tags the SDK
 * documents. This is a test double for the chain, not the enforcer: the enforcer is the bytecode.
 * It exists so an out-of-scope call can be driven through the real SessionKey.probe offline.
 */
function delegateReader(scope: Scope, agent: Address, now = NOW + 10n) {
  const targets = new Set(scope.targets.map((t) => t.toLowerCase()));
  const selectors = new Set(scope.selectors.map((s) => s.toLowerCase()));
  const recipients = new Set(scope.recipients.map((r) => r.toLowerCase()));

  const verdict = (target: Address, value: bigint, data: Hex): readonly [boolean, Hex] => {
    if (now >= scope.expiry) return [false, reasonTag("EXPIRED")];
    if (data.length < 10) return [false, reasonTag("CALLDATA_SHORT")];
    const selector = data.slice(0, 10).toLowerCase();
    if (!targets.has(target.toLowerCase())) return [false, reasonTag("TARGET")];
    if (!selectors.has(selector)) return [false, reasonTag("SELECTOR")];
    if (value > scope.perTxCap) return [false, reasonTag("PER_TX")];
    const ri = scope.recipientSelectors.findIndex((s) => s.toLowerCase() === selector);
    if (ri !== -1) {
      const arg = Number(scope.recipientArgs[ri]);
      const start = 2 + 8 + (arg - 1) * 64;
      const word = data.slice(start, start + 64);
      const recipient = getAddress(("0x" + word.slice(24)) as Hex);
      if (!recipients.has(recipient.toLowerCase())) return [false, reasonTag("RECIPIENT")];
    }
    return [true, SCOPE_OK];
  };

  return {
    async readContract(args: { address: Address; functionName: string; args: readonly unknown[] }) {
      assert.equal(args.functionName, "probe", "the model reader only serves probe");
      assert.equal(args.address.toLowerCase(), agent.toLowerCase(), "probe is addressed to the agent EOA");
      const [target, value, data] = args.args as [Address, bigint, Hex];
      return verdict(target, value, data);
    },
  };
}

async function main() {
  // -- 1. the bridge: a Privy wallet becomes a viem local account at the same address ----------
  await check("privyToViemAccount yields a local account at the Privy wallet address", () => {
    const { wallet } = fakePrivyWallet();
    const account = privyToViemAccount(wallet);
    assert.equal(account.address, PRIVY_ADDR);
    assert.equal(account.type, "local");
    assert.equal(typeof account.signTransaction, "function");
  });

  await check("the account signs through Privy and returns Privy's serialized transaction", async () => {
    const { wallet, seen } = fakePrivyWallet();
    const account = privyToViemAccount(wallet);
    const signed = await account.signTransaction({
      to: HOOK,
      value: parseEther("0.01"),
      data: "0x1234" as Hex,
      chainId: robinhoodTestnet.id,
      nonce: 3,
      gas: 21_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      type: "eip1559",
    });
    assert.equal(signed, "0xdeadbeef", "the signed blob is passed straight through from Privy");
    const tx = seen.transaction as Record<string, unknown>;
    assert.equal(tx.to, HOOK);
    assert.equal(tx.chain_id, robinhoodTestnet.id);
    assert.equal(tx.value, numberToHex(parseEther("0.01")));
    assert.equal(tx.max_fee_per_gas, numberToHex(2_000_000_000n));
    assert.equal(tx.type, 2, "eip1559 maps to type 2");
  });

  await check("toPrivyTransaction omits absent fields rather than sending nulls", () => {
    const req = toPrivyTransaction({ to: HOOK, chainId: robinhoodTestnet.id });
    assert.deepEqual(req, { to: HOOK, chain_id: robinhoodTestnet.id });
  });

  // -- 2. the binding guards, proven with no simulation ----------------------------------------
  await check("binding produces a wallet at the Privy address on the UNTOLL chain", () => {
    const { wallet } = fakePrivyWallet();
    const session = bindPrivySessionKey({ wallet, scope: claimScope(), chain: robinhoodTestnet });
    assert.equal(session.account.address, PRIVY_ADDR);
    assert.equal(session.chain.id, robinhoodTestnet.id);
  });

  await check("REJECTED: a Privy wallet that is not the scope's session key", () => {
    const { wallet } = fakePrivyWallet({ address: ATTACKER });
    assert.throws(
      () => bindPrivySessionKey({ wallet, scope: claimScope(), chain: robinhoodTestnet }),
      (e: Error) => {
        assert.ok(e instanceof PrivyAdapterError);
        assert.match(e.message, /not the scope's session key/i);
        return true;
      },
    );
  });

  await check("REJECTED: binding the cold owner key as the hot session signer", () => {
    const scope: Scope = { ...claimScope(), sessionKey: OWNER, owner: OWNER };
    const { wallet } = fakePrivyWallet({ address: OWNER });
    assert.throws(
      () => bindPrivySessionKey({ wallet, scope, chain: robinhoodTestnet }),
      (e: Error) => {
        assert.match(e.message, /is the scope's owner/i);
        return true;
      },
    );
  });

  await check("withPrivySessionKey points a policy's session key at the Privy wallet", () => {
    const policy: ScopePolicy = {
      owner: OWNER,
      sessionKey: ATTACKER,
      targets: [HOOK],
      calls: Untoll.CLAIM_SIGNATURES.map((signature) => ({ signature })),
      recipients: [OWNER],
      perTxCap: 0n,
      perEpochCap: 0n,
      epochLength: 3_600n,
      expiresIn: 86_400n,
      now: NOW,
    };
    const { wallet } = fakePrivyWallet();
    const bound = withPrivySessionKey(policy, wallet);
    assert.equal(bound.sessionKey, PRIVY_ADDR);
    // and the scope it builds can be bound without tripping the address guard
    const scope = buildScope(bound);
    const session = bindPrivySessionKey({ wallet, scope, chain: robinhoodTestnet });
    assert.equal(session.account.address, PRIVY_ADDR);
  });

  // -- 3. the point: a Privy-onboarded agent's out-of-scope call is rejected before settlement ---
  // The session key is bound through the adapter; the call is judged by the real SessionKey.probe
  // against the installed scope. The reader models the delegate's verdict (see its note).
  const scope = claimScope();
  const { wallet } = fakePrivyWallet();
  bindPrivySessionKey({ wallet, scope, chain: robinhoodTestnet }); // the agent's key, bound and confined
  const key = new SessionKey(delegateReader(scope, PRIVY_ADDR) as never, PRIVY_ADDR);
  const untoll = new Untoll({} as never, { launchHook: HOOK });

  await check("IN SCOPE: the claim the agent is meant to make is allowed", async () => {
    const probe = await key.probe(untoll.claimRewardsCall(POOL_ID, 7n));
    assert.equal(probe.ok, true);
    assert.equal(probe.reason, "OK");
  });

  await check("REJECTED: a claim redirected to a contract off the allowlist (TARGET)", async () => {
    const call = { target: ROUTER, data: untoll.claimRewardsCall(POOL_ID, 7n).data };
    const probe = await key.probe(call);
    assert.equal(probe.ok, false);
    assert.equal(probe.reason, "TARGET");
  });

  await check("REJECTED: an unlisted function on the allowed contract (SELECTOR)", async () => {
    const call = { target: HOOK, data: ("0xdeadbeef" + "00".repeat(32)) as Hex };
    const probe = await key.probe(call);
    assert.equal(probe.ok, false);
    assert.equal(probe.reason, "SELECTOR");
  });

  await check("REJECTED: native value on a claim the cap forbids (PER_TX)", async () => {
    const call = { target: HOOK, value: 1n, data: untoll.claimCreatorFeeCall(POOL_ID).data };
    const probe = await key.probe(call);
    assert.equal(probe.ok, false);
    assert.equal(probe.reason, "PER_TX");
  });

  // -- 4. the recipient hole, closed: a swap whose output is redirected to the attacker ----------
  const SWAP_SIG = "swap(address,uint256,address)";
  const swapScope = buildScope({
    owner: OWNER,
    sessionKey: PRIVY_ADDR,
    targets: [ROUTER],
    calls: [{ signature: SWAP_SIG, recipientArg: 3 }],
    recipients: [OWNER],
    perTxCap: parseEther("1"),
    perEpochCap: parseEther("1"),
    epochLength: 3_600n,
    expiresIn: 86_400n,
    now: NOW,
  });
  const swapKey = new SessionKey(delegateReader(swapScope, PRIVY_ADDR) as never, PRIVY_ADDR);
  const swapData = (recipient: Address): Hex =>
    (toFunctionSelector(SWAP_SIG) +
      HOOK.slice(2).toLowerCase().padStart(64, "0") +
      numberToHex(parseEther("0.1"), { size: 32 }).slice(2) +
      recipient.slice(2).toLowerCase().padStart(64, "0")) as Hex;

  await check("IN SCOPE: a swap whose output lands on the owner is allowed", async () => {
    const probe = await swapKey.probe({ target: ROUTER, data: swapData(OWNER) });
    assert.equal(probe.ok, true);
    assert.equal(probe.reason, "OK");
  });

  await check("REJECTED: the same swap with its output pointed at the attacker (RECIPIENT)", async () => {
    const probe = await swapKey.probe({ target: ROUTER, data: swapData(ATTACKER) });
    assert.equal(probe.ok, false);
    assert.equal(probe.reason, "RECIPIENT");
  });

  console.log(`\n  ${checks} checks passed\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

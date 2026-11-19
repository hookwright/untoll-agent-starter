import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  SessionKey,
  Untoll,
  buildScope,
  describeScope,
  resolveAddresses,
  resolveChain,
  launchHookAbi,
} from "../src/index.ts";
import { claimOnlyPolicy } from "../agent/policy.ts";
import {
  DEFAULT_REQUIRED_WEI,
  mergeEnv,
  nextStep,
  parseEnvFile,
  renderEnvBlock,
  type OnboardState,
} from "../onboard/plan.ts";

/**
 * `npm run onboard`. Nothing to a contained agent on chain, in one command.
 *
 * WHAT THIS EXISTS FOR. Before it, the route from a fresh clone to a running agent was four steps
 * that appear in no file: make two keys, get testnet ether, deploy the delegate, find a pool. The
 * README named the four environment variables and not one way to obtain any of them, so
 * `npm run agent` on a clean machine threw `UNTOLL_OWNER_KEY is not set` and left the reader with
 * no next action. Everything below is that gap, closed.
 *
 * IT HALTS ONCE, AND ONLY ONCE. Funding needs a human, because a faucet is a person or a captcha.
 * Every other step is performed here. The run is resumable: it measures the chain before each step
 * and skips whatever is already true, so funding the address and running it again picks up exactly
 * where it stopped.
 *
 * IT PROVES CONTAINMENT RATHER THAN ASSERTING IT. The last step sends two calls through the
 * installed scope: one the scope allows, and one it does not. The refused one goes through
 * `tryExecute`, so the refusal is mined as a `ScopeViolation` and the stranger ends holding a
 * transaction hash for the moment their agent was told no. A run that printed "contained" without
 * that pair would be a claim, and a claim is what this repo exists to replace.
 */

const CWD = process.cwd();
const ENV_LOCAL = join(CWD, ".env.local");

/** What the owner account needs before the run will send anything. Four transactions plus headroom. */
const OWNER_FLOOR = DEFAULT_REQUIRED_WEI;
/** What the owner forwards to the session key, so the human funds one address rather than two. */
const SESSION_STIPEND = 500_000_000_000_000n; // 0.0005 ETH

const say = (s = "") => console.log(s);
const step = (n: string, s: string) => console.log(`  ${n.padEnd(15)} ${s}`);

function loadEnv(): Record<string, string> {
  const fromFile = existsSync(ENV_LOCAL) ? parseEnvFile(readFileSync(ENV_LOCAL, "utf8")) : {};
  return mergeEnv(fromFile, process.env);
}

function writeEnvLocal(body: string): void {
  writeFileSync(ENV_LOCAL, body, { encoding: "utf8" });
}

/**
 * Halt, with the one act named.
 *
 * Exit code 75 rather than 1, and the distinction is worth keeping: 1 means the run broke, 75 means
 * the run is waiting on somebody. A wrapper that retries on failure should retry the first and
 * never the second.
 */
function halt(message: string): never {
  say("");
  say("  HALT, and this is the only step that needs you.");
  say(`  ${message}`);
  say("");
  process.exit(75);
}

const chain = resolveChain();
const rpc = chain.rpcUrls.default.http[0]!;
const reader = createPublicClient({ chain, transport: http(rpc) });
const addresses = resolveAddresses();

say("");
say("  UNTOLL agent onboarding");
step("chain", `${chain.id} at ${rpc}`);

// ------------------------------------------------------------------ step: keys
let env = loadEnv();
let ownerKey = env["UNTOLL_OWNER_KEY"] as Hex | undefined;
let sessionKey = env["UNTOLL_SESSION_KEY"] as Hex | undefined;

if (!ownerKey || !sessionKey) {
  ownerKey = generatePrivateKey();
  sessionKey = generatePrivateKey();
  writeEnvLocal(
    renderEnvBlock({
      ownerKey,
      sessionKey,
      delegateImpl: "0x0000000000000000000000000000000000000000",
      rpc,
    }).replace(
      "UNTOLL_DELEGATE_IMPL=0x0000000000000000000000000000000000000000\n",
      "# UNTOLL_DELEGATE_IMPL is written once the delegate is deployed\n",
    ),
  );
  step("keys", "generated a fresh owner key and session key, written to .env.local");
  step("", "the owner key is the one that matters. It is not on any host but this one.");
} else {
  step("keys", "read from .env.local");
}

const ownerAccount = privateKeyToAccount(ownerKey);
const sessionAccount = privateKeyToAccount(sessionKey);
const owner = createWalletClient({ account: ownerAccount, chain, transport: http(rpc) });
const session = createWalletClient({ account: sessionAccount, chain, transport: http(rpc) });

step("agent EOA", ownerAccount.address);
step("session key", sessionAccount.address);

// ------------------------------------------------------------------ step: funding
let ownerBalance = await reader.getBalance({ address: ownerAccount.address });
const state: OnboardState = {
  ownerKey,
  sessionKey,
  ownerAddress: ownerAccount.address,
  ownerBalanceWei: ownerBalance,
  requiredWei: OWNER_FLOOR,
};

if (ownerBalance < OWNER_FLOOR) {
  step("funding", `${ownerAccount.address} holds ${formatEther(ownerBalance)} ETH`);
  halt(nextStep(state).say);
}
step("funding", `${formatEther(ownerBalance)} ETH at the agent EOA, above the ${formatEther(OWNER_FLOOR)} floor`);

// ------------------------------------------------------------------ step: delegate implementation
//
// An address in the environment is not a deployment. The code is read back, because pointing a
// 7702 designator at an address with no code produces an account that looks delegated and executes
// nothing, which is the exact silent failure the SDK's own read-back exists to catch.
let implementation = env["UNTOLL_DELEGATE_IMPL"] as Address | undefined;
if (implementation && implementation !== "0x0000000000000000000000000000000000000000") {
  const code = (await reader.getCode({ address: implementation })) ?? "0x";
  if (code === "0x") {
    step("delegate", `no code at ${implementation} on chain ${chain.id}, so it is not a delegate here`);
    implementation = undefined;
  } else {
    step("delegate", `${implementation}, ${(code.length - 2) / 2} bytes of code on this chain`);
  }
}
if (!implementation) {
  step("delegate", "deploying SessionKeyDelegate from the bytecode that ships in this repo");
  implementation = await SessionKey.deployImplementation(reader, owner);
  const code = (await reader.getCode({ address: implementation })) ?? "0x";
  if (code === "0x") throw new Error(`the delegate deploy mined at ${implementation} and left no code`);
  step("delegate", `${implementation}, ${(code.length - 2) / 2} bytes, read back off chain`);
}

// ------------------------------------------------------------------ step: session stipend
//
// The containment proof is sent by the SESSION key, so it needs gas. The owner forwards it here so
// that the human funds exactly one address, which is the whole reason there is one halt.
const sessionBalance = await reader.getBalance({ address: sessionAccount.address });
if (sessionBalance < SESSION_STIPEND / 2n) {
  const hash = await owner.sendTransaction({
    account: ownerAccount,
    chain,
    to: sessionAccount.address,
    value: SESSION_STIPEND,
  });
  await reader.waitForTransactionReceipt({ hash });
  step("stipend", `forwarded ${formatEther(SESSION_STIPEND)} ETH to the session key, ${hash}`);
} else {
  step("stipend", `the session key already holds ${formatEther(sessionBalance)} ETH`);
}

// ------------------------------------------------------------------ step: delegation
const key = new SessionKey(reader, ownerAccount.address);
if (await key.isDelegatedTo(implementation)) {
  step("delegation", "already attached; the agent EOA carries the 7702 designator");
} else {
  const hash = await key.delegate({ owner, implementation });
  step("delegation", `attached and read back, ${hash}`);
}

// ------------------------------------------------------------------ step: scope
const now = (await reader.getBlock()).timestamp;
const policy = claimOnlyPolicy(
  { owner: ownerAccount.address, sessionKey: sessionAccount.address },
  addresses.launchHook,
  now,
);
const scope = buildScope(policy);

const onChain = await key.readScope();
if (onChain.initialized) {
  step("scope", `already installed, session key ${onChain.sessionKey}, expiry ${onChain.expiry}`);
} else {
  const hash = await key.installScope(owner, scope);
  step("scope", `installed, ${hash}`);
}
say("");
for (const line of describeScope(scope).split("\n")) say(`    ${line}`);
say("");

// ------------------------------------------------------------------ step: containment proof
//
// Two calls, and the second one is the point. The first is a claim on the launch hook, which the
// scope allows. The second targets a contract that is not on the target list, which it does not.
// Both are probed as reads, then the refused one is broadcast through `tryExecute` so the refusal
// becomes a row on chain rather than a line in this terminal.
const untoll = new Untoll(reader);
const poolId = (env["UNTOLL_POOL_ID"] as Hex | undefined) ?? (("0x" + "00".repeat(32)) as Hex);
// The epoch is a literal on purpose. A scope probe compares a target and a four-byte selector and
// reads no pool state at all, so calling currentEpoch here would add a way for the containment
// proof to fail for a reason that has nothing to do with containment.
const allowedCall = untoll.claimRewardsCall(poolId, 0n);
const forbiddenCall = {
  target: addresses.tokenFactory,
  value: 0n,
  // The SELECTOR here is one the scope allows. Only the TARGET is wrong, which makes this a
  // sharper control than a random call: it proves the target list is what bites, rather than
  // leaving open the possibility that the selector check did all the work.
  data: encodeFunctionData({
    abi: launchHookAbi,
    functionName: "claimCreatorFee",
    args: [poolId],
  }),
};

const allowedProbe = await key.probe(allowedCall);
const forbiddenProbe = await key.probe(forbiddenCall);
step("probe, allowed", `${allowedCall.target} claimRewards -> ok=${allowedProbe.ok} ${allowedProbe.reason}`);
step("probe, refused", `${forbiddenCall.target} off the target list -> ok=${forbiddenProbe.ok} ${forbiddenProbe.reason}`);

if (!allowedProbe.ok) {
  throw new Error(
    `the claim the scope was built to allow probed as ${allowedProbe.reason}. The scope on chain ` +
      "does not match the policy in agent/policy.ts, so nothing below would mean anything.",
  );
}
if (forbiddenProbe.ok) {
  throw new Error(
    "a call to a contract that is not on the target list probed as IN SCOPE. That is a containment " +
      "failure, not a configuration problem: stop and read the scope that is actually installed.",
  );
}

const published = await key.tryExecute(session, forbiddenCall);
step("published", `${published.outcome}, reason ${published.reason}, ${published.hash}`);
if (published.outcome !== "published") {
  throw new Error(
    `the refusal mined as ${published.outcome} rather than published, so there is no ScopeViolation ` +
      "on chain and the proof is not a proof.",
  );
}

// ------------------------------------------------------------------ done
writeEnvLocal(
  renderEnvBlock({
    ownerKey,
    sessionKey,
    delegateImpl: implementation,
    rpc,
    ...(env["UNTOLL_POOL_ID"] ? { poolId: env["UNTOLL_POOL_ID"] as Hex } : {}),
  }),
);

say("");
say("  Your agent is live on this chain and it is contained.");
say(`  The refusal is on chain at ${published.hash}. That transaction is the product.`);
say("");
say("  .env.local now carries everything the agent reads. Next:");
say("      npm run agent");
say("");

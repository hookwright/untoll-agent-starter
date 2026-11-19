import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Untoll, resolveAddresses, resolveChain } from "../src/index.ts";
import { claimOnlyPolicy } from "./policy.ts";
import { run, type Brain, type Intent } from "./agent.ts";

/**
 * Entry point. Reads its wiring from the environment, refuses to start on a gap, and says which
 * gap. Nothing here generates or stores a key: you bring accounts, the SDK never reaches for one.
 *
 * Required:
 *   UNTOLL_OWNER_KEY       installs the scope and holds the funds. Keep it off the agent host.
 *   UNTOLL_SESSION_KEY     the only key this process transacts with.
 *   UNTOLL_DELEGATE_IMPL   the SessionKeyDelegate implementation on your chain.
 *   UNTOLL_POOL_ID         the pool this agent settles for.
 * Optional:
 *   UNTOLL_RPC             defaults to Robinhood Chain testnet 46630. Needs Prague for EIP-7702.
 *   UNTOLL_PASSES          how many passes to run. Default 1.
 */

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(
      `${name} is not set. See the environment block at the top of agent/run.ts; the starter ` +
        "refuses to guess a key, a chain, or an address.",
    );
  }
  return v;
}

const chain = resolveChain();
const reader = createPublicClient({ chain, transport: http() });

const ownerAccount = privateKeyToAccount(required("UNTOLL_OWNER_KEY") as Hex);
const sessionAccount = privateKeyToAccount(required("UNTOLL_SESSION_KEY") as Hex);
const implementation = required("UNTOLL_DELEGATE_IMPL") as Address;
const poolId = required("UNTOLL_POOL_ID") as Hex;

const owner = createWalletClient({ account: ownerAccount, chain, transport: http() });
const session = createWalletClient({ account: sessionAccount, chain, transport: http() });

const untoll = new Untoll(reader);
const addresses = resolveAddresses();

/**
 * The brain, and the honest version of what a brain is.
 *
 * This one reads the chain and proposes a claim when there is something to claim. Swap it for a
 * model call and the containment does not change, which is the point: the loop treats whatever
 * comes back from here as a proposal, never as an instruction. A brain that returns an intent
 * pointed at an attacker gets the same probe as one that returns nothing.
 */
const claimBrain: Brain = async () => {
  const intents: Intent[] = [];
  const epoch = await untoll.currentEpoch(poolId);
  const claimable = await untoll.claimableRewards(poolId, ownerAccount.address, epoch);
  if (claimable > 0n) {
    intents.push({
      rationale: `epoch ${epoch} has ${claimable} wei claimable for the owner`,
      // Settling the pool is the only thing this agent wants, so it bids high. The number does
      // nothing while the claim is in scope, because an allowed call is simply made. It decides
      // one thing: whether a refusal is paid for and written down on chain, or logged and
      // dropped. The realistic refusal here is EXPIRED, and that is worth a public row.
      utility: 80,
      call: untoll.claimRewardsCall(poolId, epoch),
    });
  } else {
    console.log(`  idle            epoch ${epoch} has nothing claimable; proposing no action`);
  }
  return intents;
};

const now = (await reader.getBlock()).timestamp;

console.log("");
console.log("  UNTOLL agent starter");
console.log(`  chain           ${chain.id} at ${chain.rpcUrls.default.http[0]}`);
console.log(`  agent EOA       ${ownerAccount.address}`);
console.log(`  session key     ${sessionAccount.address}`);
console.log(`  launch hook     ${addresses.launchHook}`);
console.log("");

const verdicts = await run(
  {
    reader,
    agent: ownerAccount.address,
    owner,
    session,
    implementation,
    policy: claimOnlyPolicy(
      { owner: ownerAccount.address, sessionKey: sessionAccount.address },
      addresses.launchHook,
      now,
    ),
    brain: claimBrain,
  },
  Number(process.env.UNTOLL_PASSES ?? 1),
);

console.log("");
console.log(
  `  done            ${verdicts.filter((v) => v.allowed).length} settled, ` +
    `${verdicts.filter((v) => !v.allowed).length} stopped by the scope`,
);
console.log("");

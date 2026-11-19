import { formatEther, type Address, type Hex } from "viem";

/**
 * The onboarding domain, with no network in it.
 *
 * Separated from `scripts/onboard.ts` on purpose. The shell gathers chain state and performs
 * transactions; everything that DECIDES lives here, as pure functions over a plain record. That is
 * what makes the ordering assertable offline, and the ordering is the part that matters: a run that
 * tries to install a scope before the delegation has attached produces a revert whose message is
 * about ownership, and a stranger reading it has no way back.
 *
 * There is exactly one step in this list a machine may not perform, and naming it as data rather
 * than as a comment is deliberate. `funding` needs a human, because getting testnet ether means
 * asking a faucet, and a faucet is a person or a captcha. Every other step is ours.
 */

export type StepId =
  | "keys"
  | "funding"
  | "delegate-impl"
  | "delegation"
  | "scope"
  | "proof"
  | "done";

export type Step = {
  id: StepId;
  /** Who performs it. `human` is a halt: the run stops and prints the one act. */
  actor: "machine" | "human";
  /** One line, addressed to whoever has to act. */
  say: string;
};

/**
 * Everything the shell has measured. Every field is optional because the shell fills it in as it
 * goes, and `nextStep` is meant to be callable against a half-measured record.
 */
export type OnboardState = {
  ownerKey?: Hex;
  sessionKey?: Hex;
  ownerAddress?: Address;
  ownerBalanceWei?: bigint;
  /** What the run needs before it will attempt a transaction, in wei. */
  requiredWei: bigint;
  delegateImpl?: Address;
  /** Whether `delegateImpl` actually carries code on THIS chain. An address is not a deployment. */
  delegateImplHasCode?: boolean;
  delegated?: boolean;
  scopeInstalled?: boolean;
  proofPublished?: boolean;
};

/** The floor a run needs before it sends anything. Four transactions plus headroom. */
export const DEFAULT_REQUIRED_WEI = 2_000_000_000_000_000n; // 0.002 ETH

/**
 * The first step that is not yet satisfied.
 *
 * Order is the contract, and it is not arbitrary. Keys before funding, because there is no address
 * to fund until the keys exist. Funding before the delegate deploy, because a deploy is the first
 * transaction. The delegate implementation before the delegation, because 7702 points an account at
 * an implementation and an account pointed at an address with no code is delegated to nothing. The
 * delegation before the scope, because `initialize` is a call INTO the delegate's code and there is
 * no code at the account until the designator is written. The scope before the proof, because the
 * proof is a refusal and an account with no scope refuses nothing.
 */
export function nextStep(state: OnboardState): Step {
  if (!state.ownerKey || !state.sessionKey) {
    return {
      id: "keys",
      actor: "machine",
      say: "generating an owner key and a session key, and writing them to .env.local",
    };
  }
  if ((state.ownerBalanceWei ?? 0n) < state.requiredWei) {
    return {
      id: "funding",
      actor: "human",
      say: fundingAsk(state),
    };
  }
  if (!state.delegateImpl || !state.delegateImplHasCode) {
    return {
      id: "delegate-impl",
      actor: "machine",
      say: state.delegateImpl
        ? `UNTOLL_DELEGATE_IMPL is ${state.delegateImpl} and there is no code at it on this chain, so deploying a fresh one`
        : "deploying SessionKeyDelegate from the creation bytecode that ships in this repo",
    };
  }
  if (!state.delegated) {
    return {
      id: "delegation",
      actor: "machine",
      say: "attaching the delegate to the agent EOA under EIP-7702, then reading the code back",
    };
  }
  if (!state.scopeInstalled) {
    return {
      id: "scope",
      actor: "machine",
      say: "installing the claim-only scope, which is owner-gated and callable once",
    };
  }
  if (!state.proofPublished) {
    return {
      id: "proof",
      actor: "machine",
      say: "proving containment on chain: one call the scope allows, one it does not",
    };
  }
  return { id: "done", actor: "machine", say: "the agent is contained and live on this chain" };
}

/** Every step, in order, so a run can print the whole route before it walks any of it. */
export const STEP_ORDER: readonly StepId[] = [
  "keys",
  "funding",
  "delegate-impl",
  "delegation",
  "scope",
  "proof",
  "done",
];

/**
 * The funding halt, written for the person who has to act.
 *
 * It names the address, the shortfall and the chain, because a halt that says "insufficient funds"
 * sends a stranger to search for which account and how much, and that search is where the thirty
 * minutes goes.
 */
export function fundingAsk(state: OnboardState): string {
  const have = state.ownerBalanceWei ?? 0n;
  const short = state.requiredWei - have;
  const at = state.ownerAddress ?? "the owner address";
  return (
    `fund ${at} with at least ${formatEther(short)} more ETH on this chain ` +
    `(it holds ${formatEther(have)}, the run needs ${formatEther(state.requiredWei)}), then run this again`
  );
}

/**
 * The env block a finished run prints, in the order the agent reads it.
 *
 * The owner key is the one secret here that is worth more than the others, so it is rendered by
 * whoever calls this, never assembled with a default. A helper that could silently emit an empty
 * key would produce a file that looks configured and is not.
 */
export function renderEnvBlock(values: {
  ownerKey: Hex;
  sessionKey: Hex;
  delegateImpl: Address;
  rpc?: string;
  poolId?: Hex;
}): string {
  const lines = [
    `UNTOLL_OWNER_KEY=${values.ownerKey}`,
    `UNTOLL_SESSION_KEY=${values.sessionKey}`,
    `UNTOLL_DELEGATE_IMPL=${values.delegateImpl}`,
  ];
  if (values.rpc) lines.push(`UNTOLL_RPC=${values.rpc}`);
  lines.push(
    values.poolId
      ? `UNTOLL_POOL_ID=${values.poolId}`
      : "# UNTOLL_POOL_ID=0x...   the pool this agent settles for. The containment proof above needed none.",
  );
  return lines.join("\n") + "\n";
}

/**
 * Parse a dotenv-shaped file into a record, with no dependency and no execution.
 *
 * Deliberately dumb: `KEY=value`, first `=` wins, `#` only at the start of a line. It exists so a
 * resumed run can read back what a previous run wrote, and reading a key file is not the place for
 * a parser that does anything clever.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Merge what a previous run wrote under what the environment says, environment winning.
 *
 * The direction is the whole point. A stranger who exports `UNTOLL_DELEGATE_IMPL` to point at a
 * different chain's delegate must not have a stale `.env.local` silently override it, because the
 * failure that produces is a delegation to an address with no code, which is the exact silent
 * no-op the SDK's read-back exists to catch.
 */
export function mergeEnv(
  fromFile: Record<string, string>,
  fromProcess: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = { ...fromFile };
  for (const [k, v] of Object.entries(fromProcess)) {
    if (v && v.trim()) out[k] = v.trim();
  }
  return out;
}

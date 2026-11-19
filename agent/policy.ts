import { parseEther, type Address } from "viem";
import { Untoll, type ScopePolicy } from "../src/index.ts";

/**
 * The policy. This file is the one a human writes and reads.
 *
 * Everything the agent may ever do is here, in one screen, in terms a person can check. The model
 * never sees it, cannot widen it, and does not need to be trusted to respect it: after
 * `installScope` it is bytecode at the agent's own address.
 *
 * The habit worth keeping when you fork this: change this file, not the agent loop. If a new
 * capability needs a new target or a new selector, it belongs here, where the review happens.
 */

export type AgentIdentity = {
  /** Installs the scope, holds the funds, never handed to the model. */
  owner: Address;
  /** The only key the agent process holds. */
  sessionKey: Address;
};

/**
 * A claim-only agent: it settles what a pool owes and can do nothing else.
 *
 * Worth reading closely, because it is the whole argument. The targets list is one contract. The
 * selector list is three pull-based claims, all of which pay the caller and take no address
 * argument, so there is no output to redirect. The value caps are zero because a claim sends no
 * native value: an agent that only claims never needs to spend, so the cap that costs nothing to
 * set is zero. A model that gets talked into transferring the treasury reaches for a target that
 * is not on this list and stops there.
 */
export function claimOnlyPolicy(
  identity: AgentIdentity,
  launchHook: Address,
  now: bigint,
  ttlSeconds = 86_400n,
): ScopePolicy {
  return {
    owner: identity.owner,
    sessionKey: identity.sessionKey,
    targets: [launchHook],
    calls: Untoll.CLAIM_SIGNATURES.map((signature) => ({ signature })),
    recipients: [identity.owner],
    perTxCap: 0n,
    perEpochCap: 0n,
    epochLength: 3_600n,
    expiresIn: ttlSeconds,
    now,
  };
}

/**
 * A trading agent, as a worked example of the part that actually needs care.
 *
 * The moment an agent may call a router, the target and selector allowlists stop being enough: an
 * allowed swap on an allowed router, with the output address pointed at the attacker, satisfies
 * both. `recipientArg` is what closes it, and `reviewScope` warns on any allowed call that omits
 * one. Count the arguments on the real router signature you use. The index is 1-based and the
 * recipient must sit ahead of any dynamic argument, or the delegate reads an offset instead of
 * an address.
 */
export function tradingPolicy(
  identity: AgentIdentity,
  router: Address,
  routerSwapSignature: string,
  recipientArg: number,
  now: bigint,
): ScopePolicy {
  return {
    owner: identity.owner,
    sessionKey: identity.sessionKey,
    targets: [router],
    calls: [{ signature: routerSwapSignature, recipientArg }],
    recipients: [identity.owner],
    perTxCap: parseEther("0.05"),
    perEpochCap: parseEther("0.2"),
    epochLength: 3_600n,
    expiresIn: 7_200n,
    now,
  };
}

/**
 * What the agent will pay to have refused in public.
 *
 * The loop probes before it acts, so a refused intent normally costs nothing and leaves no trace.
 * That is right for the money and wrong for the record: an agent that only ever broadcasts what it
 * was allowed to do publishes a history with every interesting moment cut out of it. So a refusal
 * the agent wanted badly enough goes out anyway, through `tryExecute`, which mines a
 * `ScopeViolation` instead of reverting, and the refusal becomes a public row.
 *
 * Deliberate first, then scarce. Deliberate is the threshold: the intent has to clear a bar. Scarce
 * is the slot: a small number of publications per window, so the record reads as the thwarted want
 * the agent judged most important that window rather than as a defect log. Publishing every refusal
 * would produce the second thing, which is why this is not simply `tryExecute` everywhere.
 */
export type PublishPolicy = {
  /** Publish only an intent whose utility is at least this, on the same 0 to 100 scale the brain uses. */
  minUtility: number;
  /** How many refusals may be published per window. */
  slotsPerWindow: number;
  /** How long one window runs, in seconds. */
  windowSeconds: number;
  /**
   * What the agent pays, in wei, to have one refusal written down. Zero by default.
   *
   * PAYING IS A POLICY, NOT A BOUND, exactly as the slot below is, and the distinction matters
   * more here because a price reads like enforcement and the slot never did. The loop attaches
   * this as surplus native value on the publication transaction. `SessionKeyDelegate.tryExecute`
   * is payable, never compares `msg.value` against the `value` argument it scopes, and forwards
   * nothing on a breach (read 2026-08-23), so the wei is simply retained at the agent EOA. It left
   * the SESSION KEY, which is the only balance this process can spend from, and it landed at an
   * address the OWNER controls. So it is a real drain on the running agent and no loss at all to
   * the principal behind it, and a fork that deletes this line publishes for free.
   *
   * A price that actually binds has to be contract-side, and it is two changes to the delegate
   * rather than one. A minimum `msg.value` required on the violation branch before
   * `ScopeViolation` is emitted, which is the bound. And that value sent somewhere the owner does
   * not control, because a payment between two of one principal's own addresses is an accounting
   * entry and not a cost, so a signal priced that way is still free to the party being read. The
   * publication counter the slot wants belongs in the same place, keyed to the epoch the delegate
   * already tracks. Neither is built.
   */
  publicationCost: bigint;
};

/**
 * The defaults, as three numbers a person can check.
 *
 * 60 of 100: high enough that a brain has to say out loud that this was most of what it wanted.
 * 1 slot: one published refusal per window, so the choice of which one is the content.
 * 3600 seconds: one hour, the same length as the default scope epoch above, so a window of
 * publications lines up with a window of spending.
 *
 * 0 wei: publication is free, and a free publication is byte for byte what this loop did before
 * the price existed. It is a parameter so that pricing a refusal is a number here plus a delegate
 * deploy rather than a rewrite of the emitter. `parseEther` is already imported for the day it is
 * set to something.
 *
 * The threshold is advisory and the slot is what actually limits volume. Utility is the brain's own
 * number, and the brain is untrusted input, so a model that wants to publish constantly can simply
 * report 100 every time. Nothing here can stop that and nothing here pretends to. The price does
 * not change that either, and at zero it is not even trying to: read the field's own comment for
 * what would have to move on chain before any of these four numbers binds anybody.
 */
export const publishRefusals: PublishPolicy = {
  minUtility: 60,
  slotsPerWindow: 1,
  windowSeconds: 3_600,
  publicationCost: 0n,
};

/**
 * Why the loop did or did not broadcast a refusal, in words that go straight into the log.
 *
 * A union rather than a flat record, so that a `publish: true` decision CARRIES the number it
 * decided on and a consumer cannot reach a published outcome with no utility behind it. `utility`
 * is the value the gate compared, read once and frozen. Everything downstream quotes this rather
 * than re-reading the intent, because the intent belongs to the brain and a second read is a second
 * chance for it to say something else.
 *
 * A publishing decision also carries the PRICE it committed to, for the same reason and against
 * the same failure. `publicationCost` is a field on a plain object a caller holds, so re-reading it
 * at send time is a second chance for it to be a different number from the one the gate decided
 * on, and the loop would then pay a price nothing had agreed to. The refusing branch carries no
 * price because nothing is broadcast, so there is nothing to pay.
 */
export type PublishDecision =
  | { publish: true; note: string; utility: number; cost: bigint }
  | { publish: false; note: string; utility?: number };

/**
 * Name a bid that could not be used, without ever rendering the bid itself.
 *
 * Interpolating an untrusted value into a log line calls its `toString` or `valueOf`, which is code
 * the brain wrote, running inside our record. That is how a note came out reading
 * "utility [object Object] cleared 60". The shape is all a reader needs anyway.
 */
const describeBid = (bid: unknown): string => {
  if (bid === undefined) return "no utility at all";
  if (bid === null) return "a null where a number belongs";
  if (Array.isArray(bid)) return "an array where a number belongs";
  if (typeof bid !== "number") {
    const kind = typeof bid;
    return `${kind === "object" ? "an" : "a"} ${kind} where a number belongs`;
  }
  if (Number.isNaN(bid)) return "NaN";
  return "a number that is not finite";
};

/**
 * The slot ledger for one running agent process.
 *
 * THE SLOT IS A POLICY, NOT A BOUND, and that distinction is the whole repo. The budget lives in
 * this process: fork the starter and delete it, rewrite the loop, or just restart, and the limit is
 * gone. Nothing on chain counts publications, so this cannot be read as a rate limit on anybody but
 * a well behaved agent. The delegate emits `ScopeViolation` every time `tryExecute` is asked to and
 * carries no per-window counter (`SessionKeyDelegate.tryExecute`, read 2026-08-22). Scarcity that
 * would actually bind has to be contract-side, a publication counter in the delegate keyed to the
 * epoch it already tracks, and that is not built. Read this class the way you read the probe: it is
 * how a well behaved agent conducts itself, never what stops a badly behaved one. The scope is the
 * part that stops things.
 */
export class PublishBudget {
  readonly policy: PublishPolicy;
  readonly #now: () => number;
  #windowStartedAt: number;
  #spent: number;

  /** `now` is injectable so a test can move a window without waiting an hour for one. */
  constructor(policy: PublishPolicy = publishRefusals, now: () => number = Date.now) {
    this.policy = policy;
    this.#now = now;
    this.#windowStartedAt = now();
    this.#spent = 0;
  }

  /** Publications left in the current window, after rolling the window if it has run out. */
  remaining(): number {
    this.#roll();
    return Math.max(0, this.policy.slotsPerWindow - this.#spent);
  }

  /**
   * Decide whether this refusal is worth publishing, and spend the slot when the answer is yes.
   *
   * Deciding and spending are one call on purpose. A caller that could ask without spending would
   * eventually publish twice in a window by forgetting the second call, and that bug would look
   * exactly like working code.
   *
   * The slot is spent on the ATTEMPT, not on a mined transaction. A publication that dies at the
   * node has still used up the agent's judgement for that window, and refunding it would turn a
   * flaky RPC into an unbounded retry loop pointed at the chain.
   *
   * The parameter is `unknown` because it is, whatever the `Intent` type says. It arrives from the
   * brain, and a brain is untrusted input: a JSON body, a model, a plugin. JS relational operators
   * coerce, so `"80" >= 60`, `[80] >= 60` and `{valueOf: () => 100} >= 60` are all true, and every
   * one of those would have bought a publication through a gate that only compared. This asks what
   * the value IS before asking what it is worth. `Number.isFinite` on the raw value, with no
   * conversion anywhere, is the whole check: no `Number(bid)`, no `+bid`, no `parseFloat`, because
   * each of those is the coercion this is here to refuse.
   */
  consider(bid: unknown): PublishDecision {
    this.#roll();
    if (typeof bid !== "number" || !Number.isFinite(bid)) {
      return { publish: false, note: `the intent bid ${describeBid(bid)}, and silence is not a bid` };
    }
    const utility = bid;
    if (utility < this.policy.minUtility) {
      return {
        publish: false,
        note: `utility ${utility} is under the ${this.policy.minUtility} publish threshold`,
        utility,
      };
    }
    if (this.policy.slotsPerWindow - this.#spent <= 0) {
      return {
        publish: false,
        note: `this window's ${this.policy.slotsPerWindow} publish slot(s) are already spent`,
        utility,
      };
    }
    this.#spent++;
    // Read once, here, and hand it to the caller. Nothing downstream reads the policy again.
    const cost = this.policy.publicationCost;
    return {
      publish: true,
      cost,
      note:
        `utility ${utility} cleared ${this.policy.minUtility}, spending slot ` +
        `${this.#spent} of ${this.policy.slotsPerWindow} this window at ${cost} wei`,
      utility,
    };
  }

  /** A finished window restarts from now. Windows are a cadence here, not a calendar grid. */
  #roll(): void {
    if ((this.#now() - this.#windowStartedAt) / 1000 >= this.policy.windowSeconds) {
      this.#windowStartedAt = this.#now();
      this.#spent = 0;
    }
  }
}

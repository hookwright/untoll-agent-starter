import {
  SessionKey,
  reviewScope,
  buildScope,
  explainReason,
  type Call,
  type Reader,
  type ScopePolicy,
  type Wallet,
} from "../src/index.ts";
import { PublishBudget, type PublishPolicy } from "./policy.ts";

/**
 * The reference loop.
 *
 * The premise it is built on: the model's output is untrusted input. Not "usually fine", not
 * "trusted after a prompt that says do not drain the wallet". Untrusted, in the same sense as a
 * request body. So every intent the brain produces takes the same path, and the path is short:
 *
 *   brain proposes  ->  probe against the installed scope  ->  in scope, act
 *                                                              out of scope, log and drop
 *                                                              out of scope and wanted badly, publish
 *
 * The probe is a read of the same logic `execute` enforces, so an out-of-scope intent costs a call
 * to a node instead of a reverted transaction, and the agent learns why in a form it can act on.
 * The containment does not depend on the probe: if you delete it, a breach still reverts. The
 * probe is there so the agent can be well behaved, not so it can be safe.
 *
 * The third branch is the record. `execute` reverts on a breach and a revert discards its logs, so
 * a loop that only probes and drops is structurally incapable of leaving any public trace of what
 * it was refused. When a refused intent clears the publish policy in policy.ts, the loop pays to
 * have that refusal written down: `tryExecute` runs the same check on chain and, on a breach,
 * emits `ScopeViolation` and forwards nothing. Publishing is deliberate and rationed rather than
 * automatic, so the record reads as what the agent thought was worth being told no about in
 * public, which is a better artifact than an exhaustive error log.
 *
 * What a publication costs is `publicationCost` in policy.ts, zero by default. Read it there
 * before assuming it makes anyone pay: it is a price a well behaved agent charges itself, and
 * nothing on chain collects it.
 */

export type Intent = {
  /** Why the agent wants this, in the agent's own words. Goes in the log next to the verdict. */
  rationale: string;
  /**
   * How badly the agent wants this, 0 to 100, in the brain's own estimate. It is the only input to
   * the publish threshold, and it is a self-report from untrusted code, so read it as a bid rather
   * than a measurement. An intent that omits it sits below every threshold: silence is not a bid.
   */
  utility?: number;
  call: Call;
};

/** Whatever produces intents: a model, a rules engine, a script. Untrusted either way. */
export type Brain = (context: { blockNumber: bigint }) => Promise<Intent[]>;

export type AgentLog = (line: string) => void;

export type AgentOptions = {
  reader: Reader;
  /** The agent's own EOA. Under 7702 the delegate's code runs here. */
  agent: `0x${string}`;
  /** Signs the delegation and installs the scope. Never reachable from the brain. */
  owner: Wallet;
  /** The only wallet the loop transacts with after setup. */
  session: Wallet;
  implementation: `0x${string}`;
  policy: ScopePolicy;
  brain: Brain;
  /**
   * Proceed even when `reviewScope` finds an allowed call with an unconstrained address argument.
   * Off by default: an unconstrained recipient is the exact hole the recipient policy exists for,
   * and starting anyway should be a decision someone typed, not a default.
   */
  allowUnconstrainedRecipients?: boolean;
  /** Which refused wants get broadcast, and how often. Defaults to `publishRefusals` in policy.ts. */
  publishPolicy?: PublishPolicy;
  log?: AgentLog;
};

/**
 * What became of a refusal: broadcast at a cost, or dropped, and why. Absent on an allowed call.
 *
 * `utility` is the number the gate actually compared, snapshotted at the moment it decided. Read it
 * here rather than going back to `verdict.intent.utility`, which is a field on an object the brain
 * owns: a getter, a proxy, or any later mutation makes that second read a different number from the
 * one that gated the publication, and the record would then explain the decision with a value that
 * had no part in it. It is absent only when the intent bid nothing a number could be made of.
 */
export type PublishOutcome =
  | { published: true; hash: `0x${string}`; note: string; utility: number }
  | { published: false; note: string; utility?: number };

export type Verdict = {
  intent: Intent;
  allowed: boolean;
  reason: string;
  /**
   * The settled transaction, present only when the call went through. A published refusal mines a
   * transaction too, and its hash sits on `publish` rather than here, because that transaction
   * recorded a refusal and performed nothing.
   */
  hash?: `0x${string}`;
  /** Present on every refusal, absent on an allowed call. */
  publish?: PublishOutcome;
  /**
   * What the agent handed over to have this recorded, in wei, present exactly when the loop
   * broadcast a publication attempt. Absent means nothing was broadcast and therefore nothing was
   * paid: an allowed call, or a refusal the gate dropped before it ever reached a node.
   *
   * It sits on the verdict rather than on `publish` because the money moves on every broadcast,
   * including the two broadcasts that record no publication at all. A call the chain settled after
   * the scope moved leaves `publish` absent, and one whose target reverted leaves it false, and
   * both of those paid. Hanging the price off the publication would lose it in exactly the two
   * cases where the agent spent and got nothing.
   *
   * Four states, and the fourth is why this is not a plain bigint. A publication that dies at the
   * node may have been broadcast before the failure, so "nothing was paid" is a guess there and
   * `"unknown"` is the true answer. A `null`, or leaving the field off, would let a consumer
   * totalling costs read that guess as a zero. The string makes the compiler stop them.
   */
  paid?: bigint | "unknown";
};

/** Install the delegation and the scope. Idempotent on the delegation, once-only on the scope. */
export async function arm(options: AgentOptions): Promise<SessionKey> {
  const log = options.log ?? console.log;
  const key = new SessionKey(options.reader, options.agent);

  const warnings = reviewScope(options.policy);
  for (const w of warnings) log(`  scope warning   ${w.signature} ${w.note}`);
  if (warnings.length > 0 && !options.allowUnconstrainedRecipients) {
    throw new Error(
      `${warnings.length} allowed call(s) take an address argument with no recipientArg. Set one ` +
        "in the policy, or pass allowUnconstrainedRecipients to proceed deliberately.",
    );
  }

  if (!(await key.isDelegatedTo(options.implementation))) {
    log("  delegating      attaching the session-key delegate to the agent EOA (EIP-7702)");
    await key.delegate({ owner: options.owner, implementation: options.implementation });
  }
  log(`  delegated       code at ${options.agent} is the 7702 designator for ${options.implementation}`);

  const onChain = await key.readScope();
  if (onChain.initialized) {
    log("  scope           already installed; reading it back rather than reinstalling");
  } else {
    const scope = buildScope(options.policy);
    log(SessionKey.describe(scope).split("\n").map((l) => `  ${l}`).join("\n"));
    await key.installScope(options.owner, scope);
    log("  scope           installed, and it cannot be widened from here");
  }
  return key;
}

/**
 * One pass: ask the brain, probe everything it proposes, act on what is in scope, and publish the
 * refusal that earned the window's slot.
 *
 * `budget` is a parameter rather than something this function builds, because the window has to
 * outlive the pass. A budget created here would reset on every pass, which silently turns one
 * publication per window into one publication per pass. `run` below holds a single budget across
 * every pass, and a caller driving `step` itself has to do the same.
 */
export async function step(key: SessionKey, options: AgentOptions, budget: PublishBudget): Promise<Verdict[]> {
  const log = options.log ?? console.log;
  const blockNumber = await options.reader.getBlockNumber();
  const intents = await options.brain({ blockNumber });
  const verdicts: Verdict[] = [];

  for (const intent of intents) {
    const probe = await key.probe(intent.call);
    if (!probe.ok) {
      const reason = `${probe.reason}: ${explainReason[probe.reason]}`;
      log(`  BLOCKED         ${intent.rationale}`);
      log(`                  ${reason}`);
      const decision = budget.consider(intent.utility);
      if (!decision.publish) {
        log(`                  not published, ${decision.note}`);
        verdicts.push({
          intent,
          allowed: false,
          reason,
          publish: { published: false, note: decision.note, utility: decision.utility },
        });
        continue;
      }
      // The intent goes out exactly as the brain proposed it, native value included. Do not strip
      // the value to save gas: a call refused for PER_TX would pass the same check at zero value,
      // and `tryExecute` forwards anything that passes, so publishing would become a way to run a
      // cheaper version of the call the scope just refused. The cost of keeping that honest is
      // that value sent with a publication stays at the agent's own EOA, since the delegate
      // returns rather than reverting on a breach and carries no refund path.
      //
      // `decision.cost` is the price the gate quoted when it decided, and it is what gets paid.
      // Not `budget.policy.publicationCost`, which is a second read of an object a caller holds,
      // and not a number this line works out for itself. It rides as surplus transaction value and
      // never touches the scoped argument, which is `tryExecute`'s own care to take; read it there
      // before changing anything here. `paid` starts as that price and only the node-failure path
      // moves it, because that is the one ending where the loop cannot say what the chain took.
      //
      // The three endings below come off the MINED RECEIPT, never off the return tuple. The tuple
      // reports `ok=false` both for a scope breach and for a downstream revert on a call the scope
      // ALLOWED, and those are opposite facts: one puts a `ScopeViolation` on chain and the other
      // emits nothing at all. Branching on `ok` writes "published" over an event that does not
      // exist, which is the one failure this whole branch is here to prevent.
      let outcome: PublishOutcome;
      let paid: bigint | "unknown" = decision.cost;
      try {
        const published = await key.tryExecute(options.session, intent.call, decision.cost);
        if (published.outcome === "settled") {
          // The scope's own state moved between the probe and the publication, an epoch rolling
          // over being the realistic way, so the same check passed on chain and `tryExecute`
          // FORWARDED the call. `ScopedCall` is in the receipt and no refusal was recorded.
          // Report what happened rather than what was intended. The slot stays spent, by the
          // spend-on-attempt rule in policy.ts.
          log(`  SETTLED         ${intent.rationale}`);
          log(`                  the scope moved between the probe and the publication; settled in ${published.hash}`);
          verdicts.push({
            intent,
            allowed: true,
            reason: "in scope by the time the publication was mined",
            hash: published.hash,
            paid,
          });
          continue;
        }
        if (published.outcome === "callReverted") {
          // Scope passed, the target call reverted, and the receipt carries neither event. Nothing
          // was published and nothing was performed, and the delegate charged the epoch budget on
          // the way through regardless. Saying "published" here would put a row in the public
          // record with no log behind it.
          outcome = {
            published: false,
            note:
              "the scope passed by the time it was mined and the call itself reverted, so no " +
              `ScopeViolation exists and nothing was performed, at ${published.hash}. The epoch ` +
              "budget was charged anyway, and the slot is spent.",
            utility: decision.utility,
          };
          log(`  NOT PUBLISHED   ${intent.rationale}`);
          log(`                  ${outcome.note}`);
          verdicts.push({ intent, allowed: false, reason, publish: outcome, paid });
          continue;
        }
        outcome = {
          published: true,
          hash: published.hash,
          note: `${decision.note}; the chain tagged it ${published.reason}`,
          utility: decision.utility,
        };
        log(`  PUBLISHED       ${intent.rationale}`);
        log(`                  ScopeViolation mined in ${published.hash}, at ${paid} wei`);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        // The transaction may or may not have reached a node before this threw, so what the agent
        // paid is genuinely not known here. Saying zero would be a guess that reads like a fact.
        paid = "unknown";
        outcome = {
          published: false,
          note:
            "the publication failed at the node, and the slot is spent. What it cost is unknown, " +
            `because the transaction may have been broadcast before this: ${why}`,
          utility: decision.utility,
        };
        log(`                  ${outcome.note}`);
      }
      verdicts.push({ intent, allowed: false, reason, publish: outcome, paid });
      continue;
    }
    const hash = await key.execute(options.session, intent.call);
    log(`  ALLOWED         ${intent.rationale}`);
    log(`                  settled in ${hash}`);
    verdicts.push({ intent, allowed: true, reason: "in scope", hash });
  }
  return verdicts;
}

/** Arm once, then step on an interval. Stops on the first setup failure, never on a blocked intent. */
export async function run(options: AgentOptions, passes: number, intervalMs = 12_000): Promise<Verdict[]> {
  const key = await arm(options);
  const budget = new PublishBudget(options.publishPolicy);
  const all: Verdict[] = [];
  for (let i = 0; i < passes; i++) {
    all.push(...(await step(key, options, budget)));
    if (i < passes - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return all;
}

import {
  keccak256,
  toBytes,
  toFunctionSelector,
  getAddress,
  type Address,
  type Hex,
} from "viem";

/**
 * The scope: what an agent's session key is allowed to do, expressed once by the owner and
 * enforced afterwards by bytecode rather than by the model's judgement.
 *
 * The shape the contract takes is flat parallel arrays, which is efficient on chain and easy to
 * get wrong by hand. `buildScope` takes a policy that reads like a sentence and renders the
 * tuple. `reviewScope` then looks for the hole that parallel arrays invite: an allowed function
 * that moves value to an address argument nobody constrained.
 */

/** One breach class. The delegate tags every violation with exactly one of these. */
export type ViolationReason =
  | "TARGET"
  | "SELECTOR"
  | "PER_TX"
  | "PER_EPOCH"
  | "EXPIRED"
  | "RECIPIENT"
  | "CALLDATA_SHORT"
  | "UNIT_PER_TX"
  | "UNIT_PER_EPOCH";

export const VIOLATION_REASONS: readonly ViolationReason[] = [
  "TARGET",
  "SELECTOR",
  "PER_TX",
  "PER_EPOCH",
  "EXPIRED",
  "RECIPIENT",
  "CALLDATA_SHORT",
  // The contract declares nine R_* reason constants; this list carried seven, so the
  // two newest refusals decoded to UNKNOWN. They are `internal` constants and appear NOWHERE in
  // the ABI, which is why regenerating the ABI could not have found the gap.
  "UNIT_PER_TX",
  "UNIT_PER_EPOCH",
] as const;

/** The in-scope tag. `probe` and `tryExecute` return this when nothing was breached. */
export const SCOPE_OK: Hex = "0x00000000";

/**
 * The delegate tags each breach with `bytes4(keccak256(LABEL))`. Recomputing the table here from
 * the labels, rather than pasting four-byte constants, means a decoded reason is derived the same
 * way the contract derives it. A pasted constant is a transcription error waiting to happen.
 */
export const reasonTag = (reason: ViolationReason): Hex =>
  keccak256(toBytes(reason)).slice(0, 10) as Hex;

const TAG_TO_REASON: ReadonlyMap<string, ViolationReason> = new Map(
  VIOLATION_REASONS.map((r) => [reasonTag(r).toLowerCase(), r]),
);

/** Decode a reason tag from `probe`, `tryExecute`, or a `ScopeViolation` log. */
export function decodeReason(tag: Hex): ViolationReason | "OK" | "UNKNOWN" {
  const t = tag.toLowerCase();
  if (t === SCOPE_OK) return "OK";
  return TAG_TO_REASON.get(t) ?? "UNKNOWN";
}

/** A human line for a reason, for logs an operator reads at 3am. */
export const explainReason: Record<ViolationReason | "OK" | "UNKNOWN", string> = {
  OK: "in scope",
  TARGET: "the contract being called is not on the allowlist",
  SELECTOR: "the function being called is not on the allowlist",
  PER_TX: "the value on this one call is over the per-transaction cap",
  PER_EPOCH: "this call would push the epoch's spend over its cap",
  EXPIRED: "the scope's expiry has passed",
  RECIPIENT: "the call is in scope but its output address is not on the recipient allowlist",
  CALLDATA_SHORT: "the calldata is too short to carry a selector or the declared recipient argument",
  UNIT_PER_TX: "the token amount on this one call is over the per-transaction unit cap",
  UNIT_PER_EPOCH: "this call would push the epoch's token spend over its unit cap",
  UNKNOWN: "the delegate returned a tag this SDK does not know; check the contract version",
};

/**
 * One allowed function.
 *
 * `recipientArg` is the 1-based position of the address argument that says where the output goes.
 * swap(address,address,uint256,address) sending to the 4th argument is `recipientArg: 4`. Leave it
 * undefined only when the function moves nothing to an address it takes as an argument.
 */
export type AllowedCall = {
  /** The full signature, e.g. "swap(address,address,uint256,address)". */
  signature: string;
  recipientArg?: number;
  /**
   * The 1-based position of the uint256 amount argument to meter, in the token's own
   * units. approve(address,uint256) is `amountArg: 2`.
   *
   * Set this on anything that moves a TOKEN. `perTxCap` and `perEpochCap` meter the native
   * `value` field, and an ERC-20 call carries value == 0, so a scope that looks capped at one
   * ether places no bound at all on an approve for the entire supply.
   */
  amountArg?: number;
};

export type ScopePolicy = {
  /** The EOA that installs the scope. Under EIP-7702 this is also the account running the code. */
  owner: Address;
  /** The only key the agent holds. It can act, and it can never widen what it may act on. */
  sessionKey: Address;
  /** Contracts the session key may call. */
  targets: readonly Address[];
  /** Functions it may call on them. */
  calls: readonly AllowedCall[];
  /** Addresses any constrained output may land on. Usually just the owner. */
  recipients: readonly Address[];
  /** Native value ceiling for a single call, in wei. */
  perTxCap: bigint;
  /** Native value ceiling for one rolling epoch, in wei. */
  perEpochCap: bigint;
  /** Epoch length in seconds. */
  epochLength: bigint;
  /** Token-amount ceiling for a single call, in the token's own units. */
  perTxUnitCap?: bigint;
  /** Token-amount ceiling for one rolling epoch, in the token's own units. */
  perEpochUnitCap?: bigint;
  /** Absolute unix expiry. Use `expiresIn` if you would rather express a duration. */
  expiry?: bigint;
  /** Seconds from `now`. Ignored when `expiry` is set. */
  expiresIn?: bigint;
  /** Unix seconds to measure `expiresIn` from. Pass the chain's block timestamp, not the host clock. */
  now?: bigint;
};

/** The tuple `SessionKeyDelegate.initialize` takes. */
export type Scope = {
  owner: Address;
  sessionKey: Address;
  expiry: bigint;
  perTxCap: bigint;
  perEpochCap: bigint;
  perTxUnitCap: bigint;
  perEpochUnitCap: bigint;
  epochLength: bigint;
  targets: readonly Address[];
  selectors: readonly Hex[];
  recipients: readonly Address[];
  recipientSelectors: readonly Hex[];
  recipientArgs: readonly bigint[];
  amountSelectors: readonly Hex[];
  amountArgs: readonly bigint[];
};

export class ScopeError extends Error {}

function requireAddress(value: Address, label: string): Address {
  try {
    return getAddress(value);
  } catch {
    throw new ScopeError(`${label} is not a valid address: ${String(value)}`);
  }
}

/** Argument types of a signature, e.g. "swap(address,uint256)" gives ["address", "uint256"]. */
export function argumentTypes(signature: string): string[] {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open === -1 || close < open) throw new ScopeError(`not a function signature: ${signature}`);
  const inner = signature.slice(open + 1, close).trim();
  if (!inner) return [];
  // Flat split is enough here: the delegate reads a recipient at a fixed head word, so a signature
  // with a tuple argument has no stable recipient position to point at and is rejected below.
  return inner.split(",").map((s) => s.trim());
}

/** Render the on-chain tuple from a policy that reads like a sentence. */
export function buildScope(policy: ScopePolicy): Scope {
  const owner = requireAddress(policy.owner, "owner");
  const sessionKey = requireAddress(policy.sessionKey, "sessionKey");
  if (owner.toLowerCase() === sessionKey.toLowerCase()) {
    throw new ScopeError(
      "owner and sessionKey are the same address, so the scope constrains nothing: the key that " +
        "installs the scope would also be the key that acts under it",
    );
  }
  if (policy.targets.length === 0) throw new ScopeError("a scope with no targets can do nothing");
  if (policy.calls.length === 0) throw new ScopeError("a scope with no calls can do nothing");
  if (policy.perTxCap > policy.perEpochCap) {
    throw new ScopeError(
      `perTxCap (${policy.perTxCap}) is above perEpochCap (${policy.perEpochCap}), so the ` +
        "per-transaction cap can never bind",
    );
  }
  if (policy.epochLength <= 0n) throw new ScopeError("epochLength must be positive");

  let expiry: bigint;
  if (policy.expiry !== undefined) {
    expiry = policy.expiry;
  } else if (policy.expiresIn !== undefined) {
    if (policy.now === undefined) {
      throw new ScopeError(
        "expiresIn needs `now`; pass the chain's block timestamp rather than the host clock, " +
          "which can sit far from a fork's",
      );
    }
    expiry = policy.now + policy.expiresIn;
  } else {
    throw new ScopeError("a scope needs an expiry: set `expiry` or `expiresIn`");
  }
  if (policy.now !== undefined && expiry <= policy.now) {
    throw new ScopeError(`expiry ${expiry} is not in the future of ${policy.now}`);
  }

  const selectors: Hex[] = [];
  const recipientSelectors: Hex[] = [];
  const recipientArgs: bigint[] = [];
  const amountSelectors: Hex[] = [];
  const amountArgs: bigint[] = [];
  const seen = new Set<string>();

  // approve(address,uint256) and increaseAllowance(address,uint256). These are the two
  // calls whose effect OUTLIVES the scope: an allowance is a row in the token's storage, so it
  // survives the key expiring and survives the delegation being cleared. The delegate refuses to
  // install either without a unit cap on it, and this refuses it here so the caller reads the
  // reason in their own policy rather than an empty revert.
  const ALLOWANCE_SELECTORS = new Set(["0x095ea7b3", "0x39509351"]);

  for (const call of policy.calls) {
    const selector = toFunctionSelector(call.signature);
    if (seen.has(selector)) {
      throw new ScopeError(`${call.signature} appears twice, or collides with another allowed call`);
    }
    seen.add(selector);
    selectors.push(selector);

    if (call.amountArg !== undefined) {
      const amountTypes = argumentTypes(call.signature);
      const ai = call.amountArg;
      if (!Number.isInteger(ai) || ai < 1 || ai > amountTypes.length) {
        throw new ScopeError(
          `${call.signature}: amountArg ${ai} is outside its ${amountTypes.length} arguments ` +
            "(the index is 1-based)",
        );
      }
      // Bound to a const rather than indexed twice: under noUncheckedIndexedAccess the element is
      // `string | undefined`, and the bounds check above does not narrow it for the compiler.
      const amountType = amountTypes[ai - 1] ?? "";
      if (!/^uint\d*$/.test(amountType)) {
        throw new ScopeError(
          `${call.signature}: argument ${ai} is ${amountType || "absent"}, not a uint, so it ` +
            "cannot be metered as an amount",
        );
      }
      amountSelectors.push(selector);
      amountArgs.push(BigInt(ai));
    }

    if (ALLOWANCE_SELECTORS.has(selector.toLowerCase())) {
      const metered = call.amountArg !== undefined;
      if (!metered || !policy.perTxUnitCap || !policy.perEpochUnitCap) {
        throw new ScopeError(
          `${call.signature} grants a standing allowance, so it may not be allowed without a bound ` +
            "on it. Set `amountArg: 2` on this call and set perTxUnitCap and perEpochUnitCap on " +
            "the policy. An allowance survives this key expiring and survives it being revoked",
        );
      }
    }

    if (call.recipientArg === undefined) continue;
    const types = argumentTypes(call.signature);
    const index = call.recipientArg;
    if (!Number.isInteger(index) || index < 1 || index > types.length) {
      throw new ScopeError(
        `${call.signature}: recipientArg ${index} is outside its ${types.length} arguments ` +
          "(the index is 1-based)",
      );
    }
    if (types[index - 1] !== "address") {
      throw new ScopeError(
        `${call.signature}: argument ${index} is ${types[index - 1]}, not address, so it cannot be a recipient`,
      );
    }
    const dynamic = types.slice(0, index).find((t) => t.includes("[") || t === "string" || t === "bytes" || t.startsWith("("));
    if (dynamic) {
      throw new ScopeError(
        `${call.signature}: argument ${index} sits behind a dynamic argument (${dynamic}), so its ` +
          "position in the calldata head is an offset rather than the address; the delegate reads a " +
          "fixed head word and would check the wrong 32 bytes",
      );
    }
    if (policy.recipients.length === 0) {
      throw new ScopeError(
        `${call.signature} declares a recipient argument but the policy allows no recipients, so ` +
          "every call to it would be blocked",
      );
    }
    recipientSelectors.push(selector);
    recipientArgs.push(BigInt(index));
  }

  return {
    owner,
    sessionKey,
    expiry,
    perTxCap: policy.perTxCap,
    perEpochCap: policy.perEpochCap,
    perTxUnitCap: policy.perTxUnitCap ?? 0n,
    perEpochUnitCap: policy.perEpochUnitCap ?? 0n,
    epochLength: policy.epochLength,
    targets: policy.targets.map((t, i) => requireAddress(t, `targets[${i}]`)),
    selectors,
    recipients: policy.recipients.map((r, i) => requireAddress(r, `recipients[${i}]`)),
    recipientSelectors,
    recipientArgs,
    amountSelectors,
    amountArgs,
  };
}

export type ScopeWarning = { signature: string; note: string };

/**
 * The check worth running before you install anything.
 *
 * A target allowlist and a selector allowlist together still let a jailbroken model call an
 * allowed function on an allowed contract and point the output at itself. That is the failure the
 * recipient policy exists to close, and it is invisible in the flat tuple: an allowed function
 * with an address argument and no `recipientArg` is a hole with no error message.
 *
 * Returns one warning per allowed call that takes an unconstrained address argument.
 */
export function reviewScope(policy: ScopePolicy): ScopeWarning[] {
  const warnings: ScopeWarning[] = [];
  for (const call of policy.calls) {
    if (call.recipientArg !== undefined) continue;
    const types = argumentTypes(call.signature);
    const positions = types
      .map((t, i) => (t === "address" ? i + 1 : 0))
      .filter((i) => i > 0);
    if (positions.length === 0) continue;
    warnings.push({
      signature: call.signature,
      note:
        `takes an address at argument ${positions.join(" and ")} and declares no recipientArg, so ` +
        "the session key may point that address anywhere, including at itself",
    });
  }
  return warnings;
}

/** A short human rendering of a scope, for a log line or a confirmation prompt. */
export function describeScope(scope: Scope): string {
  const lines = [
    `owner        ${scope.owner}`,
    `session key  ${scope.sessionKey}`,
    `expires      ${new Date(Number(scope.expiry) * 1000).toISOString()}`,
    `value caps   ${scope.perTxCap} wei per call, ${scope.perEpochCap} wei per ${scope.epochLength}s epoch`,
    `targets      ${scope.targets.join(", ")}`,
    `selectors    ${scope.selectors.join(", ")}`,
  ];
  if (scope.recipients.length > 0) {
    lines.push(`recipients   ${scope.recipients.join(", ")}`);
    lines.push(
      `constrained  ${scope.recipientSelectors
        .map((s, i) => `${s} at argument ${scope.recipientArgs[i]}`)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

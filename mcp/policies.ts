import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, type Address } from "viem";
import { argumentTypes, buildScope, reviewScope, type ScopePolicy, type ScopeWarning } from "../src/index.ts";
import type { UntollAddresses } from "../src/index.ts";

/**
 * Named policies, written by a human, stored on disk, minted by name.
 *
 * The tool that installs a scope takes a policy NAME and nothing else about the scope. It has no
 * parameter for a target, a selector, a cap, or an expiry, so a connected model cannot author the
 * boundary it will then be held to. It can pick one a person already reviewed. That is the whole
 * design rule of this file, and it is enforced by the tool's input schema rather than by a check
 * the model could argue with.
 *
 * A policy file is portable across chains because it names contracts rather than addresses:
 * `@launchHook` resolves through the same env-overridable deploy record the SDK uses, `@owner` and
 * `@sessionKey` resolve to the identity being minted for. A literal 0x address is accepted where
 * the contract is genuinely yours to name, such as your own router.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const POLICY_DIR = join(HERE, "policies");

export class PolicyError extends Error {}

/** The on-disk shape. Every value that becomes a uint is a string, so JSON never rounds it. */
export type PolicyFile = {
  name: string;
  summary: string;
  targets: string[];
  calls: { signature: string; recipientArg?: number }[];
  recipients: string[];
  perTxCapWei: string;
  perEpochCapWei: string;
  epochLengthSeconds: string;
  expiresInSeconds: string;
  /**
   * Proceed even though an allowed call takes an address argument nobody constrained.
   *
   * Off unless a person typed it into the file. `reviewScope` finds exactly this hole, and it is
   * the one that survives a target allowlist and a selector allowlist together: an allowed
   * function on an allowed contract with its output pointed at the attacker satisfies both.
   */
  allowUnconstrainedRecipients?: boolean;
};

export type PolicyResolution = {
  file: PolicyFile;
  policy: ScopePolicy;
  /** Allowed calls that constrain no destination at all. These refuse the mint. */
  warnings: ScopeWarning[];
  /** Address arguments the delegate structurally cannot check. These are reported, not refused. */
  advisories: ScopeWarning[];
};

export type ResolveContext = {
  owner: Address;
  sessionKey: Address;
  addresses: UntollAddresses;
  /** The chain's block timestamp. Not the host clock, which can sit far from a fork's. */
  now: bigint;
  /** Extra names a policy may reference, e.g. `@router` from UNTOLL_ROUTER. */
  extras?: Record<string, Address | undefined>;
};

/** Policy names available on disk, without reading or validating them. */
export function listPolicyNames(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(POLICY_DIR);
  } catch {
    throw new PolicyError(`no policy directory at ${POLICY_DIR}`);
  }
  return entries
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

function readPolicyFile(name: string): PolicyFile {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new PolicyError(
      `"${name}" is not a policy name. Names are lowercase, digits and hyphens, and they index ` +
        `files in ${POLICY_DIR}; a path is never accepted here.`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(join(POLICY_DIR, `${name}.json`), "utf8");
  } catch {
    throw new PolicyError(
      `no policy named "${name}". Available: ${listPolicyNames().join(", ") || "none"}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PolicyError(`policy "${name}" is not valid JSON: ${(error as Error).message}`);
  }
  return validateShape(name, parsed);
}

function validateShape(name: string, value: unknown): PolicyFile {
  if (typeof value !== "object" || value === null) {
    throw new PolicyError(`policy "${name}" is not an object`);
  }
  const o = value as Record<string, unknown>;
  const str = (key: string): string => {
    const v = o[key];
    if (typeof v !== "string" || !v.trim()) {
      throw new PolicyError(`policy "${name}": ${key} must be a non-empty string`);
    }
    return v.trim();
  };
  const uintString = (key: string): string => {
    const v = str(key);
    if (!/^\d+$/.test(v)) {
      throw new PolicyError(
        `policy "${name}": ${key} is "${v}"; it must be a decimal integer written as a string, ` +
          "because a wei value large enough to matter does not survive a JSON number",
      );
    }
    return v;
  };
  const strings = (key: string): string[] => {
    const v = o[key];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      throw new PolicyError(`policy "${name}": ${key} must be an array of strings`);
    }
    return v as string[];
  };

  const calls = o["calls"];
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new PolicyError(`policy "${name}": calls must be a non-empty array`);
  }
  const parsedCalls = calls.map((c, i) => {
    if (typeof c !== "object" || c === null) {
      throw new PolicyError(`policy "${name}": calls[${i}] is not an object`);
    }
    const call = c as Record<string, unknown>;
    if (typeof call["signature"] !== "string" || !call["signature"].includes("(")) {
      throw new PolicyError(
        `policy "${name}": calls[${i}].signature must be a full signature such as ` +
          '"claimRewards(bytes32,uint256)", not a name and not a selector',
      );
    }
    const arg = call["recipientArg"];
    if (arg !== undefined && (typeof arg !== "number" || !Number.isInteger(arg))) {
      throw new PolicyError(`policy "${name}": calls[${i}].recipientArg must be a whole number`);
    }
    return arg === undefined
      ? { signature: call["signature"] }
      : { signature: call["signature"], recipientArg: arg as number };
  });

  const allow = o["allowUnconstrainedRecipients"];
  if (allow !== undefined && typeof allow !== "boolean") {
    throw new PolicyError(`policy "${name}": allowUnconstrainedRecipients must be true or false`);
  }
  if (str("name") !== name) {
    throw new PolicyError(
      `policy "${name}" declares the name "${str("name")}"; the file name is the identifier the ` +
        "mint tool takes, so a mismatch means the wrong scope could be installed under the right name",
    );
  }

  return {
    name,
    summary: str("summary"),
    targets: strings("targets"),
    calls: parsedCalls,
    recipients: strings("recipients"),
    perTxCapWei: uintString("perTxCapWei"),
    perEpochCapWei: uintString("perEpochCapWei"),
    epochLengthSeconds: uintString("epochLengthSeconds"),
    expiresInSeconds: uintString("expiresInSeconds"),
    allowUnconstrainedRecipients: allow === true,
  };
}

/** Resolve one `@name` token or a literal address. Unknown names fail loudly rather than as 0x0. */
export function resolveToken(token: string, context: ResolveContext): Address {
  if (!token.startsWith("@")) {
    if (!isAddress(token)) {
      throw new PolicyError(
        `"${token}" is neither a known name nor a valid address. Names start with @ and a bare ` +
          "string that is almost an address is the way a scope ends up pointing at nothing.",
      );
    }
    return getAddress(token);
  }
  const key = token.slice(1);
  const known: Record<string, Address | undefined> = {
    owner: context.owner,
    sessionKey: context.sessionKey,
    poolManager: context.addresses.poolManager,
    launchHook: context.addresses.launchHook,
    tokenFactory: context.addresses.tokenFactory,
    launchToken: context.addresses.launchTokenImplementation,
    reputationRegistry: context.addresses.reputationRegistry,
    polMath: context.addresses.polMath,
    ...(context.extras ?? {}),
  };
  if (!(key in known)) {
    throw new PolicyError(
      `"${token}" is not a name this server resolves. Known: ${Object.keys(known)
        .map((k) => `@${k}`)
        .join(", ")}.`,
    );
  }
  const resolved = known[key];
  if (!resolved) {
    throw new PolicyError(
      `"${token}" has no address in this environment. Set it (for @router that is UNTOLL_ROUTER) ` +
        "or point the policy at a literal address; the server will not install a scope against a " +
        "name it could not resolve.",
    );
  }
  return getAddress(resolved);
}

/**
 * The second address, and why it gets a line rather than a refusal.
 *
 * `reviewScope` finds an allowed call that constrains no destination at all. It cannot find the
 * narrower case, because that case is a limit of the contract rather than a mistake in the policy:
 * `recipientArgIndex` holds ONE argument index per selector, so a function taking two addresses
 * can have exactly one of them checked. Name the fourth argument on
 * `swap(address,address,uint256,address)` and arguments 1 and 2 still pass through unexamined.
 *
 * Refusing on that would make most real routers unmintable, which is not a boundary, it is a
 * bounce. So the mint plan says which addresses the delegate does not check and installs anyway.
 * The operator gets the true shape of the boundary rather than a clean-looking one.
 */
export function advisoriesFor(policy: ScopePolicy): ScopeWarning[] {
  const out: ScopeWarning[] = [];
  for (const call of policy.calls) {
    if (call.recipientArg === undefined) continue;
    const types = argumentTypes(call.signature);
    const others = types
      .map((t, i) => (t === "address" ? i + 1 : 0))
      .filter((i) => i > 0 && i !== call.recipientArg);
    if (others.length === 0) continue;
    out.push({
      signature: call.signature,
      note:
        `constrains argument ${call.recipientArg} and also takes an address at argument ` +
        `${others.join(" and ")}. The delegate checks one recipient argument per selector, so ` +
        "those are unchecked. Confirm they cannot receive value on this router.",
    });
  }
  return out;
}

/**
 * Load a named policy, resolve it against this environment, and run the review.
 *
 * `buildScope` runs here rather than at mint time so that a policy which cannot mean what it says
 * fails while a person is reading the plan, not while a transaction is in flight.
 */
export function loadPolicy(name: string, context: ResolveContext): PolicyResolution {
  const file = readPolicyFile(name);
  const policy: ScopePolicy = {
    owner: context.owner,
    sessionKey: context.sessionKey,
    targets: file.targets.map((t) => resolveToken(t, context)),
    calls: file.calls,
    recipients: file.recipients.map((r) => resolveToken(r, context)),
    perTxCap: BigInt(file.perTxCapWei),
    perEpochCap: BigInt(file.perEpochCapWei),
    epochLength: BigInt(file.epochLengthSeconds),
    expiresIn: BigInt(file.expiresInSeconds),
    now: context.now,
  };
  buildScope(policy);
  return { file, policy, warnings: reviewScope(policy), advisories: advisoriesFor(policy) };
}

/**
 * The gate between a loaded policy and an installed one.
 *
 * Returns the reason to refuse, or an empty string to proceed. Kept separate from the tool so the
 * offline gate can assert it without a chain.
 */
export function refusalFor(resolution: PolicyResolution): string {
  if (resolution.warnings.length === 0) return "";
  if (resolution.file.allowUnconstrainedRecipients) return "";
  const lines = resolution.warnings.map((w) => `${w.signature} ${w.note}`);
  return (
    `policy "${resolution.file.name}" allows a call whose destination argument nobody constrained, ` +
    "so a session key acting inside this scope could point the output at itself:\n  " +
    lines.join("\n  ") +
    "\n\nEither set recipientArg on that call, or, if the call genuinely moves nothing to an " +
    'address it takes as an argument, add "allowUnconstrainedRecipients": true to the policy file. ' +
    "That belongs in the file, where it is reviewed, rather than in a tool argument."
  );
}

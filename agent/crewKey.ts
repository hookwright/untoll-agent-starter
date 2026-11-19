import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { buildScope, reviewScope, type ScopePolicy, type Scope } from "../src/index.ts";

/**
 * Crew seat session keys. For the crew service: one call mints a key whose authority is the crew
 * policy in untoll-agents `src/crew/CrewPolicy.sol` (branch crew/session-policy), and nothing else.
 *
 * The seat holds `privateKey`. The crew wallet's own key (the owner) never reaches the seat, and the
 * service must not keep it either: under EIP-7702 the owner key is not confined by the policy.
 *
 * The allowed calls below are the same three selectors CrewPolicy.sol installs. Keep the two in step;
 * `crewPolicySelectors()` is the cross-check the service self-test compares against the contract.
 */
export const CREW_CALLS = [
  // `to` (argument 2, 1-based) is pinned to the crew wallet by the recipient allowlist.
  { signature: "sweepCrew(bytes32,address)", recipientArg: 2 },
  { signature: "record(bytes32,uint256,bytes32,uint64,uint8,bytes32)" },
  { signature: "recordMany((bytes32,uint256,bytes32,uint64,uint8,bytes32)[])" },
] as const;

const VAULT_CALLS = [{ signature: "release(bytes32)" }, { signature: "releaseMany(bytes32[])" }] as const;

export type CrewSeatKey = {
  /** Public address, goes into the policy and the on-chain scope. */
  address: Address;
  /** Held by the seat only. Rotate by issuing a new key and re-installing the scope from the owner. */
  privateKey: Hex;
  /** The Scope struct to pass to SessionKeyDelegate.initialize (owner signs; seat never does). */
  scope: Scope;
  /** Policy warnings from reviewScope; the service refuses to activate on any. */
  warnings: ReturnType<typeof reviewScope>;
};

export function crewPolicy(p: {
  crewWallet: Address;
  sessionKey: Address;
  hook: Address;
  receipts: Address;
  vault?: Address;
  now: bigint;
  ttlSeconds?: bigint;
  epochSeconds?: bigint;
}): ScopePolicy {
  return {
    owner: p.crewWallet,
    sessionKey: p.sessionKey,
    targets: p.vault ? [p.hook, p.receipts, p.vault] : [p.hook, p.receipts],
    calls: p.vault ? [...CREW_CALLS, ...VAULT_CALLS] : [...CREW_CALLS],
    recipients: [p.crewWallet],
    perTxCap: 0n,
    perEpochCap: 0n,
    epochLength: p.epochSeconds ?? 86_400n,
    expiresIn: p.ttlSeconds ?? 604_800n,
    now: p.now,
  };
}

/** Mint a fresh session key for one crew seat and the scope that confines it. */
export function issueCrewSeatKey(p: {
  crewWallet: Address;
  hook: Address;
  receipts: Address;
  vault?: Address;
  now: bigint;
  ttlSeconds?: bigint;
  epochSeconds?: bigint;
}): CrewSeatKey {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  const policy = crewPolicy({ ...p, sessionKey: address });
  return { address, privateKey, scope: buildScope(policy), warnings: reviewScope(policy) };
}

/** Selectors the TS side installs, for a self-test against CrewPolicy.sol. */
export const crewPolicySelectors = (): Hex[] =>
  CREW_CALLS.map((c) => keccak256(toBytes(c.signature)).slice(0, 10) as Hex);

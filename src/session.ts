import {
  encodeFunctionData,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { sessionKeyDelegateAbi } from "./generated/contracts.ts";
import { SESSION_KEY_DELEGATE_BYTECODE } from "./generated/delegate-bytecode.ts";
import { decodeReason, describeScope, type Scope, type ViolationReason } from "./scope.ts";

/**
 * The session key lane.
 *
 * The shape to hold in your head: under EIP-7702 the delegate's code runs AT the agent's own EOA.
 * There is no shared vault contract and no custody transfer. Every call below is addressed to the
 * agent EOA itself, which is why `agent` is the address every method targets.
 *
 * Two keys, and keeping them apart is the entire guarantee:
 *   owner        signs the delegation and installs the scope, once. Never handed to the model.
 *   sessionKey   the only key the agent process holds. It acts, and cannot widen what it may act on.
 */

export type Wallet = WalletClient<Transport, Chain, Account>;
export type Reader = PublicClient<Transport, Chain>;

export type Call = {
  target: Address;
  /** Native value in wei. Defaults to 0n. */
  value?: bigint;
  data: Hex;
};

export type ProbeResult = {
  ok: boolean;
  reason: ViolationReason | "OK" | "UNKNOWN";
  tag: Hex;
};

/**
 * What a `tryExecute` transaction actually did, read off its mined receipt.
 *
 * Three endings, and they are not two. `published` means a `ScopeViolation` is on chain and the
 * refusal is now public. `settled` means the scope passed and the call went through, which is what
 * a caller racing an epoch boundary needs to be told rather than guessing. `callReverted` means the
 * scope passed, the target call reverted, and NO event exists: nothing was published, nothing was
 * performed, and the epoch budget was charged anyway.
 */
export type TryExecuteOutcome = "published" | "settled" | "callReverted";

export type TryExecuteResult = {
  hash: Hex;
  outcome: TryExecuteOutcome;
  /** The tag carried by the `ScopeViolation` when published, and "OK" whenever the scope passed. */
  reason: ViolationReason | "OK" | "UNKNOWN";
};

/** The delegation designator EIP-7702 writes at a delegated EOA: 0xef0100 followed by the impl. */
export const designatorFor = (implementation: Address): Hex =>
  `0xef0100${implementation.slice(2)}`.toLowerCase() as Hex;

export class DelegationError extends Error {}

export class SessionKey {
  /** The agent's own EOA, which is both the account and the address the delegate code runs at. */
  readonly agent: Address;
  readonly #reader: Reader;

  constructor(reader: Reader, agent: Address) {
    this.#reader = reader;
    this.agent = agent;
  }

  /** Deploy the delegate implementation. For a local chain; on a network it is already there. */
  static async deployImplementation(reader: Reader, deployer: Wallet): Promise<Address> {
    const hash = await deployer.deployContract({
      abi: sessionKeyDelegateAbi,
      bytecode: SESSION_KEY_DELEGATE_BYTECODE,
      account: deployer.account,
      chain: deployer.chain,
      args: [],
    });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new DelegationError("the delegate deploy mined with no address");
    return receipt.contractAddress;
  }

  /** True when the agent EOA currently carries the 7702 designator for `implementation`. */
  async isDelegatedTo(implementation: Address): Promise<boolean> {
    const code = (await this.#reader.getCode({ address: this.agent })) ?? "0x";
    return code.toLowerCase() === designatorFor(implementation);
  }

  /**
   * Attach the delegate to the agent EOA (EIP-7702), then read the code back and prove it landed.
   *
   * The read-back is not ceremony. A node below the Prague hardfork accepts the transaction and
   * writes no code, which looks like success and leaves an agent running with an unconstrained
   * key. Failing loudly here is the difference between containment and the appearance of it.
   *
   * Pass `relayer` to have a third account pay the gas. Without one, the owner sponsors its own
   * delegation and viem accounts for the nonce shift.
   */
  async delegate(params: {
    owner: Wallet;
    implementation: Address;
    relayer?: Wallet;
  }): Promise<Hex> {
    const { owner, implementation, relayer } = params;
    const authorization = relayer
      ? await owner.signAuthorization({ account: owner.account, address: implementation })
      : await owner.signAuthorization({ account: owner.account, address: implementation, executor: "self" });

    const sender = relayer ?? owner;
    const hash = await sender.sendTransaction({
      account: sender.account,
      chain: sender.chain,
      to: this.agent,
      data: "0x",
      authorizationList: [authorization],
    });
    await this.#reader.waitForTransactionReceipt({ hash });

    if (!(await this.isDelegatedTo(implementation))) {
      const code = (await this.#reader.getCode({ address: this.agent })) ?? "0x";
      throw new DelegationError(
        `the delegation did not attach: code at ${this.agent} is ${code}, expected ` +
          `${designatorFor(implementation)}. A chain below the Prague hardfork mines this ` +
          "transaction and writes nothing, so treat this as unconfigured rather than retrying.",
      );
    }
    return hash;
  }

  /**
   * Install the scope. Owner-gated on chain and callable once, so a session key can never widen
   * its own authority and a second call reverts with AlreadyInitialized.
   *
   * THE GATE IS A SELF-CALL, and the pre-flight below has to say the same thing the contract says.
   * `initialize` requires `msg.sender == address(this)` AND `s.owner == address(this)`. Under 7702
   * the delegate's code runs AT the agent EOA, so both resolve to `this.agent`: an install is that
   * account calling itself. The contract gated on `msg.sender == s.owner` until 2026-08-20, which
   * was no gate at all, because the caller chooses `s.owner` in the same call and satisfies it by
   * naming itself. That was a front-run that took the account permanently, since there is no
   * re-initialize.
   *
   * This pre-flight checked `owner.account.address === scope.owner`, which is the OLD rule: it is
   * the exact comparison the contract stopped making. It passes whenever the caller is
   * self-consistent, including when both point at some account that is not the agent, and then the
   * transaction reverts on chain with a bare NotOwner. Both operands are compared against
   * `this.agent` now, so a wrong wallet and a wrong scope are two different messages instead of
   * one silent revert.
   */
  async installScope(owner: Wallet, scope: Scope): Promise<Hex> {
    if (scope.owner.toLowerCase() !== this.agent.toLowerCase()) {
      throw new DelegationError(
        `the scope names ${scope.owner} as its owner, but this session is bound to ${this.agent}. ` +
          "Under 7702 the delegate runs AT the agent EOA, so initialize requires the scope's owner " +
          "to BE that account; the delegate reverts NotOwner on chain, so it is caught here instead",
      );
    }
    if (owner.account.address.toLowerCase() !== this.agent.toLowerCase()) {
      throw new DelegationError(
        `the wallet installing the scope (${owner.account.address}) is not the agent EOA ` +
          `(${this.agent}). initialize requires msg.sender == address(this), which is a SELF-call, ` +
          "so only the agent's own key can install its scope",
      );
    }
    const hash = await owner.sendTransaction({
      account: owner.account,
      chain: owner.chain,
      to: this.agent,
      data: encodeFunctionData({
        abi: sessionKeyDelegateAbi,
        functionName: "initialize",
        args: [scope],
      }),
    });
    await this.#reader.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** The scope as the chain holds it, read back rather than remembered. */
  async readScope(): Promise<{
    initialized: boolean;
    owner: Address;
    sessionKey: Address;
    expiry: bigint;
    perTxCap: bigint;
    perEpochCap: bigint;
    epochLength: bigint;
    epochStart: bigint;
    epochSpent: bigint;
  }> {
    const at = { address: this.agent, abi: sessionKeyDelegateAbi } as const;
    const [initialized, owner, sessionKey, expiry, perTxCap, perEpochCap, epochLength, epochStart, epochSpent] =
      await Promise.all([
        this.#reader.readContract({ ...at, functionName: "initialized" }),
        this.#reader.readContract({ ...at, functionName: "owner" }),
        this.#reader.readContract({ ...at, functionName: "sessionKey" }),
        this.#reader.readContract({ ...at, functionName: "expiry" }),
        this.#reader.readContract({ ...at, functionName: "perTxCap" }),
        this.#reader.readContract({ ...at, functionName: "perEpochCap" }),
        this.#reader.readContract({ ...at, functionName: "epochLength" }),
        this.#reader.readContract({ ...at, functionName: "epochStart" }),
        this.#reader.readContract({ ...at, functionName: "epochSpent" }),
      ]);
    return {
      initialized,
      owner,
      sessionKey,
      expiry: BigInt(expiry),
      perTxCap: BigInt(perTxCap),
      perEpochCap: BigInt(perEpochCap),
      epochLength: BigInt(epochLength),
      epochStart: BigInt(epochStart),
      epochSpent: BigInt(epochSpent),
    };
  }

  /**
   * Ask the chain whether a call is in scope, changing nothing.
   *
   * Run this before every action. It costs a read and it turns a reverted transaction into a
   * decision the agent can make: the same scope logic `execute` runs, against the same state.
   */
  async probe(call: Call): Promise<ProbeResult> {
    const [ok, tag] = await this.#reader.readContract({
      address: this.agent,
      abi: sessionKeyDelegateAbi,
      functionName: "probe",
      args: [call.target, call.value ?? 0n, call.data],
    });
    return { ok, tag, reason: decodeReason(tag) };
  }

  /**
   * Act. Any breach reverts with a named error and moves nothing.
   *
   * `session` must be the session key wallet. The owner cannot call this: on chain the delegate
   * checks the sender against the installed session key, not against the owner.
   */
  async execute(session: Wallet, call: Call): Promise<Hex> {
    const hash = await session.writeContract({
      address: this.agent,
      abi: sessionKeyDelegateAbi,
      functionName: "execute",
      args: [call.target, call.value ?? 0n, call.data],
      value: call.value ?? 0n,
      account: session.account,
      chain: session.chain,
    });
    await this.#reader.waitForTransactionReceipt({ hash });
    return hash;
  }

  /**
   * Act, and on a breach mine a `ScopeViolation` instead of reverting.
   *
   * Use this when the violation trace is the point: the log is the on-chain record that a
   * jailbroken model reached for something outside its scope, and it survives the process that
   * produced it. Use `execute` when you want the transaction to fail outright.
   *
   * THE ANSWER COMES FROM THE MINED RECEIPT, and it has to. `tryExecute` has three endings and the
   * return tuple cannot tell two of them apart: a scope breach returns `(false, TAG)` and emits
   * `ScopeViolation`, a downstream revert on a call the scope ALLOWED returns `(false, OK)` and
   * emits nothing at all, and a success returns `(true, OK)` and emits `ScopedCall`. This method
   * used to answer with `ok` and `reason` taken from `simulateContract`, which is a value read
   * before the transaction existed. That made the common case right by luck (simulate runs the
   * same `_checkAndAccount`) and the racing case wrong by construction, which is the only case a
   * caller asks about. The simulation is gone. The receipt is already being awaited, so the logs
   * are free, and a log is the same artifact the public record is built from.
   *
   * `publicationCost` is what the caller is willing to hand over to have this recorded, in wei. It
   * rides as SURPLUS transaction value and is deliberately absent from the scoped argument, and
   * that split is the whole care in this method. The delegate judges the `value` ARGUMENT, so
   * folding a price into it would change the call the scope rules on: a swap refused for PER_TX at
   * one ether would be judged at one ether plus the price, and the price could then decide the
   * reason that goes on the public record. `msg.value` is never compared against that argument
   * (`SessionKeyDelegate.tryExecute` is payable and checks only the argument, read 2026-08-23), so
   * the surplus is retained at the agent EOA: all of it on a breach, since the delegate forwards
   * nothing there, and the part above the argument on a pass.
   *
   * There is no branch on the amount, and there must not be one. A cost of zero adds zero and
   * takes the same line as a cost of one, so the path that runs every day is the same path that
   * runs the day somebody sets a price. `execute` takes no such parameter, because an allowed call
   * is simply made and buys no record.
   */
  async tryExecute(session: Wallet, call: Call, publicationCost: bigint = 0n): Promise<TryExecuteResult> {
    const hash = await session.writeContract({
      address: this.agent,
      abi: sessionKeyDelegateAbi,
      functionName: "tryExecute",
      args: [call.target, call.value ?? 0n, call.data],
      value: (call.value ?? 0n) + publicationCost,
      account: session.account,
      chain: session.chain,
    });
    const receipt = await this.#reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new DelegationError(
        `the tryExecute transaction at ${hash} reverted. The delegate reverts only on an ` +
          "uninitialized scope or a sender that is not the session key, and neither of those is a " +
          "scope decision, so this is a wiring fault rather than a refusal.",
      );
    }

    // Only logs from the agent's own address count. Under 7702 the delegate's code runs at the
    // agent EOA, so a `ScopeViolation` in this receipt from any other address belongs to some
    // other agent in the same block's transaction and would be someone else's record read as ours.
    const mine = receipt.logs.filter((l) => l.address.toLowerCase() === this.agent.toLowerCase());
    const violations = parseEventLogs({ abi: sessionKeyDelegateAbi, eventName: "ScopeViolation", logs: mine });
    const violation = violations[0];
    if (violation) return { hash, outcome: "published", reason: decodeReason(violation.args.reason) };

    const scoped = parseEventLogs({ abi: sessionKeyDelegateAbi, eventName: "ScopedCall", logs: mine });
    if (scoped.length > 0) return { hash, outcome: "settled", reason: "OK" };

    // Neither event. The scope passed and the call itself reverted, so nothing was recorded and
    // nothing was performed, and the epoch budget was charged on the way through anyway.
    return { hash, outcome: "callReverted", reason: "OK" };
  }

  /** The installed scope as a human paragraph, for a startup log or a confirmation prompt. */
  static describe(scope: Scope): string {
    return describeScope(scope);
  }
}

import {
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import {
  launchHookAbi,
  reputationRegistryAbi,
  tokenFactoryAbi,
  Phase,
} from "./generated/contracts.ts";
import { crewLaunchAbi } from "./generated/factory-crew.ts";
import { resolveAddresses, type UntollAddresses } from "./config.ts";
import type { Call, Reader, Wallet } from "./session.ts";

/**
 * The UNTOLL surface an agent touches: read the state of a launch, settle what is owed, and build
 * a launch.
 *
 * Everything that WRITES is exposed twice, once as a direct call and once as `...Call`, which
 * returns the `{target, data}` an agent routes through its session key instead of sending itself.
 * That symmetry is deliberate: the same action reads identically whether a human or a contained
 * agent performs it, and the scope is what makes the difference.
 */

export type LaunchParams = {
  creator: Address;
  graduationTarget: bigint;
  curveSupply: bigint;
  snipeWindow: bigint;
  tradeFeeBps: number;
  snipeStartBps: number;
  perWalletCapBps: number;
  creatorAllocationBps: number;
  /** ops, creator, participation, pool. The four buckets, in basis points, summing to 10000. */
  bucketBps: readonly [number, number, number, number];
  /** Frozen-hook launches only: the crew key that holds the crew bucket. Naming it selects the 11-field launch. */
  crew?: Address;
  /** Frozen-hook launches only: crew card fingerprint, zero when there is none. */
  persona?: Hex;
};

export class Untoll {
  readonly addresses: UntollAddresses;

  readonly #reader: Reader;

  constructor(reader: Reader, overrides: Partial<UntollAddresses> = {}) {
    this.#reader = reader;
    this.addresses = resolveAddresses(overrides);
  }

  // -- reads ---------------------------------------------------------------------------------

  /** Bonding, Graduating, or Graduated. Graduated means curve off, splitter on, for good. */
  async phaseOf(poolId: Hex): Promise<Phase> {
    const phase = await this.#reader.readContract({
      address: this.addresses.launchHook,
      abi: launchHookAbi,
      functionName: "phaseOf",
      args: [poolId],
    });
    return Number(phase) as Phase;
  }

  /** How far along the curve a bonding pool has travelled, as the hook reports it. */
  progressOf(poolId: Hex) {
    return this.#reader.readContract({
      address: this.addresses.launchHook,
      abi: launchHookAbi,
      functionName: "progressOf",
      args: [poolId],
    });
  }

  creatorOf(poolId: Hex) {
    return this.#reader.readContract({
      address: this.addresses.launchHook,
      abi: launchHookAbi,
      functionName: "creatorOf",
      args: [poolId],
    });
  }

  currentEpoch(poolId: Hex) {
    return this.#reader.readContract({
      address: this.addresses.launchHook,
      abi: launchHookAbi,
      functionName: "currentEpoch",
      args: [poolId],
    });
  }

  /** What `who` can pull for one epoch. Claims are pull-based, so nothing arrives unasked. */
  claimableRewards(poolId: Hex, who: Address, epochIndex: bigint) {
    return this.#reader.readContract({
      address: this.addresses.launchHook,
      abi: launchHookAbi,
      functionName: "claimableRewards",
      args: [poolId, who, epochIndex],
    });
  }

  claimableCreatorFee(poolId: Hex) {
    return this.#reader.readContract({
      address: this.addresses.launchHook,
      abi: launchHookAbi,
      functionName: "claimableCreatorFee",
      args: [poolId],
    });
  }

  /** The address a launch will land at, before it happens. Deterministic, so it is checkable. */
  predictToken(creator: Address, name: string, symbol: string) {
    return this.#reader.readContract({
      address: this.addresses.tokenFactory,
      abi: tokenFactoryAbi,
      functionName: "predictToken",
      args: [creator, name, symbol],
    });
  }

  /**
   * The frozen factory's predictToken takes FOUR arguments (launcher, creator, name, symbol);
   * the 3-argument predictToken above reverts with empty data against it.
   */
  predictTokenFrozen(launcher: Address, creator: Address, name: string, symbol: string) {
    return this.#reader.readContract({
      address: this.addresses.tokenFactory,
      abi: [
        {
          type: "function",
          name: "predictToken",
          stateMutability: "view",
          inputs: [
            { name: "launcher", type: "address" },
            { name: "creator", type: "address" },
            { name: "name", type: "string" },
            { name: "symbol", type: "string" },
          ],
          outputs: [{ name: "", type: "address" }],
        },
      ] as const,
      functionName: "predictToken",
      args: [launcher, creator, name, symbol],
    });
  }

  /** Who this address is bound to, if anyone. Status only, off every fee path. */
  referrerOf(who: Address) {
    return this.#reader.readContract({
      address: this.addresses.reputationRegistry,
      abi: reputationRegistryAbi,
      functionName: "referrerOf",
      args: [who],
    });
  }

  // -- calls an agent routes through its session key ------------------------------------------

  claimRewardsCall(poolId: Hex, epochIndex: bigint): Call {
    return {
      target: this.addresses.launchHook,
      data: encodeFunctionData({ abi: launchHookAbi, functionName: "claimRewards", args: [poolId, epochIndex] }),
    };
  }

  claimRewardsRangeCall(poolId: Hex, fromEpoch: bigint, toEpoch: bigint): Call {
    return {
      target: this.addresses.launchHook,
      data: encodeFunctionData({
        abi: launchHookAbi,
        functionName: "claimRewardsRange",
        args: [poolId, fromEpoch, toEpoch],
      }),
    };
  }

  claimCreatorFeeCall(poolId: Hex): Call {
    return {
      target: this.addresses.launchHook,
      data: encodeFunctionData({ abi: launchHookAbi, functionName: "claimCreatorFee", args: [poolId] }),
    };
  }

  bindReferrerCall(referrer: Address): Call {
    return {
      target: this.addresses.tokenFactory,
      data: encodeFunctionData({ abi: tokenFactoryAbi, functionName: "bindReferrer", args: [referrer] }),
    };
  }

  launchCall(quoteCurrency: Address, name: string, symbol: string, params: LaunchParams, value = 0n): Call {
    const sum = params.bucketBps.reduce((a, b) => a + b, 0);
    if (sum !== 10_000) {
      throw new Error(`bucketBps must sum to 10000, got ${sum}: [${params.bucketBps.join(", ")}]`);
    }
    if (params.crew) {
      const { crew, persona, ...rest } = params;
      const zero32 = `0x${"0".repeat(64)}` as Hex;
      return {
        target: this.addresses.tokenFactory,
        value,
        data: encodeFunctionData({
          abi: crewLaunchAbi,
          functionName: "launch",
          args: [quoteCurrency, name, symbol, { ...rest, crew, persona: persona ?? zero32 }],
        }),
      };
    }
    const { crew: _c, persona: _p, ...legacy } = params;
    return {
      target: this.addresses.tokenFactory,
      value,
      data: encodeFunctionData({
        abi: tokenFactoryAbi,
        functionName: "launch",
        args: [quoteCurrency, name, symbol, legacy],
      }),
    };
  }

  // -- the same writes, sent directly ---------------------------------------------------------

  async send(wallet: Wallet, call: Call): Promise<Hex> {
    const hash = await wallet.sendTransaction({
      account: wallet.account,
      chain: wallet.chain,
      to: call.target,
      value: call.value ?? 0n,
      data: call.data,
    });
    await this.#reader.waitForTransactionReceipt({ hash });
    return hash;
  }

  /**
   * The selectors an agent typically needs on its allowlist, as signatures.
   *
   * None of them takes a recipient argument: claims are pull-based and pay the caller, which is
   * why the scope's recipient policy has nothing to bind to on this set. Add a recipient argument
   * for any OTHER contract you allow, especially a swap router.
   */
  static readonly CLAIM_SIGNATURES = [
    "claimRewards(bytes32,uint256)",
    "claimRewardsRange(bytes32,uint256,uint256)",
    "claimCreatorFee(bytes32)",
  ] as const;
}

/**
 * The bonding trade path, and why this returns a description rather than a transaction.
 *
 * The curve IS the pool: a bonding buy or sell is a Uniswap v4 swap carrying the PoolKey, routed
 * through a swap router, not a function on the hook. UNTOLL's front-door router is a signed
 * decision whose code has not shipped, so there is no address for this SDK to point at. Build the
 * intent, hand it to whichever v4 router you use, and put that router on the scope with a
 * recipient argument.
 */
export type SwapIntent = {
  poolManager: Address;
  hook: Address;
  quoteCurrency: Address;
  token: Address;
  amountIn: bigint;
  zeroForOne: boolean;
  note: string;
};

export function buildSwapIntent(
  addresses: UntollAddresses,
  args: { quoteCurrency: Address; token: Address; amountIn: bigint; zeroForOne: boolean },
): SwapIntent {
  return {
    poolManager: addresses.poolManager,
    hook: addresses.launchHook,
    ...args,
    note:
      "a v4 swap against the PoolKey (currency0, currency1, fee, tickSpacing, hook). Route it " +
      "through your v4 router, and allow that router in the scope with the recipient argument set " +
      "to whichever parameter receives the output.",
  };
}

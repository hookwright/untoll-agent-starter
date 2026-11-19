import {
  concatHex,
  encodeFunctionData,
  getAddress,
  pad,
  parseAbi,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { agentAccountBytecode } from "./generated/agent-account-bytecode.ts";
import type { Call } from "./session.ts";

/**
 * AgentAccount mode: the plain-transaction twin of the 7702 SessionKeyDelegate path. The owner deploys
 * an account with an ordinary type-2 transaction (no EIP-7702, no type-4) and issues session keys
 * whose scope is target + selector + PINNED CALLDATA WORDS + value caps. The contract is
 * untoll-agents `src/agent/AgentAccount.sol`; every word position here is measured, not guessed
 * (untoll-agents test_layout_launchSelectorAndCrewWord and test_real_layoutSelectorAndWords).
 */

export const agentAccountAbi = parseAbi([
  "constructor(address owner_)",
  "struct Pin { uint16 word; bytes32 value; }",
  "struct Rule { address target; bytes4 selector; Pin[] pins; }",
  "struct KeyConfig { uint64 expiry; uint64 epochLength; uint32 perEpochCalls; uint128 perTxCap; uint128 perEpochCap; uint128 lifetimeCap; uint128 burstCap; }",
  "function issueKey(address key, KeyConfig c, Rule[] rules)",
  "function revokeKey(address key)",
  "function revokeAll()",
  "function pause()",
  "function unpause()",
  "function transferOwnership(address next)",
  "function acceptOwnership()",
  "function execute(address target, uint256 value, bytes data) returns (bytes)",
  "function withdraw(address asset, address to, uint256 amount)",
  "function owner() view returns (address)",
  "function ruleAllowed(address key, address target, bytes4 sel) view returns (bool)",
  "function pinsOf(address key, address target, bytes4 sel) view returns (Pin[])",
  "function epochRemaining(address key) view returns (uint256)",
  "error NotOwner()",
  "error NotSessionKey()",
  "error SessionExpired()",
  "error TargetNotAllowed()",
  "error SelectorNotAllowed()",
  "error PinMismatch(uint16 word)",
  "error ShortCalldata()",
  "error PerTxCapExceeded(uint256 value, uint256 cap)",
  "error PerEpochCapExceeded(uint256 spent, uint256 value, uint256 cap)",
  "error LifetimeCapExceeded(uint256 spent, uint256 value, uint256 cap)",
  "error CallCapExceeded(uint256 calls, uint256 cap)",
  "error CallFailed(bytes reason)",
  "error PausedError()",
  "error TargetNotContract(address target)",
  "error NotContract(address asset)",
]);

export type Pin = { word: number; value: Hex };
export type Rule = { target: Address; selector: Hex; pins: Pin[] };
export type KeyConfig = {
  expiry: bigint;
  epochLength: bigint;
  perEpochCalls: number;
  perTxCap: bigint;
  perEpochCap: bigint;
  lifetimeCap: bigint;
  /** Token-bucket capacity. Spend in any window of epochLength seconds is <= perEpochCap; burst <= perEpochCap. */
  burstCap: bigint;
};
export type KeyScope = { config: KeyConfig; rules: Rule[] };
export type PoolKeyLike = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/** TokenFactory.launch(Currency,string,string,LaunchParams) with the 11-field tuple: 0xf9e40591. */
export const LAUNCH_SELECTOR: Hex = "0xf9e40591";
/** The rail's router is v4 PoolSwapTest.swap(PoolKey,SwapParams,TestSettings,bytes): 0x2229d0b4. */
export const SWAP_SIGNATURE =
  "swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)";
export const SWAP_SELECTOR: Hex = toFunctionSelector(SWAP_SIGNATURE);

/** Calldata word positions (1-based ABI word, bytes 4+32*(w-1)). */
export const LAUNCH_WORDS = { quote: 1, creator: 4, crew: 16, persona: 17 } as const;
export const SWAP_WORDS = {
  currency0: 1,
  currency1: 2,
  fee: 3,
  tickSpacing: 4,
  hooks: 5,
  zeroForOne: 6,
  amountSpecified: 7,
  takeClaims: 9,
  settleUsingBurn: 10,
} as const;

const addrWord = (a: Address): Hex => pad(getAddress(a), { size: 32 });
const uintWord = (n: bigint | number): Hex => pad(toHex(BigInt(n)), { size: 32 });
const intWord = (n: number): Hex => pad(toHex(BigInt.asUintN(256, BigInt(n))), { size: 32 });
export const pin = (word: number, value: Hex): Pin => ({ word, value });

/** Launch key rule: quote, creator (the account) and crew are all pinned. A free crew would redirect the crew bucket. */
export function launchRule(a: {
  factory: Address;
  account: Address;
  crew: Address;
  quote?: Address;
  /** Persona card word (word 17, bytes32). Pinned by default; pass null to leave it agent-chosen. */
  persona?: Hex | null;
  /** Extra pins for the rest of the launch shape (graduationTarget, curveSupply, snipeWindow, ...), word -> value. */
  shape?: Pin[];
}): Rule {
  if (getAddress(a.crew) === getAddress(zeroAddress)) {
    throw new Error("crew must be a real address: zero would drop the crew bucket");
  }
  return {
    target: a.factory,
    selector: LAUNCH_SELECTOR,
    pins: [
      pin(LAUNCH_WORDS.quote, addrWord(a.quote ?? zeroAddress)),
      pin(LAUNCH_WORDS.creator, addrWord(a.account)),
      pin(LAUNCH_WORDS.crew, addrWord(a.crew)),
      ...(a.persona === null || a.persona === undefined ? [] : [pin(LAUNCH_WORDS.persona, pad(a.persona, { size: 32 }))]),
      ...(a.shape ?? []),
    ],
  };
}

/**
 * Buy key rule: one pool (PoolKey words 1-5), buy direction, tokens not claims. PoolSwapTest has no
 * recipient word: it settles and takes for msg.sender, which is the account, so the account is the
 * recipient by construction.
 */
export function buyRule(a: { router: Address; pool: PoolKeyLike; zeroForOne?: boolean }): Rule {
  return {
    target: a.router,
    selector: SWAP_SELECTOR,
    pins: [
      pin(SWAP_WORDS.currency0, addrWord(a.pool.currency0)),
      pin(SWAP_WORDS.currency1, addrWord(a.pool.currency1)),
      pin(SWAP_WORDS.fee, uintWord(a.pool.fee)),
      pin(SWAP_WORDS.tickSpacing, intWord(a.pool.tickSpacing)),
      pin(SWAP_WORDS.hooks, addrWord(a.pool.hooks)),
      pin(SWAP_WORDS.zeroForOne, uintWord(a.zeroForOne === false ? 0 : 1)),
      pin(SWAP_WORDS.takeClaims, uintWord(0)),
      pin(SWAP_WORDS.settleUsingBurn, uintWord(0)),
    ],
  };
}

export type LaunchKeyArgs = {
  factory: Address;
  account: Address;
  crew: Address;
  /** Read it from factory.creationFee(); never assume. Every launch spends exactly this, so it is the per-tx cap. */
  creationFee: bigint;
  launches: number;
  expiry: bigint;
  quote?: Address;
  /** Persona card (bytes32) pinned at word 17. Required; null opts out of the pin on purpose. */
  persona: Hex | null;
  /** Pin the rest of the launch shape: extra word pins, 8 pins in all including quote, creator, crew, persona. */
  shape?: Pin[];
};

export function buildLaunchKey(a: LaunchKeyArgs): KeyScope {
  const total = a.creationFee * BigInt(a.launches);
  if (a.persona === undefined) {
    throw new Error("persona is required: pass the persona card bytes32, or persona: null to leave it agent-chosen");
  }
  const rule = launchRule(a);
  if (rule.pins.length > 8) throw new Error("a rule holds at most 8 pins (contract MAX_PINS)");
  return {
    config: {
      expiry: a.expiry,
      epochLength: 86_400n,
      perEpochCalls: a.launches,
      perTxCap: a.creationFee,
      perEpochCap: total,
      lifetimeCap: total,
      burstCap: a.creationFee, // one launch at a time; the rest accrues over the epoch
    },
    rules: [rule],
  };
}

export type BuyKeyArgs = {
  router: Address;
  pool: PoolKeyLike;
  expiry: bigint;
  perTxCap: bigint;
  perEpochCap: bigint;
  lifetimeCap: bigint;
  perEpochCalls: number;
  epochLength?: bigint;
  /** Bucket capacity. Default: the larger of perTxCap and half of perEpochCap. */
  burstCap?: bigint;
};

export function buildBuyKey(a: BuyKeyArgs): KeyScope {
  if (a.perTxCap > a.perEpochCap || a.perTxCap > a.lifetimeCap) {
    throw new Error("caps must satisfy perTx <= perEpoch and perTx <= lifetime");
  }
  return {
    config: {
      expiry: a.expiry,
      epochLength: a.epochLength ?? 86_400n,
      perEpochCalls: a.perEpochCalls,
      perTxCap: a.perTxCap,
      perEpochCap: a.perEpochCap,
      lifetimeCap: a.lifetimeCap,
      burstCap: a.burstCap ?? (a.perTxCap > a.perEpochCap / 2n ? a.perTxCap : a.perEpochCap / 2n),
    },
    rules: [buyRule(a)],
  };
}

/** The same check the contract runs: first pin the calldata fails, or null when every pin holds. */
export function firstPinMismatch(rule: Rule, data: Hex): number | null {
  const raw = data.slice(2);
  for (const p of rule.pins) {
    const start = (4 + 32 * (p.word - 1)) * 2;
    if (raw.length < start + 64) return p.word;
    if (`0x${raw.slice(start, start + 64)}`.toLowerCase() !== p.value.toLowerCase()) return p.word;
  }
  return null;
}

// -- calls ----------------------------------------------------------------------------------

export const issueKeyCall = (account: Address, key: Address, s: KeyScope): Call => ({
  target: account,
  value: 0n,
  data: encodeFunctionData({ abi: agentAccountAbi, functionName: "issueKey", args: [key, s.config, s.rules] }),
});

export const revokeKeyCall = (account: Address, key: Address): Call => ({
  target: account,
  value: 0n,
  data: encodeFunctionData({ abi: agentAccountAbi, functionName: "revokeKey", args: [key] }),
});

/** Wrap an inner call for the session key to send to the account. `execute` is non-payable: the value comes from the account balance. */
export const executeCall = (account: Address, inner: Call): Call => ({
  target: account,
  value: 0n,
  data: encodeFunctionData({
    abi: agentAccountAbi,
    functionName: "execute",
    args: [inner.target, inner.value ?? 0n, inner.data],
  }),
});

const swapAbi = [
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    outputs: [{ name: "", type: "int256" }],
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "zeroForOne", type: "bool" },
          { name: "amountSpecified", type: "int256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
      {
        name: "testSettings",
        type: "tuple",
        components: [
          { name: "takeClaims", type: "bool" },
          { name: "settleUsingBurn", type: "bool" },
        ],
      },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

/** A native-quote buy through the rail's router: exact input of `amountIn` wei in the buy direction. `opts` exists so a test can build the calldata a hostile key would send. */
export function buyCall(
  router: Address,
  pool: PoolKeyLike,
  amountIn: bigint,
  opts: { zeroForOne?: boolean; takeClaims?: boolean } = {},
): Call {
  const zfo = opts.zeroForOne ?? true;
  return {
    target: router,
    value: amountIn,
    data: encodeFunctionData({
      abi: swapAbi,
      functionName: "swap",
      args: [
        pool,
        {
          zeroForOne: zfo,
          amountSpecified: -amountIn,
          sqrtPriceLimitX96: zfo ? 4295128740n : 1461446703485210103287273052203988822378723970341n,
        },
        { takeClaims: opts.takeClaims ?? false, settleUsingBurn: false },
        "0x",
      ],
    }),
  };
}

/** Deploy the account with an ordinary (type-2) transaction. The deployer gets no authority: `owner` does. */
export async function deployAgentAccount(w: WalletClient, pub: PublicClient, owner: Address): Promise<{ address: Address; hash: Hex }> {
  if (!w.account) throw new Error("wallet has no account");
  const data = concatHex([agentAccountBytecode, pad(getAddress(owner), { size: 32 })]);
  const hash = await w.sendTransaction({ account: w.account, chain: w.chain, to: null, data, type: "eip1559" } as never);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success" || !rc.contractAddress) throw new Error(`deploy failed: ${hash}`);
  return { address: rc.contractAddress, hash };
}

/**
 * Re-issuing a key is a full counter reset (a fresh lifetime budget). Never re-issue a LIVE key to
 * extend its expiry: revoke it, or wait for expiry, and issue a new key on purpose. Pass the key's
 * current on-chain expiry (keyInfo(key).expiry, 0 when it is not a key).
 */
export function refuseLiveReissue(currentExpiry: bigint, nowSeconds: bigint): void {
  if (currentExpiry !== 0n && currentExpiry >= nowSeconds) {
    throw new Error(
      "refusing to re-issue a live key: it would reset the lifetime budget. Revoke it first (revokeKey) or wait for expiry.",
    );
  }
}

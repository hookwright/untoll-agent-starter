import type { Address } from "viem";

/*
 * Generated. Regenerate it rather than patching it by hand.
 *
 * SessionKeyDelegate is a COMPILED ABI (forge output), so its custom errors carry real
 * selectors and a reverted call decodes to a named scope error. Its creation bytecode is in
 * ./delegate-bytecode.ts, sha256 f68f9ee4d0ad715e.
 *
 * The UNTOLL contract ABIs are DERIVED FROM the Solidity declarations in
 * repos/untoll-hook/contracts/src at dcd7001, not from a compiled artifact. Two
 * consequences to know before you rely on them: custom error selectors are absent, and so is
 * the surface LaunchHook inherits from BaseCustomCurve. Add the compiled ABI when you need to
 * decode a hook revert reason.
 *
 * Addresses come from the chain 46630 deploy record, read back with eth_getCode after
 * broadcast and source-verified on Blockscout. PoolId encodes as bytes32 and Currency as
 * address (both are v4-core value types).
 */

export const CHAIN_ID = 46630;

/** Robinhood Chain testnet 46630. Override any of these through the env, see ../config.ts. */
export const addresses = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address,
  launchHook: "0x6793347aE686A80c65BA49204Fe33b5C8bbB6aC8" as Address,
  tokenFactory: "0x325407204587605AE974a82406F70dD7A1E5A961" as Address,
  launchTokenImplementation: "0xEdD7231CF1e60974a204CD8421E4C116a4955320" as Address,
  reputationRegistry: "0x0f25a173B280b65326f5fB7ACa85EA45D4B9Ea37" as Address,
  polMath: "0x3bc569e059c359a430722f4adaaf37bd64915037" as Address,
};

/** Welded into LaunchHook at construction. Read them off chain to check they are separate wallets. */
export const immutables = {
  treasury: "0x0cd6724019EFBA2ff175fA05a74E43eb0f4aa847" as Address,
  pauseGuardian: "0x636ba41419248456F4c02EB8825e6835eb0d9524" as Address,
};

// Phase, mirrors ILaunchHook.Phase.
export const Phase = {
  Bonding: 0,
  Graduating: 1,
  Graduated: 2,
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

// ActivityKind, mirrors ILaunchHook.ActivityKind.
export const ActivityKind = {
  Launch: 0,
  Trade: 1,
  LP: 2,
  Refer: 3,
} as const;
export type ActivityKind = (typeof ActivityKind)[keyof typeof ActivityKind];

/*
 * SessionKeyDelegate: the containment core. Under EIP-7702 this code runs AT the agent's own
 * EOA, so every one of these is called with the agent address as `to`, never a shared contract.
 */
export const sessionKeyDelegateAbi = [
  {
    type: "receive",
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "MAX_GRANTS",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "uint256",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "allowedRecipient",
    stateMutability: "view",
    inputs: [
      {
        type: "address",
        name: "",
      },
    ],
    outputs: [
      {
        type: "bool",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "allowedSelector",
    stateMutability: "view",
    inputs: [
      {
        type: "bytes4",
        name: "",
      },
    ],
    outputs: [
      {
        type: "bool",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "allowedTarget",
    stateMutability: "view",
    inputs: [
      {
        type: "address",
        name: "",
      },
    ],
    outputs: [
      {
        type: "bool",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "amountArgIndex",
    stateMutability: "view",
    inputs: [
      {
        type: "bytes4",
        name: "",
      },
    ],
    outputs: [
      {
        type: "uint256",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "epochLength",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "uint64",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "epochSpent",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "uint128",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "epochStart",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "uint64",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      {
        type: "address",
        name: "target",
      },
      {
        type: "uint256",
        name: "value",
      },
      {
        type: "bytes",
        name: "data",
      },
    ],
    outputs: [
      {
        type: "bytes",
        name: "ret",
      },
    ],
  },
  {
    type: "function",
    name: "expiry",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "uint64",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "grantCount",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "uint256",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "grantIndex",
    stateMutability: "view",
    inputs: [
      {
        type: "address",
        name: "",
      },
      {
        type: "address",
        name: "",
      },
    ],
    outputs: [
      {
        type: "uint256",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "granted",
    stateMutability: "view",
    inputs: [
      {
        type: "address",
        name: "token",
      },
      {
        type: "address",
        name: "spender",
      },
    ],
    outputs: [
      {
        type: "bool",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "grants",
    stateMutability: "view",
    inputs: [
      {
        type: "uint256",
        name: "",
      },
    ],
    outputs: [
      {
        type: "address",
        name: "token",
      },
      {
        type: "address",
        name: "spender",
      },
    ],
  },
  {
    type: "function",
    name: "initialize",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        name: "s",
        components: [
          {
            type: "address",
            name: "owner",
          },
          {
            type: "address",
            name: "sessionKey",
          },
          {
            type: "uint64",
            name: "expiry",
          },
          {
            type: "uint128",
            name: "perTxCap",
          },
          {
            type: "uint128",
            name: "perEpochCap",
          },
          {
            type: "uint256",
            name: "perTxUnitCap",
          },
          {
            type: "uint256",
            name: "perEpochUnitCap",
          },
          {
            type: "uint64",
            name: "epochLength",
          },
          {
            type: "address[]",
            name: "targets",
          },
          {
            type: "bytes4[]",
            name: "selectors",
          },
          {
            type: "address[]",
            name: "recipients",
          },
          {
            type: "bytes4[]",
            name: "recipientSelectors",
          },
          {
            type: "uint256[]",
            name: "recipientArgs",
          },
          {
            type: "bytes4[]",
            name: "amountSelectors",
          },
          {
            type: "uint256[]",
            name: "amountArgs",
          },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "initialized",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "bool",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "address",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "perEpochCap",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "uint128",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "perEpochUnitCap",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "uint256",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "perTxCap",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "uint128",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "perTxUnitCap",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "uint256",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "probe",
    stateMutability: "view",
    inputs: [
      {
        type: "address",
        name: "target",
      },
      {
        type: "uint256",
        name: "value",
      },
      {
        type: "bytes",
        name: "data",
      },
    ],
    outputs: [
      {
        type: "bool",
        name: "ok",
      },
      {
        type: "bytes4",
        name: "reason",
      },
    ],
  },
  {
    type: "function",
    name: "recipientArgIndex",
    stateMutability: "view",
    inputs: [
      {
        type: "bytes4",
        name: "",
      },
    ],
    outputs: [
      {
        type: "uint256",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "revokeAndSweep",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "uint256",
        name: "maxSteps",
      },
    ],
    outputs: [
      {
        type: "uint256",
        name: "swept",
      },
      {
        type: "uint256",
        name: "remaining",
      },
    ],
  },
  {
    type: "function",
    name: "revokeAndSweepNamed",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "address[]",
        name: "tokens",
      },
      {
        type: "address[]",
        name: "spenders",
      },
    ],
    outputs: [
      {
        type: "uint256",
        name: "swept",
      },
      {
        type: "uint256",
        name: "remaining",
      },
    ],
  },
  {
    type: "function",
    name: "sessionKey",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "address",
        name: "",
      },
    ],
  },
  {
    type: "function",
    name: "tryExecute",
    stateMutability: "payable",
    inputs: [
      {
        type: "address",
        name: "target",
      },
      {
        type: "uint256",
        name: "value",
      },
      {
        type: "bytes",
        name: "data",
      },
    ],
    outputs: [
      {
        type: "bool",
        name: "ok",
      },
      {
        type: "bytes4",
        name: "reason",
      },
      {
        type: "bytes",
        name: "ret",
      },
    ],
  },
  {
    type: "function",
    name: "unitSpent",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "uint256",
        name: "",
      },
    ],
  },
  {
    type: "event",
    name: "AllowanceGranted",
    anonymous: false,
    inputs: [
      {
        type: "address",
        name: "token",
        indexed: true,
      },
      {
        type: "address",
        name: "spender",
        indexed: true,
      },
      {
        type: "uint256",
        name: "amount",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "AllowanceSwept",
    anonymous: false,
    inputs: [
      {
        type: "address",
        name: "token",
        indexed: true,
      },
      {
        type: "address",
        name: "spender",
        indexed: true,
      },
      {
        type: "bool",
        name: "ok",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "Initialized",
    anonymous: false,
    inputs: [
      {
        type: "address",
        name: "owner",
        indexed: true,
      },
      {
        type: "address",
        name: "sessionKey",
        indexed: true,
      },
      {
        type: "uint64",
        name: "expiry",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "Revoked",
    anonymous: false,
    inputs: [
      {
        type: "uint256",
        name: "swept",
        indexed: false,
      },
      {
        type: "uint256",
        name: "remaining",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "ScopeViolation",
    anonymous: false,
    inputs: [
      {
        type: "address",
        name: "target",
        indexed: true,
      },
      {
        type: "bytes4",
        name: "selector",
        indexed: true,
      },
      {
        type: "bytes4",
        name: "reason",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "ScopedCall",
    anonymous: false,
    inputs: [
      {
        type: "address",
        name: "target",
        indexed: true,
      },
      {
        type: "uint256",
        name: "value",
        indexed: false,
      },
      {
        type: "bytes4",
        name: "selector",
        indexed: false,
      },
    ],
  },
  {
    type: "error",
    name: "AllowanceSelectorUnmetered",
    inputs: [
      {
        type: "bytes4",
        name: "selector",
      },
    ],
  },
  {
    type: "error",
    name: "AlreadyInitialized",
    inputs: [],
  },
  {
    type: "error",
    name: "AmountPolicyMalformed",
    inputs: [],
  },
  {
    type: "error",
    name: "ArrayLengthMismatch",
    inputs: [],
  },
  {
    type: "error",
    name: "CallReverted",
    inputs: [],
  },
  {
    type: "error",
    name: "CalldataTooShort",
    inputs: [],
  },
  {
    type: "error",
    name: "EpochLengthZero",
    inputs: [],
  },
  {
    type: "error",
    name: "Expired",
    inputs: [
      {
        type: "uint256",
        name: "nowTs",
      },
      {
        type: "uint256",
        name: "expiry",
      },
    ],
  },
  {
    type: "error",
    name: "GrantLimitReached",
    inputs: [
      {
        type: "uint256",
        name: "limit",
      },
    ],
  },
  {
    type: "error",
    name: "NotInitialized",
    inputs: [],
  },
  {
    type: "error",
    name: "NotOwner",
    inputs: [],
  },
  {
    type: "error",
    name: "NotSelf",
    inputs: [],
  },
  {
    type: "error",
    name: "NotSessionKey",
    inputs: [],
  },
  {
    type: "error",
    name: "PerEpochCapExceeded",
    inputs: [
      {
        type: "uint256",
        name: "spent",
      },
      {
        type: "uint256",
        name: "value",
      },
      {
        type: "uint256",
        name: "cap",
      },
    ],
  },
  {
    type: "error",
    name: "PerTxCapExceeded",
    inputs: [
      {
        type: "uint256",
        name: "value",
      },
      {
        type: "uint256",
        name: "cap",
      },
    ],
  },
  {
    type: "error",
    name: "RecipientNotAllowed",
    inputs: [
      {
        type: "address",
        name: "recipient",
      },
    ],
  },
  {
    type: "error",
    name: "SelectorNotAllowed",
    inputs: [
      {
        type: "bytes4",
        name: "selector",
      },
    ],
  },
  {
    type: "error",
    name: "TargetNotAllowed",
    inputs: [
      {
        type: "address",
        name: "target",
      },
    ],
  },
  {
    type: "error",
    name: "UnitPerEpochCapExceeded",
    inputs: [
      {
        type: "uint256",
        name: "spent",
      },
      {
        type: "uint256",
        name: "amount",
      },
      {
        type: "uint256",
        name: "cap",
      },
    ],
  },
  {
    type: "error",
    name: "UnitPerTxCapExceeded",
    inputs: [
      {
        type: "uint256",
        name: "amount",
      },
      {
        type: "uint256",
        name: "cap",
      },
    ],
  },
] as const;

/** TokenFactory: the one-call launch and the deterministic-address preflight. */
export const tokenFactoryAbi = [
  {
    type: "function",
    name: "launch",
    stateMutability: "payable",
    inputs: [
      {
        name: "quoteCurrency",
        type: "address",
      },
      {
        name: "name",
        type: "string",
      },
      {
        name: "symbol",
        type: "string",
      },
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "creator",
            type: "address",
          },
          {
            name: "graduationTarget",
            type: "uint96",
          },
          {
            name: "curveSupply",
            type: "uint128",
          },
          {
            name: "snipeWindow",
            type: "uint64",
          },
          {
            name: "tradeFeeBps",
            type: "uint16",
          },
          {
            name: "snipeStartBps",
            type: "uint16",
          },
          {
            name: "perWalletCapBps",
            type: "uint16",
          },
          {
            name: "creatorAllocationBps",
            type: "uint16",
          },
          {
            name: "bucketBps",
            type: "uint16[4]",
          },
        ],
      },
    ],
    outputs: [
      {
        name: "token",
        type: "address",
      },
      {
        name: "poolId",
        type: "bytes32",
      },
    ],
  },
  {
    type: "function",
    name: "predictToken",
    stateMutability: "view",
    inputs: [
      {
        name: "creator",
        type: "address",
      },
      {
        name: "name",
        type: "string",
      },
      {
        name: "symbol",
        type: "string",
      },
    ],
    outputs: [
      {
        name: "",
        type: "address",
      },
    ],
  },
  {
    type: "function",
    name: "bindReferrer",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "referrer",
        type: "address",
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "poolManager",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
      },
    ],
  },
  {
    type: "function",
    name: "hook",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
      },
    ],
  },
  {
    type: "function",
    name: "tokenImplementation",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
      },
    ],
  },
  {
    type: "function",
    name: "creationFee",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "treasury",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
      },
    ],
  },
  {
    type: "function",
    name: "registry",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
      },
    ],
  },
] as const;

/** LaunchHook: the views an agent reads, and the pull-based claims it can settle. */
export const launchHookAbi = [
  {
    type: "function",
    name: "phaseOf",
    stateMutability: "view",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint8",
      },
    ],
  },
  {
    type: "function",
    name: "progressOf",
    stateMutability: "view",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
      },
    ],
    outputs: [
      {
        name: "quoteRaised",
        type: "uint256",
      },
      {
        name: "graduationTarget",
        type: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "creatorOf",
    stateMutability: "view",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "address",
      },
    ],
  },
  {
    type: "function",
    name: "claimableCreatorFee",
    stateMutability: "view",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "claimableRewards",
    stateMutability: "view",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
      },
      {
        name: "who",
        type: "address",
      },
      {
        name: "epochIndex",
        type: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "currentEpoch",
    stateMutability: "view",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "claimCreatorFee",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimRewards",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
      },
      {
        name: "epochIndex",
        type: "uint256",
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimRewardsRange",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
      },
      {
        name: "fromEpoch",
        type: "uint256",
      },
      {
        name: "toEpoch",
        type: "uint256",
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "factory",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
      },
    ],
  },
  {
    type: "function",
    name: "treasury",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
      },
    ],
  },
  {
    type: "function",
    name: "pauseExpiry",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint64",
      },
    ],
  },
  {
    type: "event",
    name: "LaunchInitialized",
    anonymous: false,
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "token",
        type: "address",
        indexed: true,
      },
      {
        name: "creator",
        type: "address",
        indexed: true,
      },
      {
        name: "graduationTarget",
        type: "uint96",
        indexed: false,
      },
      {
        name: "creatorAllocationBps",
        type: "uint16",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "Graduated",
    anonymous: false,
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "quoteSeeded",
        type: "uint256",
        indexed: false,
      },
      {
        name: "tokensSeeded",
        type: "uint256",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "FeeSplit",
    anonymous: false,
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "fee",
        type: "uint256",
        indexed: false,
      },
      {
        name: "toTreasury",
        type: "uint256",
        indexed: false,
      },
      {
        name: "toCreator",
        type: "uint256",
        indexed: false,
      },
      {
        name: "toRewards",
        type: "uint256",
        indexed: false,
      },
      {
        name: "toSink",
        type: "uint256",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "CreatorFeeClaimed",
    anonymous: false,
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "creator",
        type: "address",
        indexed: true,
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "RewardsClaimed",
    anonymous: false,
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "participant",
        type: "address",
        indexed: true,
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "TreasurySwept",
    anonymous: false,
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "treasury",
        type: "address",
        indexed: true,
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "SnipeTaxToPOL",
    anonymous: false,
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "buyer",
        type: "address",
        indexed: true,
      },
      {
        name: "tax",
        type: "uint256",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "ActivityMetered",
    anonymous: false,
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "actor",
        type: "address",
        indexed: true,
      },
      {
        name: "kind",
        type: "uint8",
        indexed: false,
      },
      {
        name: "scoreDelta",
        type: "uint256",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "OrphanedRewardToReserve",
    anonymous: false,
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "EpochRolled",
    anonymous: false,
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: true,
      },
      {
        name: "newEpoch",
        type: "uint256",
        indexed: false,
      },
      {
        name: "windowStart",
        type: "uint64",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "FactorySet",
    anonymous: false,
    inputs: [
      {
        name: "factory",
        type: "address",
        indexed: true,
      },
    ],
  },
  {
    type: "event",
    name: "NewLaunchesPaused",
    anonymous: false,
    inputs: [
      {
        name: "guardian",
        type: "address",
        indexed: true,
      },
      {
        name: "autoExpiry",
        type: "uint64",
        indexed: false,
      },
    ],
  },
  {
    type: "event",
    name: "NewLaunchesUnpaused",
    anonymous: false,
    inputs: [
      {
        name: "by",
        type: "address",
        indexed: true,
      },
    ],
  },
] as const;

/** ReputationRegistry: durable cross-launch counters. Status only, off every fee path. */
export const reputationRegistryAbi = [
  {
    type: "function",
    name: "referrerOf",
    stateMutability: "view",
    inputs: [
      {
        name: "",
        type: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "address",
      },
    ],
  },
  {
    type: "function",
    name: "launchesCreated",
    stateMutability: "view",
    inputs: [
      {
        name: "",
        type: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "totalBinds",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "totalLaunches",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
      },
    ],
  },
  {
    type: "event",
    name: "ReferrerBound",
    anonymous: false,
    inputs: [
      {
        name: "referred",
        type: "address",
        indexed: true,
      },
      {
        name: "referrer",
        type: "address",
        indexed: true,
      },
    ],
  },
  {
    type: "event",
    name: "LaunchRecorded",
    anonymous: false,
    inputs: [
      {
        name: "creator",
        type: "address",
        indexed: true,
      },
      {
        name: "creatorTotal",
        type: "uint256",
        indexed: false,
      },
      {
        name: "protocolTotal",
        type: "uint256",
        indexed: false,
      },
    ],
  },
] as const;

/*
 * Deliberately not here:
 *
 * - The bonding buy/sell entry. The curve IS the pool, so a bonding trade is a v4 swap through a
 *   swap router with the PoolKey, not a function on the hook. That router is not built, so this
 *   SDK builds the swap intent and stops there rather than pretending to send it.
 * - The pause surface. Guardian-only, and an agent is never the guardian.
 * - registerLaunch, recordLaunch, ReputationRegistry.bindReferrer. All factory-only. Bind a
 *   referrer through TokenFactory.bindReferrer, the pass-through meant for callers.
 */

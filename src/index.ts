/**
 * untoll-agent-starter, the typed SDK.
 *
 * Three layers, and they stack in this order:
 *   config    where you are pointing and at which addresses
 *   scope     what the agent's key is allowed to do, and the review that finds the hole
 *   session   the EIP-7702 lane the agent acts through
 *   untoll    the UNTOLL contracts themselves, as reads and as routable calls
 */

export {
  CHAIN_ID,
  Phase,
  ActivityKind,
  addresses as deployedAddresses,
  immutables,
  launchHookAbi,
  reputationRegistryAbi,
  sessionKeyDelegateAbi,
  tokenFactoryAbi,
} from "./generated/contracts.ts";

export {
  SESSION_KEY_DELEGATE_BYTECODE,
  SESSION_KEY_DELEGATE_SHA256,
} from "./generated/delegate-bytecode.ts";

export {
  RH_TESTNET_RPC,
  robinhoodTestnet,
  resolveAddresses,
  resolveChain,
  type UntollAddresses,
} from "./config.ts";

export {
  SCOPE_OK,
  VIOLATION_REASONS,
  ScopeError,
  argumentTypes,
  reviewScope,
  buildScope,
  decodeReason,
  describeScope,
  explainReason,
  reasonTag,
  type AllowedCall,
  type Scope,
  type ScopePolicy,
  type ScopeWarning,
  type ViolationReason,
} from "./scope.ts";

export {
  DelegationError,
  SessionKey,
  designatorFor,
  type Call,
  type ProbeResult,
  type TryExecuteOutcome,
  type TryExecuteResult,
  type Reader,
  type Wallet,
} from "./session.ts";

export {
  Untoll,
  buildSwapIntent,
  type LaunchParams,
  type SwapIntent,
} from "./untoll.ts";

export {
  PrivyAdapterError,
  bindPrivySessionKey,
  privyToViemAccount,
  toPrivyTransaction,
  withPrivySessionKey,
  type PrivyEthereumRpc,
  type PrivyServerWallet,
  type PrivyTransactionRequest,
} from "./privy.ts";
export * from "./agentAccount.ts";

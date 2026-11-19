import { defineChain, type Address, type Chain } from "viem";
import { CHAIN_ID, addresses as deployed } from "./generated/contracts.ts";

/**
 * Where the SDK points, and how a fork or a redeploy moves it without a code change.
 *
 * Every address is an env override over the generated deploy record, so the same build runs
 * against a local chain, a fork, or the testnet. Nothing here reads a private key: the SDK takes
 * accounts you construct, it never constructs one for you and never touches a keystore.
 */

const env = (key: string): string | undefined => {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
};

/** The public testnet endpoint. Point `UNTOLL_RPC` somewhere else for a fork or a local node. */
export const RH_TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com";

export const robinhoodTestnet: Chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RH_TESTNET_RPC] } },
});

/**
 * The chain the SDK talks to. Defaults to testnet 46630.
 *
 * EIP-7702 needs a chain at the Prague hardfork or later. A node that predates it will accept the
 * authorization transaction and leave the EOA with no code, which reads as a silent no-op, so
 * `SessionKey.delegate()` reads the code back and refuses to continue when the designator is absent.
 */
export function resolveChain(): Chain {
  const rpc = env("UNTOLL_RPC");
  const id = env("UNTOLL_CHAIN_ID");
  if (!rpc && !id) return robinhoodTestnet;
  return defineChain({
    id: id ? Number(id) : CHAIN_ID,
    name: env("UNTOLL_CHAIN_NAME") ?? `chain ${id ?? CHAIN_ID}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc ?? RH_TESTNET_RPC] } },
  });
}

export type UntollAddresses = {
  poolManager: Address;
  launchHook: Address;
  tokenFactory: Address;
  launchTokenImplementation: Address;
  reputationRegistry: Address;
  polMath: Address;
  /**
   * The SessionKeyDelegate implementation an agent EOA delegates to.
   *
   * Absent from the generated deploy record on purpose: the delegate is not among the contracts
   * deployed at chain 46630. Deploy it yourself (the creation bytecode ships in
   * ./generated/delegate-bytecode.ts) and set `UNTOLL_DELEGATE_IMPL`, or pass it here.
   */
  sessionKeyDelegate?: Address;
};

/** Deploy-record addresses, each overridable by env, each overridable again per call. */
export function resolveAddresses(overrides: Partial<UntollAddresses> = {}): UntollAddresses {
  return {
    poolManager: (env("UNTOLL_POOL_MANAGER") as Address) ?? deployed.poolManager,
    launchHook: (env("UNTOLL_LAUNCH_HOOK") as Address) ?? deployed.launchHook,
    tokenFactory: (env("UNTOLL_TOKEN_FACTORY") as Address) ?? deployed.tokenFactory,
    launchTokenImplementation:
      (env("UNTOLL_LAUNCH_TOKEN_IMPL") as Address) ?? deployed.launchTokenImplementation,
    reputationRegistry: (env("UNTOLL_REPUTATION_REGISTRY") as Address) ?? deployed.reputationRegistry,
    polMath: (env("UNTOLL_POL_MATH") as Address) ?? deployed.polMath,
    sessionKeyDelegate: (env("UNTOLL_DELEGATE_IMPL") as Address) ?? undefined,
    ...overrides,
  };
}

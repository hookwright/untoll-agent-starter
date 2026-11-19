import {
  createWalletClient,
  getAddress,
  http,
  numberToHex,
  type Address,
  type Chain,
  type Hex,
  type Transport,
} from "viem";
import { toAccount } from "viem/accounts";
import type { LocalAccount } from "viem/accounts";
import type { Scope } from "./scope.ts";
import type { ScopePolicy } from "./scope.ts";
import type { Wallet } from "./session.ts";

/**
 * The Privy lane: onboard an agent through a Privy server wallet, and make that wallet act only
 * through UNTOLL's session key so its authority is confined by the delegate at settlement.
 *
 * The seam, and the honest boundary between the two systems:
 *
 *   Privy       holds the key and signs. A server wallet (or a session signer added to a user's
 *               embedded wallet) can carry Privy-side policies (allowlists, spend caps) that Privy
 *               enforces BEFORE it signs. That check is off chain, run by Privy's infrastructure,
 *               trusted, and revocable by Privy.
 *
 *   UNTOLL      enforces the scope AT SETTLEMENT, in the delegate's bytecode at the agent's own EOA.
 *               That check is on chain, trustless, and survives Privy being bypassed, the session
 *               signer being stolen, or the model being jailbroken. It is the last line, not the
 *               first, and it is the one this adapter exists to bind to.
 *
 * They compose as defense in depth. This adapter deliberately does NOT lean on Privy's policy for
 * the containment guarantee: the guarantee is the on-chain scope, and Privy is the key custody in
 * front of it. If the two ever disagree, the delegate wins, because it is what the chain runs.
 *
 * What this adapter binds is the HOT key: the session key the agent process holds and the delegate
 * checks `msg.sender` against. That is the key a compromise gets hold of, and the whole point is
 * that holding it buys the attacker nothing outside the installed scope. The COLD owner key (which
 * signs the EIP-7702 authorization and installs the scope, once) is a separate concern; see the
 * note on the owner path at the end of this file.
 */

export class PrivyAdapterError extends Error {}

/**
 * The transaction shape Privy's server-side Ethereum signer accepts, per its documented `rpc`
 * surface (`eth_signTransaction` params). Fields are hex strings on the wire and `chain_id`/`type`
 * are numbers.
 *
 * Field CASING is the one thing to confirm against your installed `@privy-io/node` version: the
 * REST/RPC contract uses snake_case (`gas_limit`, `max_fee_per_gas`), which is what is rendered
 * here; some SDK builds accept a camelCase alias. This is isolated in `toPrivyTransaction` so a
 * version tweak is a single edit.
 */
export interface PrivyTransactionRequest {
  to?: string;
  from?: string;
  value?: string;
  data?: string;
  chain_id?: number;
  nonce?: number;
  type?: number;
  gas_limit?: string;
  gas_price?: string;
  max_fee_per_gas?: string;
  max_priority_fee_per_gas?: string;
}

/**
 * The subset of Privy's server-side Ethereum wallet interface this adapter calls. The object
 * returned by `privy.wallets().ethereum()` in `@privy-io/node` satisfies this structurally, so the
 * real client drops in without an import here (and the tests drop in a fake the same way).
 *
 * `signMessage` and `signTypedData` are optional: the UNTOLL execute path signs only transactions,
 * so an agent that just settles never needs them. They are wired through when present so the viem
 * account is complete.
 */
export interface PrivyEthereumRpc {
  signTransaction(
    walletId: string,
    options: { params: { transaction: PrivyTransactionRequest } },
  ): Promise<{ signed_transaction: string; encoding: string }>;
  signMessage?(
    walletId: string,
    options: { params: { message: string } },
  ): Promise<{ signature: string; encoding: string }>;
  signTypedData?(
    walletId: string,
    options: { params: { typed_data: unknown } },
  ): Promise<{ signature: string; encoding: string }>;
}

/**
 * A provisioned Privy server wallet, as this adapter consumes it.
 *
 * `walletId` and `address` come back from `privy.wallets().create(...)` (or from reading an
 * existing wallet); `rpc` is `privy.wallets().ethereum()`. Keep `address` and `walletId` pointing
 * at the same wallet: the address is what the scope binds to, the id is what Privy signs with.
 */
export interface PrivyServerWallet {
  /** The Privy wallet id used for signing calls. */
  walletId: string;
  /** The wallet's Ethereum address. The scope's `sessionKey` must equal this. */
  address: Address;
  /** `privy.wallets().ethereum()` or anything that satisfies the same shape. */
  rpc: PrivyEthereumRpc;
}

/** The viem transaction fields this adapter reads, flattened across the serializable union. */
type ViemTxFields = {
  to?: Address | null;
  from?: Address;
  data?: Hex;
  value?: bigint;
  nonce?: number;
  chainId?: number;
  gas?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  type?: string;
};

const TX_TYPE_TO_NUMBER: Record<string, number> = {
  legacy: 0,
  eip2930: 1,
  eip1559: 2,
  eip7702: 4,
};

/**
 * Map a viem transaction (already prepared with nonce, gas, and fees by the wallet client) onto
 * Privy's documented transaction request. viem hands the account a fully-formed transaction to
 * sign, so there is nothing to fetch here, only to translate.
 */
export function toPrivyTransaction(tx: ViemTxFields): PrivyTransactionRequest {
  const req: PrivyTransactionRequest = {};
  if (tx.to != null) req.to = tx.to;
  if (tx.from != null) req.from = tx.from;
  if (tx.data != null) req.data = tx.data;
  if (tx.value != null) req.value = numberToHex(tx.value);
  if (tx.nonce != null) req.nonce = tx.nonce;
  if (tx.chainId != null) req.chain_id = tx.chainId;
  if (tx.gas != null) req.gas_limit = numberToHex(tx.gas);
  if (tx.gasPrice != null) req.gas_price = numberToHex(tx.gasPrice);
  if (tx.maxFeePerGas != null) req.max_fee_per_gas = numberToHex(tx.maxFeePerGas);
  if (tx.maxPriorityFeePerGas != null) {
    req.max_priority_fee_per_gas = numberToHex(tx.maxPriorityFeePerGas);
  }
  if (tx.type != null && tx.type in TX_TYPE_TO_NUMBER) req.type = TX_TYPE_TO_NUMBER[tx.type];
  return req;
}

/**
 * Wrap a Privy server wallet as a viem `LocalAccount`.
 *
 * The account signs by handing the transaction to Privy and returning the serialized signed
 * transaction Privy produces, which is exactly what viem's local-account signing contract expects.
 * That is the whole bridge: Privy holds the key, viem drives the transaction, the delegate judges
 * the result on chain.
 */
export function privyToViemAccount(wallet: PrivyServerWallet): LocalAccount {
  const address = getAddress(wallet.address);

  return toAccount({
    address,
    async signTransaction(transaction) {
      const request = toPrivyTransaction(transaction as ViemTxFields);
      const { signed_transaction } = await wallet.rpc.signTransaction(wallet.walletId, {
        params: { transaction: request },
      });
      return signed_transaction as Hex;
    },
    async signMessage({ message }) {
      if (!wallet.rpc.signMessage) {
        throw new PrivyAdapterError(
          "this Privy wallet was not given a signMessage method; the UNTOLL settle path does not " +
            "need one, so something else asked this session key to sign a message",
        );
      }
      const text =
        typeof message === "string"
          ? message
          : typeof message.raw === "string"
            ? message.raw
            : bytesToHexString(message.raw);
      const { signature } = await wallet.rpc.signMessage(wallet.walletId, {
        params: { message: text },
      });
      return signature as Hex;
    },
    async signTypedData(typedData) {
      if (!wallet.rpc.signTypedData) {
        throw new PrivyAdapterError(
          "this Privy wallet was not given a signTypedData method; the UNTOLL settle path does not " +
            "need one, so something else asked this session key to sign typed data",
        );
      }
      const { signature } = await wallet.rpc.signTypedData(wallet.walletId, {
        params: { typed_data: typedData },
      });
      return signature as Hex;
    },
  });
}

function bytesToHexString(raw: Uint8Array): Hex {
  let out = "0x";
  for (const b of raw) out += b.toString(16).padStart(2, "0");
  return out as Hex;
}

/** The scope fields the binder checks. A `Scope` or a `ScopePolicy` both satisfy this. */
type ScopeBinding = Pick<Scope, "owner" | "sessionKey">;

/**
 * Bind a Privy server wallet to an UNTOLL scope as the session key, returning the viem `Wallet`
 * that `SessionKey.execute` and `Untoll.send` transact with.
 *
 * Two guards, and both are about the address the delegate will actually check on chain, not about
 * anything Privy does:
 *
 *   1. The Privy wallet's address MUST equal the scope's `sessionKey`. The delegate checks
 *      `msg.sender == sessionKey` at settlement, so a wallet at any other address would have every
 *      `execute` revert, which reads as a broken agent rather than a contained one. Catch it here,
 *      before a single transaction is sent.
 *   2. The Privy wallet MUST NOT be the scope's `owner`. Binding the cold owner key as the hot
 *      session signer is the one move that dissolves the guarantee: the key the agent holds would
 *      then be the key that can widen the scope. `buildScope` rejects owner == sessionKey for the
 *      same reason; this catches it at the Privy seam too.
 */
export function bindPrivySessionKey(params: {
  wallet: PrivyServerWallet;
  scope: ScopeBinding;
  chain: Chain;
  transport?: Transport;
}): Wallet {
  const address = getAddress(params.wallet.address);
  const sessionKey = getAddress(params.scope.sessionKey);
  const owner = getAddress(params.scope.owner);

  if (address !== sessionKey) {
    throw new PrivyAdapterError(
      `the Privy wallet (${address}) is not the scope's session key (${sessionKey}). The delegate ` +
        "checks msg.sender == sessionKey at settlement, so every execute from this wallet would " +
        "revert. Provision the Privy wallet whose address is the installed session key, or build " +
        "the scope with sessionKey set to this Privy address (see withPrivySessionKey).",
    );
  }
  if (address === owner) {
    throw new PrivyAdapterError(
      `the Privy wallet (${address}) is the scope's owner. Binding the cold owner key as the hot ` +
        "session signer defeats the containment: the key the agent holds could then widen its own " +
        "authority. Use a distinct Privy wallet or EOA as the session key.",
    );
  }

  const account = privyToViemAccount(params.wallet);
  return createWalletClient({
    account,
    chain: params.chain,
    transport: params.transport ?? http(),
  }) as Wallet;
}

/**
 * Set a policy's `sessionKey` to a Privy wallet's address, so `buildScope` produces a scope the
 * same Privy wallet can then be bound to without tripping the address guard. The ergonomic front
 * door: provision the Privy wallet, hand it and a policy here, install, bind.
 */
export function withPrivySessionKey(policy: ScopePolicy, wallet: PrivyServerWallet): ScopePolicy {
  return { ...policy, sessionKey: getAddress(wallet.address) };
}

/**
 * The owner (7702) path, on purpose left to a caller-supplied wallet.
 *
 * Installing the delegation needs the OWNER, the agent's own EOA, to sign an EIP-7702 authorization
 * and then install the scope. Whether a Privy embedded wallet can sign a 7702 authorization
 * (viem's `signAuthorization`) depends on your Privy app and SDK version and needs a live check
 * against a chain at the Prague hardfork; it is not something this adapter can assert offline. So
 * the owner stays whatever `Wallet` you pass to `SessionKey.delegate` / `arm`, and this adapter
 * confines itself to the session key, which is the key the compromise story is about.
 */

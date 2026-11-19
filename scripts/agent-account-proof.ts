// AGENT ACCOUNT PROOF. No EIP-7702, no type-4 anywhere.
// On a local anvil fork carrying the frozen hook, factory and the rail's router:
//   owner deploys an AgentAccount (type-2), issues a launch key and a buy key; the launch key launches
//   with params.crew pinned and crewKeyOf reads back; the buy key buys once through the real router;
//   then five refusals (attacker crew, attacker creator, foreign pool, lifetime cap, a transfer).
// Every tx is asserted type 2, and every block of the run is scanned for a type-4 tx.
// Loopback only, port band PROOF_PORT_MIN..PROOF_PORT_MAX (default 9420-9449), throwaway keys, no .env read.
import fs from "node:fs";
import {
  createPublicClient, createWalletClient, decodeAbiParameters, decodeErrorResult, encodeFunctionData, http, pad, parseAbi,
  parseEther, zeroAddress, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Untoll } from "../src/untoll.ts";
import {
  agentAccountAbi, buildBuyKey, buildLaunchKey, buyCall, deployAgentAccount, executeCall, issueKeyCall,
} from "../src/agentAccount.ts";

const RPC = process.env.PROOF_RPC ?? "http://127.0.0.1:9421";
const url = new URL(RPC);
const MIN = Number(process.env.PROOF_PORT_MIN ?? 9420), MAX = Number(process.env.PROOF_PORT_MAX ?? 9449);
if (url.hostname !== "127.0.0.1" || Number(url.port) < MIN || Number(url.port) > MAX) throw new Error(`refusing ${RPC}: loopback ${MIN}-${MAX} only`);
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`set ${k}`); return v as Address; };
const FACTORY = need("UNTOLL_TOKEN_FACTORY"), HOOK = need("UNTOLL_LAUNCH_HOOK"), ROUTER = need("PROOF_ROUTER");
const CREW = (process.env.PROOF_CREW ?? "0xaA647077EDE147676c64DA2d06089c8e0C3FD372") as Address;
const ATTACKER = "0x00000000000000000000000000000000000bad01" as Address;
const OUT = process.env.RECEIPTS_OUT ?? "agent-account-receipts.json";
const rec: Record<string, unknown> = {};
const rep = (_: string, x: unknown) => (typeof x === "bigint" ? x.toString() : x);
const log = (k: string, v: unknown) => { rec[k] = v; console.log(k, typeof v === "string" ? v : JSON.stringify(v, rep)); };

const pub = createPublicClient({ transport: http(RPC) });
const chainId = await pub.getChainId();
const EXPECT_CHAIN = Number(process.env.PROOF_CHAIN_ID);
if (!Number.isInteger(EXPECT_CHAIN)) throw new Error("set PROOF_CHAIN_ID to the chain id of the fork");
if (chainId !== EXPECT_CHAIN) throw new Error(`chain ${chainId}, expected ${EXPECT_CHAIN}`);
const chain = { id: chainId, name: "fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const rpc = (m: string, p: unknown[]) => pub.request({ method: m as never, params: p as never });
const startBlock = await pub.getBlockNumber();
const mk = () => { const pk = generatePrivateKey(); return { pk, addr: privateKeyToAccount(pk).address }; };
const [deployer, owner, launchKey, buyKey] = [mk(), mk(), mk(), mk()];
for (const x of [deployer, owner, launchKey, buyKey]) await rpc("anvil_setBalance", [x.addr, "0x" + parseEther("20").toString(16)]);
const wc = (k: { pk: Hex }) => createWalletClient({ account: privateKeyToAccount(k.pk), chain, transport: http(RPC) });
const hashes: Hex[] = [];
const send = async (k: { pk: Hex }, to: Address, data: Hex, value = 0n, gas?: bigint) => {
  const h = await wc(k).sendTransaction({ to, data, value, type: "eip1559", gas } as never);
  hashes.push(h);
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  if (rc.status !== "success") throw new Error(`tx reverted ${h}`);
  return { h, rc };
};
// A refused call: eth_call as the key, decode the account's custom error. Nothing is mined.
const refusal = async (label: string, k: { addr: Address }, data: Hex, value = 0n) => {
  try {
    await pub.call({ account: k.addr, to: acct, data, value } as never);
    throw new Error("NOT REFUSED");
  } catch (e) {
    const err = e as { message: string; walk?: (f: (x: unknown) => boolean) => { data?: Hex } | null };
    if (err.message === "NOT REFUSED") throw new Error(`${label}: call was NOT refused`);
    const hit = err.walk?.((x) => typeof (x as { data?: unknown })?.data === "string" && ((x as { data: string }).data.startsWith("0x"))) as { data?: Hex } | null;
    if (!hit?.data) throw new Error(`${label}: no revert data: ${err.message.split("\n")[0]}`);
    const d = decodeErrorResult({ abi: agentAccountAbi, data: hit.data });
    const out = { selector: hit.data.slice(0, 10), error: d.errorName, args: (d.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : a)) };
    log(`refusal_${label}`, out);
    return out;
  }
};

// 1. deploy (type-2)
const dep = await deployAgentAccount(wc(deployer) as never, pub as never, owner.addr);
const acct = dep.address;
hashes.push(dep.hash);
log("account", acct); log("owner", owner.addr); log("deployer", deployer.addr);
log("owner_onchain", (await pub.readContract({ address: acct, abi: agentAccountAbi, functionName: "owner" })) as string);
await send(owner, acct, "0x", parseEther("5")); // fund the account with a plain transfer

// 2. launch key
const fee = (await pub.readContract({ address: FACTORY, abi: parseAbi(["function creationFee() view returns (uint256)"]), functionName: "creationFee" })) as bigint;
log("creationFee", fee);
const expiry = BigInt((await pub.getBlock()).timestamp) + 86_400n;
const sdk = new Untoll({} as never, { tokenFactory: FACTORY, launchHook: HOOK });
const lk = buildLaunchKey({ factory: FACTORY, account: acct, crew: CREW, creationFee: fee, launches: 2, expiry, persona: "0x01" });
log("issue_launch_key", (await send(owner, acct, issueKeyCall(acct, launchKey.addr, lk).data)).h);
const lp = (creator: Address, crew: Address) => ({
  creator, graduationTarget: 300n * 10n ** 18n, curveSupply: 10n ** 24n, snipeWindow: 60n, tradeFeeBps: 200, snipeStartBps: 500,
  perWalletCapBps: 100, creatorAllocationBps: 0, bucketBps: [1500, 4500, 2500, 1500] as const, crew, persona: pad("0x01", { size: 32 }),
});
const launchData = (name: string, creator: Address, crew: Address) => {
  const c = sdk.launchCall(zeroAddress, name, name, lp(creator, crew), fee);
  return executeCall(acct, c).data;
};

// 3. the agent launches through its key (call first to read the return, then mine it)
const good = launchData("AGT", acct, CREW);
const ret = (await pub.call({ account: launchKey.addr, to: acct, data: good })).data as Hex;
const [inner] = decodeAbiParameters([{ type: "bytes" }], ret);
const [token, poolId] = decodeAbiParameters([{ type: "address" }, { type: "bytes32" }], inner);
const l = await send(launchKey, acct, good, 0n, 6_000_000n);
log("launch_tx", l.h); log("token", token); log("poolId", poolId);
const hookAbi = parseAbi(["function crewKeyOf(bytes32) view returns (address)", "function creatorOf(bytes32) view returns (address)"]);
const crewKeyOf = (await pub.readContract({ address: HOOK, abi: hookAbi, functionName: "crewKeyOf", args: [poolId] })) as Address;
const creatorOf = (await pub.readContract({ address: HOOK, abi: hookAbi, functionName: "creatorOf", args: [poolId] })) as Address;
log("crewKeyOf", crewKeyOf); log("creatorOf", creatorOf);
if (crewKeyOf.toLowerCase() !== CREW.toLowerCase()) throw new Error("crewKeyOf does not read back the pinned crew");
if (creatorOf.toLowerCase() !== acct.toLowerCase()) throw new Error("creator is not the account");

// 4. the buy key buys once; the lifetime cap then refuses the second
const pool = { currency0: zeroAddress, currency1: token, fee: 0x800000, tickSpacing: 60, hooks: HOOK } as const;
const BUY = parseEther("0.2");
const bk = buildBuyKey({ router: ROUTER, pool, expiry, perTxCap: BUY, perEpochCap: parseEther("1"), lifetimeCap: parseEther("0.3"), perEpochCalls: 10 });
log("issue_buy_key", (await send(owner, acct, issueKeyCall(acct, buyKey.addr, bk).data)).h);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
const bal0 = (await pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [acct] })) as bigint;
const buyData = (p: typeof pool, amt: bigint) => executeCall(acct, buyCall(ROUTER, p, amt)).data;
const b = await send(buyKey, acct, buyData(pool, BUY), 0n, 3_000_000n);
const bal1 = (await pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [acct] })) as bigint;
log("buy_tx", b.h); log("tokens_bought", bal1 - bal0);
if (bal1 <= bal0) throw new Error("buy delivered no tokens to the account");

// 5. refusals
const R: Record<string, { error: string; args: unknown[] }> = {};
R.attackerCrew = await refusal("attacker_crew", launchKey, launchData("EVIL1", acct, ATTACKER), 0n);
R.attackerCreator = await refusal("attacker_creator", launchKey, launchData("EVIL2", ATTACKER, CREW), 0n);
R.foreignPool = await refusal("foreign_pool", buyKey, buyData({ ...pool, currency1: ATTACKER }, BUY));
R.lifetimeCap = await refusal("lifetime_cap", buyKey, buyData(pool, BUY));
R.transfer = await refusal("transfer", buyKey, executeCall(acct, { target: token, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [ATTACKER, 1n] }) }).data);
const want: Record<string, [string, unknown?]> = {
  attackerCrew: ["PinMismatch", 16], attackerCreator: ["PinMismatch", 4], foreignPool: ["PinMismatch", 2],
  lifetimeCap: ["LifetimeCapExceeded"], transfer: ["TargetNotAllowed"],
};
for (const [k, [name, arg]] of Object.entries(want)) {
  const got = R[k]!;
  if (got.error !== name || (arg !== undefined && String(got.args[0]) !== String(arg))) throw new Error(`refusal ${k}: got ${got.error}(${got.args}), want ${name}`);
}

// 6. every tx is type 2; no type-4 in any block of the run
const types: Record<string, string> = {};
for (const h of hashes) {
  const t = (await rpc("eth_getTransactionByHash", [h])) as { type: string };
  types[h] = t.type;
  if (t.type !== "0x2") throw new Error(`tx ${h} is type ${t.type}, not 0x2`);
}
const endBlock = await pub.getBlockNumber();
let scanned = 0;
for (let n = startBlock + 1n; n <= endBlock; n++) {
  const blk = (await rpc("eth_getBlockByNumber", ["0x" + n.toString(16), true])) as { transactions: { type: string; hash: string }[] };
  for (const t of blk.transactions) { scanned++; if (t.type === "0x4") throw new Error(`type-4 tx ${t.hash} in block ${n}`); }
}
log("tx_types", types); log("blocks_scanned", { from: startBlock + 1n, to: endBlock, txs: scanned, type4: 0 });
fs.writeFileSync(OUT, JSON.stringify(rec, rep, 2));
console.log("PROOF COMPLETE, all type 2, receipts", OUT);

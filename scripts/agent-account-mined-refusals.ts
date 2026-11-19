// AGENT ACCOUNT MINED-REFUSAL WALK. Every refusal is a REAL reverting type-2 tx (receipt status reverted), decoded from
// the mined tx's own trace, not from an eth_call. Covers attacker crew, creator, persona, foreign pool, lifetime cap, over-bucket spend,
// a transfer, a key after revokeAll, a key while paused, and a key after an ownership transfer and accept.
// Loopback fork only (PROOF_PORT_MIN..PROOF_PORT_MAX), throwaway keys, no .env read.
import fs from "node:fs";
import {
  createPublicClient, createWalletClient, decodeAbiParameters, decodeErrorResult, encodeFunctionData, http, pad, parseAbi,
  parseEther, zeroAddress, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Untoll } from "../src/untoll.ts";
import {
  agentAccountAbi, buildBuyKey, buildLaunchKey, buyCall, deployAgentAccount, executeCall, issueKeyCall, LAUNCH_SELECTOR, SWAP_SELECTOR,
} from "../src/agentAccount.ts";

const RPC = process.env.PROOF_RPC ?? "http://127.0.0.1:9421";
const url = new URL(RPC);
const MIN = Number(process.env.PROOF_PORT_MIN ?? 9420), MAX = Number(process.env.PROOF_PORT_MAX ?? 9449);
if (url.hostname !== "127.0.0.1" || Number(url.port) < MIN || Number(url.port) > MAX) throw new Error(`refusing ${RPC}: loopback ${MIN}-${MAX} only`);
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`set ${k}`); return v as Address; };
const FACTORY = need("UNTOLL_TOKEN_FACTORY"), HOOK = need("UNTOLL_LAUNCH_HOOK"), ROUTER = need("PROOF_ROUTER");
const CREW = (process.env.PROOF_CREW ?? "0xaA647077EDE147676c64DA2d06089c8e0C3FD372") as Address;
const ATTACKER = "0x00000000000000000000000000000000000bad01" as Address;
const OUT = process.env.RECEIPTS_OUT ?? "agent-account-mined-receipts.json";
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

const pad32 = (h: Hex) => pad(h, { size: 32 });
const mk = () => { const pk = generatePrivateKey(); return { pk, addr: privateKeyToAccount(pk).address }; };
const [deployer, owner, newOwner, launchKey, buyKey, bucketKey, keyR, keyP, keyO] = [mk(), mk(), mk(), mk(), mk(), mk(), mk(), mk(), mk()];
for (const x of [deployer, owner, newOwner, launchKey, buyKey, bucketKey, keyR, keyP, keyO]) await rpc("anvil_setBalance", [x.addr, "0x" + parseEther("20").toString(16)]);
const wc = (k: { pk: Hex }) => createWalletClient({ account: privateKeyToAccount(k.pk), chain, transport: http(RPC) });
const hashes: Hex[] = [];
const send = async (k: { pk: Hex }, to: Address, data: Hex, value = 0n, gas = 3_000_000n) => {
  const h = await wc(k).sendTransaction({ to, data, value, type: "eip1559", gas } as never);
  hashes.push(h);
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  if (rc.status !== "success") throw new Error(`tx reverted ${h}`);
  return { h, rc };
};
// A MINED refusal: the tx lands with status reverted; the revert data is read from the mined tx's own trace.
const refuse = async (label: string, want: string, k: { pk: Hex; addr: Address }, to: Address, data: Hex, wantArg?: number) => {
  const h = await wc(k).sendTransaction({ to, data, type: "eip1559", gas: 3_000_000n } as never);
  hashes.push(h);
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  if (rc.status !== "reverted") throw new Error(`${label}: tx ${h} status ${rc.status}, expected reverted`);
  const tr = (await rpc("debug_traceTransaction", [h, { tracer: "callTracer" }])) as { output?: Hex; error?: string };
  if (!tr.output || tr.output === "0x") throw new Error(`${label}: reverted with empty data (${tr.error})`);
  const d = decodeErrorResult({ abi: agentAccountAbi, data: tr.output });
  const args = (d.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : a));
  if (d.errorName !== want || (wantArg !== undefined && String(args[0]) !== String(wantArg))) throw new Error(`${label}: got ${d.errorName}(${args}), want ${want}`);
  log(`mined_${label}`, { tx: h, block: rc.blockNumber.toString(), status: rc.status, selector: tr.output.slice(0, 10), error: d.errorName, args });
};

const dep = await deployAgentAccount(wc(deployer) as never, pub as never, owner.addr);
const acct = dep.address; hashes.push(dep.hash);
const runtime = (await pub.getCode({ address: acct }))!;
log("account", acct); log("deploy_tx", dep.hash); log("runtime_bytes", (runtime.length - 2) / 2); log("has_issueKey_d0b575f8", runtime.includes("d0b575f8"));
log("owner_onchain", (await pub.readContract({ address: acct, abi: agentAccountAbi, functionName: "owner" })) as string);
await send(owner, acct, "0x", parseEther("5"));
const fee = (await pub.readContract({ address: FACTORY, abi: parseAbi(["function creationFee() view returns (uint256)"]), functionName: "creationFee" })) as bigint;
log("creationFee", fee);
const expiry = BigInt((await pub.getBlock()).timestamp) + 86_400n;
const sdk = new Untoll({} as never, { tokenFactory: FACTORY, launchHook: HOOK });
const PERSONA = pad32("0x01"), EVIL_PERSONA = pad32("0x02");
const issue = async (k: { addr: Address }, s: ReturnType<typeof buildBuyKey>) => (await send(owner, acct, issueKeyCall(acct, k.addr, s).data)).h;
log("issue_launch_key", await issue(launchKey, buildLaunchKey({ factory: FACTORY, account: acct, crew: CREW, creationFee: fee, launches: 3, expiry, persona: "0x01" })));
const lp = (creator: Address, crew: Address, persona: Hex) => ({
  creator, graduationTarget: 300n * 10n ** 18n, curveSupply: 10n ** 24n, snipeWindow: 60n, tradeFeeBps: 200, snipeStartBps: 500,
  perWalletCapBps: 100, creatorAllocationBps: 0, bucketBps: [1500, 4500, 2500, 1500] as const, crew, persona,
});
const launchData = (name: string, creator: Address, crew: Address, persona: Hex = PERSONA) =>
  executeCall(acct, sdk.launchCall(zeroAddress, name, name, lp(creator, crew, persona), fee)).data;
const good = launchData("AGT", acct, CREW);
const ret = (await pub.call({ account: launchKey.addr, to: acct, data: good })).data as Hex;
const [inner] = decodeAbiParameters([{ type: "bytes" }], ret);
const [token, poolId] = decodeAbiParameters([{ type: "address" }, { type: "bytes32" }], inner);
log("launch_tx", (await send(launchKey, acct, good, 0n, 6_000_000n)).h); log("token", token); log("poolId", poolId);
const hookAbi = parseAbi(["function crewKeyOf(bytes32) view returns (address)", "function creatorOf(bytes32) view returns (address)"]);
const crewKeyOf = (await pub.readContract({ address: HOOK, abi: hookAbi, functionName: "crewKeyOf", args: [poolId] })) as Address;
const creatorOf = (await pub.readContract({ address: HOOK, abi: hookAbi, functionName: "creatorOf", args: [poolId] })) as Address;
log("crewKeyOf", crewKeyOf); log("creatorOf", creatorOf);
if (crewKeyOf.toLowerCase() !== CREW.toLowerCase() || creatorOf.toLowerCase() !== acct.toLowerCase()) throw new Error("hook readback does not match the pins");

const pool = { currency0: zeroAddress, currency1: token, fee: 0x800000, tickSpacing: 60, hooks: HOOK } as const;
const BUY = parseEther("0.2");
const mkBuy = (burst?: bigint, life = parseEther("5")) =>
  buildBuyKey({ router: ROUTER, pool, expiry, perTxCap: BUY, perEpochCap: parseEther("1"), lifetimeCap: life, perEpochCalls: 10, burstCap: burst });
const bk = mkBuy(parseEther("1"), parseEther("0.3")); // big bucket so the LIFETIME cap is the binding refusal
log("issue_buy_key", await issue(buyKey, bk));
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
const buyData = (p: typeof pool, amt: bigint) => executeCall(acct, buyCall(ROUTER, p, amt)).data;
log("buy_tx", (await send(buyKey, acct, buyData(pool, BUY))).h);
log("caps_buyKey_as_issued", { perTxCap: bk.config.perTxCap, perEpochCap: bk.config.perEpochCap, lifetimeCap: bk.config.lifetimeCap, burstCap: bk.config.burstCap, perEpochCalls: bk.config.perEpochCalls });
const pinsOf = async (k: Address, target: Address, sel: Hex) =>
  ((await pub.readContract({ address: acct, abi: agentAccountAbi, functionName: "pinsOf", args: [k, target, sel] })) as readonly { word: number; value: Hex }[]).map((p) => ({ word: p.word, value: p.value }));
log("stored_pins_launchKey", await pinsOf(launchKey.addr, FACTORY, LAUNCH_SELECTOR));
log("stored_pins_buyKey", await pinsOf(buyKey.addr, ROUTER, SWAP_SELECTOR));

// over-bucket: the bucket holds BUY, the first buy drains it, the second needs more than has refilled
log("issue_bucket_key", await issue(bucketKey, mkBuy(BUY)));
log("bucket_buy_ok_tx", (await send(bucketKey, acct, buyData(pool, BUY))).h);

await refuse("attacker_crew", "PinMismatch", launchKey, acct, launchData("EVIL1", acct, ATTACKER), 16);
await refuse("attacker_creator", "PinMismatch", launchKey, acct, launchData("EVIL2", ATTACKER, CREW), 4);
await refuse("attacker_persona", "PinMismatch", launchKey, acct, launchData("EVIL3", acct, CREW, EVIL_PERSONA), 17);
await refuse("foreign_pool", "PinMismatch", buyKey, acct, buyData({ ...pool, currency1: ATTACKER }, BUY), 2);
await refuse("lifetime_cap", "LifetimeCapExceeded", buyKey, acct, buyData(pool, BUY));
await refuse("over_bucket", "PerEpochCapExceeded", bucketKey, acct, buyData(pool, BUY));
await refuse("transfer", "TargetNotAllowed", buyKey, acct,
  executeCall(acct, { target: token, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [ATTACKER, 1n] }) }).data);

// key after revokeAll
log("issue_keyR", await issue(keyR, mkBuy()));
log("revokeAll_tx", (await send(owner, acct, encodeFunctionData({ abi: agentAccountAbi, functionName: "revokeAll" }))).h);
await refuse("key_after_revokeAll", "NotSessionKey", keyR, acct, buyData(pool, BUY));
// key while paused
log("issue_keyP", await issue(keyP, mkBuy()));
log("pause_tx", (await send(owner, acct, encodeFunctionData({ abi: agentAccountAbi, functionName: "pause" }))).h);
await refuse("key_while_paused", "PausedError", keyP, acct, buyData(pool, BUY));
log("unpause_tx", (await send(owner, acct, encodeFunctionData({ abi: agentAccountAbi, functionName: "unpause" }))).h);
// key after an ownership transfer and accept (the key works before it, as a control)
log("issue_keyO", await issue(keyO, mkBuy()));
log("keyO_buy_before_transfer_tx", (await send(keyO, acct, buyData(pool, BUY))).h);
log("transferOwnership_tx", (await send(owner, acct, encodeFunctionData({ abi: agentAccountAbi, functionName: "transferOwnership", args: [newOwner.addr] }))).h);
log("acceptOwnership_tx", (await send(newOwner, acct, encodeFunctionData({ abi: agentAccountAbi, functionName: "acceptOwnership" }))).h);
log("owner_after_accept", (await pub.readContract({ address: acct, abi: agentAccountAbi, functionName: "owner" })) as string);
await refuse("key_after_ownership_change", "NotSessionKey", keyO, acct, buyData(pool, BUY));

// every tx is type 2; no type-4 in any block of the run
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
console.log("MINED-REFUSAL WALK COMPLETE, all type 2, receipts", OUT);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  isHex,
  getAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  Phase,
  SessionKey,
  Untoll,
  buildScope,
  describeScope,
  explainReason,
  resolveAddresses,
  resolveChain,
  type Call,
  type Reader,
  type Wallet,
} from "../src/index.ts";
import { describeSurface, laneAllows, resolveLane, SURFACE, type Lane } from "./lanes.ts";
import { listPolicyNames, loadPolicy, PolicyError, refusalFor } from "./policies.ts";

/**
 * The UNTOLL MCP server.
 *
 * What it is for: letting an MCP client (a desktop assistant, an IDE, an agent framework) read UNTOLL
 * state and settle what a pool owes, through a key whose authority is bounded by contract bytecode
 * rather than by the model's judgement.
 *
 * The design rule is in `mcp/lanes.ts` and it is worth reading before this file. In short: a tool
 * that lets the connected model author its own scope would undo the containment through the
 * integration, so the mint tool takes a policy NAME and has no parameter for a target, a selector,
 * a cap, or an expiry. The model can pick a boundary a person wrote. It cannot draw one.
 *
 * Protocol note that costs an hour if you miss it: stdio carries the JSON-RPC framing, so
 * everything this process prints for a human goes to stderr. There is no console.log below.
 */

const note = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const env = (key: string): string | undefined => {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
};

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });
const failure = (body: string) => ({ content: [{ type: "text" as const, text: body }], isError: true });

/** Everything that fails at the edges fails as a legible tool result, never as a dead server. */
async function guard(fn: () => Promise<ReturnType<typeof text>>): Promise<ReturnType<typeof text>> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(message);
  }
}

const requireAddressArg = (value: string, label: string): Address => {
  if (!isAddress(value)) throw new Error(`${label} is not a valid address: ${value}`);
  return getAddress(value);
};

const requirePoolId = (value: string): Hex => {
  if (!isHex(value) || value.length !== 66) {
    throw new Error(`poolId must be 32 bytes of hex (0x and 64 characters), got: ${value}`);
  }
  return value;
};

const PHASE_NAME: Record<number, string> = {
  [Phase.Bonding]: "Bonding",
  [Phase.Graduating]: "Graduating",
  [Phase.Graduated]: "Graduated",
};

// ---------------------------------------------------------------------------------------------
// Wiring. Read once at start, and every gap is stated rather than guessed around.
// ---------------------------------------------------------------------------------------------

const lane: Lane = resolveLane(process.env);
const chain = resolveChain();
const reader: Reader = createPublicClient({ chain, transport: http() });
const addresses = resolveAddresses();
const untoll = new Untoll(reader);

const withheld: Record<string, string> = {};

/**
 * The agent EOA. Under EIP-7702 the delegate's code runs at this address, so it is both the
 * account and every call's destination.
 *
 * In the owner lane it is derived from the owner key, because the delegate requires the installing
 * sender to be the scope's owner. In the read and agent lanes there is no owner key, so it must be
 * given: a session key does not name the account it acts for.
 */
const ownerKey = lane === "owner" ? env("UNTOLL_OWNER_KEY") : undefined;
const ownerAccount = ownerKey ? privateKeyToAccount(ownerKey as Hex) : undefined;
const sessionKeyRaw = env("UNTOLL_SESSION_KEY");
const sessionAccount = sessionKeyRaw ? privateKeyToAccount(sessionKeyRaw as Hex) : undefined;

const agentAddressRaw = env("UNTOLL_AGENT_ADDRESS");
const agentAddress: Address | undefined = ownerAccount
  ? ownerAccount.address
  : agentAddressRaw && isAddress(agentAddressRaw)
    ? getAddress(agentAddressRaw)
    : undefined;

const ownerWallet: Wallet | undefined = ownerAccount
  ? createWalletClient({ account: ownerAccount, chain, transport: http() })
  : undefined;
const sessionWallet: Wallet | undefined = sessionAccount
  ? createWalletClient({ account: sessionAccount, chain, transport: http() })
  : undefined;

if (!agentAddress) {
  const reason =
    "no agent EOA: set UNTOLL_AGENT_ADDRESS, or run the owner lane where it comes from the owner key";
  withheld["untoll_scope_status"] = reason;
  withheld["untoll_check_call"] = reason;
  withheld["untoll_settle"] = reason;
  withheld["untoll_mint_scoped_key"] = reason;
  withheld["untoll_revoke_key"] = reason;
}
if (laneAllows(lane, "agent") && !sessionWallet) {
  withheld["untoll_settle"] = withheld["untoll_settle"] ?? "no UNTOLL_SESSION_KEY, so nothing can be sent";
}
if (lane === "owner" && !ownerWallet) {
  const reason = "the owner lane is declared but UNTOLL_OWNER_KEY is not set";
  withheld["untoll_mint_scoped_key"] = withheld["untoll_mint_scoped_key"] ?? reason;
  withheld["untoll_revoke_key"] = withheld["untoll_revoke_key"] ?? reason;
}
if (lane !== "owner" && env("UNTOLL_OWNER_KEY")) {
  note(
    "  warning         UNTOLL_OWNER_KEY is present but the lane is not owner, so it is not loaded " +
      "and not signed with. A key readable by this process is readable by anything that can read " +
      "this process: keep it off the agent host rather than relying on the lane.",
  );
}

const sessionKey = agentAddress ? new SessionKey(reader, agentAddress) : undefined;

/**
 * Refuse legibly when the agent EOA carries no delegate code.
 *
 * Without this the first thing anyone hits is viem's "the contract function probe returned no
 * data", which is true and tells you nothing. An EOA with no designator is the ordinary state of a
 * fresh account and the most likely reason a probe or a settle goes nowhere, so it gets a sentence
 * that names the actual next step. Returns the refusal, or an empty string to proceed.
 */
async function delegationGap(): Promise<string> {
  const code = (await reader.getCode({ address: agentAddress! })) ?? "0x";
  if (code.toLowerCase().startsWith("0xef0100")) return "";
  return (
    `${agentAddress} carries no EIP-7702 delegate code, so there is no scope at that account to ` +
    `check against and nothing to act through. Its code is "${code === "0x" ? "0x, an ordinary EOA" : code}". ` +
    "Attach a delegate and install a scope first: that is untoll_mint_scoped_key in the owner lane, " +
    "and it is the owner's signature, not this session's."
  );
}

const implementation = ((): Address | undefined => {
  const raw = env("UNTOLL_DELEGATE_IMPL") ?? addresses.sessionKeyDelegate;
  return raw && isAddress(raw) ? getAddress(raw) : undefined;
})();

const routerEnv = env("UNTOLL_ROUTER");
const extras: Record<string, Address | undefined> = {
  router: routerEnv && isAddress(routerEnv) ? getAddress(routerEnv) : undefined,
};

// ---------------------------------------------------------------------------------------------
// The server.
// ---------------------------------------------------------------------------------------------

const server = new McpServer(
  { name: "untoll", version: "0.1.0" },
  {
    instructions:
      "UNTOLL on Robinhood Chain: read a launch's state, settle what a pool owes, and manage an " +
      "EIP-7702 session key whose authority is bounded on chain. Call untoll_check_call before " +
      "any action you are unsure of: it asks the same scope logic that enforces the boundary, " +
      "costs a read, and returns the reason a call would be refused. Scopes are minted from named " +
      "policies written by a person; there is no way to widen one from here.",
  },
);

const registered = (id: string): boolean => {
  const spec = SURFACE.find((s) => s.id === id);
  if (!spec) throw new Error(`${id} is not in SURFACE; add it there first`);
  return laneAllows(lane, spec.lane) && !withheld[id];
};

// -- read lane --------------------------------------------------------------------------------

if (registered("untoll_scope_status")) {
  server.registerTool(
    "untoll_scope_status",
    {
      title: "Scope status",
      description:
        "Read the delegation and the installed scope back off the agent EOA, plus this server's " +
        "own tool surface and which tools are absent and why. Nothing is remembered here: every " +
        "field is read from the chain at call time.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const agent = agentAddress!;
        const code = (await reader.getCode({ address: agent })) ?? "0x";
        const delegated = code.toLowerCase().startsWith("0xef0100");
        const delegatedTo = delegated ? getAddress(`0x${code.slice(8, 48)}`) : undefined;

        const lines = [
          `chain            ${chain.id} at ${chain.rpcUrls.default.http[0]}`,
          `lane             ${lane}`,
          `agent EOA        ${agent}`,
          `delegated        ${delegated ? `yes, to ${delegatedTo}` : "no, the EOA carries no delegate code"}`,
          `session key      ${sessionAccount?.address ?? "not loaded in this lane"}`,
          `launch hook      ${addresses.launchHook}`,
        ];

        if (delegated) {
          const scope = await sessionKey!.readScope();
          lines.push(
            `initialized      ${scope.initialized}`,
            `scope owner      ${scope.owner}`,
            `scope key        ${scope.sessionKey}`,
            `expires          ${new Date(Number(scope.expiry) * 1000).toISOString()}`,
            `per tx cap       ${scope.perTxCap} wei`,
            `per epoch cap    ${scope.perEpochCap} wei over ${scope.epochLength}s`,
            `epoch spent      ${scope.epochSpent} wei since ${scope.epochStart}`,
          );
          if (scope.initialized && sessionAccount && scope.sessionKey.toLowerCase() !== sessionAccount.address.toLowerCase()) {
            lines.push(
              "MISMATCH         the installed scope names a different session key than this server " +
                "holds, so every execute would revert with NotSessionKey",
            );
          }
        }

        lines.push("", "tools", describeSurface(lane, withheld));
        return text(lines.join("\n"));
      }),
  );
}

if (registered("untoll_pool_status")) {
  server.registerTool(
    "untoll_pool_status",
    {
      title: "Pool status",
      description:
        "Phase, curve progress, creator, current epoch, and what is claimable for an address. " +
        "Phase Graduated means the curve is off and the fee splitter is on, permanently.",
      inputSchema: {
        poolId: z.string().describe("The v4 PoolId, 32 bytes of hex."),
        who: z
          .string()
          .optional()
          .describe("Whose claimable rewards to read. Defaults to the agent EOA."),
        epochIndex: z
          .string()
          .optional()
          .describe("Which epoch to read rewards for, as a decimal string. Defaults to the current one."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ poolId, who, epochIndex }) =>
      guard(async () => {
        const id = requirePoolId(poolId);
        const subject = who ? requireAddressArg(who, "who") : agentAddress;
        const [phase, progress, creator, current] = await Promise.all([
          untoll.phaseOf(id),
          untoll.progressOf(id),
          untoll.creatorOf(id),
          untoll.currentEpoch(id),
        ]);

        /*
         * A pool the hook has never seen reads as every field's zero value, and Phase 0 is
         * Bonding. So the honest-looking answer for a wrong PoolId is "Bonding, no creator, zero
         * progress", which is a state, not an absence, and a model will act on it. An unset
         * mapping is not a launch: say so instead of reporting a phase.
         */
        if (creator === zeroAddress) {
          return failure(
            [
              `pool             ${id}`,
              "not a pool this hook knows: it has no creator, so it was never launched through",
              `${addresses.launchHook} on chain ${chain.id}. Every other field would read as its`,
              "zero value, and phase 0 is Bonding, so this is reported as absent rather than as a",
              "state. Check the PoolId and the chain.",
            ].join("\n"),
          );
        }
        const epoch = epochIndex !== undefined ? BigInt(epochIndex) : BigInt(current);
        const [claimable, creatorFee] = await Promise.all([
          subject ? untoll.claimableRewards(id, subject, epoch) : Promise.resolve(0n),
          untoll.claimableCreatorFee(id),
        ]);
        return text(
          [
            `pool             ${id}`,
            `phase            ${PHASE_NAME[phase] ?? phase}`,
            `progress         ${progress}`,
            `creator          ${creator}`,
            `current epoch    ${current}`,
            `claimable        ${claimable} wei for ${subject ?? "nobody, no address given"} at epoch ${epoch}`,
            `creator fee      ${creatorFee} wei claimable`,
          ].join("\n"),
        );
      }),
  );
}

if (registered("untoll_check_call")) {
  server.registerTool(
    "untoll_check_call",
    {
      title: "Check a call against the scope",
      description:
        "Ask the chain whether a call would be allowed, changing nothing. This runs the same logic " +
        "that enforces the boundary, against the same state, so a refusal here is the refusal you " +
        "would get. Use it before anything you are unsure of: it costs a read instead of a " +
        "reverted transaction, and it returns a reason you can act on.",
      inputSchema: {
        target: z.string().describe("The contract the call would go to."),
        data: z.string().describe("The calldata, 0x-prefixed, selector included."),
        valueWei: z.string().optional().describe("Native value in wei as a decimal string. Defaults to 0."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ target, data, valueWei }) =>
      guard(async () => {
        if (!isHex(data)) throw new Error(`data must be 0x-prefixed hex, got: ${data}`);
        const call: Call = {
          target: requireAddressArg(target, "target"),
          data,
          value: valueWei ? BigInt(valueWei) : 0n,
        };
        const gap = await delegationGap();
        if (gap) return failure(gap);
        const result = await sessionKey!.probe(call);
        return text(
          [
            `verdict          ${result.ok ? "in scope" : "refused"}`,
            `reason           ${result.reason}`,
            `meaning          ${explainReason[result.reason]}`,
            `tag              ${result.tag}`,
          ].join("\n"),
        );
      }),
  );
}

// -- agent lane -------------------------------------------------------------------------------

if (registered("untoll_settle")) {
  server.registerTool(
    "untoll_settle",
    {
      title: "Settle what a pool owes",
      description:
        "Claim through the hook, routed through the session key so the installed scope decides. " +
        "Claims are pull-based and pay the caller, so there is no destination argument to point " +
        "anywhere. The call is probed first and dropped with a reason if it is out of scope.",
      inputSchema: {
        poolId: z.string().describe("The v4 PoolId, 32 bytes of hex."),
        action: z
          .enum(["rewards", "rewards_range", "creator_fee"])
          .describe("Which claim: one epoch of rewards, a range of epochs, or the creator fee."),
        epochIndex: z.string().optional().describe("For 'rewards'. Defaults to the current epoch."),
        fromEpoch: z.string().optional().describe("For 'rewards_range', inclusive."),
        toEpoch: z.string().optional().describe("For 'rewards_range', inclusive."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ poolId, action, epochIndex, fromEpoch, toEpoch }) =>
      guard(async () => {
        const id = requirePoolId(poolId);
        let call: Call;
        if (action === "rewards") {
          const epoch = epochIndex !== undefined ? BigInt(epochIndex) : BigInt(await untoll.currentEpoch(id));
          call = untoll.claimRewardsCall(id, epoch);
        } else if (action === "rewards_range") {
          if (fromEpoch === undefined || toEpoch === undefined) {
            throw new Error("rewards_range needs both fromEpoch and toEpoch");
          }
          call = untoll.claimRewardsRangeCall(id, BigInt(fromEpoch), BigInt(toEpoch));
        } else {
          call = untoll.claimCreatorFeeCall(id);
        }

        const gap = await delegationGap();
        if (gap) return failure(gap);

        const probe = await sessionKey!.probe(call);
        if (!probe.ok) {
          return failure(
            [
              `refused          ${probe.reason}`,
              `meaning          ${explainReason[probe.reason]}`,
              `target           ${call.target}`,
              "",
              "The scope refused this before it was sent, so nothing moved. Widening the scope is " +
                "owner-gated on chain and is not something this server can do from the agent lane.",
            ].join("\n"),
          );
        }

        const hash = await sessionKey!.execute(sessionWallet!, call);
        return text(
          [`settled          ${action}`, `pool             ${id}`, `transaction      ${hash}`].join("\n"),
        );
      }),
  );
}

// -- owner lane -------------------------------------------------------------------------------

if (registered("untoll_mint_scoped_key")) {
  server.registerTool(
    "untoll_mint_scoped_key",
    {
      title: "Mint a scoped session key",
      description:
        "Install a named on-disk policy as the agent EOA's scope: attach the EIP-7702 delegate if " +
        "it is not attached, then initialize. Takes a policy NAME and nothing else about the " +
        "boundary, because a scope authored by the party it constrains is not a boundary. Call it " +
        "without confirm to get the plan, the rendered scope, and any unconstrained destination it " +
        "would leave open. Installing is once-only per EOA and cannot be undone or edited.",
      inputSchema: {
        policy: z
          .string()
          .describe(`Which named policy to install. Available: ${listPolicyNames().join(", ")}.`),
        sessionKeyAddress: z
          .string()
          .optional()
          .describe("The key that will act under the scope. Defaults to the loaded session key."),
        confirm: z
          .boolean()
          .optional()
          .describe("False or absent returns the plan and sends nothing. True installs it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ policy, sessionKeyAddress, confirm }) =>
      guard(async () => {
        const agent = agentAddress!;
        const subject = sessionKeyAddress
          ? requireAddressArg(sessionKeyAddress, "sessionKeyAddress")
          : sessionAccount?.address;
        if (!subject) {
          throw new Error(
            "no session key to scope: pass sessionKeyAddress, or set UNTOLL_SESSION_KEY. The " +
              "server will not mint a scope naming the owner as its own session key, which would " +
              "constrain nothing.",
          );
        }
        if (!implementation) {
          throw new Error(
            "no delegate implementation: set UNTOLL_DELEGATE_IMPL. The SessionKeyDelegate is not " +
              "among the contracts deployed at chain 46630, so its address is yours to supply.",
          );
        }

        const now = (await reader.getBlock()).timestamp;
        let resolution;
        try {
          resolution = loadPolicy(policy, { owner: agent, sessionKey: subject, addresses, now, extras });
        } catch (error) {
          if (error instanceof PolicyError) return failure(error.message);
          throw error;
        }

        const existing = await sessionKey!.readScope().catch(() => undefined);
        if (existing?.initialized) {
          return failure(
            [
              `${agent} already carries an installed scope, and initialize is once-only on chain,`,
              "so this would revert with AlreadyInitialized.",
              "",
              `owner            ${existing.owner}`,
              `session key      ${existing.sessionKey}`,
              `expires          ${new Date(Number(existing.expiry) * 1000).toISOString()}`,
              "",
              "A scope cannot be edited or replaced. Revoking detaches the delegate but leaves this",
              "storage in place, so re-attaching restores the same scope. A different boundary means",
              "a different agent EOA. Treat an agent account as single-use.",
            ].join("\n"),
          );
        }

        const refusal = refusalFor(resolution);
        if (refusal) return failure(refusal);

        const scope = buildScope(resolution.policy);
        const plan = [
          `policy           ${resolution.file.name}`,
          `                 ${resolution.file.summary}`,
          "",
          describeScope(scope),
          "",
          `delegate         ${implementation}`,
          `transactions     ${(await sessionKey!.isDelegatedTo(implementation)) ? "1 (already delegated, initialize only)" : "2 (delegate, then initialize)"}`,
        ];
        if (resolution.advisories.length > 0) {
          plan.push(
            "",
            "the delegate does not check these",
            ...resolution.advisories.map((a) => `  ${a.signature} ${a.note}`),
          );
        }

        if (!confirm) {
          plan.push(
            "",
            "Nothing was sent. Call again with confirm: true to install this. Installing is",
            "once-only for this EOA and cannot be edited afterwards.",
          );
          return text(plan.join("\n"));
        }

        if (!(await sessionKey!.isDelegatedTo(implementation))) {
          const hash = await sessionKey!.delegate({ owner: ownerWallet!, implementation });
          plan.push("", `delegated        ${hash}`);
        }
        const installHash = await sessionKey!.installScope(ownerWallet!, scope);
        plan.push(`installed        ${installHash}`);
        return text(plan.join("\n"));
      }),
  );
}

if (registered("untoll_revoke_key")) {
  server.registerTool(
    "untoll_revoke_key",
    {
      title: "Revoke the delegation",
      description:
        "Stop the session key from being able to act, by signing an EIP-7702 authorization to the " +
        "zero address so the agent EOA carries no delegate code. There is no revoke function on " +
        "the delegate: detaching the code is the revocation, and it is the owner's signature that " +
        "does it. Call without confirm to see exactly what it does and does not undo.",
      inputSchema: {
        confirm: z
          .boolean()
          .optional()
          .describe("False or absent explains and sends nothing. True signs and sends."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ confirm }) =>
      guard(async () => {
        const agent = agentAddress!;
        const code = (await reader.getCode({ address: agent })) ?? "0x";
        const delegated = code.toLowerCase().startsWith("0xef0100");

        const explanation = [
          `agent EOA        ${agent}`,
          `delegated        ${delegated ? `yes, to 0x${code.slice(8, 48)}` : "no, there is nothing attached"}`,
          "",
          "What this does: signs an EIP-7702 authorization to the zero address with the owner key",
          "and sends it, which clears the delegation designator. After it lands the EOA has no code,",
          "so execute() is not callable and the session key can do nothing with this account.",
          "",
          "What it does not do: the scope lives in the EOA's own storage and stays there. Attaching",
          "the same delegate again restores the same scope, and initialize stays once-only, so this",
          "account can never be given a different boundary. A new boundary means a new EOA.",
          "",
          "The other stop is time: the scope carries a hard expiry, and after it passes every call",
          "returns EXPIRED with no transaction from anyone.",
        ];

        if (!confirm) {
          explanation.push("", "Nothing was sent. Call again with confirm: true to revoke.");
          return text(explanation.join("\n"));
        }
        if (!delegated) {
          explanation.push("", "Nothing to revoke: the EOA already carries no delegate code.");
          return text(explanation.join("\n"));
        }

        const owner = ownerWallet!;
        const authorization = await owner.signAuthorization({
          account: owner.account,
          address: zeroAddress,
          executor: "self",
        });
        const hash = await owner.sendTransaction({
          account: owner.account,
          chain: owner.chain,
          to: agent,
          data: "0x",
          authorizationList: [authorization],
        });
        await reader.waitForTransactionReceipt({ hash });

        const after = (await reader.getCode({ address: agent })) ?? "0x";
        if (after !== "0x") {
          return failure(
            `the revocation did not take: code at ${agent} is still ${after}. Treat the session ` +
              "key as live and move the funds rather than retrying.",
          );
        }
        explanation.push("", `revoked          ${hash}`, "read back        code is 0x, nothing attached");
        return text(explanation.join("\n"));
      }),
  );
}

// ---------------------------------------------------------------------------------------------

note("");
note("  UNTOLL MCP server");
note(`  chain           ${chain.id} at ${chain.rpcUrls.default.http[0]}`);
note(`  lane            ${lane}`);
note(`  agent EOA       ${agentAddress ?? "not set"}`);
note(`  policies        ${listPolicyNames().join(", ") || "none"}`);
note("");
note(describeSurface(lane, withheld));
note("");

await server.connect(new StdioServerTransport());

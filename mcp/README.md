# The UNTOLL MCP server

Point an MCP client at UNTOLL: read a launch's state, settle what a pool owes, and manage an
EIP-7702 session key whose authority is bounded by contract bytecode rather than by the model's
judgement.

It runs on the same SDK as the rest of this repo, so there is one set of ABIs, one deploy record,
and one scope encoder. Nothing here is a second copy of anything.

## The design rule, before the install instructions

An MCP server is the easiest place to lose the containment.

The argument this repo makes is that an agent's key is not its authority, because the scope lives
in bytecode the model cannot widen. Expose a tool called `mint_scoped_key` that takes targets,
selectors, caps and an expiry as arguments, and the model writes its own boundary. Every contract
test still passes. The containment is gone, and it left through the integration.

So the tool surface is itself a scope, in the same shape as `agent/policy.ts`:

**`mcp/lanes.ts` is the one screen a human reads to know everything a connected model can reach.**

Three lanes, set by the operator in the client's config, never by anything the model can say:

| Lane | What is registered |
|---|---|
| `read` | `untoll_scope_status`, `untoll_pool_status`, `untoll_check_call`. No key is loaded. |
| `agent` | the reads, plus `untoll_settle` through the session key and its installed scope. |
| `owner` | everything, plus `untoll_mint_scoped_key` and `untoll_revoke_key`. The owner key signs here. |

Lanes nest, and they never resolve upward: an unset `UNTOLL_MCP_MODE` is `read`, a value the server
does not recognise is a refusal rather than a guess, and **an owner key present in the environment
does not open the owner lane.** A tool outside the running lane is not registered at all, so it is
absent from `tools/list` rather than present and refusing. A model cannot be talked into calling a
tool it cannot see.

That last one is a refusal in this process, not a guarantee about the host. A key readable by this
process is readable by anything that can read this process, so the real advice is to keep the owner
key off the agent host and open the owner lane in a separate, human-driven session.

And the mint tool takes a policy **name**. It has no parameter for a target, a selector, a cap, or
an expiry, because a scope authored by the party it constrains is not a boundary. The gate is the
tool's input schema, and `npm run check` asserts it both in the source and in the schema the server
actually publishes over the wire.

## Install

```
npm install
npm run check
```

`npm run check` is a typecheck plus 27 offline assertions in two layers: 22 that prove the lane
rules and the mint gate hold as functions, and 5 that boot the real server in a child process,
speak real MCP to it, and assert on the tool list and the mint schema it publishes. No node, no
keys, no network.

Node 22 or newer. TypeScript runs directly through Node's type stripping, so there is no build step.

## Wiring it into a client

Read-only, which is where to start:

```json
{
  "mcpServers": {
    "untoll": {
      "command": "node",
      "args": ["--experimental-strip-types", "/abs/path/to/untoll-agent-starter/mcp/server.ts"],
      "env": {
        "UNTOLL_MCP_MODE": "read",
        "UNTOLL_AGENT_ADDRESS": "0x..."
      }
    }
  }
}
```

Acting, once a scope is installed:

```json
{
  "env": {
    "UNTOLL_MCP_MODE": "agent",
    "UNTOLL_AGENT_ADDRESS": "0x...",
    "UNTOLL_SESSION_KEY": "0x..."
  }
}
```

| Variable | What it is |
|---|---|
| `UNTOLL_MCP_MODE` | `read`, `agent`, or `owner`. Absent means `read`. |
| `UNTOLL_AGENT_ADDRESS` | The agent's own EOA. Under 7702 the delegate's code runs here. Derived from the owner key in the owner lane. |
| `UNTOLL_SESSION_KEY` | The only key the agent lane transacts with. |
| `UNTOLL_OWNER_KEY` | Owner lane only. Signs the delegation and installs the scope. |
| `UNTOLL_DELEGATE_IMPL` | The `SessionKeyDelegate` on your chain. It is not among the contracts deployed at 46630, so this is yours to supply. |
| `UNTOLL_ROUTER` | Resolves `@router` in a policy file. |
| `UNTOLL_RPC` | Defaults to Robinhood Chain testnet 46630. EIP-7702 needs a chain at Prague or later. |

Every UNTOLL contract address is env-overridable the same way the SDK does it; see `src/config.ts`.

Protocol note that costs an hour if you miss it: stdio carries the JSON-RPC framing, so everything
the server prints for a human goes to stderr. The startup banner, including the surface report, is
in your client's server log.

## The tools

**`untoll_scope_status`** reads the delegation designator and the installed scope back off the
agent EOA, and reports the server's own surface with a reason for every tool that is absent. It
remembers nothing: every field is read at call time. It also flags the case where the installed
scope names a different session key than the server holds, which otherwise shows up as every
transaction reverting with `NotSessionKey`.

**`untoll_pool_status`** is phase, curve progress, creator, current epoch, and what is claimable.
`Graduated` means the curve is off and the fee splitter is on, permanently. A PoolId the hook has
never seen reads as every field's zero value, and phase 0 is `Bonding`, so a wrong PoolId would
otherwise answer with a plausible state a model will act on. It is reported as absent instead.

**`untoll_check_call`** probes an intended call against the installed scope and changes nothing. It
runs the same logic that enforces the boundary, against the same state, so a refusal here is the
refusal you would get. This is the tool worth telling a model to reach for: it turns the boundary
into something the model can consult rather than something it discovers by failing. An agent EOA
with no delegate attached is named as exactly that, rather than as a call that returned no data.

**`untoll_settle`** claims through the hook, routed through the session key. Probed first and
dropped with a decoded reason if it is out of scope. Claims are pull-based and pay the caller, so
there is no destination argument to point anywhere, which is why the claim-only policy needs no
recipient constraint to be safe.

**`untoll_mint_scoped_key`** installs a named policy: attach the delegate if it is not attached,
then initialize. Without `confirm` it returns the plan, the rendered scope, and any unconstrained
destination it would leave open, and sends nothing.

**`untoll_revoke_key`** is the one to read carefully, below.

## Policies

`mcp/policies/*.json`. A file is named by a person and picked by name.

```json
{
  "name": "claim-only",
  "summary": "Settle what a pool owes, and do nothing else.",
  "targets": ["@launchHook"],
  "calls": [{ "signature": "claimRewards(bytes32,uint256)" }],
  "recipients": ["@owner"],
  "perTxCapWei": "0",
  "perEpochCapWei": "0",
  "epochLengthSeconds": "3600",
  "expiresInSeconds": "86400",
  "allowUnconstrainedRecipients": false
}
```

Contracts are named rather than pasted (`@launchHook`, `@tokenFactory`, `@owner`, `@sessionKey`,
`@router`, or a literal address), so a policy is portable across a fork, a redeploy and the
testnet. A name that does not resolve is a refusal, never a scope installed against the zero
address. Wei values are strings, because a cap large enough to matter does not survive a JSON
number.

Two ship. `claim-only` is the whole argument in one file: one target, three pull-based claims, zero
value caps, because an agent that only claims never needs to spend. `trade-through-router` is the
case that needs care, and it will not load until you set `UNTOLL_ROUTER` and check the signature
against your actual router.

### What the mint refuses, and what it only reports

It **refuses** a policy with an allowed call that constrains no destination at all while taking an
address argument. That is the hole a target allowlist and a selector allowlist leave open together:
an allowed function on an allowed contract with its output pointed at the attacker satisfies both.
Set `recipientArg`, or, if the call genuinely moves nothing to an address it takes as an argument,
put `"allowUnconstrainedRecipients": true` in the file, where it is reviewed.

It **reports and installs anyway** when a call constrains one address and takes another. That is a
limit of the contract rather than a mistake in the policy: `recipientArgIndex` holds one argument
index per selector, so `swap(address,address,uint256,address)` with `recipientArg: 4` leaves
arguments 1 and 2 unexamined. Refusing would make most real routers unmintable, which is a bounce
rather than a boundary. The plan says which addresses the delegate does not check, so the operator
gets the true shape of it instead of a clean-looking one.

## Revoking, and the three things about it that surprise people

There is no revoke function on `SessionKeyDelegate`. The scope is written once and has no setter.
So `untoll_revoke_key` signs an EIP-7702 authorization to the zero address with the owner key,
which clears the delegation designator. After it lands the EOA carries no code, `execute` is not
callable, and the session key can do nothing with that account. The tool reads the code back and
says so if it did not take.

1. **It detaches, it does not erase.** The scope lives in the EOA's own storage and stays there.
   Attaching the same delegate again restores the same scope.
2. **An agent EOA is single-use.** `initialize` is once-only, so that account can never be given a
   different boundary. A new boundary means a new EOA, and the mint tool refuses rather than
   sending a transaction that would revert with `AlreadyInitialized`.
3. **Time is the other stop.** The scope carries a hard expiry, after which every call returns
   `EXPIRED` without a transaction from anyone. Set `expiresInSeconds` to something you would be
   comfortable with if the revoke never happened.

## Layout

```
mcp/lanes.ts             the tool surface, as a scope. read this first
mcp/policies.ts          named policies, name resolution, and the mint gate
mcp/policies/*.json      the policies themselves
mcp/server.ts            the tools
scripts/mcp-selftest.ts  the lane rules and the mint gate, as functions
scripts/mcp-smoke.ts     the real server, over a real client
```

## What is deployed, and what is not

The five UNTOLL contracts are deployed and source-verified on Blockscout at Robinhood Chain testnet
46630, and their addresses are read back with `eth_getCode` after broadcast. Their ABIs are derived
from the Solidity declarations in the hook repo, so custom error selectors and the surface
`LaunchHook` inherits from `BaseCustomCurve` are absent by construction.

`SessionKeyDelegate` is not among them. Its ABI is compiled output and its creation bytecode ships
in `src/generated/delegate-bytecode.ts` with a sha256 to compare against your own build. The
implementation is yours to deploy: set `UNTOLL_DELEGATE_IMPL`.

MIT.

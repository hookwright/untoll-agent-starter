# untoll-agent-starter

Fork this to run an autonomous agent on UNTOLL with a key whose authority is bounded by contract
bytecode instead of by the model's judgement.

Two things ship here. A **typed SDK** over the UNTOLL contracts and the EIP-7702 session-key
delegate, generated from the deployed ABIs rather than transcribed. And a **reference agent**: a
short loop you are meant to read in one sitting, replace the brain of, and keep the shape of.

The shape is the product. Everything the agent may ever do is one file a human reads
(`agent/policy.ts`). Everything the model proposes goes through the same gate before it becomes a
transaction. Swap the brain for a hosted model, a rules engine, or a coin flip and the boundary does
not move.

## Why the key is not the authority

Hand an agent a private key and the key IS the authority. A prompt-injected model signs whatever it
was talked into, and nothing downstream can tell that transaction from an honest one.

Under EIP-7702 the agent's own EOA runs delegate code, and the scope lives in that account's
storage: allowed targets, allowed selectors, per-transaction and per-epoch value caps, an expiry,
and a per-selector recipient policy. The owner writes it once. The agent holds a session key that
can act inside the scope and cannot widen it, because widening is owner-gated on chain.

The part people miss is the recipient policy. A target allowlist plus a selector allowlist still
lets a jailbroken model call an allowed function on an allowed contract and point the output at
itself. Both allowlists are satisfied. `recipientArg` names which argument carries the destination,
and the delegate checks it against the recipient allowlist on every call.

That gap is invisible in the flat tuple the contract takes, so this SDK looks for it:

```ts
reviewScope(policy)
// [{ signature: "swap(address,address,uint256,address)",
//    note: "takes an address at argument 1 and 2 and 4 and declares no recipientArg, so the
//           session key may point that address anywhere, including at itself" }]
```

The reference agent refuses to start on a warning unless you pass
`allowUnconstrainedRecipients`. Starting anyway should be something someone typed.

## Install

```
npm install
npm run check
```

`npm run check` is a typecheck plus 115 offline assertions: no node, no keys, no network. Fifty-eight
cover the SDK, the scope encoder, the rules that reject a scope that cannot do what its author
meant, the violation-tag table, and the calldata for every routed call. The tags and selectors it
compares against were computed by a separate keccak implementation, so the check is
cross-implementation rather than circular. Seventeen cover the onboarding order below, each one
carrying its own negative control. Thirteen cover the Privy adapter. The rest cover the MCP server:
twenty-two on the lane rules and the mint gate, and five that boot the real server in a child
process and assert on the tool list it publishes.

Node 22 or newer. The starter runs its TypeScript directly through Node's type stripping, so there
is no build step and no bundler.

## From nothing to a contained agent

```
npm run onboard
```

One command, and it stops exactly once. It generates an owner key and a session key, deploys the
`SessionKeyDelegate` from the creation bytecode in this repo, attaches it to the agent EOA under
EIP-7702 and reads the code back, installs the claim-only scope from `agent/policy.ts`, and then
proves the containment rather than claiming it: one call the scope allows, one it does not, with the
refused one broadcast through `tryExecute` so the refusal is mined as a `ScopeViolation`. You finish
holding a transaction hash for the moment your agent was told no.

The one halt is funding, because a faucet is a person or a captcha. The run prints the address, the
shortfall and the resume, exits 75 rather than 1 (75 means waiting on somebody, 1 means broken), and
picks up where it stopped when you run it again. Every step is measured against the chain before it
is attempted, so a second run repeats nothing.

Everything it writes goes to `.env.local`, which is gitignored. Point it somewhere else with
`UNTOLL_RPC` and `UNTOLL_CHAIN_ID`; the environment wins over the file, so an export is never
silently overridden by a stale run.

## The SDK

```ts
import {
  SessionKey, Untoll, buildScope, reviewScope, resolveChain, resolveAddresses,
} from "untoll-agent-starter/src/index.ts";
```

| Piece | What it does |
|---|---|
| `resolveChain()` / `resolveAddresses()` | Where you are pointing. Every address is an env override over the generated deploy record, so a fork or a redeploy costs no code change. |
| `buildScope(policy)` | Renders the on-chain tuple from a policy that reads like a sentence, and refuses eleven ways of writing one that cannot mean what it says. |
| `reviewScope(policy)` | Finds allowed calls whose destination argument nobody constrained. |
| `SessionKey` | The 7702 lane: `delegate`, `installScope`, `probe`, `execute`, `tryExecute`, `readScope`. |
| `Untoll` | The contracts: phase, curve progress, claimable rewards, plus every write as a routable `{target, data}`. |

Three details worth knowing before you build on it.

**`delegate()` reads the code back.** A chain below the Prague hardfork mines an authorization
transaction and writes nothing, which looks exactly like success and leaves an agent running with
an unbounded key. The SDK checks for the `0xef0100` designator and throws when it is absent.

**`probe()` is the same logic `execute()` enforces.** It is a read, so an out-of-scope intent costs
a call to a node instead of a reverted transaction, and the agent gets a reason it can act on. The
containment does not depend on it: delete every probe and a breach still reverts.

**`tryExecute()` mines a `ScopeViolation` instead of reverting.** Use it when the trace is the
point. The log outlives the process that produced it, which is what you want when the question
later is what the model reached for.

## The reference agent

```
UNTOLL_OWNER_KEY=0x...      # installs the scope, holds funds, stays off the agent host
UNTOLL_SESSION_KEY=0x...    # the only key the process transacts with
UNTOLL_DELEGATE_IMPL=0x...  # the SessionKeyDelegate on your chain
UNTOLL_POOL_ID=0x...        # the pool this agent settles for
npm run agent
```

`npm run onboard` writes the first three of those into `.env.local` for you. The pool is the one it
cannot supply, because which pool an agent settles for is a choice rather than a lookup.

It reads the chain, proposes a claim when a pool owes one, probes it, and settles it. Every
proposal takes the same path:

```
brain proposes  ->  probe against the installed scope  ->  in scope, act  /  out of scope, log and drop
```

The claim-only policy in `agent/policy.ts` is worth reading closely, because it is the whole
argument in fifteen lines. One target. Three pull-based claims that pay the caller and take no
address argument, so there is no output to redirect. Value caps of zero, because an agent that only
claims never needs to spend. A model talked into moving the treasury reaches for a target that is
not on the list and stops there.

`agent/policy.ts` also carries a trading policy as a worked example of the case that needs care: the
moment a router is on the allowlist, `recipientArg` is what stands between an allowed swap and a
redirected one.

## The MCP server

`npm run mcp` serves the same SDK to an MCP client, so a desktop assistant, an IDE, or an agent
framework can read a launch, settle what a pool owes, and mint or revoke a scoped key. Full notes
in `mcp/README.md`.

It is worth reading even if you never run it, because an MCP server is the easiest place to lose
the containment. A tool that lets the connected model author its own scope makes the boundary
advisory again, with every contract test still passing. So the tool surface is itself a scope:
three lanes set by the operator in the client's config, never by anything the model can say, and a
mint tool that takes a policy NAME with no parameter for a target, a selector, a cap, or an expiry.
`mcp/lanes.ts` is the one screen that holds all of it, the same way `agent/policy.ts` does for the
agent.

## Where the addresses come from

`src/generated/` is machine-rendered and should not be hand-edited.

The UNTOLL addresses are the five contracts deployed and source-verified on Blockscout at Robinhood
Chain testnet 46630, read back with `eth_getCode` after broadcast. Their ABIs are derived from the
Solidity declarations in the hook repo, which means custom error selectors and the surface
`LaunchHook` inherits from `BaseCustomCurve` are absent by construction: bring the compiled ABI when
you need to decode a hook revert reason.

`SessionKeyDelegate` is different. Its ABI is compiled output, so its errors carry real selectors,
and its creation bytecode ships in `src/generated/delegate-bytecode.ts` with a sha256 you can
compare against your own build. The delegate implementation is yours to deploy: put its address in
`UNTOLL_DELEGATE_IMPL`, or call `SessionKey.deployImplementation()` on a local chain.

## The trade path

The curve IS the pool. A bonding buy or sell is a Uniswap v4 swap carrying the PoolKey, routed
through a v4 swap router, not a function on the hook. So `buildSwapIntent()` returns the intent and
stops there: hand it to whichever router you use, and put that router on the scope with its
recipient argument set. This SDK builds what it can encode and says where the edge is.

## AgentAccount mode

The plain-transaction twin of the 7702 lane. The owner deploys an `AgentAccount` with an ordinary type-2
transaction (no EIP-7702 authorization) and issues session keys from it. A key's scope is a list of rules,
each a target, a selector and optionally pinned calldata words, plus a key config: expiry, epoch length,
calls per epoch, per-transaction cap, per-epoch cap, lifetime cap and a burst cap. The owner can revoke
one key, revoke all keys, pause the account, and withdraw. The SDK exports the builders
(`buildLaunchKey`, `buildBuyKey`, `issueKeyCall`) from `src/agentAccount.ts`, and `npm run
agent-account-selftest` checks them against the contract layout.

## Scope model

Two lanes, one idea. The agent holds a session key; the authority is a scope the owner writes into a
contract: which targets, which selectors, which calldata words, how much value per transaction, per
epoch and in total, and until when. `agent/policy.ts` is the one file that states it, `buildScope`
renders it, and the contract enforces it at settlement. The model proposes; it cannot widen the scope.

## Status

- Proven: `npm run check` (typecheck, SDK, onboarding, Privy adapter, MCP and AgentAccount self-tests),
  plus the AgentAccount fork proof in `scripts/agent-account-proof.ts`.
- Local anvil fork (chain id set by PROOF_CHAIN_ID): through AgentAccount, an agent launched a token with its crew
  pinned and bought through a capped key, and ten out-of-scope attempts were mined and refused,
  all with ordinary type 2 transactions (`scripts/agent-account-mined-refusals.ts`).
- Testnet: the addresses under Where the addresses come from are Robinhood Chain testnet.
- Mainnet: this starter moves to mainnet once the UNTOLL contracts deploy there.

## Layout

```
src/config.ts       chain and addresses, env-overridable
src/scope.ts        the policy language, the encoder, the review
src/session.ts      the EIP-7702 lane
src/untoll.ts       the UNTOLL contracts, as reads and as routable calls
src/generated/      machine-rendered ABIs, addresses, delegate bytecode
agent/policy.ts     what the agent may do. the file a human reviews
agent/agent.ts      arm, then propose -> probe -> act
agent/run.ts        wiring and entry point
mcp/                the MCP server. lanes.ts is what the agent's policy.ts is
scripts/selftest.ts the offline gate
```

MIT.

/**
 * The tool surface is itself a scope.
 *
 * This file is to the MCP server what `agent/policy.ts` is to the reference agent: the one screen
 * a human reads to know everything the connected model can reach. Same habit, same reason. If a
 * new capability needs a new tool, it belongs here, where the review happens.
 *
 * The failure this exists to prevent is specific, and it is the one an MCP server invites. UNTOLL's
 * whole argument is that an agent's key is not its authority, because the scope is bytecode the
 * model cannot widen. Hand that same model a tool called `mint_scoped_key` that takes targets,
 * selectors and caps as arguments, and the model writes its own scope. The containment is gone,
 * and it is gone through the integration rather than through the contract.
 *
 * So the surface is split into three lanes, and the lane is set by the operator at launch, in the
 * client's config, not by anything the model can say:
 *
 *   read    reads and the probe. No key is loaded, nothing can move.
 *   agent   read, plus settling what a pool owes, through the session key and its installed scope.
 *   owner   agent, plus minting a scope and revoking a delegation. The owner key signs here.
 *
 * Lanes nest: owner contains agent contains read. A tool outside the running lane is not
 * registered at all, so it is absent from `tools/list` rather than present and refusing. A model
 * cannot be talked into calling a tool it cannot see.
 */

export type Lane = "read" | "agent" | "owner";

export const LANES: readonly Lane[] = ["read", "agent", "owner"] as const;

const RANK: Record<Lane, number> = { read: 0, agent: 1, owner: 2 };

/** Lanes nest: a server in `owner` runs every tool, a server in `read` runs only the reads. */
export const laneAllows = (running: Lane, required: Lane): boolean => RANK[running] >= RANK[required];

export type ToolSpec = {
  id: string;
  lane: Lane;
  /** True when the tool can send a transaction. Drives the MCP destructive-hint annotation. */
  mutates: boolean;
  /** What it does, in one line, for the surface report. */
  oneLine: string;
};

/**
 * Every tool this server can register. Six, and the count is a feature: a surface a person can
 * hold in their head is a surface a person can review.
 */
export const SURFACE: readonly ToolSpec[] = [
  {
    id: "untoll_scope_status",
    lane: "read",
    mutates: false,
    oneLine: "read the delegation and the installed scope back off the agent EOA",
  },
  {
    id: "untoll_pool_status",
    lane: "read",
    mutates: false,
    oneLine: "phase, curve progress, creator and what a pool currently owes",
  },
  {
    id: "untoll_check_call",
    lane: "read",
    mutates: false,
    oneLine: "probe an intended call against the installed scope, changing nothing",
  },
  {
    id: "untoll_settle",
    lane: "agent",
    mutates: true,
    oneLine: "claim what a pool owes, routed through the session key, probed first",
  },
  {
    id: "untoll_mint_scoped_key",
    lane: "owner",
    mutates: true,
    oneLine: "install a named on-disk policy as an agent EOA's scope",
  },
  {
    id: "untoll_revoke_key",
    lane: "owner",
    mutates: true,
    oneLine: "detach the delegate from the agent EOA, so the session key stops being able to act",
  },
] as const;

export class LaneError extends Error {}

/**
 * The running lane, from the environment, and the rule that matters: possession of a key never
 * escalates a lane.
 *
 * `UNTOLL_MCP_MODE` is the only thing that opens the owner lane. An owner key sitting in the
 * environment of a server running in `agent` is not loaded and is not signed with. That is a
 * refusal in this process, not a guarantee about the host: a key readable by the process is
 * readable by anything that can read the process, so the actual advice is to keep the owner key
 * off the agent host entirely and open the owner lane in a separate, human-driven session.
 */
export function resolveLane(env: Record<string, string | undefined>): Lane {
  const raw = env["UNTOLL_MCP_MODE"]?.trim().toLowerCase();
  if (!raw) return "read";
  if (!LANES.includes(raw as Lane)) {
    throw new LaneError(
      `UNTOLL_MCP_MODE is "${raw}", which is not one of ${LANES.join(", ")}. The server refuses to ` +
        "guess a lane, because guessing upward is the whole failure mode.",
    );
  }
  return raw as Lane;
}

export type SurfaceEntry = {
  spec: ToolSpec;
  registered: boolean;
  /** Why a tool in this lane is still absent, e.g. a missing key. Empty when it registered. */
  withheld: string;
};

/**
 * What actually got registered, and for anything that did not, the reason.
 *
 * Reported by `untoll_scope_status` on purpose. A model that can see the shape of its own boundary
 * asks for the right thing instead of retrying the wrong one, and an operator reading a transcript
 * can tell "the tool refused" from "the tool was never there".
 */
export function surfaceReport(lane: Lane, withheld: Record<string, string> = {}): SurfaceEntry[] {
  return SURFACE.map((spec) => {
    const reason = laneAllows(lane, spec.lane)
      ? (withheld[spec.id] ?? "")
      : `not in the ${lane} lane; needs ${spec.lane}`;
    return { spec, registered: reason === "", withheld: reason };
  });
}

/** The surface as a paragraph, for the startup line on stderr and for the status tool. */
export function describeSurface(lane: Lane, withheld: Record<string, string> = {}): string {
  const rows = surfaceReport(lane, withheld);
  const width = Math.max(...SURFACE.map((s) => s.id.length));
  return rows
    .map((row) => {
      const mark = row.registered ? "on " : "off";
      const tail = row.registered ? row.spec.oneLine : row.withheld;
      return `  ${mark}  ${row.spec.id.padEnd(width)}  ${tail}`;
    })
    .join("\n");
}

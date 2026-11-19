import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * The wiring gate: boot the real server in a child process, speak real MCP to it, and assert on
 * the tool list it publishes.
 *
 * Separate from `mcp-selftest.ts` on purpose. That one proves the lane rules hold as functions;
 * this one proves the server applies them. Both matter, and only this one would catch a lane that
 * is enforced perfectly in `lanes.ts` and then ignored at registration.
 *
 * Still offline: `tools/list` touches no chain, and no lane below owner is booted with a key.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "mcp", "server.ts");
const AGENT = "0x0cd6724019EFBA2ff175fA05a74E43eb0f4aa847";

let checks = 0;

async function toolsIn(env: Record<string, string>): Promise<string[]> {
  const client = new Client({ name: "untoll-smoke", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", SERVER],
    // The child inherits nothing: a stray UNTOLL_* on this host must not decide what the gate sees.
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stderr: "ignore",
  });
  await client.connect(transport);
  const listed = await client.listTools();
  await client.close();
  return listed.tools.map((t) => t.name).sort();
}

const check = async (name: string, fn: () => Promise<void>) => {
  await fn();
  checks++;
  console.log(`  ok   ${name}`);
};

console.log("\n  MCP server, over a real client\n");

await check("the read lane publishes reads only, and no key is needed to get them", async () => {
  const tools = await toolsIn({ UNTOLL_MCP_MODE: "read", UNTOLL_AGENT_ADDRESS: AGENT });
  assert.deepEqual(tools, ["untoll_check_call", "untoll_pool_status", "untoll_scope_status"]);
});

await check("the agent lane without a session key publishes no way to send anything", async () => {
  const tools = await toolsIn({ UNTOLL_MCP_MODE: "agent", UNTOLL_AGENT_ADDRESS: AGENT });
  assert.ok(!tools.includes("untoll_settle"), "settle registered with no session key to send with");
  assert.ok(!tools.includes("untoll_mint_scoped_key"));
});

await check("an owner key in the environment does not open the owner lane", async () => {
  const tools = await toolsIn({
    UNTOLL_MCP_MODE: "agent",
    UNTOLL_AGENT_ADDRESS: AGENT,
    // A funded-looking key is the point: possession must not be the thing that escalates.
    UNTOLL_OWNER_KEY: `0x${"11".repeat(32)}`,
    UNTOLL_SESSION_KEY: `0x${"22".repeat(32)}`,
  });
  assert.ok(tools.includes("untoll_settle"), "the session key should open the agent lane");
  assert.ok(!tools.includes("untoll_mint_scoped_key"), "an owner key alone opened the owner lane");
  assert.ok(!tools.includes("untoll_revoke_key"), "an owner key alone opened the owner lane");
});

await check("the owner lane publishes all six, and derives the agent EOA from the owner key", async () => {
  const tools = await toolsIn({
    UNTOLL_MCP_MODE: "owner",
    UNTOLL_OWNER_KEY: `0x${"11".repeat(32)}`,
    UNTOLL_SESSION_KEY: `0x${"22".repeat(32)}`,
  });
  assert.deepEqual(tools, [
    "untoll_check_call",
    "untoll_mint_scoped_key",
    "untoll_pool_status",
    "untoll_revoke_key",
    "untoll_scope_status",
    "untoll_settle",
  ]);
});

await check("the mint tool's published schema has no field that could widen a scope", async () => {
  const client = new Client({ name: "untoll-smoke", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", SERVER],
    env: {
      PATH: process.env["PATH"] ?? "",
      UNTOLL_MCP_MODE: "owner",
      UNTOLL_OWNER_KEY: `0x${"11".repeat(32)}`,
      UNTOLL_SESSION_KEY: `0x${"22".repeat(32)}`,
    },
    stderr: "ignore",
  });
  await client.connect(transport);
  const listed = await client.listTools();
  await client.close();

  const mint = listed.tools.find((t) => t.name === "untoll_mint_scoped_key");
  assert.ok(mint, "the mint tool is not published");
  const properties = Object.keys(
    (mint.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
  ).sort();
  assert.deepEqual(properties, ["confirm", "policy", "sessionKeyAddress"]);
});

console.log(`\n  ${checks} checks passed\n`);

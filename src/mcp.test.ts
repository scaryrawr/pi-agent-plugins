import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { registerMcpPlugin } from "pi-mcp";
import { it } from "vitest";

it("delegates portable MCP parsing and replayable registration to pi-mcp", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-plugin-mcp-"));
  try {
    await writeFile(
      path.join(root, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "example",
      }),
    );
    await writeFile(
      path.join(root, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          local: {
            type: "stdio",
            command: "node",
            args: ["${PLUGIN_ROOT}/server.js", "${PLUGIN_DATA}/cache"],
          },
          invalid: { type: "stdio", command: "../outside" },
        },
      }),
    );
    const registrations: unknown[] = [];
    const collectors: Array<() => void> = [];
    // SAFETY: registerMcpPlugin uses only the on/emit subset of ExtensionAPI.events.
    const pi = {
      events: {
        on: (_name: string, listener: () => void) => {
          collectors.push(listener);
          return () => {};
        },
        emit: (_name: string, data: unknown) => {
          registrations.push(data);
        },
      },
    } as Parameters<typeof registerMcpPlugin>[0];
    const data = path.join(root, "persistent");
    await registerMcpPlugin(pi, root, data);
    assert.equal(registrations.length, 1);
    assert.equal(collectors.length, 1);
    assert.equal((registrations[0] as { name: string }).name, "example_local");
    await mkdir(data, { recursive: true });
    collectors[0]?.();
    assert.deepEqual(registrations[1], registrations[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

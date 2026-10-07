import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  createAgentSession,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

import agentPlugins from "./index.js";

it("connects portable servers through native MCP, discovers and calls their tools without either legacy extension", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-native-mcp-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const root = path.join(directory, "plugin");
    await mkdir(root);
    await writeFile(path.join(root, "plugin.json"), JSON.stringify({ name: "native.demo" }));
    await writeFile(
      path.join(root, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          peer: {
            type: "stdio",
            command: process.platform === "win32" ? "node.exe" : "node",
            args: ["${PLUGIN_ROOT}/server.cjs"],
            env: { LITERAL: "!not-a-command ${UNSET} $HOME" },
            cwd: "${PLUGIN_DATA}",
          },
        },
      }),
    );
    await writeFile(
      path.join(root, "server.cjs"),
      `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : request.method === 'tools/list'
      ? { tools: [{ name: 'where', description: 'Read native fixture environment', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: JSON.stringify({ cwd: process.cwd(), root: process.env.PLUGIN_ROOT, data: process.env.PLUGIN_DATA, literal: process.env.LITERAL }) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`,
    );
    await writeFile(
      path.join(directory, "pi-agent-plugins.json"),
      JSON.stringify({ plugins: [root] }),
    );
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["+tool_search"] });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [createToolSearchExtension(), createMcpExtension(), agentPlugins],
    });
    await resourceLoader.reload();
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
    });
    cleanup = async () => {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    };
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    let nativeName: string | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      nativeName = session.getAllTools().find((tool) => tool.name.endsWith("__where"))?.name;
      if (nativeName) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(errors).toEqual([]);
    expect(nativeName).toBeDefined();
    expect(session.getActiveToolNames()).not.toContain(nativeName);
    expect(session.getActiveToolNames()).not.toContain("search_tools");
    const search = session.agent.state.tools.find((tool) => tool.name === "tool_search");
    if (!search) throw new Error("Missing native tool_search");
    await search.execute("search", { query: "native fixture environment" });
    expect(session.getActiveToolNames()).toContain(nativeName);
    const tool = session.agent.state.tools.find((item) => item.name === nativeName);
    if (!tool) throw new Error("Missing loaded MCP tool");
    const result = await tool.execute("call", {});
    const content = result.content.find((block) => block.type === "text");
    if (!content || content.type !== "text") throw new Error("Missing MCP text result");
    const values = JSON.parse(content.text) as {
      cwd: string;
      root: string;
      data: string;
      literal: string;
    };
    expect(values.root).toBe(await realpath(root));
    expect(values.cwd).toBe(values.data);
    expect(values.data).toContain("plugin-data");
    expect(values.literal).toBe("!not-a-command ${UNSET} $HOME");

    // A new session must withdraw servers from plugins that have been disabled.
    await writeFile(path.join(directory, "pi-agent-plugins.json"), JSON.stringify({ plugins: [] }));
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    expect(errors).toEqual([]);
    expect(session.getActiveToolNames()).not.toContain(nativeName);
    expect(session.getAllTools().find((item) => item.name === nativeName)?.exposure).toBe("hidden");
  } finally {
    await cleanup?.();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

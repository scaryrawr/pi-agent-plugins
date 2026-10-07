import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { registerPluginMcp } from "./mcp.js";
import { loadPlugin } from "./plugin.js";

const roots: string[] = [];
const schema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

async function fixture(servers: Record<string, unknown>, name = "tools.demo") {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-plugin-mcp-"));
  roots.push(directory);
  const root = path.join(directory, "plugin");
  const data = path.join(directory, "persistent");
  await mkdir(root);
  // The loader accepts omitted manifest schema for marketplace compatibility.
  await writeFile(path.join(root, "plugin.json"), JSON.stringify({ name }));
  await writeFile(
    path.join(root, "mcp.json"),
    JSON.stringify({ $schema: schema, mcpServers: servers }),
  );
  const plugin = await loadPlugin(root);
  const registrations = new Map<string, McpServerConfig>();
  const warnings: string[] = [];
  const pi = {
    registerMcpServer: (key: string, config: McpServerConfig) => {
      registrations.set(key, config);
    },
  };
  const register = () => registerPluginMcp(pi, plugin, data, (message) => warnings.push(message));
  return { root, data, directory, plugin, pi, registrations, warnings, register };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable MCP adapter for Pi's built-in support", () => {
  it("registers native deferred servers, expands paths, and isolates invalid siblings", async () => {
    const f = await fixture({
      local: {
        type: "stdio",
        command: "./server.js",
        args: ["${PLUGIN_ROOT}/config", "${PLUGIN_DATA}/cache", "$HOME"],
        env: { CUSTOM: "${PLUGIN_DATA}/x", LITERAL: "$HOME", COMMAND: "!touch /never-run" },
        cwd: "${PLUGIN_DATA}/work",
      },
      remote: {
        type: "streamable-http",
        url: "https://example.org/mcp",
        headers: { "X-Test": "${PLUGIN_ROOT}", "X-Literal": "!not-a-command" },
      },
      invalid: { type: "stdio", command: "../outside" },
      reserved: { type: "stdio", command: "node", env: { PLUGIN_ROOT: "bad" } },
      legacy: { type: "sse", url: "https://example.org/sse" },
    });
    await writeFile(path.join(f.root, "server.js"), "");
    await mkdir(path.join(f.data, "work"), { recursive: true });
    const names = await f.register();
    expect(names).toHaveLength(2);
    expect(names.every((name) => /^[a-zA-Z0-9_-]+$/.test(name))).toBe(true);
    expect(f.registrations.get(names[0]!)).toEqual({
      type: "stdio",
      exposure: "deferred",
      command: path.join(await realpath(f.root), "server.js"),
      cwd: path.join(await realpath(f.data), "work"),
      args: [
        path.join(await realpath(f.root), "config"),
        path.join(await realpath(f.data), "cache"),
        "$HOME",
      ],
      env: {
        CUSTOM: path.join(await realpath(f.data), "x"),
        LITERAL: "$$HOME",
        COMMAND: "$!touch /never-run",
        PLUGIN_ROOT: await realpath(f.root),
        PLUGIN_DATA: await realpath(f.data),
      },
    });
    expect(f.registrations.get(names[1]!)).toEqual({
      type: "http",
      exposure: "deferred",
      url: "https://example.org/mcp",
      headers: { "X-Test": "$${PLUGIN_ROOT}", "X-Literal": "$!not-a-command" },
    });
    expect(f.warnings).toHaveLength(3);
    expect(await f.register()).toEqual(names);
  });

  it("uses stable collision-resistant names for punctuation and namesake installations", async () => {
    const servers = {
      "a.b": { type: "stdio", command: "node" },
      a_b: { type: "stdio", command: "node" },
    };
    const first = await fixture(servers);
    const second = await fixture(servers);
    const names = [...(await first.register()), ...(await second.register())];
    expect(new Set(names).size).toBe(4);
    expect(names.every((name) => /^[a-zA-Z0-9_-]+$/.test(name))).toBe(true);
  });

  it("rejects escaping symlinks, cwd traversal, unsafe URLs and duplicate headers", async () => {
    const f = await fixture({
      escaped: { type: "stdio", command: "./outside" },
      cwd: { type: "stdio", command: "node", cwd: "${PLUGIN_DATA}/../" },
      insecure: { type: "streamable-http", url: "http://example.org/mcp" },
      credentials: { type: "streamable-http", url: "https://user@example.org/mcp" },
      fragment: { type: "streamable-http", url: "https://example.org/mcp#bad" },
      duplicate: {
        type: "streamable-http",
        url: "https://example.org/mcp",
        headers: { "X-Key": "a", "x-key": "b" },
      },
      valid: { type: "stdio", command: "node" },
      loopback: { type: "streamable-http", url: "http://127.0.0.1:9876/mcp" },
    });
    await writeFile(path.join(f.directory, "outside"), "");
    await symlink(path.join(f.directory, "outside"), path.join(f.root, "outside"));
    expect(await f.register()).toHaveLength(2);
    expect(f.warnings).toHaveLength(6);
  });

  it("ignores missing, invalid and escaping MCP components without losing the plugin", async () => {
    const f = await fixture({});
    await rm(path.join(f.root, "mcp.json"));
    expect(await f.register()).toEqual([]);
    expect(f.warnings).toEqual([]);
    await writeFile(path.join(f.root, "mcp.json"), "{");
    expect(await f.register()).toEqual([]);
    await writeFile(
      path.join(f.root, "mcp.json"),
      JSON.stringify({ $schema: "unsupported", mcpServers: {} }),
    );
    expect(await f.register()).toEqual([]);
    await rm(path.join(f.root, "mcp.json"));
    await writeFile(
      path.join(f.directory, "outside.json"),
      JSON.stringify({ $schema: schema, mcpServers: {} }),
    );
    await symlink(path.join(f.directory, "outside.json"), path.join(f.root, "mcp.json"));
    expect(await f.register()).toEqual([]);
    expect(f.warnings).toHaveLength(3);
    expect((await loadPlugin(f.root)).name).toBe("tools.demo");
  });

  it("continues after Pi rejects a registration", async () => {
    const f = await fixture({
      first: { type: "stdio", command: "node" },
      second: { type: "stdio", command: "node" },
    });
    let calls = 0;
    const names = await registerPluginMcp(
      {
        registerMcpServer: (name, config) => {
          if (calls++ === 0) throw new Error("owned by another extension");
          f.pi.registerMcpServer(name, config);
        },
      },
      f.plugin,
      f.data,
      (message) => f.warnings.push(message),
    );
    expect(names).toHaveLength(1);
    expect(f.warnings).toHaveLength(1);
  });

  it("does not modify portable configuration", async () => {
    const f = await fixture({ local: { type: "stdio", command: "node" } });
    const original = await readFile(path.join(f.root, "mcp.json"), "utf8");
    await f.register();
    expect(await readFile(path.join(f.root, "mcp.json"), "utf8")).toBe(original);
  });
});

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { isIP } from "node:net";
import * as path from "node:path";

import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

import type { PluginResources } from "./plugin.js";

const mcpSchema = Compile(
  Type.Object(
    {
      $schema: Type.Literal("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"),
      mcpServers: Type.Record(Type.String(), Type.Unknown()),
    },
    { additionalProperties: false },
  ),
);
const stdioSchema = Compile(
  Type.Object(
    {
      type: Type.Literal("stdio"),
      command: Type.String({ minLength: 1 }),
      args: Type.Optional(Type.Array(Type.String())),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      cwd: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
);
const httpSchema = Compile(
  Type.Object(
    {
      type: Type.Literal("streamable-http"),
      url: Type.String(),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    },
    { additionalProperties: false },
  ),
);

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function checked(root: string, target: string, kind: "file" | "directory"): Promise<string> {
  const resolved = await realpath(target);
  const info = await stat(resolved);
  if (!within(root, resolved) || !(kind === "file" ? info.isFile() : info.isDirectory()))
    throw new Error(`Invalid plugin ${kind} path: ${target}`);
  return resolved;
}

function expand(value: string, root: string, data: string): string {
  return value.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_, key: string) =>
    key === "ROOT" ? root : data,
  );
}

// Portable plugin values are literals (except PLUGIN_ROOT/DATA in stdio).
// Escape Pi's environment/command syntax so migration does not add shell execution.
function literal(value: string): string {
  const escaped = value.replace(/\$/g, "$$$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

function serverName(plugin: PluginResources, name: string): string {
  const identity = createHash("sha256").update(plugin.root).digest("hex").slice(0, 12);
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_") || "server";
  const suffix = `_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
  return `${plugin.name.replace(/\./g, "_")}_${identity}_${safe}${suffix}`;
}

async function stdioConfig(
  entry: ReturnType<typeof stdioSchema.Parse>,
  root: string,
  dataPath: string,
): Promise<McpServerConfig> {
  if (
    Object.keys(entry.env ?? {}).some((key) =>
      process.platform === "win32"
        ? /^(PLUGIN_ROOT|PLUGIN_DATA)$/i.test(key)
        : key === "PLUGIN_ROOT" || key === "PLUGIN_DATA",
    )
  )
    throw new Error("Reserved environment variable");

  let command = entry.command;
  if (command.startsWith("./")) command = await checked(root, path.join(root, command), "file");
  else if (
    command.includes("/") ||
    command.includes("\\") ||
    /\s/.test(command) ||
    command === "." ||
    command === ".."
  )
    throw new Error("Command must be a bare executable or a ./ path");

  await mkdir(dataPath, { recursive: true });
  const data = await realpath(dataPath);
  if (!(await stat(data)).isDirectory()) throw new Error("PLUGIN_DATA must be a directory");
  await access(data, constants.W_OK);
  let cwd = root;
  if (entry.cwd !== undefined) {
    if (entry.cwd.startsWith("./"))
      cwd = await checked(root, path.resolve(root, entry.cwd), "directory");
    else if (entry.cwd === "${PLUGIN_ROOT}" || entry.cwd.startsWith("${PLUGIN_ROOT}/"))
      cwd = await checked(root, expand(entry.cwd, root, data), "directory");
    else if (entry.cwd === "${PLUGIN_DATA}" || entry.cwd.startsWith("${PLUGIN_DATA}/"))
      cwd = await checked(data, expand(entry.cwd, root, data), "directory");
    else throw new Error("Invalid working directory form");
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.env ?? {}))
    env[key] = literal(expand(value, root, data));
  // Pi inherits process.env; do not snapshot or re-interpolate the host environment.
  env.PLUGIN_ROOT = literal(root);
  env.PLUGIN_DATA = literal(data);
  return {
    type: "stdio",
    command,
    args: (entry.args ?? []).map((arg) => expand(arg, root, data)),
    cwd,
    env,
    exposure: "deferred",
  };
}

function httpConfig(entry: ReturnType<typeof httpSchema.Parse>): McpServerConfig {
  const url = new URL(entry.url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" || (isIP(host) === 4 && host.startsWith("127.")) || host === "::1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    /^https?:\/\/[^/?#]*@/i.test(entry.url) ||
    entry.url.includes("#")
  )
    throw new Error("Invalid remote server URL");
  const names = new Set<string>();
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(entry.headers ?? {})) {
    validateHeaderName(name);
    validateHeaderValue(name, value);
    if (names.has(name.toLowerCase())) throw new Error("Duplicate header name");
    names.add(name.toLowerCase());
    headers[name] = literal(value);
  }
  return { type: "http", url: entry.url, headers, exposure: "deferred" };
}

/** Adapt a previously validated portable plugin; Pi owns transports, OAuth and tools. */
export async function registerPluginMcp(
  pi: Pick<ExtensionAPI, "registerMcpServer">,
  plugin: PluginResources,
  dataPath: string,
  warn: (message: string) => void = console.warn,
): Promise<string[]> {
  const registered: string[] = [];
  let config: unknown;
  try {
    const file = await checked(plugin.root, path.join(plugin.root, "mcp.json"), "file");
    config = JSON.parse(await readFile(file, "utf8"));
    if (!mcpSchema.Check(config)) throw new Error("Invalid or unsupported mcp.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      warn(`Ignoring MCP for ${plugin.name}: ${String(error)}`);
    return registered;
  }
  const parsed = mcpSchema.Parse(config);
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    try {
      let entry: McpServerConfig;
      if (stdioSchema.Check(value))
        entry = await stdioConfig(stdioSchema.Parse(value), plugin.root, dataPath);
      else if (httpSchema.Check(value)) entry = httpConfig(httpSchema.Parse(value));
      else throw new Error("Unsupported or invalid server entry");
      const nativeName = serverName(plugin, name);
      pi.registerMcpServer(nativeName, entry);
      registered.push(nativeName);
    } catch (error) {
      warn(`Skipping plugin MCP server ${plugin.name}/${name}: ${String(error)}`);
    }
  }
  return registered;
}

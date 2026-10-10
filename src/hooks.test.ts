import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";

import { HookRuntime, parseHooks, registerHooks } from "./hooks.js";
import { loadPlugin, type PluginResources } from "./plugin.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(style: "copilot" | "codex" = "copilot") {
  const root = await mkdtemp(path.join(tmpdir(), "pi-hooks-"));
  roots.push(root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  await mkdir(path.join(root, ".codex-plugin"));
  await writeFile(
    path.join(root, style === "codex" ? ".codex-plugin/plugin.json" : "plugin.json"),
    '{"name":"fixture"}',
  );
  const ctx = {
    cwd: root,
    hasUI: false,
    sessionManager: {
      getSessionId: () => "session",
      getSessionFile: () => undefined,
      getBranch: () => [],
    },
  } as unknown as ExtensionContext;
  return { root, ctx };
}
function plugin(
  root: string,
  hooks: unknown,
  style: "copilot" | "codex" = "copilot",
): PluginResources {
  return {
    root,
    name: "fixture",
    skillPaths: [],
    promptPaths: [],
    hookStyle: style,
    hookSources: [hooks],
  };
}
const emit = (value: unknown) => `printf '%s' '${JSON.stringify(value)}'`;

it("discovers both defaults, inline and explicit hook sources without escaping plugin roots", async () => {
  const { root } = await fixture();
  await mkdir(path.join(root, "hooks"));
  await writeFile(path.join(root, "hooks.json"), '{"version":1,"hooks":{}}');
  await writeFile(path.join(root, "hooks/hooks.json"), '{"hooks":{}}');
  expect((await loadPlugin(root)).hookSources).toHaveLength(2);
  await writeFile(
    path.join(root, "plugin.json"),
    JSON.stringify({
      name: "fixture",
      hooks: ["./missing.json", { hooks: {} }, "./hooks/hooks.json"],
    }),
  );
  const warn = vi.fn();
  expect((await loadPlugin(root, warn)).hookSources).toHaveLength(2);
  expect(warn).toHaveBeenCalledWith("Missing hook file ./missing.json");
  const outside = await fixture("codex");
  await symlink(
    path.join(outside.root, ".codex-plugin/plugin.json"),
    path.join(root, "escape.json"),
  );
  await writeFile(path.join(root, "plugin.json"), '{"name":"fixture","hooks":"./escape.json"}');
  expect((await loadPlugin(root, warn)).hookSources).toEqual([]);
  await mkdir(path.join(outside.root, "hooks"));
  await writeFile(path.join(outside.root, "hooks/hooks.json"), '{"hooks":{}}');
  expect((await loadPlugin(outside.root)).hookStyle).toBe("codex");
  expect((await loadPlugin(outside.root)).hookSources).toHaveLength(1);
});

it("isolates malformed handlers, unsupported events/types, invalid regex and disabled sources", async () => {
  const { root } = await fixture();
  const warn = vi.fn();
  const hooks = parseHooks(
    [
      plugin(root, {
        hooks: {
          PreToolUse: [
            { hooks: [null, { type: "http" }, { command: "true" }] },
            { matcher: "[", command: "true" },
          ],
          PermissionRequest: [],
        },
      }),
      plugin(root, { disableAllHooks: true, hooks: { Stop: [{ command: "false" }] } }),
    ],
    warn,
  );
  expect(hooks).toHaveLength(1);
  expect(warn).toHaveBeenCalledTimes(4);
});

it("passes JSON stdin, literal env and persistent plugin paths with exec", async () => {
  const { root, ctx } = await fixture();
  await writeFile(
    path.join(root, "peer.cjs"),
    `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const p=JSON.parse(input);process.stdout.write(JSON.stringify({additionalContext:JSON.stringify({p,root:process.env.PLUGIN_ROOT,data:process.env.PLUGIN_DATA,literal:process.env.LITERAL,cwd:process.cwd()})}));});`,
  );
  const runtime = new HookRuntime(vi.fn());
  runtime.load([
    plugin(root, {
      version: 1,
      hooks: {
        sessionStart: [
          {
            exec: process.execPath,
            args: [path.join(root, "peer.cjs")],
            env: { LITERAL: "!echo no ${UNSET}" },
          },
        ],
      },
    }),
  ]);
  const output = await runtime.run("SessionStart", { source: "startup" }, ctx);
  const data = JSON.parse(output.context);
  expect(data.p.sessionId).toBe("session");
  expect(data.p.timestamp).toEqual(expect.any(Number));
  expect(data.p.session_id).toBeUndefined();
  expect(data.root).toBe(root);
  expect(data.data).toContain("plugin-data");
  expect(data.literal).toBe("!echo no ${UNSET}");
  expect(data.cwd).toBe(await realpath(root));
  runtime.dispose();
});

it("uses tool aliases, Codex decisions, Copilot result rewrites and progress stripping", async () => {
  const { root, ctx } = await fixture();
  const runtime = new HookRuntime(vi.fn());
  runtime.load([
    plugin(
      root,
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "^Bash$",
              hooks: [
                {
                  command: emit({
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: "policy",
                    },
                  }),
                },
              ],
            },
          ],
        },
      },
      "codex",
    ),
  ]);
  expect((await runtime.run("PreToolUse", { tool_name: "bash", tool_input: {} }, ctx)).block).toBe(
    "policy",
  );
  expect((await runtime.run("PreToolUse", { tool_name: "read" }, ctx)).block).toBeUndefined();
  runtime.load([
    plugin(root, {
      hooks: {
        postToolUse: [
          {
            matcher: "bash",
            command: `echo '{"type":"progress","message":"check"}'; ${emit({ modifiedResult: { resultType: "success", textResultForLlm: "redacted" }, additionalContext: "notes" })}`,
          },
        ],
      },
    }),
  ]);
  expect(await runtime.run("PostToolUse", { tool_name: "bash" }, ctx)).toMatchObject({
    result: "redacted",
    context: "notes",
  });
  runtime.dispose();
});

it("fails closed for Copilot command errors, open for Codex errors and all timeouts", async () => {
  const { root, ctx } = await fixture();
  const warn = vi.fn();
  const runtime = new HookRuntime(warn);
  for (const style of ["copilot", "codex"] as const) {
    runtime.load([plugin(root, { hooks: { PreToolUse: [{ command: "exit 1" }] } }, style)]);
    expect(Boolean((await runtime.run("PreToolUse", {}, ctx)).block)).toBe(style === "copilot");
  }
  runtime.load([
    plugin(root, { hooks: { PreToolUse: [{ command: "echo policy >&2; exit 2" }] } }, "codex"),
  ]);
  expect((await runtime.run("PreToolUse", {}, ctx)).block).toBe("policy");
  runtime.load([plugin(root, { hooks: { PreToolUse: [{ command: "sleep 5", timeout: 0.02 }] } })]);
  expect((await runtime.run("PreToolUse", {}, ctx)).block).toBeUndefined();
  runtime.dispose();
  expect(warn).toHaveBeenCalled();
});

it("bounds output and cancels old invocations when definitions are replaced", async () => {
  const { root, ctx } = await fixture();
  const runtime = new HookRuntime(vi.fn());
  runtime.load([
    plugin(root, {
      hooks: {
        PreToolUse: [
          { exec: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(2*1024*1024))"] },
        ],
      },
    }),
  ]);
  expect((await runtime.run("PreToolUse", {}, ctx)).block).toBeDefined();
  runtime.load([plugin(root, { hooks: { SessionStart: [{ command: "sleep 5" }] } })]);
  const running = runtime.run("SessionStart", { source: "startup" }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  runtime.load([]);
  expect(await running).toEqual({ context: "" });
  runtime.dispose();
});

it("starts all matching Codex hooks concurrently and merges in declaration order", async () => {
  const { root, ctx } = await fixture();
  const runtime = new HookRuntime(vi.fn());
  runtime.load([
    plugin(
      root,
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  command: `for i in $(seq 1 50); do test -f "$PLUGIN_ROOT/started" && break; sleep .01; done; test -f "$PLUGIN_ROOT/started" && ${emit({ additionalContext: "first" })}`,
                },
                {
                  command: `touch "$PLUGIN_ROOT/started"; ${emit({ additionalContext: "second" })}`,
                },
              ],
            },
          ],
        },
      },
      "codex",
    ),
  ]);
  expect((await runtime.run("SessionStart", { source: "startup" }, ctx)).context).toBe(
    "first\n\nsecond",
  );
  expect(await readFile(path.join(root, "started"), "utf8")).toBe("");
  runtime.dispose();
});

it("maps Pi input, validated tool mutations, result redaction, compaction, and bounded continuations", async () => {
  const { root, ctx } = await fixture();
  type Handler = (
    event: unknown,
    ctx: ExtensionContext,
  ) => Promise<Record<string, unknown> | undefined>;
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getAllTools: () => [{ name: "bash", parameters: Type.Object({ command: Type.String() }) }],
  } as unknown as ExtensionAPI;
  const runtime = new HookRuntime(vi.fn());
  registerHooks(pi, runtime);
  runtime.load([
    plugin(
      root,
      {
        hooks: {
          UserPromptSubmit: [{ command: emit({ decision: "block", reason: "secret" }) }],
          PreToolUse: [
            {
              command: emit({
                hookSpecificOutput: {
                  permissionDecision: "allow",
                  updatedInput: { command: "safe" },
                },
              }),
            },
          ],
          PostToolUse: [{ command: emit({ decision: "block", reason: "redacted" }) }],
          PreCompact: [{ command: emit({ continue: false }) }],
          Stop: [{ command: emit({ decision: "block", reason: "check" }) }],
        },
      },
      "codex",
    ),
  ]);
  expect(await handlers.get("input")!({ text: "secret" }, ctx)).toEqual({ action: "handled" });
  const call = {
    toolName: "bash",
    input: { command: "original", timeout: 10 },
    toolCallId: "call",
  };
  await handlers.get("tool_call")!(call, ctx);
  expect(call.input).toEqual({ command: "safe" });
  const result = await handlers.get("tool_result")!(
    {
      ...call,
      content: [{ type: "text", text: "secret" }],
      structuredContent: { secret: true },
      isError: false,
    },
    ctx,
  );
  expect(result!.content).toEqual([{ type: "text", text: "redacted" }]);
  expect(result!.structuredContent).toBeUndefined();
  expect(await handlers.get("session_before_compact")!({ reason: "manual" }, ctx)).toEqual({
    cancel: true,
  });
  const boundary = {
    outcome: "completed",
    entries: [],
    context: { canContinue: true, contextMessages: [] },
  };
  for (let i = 0; i < 8; i++)
    expect((await handlers.get("agent_before_settle")!(boundary, ctx))!.continue).toBe(true);
  expect(await handlers.get("agent_before_settle")!(boundary, ctx)).toBeUndefined();
  runtime.dispose();
});

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";

import type { PluginResources } from "./plugin.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const aliases: Record<string, string> = {
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  userPromptSubmitted: "UserPromptSubmit",
  userPromptTransformed: "UserPromptTransformed",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  agentStop: "Stop",
  errorOccurred: "ErrorOccurred",
  preCompact: "PreCompact",
  notification: "Notification",
};
const supported = new Set([...Object.values(aliases), "PostCompact", "Interrupt"]);
const toolAliases: Record<string, string> = {
  bash: "Bash",
  powershell: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  find: "Glob",
};

interface Hook {
  plugin: PluginResources;
  event: string;
  name: string;
  camel: boolean;
  codex: boolean;
  matcher?: RegExp;
  handler: ObjectValue;
}
export interface HookOutput {
  context: string;
  block?: string | undefined;
  stop?: boolean | undefined;
  args?: ObjectValue;
  prompt?: string | undefined;
  result?: string | undefined;
  failedResult?: boolean | undefined;
}

/** Parse each handler independently; unsupported capabilities never silently run. */
export function parseHooks(plugins: PluginResources[], warn: (message: string) => void): Hook[] {
  const result: Hook[] = [];
  for (const plugin of plugins)
    for (const source of plugin.hookSources ?? []) {
      if (!object(source)) {
        warn(`Invalid hooks for ${plugin.name}`);
        continue;
      }
      if (source.disableAllHooks === true) continue;
      if (source.version !== undefined && source.version !== 1) {
        warn(`Unsupported hook version for ${plugin.name}`);
        continue;
      }
      const events = object(source.hooks) ? source.hooks : source;
      for (const [name, groups] of Object.entries(events)) {
        if (["description", "version", "disableAllHooks"].includes(name)) continue;
        const event = aliases[name] ?? name;
        if (!supported.has(event)) {
          warn(`Unsupported hook event ${name} for ${plugin.name}`);
          continue;
        }
        if (!Array.isArray(groups)) {
          warn(`Invalid hook list ${name} for ${plugin.name}`);
          continue;
        }
        for (const group of groups) {
          if (!object(group)) {
            warn(`Invalid hook ${name}`);
            continue;
          }
          const handlers = Array.isArray(group.hooks) ? group.hooks : [group];
          for (const handler of handlers) {
            try {
              if (!object(handler)) throw new Error("handler must be an object");
              if ((handler.type ?? "command") !== "command")
                throw new Error(`unsupported handler type ${String(handler.type)}`);
              if (handler.async === true)
                throw new Error("background hooks are not supported; use a synchronous command");
              const command =
                process.platform === "win32"
                  ? (handler.commandWindows ?? handler.powershell ?? handler.command)
                  : (handler.bash ?? handler.command);
              if (handler.exec !== undefined) {
                if (
                  typeof handler.exec !== "string" ||
                  !handler.exec ||
                  handler.command !== undefined ||
                  handler.bash !== undefined ||
                  handler.powershell !== undefined
                )
                  throw new Error("invalid exec command");
              } else if (typeof command !== "string" || !command)
                throw new Error("missing platform command");
              if (
                handler.args !== undefined &&
                (!Array.isArray(handler.args) ||
                  !handler.args.every((arg) => typeof arg === "string"))
              )
                throw new Error("invalid args");
              if (
                handler.env !== undefined &&
                (!object(handler.env) ||
                  !Object.values(handler.env).every((v) => typeof v === "string"))
              )
                throw new Error("invalid env");
              if (handler.cwd !== undefined && typeof handler.cwd !== "string")
                throw new Error("invalid cwd");
              const timeout = handler.timeoutSec ?? handler.timeout;
              if (
                timeout !== undefined &&
                (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
              )
                throw new Error("invalid timeout");
              const pattern = group.matcher ?? handler.matcher;
              if (pattern !== undefined && typeof pattern !== "string")
                throw new Error("invalid matcher");
              const codex = plugin.hookStyle === "codex";
              result.push({
                plugin,
                event,
                name,
                camel: name in aliases,
                codex,
                handler,
                ...(pattern && pattern !== "*" && pattern !== "**"
                  ? { matcher: new RegExp(codex ? pattern : `^(?:${pattern})$`) }
                  : {}),
              });
            } catch (error) {
              warn(`Skipping ${plugin.name} ${name} hook: ${String(error)}`);
            }
          }
        }
      }
    }
  return result;
}

const limit = 1024 * 1024;
export class HookRuntime {
  private hooks: Hook[] = [];
  private kills = new Set<() => void>();
  private closed = false;
  private generation = 0;
  constructor(private warn: (message: string) => void) {}
  load(plugins: PluginResources[]): void {
    this.cancel();
    this.hooks = parseHooks(plugins, this.warn);
    this.closed = false;
  }
  cancel(): void {
    this.generation++;
    for (const kill of this.kills) kill();
    this.kills.clear();
  }
  dispose(): void {
    this.closed = true;
    this.cancel();
    this.hooks = [];
  }

  private async execute(
    hook: Hook,
    payload: ObjectValue,
    ctx: ExtensionContext,
  ): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
    const generation = this.generation;
    const h = hook.handler;
    const data = path.join(
      getAgentDir(),
      "plugin-data",
      createHash("sha256").update(hook.plugin.root).digest("hex"),
    );
    await mkdir(data, { recursive: true });
    if (this.closed || generation !== this.generation) throw new Error("Hook runtime changed");
    const command = text(
      process.platform === "win32"
        ? (h.commandWindows ?? h.powershell ?? h.command)
        : (h.bash ?? h.command),
    );
    const executable = text(h.exec) || (process.platform === "win32" ? "powershell.exe" : "bash");
    const args = h.exec
      ? ((h.args ?? []) as string[])
      : process.platform === "win32"
        ? ["-NoProfile", "-Command", command]
        : ["-c", command];
    const short = hook.event === "SessionEnd" || hook.event === "Interrupt";
    const seconds = Number(h.timeoutSec ?? h.timeout ?? (hook.codex ? (short ? 1 : 600) : 30));
    return new Promise((resolve) => {
      const child = spawn(executable, args, {
        cwd: h.cwd ? path.resolve(ctx.cwd, text(h.cwd)) : ctx.cwd,
        env: {
          ...process.env,
          ...(h.env as Record<string, string> | undefined),
          PLUGIN_ROOT: hook.plugin.root,
          PLUGIN_DATA: data,
          COPILOT_PLUGIN_ROOT: hook.plugin.root,
          COPILOT_PLUGIN_DATA: data,
          CLAUDE_PLUGIN_ROOT: hook.plugin.root,
          CLAUDE_PLUGIN_DATA: data,
        },
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "",
        bytes = 0,
        timedOut = false,
        overflow = false;
      const kill = () => {
        if (!child.pid) return;
        try {
          if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* Already exited. */
        }
      };
      this.kills.add(kill);
      const timer = setTimeout(
        () => {
          timedOut = true;
          kill();
        },
        Math.min(seconds, hook.codex && short ? 3 : seconds) * 1000,
      );
      const signal =
        hook.event === "Interrupt" || hook.event === "SessionEnd" ? undefined : ctx.signal;
      signal?.addEventListener("abort", kill, { once: true });
      if (signal?.aborted) kill();
      const append = (chunk: Buffer, isError: boolean) => {
        bytes += chunk.length;
        if (bytes > limit) {
          overflow = true;
          kill();
          return;
        }
        if (isError) stderr += chunk.toString();
        else stdout += chunk.toString();
      };
      child.stdout.on("data", (chunk: Buffer) => append(chunk, false));
      child.stderr.on("data", (chunk: Buffer) => append(chunk, true));
      child.stdin.on("error", () => {});
      child.on("error", (error) => {
        stderr = String(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", kill);
        this.kills.delete(kill);
        resolve({
          stdout,
          stderr: overflow ? "Hook output exceeded 1 MiB" : stderr,
          code: overflow ? 1 : (code ?? 1),
          timedOut,
        });
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }

  async run(event: string, fields: ObjectValue, ctx: ExtensionContext): Promise<HookOutput> {
    const generation = this.generation;
    const output: HookOutput = { context: "" };
    const invoke = async (hook: Hook): Promise<HookOutput> => {
      const tool = text(fields.tool_name);
      const canonical = toolAliases[tool] ?? tool;
      const match = text(fields.source ?? fields.trigger ?? fields.reason);
      if (
        hook.matcher &&
        ![
          "UserPromptSubmit",
          "UserPromptTransformed",
          "Stop",
          "Interrupt",
          "ErrorOccurred",
        ].includes(event)
      ) {
        const values = tool ? (hook.camel ? [tool] : [tool, canonical]) : [match];
        if (!values.some((value) => hook.matcher!.test(value))) return { context: "" };
      }
      const payload: ObjectValue = {
        session_id: ctx.sessionManager.getSessionId(),
        transcript_path: ctx.sessionManager.getSessionFile() ?? null,
        cwd: ctx.cwd,
        hook_event_name: hook.name,
        model: ctx.model?.id ?? "",
        ...fields,
        ...(tool ? { tool_name: hook.camel ? tool : canonical } : {}),
        timestamp: new Date().toISOString(),
      };
      delete payload.pi_codex_only;
      delete payload.pi_failure_only;
      if (!hook.codex && event === "SessionEnd") payload.reason = "user_exit";
      if (!hook.codex && event === "SessionStart" && payload.source === "clear")
        payload.source = "new";
      if (!hook.codex && object(fields.tool_response)) {
        const response = fields.tool_response;
        if (hook.camel) payload.tool_response = response;
        else {
          payload.tool_result = {
            result_type: response.resultType,
            text_result_for_llm: response.textResultForLlm,
          };
          delete payload.tool_response;
        }
      } else if (hook.codex && fields.pi_tool_response !== undefined)
        payload.tool_response = fields.pi_tool_response;
      delete payload.pi_tool_response;
      if (hook.camel) {
        const mapping: Record<string, string> = {
          session_id: "sessionId",
          transcript_path: "transcriptPath",
          tool_name: "toolName",
          tool_input: "toolArgs",
          tool_response: "toolResult",
          stop_reason: "stopReason",
          error_context: "errorContext",
          custom_instructions: "customInstructions",
          transformed_prompt: "transformedPrompt",
        };
        for (const [from, to] of Object.entries(mapping))
          if (from in payload) {
            payload[to] = payload[from];
            delete payload[from];
          }
        payload.timestamp = Date.now();
        if (event !== "Notification") delete payload.hook_event_name;
      }
      try {
        const result = await this.execute(hook, payload, ctx);
        if (
          this.closed ||
          generation !== this.generation ||
          (ctx.signal?.aborted && event !== "SessionEnd" && event !== "Interrupt")
        )
          return { context: "" };
        if (result.timedOut) {
          this.warn(`${hook.plugin.name} ${hook.name} timed out (fail-open)`);
          return { context: "" };
        }
        if (result.code !== 0) {
          this.warn(
            `${hook.plugin.name} ${hook.name} exited ${result.code}: ${result.stderr.slice(0, 2000)}`,
          );
          if (
            (event === "PreToolUse" && (!hook.codex || result.code === 2)) ||
            (hook.codex &&
              result.code === 2 &&
              ["UserPromptSubmit", "Stop", "PostToolUse"].includes(event))
          )
            return { context: "", block: result.stderr.trim() || "Blocked by plugin hook" };
          if (!hook.codex && event === "PostToolUseFailure" && result.code === 2)
            return { context: result.stdout.slice(0, 10000) };
          return { context: "" };
        }
        const stdout = result.stdout
          .split("\n")
          .filter((line) => {
            try {
              const progress: unknown = JSON.parse(line);
              if (object(progress) && progress.type === "progress") {
                if (ctx.hasUI) ctx.ui.notify(text(progress.message), "info");
                return false;
              }
            } catch {
              /* Not progress. */
            }
            return true;
          })
          .join("\n")
          .trim();
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout || "{}");
        } catch {
          return {
            context:
              hook.codex && ["SessionStart", "UserPromptSubmit"].includes(event)
                ? stdout.slice(0, 10000)
                : "",
          };
        }
        if (!object(parsed)) return { context: "" };
        const specific =
          object(parsed.hookSpecificOutput) &&
          (!parsed.hookSpecificOutput.hookEventName ||
            parsed.hookSpecificOutput.hookEventName === event)
            ? parsed.hookSpecificOutput
            : {};
        if (text(parsed.systemMessage)) {
          if (ctx.hasUI) ctx.ui.notify(text(parsed.systemMessage), "warning");
          else this.warn(text(parsed.systemMessage));
        }
        const decision = specific.permissionDecision ?? parsed.permissionDecision;
        let block =
          decision === "deny" || parsed.decision === "block"
            ? text(
                specific.permissionDecisionReason ??
                  parsed.permissionDecisionReason ??
                  parsed.reason,
              ) || "Blocked by plugin hook"
            : undefined;
        if (decision === "ask")
          block =
            !ctx.hasUI ||
            !(await ctx.ui.confirm(
              "Plugin hook approval",
              text(parsed.permissionDecisionReason ?? specific.permissionDecisionReason) || tool,
            ))
              ? "Denied by plugin hook approval"
              : undefined;
        if (
          !hook.codex &&
          ["PreCompact", "UserPromptSubmit", "SessionEnd", "ErrorOccurred"].includes(event)
        )
          return { context: "" };
        const args = hook.codex
          ? specific.permissionDecision === "allow"
            ? specific.updatedInput
            : undefined
          : (parsed.modifiedArgs ?? specific.updatedInput);
        const modified = object(parsed.modifiedResult) ? parsed.modifiedResult : {};
        return {
          context: text(specific.additionalContext ?? parsed.additionalContext).slice(0, 10000),
          block,
          stop: parsed.continue === false,
          ...(object(args) ? { args } : {}),
          prompt: text(parsed.modifiedTransformedPrompt) || undefined,
          result:
            typeof modified.textResultForLlm === "string"
              ? modified.textResultForLlm.slice(0, limit)
              : undefined,
          failedResult: modified.resultType === "failure",
        };
      } catch (error) {
        this.warn(`${hook.plugin.name} ${hook.name}: ${String(error)}`);
        return {
          context: "",
          ...(!hook.codex &&
          event === "PreToolUse" &&
          !this.closed &&
          generation === this.generation
            ? { block: "Plugin hook failed" }
            : {}),
        };
      }
    };
    // Codex handlers start concurrently; Copilot handlers run in declaration order.
    const matching = this.hooks.filter(
      (hook) =>
        hook.event === event &&
        (!fields.pi_codex_only || hook.codex) &&
        (!fields.pi_failure_only || hook.codex),
    );
    const merge = (next: HookOutput) => {
      if (next.context)
        output.context = [output.context, next.context]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 10000);
      if (next.block) output.block = next.block;
      if (next.stop) output.stop = true;
      if (next.args) output.args = next.args;
      if (next.prompt) output.prompt = next.prompt;
      if (next.result !== undefined) {
        output.result = next.result;
        output.failedResult = next.failedResult;
      }
    };
    const codex = matching.filter((hook) => hook.codex).map(invoke);
    for (const hook of matching.filter((item) => !item.codex)) {
      if (generation !== this.generation || this.closed) break;
      merge(await invoke(hook));
    }
    for (const next of await Promise.all(codex)) merge(next);
    return output;
  }
}

/** Register once, replace definitions on discovery, and release processes on shutdown. */
export function registerHooks(pi: ExtensionAPI, runtime: HookRuntime): void {
  let context = "",
    continuations = 0,
    trigger = "manual";
  const queue = (value: string) => {
    if (value) context = [context, value].filter(Boolean).join("\n\n").slice(0, 10000);
  };
  pi.on("session_start", async (event, ctx) => {
    context = "";
    continuations = 0;
    const source =
      event.reason === "new" || event.reason === "fork"
        ? "clear"
        : event.reason === "resume" || ctx.sessionManager.getBranch().length > 0
          ? "resume"
          : "startup";
    queue((await runtime.run("SessionStart", { source }, ctx)).context);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    runtime.cancel();
    try {
      await runtime.run("SessionEnd", { reason: "other" }, ctx);
    } finally {
      runtime.dispose();
      context = "";
    }
  });
  pi.on("input", async (event, ctx) => {
    continuations = 0;
    const output = await runtime.run("UserPromptSubmit", { prompt: event.text }, ctx);
    if (output.block || output.stop) {
      if (ctx.hasUI) ctx.ui.notify(output.block ?? "Prompt stopped by plugin hook", "warning");
      return { action: "handled" };
    }
    queue(output.context);
    const transformed = await runtime.run(
      "UserPromptTransformed",
      { prompt: event.text, transformed_prompt: event.text },
      ctx,
    );
    return transformed.prompt
      ? {
          action: "transform",
          text: transformed.prompt,
          ...(event.images ? { images: event.images } : {}),
        }
      : undefined;
  });
  pi.on("before_agent_start", () => {
    if (!context) return;
    const content = context;
    context = "";
    return { message: { customType: "plugin-hooks", content, display: false } };
  });
  pi.on("context", (event) => {
    if (!context) return;
    const content = context;
    context = "";
    return {
      messages: [
        ...event.messages,
        {
          role: "custom",
          customType: "plugin-hooks",
          content,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });
  pi.on("tool_call", async (event, ctx) => {
    const output = await runtime.run(
      "PreToolUse",
      { tool_name: event.toolName, tool_input: event.input, tool_use_id: event.toolCallId },
      ctx,
    );
    queue(output.context);
    if (output.block) return { block: true, reason: output.block };
    if (output.args) {
      // Pi does not revalidate hook mutations; reject unsafe object keys before replacement.
      if (
        Object.keys(output.args).some((key) =>
          ["__proto__", "constructor", "prototype"].includes(key),
        )
      )
        return { block: true, reason: "Unsafe hook argument keys" };
      const tool = pi.getAllTools().find((item) => item.name === event.toolName);
      try {
        if (!tool || !Compile(tool.parameters).Check(output.args))
          return { block: true, reason: "Invalid hook replacement arguments" };
      } catch {
        return { block: true, reason: "Cannot validate hook replacement arguments" };
      }
      for (const key of Object.keys(event.input)) delete (event.input as ObjectValue)[key];
      Object.assign(event.input, output.args);
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    const rendered = event.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    if (event.isError)
      await runtime.run(
        "ErrorOccurred",
        {
          error: { message: rendered, name: "ToolError" },
          error_context: "tool_execution",
          recoverable: true,
        },
        ctx,
      );
    const fields = {
      tool_name: event.toolName,
      tool_input: event.input,
      tool_use_id: event.toolCallId,
      tool_response: {
        resultType: event.isError ? "failure" : "success",
        textResultForLlm: rendered,
      },
      pi_tool_response: {
        content: event.content,
        ...(event.structuredContent !== undefined
          ? { structuredContent: event.structuredContent }
          : {}),
        isError: event.isError,
      },
      error: rendered,
    };
    // Codex PostToolUse includes failures; Copilot has a separate failure event.
    const output = await runtime.run(
      event.isError ? "PostToolUseFailure" : "PostToolUse",
      fields,
      ctx,
    );
    if (event.isError) {
      const codex = await runtime.run("PostToolUse", { ...fields, pi_failure_only: true }, ctx);
      output.context = [output.context, codex.context].filter(Boolean).join("\n\n");
      output.block ??= codex.block;
      output.stop ||= codex.stop;
    }
    if (output.result !== undefined || output.context || output.block || output.stop) {
      const replacement =
        output.block ??
        (output.stop ? "Tool output stopped by plugin hook" : (output.result ?? rendered));
      return {
        content: [
          { type: "text", text: [replacement, output.context].filter(Boolean).join("\n\n") },
        ],
        details: undefined,
        isError: output.block
          ? true
          : output.result !== undefined
            ? (output.failedResult ?? false)
            : event.isError,
      };
    }
  });
  pi.on("session_before_compact", async (event, ctx) => {
    trigger = event.reason === "manual" ? "manual" : "auto";
    const output = await runtime.run(
      "PreCompact",
      { trigger, custom_instructions: event.customInstructions ?? "" },
      ctx,
    );
    queue(output.context);
    if (output.stop) return { cancel: true };
  });
  pi.on("session_compact", async (event, ctx) => {
    trigger = event.reason === "manual" ? "manual" : "auto";
    queue((await runtime.run("PostCompact", { trigger }, ctx)).context);
    queue(
      (await runtime.run("SessionStart", { source: "compact", pi_codex_only: true }, ctx)).context,
    );
  });
  pi.on("session_compact_failed", async (event, ctx) => {
    if (event.errorMessage)
      await runtime.run(
        "ErrorOccurred",
        {
          error: { message: event.errorMessage, name: "CompactionError" },
          error_context: "system",
          recoverable: true,
        },
        ctx,
      );
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome === "aborted") {
      await runtime.run("Interrupt", {}, ctx);
      return;
    }
    if (event.outcome === "error") {
      await runtime.run(
        "ErrorOccurred",
        {
          error: { message: "Agent run failed", name: "AgentError" },
          error_context: "model_call",
          recoverable: false,
        },
        ctx,
      );
      return;
    }
    const messages = event.context.contextMessages;
    const last = [...messages].reverse().find((message) => message.role === "assistant");
    const output = await runtime.run(
      "Stop",
      {
        stop_hook_active: continuations > 0,
        stop_reason: "end_turn",
        last_assistant_message:
          last?.role === "assistant"
            ? last.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n")
            : null,
      },
      ctx,
    );
    queue(output.context);
    if (output.block && !output.stop && continuations < 8 && event.context.canContinue) {
      continuations++;
      return {
        continue: true,
        entries: [
          ...event.entries,
          {
            type: "custom_message",
            customType: "plugin-hook-continuation",
            content: output.block,
            display: false,
          },
        ],
      };
    }
  });
  pi.on("ui_prompt_start", async (event, ctx) => {
    queue(
      (
        await runtime.run(
          "Notification",
          {
            notification_type: "elicitation_dialog",
            title: event.title ?? "",
            message: event.title ?? event.kind,
          },
          ctx,
        )
      ).context,
    );
  });
}

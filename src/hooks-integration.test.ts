import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

import agentPlugins from "./index.js";

it("runs configured plugin hooks through a real Pi extension runtime", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-hooks-integration-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const root = path.join(directory, "plugin");
    await mkdir(root);
    await writeFile(path.join(root, "plugin.json"), '{"name":"policy"}');
    await writeFile(
      path.join(root, "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          preToolUse: [
            {
              matcher: "bash",
              bash: `printf '%s' '{"permissionDecision":"deny","permissionDecisionReason":"integration policy"}'`,
            },
          ],
          userPromptTransformed: [
            { bash: `printf '%s' '{"modifiedTransformedPrompt":"rewritten"}'` },
          ],
        },
      }),
    );
    await writeFile(
      path.join(directory, "pi-agent-plugins.json"),
      JSON.stringify({ plugins: [root] }),
    );
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [agentPlugins],
    });
    await resourceLoader.reload();
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
    expect(
      await session.extensionRunner.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "test",
        input: { command: "echo unsafe" },
      }),
    ).toMatchObject({ block: true, reason: "integration policy" });
    expect(
      await session.extensionRunner.emitInput("original", undefined, "interactive"),
    ).toMatchObject({ action: "transform", text: "rewritten" });
    await writeFile(path.join(directory, "pi-agent-plugins.json"), '{"plugins":[]}');
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    expect(
      await session.extensionRunner.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "next",
        input: { command: "echo safe" },
      }),
    ).not.toMatchObject({ block: true });
    expect(errors).toEqual([]);
  } finally {
    await cleanup?.();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

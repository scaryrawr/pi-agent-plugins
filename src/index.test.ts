import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { it, vi } from "vitest";

import { globalConfigPath, readConfig } from "./config.js";
import extension from "./index.js";
import { marketplaceRoot } from "./marketplace.js";
import { loadPlugin } from "./plugin.js";

it("adds an already cloned Codex marketplace to global config and can load its plugins", async () => {
  const agent = await mkdtemp(path.join(tmpdir(), "pi-codex-marketplace-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  try {
    const source = "https://github.com/scaryrawr/scarydex";
    const root = marketplaceRoot(source);
    await mkdir(path.join(root, ".agents/plugins"), { recursive: true });
    await mkdir(path.join(root, "plugins/decide/.codex-plugin"), { recursive: true });
    await mkdir(path.join(root, "plugins/decide/skills/decide"), { recursive: true });
    await writeFile(
      path.join(root, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "scarydex",
        plugins: [{ name: "decide", source: { source: "local", path: "./plugins/decide" } }],
      }),
    );
    await writeFile(
      path.join(root, "plugins/decide/.codex-plugin/plugin.json"),
      '{"name":"decide"}',
    );
    await writeFile(
      path.join(root, "plugins/decide/skills/decide/SKILL.md"),
      "---\nname: decide\ndescription: Make decisions\n---\n",
    );
    let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
    const pi = {
      registerCommand: (_name: string, value: NonNullable<typeof command>) => {
        command = value;
      },
      on: () => {},
    } as unknown as ExtensionAPI;
    extension(pi);
    const select = vi.fn().mockResolvedValueOnce("Add marketplace").mockResolvedValueOnce("Done");
    const notify = vi.fn();
    const ctx = {
      hasUI: true,
      cwd: agent,
      ui: { select, input: async () => source, notify },
    } as unknown as ExtensionCommandContext;
    await command!.handler("", ctx);
    assert.deepEqual(await readConfig(globalConfigPath()), {
      plugins: [],
      marketplaces: [{ source, enabled: [] }],
    });
    assert.equal(notify.mock.calls[0]![0], "Added scarydex (1 plugins, all disabled)");
    assert.equal((await loadPlugin(path.join(root, "plugins/decide"))).skillPaths.length, 1);
    // Retrying the add reuses the checkout without duplicating configuration.
    select.mockResolvedValueOnce("Add marketplace").mockResolvedValueOnce("Done");
    await command!.handler("", ctx);
    assert.equal((await readConfig(globalConfigPath())).marketplaces.length, 1);
  } finally {
    vi.unstubAllEnvs();
    await rm(agent, { recursive: true, force: true });
  }
});

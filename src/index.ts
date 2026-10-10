import { createHash } from "node:crypto";
import * as path from "node:path";

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { configuredSources, readConfig, saveGlobalConfig, globalConfigPath } from "./config.js";
import { HookRuntime, registerHooks } from "./hooks.js";
import {
  installMarketplace,
  normalizeSource,
  readMarketplace,
  refreshMarketplace,
} from "./marketplace.js";
import { registerPluginMcp } from "./mcp.js";
import { loadPlugin, type PluginResources } from "./plugin.js";

export default function (pi: ExtensionAPI): void {
  let resources: PluginResources[] = [];
  let mcpServers: string[] = [];
  const warn = (message: string) => console.warn(`[pi-agent-plugins] ${message}`);
  const hooks = new HookRuntime(warn);

  async function discover(cwd: string, trusted: boolean): Promise<PluginResources[]> {
    const result: PluginResources[] = [];
    const config = await configuredSources(cwd, trusted, warn);
    const roots = [...config.plugins];
    for (const marketplace of config.marketplaces) {
      try {
        const catalog = await readMarketplace(marketplace.source, warn);
        roots.push(
          ...catalog.plugins
            .filter((item) => marketplace.enabled.includes(item.name))
            .map((item) => item.root),
        );
      } catch (error) {
        warn(`Skipping marketplace ${marketplace.source}: ${String(error)}`);
      }
    }
    for (const root of new Set(roots)) {
      try {
        result.push(await loadPlugin(root, warn));
      } catch (error) {
        warn(`Skipping ${root}: ${String(error)}`);
      }
    }
    return result;
  }

  pi.registerCommand("marketplaces", {
    description: "Add, browse, refresh and toggle Agent Plugin marketplaces",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      while (true) {
        const config = await readConfig(globalConfigPath(), warn);
        const action = await ctx.ui.select("Agent Plugin marketplaces", [
          "Add marketplace",
          ...config.marketplaces.map((m) => m.source),
          "Done",
        ]);
        if (!action || action === "Done") return;
        if (action === "Add marketplace") {
          const input = await ctx.ui.input(
            "Marketplace",
            "Local directory or https://github.com/owner/repo",
          );
          if (!input) continue;
          try {
            const source = normalizeSource(input, ctx.cwd);
            const existing = config.marketplaces.some((m) => m.source === source);
            await installMarketplace(source);
            const catalog = await readMarketplace(source, warn);
            if (!existing) {
              config.marketplaces.push({ source, enabled: [] });
              await saveGlobalConfig(config);
            }
            ctx.ui.notify(
              existing
                ? `${catalog.name} is already configured; cache is ready`
                : `Added ${catalog.name} (${catalog.plugins.length} plugins, all disabled)`,
              "info",
            );
          } catch (error) {
            ctx.ui.notify(`Cannot add marketplace: ${String(error)}`, "error");
          }
          continue;
        }
        const entry = config.marketplaces.find((m) => m.source === action);
        if (!entry) continue;
        while (true) {
          let catalog;
          try {
            catalog = await readMarketplace(entry.source, warn);
          } catch (error) {
            ctx.ui.notify(`Cannot browse ${entry.source}: ${String(error)}`, "error");
            break;
          }
          const choices = catalog.plugins.map(
            (p) =>
              `${entry.enabled.includes(p.name) ? "[on] " : "[off]"} ${p.name}${p.description ? ` — ${p.description}` : ""}`,
          );
          const selection = await ctx.ui.select(`${catalog.name} — toggle a plugin`, [
            ...choices,
            "Refresh marketplace",
            "Remove marketplace",
            "Back",
          ]);
          if (!selection || selection === "Back") break;
          if (selection === "Remove marketplace") {
            if (
              await ctx.ui.confirm(
                "Remove marketplace?",
                `Remove ${entry.source} from global config?`,
              )
            ) {
              config.marketplaces = config.marketplaces.filter((m) => m !== entry);
              await saveGlobalConfig(config);
              break;
            }
          } else if (selection === "Refresh marketplace") {
            try {
              await refreshMarketplace(entry.source);
              ctx.ui.notify("Marketplace refreshed", "info");
            } catch (error) {
              ctx.ui.notify(`Refresh failed: ${String(error)}`, "error");
            }
          } else {
            const index = choices.indexOf(selection);
            if (index < 0) continue;
            const name = catalog.plugins[index]!.name;
            entry.enabled = entry.enabled.includes(name)
              ? entry.enabled.filter((item) => item !== name)
              : [...entry.enabled, name];
            try {
              await saveGlobalConfig(config);
              ctx.ui.notify(
                `${name} ${entry.enabled.includes(name) ? "enabled" : "disabled"}. Use /reload to apply.`,
                "info",
              );
            } catch (error) {
              ctx.ui.notify(`Cannot save config: ${String(error)}`, "error");
            }
          }
        }
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    resources = await discover(ctx.cwd, ctx.isProjectTrusted());
    hooks.load(resources);
    for (const name of mcpServers) pi.unregisterMcpServer(name);
    mcpServers = [];
    for (const plugin of resources) {
      // Identity is the canonical path, so namesakes and updates keep independent persistent data.
      const id = createHash("sha256").update(plugin.root).digest("hex");
      const data = path.join(getAgentDir(), "plugin-data", id);
      try {
        mcpServers.push(...(await registerPluginMcp(pi, plugin, data, warn)));
      } catch (error) {
        warn(`MCP for ${plugin.name}: ${String(error)}`);
      }
    }
  });

  pi.on("resources_discover", async (event, ctx) => {
    // Reload can update files without a session restart; do not add MCP registrations here.
    if (event.reason === "reload") {
      resources = await discover(event.cwd, ctx.isProjectTrusted());
      hooks.load(resources);
    }
    return {
      skillPaths: resources.flatMap((plugin) => plugin.skillPaths),
      promptPaths: resources.flatMap((plugin) => plugin.promptPaths),
    };
  });
  registerHooks(pi, hooks);
}

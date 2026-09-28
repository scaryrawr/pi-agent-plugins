import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import { type MarketplaceEntry, normalizeSource } from "./marketplace.js";

export interface PluginConfig {
  plugins: string[];
  marketplaces: MarketplaceEntry[];
}

const empty = (): PluginConfig => ({ plugins: [], marketplaces: [] });
export const globalConfigPath = (): string => path.join(getAgentDir(), "pi-agent-plugins.json");

export async function readConfig(
  file: string,
  warn: (message: string) => void = console.warn,
): Promise<PluginConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
    warn(`Cannot read ${file}: ${String(error)}`);
    return empty();
  }
  try {
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("Expected object");
    const object = data as Record<string, unknown>;
    if (object.plugins !== undefined && !Array.isArray(object.plugins))
      warn(`Invalid plugins array in ${file}`);
    if (object.marketplaces !== undefined && !Array.isArray(object.marketplaces))
      warn(`Invalid marketplaces array in ${file}`);
    const plugins: string[] = [];
    for (const value of (Array.isArray(object.plugins) ? object.plugins : []) as unknown[]) {
      if (typeof value === "string" && value.length > 0)
        plugins.push(path.resolve(path.dirname(file), value));
      else warn(`Skipping invalid plugin path in ${file}`);
    }
    const marketplaces: MarketplaceEntry[] = [];
    for (const value of (Array.isArray(object.marketplaces)
      ? object.marketplaces
      : []) as unknown[]) {
      try {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("not an object");
        const item = value as Record<string, unknown>;
        if (
          typeof item.source !== "string" ||
          !Array.isArray(item.enabled) ||
          !item.enabled.every((name: unknown) => typeof name === "string")
        )
          throw new Error("expected { source: string, enabled: string[] }");
        const source = normalizeSource(item.source, path.dirname(file));
        if (marketplaces.some((entry) => entry.source === source)) continue;
        marketplaces.push({ source, enabled: [...new Set(item.enabled as string[])] });
      } catch (error) {
        warn(`Skipping invalid marketplace in ${file}: ${String(error)}`);
      }
    }
    return { plugins, marketplaces };
  } catch (error) {
    warn(`Invalid ${file}: ${String(error)}`);
    return empty();
  }
}

export async function configuredSources(
  cwd: string,
  projectTrusted: boolean,
  warn: (message: string) => void = console.warn,
): Promise<PluginConfig> {
  const global = await readConfig(globalConfigPath(), warn);
  const project = projectTrusted
    ? await readConfig(path.join(cwd, CONFIG_DIR_NAME, "pi-agent-plugins.json"), warn)
    : empty();
  return {
    plugins: [...new Set([...global.plugins, ...project.plugins])],
    marketplaces: [...global.marketplaces, ...project.marketplaces],
  };
}

export async function configuredPlugins(
  cwd: string,
  projectTrusted: boolean,
  warn: (message: string) => void = console.warn,
): Promise<string[]> {
  return (await configuredSources(cwd, projectTrusted, warn)).plugins;
}

/** The UI only edits the global config, never a project-provided config. */
export async function saveGlobalConfig(config: PluginConfig): Promise<void> {
  const file = globalConfigPath();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(temporary, { force: true });
  }
}

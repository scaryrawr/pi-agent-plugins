import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
const github = /^https:\/\/github\.com\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?\/?$/;
const pluginName = /^[a-z0-9](?:(?!.*(?:--|\.\.))[a-z0-9.-]{0,62}[a-z0-9])?$/;

export interface MarketplaceEntry {
  source: string;
  enabled: string[];
}

export interface CatalogPlugin {
  name: string;
  description?: string;
  root: string;
}

export interface Catalog {
  name: string;
  plugins: CatalogPlugin[];
}

export function normalizeSource(input: string, base = process.cwd()): string {
  const source = input.trim();
  const match = github.exec(source);
  if (match) return `https://github.com/${match[1]}/${match[2]}`;
  if (source.startsWith("https://") || source.startsWith("http://") || source.startsWith("git:"))
    throw new Error("Only https://github.com/owner/repo URLs or local directories are supported");
  if (!source) throw new Error("Marketplace source is empty");
  return path.resolve(base, source);
}

export function marketplaceRoot(source: string): string {
  if (!github.test(source)) return source;
  const id = createHash("sha256").update(source).digest("hex");
  return path.join(getAgentDir(), "marketplaces", id);
}

export async function installMarketplace(source: string): Promise<void> {
  if (!github.test(source)) return;
  const root = marketplaceRoot(source);
  try {
    await stat(root);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(root), { recursive: true });
  const temporary = `${root}-${process.pid}-${Date.now()}`;
  try {
    await exec("git", ["clone", "--depth", "1", "--", source, temporary], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    await rename(temporary, root);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function refreshMarketplace(source: string): Promise<void> {
  if (!github.test(source)) return;
  const root = marketplaceRoot(source);
  await installMarketplace(source);
  // Only fast-forward the existing checkout. No startup network requests or implicit updates.
  await exec("git", ["-C", root, "pull", "--ff-only"], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export async function readMarketplace(
  source: string,
  warn: (message: string) => void = console.warn,
): Promise<Catalog> {
  const root = await realpath(marketplaceRoot(source));
  if (!(await stat(root)).isDirectory()) throw new Error("Marketplace root must be a directory");
  let manifest: string | undefined;
  for (const location of [".github/plugin/marketplace.json", ".agents/plugins/marketplace.json"]) {
    const candidate = path.join(root, location);
    try {
      await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    manifest = await realpath(candidate);
    break;
  }
  if (!manifest)
    throw new Error(
      "Missing marketplace manifest (.github/plugin/marketplace.json or .agents/plugins/marketplace.json)",
    );
  if (!within(root, manifest) || !(await stat(manifest)).isFile())
    throw new Error("Marketplace manifest must be a file inside the marketplace root");
  const data: unknown = JSON.parse(await readFile(manifest, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Invalid marketplace");
  const catalog = data as Record<string, unknown>;
  if (typeof catalog.name !== "string" || !Array.isArray(catalog.plugins))
    throw new Error("Marketplace needs a name and plugins array");
  const plugins: CatalogPlugin[] = [];
  const names = new Set<string>();
  for (const value of catalog.plugins) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      warn("Skipping invalid marketplace entry");
      continue;
    }
    const entry = value as Record<string, unknown>;
    try {
      if (typeof entry.name !== "string" || !pluginName.test(entry.name) || names.has(entry.name))
        throw new Error("invalid or duplicate name");
      const source = entry.source;
      const localPath =
        typeof source === "string"
          ? source
          : source &&
              typeof source === "object" &&
              !Array.isArray(source) &&
              (source as Record<string, unknown>).source === "local"
            ? (source as Record<string, unknown>).path
            : undefined;
      if (typeof localPath !== "string" || !localPath.startsWith("./"))
        throw new Error("only local ./ plugin sources are supported");
      const location = await realpath(path.resolve(root, localPath));
      if (!within(root, location) || !(await stat(location)).isDirectory())
        throw new Error("plugin source must be a directory inside the marketplace");
      names.add(entry.name);
      plugins.push({
        name: entry.name,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        root: location,
      });
    } catch (error) {
      warn(`Skipping marketplace plugin ${String(entry.name)}: ${String(error)}`);
    }
  }
  return { name: catalog.name, plugins };
}

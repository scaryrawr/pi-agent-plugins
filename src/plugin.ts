import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

import { Type } from "typebox";
import { Compile } from "typebox/compile";
import YAML from "yaml";

const manifestSchema = Compile(
  Type.Object(
    {
      $schema: Type.Optional(
        Type.Literal("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"),
      ),
      name: Type.String({
        minLength: 1,
        maxLength: 64,
        pattern: "^[a-z0-9](?:(?!.*(?:--|\\.\\.))[a-z0-9.-]{0,62}[a-z0-9])?$",
      }),
      version: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      author: Type.Optional(
        Type.Object(
          {
            name: Type.Optional(Type.String()),
            email: Type.Optional(Type.String()),
            url: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
      homepage: Type.Optional(Type.String()),
      repository: Type.Optional(Type.String()),
      license: Type.Optional(Type.String()),
      keywords: Type.Optional(Type.Array(Type.String())),
      extensions: Type.Optional(Type.Unknown()),
      hooks: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
  ),
);

const fields = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
  "hooks",
]);
const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function checked(
  root: string,
  location: string,
  kind: "file" | "directory",
): Promise<string | undefined> {
  let resolved: string;
  try {
    resolved = await realpath(path.join(root, location));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const info = await stat(resolved);
  if (!within(root, resolved) || !(kind === "file" ? info.isFile() : info.isDirectory())) {
    throw new Error(`Invalid ${location} (${kind} must be inside plugin root)`);
  }
  return resolved;
}

export interface PluginResources {
  root: string;
  name: string;
  skillPaths: string[];
  promptPaths: string[];
  hookSources?: unknown[];
  hookStyle?: "copilot" | "codex";
}

function validSkill(content: string, directory: string): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!frontmatter) return false;
  try {
    const metadata: unknown = YAML.parse(frontmatter[1] ?? "", { uniqueKeys: true });
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
    const data = metadata as Record<string, unknown>;
    return (
      typeof data.name === "string" &&
      data.name === directory &&
      data.name.length <= 64 &&
      skillName.test(data.name) &&
      typeof data.description === "string" &&
      data.description.length > 0 &&
      data.description.length <= 1024 &&
      (data.compatibility === undefined ||
        (typeof data.compatibility === "string" &&
          data.compatibility.length > 0 &&
          data.compatibility.length <= 500)) &&
      (data.license === undefined || typeof data.license === "string") &&
      (data["allowed-tools"] === undefined || typeof data["allowed-tools"] === "string") &&
      (data.metadata === undefined ||
        (typeof data.metadata === "object" &&
          data.metadata !== null &&
          !Array.isArray(data.metadata) &&
          Object.values(data.metadata).every((value) => typeof value === "string")))
    );
  } catch {
    return false;
  }
}

/** Inspect one explicitly configured package. Component failures do not reject valid siblings. */
export async function loadPlugin(
  rootPath: string,
  warn: (message: string) => void = console.warn,
): Promise<PluginResources> {
  const root = await realpath(rootPath);
  if (!(await stat(root)).isDirectory()) throw new Error("Plugin root must be a directory");
  let manifestPath: string | undefined;
  for (const location of ["plugin.json", ".codex-plugin/plugin.json"]) {
    try {
      await lstat(path.join(root, location));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    manifestPath = await checked(root, location, "file");
    if (!manifestPath) throw new Error(`Invalid ${location}`);
    break;
  }
  if (!manifestPath) throw new Error("Missing plugin.json or .codex-plugin/plugin.json");
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifestSchema.Check(manifest))
    throw new Error("Invalid or unsupported plugin.json (only v1.0.0 is supported)");
  const plugin = manifestSchema.Parse(manifest);
  for (const key of Object.keys(plugin))
    if (!fields.has(key)) warn(`Ignoring unknown plugin.json field: ${key}`);
  if (
    plugin.extensions !== undefined &&
    (!plugin.extensions ||
      typeof plugin.extensions !== "object" ||
      Array.isArray(plugin.extensions))
  )
    warn("Ignoring invalid extensions field");

  const skillPaths: string[] = [];
  try {
    const skills = await checked(root, "skills", "directory");
    if (skills) {
      for (const child of await readdir(skills, { withFileTypes: true })) {
        // Symlinked child directories are allowed only when their resolved target remains in the package.
        try {
          const directory = await checked(root, path.join("skills", child.name), "directory");
          if (!directory) continue;
          const file = await checked(root, path.join("skills", child.name, "SKILL.md"), "file");
          if (file && validSkill(await readFile(file, "utf8"), child.name)) skillPaths.push(file);
          else if (file) warn(`Skipping invalid skill ${child.name}`);
        } catch (error) {
          warn(`Skipping skill ${child.name}: ${String(error)}`);
        }
      }
    }
  } catch (error) {
    warn(`Ignoring invalid skills component: ${String(error)}`);
  }

  // Prompts are NOT a portable v1 component: only a pi-specific extension directory is read.
  const promptPaths: string[] = [];
  try {
    const prompts = await checked(root, path.join("com.scaryrawr.pi", "prompts"), "directory");
    if (prompts) {
      for (const entry of await readdir(prompts)) {
        if (!entry.endsWith(".md")) continue;
        try {
          const file = await checked(root, path.join("com.scaryrawr.pi", "prompts", entry), "file");
          if (file) promptPaths.push(file);
        } catch (error) {
          warn(`Skipping prompt ${entry}: ${String(error)}`);
        }
      }
    }
  } catch (error) {
    warn(`Ignoring invalid prompts extension: ${String(error)}`);
  }
  const hookStyle = manifestPath === path.join(root, "plugin.json") ? "copilot" : "codex";
  const hookSources: unknown[] = [];
  const entries =
    plugin.hooks === undefined
      ? hookStyle === "codex"
        ? ["./hooks/hooks.json"]
        : ["./hooks.json", "./hooks/hooks.json"]
      : Array.isArray(plugin.hooks)
        ? plugin.hooks
        : [plugin.hooks];
  for (const entry of entries) {
    try {
      if (typeof entry === "string") {
        if (!entry.startsWith("./")) throw new Error("Hook paths must start with ./");
        const file = await checked(root, entry, "file");
        if (file) hookSources.push(JSON.parse(await readFile(file, "utf8")));
        else if (plugin.hooks !== undefined) warn(`Missing hook file ${entry}`);
      } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        hookSources.push(entry);
      } else throw new Error("Invalid hooks entry");
    } catch (error) {
      warn(`Ignoring hooks component: ${String(error)}`);
    }
  }
  return { root, name: plugin.name, skillPaths, promptPaths, hookSources, hookStyle };
}

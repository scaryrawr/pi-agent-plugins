import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, it } from "vitest";

import { loadPlugin } from "./plugin.js";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(
  manifest: object = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "example",
  },
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-agent-plugins-"));
  roots.push(root);
  await writeFile(path.join(root, "plugin.json"), JSON.stringify(manifest));
  return root;
}

it("discovers only direct valid skills and pi-specific prompts", async () => {
  const root = await fixture();
  for (const name of ["good", "bad", "nested/deep"])
    await mkdir(path.join(root, "skills", name), { recursive: true });
  await writeFile(
    path.join(root, "skills/good/SKILL.md"),
    "---\nname: good\ndescription: A useful skill\n---\n# Good",
  );
  await writeFile(
    path.join(root, "skills/bad/SKILL.md"),
    "---\nname: other\ndescription: Bad name\n---\n",
  );
  await writeFile(
    path.join(root, "skills/nested/deep/SKILL.md"),
    "---\nname: deep\ndescription: Deep\n---\n",
  );
  await mkdir(path.join(root, "com.scaryrawr.pi/prompts"), { recursive: true });
  await writeFile(path.join(root, "com.scaryrawr.pi/prompts/review.md"), "Review this");
  const result = await loadPlugin(root, () => {});
  const canonical = await realpath(root);
  assert.deepEqual(result.skillPaths, [path.join(canonical, "skills/good/SKILL.md")]);
  assert.deepEqual(result.promptPaths, [
    path.join(canonical, "com.scaryrawr.pi/prompts/review.md"),
  ]);
});

it("accepts manifests without $schema and discovers their skills", async () => {
  const root = await fixture({ name: "better-init", skills: ["skills/"], agents: "agents/" });
  await mkdir(path.join(root, "skills/better-init"), { recursive: true });
  await writeFile(
    path.join(root, "skills/better-init/SKILL.md"),
    "---\nname: better-init\ndescription: Bootstrap repository guidance\n---\n# Better Init",
  );
  const warnings: string[] = [];
  const result = await loadPlugin(root, (message) => warnings.push(message));
  assert.deepEqual(result.skillPaths, [
    path.join(await realpath(root), "skills/better-init/SKILL.md"),
  ]);
  assert.deepEqual(warnings, [
    "Ignoring unknown plugin.json field: skills",
    "Ignoring unknown plugin.json field: agents",
  ]);
});

it("rejects invalid manifests before discovering components", async () => {
  for (const manifest of [
    { description: "Missing name" },
    { $schema: null, name: "example" },
    { $schema: "https://example.com/other-schema", name: "example" },
    { $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json", name: "example" },
    { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "Bad-Name" },
    {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "example",
      author: { extra: 1 },
    },
  ]) {
    await assert.rejects(loadPlugin(await fixture(manifest), () => {}));
  }
});

it("ignores unknown manifest fields and malformed extensions", async () => {
  const root = await fixture({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "example",
    extra: true,
    extensions: 1,
  });
  const warnings: string[] = [];
  assert.equal((await loadPlugin(root, (message) => warnings.push(message))).name, "example");
  assert.equal(warnings.length, 2);
});

it("rejects an escaping manifest and isolates escaping skill and prompt entries", async () => {
  const root = await fixture();
  const outside = await fixture();
  await mkdir(path.join(root, "skills/good"), { recursive: true });
  await writeFile(
    path.join(root, "skills/good/SKILL.md"),
    "---\nname: good\ndescription: Valid\n---\n",
  );
  await symlink(path.join(outside, "plugin.json"), path.join(root, "skills/good/extra"));
  await mkdir(path.join(root, "skills/escape"));
  await symlink(path.join(outside, "plugin.json"), path.join(root, "skills/escape/SKILL.md"));
  await mkdir(path.join(root, "com.scaryrawr.pi/prompts"), { recursive: true });
  await symlink(
    path.join(outside, "plugin.json"),
    path.join(root, "com.scaryrawr.pi/prompts/outside.md"),
  );
  const result = await loadPlugin(root, () => {});
  assert.equal(result.skillPaths.length, 1);
  assert.equal(result.promptPaths.length, 0);
  await writeFile(
    path.join(outside, "manifest.json"),
    await readFile(path.join(root, "plugin.json")),
  );
  const { unlink } = await import("node:fs/promises");
  await unlink(path.join(root, "plugin.json"));
  await symlink(path.join(outside, "manifest.json"), path.join(root, "plugin.json"));
  await assert.rejects(loadPlugin(root));
});

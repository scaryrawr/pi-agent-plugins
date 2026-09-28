import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, it } from "vitest";

import { normalizeSource, readMarketplace } from "./marketplace.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-marketplace-"));
  dirs.push(root);
  await mkdir(path.join(root, ".github/plugin"), { recursive: true });
  return root;
}

it("accepts local directories and normalized GitHub repositories, not other remote URLs", () => {
  assert.equal(normalizeSource("./hello", "/tmp"), "/tmp/hello");
  assert.equal(
    normalizeSource("https://github.com/owner/repo.git"),
    "https://github.com/owner/repo",
  );
  for (const source of [
    "https://evil.test/repo",
    "https://github.com/owner/repo/tree/main",
    "git:github.com/owner/repo",
  ])
    assert.throws(() => normalizeSource(source));
});

it("isolates invalid entries and refuses marketplace paths escaping through symlinks or traversal", async () => {
  const root = await fixture();
  const outside = await fixture();
  await mkdir(path.join(root, "plugins/good"), { recursive: true });
  await symlink(outside, path.join(root, "plugins/escape"));
  await writeFile(
    path.join(root, ".github/plugin/marketplace.json"),
    JSON.stringify({
      name: "sample",
      plugins: [
        { name: "good", source: "./plugins/good", description: "Works" },
        { name: "escape", source: "./plugins/escape" },
        { name: "traversal", source: "./../" },
        { name: "remote", source: "https://example.com/remote" },
        { name: "good", source: "./plugins/good" },
      ],
    }),
  );
  const warnings: string[] = [];
  const catalog = await readMarketplace(root, (message) => warnings.push(message));
  assert.equal(catalog.name, "sample");
  assert.deepEqual(
    catalog.plugins.map((p) => p.name),
    ["good"],
  );
  assert.equal(warnings.length, 4);
});

it("rejects marketplace manifests outside the real root", async () => {
  const root = await fixture();
  const outside = await fixture();
  await writeFile(path.join(outside, "marketplace.json"), '{"name":"bad","plugins":[]}');
  await symlink(
    path.join(outside, "marketplace.json"),
    path.join(root, ".github/plugin/marketplace.json"),
  );
  await assert.rejects(readMarketplace(root));
});

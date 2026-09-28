import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, it } from "vitest";

import { configuredSources, readConfig } from "./config.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("reads project config only for trusted projects and resolves relative paths from config location", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-plugin-project-"));
  dirs.push(cwd);
  await mkdir(path.join(cwd, CONFIG_DIR_NAME));
  await writeFile(
    path.join(cwd, CONFIG_DIR_NAME, "pi-agent-plugins.json"),
    JSON.stringify({
      plugins: ["../my-plugin"],
      marketplaces: [{ source: "../catalog", enabled: ["one"] }],
    }),
  );
  const global = await configuredSources(cwd, false);
  const trusted = await configuredSources(cwd, true);
  assert.deepEqual(trusted.plugins, [...global.plugins, path.join(cwd, "my-plugin")]);
  assert.deepEqual(trusted.marketplaces, [
    ...global.marketplaces,
    { source: path.join(cwd, "catalog"), enabled: ["one"] },
  ]);
});

it("malformed marketplace arrays do not disable direct plugins", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-plugin-config-"));
  dirs.push(cwd);
  const file = path.join(cwd, "pi-agent-plugins.json");
  await writeFile(file, JSON.stringify({ plugins: ["./plugin"], marketplaces: false }));
  const config = await readConfig(file, () => {});
  assert.deepEqual(config.plugins, [path.join(cwd, "plugin")]);
  assert.deepEqual(config.marketplaces, []);
});

it("reads marketplace selections relative to config and skips invalid entries independently", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-plugin-config-"));
  dirs.push(cwd);
  const file = path.join(cwd, "pi-agent-plugins.json");
  await writeFile(
    file,
    JSON.stringify({
      plugins: ["./plugin", null],
      marketplaces: [
        { source: "./market", enabled: ["one", "one", "two"] },
        { source: "https://evil.example/repo", enabled: ["bad"] },
        { source: "./broken", enabled: true },
      ],
    }),
  );
  const warnings: string[] = [];
  const config = await readConfig(file, (message) => warnings.push(message));
  assert.deepEqual(config.plugins, [path.join(cwd, "plugin")]);
  assert.deepEqual(config.marketplaces, [
    { source: path.join(cwd, "market"), enabled: ["one", "two"] },
  ]);
  assert.equal(warnings.length, 3);
});

# pi-agent-plugins

Load local [Agent Plugins](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md) directories into [pi](https://github.com/earendil-works/pi). This version supports the **published 1.0.0** format (not the 1.1.0 working draft). Portable skills are exposed through `resources_discover`; portable `mcp.json` servers are validated and registered through Pi's built-in `registerMcpServer` API (Pi 0.99.1 or newer).

## Install

```sh
pi install git:github.com/scaryrawr/pi-agent-plugins
```

Keep Pi's built-in MCP and tool-search extensions enabled. Pi owns MCP connections, OAuth, tool discovery, execution, and shutdown; this loader only adapts the portable configuration. No separate `pi-mcp` or `pi-dynamic-tools` extension is required.

If upgrading, remove `pi-mcp` and `pi-dynamic-tools` from your Pi settings after updating this loader. Native MCP configuration belongs in `<pi agent directory>/mcp.json` under `mcpServers`, or in a trusted project's `.pi/mcp.json`. Legacy flat maps, `.mcp.json`, cwd-level config, `PI_MCP_CONFIG_DIRS`, and `--mcp` are not read by the built-in support. Use `/mcp` or `pi mcp login <server>` instead of `/mcp-login`; old `mcp-oauth/` credentials require a fresh login. Built-in `tool_search` replaces `search_tools` (keyword ranking only, not the old semantic-model mode).

## Configure

Create `<pi agent directory>/pi-agent-plugins.json` for global plugins, or `<project>/.pi/pi-agent-plugins.json` for project plugins (only read when the project is trusted; pi may use a different project config directory name). Direct `plugins` paths must name **existing local directories**, not URLs, archives, or pi package names. Relative paths are resolved relative to the config file. Configured packages are trusted code: review them before adding them.

```json
{
  "plugins": ["/absolute/path/to/my-plugin", "../plugins/other-plugin"],
  "marketplaces": [
    { "source": "https://github.com/scaryrawr/scarypilot", "enabled": ["anti-slop"] },
    { "source": "../local-marketplace", "enabled": ["my-plugin"] }
  ]
}
```

Use `/marketplaces` in pi to add a local marketplace directory or an HTTPS GitHub repository (`https://github.com/owner/repo`), browse its entries, toggle plugins, refresh the cached checkout, or remove a marketplace from global config. New marketplace plugins start **disabled**. A marketplace must contain `.github/plugin/marketplace.json` with `name` and `plugins` entries with `name` and a local `./` `source` path (as in [scarypilot](https://github.com/scaryrawr/scarypilot/blob/main/.github/plugin/marketplace.json)). Only sources inside the real marketplace root are allowed; entries with remote sources or escaping symlinks are skipped. A selected plugin must contain a parseable `plugin.json` with a valid `name` to load. A missing `$schema` is treated as v1.0.0 for compatibility with marketplace packages; an explicit schema other than the v1.0.0 URL is rejected. Other Agent Plugins v1 manifest fields are validated as before. Marketplace failures do not prevent direct plugins or other entries from loading.

GitHub marketplaces are cloned to `<pi agent directory>/marketplaces/<hash-of-URL>` when added via the UI. Startup uses the cached checkout **without network access**; `/marketplaces` → Refresh explicitly pulls changes. If configuring a GitHub URL by hand, add it through the UI once to populate the cache. Local marketplaces read directly from disk. Project marketplace config is honored only in trusted projects; the UI writes global config only. Enabling, disabling, refreshing, or removing plugins takes effect after `/reload` (including MCP connections). Review marketplace code before enabling: MCP servers run with your permissions. Marketplace discovery is a pi convenience, **not** a portable Agent Plugins v1 component.

Example package:

```text
my-plugin/
├── plugin.json
├── skills/
│   └── explain/
│       └── SKILL.md
├── mcp.json                         # optional
└── com.scaryrawr.pi/
    └── prompts/
        └── review.md               # optional, pi-specific
```

`plugin.json` (the published v1.0.0 specification requires `$schema`; this loader also accepts its omission for compatibility):

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-plugin"
}
```

`mcp.json` (optional; see the [spec](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md#72-mcp-servers)):

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "validator": { "type": "stdio", "command": "./bin/validator" }
  }
}
```

Portable components are discovered **only** at `skills/<name>/SKILL.md` (one level deep) and root `mcp.json`. Missing locations are fine; invalid skills or MCP server entries do not prevent valid siblings from loading. The adapter supports stdio and Streamable HTTP but skips legacy `sse`. Server names contain a sanitized plugin name, a canonical-root identity hash, and a sanitized server name with a name hash, so namesakes and punctuation cannot collide. Tools are named `mcp__<server>__<tool>` and use `deferred` exposure: Pi's built-in `tool_search` loads matching tools on demand. Registered servers appear in `/mcp`; a matching `mcp.json` entry takes precedence. Portable env/header values remain literal (only stdio `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` placeholders expand); they do not gain Pi's shell-command or environment interpolation syntax. MCP subprocesses receive `PLUGIN_ROOT` and persistent `PLUGIN_DATA`; data is stored in `<pi agent directory>/plugin-data/<hash-of-canonical-plugin-root>`. Do not remove this directory if you want to preserve server state across plugin updates. After editing config or package contents, use `/reload` to restart the extension runtime and refresh resources and MCP connections. Pi can replace registrations and disconnect withdrawn servers within a runtime; a new session rebuilds this loader's registrations.

**Prompts are not a portable Agent Plugins v1 component.** This extension adopts the pi-specific namespace `com.scaryrawr.pi/` and loads direct `.md` files from its `prompts/` directory as pi prompt templates. A root-level `prompts/` directory is deliberately ignored. Paths escaping the resolved plugin root via symlinks are ignored. Pi may further validate or deduplicate contributed skills/templates according to its own resource rules.

## Development

```sh
npm install
npm run build
npm run lint
npm run test
npm run fmt:check
```

`npm install` requires access to the configured npm registry. There are no Git dependencies or bundled MCP transports.

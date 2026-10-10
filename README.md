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

Use `/marketplaces` in pi to add a local marketplace directory or an HTTPS GitHub repository (`https://github.com/owner/repo`), browse its entries, toggle plugins, refresh the cached checkout, or remove a marketplace from global config. New marketplace plugins start **disabled**. A marketplace must contain `.github/plugin/marketplace.json` (as in [scarypilot](https://github.com/scaryrawr/scarypilot/blob/main/.github/plugin/marketplace.json)) or, when that is absent, Codex's `.agents/plugins/marketplace.json` (as in [scarydex](https://github.com/scaryrawr/scarydex)). Both need `name` and `plugins` entries with `name` and a local `./` source: either `"source": "./plugins/my-plugin"` or Codex's `"source": { "source": "local", "path": "./plugins/my-plugin" }`. Only sources inside the real marketplace root are allowed; entries with remote sources or escaping symlinks are skipped. A selected plugin must contain a parseable root `plugin.json` or, when absent, `.codex-plugin/plugin.json` with a valid `name` to load. Skills still load only from the plugin root's `skills/`; Codex interface metadata and custom skill component paths are not activated; plugin hooks are adapted as described below. Existing invalid or escaping primary manifests are rejected, not bypassed via fallback paths. A missing `$schema` is treated as v1.0.0 for compatibility with marketplace packages; an explicit schema other than the v1.0.0 URL is rejected. Other Agent Plugins v1 manifest fields are validated as before. Marketplace failures do not prevent direct plugins or other entries from loading.

For ScaryDex, use `/marketplaces` → Add marketplace → `https://github.com/scaryrawr/scarydex`, then select the marketplace to enable individual plugins. A previous failed add that left a cached clone can simply be retried; the clone is reused and the config is saved after successful catalog validation.

GitHub marketplaces are cloned to `<pi agent directory>/marketplaces/<hash-of-URL>` when added via the UI. Startup uses the cached checkout **without network access**; `/marketplaces` → Refresh explicitly pulls changes. If configuring a GitHub URL by hand, add it through the UI once to populate the cache. Local marketplaces read directly from disk. Project marketplace config is honored only in trusted projects; the UI writes global config only. Enabling, disabling, refreshing, or removing plugins takes effect after `/reload` (including MCP connections). Review marketplace code before enabling: MCP servers and hook commands run with your permissions. Marketplace discovery is a pi convenience, **not** a portable Agent Plugins v1 component.

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

## Plugin hooks (best effort)

The loader adapts [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference) and [Codex hooks](https://learn.chatgpt.com/docs/hooks), not repository/user hook settings from either application. Root `plugin.json` selects Copilot defaults (`hooks.json` and `hooks/hooks.json`); `.codex-plugin/plugin.json` selects Codex defaults (`hooks/hooks.json`). A manifest `hooks` field replaces those defaults and accepts a `./`-prefixed file path, an inline hooks object, or an array of either. Hook config files and symlinks must remain inside the real plugin root. Invalid files/handlers are skipped independently of skills, prompts, MCP, and other hooks.

**Adding a direct plugin or enabling a marketplace plugin trusts its hook commands, including future edits/refreshes.** This loader does not implement Codex's per-definition hash review, either application's sandbox, or enterprise policy enforcement. Commands run on the host with your permissions and can read prompts, tool arguments/results, and the Pi transcript. Review code before enabling; disable the plugin and `/reload` to stop its hooks. `disableAllHooks: true` skips an individual hook source.

Example Copilot `hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "matcher": "bash",
        "bash": "python3 \"$PLUGIN_ROOT/hooks/check.py\"",
        "timeoutSec": 30
      }
    ]
  }
}
```

Equivalent Codex `hooks/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"$PLUGIN_ROOT/hooks/check.py\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

| Hook                                        | Pi mapping and supported effects                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionStart` / `SessionStart`             | `session_start`: extra model context; Codex also receives `source: compact` after compaction                                                                      |
| `sessionEnd` / `SessionEnd`                 | `session_shutdown`, including reload/session replacement; advisory output only                                                                                    |
| `userPromptSubmitted` / `UserPromptSubmit`  | `input`, before Pi template expansion; Codex can reject input or add context; Copilot command output is ignored                                                   |
| `userPromptTransformed`                     | `input` after submit hooks: nonempty `modifiedTransformedPrompt` rewrites input, including its displayed text (not a separate persisted model-only transform)     |
| `preToolUse` / `PreToolUse`                 | `tool_call`: deny, ask via UI (deny without UI), argument replacement validated against Pi's tool schema, extra context                                           |
| `postToolUse` / `PostToolUse`               | `tool_result`: Copilot result replacement/context; Codex feedback replaces the completed result, never undoes side effects                                        |
| `postToolUseFailure` / `PostToolUseFailure` | Failed `tool_result`; Codex `PostToolUse` also sees failures                                                                                                      |
| `agentStop` / `Stop`                        | `agent_before_settle`: continuation with reason, at most eight per submitted input; `stop_hook_active` indicates prior continuation; Codex `continue: false` wins |
| `preCompact` / `PreCompact`                 | `session_before_compact`: manual/auto trigger; only Codex can cancel with `continue: false`                                                                       |
| `PostCompact`                               | `session_compact`: additional context; cannot cancel completed compaction or stop Pi recovery                                                                     |
| `Interrupt`                                 | Aborted `agent_before_settle`: advisory only                                                                                                                      |
| `errorOccurred` / `ErrorOccurred`           | Tool failures, failed compactions, and failed settlement (generic agent error); not every internal Pi error                                                       |
| `notification` / `Notification`             | `ui_prompt_start` approximated as `elicitation_dialog`; no shell/background-agent notification coverage                                                           |

Only synchronous **command** handlers are supported, including Copilot `exec`/`args`, platform shell overrides, `cwd`, literal `env`, and seconds-based timeouts. HTTP, MCP-tool, prompt/agent, background handlers, `PermissionRequest`, and subagent events are warned and skipped: Pi has no equivalent native permission service or subagent lifecycle. No hooks run for interactive `!` shell commands. Commands invoked by hooks do not recursively trigger tool hooks. Pi nested tool calls do trigger tool hooks.

Copilot camelCase event names receive camelCase payloads and anchored regex matching against Pi tool names. PascalCase/Codex events receive snake_case payloads and match Pi names or aliases (`bash` → `Bash`, `read` → `Read`, `write` → `Write`, `edit` → `Edit`, `grep` → `Grep`, `find` → `Glob`). Codex regexes are unanchored unless explicitly anchored. MCP tools keep Pi's registered names. Tool input remains Pi-native (for example `path`, not `file_path`); transcripts remain Pi JSONL, not Copilot/Codex transcripts. Turn IDs and permission modes are not fabricated.

Copilot handlers execute in declaration order; matching Codex handlers start concurrently and merge in declaration order. Any denial wins. Copilot `preToolUse` command errors fail closed, except timeouts; Codex errors fail open except explicit exit `2` decisions. All timeouts fail open and warn. Defaults are 30 seconds for Copilot and 600 seconds for Codex, with Codex session-end/interrupt defaults of 1 second and a 3-second cap. Output is limited to 1 MiB per invocation and aggregated context to 10,000 characters; oversized output terminates the hook. Copilot progress JSON lines are stripped before parsing the final JSON. No output spilling or `additionalContextLimit` support is implemented.

Hook processes receive `PLUGIN_ROOT`, `PLUGIN_DATA`, `COPILOT_PLUGIN_ROOT/DATA`, and `CLAUDE_PLUGIN_ROOT/DATA`; data uses the same persistent directory as MCP. Shell hooks can use `$PLUGIN_ROOT`; `env` and direct-exec arguments are literal, with no config-value expansion. Default cwd is Pi's session cwd; explicit cwd is resolved relative to it. Processes are cancelled on operation abort and runtime shutdown (POSIX process groups; direct child on Windows). Context is injected as custom Pi messages rather than overwriting the system prompt.

## Development

```sh
npm install
npm run build
npm run lint
npm run test
npm run fmt:check
```

`npm install` requires access to the configured npm registry. There are no Git dependencies or bundled MCP transports.

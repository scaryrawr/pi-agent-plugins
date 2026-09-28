# pi-agent-plugins

This TypeScript/ESM pi extension loads explicitly configured Agent Plugins 1.0.0 directories. Keep portable manifest/skill discovery and path containment in `src/plugin.ts`, config and trust handling in `src/config.ts`, and pi lifecycle/MCP delegation in `src/index.ts`. `pi-mcp` owns MCP parsing, validation and connections; do not duplicate its transport code. Do not treat portable `prompts/` as a v1 component: the pi-only path is `com.scaryrawr.pi/prompts/`.

Run `npm run build && npm run lint && npm run test && npm run fmt:check` for changes. Use `.js` relative TypeScript imports and update README examples when configuration behavior changes. Keep independent component failures isolated, and never follow package paths outside the real plugin root.

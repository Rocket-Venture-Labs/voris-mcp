# @voris-ai/mcp

`voris-mcp` — a thin **stdio ⇄ HTTPS** proxy that connects a local MCP client (Claude Desktop, an editor agent, a CLI) to the hosted **Voris MCP server** at `https://mcp.voris.ai/mcp`.

It forwards JSON-RPC messages verbatim between the client's stdio channel and the hosted endpoint over Streamable HTTP. It contains **no tool logic and no database access** — all enforcement (authentication, scopes, rate limits, audit) lives in the hosted server. One connection is scoped to exactly one site, by your key.

## Usage

Your MCP client launches `voris-mcp` as a subprocess and speaks MCP over its stdin/stdout. Provide your key via the environment:

```
VORIS_API_KEY=vor_mcp_… voris-mcp
```

Example Claude Desktop configuration:

```json
{
  "mcpServers": {
    "voris": {
      "command": "voris-mcp",
      "env": { "VORIS_API_KEY": "vor_mcp_…" }
    }
  }
}
```

### Options

- **`VORIS_API_KEY`** (required) — your Voris MCP connection key, generated in **Settings → AI Connections**. It is sent as `Authorization: Bearer …` to the hosted endpoint. If it is unset, `voris-mcp` writes a message to stderr and exits with code `1`.
- **`--endpoint <url>`** — override the hosted endpoint (default `https://mcp.voris.ai/mcp`). Mainly for local development; also accepts `--endpoint=<url>`.

All diagnostics are written to **stderr**; stdout carries only the MCP protocol stream, so it stays clean for the client.

## Status

**This release does not publish `voris-mcp` to npm.** The package is built and tarball-tested here; public npm distribution ships in the next phase (A042). Until then, generate your key and copy the hosted-connection snippet from the Voris dashboard.

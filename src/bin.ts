#!/usr/bin/env node
// The `voris-mcp` CLI entry (spec A041 T38). A thin wrapper over bridge.ts: resolve config from
// argv+env, wire the local stdio transport to the hosted HTTPS transport, and forward JSON-RPC
// verbatim. ALL diagnostics go to stderr — stdout stays a clean MCP stdio channel for the client.
// No tool logic, no database access (ADR-082 §c). Published in A042, not A041.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { resolveBridgeConfig, buildRemoteTransport, runBridge } from "./bridge.js"

function fail(message: string): never {
  process.stderr.write(`voris-mcp: ${message}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  const config = resolveBridgeConfig(process.argv.slice(2), process.env)
  if (!config.ok) fail(config.message)

  const local = new StdioServerTransport()
  const remote = buildRemoteTransport(config.endpoint, config.apiKey)
  await runBridge(local, remote, (where, err) => {
    process.stderr.write(`voris-mcp: ${where}: ${err instanceof Error ? err.message : String(err)}\n`)
  })
}

main().catch((err) => fail(`fatal: ${err instanceof Error ? err.message : String(err)}`))

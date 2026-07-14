/**
 * STAGED public-repo smoke (ADR-093). Synced to the public bridge repo as
 * src/__tests__/smoke.test.ts and run by release.yml before publish (`npm run test:smoke`).
 *
 * A LAYOUT-AGNOSTIC port of the monorepo's packages/mcp integration tarball smoke
 * (spec A042 T59): the monorepo copy uses pnpm + a 5-deep REPO_ROOT and is the CI
 * gate there; THIS copy uses npm + a 2-deep root so it runs in the standalone public
 * repo (no pnpm workspace). Same contract: build -> `npm pack` -> `npm install` the
 * tarball into a clean scratch dir (from disk, no registry), then drive the INSTALLED
 * dist/bin.js as a real MCP client against a LOCAL stateless Streamable-HTTP stub
 * (no upstream, no network, no Docker). Proves the published bin launches, wires
 * stdio<->HTTP, forwards initialize -> tools/list -> resources/list verbatim, keeps
 * stdout to JSON-RPC frames only, and fails closed without a key.
 *
 * NOT the real catalog: @voris/mcp is a pure proxy (ADR-082 §c); the stub stands in
 * for "some upstream". Real-catalog fidelity is the hosted server's job.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execSync, spawn } from "node:child_process"
import { mkdtempSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { ListToolsRequestSchema, ListResourcesRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

// Standalone repo root: src/__tests__ -> src -> root (two up), vs the monorepo's five.
const REPO_ROOT = resolve(import.meta.dirname, "..", "..")

const STUB_TOOLS = [
  { name: "voris_query_metrics", description: "stub", inputSchema: { type: "object" as const } },
  { name: "voris_get_tracking_plan", description: "stub", inputSchema: { type: "object" as const } },
]
const STUB_RESOURCES = [
  { uri: "voris://catalog/integrity", name: "catalog-integrity", mimeType: "application/json" },
  { uri: "voris://site/tracking-plan", name: "tracking-plan", mimeType: "application/json" },
]

function buildStubServer(): Server {
  const server = new Server({ name: "voris-mcp-stub", version: "0.0.0" }, { capabilities: { tools: {}, resources: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: STUB_TOOLS }))
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: STUB_RESOURCES }))
  return server
}

/** Spawn the installed bin raw; resolve early on a stdout/stderr predicate, else at waitMs. */
function rawCliSession(
  binJs: string,
  endpoint: string,
  apiKey: string | undefined,
  stdinLines: string[],
  waitMs: number,
  resolveWhen?: (stdout: string, stderr: string) => boolean,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [binJs, "--endpoint", endpoint], {
      env: {
        PATH: process.env["PATH"] ?? "",
        ...(apiKey !== undefined ? { VORIS_API_KEY: apiKey } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolvePromise({ stdout, stderr, exitCode: child.exitCode })
    }
    child.on("exit", finish)
    const killAndFinish = () => {
      if (settled) return
      child.kill()
      setTimeout(finish, 500)
    }
    const maybeEarly = () => {
      if (resolveWhen?.(stdout, stderr)) killAndFinish()
    }
    child.stdout.on("data", (d) => {
      stdout += String(d)
      maybeEarly()
    })
    child.stderr.on("data", (d) => {
      stderr += String(d)
      maybeEarly()
    })
    for (const line of stdinLines) child.stdin.write(`${line}\n`)
    setTimeout(killAndFinish, waitMs)
  })
}

describe("@voris/mcp publish smoke (packed bin, standalone)", () => {
  let binJs: string
  let httpServer: http.Server
  let endpoint: string

  beforeAll(async () => {
    // Build -> pack -> install the tarball into a clean scratch dir (from disk, no registry).
    execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" })
    const packDest = mkdtempSync(join(tmpdir(), "voris-mcp-pack-"))
    const packOut = execSync(`npm pack --pack-destination "${packDest}"`, { cwd: REPO_ROOT, encoding: "utf-8" })
    const tarball = packOut
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .findLast((l) => l.endsWith(".tgz"))
    if (!tarball) throw new Error(`pack produced no tarball path:\n${packOut}`)
    const tarballPath = tarball.startsWith("/") ? tarball : join(packDest, tarball)

    const scratch = mkdtempSync(join(tmpdir(), "voris-mcp-install-"))
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ private: true }))
    execSync(`npm install "${tarballPath}" --no-audit --no-fund --prefer-offline --loglevel=error`, {
      cwd: scratch,
      stdio: "pipe",
    })
    binJs = join(scratch, "node_modules/@voris/mcp/dist/bin.js")
    if (!existsSync(binJs)) throw new Error(`installed bin missing at ${binJs}`)

    // Local stateless Streamable-HTTP stub the packed bridge proxies to (fresh Server +
    // transport per POST, sessionIdGenerator undefined, enableJsonResponse true).
    httpServer = http.createServer((req, res) => {
      void (async () => {
        if (req.method !== "POST") {
          res.writeHead(405).end("Method Not Allowed")
          return
        }
        const server = buildStubServer()
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        })
        res.on("close", () => {
          void transport.close()
          void server.close()
        })
        try {
          await server.connect(transport)
          await transport.handleRequest(req, res)
        } catch (err) {
          if (!res.headersSent) res.writeHead(500).end(String(err))
        }
      })()
    })
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()))
    endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`
  }, 180_000)

  afterAll(async () => {
    httpServer?.closeAllConnections?.()
    await new Promise<void>((r) => (httpServer ? httpServer.close(() => r()) : r()))
  })

  it("the installed bin completes initialize → tools/list → resources/list through the packed bridge", async () => {
    const client = new Client({ name: "voris-mcp-publish-smoke", version: "0.0.1" })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [binJs, "--endpoint", endpoint],
      env: { PATH: process.env["PATH"] ?? "", VORIS_API_KEY: "vor_mcp_dummy" },
      stderr: "pipe",
    })
    try {
      await client.connect(transport)
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual(STUB_TOOLS.map((t) => t.name).sort())
      const { resources } = await client.listResources()
      expect(resources.map((r) => r.uri).sort()).toEqual(STUB_RESOURCES.map((r) => r.uri).sort())
    } finally {
      await client.close()
    }
  }, 60_000)

  it("subprocess stdout carries only JSON-RPC protocol frames; diagnostics go to stderr", async () => {
    const initFrame = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "frames-probe", version: "0" } },
    })
    const session = await rawCliSession(binJs, endpoint, "vor_mcp_dummy", [initFrame], 8_000, (out) =>
      out.includes('"serverInfo"'),
    )
    const lines = session.stdout.split("\n").filter((l) => l.trim().length > 0)
    expect(lines.length, "no protocol frames reached stdout").toBeGreaterThan(0)
    for (const line of lines) {
      const frame = JSON.parse(line) as { jsonrpc?: string }
      expect(frame.jsonrpc, `non-protocol stdout line: ${line}`).toBe("2.0")
    }
  }, 30_000)

  it("a missing VORIS_API_KEY fails closed: empty stdout, stderr diagnostic, exit 1", async () => {
    const misconfigured = await rawCliSession(binJs, endpoint, undefined, [], 5_000)
    expect(misconfigured.stdout).toBe("")
    expect(misconfigured.stderr).toContain("VORIS_API_KEY is not set")
    expect(misconfigured.exitCode).toBe(1)
  }, 30_000)
})

// The @voris/mcp bridge core (spec A041 T38, ADR-082 §c). A message-level stdio⇄HTTPS proxy:
// forward JSON-RPC VERBATIM between the local MCP client (stdio) and the hosted Voris MCP server
// (Streamable HTTP). NO tool logic, NO database access — all enforcement lives in the hosted
// server. Kept free of process/exit side effects so it is fully unit-testable (bin.ts is the
// thin CLI wrapper that owns argv/env/stderr/exit).
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport, FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"

/** The hosted endpoint the CLI proxies to when --endpoint is not supplied (plan §3). */
export const DEFAULT_ENDPOINT = "https://mcp.voris.ai/mcp"

export type BridgeConfig =
  | { ok: true; apiKey: string; endpoint: URL }
  | { ok: false; message: string }

/** Where a diagnostic came from + the error — the sink writes it to stderr (stdout stays clean). */
export type BridgeErrorSink = (where: string, err: unknown) => void

/** `--endpoint <url>` or `--endpoint=<url>`; undefined when the flag is absent. */
function parseEndpointArg(argv: readonly string[]): string | undefined {
  const eq = argv.find((a) => a.startsWith("--endpoint="))
  if (eq) return eq.slice("--endpoint=".length)
  const i = argv.indexOf("--endpoint")
  if (i !== -1) return argv[i + 1]
  return undefined
}

/**
 * Resolve the CLI's config from argv + env. `VORIS_API_KEY` is required (missing → a message the
 * caller prints to stderr before exiting 1). `--endpoint` overrides the hosted default; a
 * non-URL value fails closed. Pure — no process/exit side effects, so it is directly testable.
 */
export function resolveBridgeConfig(
  argv: readonly string[],
  env: { VORIS_API_KEY?: string },
): BridgeConfig {
  const apiKey = env.VORIS_API_KEY
  if (!apiKey) {
    return {
      ok: false,
      message:
        "VORIS_API_KEY is not set. Generate a key in Settings > AI Connections and export it as VORIS_API_KEY.",
    }
  }
  const endpointStr = parseEndpointArg(argv) ?? DEFAULT_ENDPOINT
  let endpoint: URL
  try {
    endpoint = new URL(endpointStr)
  } catch {
    return { ok: false, message: `Invalid --endpoint "${endpointStr}" (expected an absolute URL).` }
  }
  return { ok: true, apiKey, endpoint }
}

/**
 * Build the hosted-facing transport: a Streamable HTTP client to `endpoint` that sends the key as
 * `Authorization: Bearer …` on every request (via `requestInit.headers`). `fetchImpl` is injectable
 * so a test can assert the exact bearer the SDK puts on the wire.
 */
export function buildRemoteTransport(
  endpoint: URL,
  apiKey: string,
  fetchImpl?: FetchLike,
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
}

/**
 * Wire two transports into a bidirectional verbatim pipe: every message from `local` (the MCP
 * client over stdio) is forwarded to `remote` (the hosted server) and vice versa, unmodified. A
 * close on either side tears down the other (guarded so the reciprocal onclose can't loop). A
 * forward-send failure is reported to `onError` — the bridge never crashes on a transient hiccup.
 * Callbacks are installed BEFORE start() (Transport contract), and `remote` starts first so it can
 * accept the client's opening `initialize` the moment stdin delivers it.
 */
export async function runBridge(
  local: Transport,
  remote: Transport,
  onError?: BridgeErrorSink,
): Promise<void> {
  let closing = false
  const shutdown = () => {
    if (closing) return
    closing = true
    void local.close().catch((e) => onError?.("local.close", e))
    void remote.close().catch((e) => onError?.("remote.close", e))
  }

  local.onmessage = (msg) => void remote.send(msg).catch((e) => onError?.("remote.send", e))
  remote.onmessage = (msg) => void local.send(msg).catch((e) => onError?.("local.send", e))
  local.onclose = shutdown
  remote.onclose = shutdown
  local.onerror = (e) => onError?.("local", e)
  remote.onerror = (e) => onError?.("remote", e)

  await remote.start()
  await local.start()
}

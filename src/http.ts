// Opt-in stateless Streamable HTTP transport (`jev-browser --http`).
//
// Serves MCP 2026-07-28 per request and 2025-era clients through the SDK's
// stateless fallback: no sessions, no Mcp-Session-Id, nothing held between
// requests, so any number of replicas can sit behind a plain load balancer.
import { createServer as createNodeServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

// Fixed-string rejection: never echo the rejected Host/Origin back (reflection
// of attacker-controlled values), unlike the SDK's guards.
const FORBIDDEN_BODY = JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden" }, id: null });
function forbidden(res: import("node:http").ServerResponse) {
  res.writeHead(403, { "content-type": "application/json" }).end(FORBIDDEN_BODY);
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  let hostname = host.toLowerCase();
  const bracketed = hostname.match(/^\[(.+)\](?::\d+)?$/);
  if (bracketed) hostname = bracketed[1];
  else hostname = hostname.replace(/:\d+$/, "");
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}

export async function serveHttp(factory: () => McpServer, env: NodeJS.ProcessEnv = process.env) {
  // Loopback by default: binding a public interface is an explicit act.
  const host = env.HOST || "127.0.0.1";
  const port = Number(env.PORT || 8080);
  const token = Buffer.from(env.JEV_BROWSER_AUTH_TOKEN ?? "");
  // Each admitted request drives a full headless-browser run (its own Chromium
  // for up to the caller's time budget), so the default cap is far below the
  // API-only jev-mcp: shedding load beats OOM-ing the host on browser memory.
  const maxInFlight = Number(env.JEV_BROWSER_MAX_CONCURRENCY ?? 4);
  // The server spends the operator's Jev key and drives credential-guarded
  // browser sessions; never expose it unauthenticated.
  if (token.length === 0 && !LOOPBACK.has(host)) {
    throw new Error("JEV_BROWSER_AUTH_TOKEN is required when HTTP mode binds a non-loopback HOST");
  }
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new Error("JEV_BROWSER_MAX_CONCURRENCY must be a positive integer");
  }

  const authorized = (header: string | undefined) => {
    if (token.length === 0) return true;
    const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
    return given.length === token.length && timingSafeEqual(given, token);
  };

  // On loopback, reject foreign Host/Origin headers so a web page cannot reach
  // the server through DNS rebinding (the spec's Origin-validation MUST).
  const onLoopback = LOOPBACK.has(host);

  const mcp = toNodeHandler(
    createMcpHandler(factory, {
      // The tool list never changes: refuse subscriptions/listen in-band
      // instead of letting a client park an idle SSE stream on a slot.
      maxSubscriptions: 0,
      onerror: (error) => console.error(`[jev-browser] http: ${error.message}`),
    }),
    {
      onerror: (error) => console.error(`[jev-browser] http: ${error.message}`),
    },
  );

  let inFlight = 0;
  const server = createNodeServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    } else if (path !== "/mcp") {
      res.writeHead(404).end();
    } else if (onLoopback && (!isLoopbackHost(req.headers.host) || !isLoopbackOrigin(req.headers.origin))) {
      forbidden(res);
    } else if (!authorized(req.headers.authorization)) {
      res.writeHead(401, { "www-authenticate": "Bearer" }).end();
    } else if (inFlight >= maxInFlight) {
      // Backpressure: each in-flight request runs a browser and may spend the
      // operator's Jev key; shed load instead of queueing it.
      res.writeHead(429, { "retry-after": "1" }).end();
    } else {
      inFlight++;
      void mcp(req, res)
        .catch((error) => {
          // toNodeHandler reports its own failures through onerror; a promise
          // rejection here must not become an unhandled one that kills Node.
          console.error(`[jev-browser] http: ${(error as Error)?.message ?? error}`);
          res.destroy();
        })
        .finally(() => inFlight--);
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const { port: bound, address: boundAddress } = server.address() as AddressInfo;
  // "localhost" must actually resolve to loopback; a poisoned resolver must not
  // silently turn a loopback bind into a public one.
  if (onLoopback && boundAddress !== "127.0.0.1" && boundAddress !== "::1" && boundAddress !== "::ffff:127.0.0.1") {
    server.close();
    throw new Error(`HOST ${host} resolved to non-loopback ${boundAddress}; refusing to serve`);
  }
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { server, url: `http://${host.includes(":") ? `[${host}]` : host}:${bound}/mcp` };
}

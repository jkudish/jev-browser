// Network guard: refuses loopback / private / link-local / cloud-metadata addresses
// for the browser (start URL, redirects, subresources, iframes). Node-side
// fetches (e.g. decision calls to a local service) never pass through here.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

export const ALLOW_ENV = "JEV_BROWSER_ALLOW_PRIVATE_HOSTS";

export type Resolver = (host: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (host) => {
  const rows = await lookup(host, { all: true, verbatim: true });
  return rows.map((r) => r.address);
};

export interface AllowList {
  hosts: Set<string>;
  ports: Set<string>;
  hostPorts: Set<string>;
}

function normHost(h: string): string {
  let s = h.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  while (s.endsWith(".")) s = s.slice(0, -1);
  return s;
}

/**
 * Comma-separated entries: `host` (exact match, no wildcards/subdomains) or `host:port`.
 * A bare port (e.g. `5000`) is rejected: it would open that port on EVERY host, including
 * metadata and LAN addresses. Write `127.0.0.1:5000` instead.
 */
export function parseAllowList(raw: string | undefined = process.env[ALLOW_ENV]): AllowList {
  const out: AllowList = { hosts: new Set(), ports: new Set(), hostPorts: new Set() };
  for (const part of (raw ?? "").split(",")) {
    const e = part.trim().toLowerCase();
    if (!e) continue;
    if (/^\d+$/.test(e)) {
      throw new Error(
        `${ALLOW_ENV}: bare port "${e}" is not allowed (it would open that port on every host); write host:port, e.g. 127.0.0.1:${e}`,
      );
    } else if (/^\[.*\]:\d+$/.test(e) || /^[^:[\]]+:\d+$/.test(e)) {
      const i = e.lastIndexOf(":");
      out.hostPorts.add(`${normHost(e.slice(0, i))}:${e.slice(i + 1)}`);
    } else out.hosts.add(normHost(e));
  }
  return out;
}

/** Parse legacy inet_aton forms (decimal, hex, octal, 1-4 parts). Returns 4 bytes or null. */
export function parseLegacyIPv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length > 4 || parts.some((p) => p === "")) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^\d+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums[nums.length - 1];
  const head = nums.slice(0, -1);
  if (head.some((n) => n > 255)) return null;
  if (last >= 256 ** (4 - head.length)) return null;
  let value = last;
  head.forEach((n, i) => {
    value += n * 256 ** (3 - i);
  });
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

/** The host's own interface addresses, as normalized keys (fresh each call; interfaces change). */
function localAddressKeys(): Set<string> {
  const keys = new Set<string>();
  try {
    for (const rows of Object.values(networkInterfaces())) {
      for (const r of rows ?? []) {
        const addr = r.address.split("%")[0];
        if (isIP(addr) === 4) keys.add(addr);
        else {
          const g = parseIPv6(addr);
          if (g) keys.add(g.join(":"));
        }
      }
    }
  } catch {
    // interface enumeration unavailable: nothing extra to block
  }
  return keys;
}

function blockedV4(b: number[]): string | null {
  const [a, c] = b;
  if (a === 0) return "unspecified/this-network (0.0.0.0/8)";
  if (a === 127) return "loopback (127.0.0.0/8)";
  if (a === 10) return "private (10.0.0.0/8)";
  if (a === 172 && c >= 16 && c <= 31) return "private (172.16.0.0/12)";
  if (a === 192 && c === 168) return "private (192.168.0.0/16)";
  if (a === 169 && c === 254) return "link-local/cloud metadata (169.254.0.0/16)";
  if (a === 100 && c >= 64 && c <= 127) return "carrier-grade NAT (100.64.0.0/10)";
  if (a === 198 && (c === 18 || c === 19)) return "benchmarking (198.18.0.0/15)";
  if (a === 192 && c === 0 && b[2] === 0) return "IETF protocol assignments (192.0.0.0/24)";
  if (a >= 224) return "multicast/reserved (224.0.0.0/3)";
  if (localAddressKeys().has(b.join("."))) return "this host's own interface address";
  return null;
}

/** Expand an IPv6 literal into 8 16-bit groups, or null if invalid. */
export function parseIPv6(host: string): number[] | null {
  let s = host.split("%")[0];
  if (isIP(s) !== 6) return null;
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const b = m[2].split(".").map(Number);
    s = `${m[1]}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const [l, r] = s.split("::");
  const left = l ? l.split(":") : [];
  const right = r ? r.split(":") : [];
  const fill = s.includes("::") ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(fill).fill("0"), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : null;
}

function blockedV6(g: number[]): string | null {
  if (g.every((x) => x === 0)) return "unspecified (::)";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback (::1)";
  const v4 = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  const inner = blockedV4(v4);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return inner && `IPv4-mapped ${inner}`;
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return inner && `IPv4-translated ${inner}`;
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return "local-use NAT64 (64:ff9b:1::/48)";
  if (g[0] === 0x2001 && g[1] === 0) return "Teredo (2001::/32)";
  if (localAddressKeys().has(g.join(":"))) return "this host's own interface address";
  if (g.slice(0, 6).every((x) => x === 0)) return inner && `IPv4-compatible ${inner}`;
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return inner && `NAT64 ${inner}`;
  if ((g[0] & 0xfe00) === 0xfc00) return "unique-local (fc00::/7)";
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local (fe80::/10)";
  if ((g[0] & 0xffc0) === 0xfec0) return "site-local (fec0::/10)";
  if ((g[0] & 0xff00) === 0xff00) return "multicast (ff00::/8)";
  if (g[0] === 0x2002) {
    const r = blockedV4([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255]);
    return r && `6to4 ${r}`;
  }
  return null;
}

export type HostVerdict = { blocked: boolean; reason?: string; host: string; literal: boolean };

/** Classify a host string (as in a URL host, possibly bracketed or with userinfo) WITHOUT DNS. */
export function classifyHost(rawHost: string): HostVerdict {
  const host = normHost(rawHost.includes("@") ? rawHost.slice(rawHost.lastIndexOf("@") + 1) : rawHost);
  if (!host) return { blocked: true, reason: "empty host", host, literal: false };
  if (host === "localhost" || host.endsWith(".localhost")) return { blocked: true, reason: "localhost", host, literal: false };
  if (host.includes(":")) {
    const v6 = parseIPv6(host);
    if (!v6) return { blocked: true, reason: "unparseable IPv6 host", host, literal: true };
    const r = blockedV6(v6);
    return { blocked: !!r, reason: r ?? undefined, host, literal: true };
  }
  const v4 = parseLegacyIPv4(host);
  if (v4) {
    const r = blockedV4(v4);
    return { blocked: !!r, reason: r ?? undefined, host, literal: true };
  }
  if (/^(0x[0-9a-f]*|\d+)$/i.test(host.split(".").pop() ?? "")) {
    return { blocked: true, reason: "malformed numeric IPv4 host", host, literal: true };
  }
  return { blocked: false, host, literal: false };
}

function allowed(host: string, port: string, list: AllowList): boolean {
  return list.hosts.has(host) || list.ports.has(port) || list.hostPorts.has(`${host}:${port}`);
}

export class BlockedAddressError extends Error {
  constructor(
    public url: string,
    public reason: string,
  ) {
    super(
      `jev-browser blocked ${url}: ${reason}. Set ${ALLOW_ENV} (comma-separated exact hosts or host:port entries) to allow deliberate local testing.`,
    );
    this.name = "BlockedAddressError";
  }
}

/** Throws BlockedAddressError unless the URL is public (or allow-listed). */
export async function assertUrlAllowed(
  rawUrl: string,
  opts: { resolver?: Resolver; allow?: AllowList } = {},
): Promise<void> {
  const allow = opts.allow ?? parseAllowList();
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new BlockedAddressError(rawUrl, "invalid URL");
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return; // data:, blob:, about: never touch the network
  const port = u.port || (u.protocol === "https:" || u.protocol === "wss:" ? "443" : "80");
  const verdict = classifyHost(u.hostname);
  if (allowed(verdict.host, port, allow)) return;
  if (verdict.blocked) throw new BlockedAddressError(rawUrl, verdict.reason ?? "blocked host");
  if (verdict.literal) return; // public IP literal
  let addrs: string[];
  try {
    addrs = await (opts.resolver ?? defaultResolver)(verdict.host);
  } catch {
    // Fail closed: with a proxy-less (injected) page the browser resolves DNS itself and could
    // get a different answer than we could, so an unresolvable name is never waved through.
    throw new BlockedAddressError(rawUrl, `DNS resolution failed for ${verdict.host}`);
  }
  for (const a of addrs) {
    const v = classifyHost(a);
    if (v.blocked) throw new BlockedAddressError(rawUrl, `host ${verdict.host} resolves to ${a}: ${v.reason}`);
  }
}

// ── Filtering proxy ──────────────────────────────────────────────────────────
// Playwright's context.route does not see redirect hops (the network stack
// follows them), and a browser resolves DNS on its own. Routing Chromium
// through this in-process proxy closes both: every hop, including redirects
// and subresources, is validated, and the proxy connects to the exact address
// it validated (no DNS-rebinding window).
import http from "node:http";
import net from "node:net";

// Returns every validated address (in resolver order) so callers can fall back across them
// without a fresh, unchecked lookup.
async function resolveValidated(host: string, port: string, allow: AllowList, resolver: Resolver): Promise<string[]> {
  const h = normHost(host);
  const verdict = classifyHost(h);
  const ok = allowed(verdict.host, port, allow);
  if (verdict.blocked && !ok) throw new BlockedAddressError(`${h}:${port}`, verdict.reason ?? "blocked host");
  if (verdict.literal) {
    if (verdict.blocked || net.isIP(h)) return [h];
    const b = parseLegacyIPv4(h);
    if (b) return [b.join(".")];
    return [h];
  }
  const addrs = await resolver(h);
  if (!addrs.length) throw new Error(`no address for ${h}`);
  if (!ok) {
    for (const a of addrs) {
      const v = classifyHost(a);
      if (v.blocked) throw new BlockedAddressError(`${h}:${port}`, `host ${h} resolves to ${a}: ${v.reason}`);
    }
  }
  return addrs;
}

export interface GuardProxy {
  port: number;
  close(): Promise<void>;
}

export async function startGuardProxy(opts: {
  allow?: AllowList;
  resolver?: Resolver;
  onBlocked?: (message: string) => void;
  /** Per-address CONNECT dial timeout (default 5000ms). */
  connectTimeoutMs?: number;
}): Promise<GuardProxy> {
  const allow = opts.allow ?? parseAllowList();
  const resolver = opts.resolver ?? defaultResolver;
  const sockets = new Set<net.Socket>();
  const blockedOut = (e: unknown, sock: net.Socket | null, res?: http.ServerResponse) => {
    if (e instanceof BlockedAddressError) opts.onBlocked?.(e.message);
    // Reset the connection so the browser reports a failed request (a 403 page would look like a normal load).
    void res;
    sock?.destroy();
  };
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "");
      if (u.protocol !== "http:") throw new BlockedAddressError(req.url ?? "", "unsupported proxy scheme");
      const port = u.port || "80";
      const ip = (await resolveValidated(u.hostname, port, allow, resolver))[0];
      const headers = { ...req.headers };
      delete headers["proxy-connection"];
      const up = http.request(
        { host: ip, port: Number(port), method: req.method, path: u.pathname + u.search, headers: { ...headers, host: u.host } },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          // A truncated upstream body must not look like a complete response to the browser.
          r.on("aborted", () => res.destroy());
          r.on("error", () => res.destroy());
          r.on("close", () => {
            if (!r.complete) res.destroy();
          });
          r.pipe(res);
        },
      );
      up.on("error", () => res.headersSent || res.writeHead(502).end());
      res.on("close", () => up.destroy());
      req.socket.on("close", () => up.destroy());
      req.pipe(up);
    } catch (e) {
      blockedOut(e, req.socket, res);
    }
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.on("connect", async (req, client, head) => {
    // Attach before awaiting DNS: a client reset during resolution must not surface as an unhandled 'error'.
    const connectTimeoutMs = opts.connectTimeoutMs ?? 5_000;
    let clientGone = false;
    let up: net.Socket | null = null;
    client.on("error", () => {
      clientGone = true;
      up?.destroy();
    });
    client.on("close", () => {
      clientGone = true;
      up?.destroy();
    });
    try {
      const i = (req.url ?? "").lastIndexOf(":");
      const host = (req.url ?? "").slice(0, i);
      const port = (req.url ?? "").slice(i + 1) || "443";
      const ips = await resolveValidated(host, port, allow, resolver);
      if (clientGone) return;
      // Try each validated address in turn; never re-resolve.
      for (let n = 0; n < ips.length; n++) {
        const sock = await new Promise<net.Socket | null>((resolve) => {
          const c = net.connect(Number(port), ips[n]);
          sockets.add(c);
          up = c;
          let settled = false;
          const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            client.off("close", onClientGone);
            client.off("error", onClientGone);
            if (!ok) c.destroy();
            resolve(ok ? c : null);
          };
          // Per-address timeout: a blackholed address must not stall the remaining validated ones.
          const timer = setTimeout(() => finish(false), connectTimeoutMs);
          // Settle if the client goes away mid-attempt so the handler never stays suspended.
          const onClientGone = () => finish(false);
          client.once("close", onClientGone);
          client.once("error", onClientGone);
          c.on("close", () => {
            sockets.delete(c);
            finish(false);
          });
          c.once("connect", () => finish(true));
          c.once("error", () => finish(false));
        });
        if (clientGone) {
          sock?.destroy();
          return;
        }
        if (!sock) continue;
        sock.on("error", () => client.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) sock.write(head);
        sock.pipe(client);
        client.pipe(sock);
        return;
      }
      client.destroy();
    } catch (e) {
      if (e instanceof BlockedAddressError) opts.onBlocked?.(e.message);
      if (!client.destroyed) client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

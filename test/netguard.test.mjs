import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { test } from "node:test";
import { assertUrlAllowed, classifyHost, parseAllowList, startGuardProxy } from "../dist/netguard.js";
import { navigate } from "../dist/navigate.js";

const none = parseAllowList("");
const blocked = (h) => assert.equal(classifyHost(h).blocked, true, `${h} should be blocked`);
const open = (h) => assert.equal(classifyHost(h).blocked, false, `${h} should be allowed`);

test("classifier: IPv4 loopback/private/metadata/unspecified", () => {
  for (const h of ["127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "169.254.0.1", "0.0.0.0", "localhost", "LOCALHOST", "foo.localhost", "a.b.localhost"]) blocked(h);
  for (const h of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "example.com", "1.1.1.1"]) open(h);
});

test("classifier: decimal, hex, octal, short and mixed IPv4 forms", () => {
  for (const h of ["2130706433", "0x7f000001", "0x7f.0.0.1", "017700000001", "0177.0.0.1", "127.1", "127.0.1", "0", "0x0", "3232235777", "0xa9fea9fe", "2852039166", "012.1.1.1", "0300.0250.0.1"]) blocked(h);
  open("0x08080808"); // 8.8.8.8
  open("134744072"); // 8.8.8.8
});

test("classifier: IPv6 loopback/ULA/link-local/unspecified", () => {
  for (const h of ["::1", "[::1]", "::", "0:0:0:0:0:0:0:1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "febf::1", "ff02::1"]) blocked(h);
  open("2606:4700:4700::1111");
  open("[2001:4860:4860::8888]");
});

test("classifier: IPv4-mapped / compatible / NAT64 / 6to4 IPv6", () => {
  for (const h of ["::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:10.0.0.1]", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:c0a8:101", "::127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::1", "2002:a9fe:a9fe::"]) blocked(h);
  open("::ffff:8.8.8.8");
  open("::ffff:808:808");
});

test("classifier: trailing dots and userinfo", () => {
  for (const h of ["localhost.", "127.0.0.1.", "foo.localhost.", "evil.com@127.0.0.1", "user:pw@localhost", "a@b@10.0.0.1"]) blocked(h);
  open("example.com.");
  open("127.0.0.1@example.com"); // userinfo is not the host
});

test("assertUrlAllowed: URL parsing tricks resolve to the real host", async () => {
  for (const u of [
    "http://127.0.0.1:4319/health", "http://localhost:4319/", "http://[::1]:80/", "http://0.0.0.0/",
    "http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/", "http://evil.com@127.0.0.1/", "http://127.0.0.1.:80/",
    "http://169.254.169.254/latest/meta-data/", "http://[::ffff:127.0.0.1]/", "http://[fd00::1]/", "http://[fe80::1]/",
    "http://10.0.0.5/", "http://172.20.1.1/", "http://192.168.0.1/", "ws://127.0.0.1:9/", "http://foo.localhost/",
    "http://localhost%2e/", "http://127。0。0。1/",
  ]) await assert.rejects(() => assertUrlAllowed(u, { allow: none, resolver: async () => ["93.184.216.34"] }), /blocked/, u);
  await assertUrlAllowed("http://127.0.0.1@example.com/", { allow: none, resolver: async () => ["93.184.216.34"] });
  await assertUrlAllowed("https://example.com/", { allow: none, resolver: async () => ["93.184.216.34"] });
  await assertUrlAllowed("data:text/html,hi", { allow: none });
});

test("assertUrlAllowed: DNS names resolving to private addresses are refused (stub resolver)", async () => {
  const table = { "rebind.test": ["127.0.0.1"], "meta.test": ["169.254.169.254"], "mixed.test": ["93.184.216.34", "10.0.0.1"], "v6.test": ["::1"], "mapped.test": ["::ffff:192.168.1.1"], "pub.test": ["93.184.216.34", "2606:4700::1111"] };
  const resolver = async (h) => { if (!table[h]) throw new Error("ENOTFOUND"); return table[h]; };
  for (const h of ["rebind.test", "meta.test", "mixed.test", "v6.test", "mapped.test"]) {
    await assert.rejects(() => assertUrlAllowed(`http://${h}/`, { allow: none, resolver }), /resolves to/, h);
  }
  await assertUrlAllowed("http://pub.test/", { allow: none, resolver });
  // Fail closed: an unresolvable name is blocked at the route layer, not waved through.
  await assert.rejects(() => assertUrlAllowed("http://nonexistent.test/", { allow: none, resolver }), /DNS resolution failed/);
});

test("allow list: hosts, ports and host:port, default empty", async () => {
  const resolver = async () => ["127.0.0.1"];
  await assert.rejects(() => assertUrlAllowed("http://127.0.0.1:5000/", { allow: parseAllowList(undefined) }));
  await assertUrlAllowed("http://127.0.0.1:5000/", { allow: parseAllowList("127.0.0.1") });
  await assertUrlAllowed("http://127.0.0.1:5000/", { allow: parseAllowList(" 127.0.0.1:5000 , 127.0.0.1:6000") });
  await assert.rejects(() => assertUrlAllowed("http://127.0.0.1:5001/", { allow: parseAllowList("127.0.0.1:5000") }));
  await assertUrlAllowed("http://localhost:5000/", { allow: parseAllowList("localhost:5000") });
  await assert.rejects(() => assertUrlAllowed("http://localhost:5001/", { allow: parseAllowList("localhost:5000") }));
  await assertUrlAllowed("http://[::1]:7/", { allow: parseAllowList("[::1]:7") });
  await assertUrlAllowed("http://dev.test/", { allow: parseAllowList("dev.test"), resolver });
  await assert.rejects(() => assertUrlAllowed("http://10.0.0.1/", { allow: parseAllowList("127.0.0.1") }));
});

// Judge that records the page state it is shown and immediately declares done,
// so the run loads and captures the page under a realistic time budget.
const doneJudge = (states, before) => ({
  name: "fixture",
  async ask({ state, questions }) {
    if (before) await before;
    states.push(state);
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      answers[id] = q.type === "noul"
        ? { type: "noul", noul: 0 }
        : { type: "choice", choice: "done", confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === "done" ? 1 : 0])) };
    }
    return { answers, usage: { input_tokens: 1, output_tokens: 1 }, model: "fixture" };
  },
});
const judge = { name: "fixture", async ask() { assert.fail("no judgment expected"); } };

test("integration: browser refuses a loopback server by default; allow list opens it", async () => {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.setHeader("content-type", "text/html");
    res.end(req.url === "/redir" ? "" : `<h1>secret</h1><img src="http://127.0.0.1:${server.address().port}/sub.png">`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const saved = process.env.JEV_BROWSER_ALLOW_PRIVATE_HOSTS;
  try {
    delete process.env.JEV_BROWSER_ALLOW_PRIVATE_HOSTS;
    for (const host of ["127.0.0.1", "localhost"]) {
      const r = await navigate({ task: "x", startUrl: `http://${host}:${port}/`, maxSeconds: 0, screenshot: "none", transport: judge });
      assert.equal(r.status, "error");
      assert.match(r.error ?? "", /blocked/);
    }
    assert.deepEqual(hits, [], "server must never be contacted");
  } finally {
    if (saved === undefined) delete process.env.JEV_BROWSER_ALLOW_PRIVATE_HOSTS; else process.env.JEV_BROWSER_ALLOW_PRIVATE_HOSTS = saved;
    server.close();
  }
});

test("integration: public site is still reachable (skipped offline)", async (t) => {
  const online = await fetch("https://example.com/", { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
  if (!online) return t.skip("offline");
  delete process.env.JEV_BROWSER_ALLOW_PRIVATE_HOSTS;
  let asked = false;
  const transport = { name: "fixture", async ask() { asked = true; throw new Error("stop here"); } };
  const r = await navigate({ task: "x", startUrl: "https://example.com/", maxSeconds: 30, maxSteps: 1, screenshot: "none", transport });
  assert.ok(asked, `page must load and reach the judgment step, got ${r.status}: ${r.error}`);
  assert.doesNotMatch(String(r.error), /blocked/);
});

test("integration: subresources, iframes and redirects to a non-allow-listed port are blocked", async () => {
  const secretHits = [];
  const secret = createServer((req, res) => { secretHits.push(req.url); res.end("secret"); });
  await new Promise((r) => secret.listen(0, "127.0.0.1", r));
  const sp = secret.address().port;
  let beaconed; const beacon = new Promise((r) => { beaconed = r; });
  const front = createServer((req, res) => {
    if (req.url === "/beacon") { beaconed(); return res.end("ok"); }
    if (req.url === "/redir") { res.statusCode = 302; res.setHeader("location", `http://127.0.0.1:${sp}/redir`); return res.end(); }
    res.setHeader("content-type", "text/html");
    res.end(`<title>front</title><h1>front ok</h1><img id="i" src="http://127.0.0.1:${sp}/img.png"><iframe src="http://127.0.0.1:${sp}/frame"></iframe><script>const imgDone = new Promise((r) => { const i = document.getElementById("i"); i.onerror = i.onload = r; if (i.complete) r(); }); Promise.all([fetch("http://127.0.0.1:${sp}/xhr").catch(()=>{}), imgDone]).then(() => fetch("/beacon"))</script>`);
  });
  await new Promise((r) => front.listen(0, "127.0.0.1", r));
  const fp = front.address().port;
  const saved = process.env.JEV_BROWSER_ALLOW_PRIVATE_HOSTS;
  process.env.JEV_BROWSER_ALLOW_PRIVATE_HOSTS = `127.0.0.1:${fp}`;
  try {
    const states = [];
    const r = await navigate({ task: "x", startUrl: `http://127.0.0.1:${fp}/`, maxSeconds: 15, maxSteps: 1, screenshot: "none", transport: doneJudge(states, Promise.race([beacon, new Promise((res) => setTimeout(res, 8000))])) });
    assert.equal(r.status, "done", `${r.status}: ${r.error}`);
    assert.match(states[0]?.page_text_excerpt ?? "", /front ok/);
    await new Promise((res) => setTimeout(res, 500));
    assert.deepEqual(secretHits, []);
    assert.ok((r.console_events ?? []).some((e) => e.type === "request_failed" && /BLOCKED_BY_CLIENT/i.test(e.text)), "blocked subresources are reported");
    const red = await navigate({ task: "x", startUrl: `http://127.0.0.1:${fp}/redir`, maxSeconds: 0, screenshot: "none", transport: judge });
    assert.equal(red.status, "error");
    assert.match(red.error ?? "", /blocked .*loopback/);
    assert.deepEqual(secretHits, [], "redirect target must never be contacted");
  } finally {
    if (saved === undefined) delete process.env.JEV_BROWSER_ALLOW_PRIVATE_HOSTS; else process.env.JEV_BROWSER_ALLOW_PRIVATE_HOSTS = saved;
    front.close(); secret.close();
  }
});

test("allow list: bare ports are rejected with a clear error; host entries stay exact-match", async () => {
  for (const raw of ["5000", " 8080 ", "127.0.0.1,5000"]) assert.throws(() => parseAllowList(raw), /bare port .* not allowed.*host:port/, raw);
  parseAllowList("127.0.0.1:5000");
  const resolver = async () => ["93.184.216.34"];
  // exact host only: no subdomain / suffix matching
  await assert.rejects(() => assertUrlAllowed("http://sub.localhost/", { allow: parseAllowList("localhost") }), /blocked/);
  await assertUrlAllowed("http://localhost/", { allow: parseAllowList("localhost"), resolver });
});

test("classifier: benchmarking, IETF, NAT64 local-use, IPv4-translated, Teredo ranges", () => {
  for (const h of ["198.18.0.1", "198.19.255.255", "192.0.0.1", "192.0.0.170", "64:ff9b:1::1", "64:ff9b:1:ffff::1", "::ffff:0:7f00:1", "::ffff:0:a00:1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2"]) blocked(h);
  for (const h of ["198.17.255.255", "198.20.0.1", "192.0.1.1", "::ffff:0:808:808", "2001:db8::1", "2001:1::1"]) open(h);
});

test("classifier: the host's own non-loopback interface addresses are private", () => {
  const own = Object.values(networkInterfaces()).flat().filter(Boolean).map((r) => r.address.split("%")[0]);
  for (const a of own) blocked(a);
  for (const a of own.filter((x) => x.includes("."))) blocked(`::ffff:${a}`);
});

test("navigate: non-http(s) start URLs are refused in the library/CLI path", async () => {
  for (const u of ["file:///etc/passwd", "data:text/html,hi", "blob:http://a/b", "javascript:alert(1)", "ftp://example.com/", "about:blank", "not a url"]) {
    await assert.rejects(() => navigate({ task: "x", startUrl: u, maxSeconds: 0, screenshot: "none", transport: judge }), /startUrl/, u);
  }
});

test("navigate: an injected page is refused unless the unproxied-page opt-in is set", async () => {
  const saved = process.env.JEV_BROWSER_ALLOW_UNPROXIED_PAGE;
  delete process.env.JEV_BROWSER_ALLOW_UNPROXIED_PAGE;
  try {
    const explosive = new Proxy({}, { get() { throw new Error("page must not be touched"); } });
    await assert.rejects(() => navigate({ task: "x", page: explosive, transport: judge }), /JEV_BROWSER_ALLOW_UNPROXIED_PAGE/);
  } finally {
    if (saved !== undefined) process.env.JEV_BROWSER_ALLOW_UNPROXIED_PAGE = saved;
  }
});

test("integration: WebRTC STUN/TURN UDP to loopback never leaves the browser", async () => {
  const packets = [];
  const udp = createSocket("udp4");
  udp.on("message", (m) => packets.push(m.length));
  await new Promise((r) => udp.bind(0, "127.0.0.1", r));
  const port = udp.address().port;
  const web = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<title>rtc</title><h1>rtc page</h1><script>
    const pc = new RTCPeerConnection({ iceServers: [
      { urls: "stun:127.0.0.1:${port}" },
      { urls: "turn:127.0.0.1:${port}?transport=udp", username: "u", credential: "p" } ] });
    pc.createDataChannel("d");
    pc.createOffer().then((o) => pc.setLocalDescription(o));
  </script>`);
  });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  const wp = web.address().port;
  const saved = process.env.JEV_BROWSER_ALLOW_PRIVATE_HOSTS;
  process.env.JEV_BROWSER_ALLOW_PRIVATE_HOSTS = `127.0.0.1:${wp}`;
  try {
    const states = [];
    const r = await navigate({ task: "x", startUrl: `http://127.0.0.1:${wp}/`, maxSeconds: 15, maxSteps: 1, screenshot: "none", transport: doneJudge(states) });
    assert.equal(r.status, "done", `${r.status}: ${r.error}`);
    assert.match(states[0]?.page_text_excerpt ?? "", /rtc page/);
    await new Promise((res) => setTimeout(res, 4000));
    assert.deepEqual(packets, [], "UDP listener must receive 0 packets");
  } finally {
    if (saved === undefined) delete process.env.JEV_BROWSER_ALLOW_PRIVATE_HOSTS; else process.env.JEV_BROWSER_ALLOW_PRIVATE_HOSTS = saved;
    udp.close(); web.close();
  }
});

test("proxy CONNECT: client reset during DNS does not raise an unhandled error", async () => {
  const errors = [];
  const onUncaught = (e) => errors.push(e);
  process.on("uncaughtException", onUncaught);
  const proxy = await startGuardProxy({ allow: none, resolver: () => new Promise((r) => setTimeout(() => r(["93.184.216.34"]), 300)) });
  try {
    const c = netConnect(proxy.port, "127.0.0.1");
    c.on("error", () => {});
    await new Promise((r) => c.once("connect", r));
    c.write("CONNECT slow.test:443 HTTP/1.1\r\nHost: slow.test:443\r\n\r\n");
    await new Promise((r) => setTimeout(r, 50));
    c.resetAndDestroy();
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(errors.map(String), []);
  } finally {
    process.off("uncaughtException", onUncaught);
    await proxy.close();
  }
});

test("proxy CONNECT: falls back across validated addresses without re-resolving", async () => {
  let lookups = 0;
  const target = createNetServer((s) => s.end("hello"));
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const port = target.address().port;
  // 127.0.0.2 refuses (target is bound to 127.0.0.1 only), so the second validated address must be used.
  const proxy = await startGuardProxy({
    allow: parseAllowList("multi.test"),
    resolver: async () => { lookups++; return ["127.0.0.2", "127.0.0.1"]; },
  });
  try {
    const c = netConnect(proxy.port, "127.0.0.1");
    let buf = "";
    c.on("data", (d) => (buf += d));
    c.on("error", () => {});
    await new Promise((r) => c.once("connect", r));
    c.write(`CONNECT multi.test:${port} HTTP/1.1\r\nHost: multi.test:${port}\r\n\r\n`);
    await new Promise((r) => c.once("close", r));
    assert.match(buf, /^HTTP\/1\.1 200 /);
    assert.match(buf, /hello/);
    assert.equal(lookups, 1);
  } finally {
    await proxy.close();
    target.close();
  }
});

test("proxy CONNECT: every address stays validated (mixed public/private is refused)", async () => {
  const blockedMsgs = [];
  const proxy = await startGuardProxy({ allow: none, resolver: async () => ["93.184.216.34", "127.0.0.1"], onBlocked: (m) => blockedMsgs.push(m) });
  try {
    const c = netConnect(proxy.port, "127.0.0.1");
    let buf = "";
    c.on("data", (d) => (buf += d));
    c.on("error", () => {});
    await new Promise((r) => c.once("connect", r));
    c.write("CONNECT mixed.test:443 HTTP/1.1\r\nHost: mixed.test:443\r\n\r\n");
    await new Promise((r) => c.once("close", r));
    assert.match(buf, /403/);
    assert.equal(blockedMsgs.length, 1);
  } finally {
    await proxy.close();
  }
});

test("proxy HTTP: truncated upstream body terminates the browser-facing response", async () => {
  const up = createNetServer((s) => {
    s.once("data", () => {
      s.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial");
      setTimeout(() => s.destroy(), 50);
    });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const port = up.address().port;
  const proxy = await startGuardProxy({ allow: parseAllowList(`127.0.0.1:${port}`) });
  try {
    const outcome = await new Promise((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port: proxy.port, method: "GET", path: `http://127.0.0.1:${port}/`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.complete ? "complete" : "truncated"));
        res.on("aborted", () => resolve("aborted"));
        res.on("error", () => resolve("error"));
        res.on("close", () => resolve(res.complete ? "complete" : "closed-incomplete"));
      });
      req.on("error", () => resolve("req-error"));
      req.end();
      setTimeout(() => resolve("hung"), 3000);
    });
    assert.notEqual(outcome, "complete");
    assert.notEqual(outcome, "hung");
  } finally {
    await proxy.close();
    up.close();
  }
});

test("navigate: borrowed page (unproxied opt-in) leaves no active WebSocket guard on the caller's context", async () => {
  const saved = process.env.JEV_BROWSER_ALLOW_UNPROXIED_PAGE;
  process.env.JEV_BROWSER_ALLOW_UNPROXIED_PAGE = "1";
  let wsHandler = null;
  let unrouted = 0;
  const context = {
    route: async () => {},
    unroute: async () => { unrouted++; },
    routeWebSocket: async (_p, h) => { wsHandler = h; },
    addCookies: async () => {},
    setDefaultTimeout: () => {},
    on: () => {},
    off: () => {},
  };
  const page = new Proxy({}, {
    get(_t, k) {
      if (k === "context") return () => context;
      if (k === "on" || k === "off") return () => {};
      if (k === "url") return () => "about:blank";
      if (k === "then") return undefined;
      return () => Promise.reject(new Error("stub page"));
    },
  });
  try {
    await navigate({ task: "x", page, maxSeconds: 2, maxSteps: 1, screenshot: "none", transport: judge }).catch(() => {});
    assert.ok(wsHandler, "guard installed during the run");
    assert.equal(unrouted, 1, "http route guard removed");
    let connected = 0;
    let closed = 0;
    await wsHandler({ url: () => "ws://127.0.0.1:9/", connectToServer: () => { connected++; }, close: async () => { closed++; } });
    assert.equal(connected, 1, "guard is pass-through after the run");
    assert.equal(closed, 0);
  } finally {
    if (saved === undefined) delete process.env.JEV_BROWSER_ALLOW_UNPROXIED_PAGE; else process.env.JEV_BROWSER_ALLOW_UNPROXIED_PAGE = saved;
  }
});

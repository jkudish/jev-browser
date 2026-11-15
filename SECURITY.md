# Security policy

## Reporting a vulnerability

Email **joey@jkudish.com** with "jev-browser security" in the subject. Include:

- the package version and how you installed it;
- a minimal reproduction (task, start URL, environment);
- the impact you observed or expect.

Please do not open public issues for vulnerabilities. There is no bug bounty and no committed response time; reports are handled as maintainer time allows.

## Scope

jev-browser runs a headless browser and makes network calls to the TypeSafe API and, when configured, one typing provider. It navigates to URLs you supply and can follow links from those pages. Treat the service environment it runs in as reachable by the pages it visits: run it in a container or restricted network if your environment has private endpoints you do not want touched.

Only the latest released version receives fixes. There is no support policy for older versions yet.

## Network guard notes

- `JEV_BROWSER_ALLOW_PRIVATE_HOSTS` accepts exact `host` or `host:port` entries only. Bare ports (e.g. `5000`) are rejected because they would open that port on every host.
- Chromium is launched with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` so WebRTC STUN/TURN UDP cannot bypass the filtering proxy.
- `navigate({ page })` runs in the caller's browser, which is not behind the proxy (route-layer checks only). It is refused unless `JEV_BROWSER_ALLOW_UNPROXIED_PAGE=1`.
- Start URLs must be http(s). Unresolvable DNS names are blocked at the route layer.

# Security policy

## Reporting a vulnerability

Email **joey@jkudish.com** with "discern-browser security" in the subject. Include:

- the package version and how you installed it;
- a minimal reproduction (task, start URL, environment);
- the impact you observed or expect.

Please do not open public issues for vulnerabilities. There is no bug bounty and no committed response time; reports are handled as maintainer time allows.

## Scope

discern-browser runs a headless browser and makes network calls to the configured judgment provider (the TypeSafe API by default, or OpenRouter, Cloudflare Workers AI including Clef, Vercel AI Gateway, OpenAI, or a System One-compatible endpoint you configure) and, when configured, one typing provider. It navigates to URLs you supply and can follow links from those pages. Treat the service environment it runs in as reachable by the pages it visits: run it in a container or restricted network if your environment has private endpoints you do not want touched.

Only the latest released version receives fixes. The `@jkudish/jev-browser` compatibility package delegates to `@jkudish/discern-browser`, so report issues against discern-browser. There is no support policy for older versions yet.

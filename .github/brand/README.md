# Discern brand images

`render.mjs` draws every Discern README and social image, for all three repositories, from code: the split mark with an 8×8 Bayer ordered dither, and the dark terminal cards. Run it from the repository root after `npm ci`:

```sh
node .github/brand/render.mjs /tmp/discern-brand
```

It writes these files to the given directory:

| File | Size | Used for |
| --- | --- | --- |
| `<name>-banner.png` | 1270×760 | The repository README header |
| `<name>-og.png` | 1280×640 | The repository's GitHub social preview (Settings → Social preview) |
| `discern-mark.svg`, `discern-mark-512.png` | vector, 512×512 | Avatars and favicons |

`<name>` is `discern-mcp`, `discern-browser`, or `discern-sdk`. Each repository keeps its own banner and social card in `.github/` and the mark in `.github/brand/`; this generator in discern-browser is the only source. Panel values are real outputs; `render.mjs` records the inputs that produced them.

The render fails when any text would overflow its box. Fonts are Plus Jakarta Sans and JetBrains Mono, both under the SIL Open Font License (`fonts/OFL-*.txt`), and are inlined so the output does not depend on installed fonts.

## Browser demo

The GIF and MP4 in `assets/` combine a real Playwright recording with the run's recorded trace. The panel is added afterward; its decisions, probabilities, timings and usage come from `assets/github-demo.json`, not a simulated session. The original `assets/github-demo.webm` is retained so the composite can be regenerated without another paid run. The source take ends on the repository URL, not the Releases page. GitHub still uses the legacy repository name.

Requires the repository build, Chromium, FFmpeg and provider credentials. Recording makes paid model calls; use a public page without credentials or seeded cookies. Never record a login or password run.

```sh
npm run build
mkdir -p /tmp/discern-demo
DISCERN_PROVIDER=typesafe DISCERN_BROWSER_TYPE_PROVIDER=openrouter \
  node dist/index.js run \
  "Search GitHub for the repository jkudish/jev-browser, open that repository, and stop on its repository page." \
  https://github.com/ --max-steps 12 --max-seconds 90 \
  --record /tmp/discern-demo/run.webm --no-screenshot \
  > /tmp/discern-demo/result.json
```

Check `status`, the actual `final_url`, goal probability and action errors before selecting a take; `done` alone is not proof that the task succeeded. Keep failed takes out of the README rather than editing their values. Export only the public task and trace fields:

```sh
jq '{task: "Search GitHub for the repository jkudish/jev-browser, open that repository, and stop on its repository page.",
     status, final_url, final_title, elapsed_ms, model, judgment_provider,
     typing_provider, typing_model, usage, steps}' \
  /tmp/discern-demo/result.json > assets/github-demo.json
node .github/brand/render-demo.mjs \
  assets/github-demo.json /tmp/discern-demo/run.webm assets
```

To re-render the committed take without model calls, use `assets/github-demo.webm` instead of `/tmp/discern-demo/run.webm`.

The compositor preserves the recording's order and aligns panels to trace timestamps, then holds the last frame for 2.6 seconds. It uses the same dark-terminal palette and mark as the banners. The GIF is 1100px wide at 12fps with a 220-color Bayer-dithered palette; the MP4 retains the 1644×640 composite at 30fps. Inspect both the motion and the final frame before committing. These assets and render scripts are not shipped in the npm package.

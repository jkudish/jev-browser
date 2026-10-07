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

`<name>` is `discern-mcp`, `discern-browser`, or `discern-agent-tools`. Each repository keeps its own banner and social card in `.github/` and the mark in `.github/brand/`; this generator in discern-browser is the only source. Panel values are real outputs; `render.mjs` records the inputs that produced them.

The render fails when any text would overflow its box. Fonts are Plus Jakarta Sans and JetBrains Mono, both under the SIL Open Font License (`fonts/OFL-*.txt`), and are inlined so the output does not depend on installed fonts.

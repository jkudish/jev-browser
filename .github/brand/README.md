# Discern brand images

`render.mjs` draws every Discern README and social image from code: the split mark with an 8×8 Bayer ordered dither, and the dark terminal cards. Run it from the repository root after `npm ci`:

```sh
node .github/brand/render.mjs /tmp/discern-brand
```

It writes these files to the given directory:

| File | Size | Used for |
| --- | --- | --- |
| `discern-browser-banner.png` | 1270×760 | This README's header (`.github/`) |
| `discern-browser-og.png` | 1280×640 | This repository's GitHub social preview (`.github/`) |
| `discern-mcp-og.png` | 1280×640 | discern-mcp's README header and social preview (`.github/` in that repository) |
| `discern-mark.svg`, `discern-mark-512.png` | vector, 512×512 | Avatars and favicons (`.github/brand/`) |

The render fails when any text would overflow its box. Fonts are Plus Jakarta Sans and JetBrains Mono, both under the SIL Open Font License (`fonts/OFL-*.txt`), and are inlined so the output does not depend on installed fonts.

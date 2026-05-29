# @vault-4/video

Remotion promo videos for Vault-4. Reuses the web app's cyberpunk terminal
design tokens (ported from `packages/web/app/globals.css` into `src/theme.ts`).

## Develop

```bash
cd packages/video
npm install          # self-contained; not part of the pnpm/npm workspace
npm run studio       # live preview (Remotion Studio)
```

## Render

```bash
npm run render       # -> out/vault-promo.mp4 (H.264 CRF 18, 1920x1080, ~24s)
npm run render:gif   # -> out/vault-promo.gif
npm run still        # -> out/frame.png (poster frame)
```

## Live data

Metrics + the PnL chart series are fetched **at render time** in `Root.tsx`'s
`calculateMetadata` from the production API (CORS `*`, works in Studio + CLI):

- `GET /api/metrics` — TVL, PnL %, win rate, drawdown, days since inception
- `GET /api/portfolio` — `history.pnl.points` time series for the chart

Override the API with `REMOTION_VAULT_API_BASE_URL`. If the fetch fails, it
falls back to a baked-in snapshot (`FALLBACK` in `src/lib/api.ts`) so the video
always renders. **Note:** TVL is shown as a 30d % change (derived from
`tvlChange30dUsd / priorTvl`), never the absolute figure.

## Scenes (assembled via `<Series>` in `Promo.tsx`, ~24s total)

1. **Boot** — terminal boot lines + glitch logo reveal
2. **HeroMetrics** — live count-up: TVL_30D %, 30D PnL, 60D PnL, win rate
3. **PnLChart** — real PnL series drawn as an animated SVG sweep
4. **HowItWorks** — DISCOVER → RANK → REBALANCE
5. **CTA** — badges + URL

`MatrixRain` (backdrop) and `CRT` (scanline/vignette overlay) are global, drawn
once across all scenes in `Promo.tsx`.

## Music

An original, royalty-free synthwave bed is generated procedurally (no licensing):

```bash
npm run music        # node scripts/gen-music.js -> public/music.wav, then -> public/music.mp3
```

`scripts/gen-music.js` synthesizes A-minor @ 120 BPM (kick / bass / arp+delay /
pad / hats) with section dynamics matched to the scene cuts. It's muxed into the
render via `<Audio src={staticFile("music.mp3")} volume={0.7}>` in `Promo.tsx`.
Edit the script and re-run `npm run music` to change it.

## Structure

```
src/
  Root.tsx               # <Composition> + calculateMetadata (live fetch)
  Promo.tsx              # <Series> of scenes + global backdrop/CRT + durations
  theme.ts               # design tokens ported from the web app
  lib/
    api.ts               # live fetch + FALLBACK snapshot + types
    format.ts            # number / color helpers
  components/            # CRT, MatrixRain, TerminalFrame, TypingText, GlitchText
  scenes/                # Boot, HeroMetrics, PnLChart, HowItWorks, CTA
```

## Knobs

- CTA URL is `vault-4.xyz` (`src/scenes/CTA.tsx`).
- Scene durations live in `DURATIONS` in `Promo.tsx`.
- Music master level is the `volume` on `<Audio>` in `Promo.tsx`; the track
  itself is regenerated with `npm run music`.

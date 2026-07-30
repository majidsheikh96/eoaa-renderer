# eoaa-renderer

GitHub Actions renderer for **English Out & About**. It renders a HyperFrames composition on
a cloud runner so the heavy work never touches the local machine.

For a given `video_id` the workflow:
1. Syncs the whole episode prefix from Cloudflare R2 → `./composition`
2. Renders it with HyperFrames → `output.mp4`
3. Optionally embeds the thumbnail as the cover image
4. Uploads the MP4 back to R2 at `rendered/<video_id>/video.mp4`

There is **no callback server**. The orchestrating agent triggers the workflow and polls the
run (same pattern as the Kaggle voiceover step), then reads the MP4 from R2.

## R2 layout (one prefix per episode)
```
episodes/<video_id>/
├── index.html
├── caption-data.json
└── assets/            # audio WAVs (from Kaggle), video clips, images, bg-music
rendered/<video_id>/
└── video.mp4          # renderer output
```
> The whole `episodes/<video_id>/` prefix is synced to the runner so HyperFrames sees local,
> relatively-referenced assets (its determinism rules prefer local files).

## One-time setup
1. Create a **new GitHub repo** and push these files.
2. Create a **Cloudflare R2** bucket and an R2 API token (Access Key + Secret).
3. Add these **repo secrets** (Settings → Secrets and variables → Actions):
   - `R2_ACCOUNT_ID` — Cloudflare account id
   - `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — R2 API token
   - `R2_BUCKET_NAME` — the bucket
   - `R2_PUBLIC_URL` — the bucket's public base URL (e.g. `https://pub-xxxx.r2.dev`)

No other install is needed: `ubuntu-latest` ships the AWS CLI and Node 22 is set up by the
workflow; HyperFrames is fetched via `npx --yes hyperframes`.

## Trigger a render (from the agent / CLI)
```bash
gh workflow run render.yml \
  -R <owner>/eoaa-renderer \
  -f video_id=episode-01-airport \
  -f quality=standard \
  -f thumbnail_url="https://pub-xxxx.r2.dev/episodes/episode-01-airport/assets/thumbnail/thumbnail.jpg" \
  -f video_title="Airport English"
```

## Poll + fetch (no callback)
```bash
# find the run just started for this workflow
gh run list -R <owner>/eoaa-renderer --workflow=render.yml -L 1
# watch it to completion
gh run watch -R <owner>/eoaa-renderer <run-id>
# then the MP4 is at:
#   https://<R2_PUBLIC_URL>/rendered/<video_id>/video.mp4
# (also uploaded as workflow artifact "video-<video_id>" as a backup)
```

## Inputs
| Input | Required | Default | Notes |
|---|---|---|---|
| `video_id` | yes | — | R2 prefix under `episodes/<id>/` |
| `quality` | no | `standard` | `standard` = 30fps, `draft` = 24fps draft |
| `thumbnail_url` | no | — | JPEG to embed as MP4 cover |
| `video_title` | no | — | run name only |

## ⚠️ Render time
Long episodes (25–35 min) are heavy on a 2-core CPU runner and can approach the 120-min job
timeout. **Benchmark a 1-minute composition first** and extrapolate. If needed: use
`quality=draft`, or split the render into parallel `matrix` jobs (frame/segment ranges) and
concatenate, or move to a self-hosted / higher-core runner. See `RENDER-PLAN.md` in the main
project.

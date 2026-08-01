import { execSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, statSync, readdirSync } from "fs";

/**
 * English Out & About — GitHub Actions Renderer
 * =============================================
 * Three modes (env MODE, default "full"):
 *
 *   full   — legacy single render. Sync episodes/<id>/ → ./composition, render the whole
 *            index.html, (optional thumbnail cover), upload rendered/<id>/video.mp4.
 *
 *   chunk  — render ONE chunk of a long episode (parallel matrix job). Sync the shared
 *            episode files (assets/, compositions/, …) then overlay the chunk-specific
 *            index.html + caption-data.json from episodes/<id>/chunks/c<CHUNK_ID>/, render,
 *            and upload rendered/<id>/chunks/c<CHUNK_ID>.mp4. No thumbnail here.
 *
 *   concat — join the rendered chunk MP4s. List rendered/<id>/chunks/*.mp4 (sorted, so
 *            the zero-padded names concatenate in order), ffmpeg -c copy (lossless, instant),
 *            (optional thumbnail cover), upload rendered/<id>/video.mp4.
 *
 * No callback server: the orchestrating agent triggers with `gh workflow run` and polls.
 */

const REQUIRED_ENV = [
  "VIDEO_ID",
  "R2_ACCOUNT_ID",
  "R2_BUCKET_NAME",
  "R2_PUBLIC_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];

function validateEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

// R2 rejects newer AWS CLI auto-checksums; force "when required".
const S3_ENV = {
  AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "auto",
  AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
  AWS_RESPONSE_CHECKSUM_VALIDATION: "WHEN_REQUIRED",
};

function run(cmd, extraEnv = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
}

function capture(cmd, extraEnv = {}) {
  return execSync(cmd, { env: { ...process.env, ...extraEnv, ...S3_ENV }, encoding: "utf-8" });
}

const ENDPOINT = () => `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const BUCKET = () => process.env.R2_BUCKET_NAME;
const pad = (n) => String(n).padStart(2, "0");

function qualityFlags() {
  const quality = process.env.RENDER_QUALITY || "standard";
  return quality === "draft"
    ? "--fps 24 --quality draft"
    : "--fps 30 --quality standard";
}

function render(compositionDir, outFile) {
  const cmd =
    `npx --yes hyperframes render ${compositionDir} --output ${outFile} ` +
    `${qualityFlags()} --workers auto --browser-timeout 18000`;
  console.log(`Rendering ${compositionDir} (quality: ${process.env.RENDER_QUALITY || "standard"}) ...`);
  try {
    run(cmd, {
      PRODUCER_ENABLE_CHUNKED_ENCODE: "true",
      FFMPEG_ENCODE_TIMEOUT_MS: "3600000",
    });
  } catch (err) {
    throw new Error(`Render failed with exit code ${err.status}: ${err.message}`);
  }
  if (!existsSync(outFile)) {
    throw new Error(`Render finished but ${outFile} was not produced.`);
  }
}

async function embedThumbnail(mp4) {
  const url = process.env.THUMBNAIL_URL;
  if (!url) {
    console.log("No THUMBNAIL_URL — skipping cover embed.");
    return;
  }
  console.log("Embedding thumbnail as cover image ...");
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`Could not download thumbnail (${res.status}) — skipping cover embed.`);
    return;
  }
  writeFileSync("./thumbnail.jpg", Buffer.from(await res.arrayBuffer()));
  run(
    `ffmpeg -y -i ${mp4} -i ./thumbnail.jpg -map 0 -map 1 -c copy ` +
      `-disposition:v:1 attached_pic ./output_with_cover.mp4`,
  );
  run(`mv ./output_with_cover.mp4 ${mp4}`);
  console.log("Thumbnail embedded.");
}

function uploadMp4(localFile, key) {
  console.log(`Uploading to R2 ${key} ...`);
  run(
    `aws s3 cp ${localFile} "s3://${BUCKET()}/${key}" ` +
      `--endpoint-url "${ENDPOINT()}" --content-type video/mp4 --only-show-errors`,
    S3_ENV,
  );
  return `${process.env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
}

// ── full (legacy) ─────────────────────────────────────────────────────────────
async function modeFull(id) {
  console.log(`[full] Syncing episodes/${id}/ from R2 ...`);
  mkdirSync("./composition", { recursive: true });
  run(
    `aws s3 sync "s3://${BUCKET()}/episodes/${id}/" ./composition ` +
      `--endpoint-url "${ENDPOINT()}" --only-show-errors`,
    S3_ENV,
  );
  if (!existsSync("./composition/index.html")) {
    throw new Error(`./composition/index.html not found — is episodes/${id}/index.html in R2?`);
  }
  render("./composition", "./output.mp4");
  await embedThumbnail("./output.mp4");
  console.log(`Rendered output.mp4 (${(statSync("./output.mp4").size / 1e6).toFixed(1)} MB).`);
  const url = uploadMp4("./output.mp4", `rendered/${id}/video.mp4`);
  console.log(`\n== DONE ==\nMP4: ${url}`);
}

// ── chunk (matrix job) ──────────────────────────────────────────────────────
function modeChunk(id) {
  const cid = pad(process.env.CHUNK_ID);
  console.log(`[chunk c${cid}] Syncing shared episode files ...`);
  mkdirSync("./composition", { recursive: true });
  // Shared: everything except the per-chunk index.html + caption-data.json under chunks/.
  run(
    `aws s3 sync "s3://${BUCKET()}/episodes/${id}/" ./composition ` +
      `--endpoint-url "${ENDPOINT()}" --exclude "chunks/*" --only-show-errors`,
    S3_ENV,
  );
  // Overlay the chunk-specific composition + caption data.
  for (const f of ["index.html", "caption-data.json"]) {
    run(
      `aws s3 cp "s3://${BUCKET()}/episodes/${id}/chunks/c${cid}/${f}" ./composition/${f} ` +
        `--endpoint-url "${ENDPOINT()}" --only-show-errors`,
      S3_ENV,
    );
  }
  render("./composition", "./output.mp4");
  console.log(`Rendered chunk c${cid} (${(statSync("./output.mp4").size / 1e6).toFixed(1)} MB).`);
  const url = uploadMp4("./output.mp4", `rendered/${id}/chunks/c${cid}.mp4`);
  console.log(`\n== CHUNK c${cid} DONE ==\nMP4: ${url}`);
}

// ── concat (join chunks) ─────────────────────────────────────────────────────
async function modeConcat(id) {
  console.log(`[concat] Listing rendered/${id}/chunks/ ...`);
  const listing = capture(
    `aws s3 ls "s3://${BUCKET()}/rendered/${id}/chunks/" --endpoint-url "${ENDPOINT()}"`,
  );
  const names = listing
    .split("\n")
    .map((l) => l.trim().split(/\s+/).pop())
    .filter((n) => n && n.endsWith(".mp4"))
    .sort(); // zero-padded c00.mp4, c01.mp4, … → chronological order
  if (names.length === 0) {
    throw new Error(`No chunk MP4s found under rendered/${id}/chunks/`);
  }
  console.log(`Found ${names.length} chunks: ${names.join(", ")}`);

  mkdirSync("./chunks", { recursive: true });
  for (const n of names) {
    run(
      `aws s3 cp "s3://${BUCKET()}/rendered/${id}/chunks/${n}" ./chunks/${n} ` +
        `--endpoint-url "${ENDPOINT()}" --only-show-errors`,
      S3_ENV,
    );
  }
  const listTxt = names.map((n) => `file 'chunks/${n}'`).join("\n") + "\n";
  writeFileSync("./concat-list.txt", listTxt);

  console.log("Concatenating (ffmpeg -c copy) ...");
  run(`ffmpeg -y -f concat -safe 0 -i ./concat-list.txt -c copy ./output.mp4 -loglevel error`);
  if (!existsSync("./output.mp4")) {
    throw new Error("Concat finished but ./output.mp4 was not produced.");
  }
  await embedThumbnail("./output.mp4");
  console.log(`Final video (${(statSync("./output.mp4").size / 1e6).toFixed(1)} MB).`);
  const url = uploadMp4("./output.mp4", `rendered/${id}/video.mp4`);
  console.log(`\n== DONE ==\nMP4: ${url}`);
}

async function main() {
  validateEnv();
  const id = process.env.VIDEO_ID;
  const mode = process.env.MODE || "full";
  console.log(`Mode: ${mode} | video_id: ${id}`);
  if (mode === "chunk") return modeChunk(id);
  if (mode === "concat") return modeConcat(id);
  return modeFull(id);
}

main().catch((err) => {
  console.error("Renderer failed:", err);
  process.exit(1);
});

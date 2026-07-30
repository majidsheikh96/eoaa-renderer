import { execSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, statSync } from "fs";

/**
 * English Out & About — GitHub Actions Renderer
 * =============================================
 * Runs on a GitHub Actions runner. For a given VIDEO_ID it:
 *   1. Syncs the whole episode prefix from Cloudflare R2  (episodes/<id>/ → ./composition)
 *   2. Renders it with HyperFrames                        (→ ./output.mp4)
 *   3. Optionally embeds the thumbnail as the cover image
 *   4. Uploads the MP4 back to R2                          (rendered/<id>/video.mp4)
 *
 * There is NO callback server: the orchestrating agent triggers this workflow with
 * `gh workflow run` and polls the run, then reads the MP4 from R2. Keep it that way.
 *
 * Auth: AWS-compatible env vars (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) are set from
 * the R2 credentials in the workflow, and every S3 call targets the R2 endpoint.
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

function run(cmd, extraEnv = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
}

async function main() {
  validateEnv();

  const {
    VIDEO_ID,
    R2_ACCOUNT_ID,
    R2_BUCKET_NAME,
    R2_PUBLIC_URL,
    THUMBNAIL_URL,
  } = process.env;

  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

  // Newer AWS CLI adds request checksums that some S3-compatible stores (R2) reject.
  // Force "when required" so sync/cp stay compatible with R2.
  const s3Env = {
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "auto",
    AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
    AWS_RESPONSE_CHECKSUM_VALIDATION: "WHEN_REQUIRED",
  };

  // ── Step 1: Sync the whole episode prefix from R2 ────────────────────────────
  // HyperFrames wants LOCAL, relatively-referenced assets (determinism), so we pull
  // index.html + caption-data.json + assets/ — not just index.html.
  console.log(`Syncing episodes/${VIDEO_ID}/ from R2 ...`);
  mkdirSync("./composition", { recursive: true });
  run(
    `aws s3 sync "s3://${R2_BUCKET_NAME}/episodes/${VIDEO_ID}/" ./composition ` +
      `--endpoint-url "${endpoint}" --only-show-errors`,
    s3Env,
  );
  if (!existsSync("./composition/index.html")) {
    throw new Error(
      `./composition/index.html not found after sync — is episodes/${VIDEO_ID}/index.html in R2?`,
    );
  }

  // ── Step 2: Render with HyperFrames ──────────────────────────────────────────
  const quality = process.env.RENDER_QUALITY || "standard";
  const qualityFlags =
    quality === "draft" ? "--fps 24 --quality draft" : "--fps 30 --quality standard";

  const renderCmd =
    `npx --yes hyperframes render ./composition --output ./output.mp4 ` +
    `${qualityFlags} --workers auto --browser-timeout 18000`;

  console.log(`Rendering (quality: ${quality}) ...`);
  try {
    run(renderCmd, {
      PRODUCER_ENABLE_CHUNKED_ENCODE: "true",
      FFMPEG_ENCODE_TIMEOUT_MS: "0",
    });
  } catch (err) {
    throw new Error(`Render failed with exit code ${err.status}: ${err.message}`);
  }
  if (!existsSync("./output.mp4")) {
    throw new Error("Render finished but ./output.mp4 was not produced.");
  }

  // ── Step 2.5: Embed thumbnail as cover image (optional) ──────────────────────
  if (THUMBNAIL_URL) {
    console.log("Embedding thumbnail as cover image ...");
    const thumbRes = await fetch(THUMBNAIL_URL);
    if (thumbRes.ok) {
      writeFileSync("./thumbnail.jpg", Buffer.from(await thumbRes.arrayBuffer()));
      run(
        "ffmpeg -y -i ./output.mp4 -i ./thumbnail.jpg -map 0 -map 1 -c copy " +
          "-disposition:v:1 attached_pic ./output_with_cover.mp4",
      );
      run("mv ./output_with_cover.mp4 ./output.mp4");
      console.log("Thumbnail embedded.");
    } else {
      console.warn(`Could not download thumbnail (${thumbRes.status}) — skipping cover embed.`);
    }
  } else {
    console.log("No THUMBNAIL_URL — skipping cover embed.");
  }

  const sizeMB = (statSync("./output.mp4").size / 1e6).toFixed(1);
  console.log(`Rendered output.mp4 (${sizeMB} MB).`);

  // ── Step 3: Upload MP4 to R2 ─────────────────────────────────────────────────
  const key = `rendered/${VIDEO_ID}/video.mp4`;
  console.log(`Uploading to R2 ${key} ...`);
  run(
    `aws s3 cp ./output.mp4 "s3://${R2_BUCKET_NAME}/${key}" ` +
      `--endpoint-url "${endpoint}" --content-type video/mp4 --only-show-errors`,
    s3Env,
  );

  const publicUrl = `${R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
  console.log("\n== DONE ==");
  console.log(`MP4: ${publicUrl}`);
}

main().catch((err) => {
  console.error("Renderer failed:", err);
  process.exit(1);
});

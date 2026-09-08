# image-moderation

NSFW image moderation REST API. Fastify + nsfwjs (MobileNetV2) on CPU, inference
isolated in `worker_threads`, packaged for a small Debian home server.

## Requirements

- **Node.js 22 LTS.** Pinned in `engines` and in the Dockerfile.
- **glibc, not musl.** `@tensorflow/tfjs-node` links against libtensorflow,
  which is published for glibc only. Alpine builds succeed and then fail at
  `require()`.
- **linux/amd64.** tfjs-node ships prebuilt binaries for `cpu-linux-x86_64`
  only — there is no `linux-arm64` build, so the image cannot run on ARM.

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/moderate` | yes | one image: multipart `image`, or JSON `{url}` / `{base64}` |
| POST | `/v1/moderate/batch` | yes | up to `MAX_BATCH_SIZE`; always 200 when the request is valid |
| GET | `/health` | no | liveness — 200 as soon as the process is up |
| GET | `/ready` | no | 200 only once the model is loaded and a worker is free |
| GET | `/metrics` | no | Prometheus, when `METRICS_ENABLED=true` |

Authentication is the `X-API-Key` header, checked against `API_KEYS`.

### Single image

```bash
curl -X POST http://127.0.0.1:3000/v1/moderate \
  -H "X-API-Key: $API_KEY" \
  -F "image=@photo.jpg"
```

```json
{
  "success": true,
  "data": {
    "verdict": "allow",
    "scores": { "neutral": 0.07, "drawing": 0.91, "sexy": 0.0004, "porn": 0.0018, "hentai": 0.010 },
    "nsfwScore": 0.012,
    "topClass": "drawing",
    "image": { "hash": "d7649f…", "width": 512, "height": 384, "format": "jpeg", "bytes": 1422 }
  },
  "meta": {
    "requestId": "98d35ec7-…",
    "processingMs": 28.9,
    "modelVersion": "nsfwjs-mobilenet-v2",
    "thresholds": { "block": 0.7, "review": 0.4 }
  }
}
```

### Batch

```bash
curl -X POST http://127.0.0.1:3000/v1/moderate/batch \
  -H "X-API-Key: $API_KEY" -H 'content-type: application/json' \
  -d '{"images":[{"id":"a","url":"https://example.com/a.jpg"},{"id":"b","base64":"…"}]}'
```

A valid batch request always returns **200**. Per-image failures appear inside
the array, so one bad URL never costs you the other nine results:

```json
{
  "success": true,
  "data": {
    "results": [
      { "index": 0, "id": "a", "success": true, "data": { "verdict": "allow", "…": "…" } },
      { "index": 1, "id": "b", "success": false,
        "error": { "code": "UNSUPPORTED_MEDIA_TYPE", "message": "…", "details": {} } }
    ],
    "summary": { "total": 2, "succeeded": 1, "failed": 1 }
  },
  "meta": { "…": "…" }
}
```

Batch accepts multipart too — repeat the `image` field. Prefer multipart or
`url` over `base64` for batches: base64 inflates the body by ~4/3, and the
route's body limit scales with `MAX_UPLOAD_BYTES × MAX_BATCH_SIZE`.

## Scoring

```
nsfwScore = porn + hentai + (sexy × SEXY_WEIGHT)

nsfwScore >= THRESHOLD_BLOCK   -> block
nsfwScore >= THRESHOLD_REVIEW  -> review
otherwise                      -> allow
```

At the default `SEXY_WEIGHT=0.5`, an image scoring `sexy: 1.0` and nothing else
reaches `nsfwScore 0.5` — review, never block. Raise `SEXY_WEIGHT` if
suggestive-but-not-explicit content should block on its own.

## Errors

Every failure uses one shape:

```json
{ "success": false,
  "error": { "code": "FILE_TOO_LARGE", "message": "…", "details": {} },
  "meta": { "requestId": "…" } }
```

| Status | Codes |
|---|---|
| 400 | `NO_IMAGE_PROVIDED`, `INVALID_INPUT`, `DECODE_FAILED`, `IMAGE_TOO_LARGE_DIMENSIONS` |
| 401 | `UNAUTHORIZED` |
| 413 | `FILE_TOO_LARGE`, `BATCH_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `URL_FETCH_FAILED` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` |
| 503 | `MODEL_NOT_READY` |
| 504 | `INFERENCE_TIMEOUT` |

## Configuration

Every variable is read at startup and validated; an invalid value stops the
process with **all** problems listed at once, rather than one per restart. See
[.env.example](.env.example) for the full annotated list.

## Local development

```bash
nvm use 22
npm install
npm run bake:model     # extracts model/ from the nsfwjs package
cp .env.example .env   # set MODEL_PATH=./model and a real API_KEYS value
npm run dev
```

## Tests

```bash
npm test               # 78 unit + integration tests, no network, no dev deps
npm run test:pool      # worker timeout, crash recovery, queueing, shutdown
npm run test:leak      # 1000 inferences, asserts RSS stays flat
```

Fixtures are generated locally by sharp (solid colour blocks) — no image is
downloaded, and none is committed.

## Deployment

The image must be built on a **linux/amd64** host — there is no ARM build of
tfjs-node — and the model is baked in, so the container needs no network at
start. Copy the source across and build there; nothing needs a registry unless
you are deploying the same image to more than one machine.

```bash
rsync -av --delete \
  --exclude node_modules --exclude .git --exclude '.env*' \
  --exclude 'test/fixtures/generated' \
  ./ user@server:/srv/image-moderation/
```

`node_modules` must never be copied: the native bindings are built for the
host's platform, and `npm ci` inside the image installs the linux-x64 ones.

```bash
# 1. build for the server's architecture
docker build --platform linux/amd64 -t image-moderation:1.0.0 .

# 2. environment (never commit these)
cp .env.example .env.prod
openssl rand -hex 24            # put the result in API_KEYS

# 3. run
IMAGE_TAG=1.0.0 docker compose -f docker-compose.prod.yml up -d

# 4. confirm
./scripts/smoke-test.sh http://127.0.0.1:3000 image-moderation:1.0.0
```

`smoke-test.sh` checks readiness, both auth rejections, a real inference, the
415 and 422 rejections, and the batch partial-failure contract. It builds its
own test image using the container's own sharp, so it needs no fixture files
and no network. Set `SMOKE_IMAGE_B64` to run it from a host that has no local
copy of the image.

Staging uses the same image and the same compose shape — only `.env.staging`
and the published port (3001) differ:

```bash
IMAGE_TAG=1.0.0 docker compose -f docker-compose.staging.yml up -d
```

### Behind nginx

The container publishes to `127.0.0.1` only. `client_max_body_size` must be at
least `MAX_UPLOAD_BYTES`, and the proxy timeouts must exceed
`INFERENCE_TIMEOUT_MS`:

```nginx
location /v1/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header X-Request-Id $request_id;
    client_max_body_size 12m;
    proxy_read_timeout 60s;
}
```

`X-Request-Id` is picked up and echoed back as `meta.requestId`, so a request
can be traced from the nginx log into the service log.

### Resource notes

`worker_threads` are threads inside one process, so `WORKER_POOL_SIZE=2` costs
one process at roughly **450 MB RSS** in total — not 450 MB per worker. The
1500 MB `mem_limit` leaves comfortable headroom. Set
`TF_NUM_INTRAOP_THREADS`/`TF_NUM_INTEROP_THREADS` so the workers do not each
size a thread pool to every core and fight the other containers on the box.

## Design notes

- **Inference never runs on the main thread.** TF.js inference is blocking; a
  single request would otherwise stall the whole event loop.
- **Tensors are disposed explicitly.** nsfwjs wraps its own intermediates in
  `tf.tidy` and disposes its logits, so the only tensor this service owns is the
  input, which is disposed in a `finally`. `npm run test:leak` asserts this.
- **The model loads once per worker, at startup**, from `MODEL_PATH`. Nothing is
  fetched at runtime.
- **MIME comes from magic bytes.** Filenames and `Content-Type` headers are
  attacker-controlled and are never trusted.
- **Every image passes through sharp first** — dimensions checked against
  `MAX_IMAGE_PIXELS` before decode, metadata stripped, resized to 224×224 raw
  RGB. This doubles as decompression-bomb protection.
- **Remote fetches are SSRF-hardened.** Private, loopback, link-local and CGNAT
  ranges are refused, IP-literal hosts are checked directly (Node skips DNS for
  those), redirects are re-validated per hop, and the socket is pinned to the
  address that was checked.
- **Images are never written to disk.** Only the SHA-256 is kept, and only when
  `STORE_IMAGE_HASH=true`.

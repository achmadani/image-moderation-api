# Panduan Deploy — image-moderation

Panduan lengkap memasang service moderasi gambar NSFW di server Linux baru:
dari persiapan, build, konfigurasi, sampai monitoring dan operasi harian.

Ditulis setelah deployment nyata di Debian 13 / Intel i5-6200U. Bagian
**Troubleshooting** berisi kegagalan yang benar-benar terjadi di sana, bukan
daftar teoretis.

---

## Daftar isi

1. [Prasyarat](#1-prasyarat)
2. [Pindahkan source](#2-pindahkan-source)
3. [Pre-flight: cek lockfile](#3-pre-flight-cek-lockfile)
4. [Build](#4-build)
5. [Konfigurasi & sizing](#5-konfigurasi--sizing)
6. [Jalankan](#6-jalankan)
7. [Verifikasi](#7-verifikasi)
8. [nginx di depan](#8-nginx-di-depan)
9. [Monitoring](#9-monitoring)
10. [Logging](#10-logging)
11. [Operasi harian](#11-operasi-harian)
12. [Upgrade & rollback](#12-upgrade--rollback)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Prasyarat

**Arsitektur harus x86_64.** `@tensorflow/tfjs-node` hanya menyediakan binary
prebuilt untuk `cpu-linux-x86_64` — tidak ada build ARM. Image ini tidak akan
jalan di Raspberry Pi, Graviton, atau Apple Silicon.

**Base image harus glibc, bukan musl.** libtensorflow hanya dipublikasikan untuk
glibc. Build di Alpine akan sukses lalu gagal saat `require()`.

```bash
uname -m && docker version --format 'server {{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}' && nproc && free -m | head -2 && df -h /var/lib/docker | tail -1
```

Yang dibutuhkan:

| Item | Minimum | Catatan |
|---|---|---|
| Arsitektur | `x86_64` | wajib |
| Docker | 20.10+ | dengan plugin `compose` v2 |
| RAM bebas saat build | ~2 GB | `npm ci` yang jadi penentu |
| Disk | ~3 GB | image ±1 GB, sisanya cache build |
| Core | 2 | lihat [sizing](#5-konfigurasi--sizing) |

Pesan `cpu_feature_guard ... SSE4.1 SSE4.2 AVX AVX2 FMA` yang muncul saat build
itu **normal**. libtensorflow dikompilasi untuk kompatibilitas luas dan hanya
memberitahu bahwa CPU Anda punya instruksi yang tidak dipakainya. Di Xeon pesan
ini biasanya menyebut lebih banyak instruksi (AVX-512). Bukan error.

---

## 2. Pindahkan source

Image belum ada di registry mana pun — yang dipindahkan adalah source, lalu
build di server. Itu native amd64, jauh lebih cepat daripada emulasi.

```bash
rsync -av --delete --exclude node_modules --exclude .git --exclude '.env' --exclude '.env.prod' --exclude '.env.staging' --exclude 'test/fixtures/generated' ./ user@server-xeon:/srv/image-moderation/
```

Atau lewat git (repo privat), yang lebih baik kalau Anda ingin riwayat:

```bash
git clone git@github.com:user/image-moderation.git /srv/image-moderation
```

**`node_modules` tidak boleh ikut.** Isinya binary untuk platform mesin asal;
`npm ci` di dalam image akan memasang versi linux-x64 yang benar.

**`model/` harus ikut** (±2,6 MB). Itu yang membuat container tidak perlu
jaringan saat start.

`.env.example` diawali titik — tidak terlihat oleh `ls` biasa. Cek dengan
`ls -a`.

---

## 3. Pre-flight: cek lockfile

**Langkah ini menghemat berjam-jam.** Di deployment pertama, direktori tujuan
sudah berisi `package-lock.json` dari proyek lama. `npm ci` mematuhinya dan
memasang tfjs-node **1.x**, bukan 4.22.0. Gejalanya tidak menunjuk ke mana-mana:
`TypeError: tf.getBackend is not a function`. Empat build gagal sebelum
penyebabnya ketemu.

```bash
cd /srv/image-moderation && sha256sum package.json package-lock.json && grep -m1 lockfileVersion package-lock.json && ls -a | grep -E '^\.env'
```

Yang harus terlihat:

```
"lockfileVersion": 3
```

Bandingkan checksum-nya dengan mesin asal. Kalau berbeda, salin ulang **kedua**
file itu. Karena `COPY package.json package-lock.json ./` ada sebelum `npm ci`
di Dockerfile, mengganti lockfile otomatis membatalkan cache — tidak perlu
`--no-cache`.

Pastikan juga tidak ada `node_modules` nyasar:

```bash
ls -d /srv/image-moderation/node_modules 2>/dev/null && echo "PINDAHKAN INI: mv node_modules node_modules.stale"
```

Build tidak memakainya (`.dockerignore` mengecualikannya), tapi ia akan
mengacaukan diagnostik apa pun yang Anda jalankan dengan mount.

---

## 4. Build

```bash
cd /srv/image-moderation && docker build --platform linux/amd64 -t image-moderation:1.0.0 .
```

Tiga stage:

| Stage | Isi |
|---|---|
| `deps` | toolchain build + `npm ci --omit=dev` |
| `verify` | memastikan TensorFlow benar-benar bisa dipakai |
| `runtime` | image ramping: node_modules, src, model, non-root |

Stage `verify` adalah gerbangnya. Ia menjalankan resolver yang **sama persis**
dengan worker, jadi build yang lolos tidak mungkin menghasilkan container yang
worker-nya mati. Untuk melihat outputnya (BuildKit menyembunyikan output stage
yang sukses):

```bash
docker build --platform linux/amd64 --target verify --progress=plain -t im-verify . 2>&1 | grep -A12 "tfjs runtime check"
```

Yang benar:

```
tfjs runtime check
  installed packages:
  @tensorflow/tfjs-node 4.22.0
  nsfwjs               4.3.0
  sharp                0.35.4
  node                   v22.x.x linux/x64
  namespace in use       @tensorflow/tfjs-node
  backend                tensorflow
  file:// io router      registered
  tensor3d + sum         ok (sum=0)
  RESULT: ok
```

`backend` harus `tensorflow`. Kalau `cpu`, binding native tidak termuat dan
inference akan berjalan di JavaScript murni — puluhan kali lebih lambat.

---

## 5. Konfigurasi & sizing

```bash
cp .env.example .env.prod && openssl rand -hex 24
```

Masukkan hasilnya ke `API_KEYS`. Minimal 16 karakter — divalidasi saat startup.
Untuk beberapa klien, pisahkan dengan koma agar tiap klien bisa dicabut sendiri:

```
API_KEYS=kunci-klien-a-xxxxx,kunci-klien-b-yyyyy
```

`MODEL_PATH=/app/model` jangan diubah — itu path di dalam container.

### Sizing untuk mesin dengan core banyak

Default `WORKER_POOL_SIZE=2` dibuat untuk 4-core. Xeon biasanya punya jauh lebih
banyak.

Aturannya: **`WORKER_POOL_SIZE × TF_NUM_INTRAOP_THREADS` jangan melebihi jatah
core** (`cpus:` di compose). Melebihi itu membuat worker berebut CPU dan latensi
justru naik.

| Core dialokasikan | `WORKER_POOL_SIZE` | `TF_NUM_INTRAOP_THREADS` | `cpus:` | `mem_limit` |
|---|---|---|---|---|
| 2 | 2 | 1 | 2.0 | 768m |
| 4 | 2 | 2 | 4.0 | 1024m |
| 8 | 4 | 2 | 8.0 | 1280m |
| 16 | 6 | 2 | 12.0 | 1536m |

`TF_NUM_INTEROP_THREADS=1` untuk semua kasus — inference kita satu graph per
request, paralelisme antar-operasi tidak membantu.

Jangan naikkan worker melebihi ~6. Model MobileNetV2 hanya ~13 ms per inference;
di atas itu bottleneck-nya pindah ke decode gambar dan I/O, bukan inference.

**Memory** mengikuti pola linier dari hasil pengukuran di Linux:

```
RSS ≈ 115 MB + (85 MB × WORKER_POOL_SIZE)
```

Terverifikasi: 2 worker = 285 MB perkiraan, 290 MB terukur. Tambahkan ~90 MB
untuk puncak saat upload besar bersamaan, lalu beri margin ~2×.

`worker_threads` adalah thread dalam **satu proses**, bukan proses terpisah.
Jadi 4 worker bukan berarti 4× memory penuh — hanya model dan arena TF-nya yang
bertambah.

### Batas input

| Variabel | Default | Kapan diubah |
|---|---|---|
| `MAX_UPLOAD_BYTES` | 10485760 (10 MB) | naikkan kalau klien mengirim foto kamera mentah |
| `MAX_IMAGE_PIXELS` | 50000000 (50 MP) | turunkan ke 25000000 untuk memperketat memory |
| `MAX_BATCH_SIZE` | 10 | naikkan hanya bila klien memakai `url`, bukan base64 |
| `MAX_CONCURRENT_REQUESTS` | 20 | turunkan ke 6 kalau memory ketat |
| `RATE_LIMIT_MAX` | 60 per menit | per API key |

Pengukuran menunjukkan sharp **tidak** memuat bitmap penuh: 12 gambar 49 MP
bersamaan (yang raw RGB-nya 140 MB masing-masing) hanya menambah 87 MB, karena
libvips men-decode per-tile langsung ke 224×224.

### URL_ALLOWLIST

Kosong = host publik mana pun boleh; alamat privat, loopback, link-local, dan
CGNAT tetap ditolak. Kalau gambar hanya datang dari domain tertentu, isi
daftarnya — itu batas yang jauh lebih ketat:

```
URL_ALLOWLIST=cdn.example.com,images.example.com
```

Isi dengan hostname polos, tanpa skema dan tanpa port. Divalidasi saat startup.

---

## 6. Jalankan

```bash
IMAGE_TAG=1.0.0 docker compose -f docker-compose.prod.yml up -d
```

Container mem-bind ke `127.0.0.1` saja. Itu disengaja — nginx yang menghadap
jaringan. Tanpa prefix itu Docker akan mempublikasikan ke semua interface dan
menembus firewall host.

Tunggu sampai siap:

```bash
docker compose -f docker-compose.prod.yml logs -f --tail=50
```

Yang ditunggu:

```json
{"msg":"worker ready","worker":0,"backend":"tensorflow","namespace":"@tensorflow/tfjs-node"}
{"msg":"worker pool ready","workers":2}
{"msg":"Server listening at http://0.0.0.0:3000"}
```

Load model butuh 10-20 detik. Selama itu `/health` sudah 200 tapi `/ready`
masih 503 — memang begitu rancangannya, supaya restart tidak berubah jadi crash
loop saat model lambat dimuat.

---

## 7. Verifikasi

```bash
./scripts/smoke-test.sh http://127.0.0.1:3000 image-moderation:1.0.0
```

Sembilan pemeriksaan: readiness, dua penolakan auth, inference sungguhan,
penolakan non-gambar (415), penolakan URL ke jaringan host (422), dan kontrak
batch gagal-sebagian. Gambar ujinya dibuat oleh sharp milik container sendiri —
tidak perlu file fixture, tidak menyentuh internet.

```
passed: 9   failed: 0
SMOKE TEST OK
```

Ukur puncak memory dengan beban nyata di mesin Anda sendiri:

```bash
docker run --rm --entrypoint node image-moderation:1.0.0 -e 'require("sharp")({create:{width:7000,height:7000,channels:3,background:{r:120,g:80,b:160}}}).jpeg({quality:85}).toBuffer().then(b=>process.stdout.write(b.toString("base64")))' | base64 -d > /tmp/49mp.jpg
```

```bash
( for i in $(seq 1 200); do docker stats --no-stream --format '{{.MemUsage}}' nsfwjs-prod; done > /tmp/peak.txt ) & for i in $(seq 1 12); do curl -s -o /dev/null -X POST http://127.0.0.1:3000/v1/moderate -H "X-API-Key: $(grep -E '^API_KEYS=' .env.prod | cut -d= -f2 | cut -d, -f1)" -F "image=@/tmp/49mp.jpg" & done; wait; sort -h /tmp/peak.txt | tail -1
```

Baris terakhir adalah puncak sesungguhnya. Kalau di bawah 60% `mem_limit`,
konfigurasi Anda nyaman.

---

## 8. nginx di depan

```nginx
location /v1/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-Id      $request_id;

    client_max_body_size 12m;    # harus di atas MAX_UPLOAD_BYTES
    proxy_read_timeout   60s;    # harus di atas REQUEST_TIMEOUT_MS
}

# /health, /ready, /metrics TIDAK diautentikasi — jangan diekspos publik.
location ~ ^/(metrics|health|ready)$ {
    proxy_pass http://127.0.0.1:3000;
    allow 127.0.0.1;
    allow 10.0.0.0/8;
    deny all;
}
```

`X-Request-Id` diambil service dan dikembalikan sebagai `meta.requestId`,
sehingga satu request bisa dilacak dari log nginx sampai log service.

Ketiga endpoint itu sengaja dibebaskan dari API key agar healthcheck container
dan scrape Prometheus lokal tidak perlu kredensial. `/metrics` tidak memuat data
gambar, tapi membocorkan volume traffic dan distribusi verdict — tutup dari
publik.

---

## 9. Monitoring

### Kesehatan cepat

```bash
docker compose -f docker-compose.prod.yml ps && curl -s http://127.0.0.1:3000/ready | python3 -m json.tool
```

```json
{
  "status": "ready",
  "shuttingDown": false,
  "workers": { "size": 2, "ready": 2, "busy": 0, "queued": 0,
               "completed": 1432, "failed": 3, "timeouts": 0, "restarts": 0 }
}
```

`restarts` yang naik terus berarti worker berulang kali mati — periksa log.
`queued` yang konsisten tinggi berarti worker kurang.

### Resource

```bash
docker stats --no-stream nsfwjs-prod
```

### Prometheus

```yaml
scrape_configs:
  - job_name: image-moderation
    static_configs:
      - targets: ['127.0.0.1:3000']
```

Metrik yang tersedia:

| Metrik | Tipe | Guna |
|---|---|---|
| `moderation_requests_total{route,status}` | counter | rate & error rate per endpoint |
| `moderation_images_total{outcome}` | counter | distribusi verdict dan kode error per gambar |
| `moderation_request_duration_seconds{route}` | histogram | latensi ujung-ke-ujung |
| `moderation_inference_duration_seconds` | histogram | waktu murni di dalam worker |
| `moderation_queue_wait_seconds` | histogram | lama menunggu worker kosong |
| `moderation_worker_pool{state}` | gauge | `size`, `ready`, `busy`, `queued` |
| `moderation_worker_restarts_total` | counter | worker diganti karena crash/timeout |

Tiga alert yang layak dipasang:

```yaml
- alert: ModerationNotReady
  expr: moderation_worker_pool{state="ready"} == 0
  for: 2m

- alert: ModerationWorkerFlapping
  expr: increase(moderation_worker_restarts_total[15m]) > 3

- alert: ModerationQueueBacklog
  expr: moderation_worker_pool{state="queued"} > 10
  for: 5m
```

`moderation_queue_wait_seconds` yang naik sementara
`moderation_inference_duration_seconds` tetap datar adalah sinyal paling jelas
bahwa `WORKER_POOL_SIZE` perlu dinaikkan.

---

## 10. Logging

Log berformat JSON satu baris (pino), keluar ke stdout, dirotasi Docker pada
10 MB × 3 file.

```bash
docker compose -f docker-compose.prod.yml logs -f --tail=100
```

Field yang tersedia:

| Field | Isi |
|---|---|
| `level` | 30 info, 40 warn, 50 error, 60 fatal |
| `time` | ISO 8601 |
| `service` | selalu `image-moderation` |
| `reqId` | UUID, atau `X-Request-Id` dari nginx bila ada |
| `req` | `method`, `url`, `remoteAddress` |
| `res.statusCode` | status balasan |
| `responseTime` | milidetik |
| `msg` | teks pesan |

**`X-API-Key` di-redact otomatis** dan tidak pernah muncul di log.

Hanya error:

```bash
docker compose -f docker-compose.prod.yml logs --no-log-prefix | python3 -c "import sys,json;[print(l,end='') for l in sys.stdin if l.startswith('{') and json.loads(l).get('level',0)>=40]"
```

Request yang lambat (di atas 1 detik):

```bash
docker compose -f docker-compose.prod.yml logs --no-log-prefix | python3 -c "import sys,json;[print(json.dumps(d)) for l in sys.stdin if l.startswith('{') for d in [json.loads(l)] if d.get('responseTime',0)>1000]"
```

Melacak satu request dari nginx sampai service:

```bash
docker compose -f docker-compose.prod.yml logs --no-log-prefix | grep '"reqId":"MASUKKAN-UUID-DI-SINI"'
```

Naikkan verbositas sementara tanpa build ulang:

```bash
sed -i 's/^LOG_LEVEL=.*/LOG_LEVEL=debug/' .env.prod && docker compose -f docker-compose.prod.yml up -d
```

Kembalikan ke `info` setelah selesai — `debug` menghasilkan log yang sangat
banyak dan rotasi 10 MB akan cepat berputar.

Rotasi diatur di compose (`max-size: 10m`, `max-file: "3"`), jadi maksimal 30 MB
per container. Log **tidak** dikirim ke journald; kalau Anda ingin terpusat,
ganti driver logging di compose.

---

## 11. Operasi harian

Semua perintah butuh `-f` karena nama filenya tidak standar. Jalankan dari
direktori project.

```bash
docker compose -f docker-compose.prod.yml ps
```

```bash
docker compose -f docker-compose.prod.yml stop
```

```bash
docker compose -f docker-compose.prod.yml start
```

```bash
docker compose -f docker-compose.prod.yml restart
```

```bash
docker compose -f docker-compose.prod.yml down
```

`stop` mempertahankan container; `down` menghapusnya beserta network (image
tetap ada). Project ini tidak memakai named volume sama sekali — tidak ada data
yang bisa hilang, karena hanya hash SHA-256 yang disimpan, tidak pernah file
gambar.

**Shutdown itu bertahap.** `stop_grace_period: 30s` memberi waktu SIGTERM
bekerja: `/ready` jadi 503 lebih dulu selama `SHUTDOWN_DRAIN_MS` (3 detik) agar
nginx berhenti mengirim traffic, lalu listener ditutup, request yang berjalan
diselesaikan, baru worker diterminasi.

Mengubah env tanpa build ulang:

```bash
docker compose -f docker-compose.prod.yml up -d
```

Compose mendeteksi perubahan `.env.prod` dan me-recreate container.

---

## 12. Upgrade & rollback

Selalu beri tag versi, jangan `latest`. Itu yang membuat rollback jadi satu
perintah.

```bash
cd /srv/image-moderation && git pull && docker build --platform linux/amd64 -t image-moderation:1.1.0 .
```

Uji di staging dulu — **image yang sama**, hanya env dan port yang berbeda:

```bash
IMAGE_TAG=1.1.0 docker compose -f docker-compose.staging.yml up -d && ./scripts/smoke-test.sh http://127.0.0.1:3001 image-moderation:1.1.0
```

Kalau lolos, naikkan ke produksi:

```bash
IMAGE_TAG=1.1.0 docker compose -f docker-compose.prod.yml up -d
```

Rollback:

```bash
IMAGE_TAG=1.0.0 docker compose -f docker-compose.prod.yml up -d
```

Simpan minimal dua versi terakhir. Bersih-bersih image lama:

```bash
docker image ls image-moderation && docker rmi image-moderation:0.9.0
```

Staging dan produksi memakai `name:` project yang berbeda, jadi bisa jalan
berdampingan. Kalau Anda menyalin file compose, **pastikan `name:` ikut
diganti** — dua file dengan nama project sama akan saling menghapus container.

---

## 13. Troubleshooting

### Build

| Gejala | Penyebab | Perbaikan |
|---|---|---|
| `tf.getBackend is not a function` | `package-lock.json` bukan milik proyek ini; `npm ci` memasang tfjs-node 1.x | bandingkan checksum lockfile, salin ulang, build ulang |
| `keys=2` pada `@tensorflow/tfjs-node` | sama seperti di atas | idem |
| nested `tfjs-node/node_modules/@tensorflow/tfjs-core` | lockfile npm v6 (lockfileVersion 1) | pakai lockfile v3 dari repo |
| `Killed` / exit 137 saat `npm ci` | RAM build kurang | sediakan ~2 GB bebas |
| `backend: cpu`, bukan `tensorflow` | binding native tidak termuat | pastikan base glibc dan platform amd64 |
| Build sukses di Alpine lalu gagal jalan | musl | wajib `node:22-bookworm-slim` |

Stage `verify` sekarang menangkap semua kasus di atas saat build, dengan pesan
yang menyebut penyebabnya langsung.

### Runtime

| Gejala | Penyebab | Perbaikan |
|---|---|---|
| `/ready` 503 terus | model gagal dimuat | `logs` — cari `model load failed` |
| `Could not locate the bindings file` | node_modules dari platform lain | build ulang image, jangan mount node_modules host |
| Container di-OOM-kill | `mem_limit` terlalu kecil | `docker inspect ... --format '{{.State.OOMKilled}}'`; naikkan limit atau turunkan `MAX_CONCURRENT_REQUESTS` |
| Container gagal start setelah bind IP LAN | IP tidak ada di interface | pakai IP statis, atau kembali ke loopback |
| Container tidak start, tanpa pesan jelas | `read_only: true` | coba hapus baris itu beserta `tmpfs` untuk memastikan |
| 413 pada upload yang wajar | `client_max_body_size` nginx | naikkan di atas `MAX_UPLOAD_BYTES` |
| 504 `INFERENCE_TIMEOUT` | mesin kelebihan beban | naikkan `INFERENCE_TIMEOUT_MS` atau kurangi beban |
| `restarts` naik terus | worker crash berulang | `logs` — cari `restarting inference worker` |
| Latensi naik, inference tetap datar | worker kurang | naikkan `WORKER_POOL_SIZE` |
| Startup gagal, daftar env dicetak | validasi konfigurasi | perbaiki semua yang disebut; semuanya dilaporkan sekaligus |

### Diagnostik mendalam

Kalau TensorFlow bermasalah dan pesannya kurang jelas:

```bash
docker build --platform linux/amd64 --target verify --progress=plain -t im-verify . 2>&1 | tail -40
```

Bagian `module forensics` mencetak path yang di-resolve, jumlah salinan
tfjs-core, `module.loaded`, ukuran `index.js`, dan daftar backend terdaftar —
cukup untuk membedakan setiap mode kegagalan di tabel di atas.

Jangan menjalankan diagnostik dengan mem-mount direktori project ke `/app`:
`node_modules` di host akan menaungi milik image dan hasilnya menyesatkan.

---

## Referensi cepat

```bash
# status
docker compose -f docker-compose.prod.yml ps

# log
docker compose -f docker-compose.prod.yml logs -f --tail=100

# kesehatan
curl -s http://127.0.0.1:3000/ready | python3 -m json.tool

# resource
docker stats --no-stream nsfwjs-prod

# uji fungsional
./scripts/smoke-test.sh http://127.0.0.1:3000 image-moderation:1.0.0

# restart
docker compose -f docker-compose.prod.yml restart

# rollback
IMAGE_TAG=1.0.0 docker compose -f docker-compose.prod.yml up -d
```

# Vectorio

A fully self-hosted PNG → SVG studio. Upload, trace, remove background regions, select and delete vector shapes, recolor, crop, undo/redo, compare with the original, and download SVG. Edits are saved on your server. No CDN, external fonts, analytics, hosted tracing, AI API, GPU, Redis, or online service is used at runtime.

## Run with Docker

```sh
docker compose up --build -d
```

Open **http://localhost:8000**. The first build downloads Python, its base image, and open-source packages. For an offline server, build the images on a connected machine, transfer them using `docker save`/`docker load`, then run `docker compose up -d --no-build --pull never`.

```sh
docker compose logs -f worker
docker compose down
```

Data persists in the `vectorio-data` Docker volume. `docker compose down -v` deletes all projects. The app defaults to loopback access; set `BIND_ADDRESS=0.0.0.0` in `.env` to expose it. For public deployments put it behind your own TLS reverse proxy and access controls; browser cookies isolate projects but are not a user login system. Forward the original Host and scheme (configure Uvicorn's trusted proxy addresses for your proxy), set `COOKIE_SECURE=true` for HTTPS, and set the proxy body-size/time limits to match uploads. Do not use an untrusted proxy's forwarded headers.

## Editing

The main screen keeps upload, background/color removal, selection/erasing, Undo, and download visible. **Trace settings** and **Recent files** open from the upload bar. **More editing tools** contains background fine-tuning, recoloring, the full palette, crop/reset, and trace notes. Color tolerance is under **Include similar shades**. New uploads default to Exact PNG at native resolution.

1. Upload a PNG, or use **Try a sample design**. The default **Logos & text / Native** profile traces at the source resolution, retains small marks, and uses eight-bit color precision. For tiny lettering, **Exact pixel contours** avoids curve fitting (it also retains pixel stair steps). The simplified artwork profile is a faster, less faithful alternative. Trace settings apply to the next upload; re-upload an older PNG to use new settings because source PNGs are deleted after processing.
2. Use **Remove edge background** for a flat background, or **Pick a region** to remove a specific vector shape. The edge tool samples the border and removes shapes in the dominant edge color; it is a heuristic, not semantic object segmentation. Increase tolerance for similar shades. **Remove every shape of that color** also removes matching interior regions, so use Undo if needed.
3. Select shapes; Shift-click selects more. Delete removes them. Change their fill color or use a palette swatch to select matching shapes. Eraser mode removes individual shapes with one click.
   **Remove a color** deletes matching fills across the entire vector, including disconnected areas and shapes outside the current crop. Use **Pick color from canvas**, a design-palette swatch, or the color input, then **Remove color**. The match count updates before removal. Its separate tolerance defaults to 0 (exact color); increase it to include similar shades. The action is saved and can be undone/redone as one operation. It uses current recolored fills and skips already removed shapes.
4. Drag a crop rectangle to change the exported viewBox. Crop does not destroy paths outside the viewBox. Reset crop restores them.
5. Download SVG. The downloaded file contains current edits even if a server save fails. Server saves use revision checks so another tab cannot silently overwrite edits.

The **Palette** uses large circular color groups with small shade bubbles inside. Drag a shade anywhere onto a circle to move it into that group; dropping on an inner bubble has the same effect. Drag into blank palette space or the marked split area to create a separate circle. A compact bubble's shades stay together when dragged out. Drag a circle rim onto another circle to join their groups. Dragging never changes artwork fills. Use **Merge** explicitly to combine selected shades into one fill. **Split** separates selected colors into individual circles without restoring previously merged colors. **Restore merged shades** restores their remembered colors, even after reloading. **Edit** opens recoloring; **Remove selected color** deletes the selected shade everywhere. Circle membership and merge sources are saved with the project, and all moves, merges, splits, and removals support Undo/Redo. Keyboard users can select circles or shades and use Merge, Split, or **Move without dragging**. Escape, loss of pointer capture, or a drop outside the palette cancels the drag.

Opening a project groups the palette without changing fills. **Merge near-identical shades** is now strictly manual; it uses an OKLab distance of 0.018 and can be undone or reversed with **Restore merged shades**. Previously saved merges remain part of older projects.

**Exact PNG** is the default for new uploads. It uses the original resolution and emits integer pixel rectangles as editable SVG paths, preserving decoded RGBA colors, transparency, one-pixel marks and lettering. It does not smooth, filter, quantize or retry with fewer colors. Equal RGBA runs are collected into compound paths, so selecting a path can select disconnected areas of the same paint. Exports contain vector paths, not an embedded PNG. The tradeoff is larger files and visible source pixel edges when enlarged. Images exceeding the path, SVG size or native pixel limits fail explicitly. Choose Logos & text or Illustrations only when smoothing/simplification is desired. Existing traces must be re-uploaded to recover detail lost during their original conversion.

**Auto group** reorganizes circles without recoloring the artwork. The source preview's pixel coverage identifies dominant paint colors; nearby shades are assigned to their nearest paint, keeping distinct reds or oranges separate. Low-coverage antialiasing mixtures are attached to their contributing paints. Unrelated colors still get their own groups. If the preview cannot be read, perceptual clustering remains available. **Group shades** offers Precise, Balanced (default), and Broader settings. Compact bubbles collect small variations; enable **Show all shades individually** to move or remove an exact fill. Compact bubble selection and dragging act on all of its shades. Existing circles receive a one-time grouping upgrade; later manual moves and splits remain saved. Undo restores the previous arrangement without repeating the upgrade on reload. Paint detection is heuristic: small accent colors and continuous gradients may still need manual adjustment.

Shortcuts: `V` select, `H` pan, `B` background picker, `E` erase, `C` crop, Space+drag pan, wheel zoom, Delete remove, Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo. Touch supports selection, tools, dragging, and zoom buttons.

Projects belong to a random HttpOnly session cookie on that browser. Clearing cookies loses access. Source PNGs are deleted after processing; only a reduced PNG comparison preview and SVG remain. Projects expire **24 hours after upload** by default, even if recently edited. Download work you want to keep. Cancellation stops the processing subprocess; permanent cleanup follows within a minute.

## Architecture and limits

```text
Browser → FastAPI web container → streamed PNG on shared disk
                              → SQLite WAL job queue
          worker container → isolated tracing subprocess → VTracer → SVG
Browser ← SVG + preview     → edit paths locally / autosave operations
```

The worker claims one job at a time with a SQLite transaction. It spawns a disposable process for decoding and tracing, sends a heartbeat, kills timed-out jobs, detects worker crashes, and cleans expired jobs. You can scale workers on **one host with a local Docker volume** using `docker compose up -d --scale worker=2`; each additional worker needs its own memory and CPU allocation. SQLite WAL is not suitable for a volume shared between hosts over NFS. Multi-host scheduling is outside this implementation.

Uploads stream to disk and reserve a queue slot before receiving the body. PNG dimensions are checked before decoding, then the worker verifies the image. Upload, pixel, path, and output-size limits protect disk, memory, and the browser. A minimum free-disk check prevents starting an upload on a nearly full server. Retention controls disk growth; deploy a disk quota and proxy rate limits for an untrusted public audience.

The application cannot run arbitrarily large images on arbitrary hardware. libvips performs sequential thumbnail decoding where the PNG format permits it; Pillow then handles only the reduced image. Interlaced PNGs and some decoder paths still need significant full-image storage, and tracing adds memory. Downsampling limits tracing costs, but source dimensions and encoding still matter. Container memory limits stop an oversized job from exhausting the host; recovery marks it failed and directs the user to smaller input or faster settings. Native decoder concurrency is limited to one thread per worker. The default worker budget is 2 GB. It needs no GPU. Animated PNGs are rejected; export a single frame first.

| Quality | Maximum trace edge | Purpose |
| --- | ---: | --- |
| Native (default) | Original resolution, up to `MAX_NATIVE_PIXELS` | Logos, lettering, sharp design details; no silent resizing |
| Fast | 1,024 px | Small servers, quick previews |
| Balanced | 2,048 px | Typical logos and illustrations |
| Detailed | 4,096 px | Finer detail, higher memory use |

Fast, Balanced, and Detailed are capped by `MAX_TRACE_DIMENSION`. Native uses a separate pixel budget (16 MP by default) and rejects images above that budget instead of silently resizing them. Raising `MAX_NATIVE_PIXELS` increases tracing memory, output complexity, and processing time. The UI reports when a vector was resized. The SVG preserves the source's output width and height while curves use the traced resolution. It scales cleanly, but downsampling cannot preserve fine details that were removed. Text is traced as outlines, not recognized or reconstructed as editable font text. Transparent PNG regions are preserved by the tracer. Flat artwork produces better output than photographs. Cutout tracing allows individual regions to be removed without exposing an underlying full-image background layer. This is shape editing, not Bézier node editing.

The tracer is pinned to **VTracer 1.0.0-alpha.4** to use the corrected cutout geometry; the previous 0.6.12 cutout path could omit glyph regions. This is an upstream prerelease, covered here by rendered text-fidelity, transparency, and editor regression tests. Path optimization is disabled so distinct color regions remain separately editable. Exact pixel contours are supported by the new engine. A reproducible fixture with 12 px and 24 px lettering, isolated dots, and a one-pixel line is available via `python scripts/check_text_quality.py`; it saves original/before/after comparisons and measured pixel errors in `test-results/`.

When a trace exceeds the editor's shape limit, tiny faces (up to 8 × 8 trace pixels) of the same color are packed into compound paths, first within small tiles and then larger tiles if needed. Their contours are retained, but grouped fragments are selected/recolored/deleted together. Larger regions stay independently editable. If packing alone is insufficient, the worker retries at most three times with reduced color precision and palettes of 256, 128, then 64 colors. Resolution and noise filtering stay as requested. The studio note reports grouping and color adjustments. The existing process timeout, memory, SVG-size, and shape budgets still apply; exceptionally complex images can still exceed them.

Copy `.env.example` to `.env` to tune limits. Suggested starting points, not measured guarantees:

| Server | Settings |
| --- | --- |
| Small, ~1 GB RAM | Fast; `WORKER_MEMORY=640m`, `WEB_MEMORY=192m`, `MAX_TRACE_DIMENSION=1024`, `MAX_IMAGE_PIXELS=8000000`, `MAX_UPLOAD_MB=32`, `MAX_PENDING_JOBS=2` |
| General, ~4 GB RAM | Defaults, one worker |
| Larger, 8+ GB RAM | Increase worker memory if needed; add workers to process more jobs concurrently |

## Local development and tests

Python 3.11+ is supported. No frontend build step is needed.

```sh
python -m venv .venv
# Windows: .venv\Scripts\activate
# Linux/macOS: source .venv/bin/activate
pip install -r requirements-dev.txt
python scripts/create_sample.py
uvicorn backend.main:app --host 127.0.0.1 --port 8000
# In another terminal, with the same environment:
python -m backend.worker
python -m pytest -q
node --test tests/test_palette.cjs
```

The test stage also runs the same suite under Linux without touching the persistent app volume:

```sh
docker build --target test -t vectorio-tests .
docker run --rm --network none vectorio-tests
python scripts/benchmark.py --width 12000 --height 8000 --quality fast
```

The benchmark generates a flat-color PNG and submits it to the running containers. It reports wall time, tracing resolution, shape count, and Linux peak process RSS in `test-results/benchmark.json`. The initial 0.6.12 implementation processed a **12,000 × 8,000 (96 MP)** flat-color design at Fast quality in **5.25 seconds from upload to ready**, with **113.3 MB peak tracing-process RSS**. These historical numbers do not describe the new fidelity-oriented defaults. Benchmark the current engine with settings representative of your designs; a simple three-shape design is not a throughput guarantee for complex artwork or noisy photographs.

`DATA_DIR` defaults to `./data`. The tests use `.tmp/test-data` and cover real tracing, transparency, downsampling, export, edits, cookie isolation, malformed uploads, queue pressure, cancellation, recovery, and expiration. Runtime packages are pinned in `requirements.txt`; development tests are separate. Docker uses Linux amd64 native VTracer wheels. Other architectures may need a Rust toolchain to build VTracer from source; test the image on your deployment architecture.

### API

All job routes are scoped to the session cookie. `GET /api/config` initializes a session for non-browser clients. POST accepts raw PNG bytes (`Content-Type: image/png`), avoiding multipart buffering.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | API/database health |
| `GET /api/config` | Server input limits |
| `POST /api/jobs?name=design.png&quality=balanced&colors=6&speckle=8&mode=spline` | Stream upload; returns 202 with job ID |
| `GET /api/jobs` | This browser's recent projects |
| `GET /api/jobs/{id}` | Status, stage, trace metadata, edits, revision |
| `GET /api/jobs/{id}/svg?original=true` | Original vector |
| `GET /api/jobs/{id}/svg?download=true` | SVG with saved edits |
| `GET /api/jobs/{id}/preview` | Reduced original raster |
| `PUT /api/jobs/{id}/edits` | `{ "deleted": ["shape-0"], "fills": {}, "crop": null, "revision": 0 }`; optional `palette_groups`, `palette_sources`, and `palette_auto_merged` preserve palette operations |
| `DELETE /api/jobs/{id}` | Cancel and schedule removal |

Health checks validate the web process and database; they do not prove worker availability. Monitor worker container status and logs. Failed jobs expose a helpful message to the owner; stack traces stay in server logs.

Tracing uses [VTracer](https://github.com/visioncortex/vtracer) (MIT). See `THIRD_PARTY_NOTICES.md` for dependency notices.

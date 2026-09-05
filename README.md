# SIGMET IWXXM replay proof of concept

This project replays aviation SIGMET warnings supplied as IWXXM 2023-1 bulletins. It produces the legacy banner interface files used by an existing display integration and a time-stepped MapLibre website for inspecting the same archive.

It is an archive replay, not a live operational warning service.

## User experience

The upper section shows every valid SIGMET as a banner. When a cancellation is effective, the cancellation and the original SIGMET remain paired in the banner area until the original validity ends. This preserves the cancelled warning’s content rather than making it silently disappear.

The map shows only active hazards. Each area has the reported polygon, visible hazard code, a schematic movement arrow, and reported speed. Selecting a polygon, compact code label, or banner opens a popup on the map with both the embedded alphanumeric message and decoded IWXXM values. Intensity has four explicit states: **↑ Intensifying**, **= No change**, **↓ Weakening**, and **Not reported**.

The time player advances in 30-minute UTC intervals from 1 May 2026 00:00 through 31 May 2026 23:30. Polygons remain at their reported position; the arrow communicates motion and does not translate the geometry.

## Architecture

```text
IWXXM archive and embedded TAC comment
data/aviation_sigmet/2026/05/<day>/
                 │
           scripts/pipeline.py
      ┌──────────┼─────────────────┐
      │          │                 │
legacy XML   legacy PNG     public/data/sigmets.json
and image    overlay                 │
same day directory            MapLibre replay website
```

The pipeline reads source files only. It keeps a baseline of hashes for original inputs and rejects changed, missing, or unexpected source files. It excludes generated XML and PNG files during input discovery.

## Local development

Requires Node.js 22.13+ and Python 3.11+.

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env
# Set MAPTILER_API in .env
npm run dev
```

Open `http://127.0.0.1:5173/`. MapTiler needs internet access for tiles. The replay data, symbols, and MapLibre worker remain local.

Suggested review positions: 1 May 07:00 UTC (cancellation pair), 12 May 14:30 UTC (severe icing), and 27 May 15:00 UTC (cancellation/replacement context).

## Interface files

### Original archive input

`../data/aviation_sigmet/2026/05/<day>/LSSR*` are extensionless WMO bulletin envelopes containing IWXXM. The pipeline reads structured IWXXM fields and the XML comment that preserves the alphanumeric TAC message. Nearby `WSSR*` files are preserved companion bulletins; they are not overwritten or used as a second display source.

[`source-hashes.json`](source-hashes.json) contains the baseline for all 386 original archive files. Never edit, rename, move, or overwrite source files.

### Legacy banner XML

Every IWXXM source produces exactly one interface file beside the source in its day directory:

```text
Sigmetdata_YYYYMMDD_DDHHmm.xml
```

It is a `channel/item` XML document with these integration fields:

| Field | Meaning |
| --- | --- |
| `Year`, `Month`, `Day` | UTC issue date |
| `SIGMETIssue` | UTC issue time (`HHmm`) |
| `Type` | SIGMET type/series prefix |
| `SIGMET_NO` | warning sequence number |
| `IMAGE_NAME` | actual companion PNG filename |
| `VALID_START`, `VALID_END` | UTC validity endpoints |
| `CNL` | cancellation indicator |
| `SIGMET` | WMO heading plus normalized alphanumeric message |

The legacy sequence mapping is preserved: `A01` maps to `1`; `B01` maps to `51`. `DDHHmm` uses the bulletin issue time, avoiding the collision in the old filename slice.

### Legacy PNG overlay

The image named by `IMAGE_NAME` is written beside the same source with this format:

```text
sigmet_<type>_<legacy-number>_YYYYMMDD_DDHHmm.png
```

It is a transparent 1503×1503 regional overlay containing the reported polygon, hazard label, and movement arrow. A cancellation image retains the original geometry and adds a prominent cancellation label. Natural Earth 1:10m coastlines are cached under `.cache/natural-earth/`; no reference shapefile is required.

The PNG is an archive compatibility interface and is not consumed by the website.

### Website replay dataset

[`public/data/sigmets.json`](public/data/sigmets.json) is the canonical web interface. Regenerate it through the pipeline; do not edit it by hand.

Each `records[]` item contains source identity/hash, issue and validity times, FIR and issuer, hazard code and WMO URI, verbatim TAC, decoded conditions, cancellation links, and quality notes. A decoded condition looks like this:

```json
{
  "vertical": "TOP FL520",
  "intensity": "INTSF",
  "motion": { "label": "MOV W 5KT", "bearing": 270, "stationary": false },
  "anchor": [106.6, 4.4],
  "geometry": { "type": "MultiPolygon", "coordinates": [] }
}
```

Geometry is GeoJSON `[longitude, latitude]`, intentionally different from IWXXM GML coordinate ordering. Cancellations use `targetId`, `cancelledBy`, and `cancelEffective` to link the two reports.

### Supporting assets and manifests

- `public/symbols/`: pinned WorldWeatherSymbols SVGs, source manifest, and CC BY 4.0 attribution. The WMO code remains visible and is the fallback if a symbol is unavailable.
- `public/maplibre/`: MapLibre worker and shared module copied from the installed MapLibre version by `scripts/prepare-map-worker.mjs`.
- `reports/output-manifest.json`: generated XML/PNG ownership and hashes.
- `reports/pipeline-audit.md`: parsing findings and the source-quality audit.

## SIGMET behaviour

- A normal warning is displayed after its issue time and within `[validFrom, validTo)`.
- Cancellation effectiveness is the later of cancellation issue time and cancellation validity start.
- Once effective, cancelled originals and their cancellation reports have no map polygon. Their paired banner remains visible until the original validity expires.
- The popup’s alphanumeric message is taken verbatim from the IWXXM XML comment. Decoded values come from structured IWXXM.
- An embedded `STNR` supplies stationary motion when structured IWXXM lacks movement. Other absent values remain `Not reported`.
- One record contains an invalid month in structured end time. The derived data applies a narrow TAC-corroborated month-rollover correction, retains `rawValidTo`, and adds a quality note. Source bytes are unchanged.

## Regenerating outputs

Run these from this project directory:

```bash
npm run data:check    # validate archive and expected outputs
npm run data:build    # create XML, PNG, manifests, and replay JSON
npm run data:web      # create replay JSON only; does not write XML or PNG
```

The pipeline refuses output-name collisions and will not overwrite files it does not own.

## Verification

```bash
npm test
npm run test:pipeline
npm run typecheck
npm run lint
npm run build
```

JavaScript tests exercise all 1,488 time positions, cancellation boundaries, reverse seeking, and symbol mappings. Python tests verify XML/PNG pairing, source integrity, and output manifests.

## GitHub Pages

[`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) creates a static export under `/sigmet-wiw2-astra/`. The code uses prefix-aware paths so replay JSON, symbols, and MapLibre worker load correctly from a project Pages URL.

Before a Pages deployment, add the repository Actions secret `MAPTILER_API`. It is injected during the build and is necessarily present in the resulting browser bundle because MapLibre uses it to request tiles. Restrict the key’s allowed origin in MapTiler to:

```text
https://songhan89.github.io/sigmet-wiw2-astra/
```

Then enable **Settings → Pages → Build and deployment → GitHub Actions**. Pushes to `main` will run the checks and deploy the site. `.env`, the raw archive, generated XML/PNG siblings, local caches, and build output are not committed.

## Attribution and limitations

Map tiles are supplied by MapTiler. Symbols are selected from [OGC MetOcean DWG WorldWeatherSymbols](https://github.com/OGCMetOceanDWG/WorldWeatherSymbols), CC BY 4.0. WMO phenomenon URIs identify code definitions, not image resources.

The supplied archive starts after May begins and ends before a final report becomes valid. Warnings outside that archive cannot be reconstructed. The application never invents FIR boundaries; it renders reported SIGMET geometry only.

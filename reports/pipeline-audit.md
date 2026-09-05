# Reference pipeline audit and corrected implementation

## Outcome

Processed **193 IWXXM reports**, producing **193 XML files and 193 transparent 1503×1503 PNGs** beside the inputs. The archive contains 176 embedded-thunderstorm reports, one severe-icing report and 16 cancellations. All cancellations resolve to their originals. All **386 original source files** retain their baseline SHA-256 hashes.

The supplied reference implementation was inspected, not executed. Its hardcoded production prerequisites are absent, and its shell wrapper moves/deletes source files. The corrected, self-contained implementation is `scripts/pipeline.py`.

## Confirmed reference defects

| Finding | Effect | Correction |
|---|---|---|
| Shell wrapper fetches remote data, moves input files and ends with `rm` | Violates immutable-source requirement; unsafe for this archive | Independent local read-only input processing; no shell-wrapper execution |
| `filename[16:23]` used for pairing and output suffix | 45 groups contain multiple IWXXM reports; unrelated inputs collide and XML outputs overwrite | Parse each IWXXM independently; suffix uses bulletin DDHHmm, giving 193 unique XML names |
| Fixed `files[0]`/`files[1]` and modification-time ordering | Missing pairs can crash; copied timestamps can swap TAC and XML | Website TAC comes from the IWXXM comment; companion WSSR files are not required for decoding |
| Only slices at `<?xml`, retaining ETX transport terminator | XML parse fails on supplied files | Remove framing/control characters in memory before parsing |
| Parse error is printed but execution continues | Unbound or stale XML root may be used | Fail with source-specific diagnostic before output generation |
| Hazard lookup hardcodes IWXXM 3.0 and searches the wrong nesting level | Supplied 2023-1 bulletins have missing hazard labels | Explicit supported namespace and report/field paths |
| Takes first descendant time or FIR-like name | Confuses semantic contexts, especially Singapore issuer versus Jakarta affected FIR | Scoped issue/validity/affected-region/MWO extraction |
| `SIGMETIssue = desired_string[0:4]` | Writes `2605` for May 2026 instead of issue HHmm | Format the scoped issue timestamp |
| Cancellation search restricted to five recent XML and ten PNG files | Valid originals may be missed; missing match can crash | Whole-archive identity index including FIR, issuer, sequence and full validity interval |
| Image fallback matches sequence prefix | Reused daily sequences can select unrelated images | Exact cancellation link; render from linked original geometry |
| All `posList` descendants treated as equivalent polygons | Can confuse multiple geometries or polygon interiors | Parse scoped analysis surfaces, exterior/interior rings and EPSG:4326 axis order |
| Only final polygon supplies annotation variables | Multi-area annotations can be wrong or variables absent | Per-condition geometry and annotations |
| Compass offsets have incorrect NNE/NNW vectors; speed assumes KT | Wrong directions and mislabelled units | Numeric geographic bearing and explicit unit handling |
| Phenomenon string joined character-by-character | Spaced-out hazard descriptions | Use standardized text codes |
| Hardcoded logging and coastline/FIR shapefile paths | Cannot run as distributed in this workspace | Project-local configuration and cached Natural Earth coastlines |

## Source issue discovered during validation

Source: `data/aviation_sigmet/2026/05/31/LSSR20WSSS312318260531231831`

- Issue: `2026-05-31T23:18:00Z`
- IWXXM start: `2026-05-31T23:45:00Z`
- Raw IWXXM end: **`2026-05-01T02:45:00Z`**
- Embedded TAC: `VALID 312345/010245`
- Derived end: **`2026-06-01T02:45:00Z`**

The original end precedes the start. The embedded TAC corroborates a three-hour validity period crossing into June. The parser corrects only a same-month backward end whose DDHHmm exactly matches TAC and whose next-month result is positive and at most six hours. It retains the raw timestamp, source hash and a quality note. All other invalid periods fail explicitly. No source file was edited.

## Rendering and replay decisions

Natural Earth 1:10m coastlines replace missing reference coastlines. PNGs retain the original regional extent (96–120°E, 4°S–14°N), text phenomenon codes and motion direction/speed. Labels sit away from small polygons. Cancellation PNGs retain the original area and show CANCELLED; this archival rendering is distinct from the interactive website, which removes cancelled polygons entirely.

The website consumes one canonical JSON dataset derived from the same records used by XML generation. Its legacy XML counterpart retains the original schema and intentionally cannot carry full cancellation links or full ISO timestamps. The internal JSON supplies those without changing the interface schema.

Reported geometry is fixed during playback. Cancellation starts at `max(issueTime, validFrom)` and linked banner history ends at the original `validTo`. The dataset has all 31 day directories, but the presence of files does not prove completeness outside this supplied archive.

## Validation coverage

- Seven Python test cases, including all output files, source hashes, cancellation identity, filenames, units, geometry, framing and source rollover.
- Seven JavaScript tests covering all 1,488 replay frames, all 16 cancellations, half-open validity, backward seeking, movement bearings, intensity text and local WMO-URI symbol mappings.
- TypeScript compilation and production build.
- Local route HTTP check and authenticated MapTiler style request (key not logged).
- Visual inspection of representative icing and cancellation PNGs.

Browser click-through/visual QA was not performed. The optional WebMCP integration remains unverified because a compatible runtime was unavailable. Build-time MapLibre chunk-size warnings are expected for the dynamically loaded map library.

## References

- Supplied APAC SIGMET Guide, 12th edition, November 2025: §§3.2, 3.5.3.8–9 and 3.5.4.
- Supplied APAC IWXXM implementation guidelines (2016), with actual data parsed against its declared IWXXM 2023-1 namespace.
- Supplied APAC ROBEX Handbook, 19th edition, February 2026.
- https://codes.wmo.int/49-2/SigWxPhenomena
- https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-coastline/
- https://maplibre.org/maplibre-gl-js/docs/

## Web-app follow-up

The web app now retains each original WMO `phenomenon/@xlink:href`. These links are code-definition resources, not image URLs. Recognized URIs map to 11 locally cached ICAO assets from WorldWeatherSymbols, pinned at revision `1b907f04da74c6dfd89508bab119e330ffd2f7b0`. The exact text code remains visible and is the fallback for unknown URIs and failed images. Source URLs, asset hashes and CC BY 4.0 licence are in `public/symbols/manifest.json` and `public/symbols/LICENSE.md`.

`--web-only` refreshes JSON without writing XML or PNGs. The final symbol change used this path.

MapLibre 6's automatic worker URL broke under Vite dependency optimization. A reproducible predev/prebuild script now serves the matching package worker and shared module from explicit local URLs. The app, worker, shared module and thunderstorm symbol pass HTTP checks. Tailwind scanning is limited to app source and the used slider to avoid scanning generated data/cache files.

The starter's vulnerable dependencies were updated with matching peer versions. The final npm installation reports zero known vulnerabilities. Application lint and TypeScript checks pass. Unused scaffold components retain their upstream source and are excluded from application lint.

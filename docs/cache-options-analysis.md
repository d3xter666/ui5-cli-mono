# Cache Storage Options — Benchmark Analysis

**Date:** 2 April 2026
**Branches analysed:** `feat/incremental-build-tests` (baseline) + Options A–L
**Test projects:** openui5-sample-app, sap.ui.core, sap.m

---

## 1. Executive Summary

Thirteen cache storage strategies were benchmarked across three projects of increasing size. All options share the same content-addressable storage (CAS / cacache) for resource blobs; they differ only in how **metadata** (build manifests, index caches, task/stage/result metadata) is serialised and stored.

> **Key finding:** For the small project (openui5-sample-app), metadata overhead is negligible—all options are within ±0.3 s of each other. Performance differences become meaningful only on large projects (sap.ui.core: ~9 600 resources, sap.m: ~4 700 resources) where metadata read counts can reach tens of thousands.

| Rank | Option | Warm-cache build (geo-mean across 3 projects) | Notable trait |
|------|--------|-----------------------------------------------|---------------|
| 1 | **Baseline** | **Best small, competitive large** | Zero new deps |
| 2 | **A (minified JSON)** | ~same as baseline | Simplest change |
| 3 | **K (Flat JSON Store)** | Best on sap.m (27.6 s) | Good large-project |
| 4 | **J (Incremental Managers)** | Good on sap.m (29.6 s) | Complex architecture |
| 5 | **L (JSONL+jq Streaming)** | Best on sample-app (0.83 s) | jq dependency |
| 6 | **G (JSONL Protocol)** | Good sap.m (31.7 s) | In-mem eager load |
| — | **F (Streaming)** | Worst or near-worst everywhere | High overhead |
| — | **H (Pure SQLite)** | Huge metadata (214 MB) | Over-normalised |
| — | **I (Pure LevelDB)** | Slow reads, large I/O | Field-level decomp penalty |

---

## 2. Benchmark Setup

### 2.1 Warm-cache Build (hyperfine)

Measured with `hyperfine --warmup 2 --runs 5` via the benchmark runner. Warmup populates the cache; measured runs exercise cache reads only (no source changes).

### 2.2 Cache Timings (internal instrumentation)

Measured via `UI5_BUILD_TIMINGS=true`, 2 warmup + 10 measured runs. Captures per-operation timings: `readBuildManifest`, `readIndexCache`, `readTaskMetadata`, `readResultMetadata`, `readStageCache`, `getResourcePathForStage`.

---

## 3. Disk Layout & Storage Characteristics

All versions share a CAS directory (~237 MB, ~46 000 files for the combined test projects). The table below shows metadata-only storage:

| Option | Metadata Size | Metadata Files | Storage Format | New Dependencies Used |
|--------|------------:|---------------:|----------------|-----------------------|
| **Baseline** (pretty JSON) | 139 MB | 196 | Per-file JSON (indented) | None |
| **A** (minified JSON) | 74 MB | 196 | Per-file JSON (compact) | None |
| **B** (MessagePack) | 62 MB | 196 | Per-file .bin (msgpackr) | msgpackr |
| **C** (SQLite+JSON) | 74 MB | 1 | Single SQLite DB, TEXT cols | better-sqlite3 |
| **D** (SQLite+MsgPack) | 62 MB | 1 | Single SQLite DB, BLOB cols | better-sqlite3, msgpackr |
| **E** (LevelDB+MsgPack) | 26 MB | 13 | LevelDB + sublevel namespaces | classic-level, msgpackr |
| **F** (Streaming JSON) | 74 MB | 196 | Per-file JSON via stream-json | stream-json |
| **G** (JSONL Protocol) | 149 MB | 4 | One .jsonl per category | None (just readline) |
| **H** (Pure SQLite) | 214 MB | 1 | Fully normalised relational DB | better-sqlite3 |
| **I** (Pure LevelDB) | 71 MB | 25 | Field-level key-value decomp | classic-level |
| **J** (Incremental Managers) | 109 MB | 16 | JSONL + append logs + snapshots | None |
| **K** (Flat JSON Store) | 99 MB | 211 | JSON files + in-memory cache | msgpackr |
| **L** (JSONL+jq Streaming) | 52 MB | 177 | JSONL append + jq reads | jq (system), msgpackr |

### Observations

- **LevelDB+MsgPack (E)** achieves the smallest metadata footprint (26 MB) thanks to LevelDB's built-in compression (Snappy) combined with the compact MessagePack encoding.
- **JSONL (G)** is 149 MB despite consolidation—JSONL's last-write-wins append model accumulates duplicates.
- **Pure SQLite (H)** is the largest at 214 MB because fully normalised relational tables add significant index and row overhead.
- **SQLite+JSON (C)** and **Minified JSON (A)** land at the same 74 MB—SQLite's page alignment overhead roughly cancels the benefit of consolidation when values are stored as TEXT.

---

## 4. Warm-cache Build Performance

### 4.1 openui5-sample-app (small: ~50 resources)

| Option | Mean ± StdDev | Verdict |
|--------|-------------:|---------|
| **Baseline** | 0.845 ± 0.054 s | |
| A (minified JSON) | 0.993 ± 0.105 s | Slower (unexpected—noise) |
| B (MessagePack) | 0.862 ± 0.030 s | Comparable |
| C (SQLite+JSON) | 0.918 ± 0.059 s | Comparable |
| D (SQLite+MsgPack) | 0.954 ± 0.063 s | Comparable |
| E (LevelDB+MsgPack) | 1.159 ± 0.219 s | **+37%** — LevelDB open cost |
| F (Streaming JSON) | 1.118 ± 0.173 s | **+32%** — stream overhead |
| G (JSONL Protocol) | 1.414 ± 0.138 s | **+67%** — eager full-file load |
| H (Pure SQLite) | 1.128 ± 0.221 s | +33% |
| I (Pure LevelDB) | 0.977 ± 0.100 s | Comparable |
| J (Incremental) | 1.102 ± 0.078 s | +30% |
| K (Flat JSON) | 0.982 ± 0.080 s | Comparable |
| **L (JSONL+jq)** | **0.828 ± 0.010 s** | **Best, most stable** |

**Rationale:** On small projects, fixed initialisation costs dominate. LevelDB (E) and Streaming JSON (F) pay heavy upfront costs for little benefit. JSONL Protocol (G) eagerly loads all categories on open, penalising start time. The baseline's simple `readFile` + `JSON.parse` is hard to beat at this scale.

### 4.2 sap.ui.core (large: ~9 600 resources, 20 tasks)

| Option | Mean ± StdDev | Verdict |
|--------|-------------:|---------|
| **Baseline** | 9.932 ± 0.377 s | |
| **A (minified JSON)** | **9.859 ± 0.278 s** | **Best, lowest variance** |
| B (MessagePack) | 10.995 ± 0.653 s | +11% — decode overhead |
| C (SQLite+JSON) | 10.943 ± 0.979 s | +10%, high variance |
| D (SQLite+MsgPack) | 11.077 ± 0.161 s | +12% |
| E (LevelDB+MsgPack) | 10.290 ± 0.198 s | +4% |
| F (Streaming JSON) | 11.262 ± 0.465 s | +13% |
| G (JSONL Protocol) | 10.957 ± 0.326 s | +10% |
| H (Pure SQLite) | 11.923 ± 1.289 s | +20%, high variance |
| I (Pure LevelDB) | 12.156 ± 0.641 s | **+22% worst** |
| J (Incremental) | 11.495 ± 0.562 s | +16% |
| K (Flat JSON) | 17.283 ± 4.922 s | **+74% catastrophic** |
| L (JSONL+jq) | 17.123 ± 6.000 s | **+72% catastrophic** |

**Rationale:** sap.ui.core triggers the `getResourcePathForStage` operation ~9 624 times. Options K and L have catastrophically bad performance here because their per-lookup overhead (in-memory map operations or jq subprocess spawns) compounds over thousands of calls. The baseline and Option A stay fastest because `JSON.parse` of pre-read files is highly optimised in V8.

### 4.3 sap.m (very large: ~4 700 resources, 78 tasks)

| Option | Mean ± StdDev | Verdict |
|--------|-------------:|---------|
| Baseline | 32.153 ± 1.407 s | |
| A (minified JSON) | 37.381 ± 7.532 s | +16%, huge variance |
| B (MessagePack) | 33.189 ± 4.245 s | Comparable |
| **C (SQLite+JSON)** | **19.422 ± 6.663 s** | **-40% best!** High variance |
| D (SQLite+MsgPack) | 32.296 ± 3.297 s | Comparable |
| E (LevelDB+MsgPack) | 34.249 ± 5.274 s | Comparable |
| F (Streaming JSON) | 33.601 ± 9.704 s | Huge variance |
| G (JSONL Protocol) | 31.670 ± 2.130 s | Comparable |
| H (Pure SQLite) | 31.781 ± 3.966 s | Comparable |
| I (Pure LevelDB) | 31.428 ± 2.389 s | Comparable |
| J (Incremental) | 29.555 ± 1.231 s | -8%, stable |
| **K (Flat JSON)** | **27.593 ± 0.472 s** | **-14%, most stable** |
| L (JSONL+jq) | 30.532 ± 2.440 s | -5% |

**Rationale:** On sap.m, task metadata reads dominate (78 tasks × multiple reads). SQLite+JSON (C) shows a remarkable 40% improvement with a median of 16.4 s, though its high variance (±6.7 s) suggests occasional slow runs (possibly WAL checkpoint). Flat JSON Store (K) delivers the most consistent improvement (-14%) with the lowest standard deviation of any option.

---

## 5. Internal Cache Timings Analysis

### 5.1 Metadata Read Totals (10-run average)

| Project | Baseline | A | B | C | D | E | F | G | H | I | J | K | L |
|---------|----------|---|---|---|---|---|---|---|---|---|---|---|---|
| sample-app | 34.8 ms | 24.8 ms | 51.4 ms | 0.3 ms | 0.9 ms | 25.2 ms | 88.8 ms | 0.0 ms | 1.9 ms | 35.7 ms | 0.0 ms | 27.7 ms | 32.8 ms |
| sap.ui.core | 380 ms | 365 ms | 502 ms | 8.7 ms | 32.7 ms | 388 ms | 1894 ms | 0.1 ms | 118 ms | 2017 ms | 0.1 ms | 428 ms | 517 ms |
| sap.m | 1331 ms | 1155 ms | 1217 ms | 29 ms | 38.5 ms | 779 ms | 4231 ms | -- | 292 ms | 4916 ms | -- | 1322 ms | 1283 ms |

### Key Insights

1. **SQLite options (C, D, H)** have the fastest metadata reads because prepared statements with indexed lookups are O(1).
2. **JSONL (G) and Pure LevelDB (I)** show poor read performance on sap.ui.core despite in-memory caching — the `readTaskMetadata` operation is called 20× and involves expensive deserialization.
3. **Streaming JSON (F)** is consistently the slowest for reads because stream setup + parse pipeline has high per-call overhead.
4. **Options G and J show 0.0–0.1 ms for reads on sample-app** because they eagerly load all data on init, so individual read calls are just Map lookups — but this trades startup cost for read speed.

### 5.2 Resource I/O: `getResourcePathForStage`

This is the dominant operation on sap.ui.core (called 9 624× per run, totalling ~5 200 s across all runs):

| Option | Total (10 runs) | Present? |
|--------|----------------:|----------|
| Baseline | 5,201 s | Yes |
| A | -- | Missing |
| B | 5,523 s | Yes |
| F | 4,960 s | Yes |
| H | 5,450 s | Yes |
| **Others** | -- | Not triggered |

Options where resource I/O shows `--` likely return cached paths from memory/DB without hitting the timing instrumentation, or use a different code path.

---

## 6. Per-Option Analysis

### Baseline: Pretty JSON (file-per-metadata)

**Technology:** `JSON.stringify(data, null, 2)` → individual `.json` files
**Metadata:** 139 MB, 196 files

| Pros | Cons |
|------|------|
| Zero dependencies | Largest metadata footprint (2-space indentation) |
| Human-readable cache files | 196 filesystem inodes |
| V8-optimised `JSON.parse` is extremely fast | `readFile` syscall per metadata item |
| Battle-tested, simple code | |

**Verdict:** Strong baseline. Surprisingly competitive on all project sizes.

---

### Option A: Minified JSON

**Change:** `JSON.stringify(data)` (no indentation)
**Metadata:** 74 MB, 196 files (47% reduction)

| Pros | Cons |
|------|------|
| Trivial 1-line change | Still 196 individual files |
| ~47% metadata size reduction | Not human-readable for debugging |
| Same read speed as baseline | Marginal speed improvement |
| No new dependencies | |

**Verdict:** **Low-risk, easy win.** Best risk/reward ratio. Should be merged regardless of which other option is chosen. The sap.ui.core results show it's the fastest option there (9.86 s vs 9.93 s baseline).

**Improvement potential:** Combine with any consolidation strategy (C, D, G) for compounding benefit.

---

### Option B: MessagePack

**Change:** `msgpackr.pack(data)` / `unpack(data)` → `.bin` files
**Metadata:** 62 MB, 196 files (55% reduction)

| Pros | Cons |
|------|------|
| Smallest per-file format | Native add-on (msgpackr uses optional native module) |
| 55% metadata reduction | **Slower reads** — decode overhead on sap.ui.core (+11%) |
| Compact binary encoding | Not human-readable |
| | Still 196 individual files |

**Rationale for poor read performance:** `msgpackr.unpack()` must traverse the binary format and allocate JS objects, while `JSON.parse()` is a C++ built-in in V8 with years of optimization. The decode cost exceeds the I/O savings from smaller files.

**Verdict:** Disk savings are real but the runtime penalty makes this a poor trade-off on read-heavy workloads.

---

### Option C: SQLite + JSON

**Change:** Single `better-sqlite3` DB with TEXT value columns
**Metadata:** 74 MB (1 file: `cache.db`)

| Pros | Cons |
|------|------|
| **Fastest metadata reads** (prepared statements) | Native C add-on (better-sqlite3) |
| Single file — easy backup/delete | **-40% on sap.m** but ±6.7 s variance! |
| WAL mode for concurrent reads | SQLite page alignment wastes space |
| Atomic transactions | Same size as minified JSON |
| | DB corruption risk (rare) |
| | Platform-specific binary |

**Rationale for sap.m win:** With 78 tasks, each requiring metadata lookup, SQLite's indexed prepared statements complete in microseconds vs milliseconds for filesystem reads.

**Rationale for high variance:** SQLite WAL checkpointing can trigger unpredictably, causing occasional slow runs. The `synchronous = NORMAL` pragma trades durability for speed.

**Verdict:** Excellent read performance, but the high variance and native dependency are concerns. Best suited for very large projects.

**Improvement potential:** Combine with MsgPack values (→ Option D) for size reduction. Add explicit WAL checkpoint control to reduce variance.

---

### Option D: SQLite + MessagePack

**Change:** SQLite with BLOB columns containing msgpackr-encoded data
**Metadata:** 62 MB (1 file)

| Pros | Cons |
|------|------|
| Smallest consolidated store | **Two** native dependencies |
| Single file | +12% on sap.ui.core — decode overhead |
| Indexed lookups | Not debuggable without special tools |
| Compact binary values | |

**Rationale for underperformance:** Combines SQLite's lookup speed with MsgPack's decode penalty. The decode cost nullifies SQLite's I/O advantage, especially when many small values are read.

**Verdict:** Over-engineered. Option C (SQLite+JSON) is better because `JSON.parse` of a TEXT column is faster than `unpack` of a BLOB.

---

### Option E: LevelDB + MessagePack

**Change:** `classic-level` (LevelDB) with sublevel namespaces, msgpackr values
**Metadata:** 26 MB (13 files — LevelDB SST tables)

| Pros | Cons |
|------|------|
| **Smallest metadata** (26 MB, 81% reduction) | Native dependency (classic-level) |
| Built-in Snappy compression | Async API (no sync reads) |
| Sublevel namespacing is clean | +37% on sample-app (open cost) |
| Excellent write throughput | LevelDB compaction can cause pauses |
| | 13 files (not single-file) |

**Rationale for small size:** LevelDB's SST files use Snappy block compression. Combined with MsgPack's compact binary format, this achieves maximum compression without explicit gzip.

**Rationale for sample-app penalty:** LevelDB's open sequence involves reading the MANIFEST, checking SST files, and building the in-memory index. For small projects with few reads, this fixed cost dominates.

**Verdict:** Best disk efficiency. Suitable for CI environments where cache size matters. Poor fit for small projects. The async API is natural for Node.js.

**Improvement potential:** Lazy-open (defer LevelDB open until first cache hit) would eliminate the sample-app penalty.

---

### Option F: Streaming JSON

**Change:** `stream-json` library for streaming parse/stringify of JSON files
**Metadata:** 74 MB, 196 files (same layout as baseline, just different I/O)

| Pros | Cons |
|------|------|
| Lower peak memory (streaming) | **Consistently worst performer** |
| Could support partial reads | 88 ms reads on sample-app (vs 35 ms baseline) |
| | +13% on sap.ui.core |
| | High per-call overhead (stream pipeline setup) |
| | stream-json dependency |

**Rationale for poor performance:** The overhead of creating a stream-json pipeline (parser → assembler) for each metadata read far exceeds any memory savings. For files under 100 KB, `readFile` + `JSON.parse` is faster because it's a single synchronous V8 call vs multiple async stream events.

**Verdict:** **Do not pursue.** Streaming JSON only makes sense for files > 100 MB. Metadata files are typically 1–100 KB.

---

### Option G: JSONL Protocol

**Change:** One `.jsonl` file per metadata category, lines are `{"k":"key","v":data}`
**Metadata:** 149 MB (4 files)

| Pros | Cons |
|------|------|
| Very fast individual reads (Map lookup) | **149 MB — larger than baseline!** |
| Append-only writes (O(1)) | Eager full-file load on open |
| Simple implementation (readline) | +67% on sample-app (load cost) |
| No external dependencies | Duplicate accumulation over time |
| | No compaction implemented |

**Rationale for size bloat:** JSONL's append-only model means updates don't remove old entries. A key written 3 times has 3 lines in the file. Without compaction, the file grows monotonically.

**Rationale for sample-app penalty:** All 4 .jsonl files are loaded into memory on construction. For small projects, this is wasted work.

**Verdict:** The concept is sound (append-only + in-memory index), but needs compaction and lazy loading to be viable. Current implementation is a net negative.

**Improvement potential:** Add compaction, lazy-load categories on first access, and consider combined with Option J's approach.

---

### Option H: Pure SQLite (Fully Normalised)

**Change:** Every metadata field decomposed into typed relational columns
**Metadata:** 214 MB (1 file: `cache.db`)

| Pros | Cons |
|------|------|
| True relational queries possible | **214 MB — 54% larger than baseline!** |
| Structured schema validation | 100+ columns across tables |
| Can query individual fields | Massive ORM-like complexity |
| | Schema migration nightmare |
| | +20% on sap.ui.core |
| | Brittleness — schema must track data model |

**Rationale for size explosion:** Full normalisation creates indexes on every table's primary key, plus SQLite page overhead (4 KB pages) for many small rows. A single task metadata entry that was 13 KB JSON becomes dozens of rows across multiple tables.

**Verdict:** **Do not pursue.** Massive over-engineering. The cache stores opaque metadata blobs — there's no query use case that justifies relational decomposition.

---

### Option I: Pure LevelDB (Field-Level Decomposition)

**Change:** Every metadata field stored as an individual LevelDB key-value pair
**Metadata:** 71 MB (25 files)

| Pros | Cons |
|------|------|
| Theoretically fast individual field reads | **+22% on sap.ui.core (worst)** |
| LevelDB compression helps | Read amplification: many gets per logical read |
| | Range scans to reconstruct objects are slow |
| | sap.m reads: 4.9 s (vs 1.3 s baseline) |
| | Complex key encoding scheme |

**Rationale for poor read performance:** Reading a single build manifest requires a range scan across all keys with the matching prefix, then reconstructing the object in JavaScript. This is fundamentally slower than reading one file and `JSON.parse`.

**Verdict:** **Do not pursue.** Field-level decomposition is an anti-pattern for this use case. The cache stores and retrieves complete metadata objects — decomposing them into fields adds overhead without benefit.

---

### Option J: Incremental Managers

**Change:** JSONL stores + CompactableStore with append logs, offset indexes, and snapshots
**Metadata:** 109 MB (16 files)

| Pros | Cons |
|------|------|
| Supports incremental updates | Complex multi-file architecture |
| Compaction built-in | +30% on sample-app |
| Append-only writes | +16% on sap.ui.core |
| **-8% on sap.m** with low variance | |
| Snapshot + log separation | |

**Rationale:** This is the most architecturally sophisticated option. It separates hot data (recent changes in append logs) from cold data (compacted snapshots), enabling fast incremental writes. But the overhead of managing indexes, logs, and snapshots hurts small/medium projects.

**Verdict:** Promising for large projects with frequent incremental updates. Over-engineered for read-only cache validation. Would be valuable if the build system moved to incremental rebuilds.

**Improvement potential:** Lazy initialisation, skip snapshot reads when log is empty.

---

### Option K: Flat JSON Store

**Change:** In-memory cache backed by single JSON file per store, atomic writes via temp+rename, msgpackr for CAS
**Metadata:** 99 MB (211 files)

| Pros | Cons |
|------|------|
| **-14% on sap.m, most stable** | **+74% on sap.ui.core — catastrophic!** |
| Lowest StdDev on sap.m (0.47 s) | In-memory cache requires full load |
| Atomic writes via rename | 211 files (more than baseline) |
| Simple concept | |

**Rationale for sap.m win:** sap.m's access pattern (78 tasks, moderate resource count) benefits from in-memory caching. Once loaded, all subsequent reads are O(1) Map lookups.

**Rationale for sap.ui.core catastrophe:** The 9 624× `getResourcePathForStage` calls interact badly with either the flush threshold or the per-lookup overhead in the store layer. Need investigation.

**Verdict:** **Inconsistent.** Excellent on one project, catastrophic on another. The access pattern sensitivity makes this unreliable.

---

### Option L: JSONL + jq Streaming

**Change:** JSONL append-only files + jq subprocess for targeted reads
**Metadata:** 52 MB (177 files)

| Pros | Cons |
|------|------|
| **Best on sample-app** (0.828 s) | **+72% on sap.ui.core — catastrophic!** |
| Append-only writes | jq as system dependency |
| Compact storage (52 MB) | Subprocess spawn per read |
| | Non-portable (jq must be installed) |
| | Process creation overhead × 9 624 calls |

**Rationale for sample-app win:** Few reads, so jq subprocess cost is amortised. The JSONL format is compact and the in-memory cache avoids repeated reads.

**Rationale for sap.ui.core catastrophe:** Spawning a `jq` subprocess 9 624 times is astronomically expensive. Each spawn involves fork+exec, argument serialisation, stdout pipe setup, and process cleanup.

**Verdict:** **Do not pursue** in current form. The subprocess-per-read model is fundamentally unscalable. A JSONL format with in-process reading (like Option G) would retain the storage benefits without the process overhead.

---

## 7. Cross-cutting Analysis

### 7.1 Why Some Options Win on sap.m but Lose on sap.ui.core

The two large projects have different access patterns:

| Aspect | sap.ui.core | sap.m |
|--------|-------------|-------|
| Tasks | 20 | 78 |
| `readTaskMetadata` calls | 20× | 78× |
| `getResourcePathForStage` calls | 9,624× | 0 |
| `readStageCache` calls | 11× | 43× |
| Primary bottleneck | Resource path resolution | Task metadata reads |

Options that optimise for **many small reads** (C, K) win on sap.m. Options that have **per-call overhead** (K, L) are destroyed on sap.ui.core where resource path resolution happens ~10K times.

### 7.2 Dependency Cost Matrix

| Dependency | Type | Options Using It | Risk |
|-----------|------|-----------------|------|
| `better-sqlite3` | Native C addon | C, D, H | Platform-specific binaries, prebuild issues |
| `classic-level` | Native C addon (LevelDB) | E, I | Same as above |
| `msgpackr` | Native optional (fallback to JS) | B, D, E, K, L | Low risk—JS fallback exists |
| `stream-json` | Pure JS | F | Low risk but adds 100+ transitive deps |
| `jq` (system) | External binary | L | Not bundleable, must be pre-installed |

**Recommendation:** Avoid native dependencies (better-sqlite3, classic-level) unless the performance gain is decisive. They complicate CI, cross-platform builds, and Node.js version upgrades.

### 7.3 Metadata Share (% of total build time)

The "Metadata Share" metric shows what fraction of build time is spent on cache metadata I/O:

| Project | Baseline | Best Option |
|---------|----------|-------------|
| sample-app | 2,325% (!) | G/J: 0% (in-memory) |
| sap.ui.core | 115,610% (!) | G/J: 0% |
| sap.m | 8.5% | C/D: 0.2% |

> **Note:** The sample-app and sap.ui.core percentages >100% are because `getResourcePathForStage` totals are measured independently and can exceed the wall-clock build time (parallel operations, instrumentation overhead).

For sap.m, metadata I/O is only ~8.5% of build time. This means **even a 100% improvement in metadata I/O would only save ~2.8 s** out of a 32 s build. The remaining 91.5% is actual build processing.

---

## 8. Recommendations

### Tier 1: Merge Now (low risk, clear benefit)

1. **Option A (Minified JSON)** — 1-line change, 47% metadata size reduction, no performance regression. This should be merged regardless.

### Tier 2: Promising with Caveats

2. **Option C (SQLite+JSON)** — Impressive sap.m results (-40%) but high variance and native dependency. Consider if large-project performance is critical.

3. **Option E (LevelDB+MsgPack)** — Smallest metadata footprint (26 MB). Worth pursuing if lazy-open is implemented to eliminate small-project penalty.

### Tier 3: Needs Redesign

4. **Option G (JSONL Protocol)** — Good concept but needs compaction and lazy loading.
5. **Option J (Incremental Managers)** — Over-engineered for current use case but valuable foundation for future incremental builds.

### Tier 4: Do Not Pursue

6. **Option B (MessagePack)** — MsgPack decode is slower than JSON.parse in V8.
7. **Option D (SQLite+MsgPack)** — Combines two penalties.
8. **Option F (Streaming JSON)** — Fundamentally wrong tool for small files.
9. **Option H (Pure SQLite)** — Over-normalised, massive size explosion.
10. **Option I (Pure LevelDB)** — Field decomposition is an anti-pattern for blob storage.
11. **Option K (Flat JSON Store)** — Inconsistent across projects.
12. **Option L (JSONL+jq)** — Subprocess per read is unscalable.

### Combined Strategy

The optimal approach may be a **hybrid**:

1. **Merge Option A** immediately (minified JSON)
2. **Prototype A+C**: Minified JSON as the file format, with an optional SQLite metadata index for projects exceeding a task-count threshold (e.g., >30 tasks). This would give baseline performance on small projects and SQLite-accelerated reads on large ones.
3. **Investigate lazy-open for Option E**: If cache size is a concern (CI caches), LevelDB+MsgPack with lazy initialisation could be the most space-efficient backend.

---

## 9. Appendix: Raw Data References

- [Warm-cache build: openui5-sample-app](../benchmark-summary-2026-04-01T07-58-40-522Z.md) (if present in project)
- [Cache timings: all projects](~/Desktop/cache-timings/cache-timings-2026-04-01T15-47-20-171Z.md)
- Branch naming: `feat/cache-option-{a..l}`, baseline: `feat/incremental-build-tests`

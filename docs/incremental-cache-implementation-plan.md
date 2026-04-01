# Incremental Cache I/O Implementation Plan

**Status:** PoC  
**Created:** 2026-03-31  
**Goal:** Reduce cache I/O by writing only changed data instead of full read-modify-write cycles

---

## Problem Statement

All current cache options (A-I) follow the same pattern:
1. **Read entire file** into memory
2. **Modify in-memory objects** during build
3. **Write entire file** back to disk

This defeats streaming benefits — whether JSON, MessagePack, or SQLite, we're still doing full serialization/deserialization of large data structures.

### Benchmark Evidence (sap.m, 78 tasks)

| Option | readTaskMetadata | Pattern |
|--------|------------------|---------|
| Baseline | 810ms | Read 78 full JSON files |
| Option H (SQLite) | 123ms | Read 78 JSON blobs from DB |
| **Target** | ~10ms | Read only changed entries |

---

## Proposed Architecture

### Pattern: Append-Only Log + Index

```
cache/v0_4_incremental/
├── index_cache/
│   └── @ui5_cli/
│       ├── source-{buildSig}.snapshot.bin  # Base tree snapshot (cold start)
│       ├── source-{buildSig}.log.jsonl     # Append-only deltas
│       └── source-{buildSig}.index.bin     # Offset index for fast lookup
├── task_metadata/
│   └── @ui5_cli/{buildSig}/
│       ├── minify.project.log.jsonl        # Request graph deltas
│       └── minify.project.index.bin        # Key → offset mapping
└── stage_metadata/                          # Unchanged (immutable by signature)
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Log file** | Append-only sequence of operations (upsert, remove, delta) |
| **Index file** | Small file mapping keys → byte offsets in log |
| **Snapshot** | Full serialization created on cold start or compaction |
| **Compaction** | Merge log entries into fresh snapshot when log > threshold |

---

## Branch Strategy

| New Branch | Based On | Focus |
|------------|----------|-------|
| `feat/cache-option-j` | `feat/cache-option-g` | JSONL append-only |
| `feat/cache-option-k` | `feat/cache-option-b` | Streaming MsgPack |
| `feat/cache-option-l` | `feat/cache-option-h` | Native SQL incremental |

Keep existing branches (A-I) unchanged as baseline comparisons.

---

## Implementation Steps

### Phase 1: Core Infrastructure

#### Step 1: Create `AppendLog` utility class

**File:** `packages/project/lib/build/cache/io/AppendLog.js`

```javascript
/**
 * Append-only log file for incremental cache storage.
 * Supports JSONL, streaming MsgPack, or custom formats.
 */
export default class AppendLog {
  #filePath;
  #format; // 'jsonl' | 'msgpack'
  #fileHandle;

  constructor(filePath, format = 'jsonl') { }

  /** Append single entry to log, returns byte offset */
  async append(entry) { }

  /** Read specific entry by byte offset */
  async readAt(offset, length) { }

  /** Stream all entries (for compaction or full rebuild) */
  async *readAll() { }

  /** Get current file size */
  async getSize() { }

  /** Close file handle */
  async close() { }
}
```

**Depends on:** Nothing  
**Estimate:** 2 hours

---

#### Step 2: Create `OffsetIndex` utility class

**File:** `packages/project/lib/build/cache/io/OffsetIndex.js`

```javascript
/**
 * Maps keys to byte offsets in a log file.
 * Small enough to rewrite fully on each update.
 */
export default class OffsetIndex {
  #indexPath;
  #map; // Map<string, {offset: number, length: number}>

  constructor(indexPath) { }

  /** Load index from disk */
  async load() { }

  /** Save index to disk (full rewrite, atomic) */
  async save() { }

  /** Set offset for key */
  set(key, offset, length) { }

  /** Get offset for key */
  get(key) { }

  /** Check if key exists */
  has(key) { }

  /** Get all keys */
  keys() { }
}
```

**Depends on:** Nothing (parallel with Step 1)  
**Estimate:** 1 hour

---

#### Step 3: Create `CompactableStore` class

**File:** `packages/project/lib/build/cache/io/CompactableStore.js`

```javascript
/**
 * Combines AppendLog + OffsetIndex for incremental key-value storage.
 * Supports compaction when log exceeds threshold.
 */
export default class CompactableStore {
  #log;
  #index;
  #snapshotPath;
  #compactionThreshold;

  constructor(basePath, options = {}) { }

  /** Initialize: load index, open log */
  async open() { }

  /** Put value for key (append to log, update index) */
  async put(key, value) { }

  /** Get value for key (use index to read from log) */
  async get(key) { }

  /** Check if compaction needed */
  needsCompaction() { }

  /** Compact log into fresh snapshot */
  async compact() { }

  /** Close all handles */
  async close() { }
}
```

**Depends on:** Steps 1 and 2  
**Estimate:** 2 hours

---

### Phase 2: Adapt HashTree for Incremental Storage

#### Step 4: Add dirty node tracking to HashTree

**File:** `packages/project/lib/build/cache/index/HashTree.js`

**Changes:**
1. Add `#dirtyPaths` Set to track modified nodes
2. Mark paths dirty in `upsertResources()` and `removeResources()`
3. Add `getDirtyNodes()` method to return only changed nodes
4. Add `clearDirtyTracking()` after flush
5. Add `applyNodeUpdates(updates)` to apply incremental changes

```javascript
// New methods to add:

/** Get all nodes that were modified since last clear */
getDirtyNodes() {
  const nodes = [];
  for (const path of this.#dirtyPaths) {
    const node = this.getNode(path);
    if (node) {
      nodes.push({ path, node: node.toJSON() });
    }
  }
  return nodes;
}

/** Apply incremental node updates from log */
applyNodeUpdates(updates) {
  for (const { path, node, operation } of updates) {
    if (operation === 'remove') {
      this.#removeNodeAtPath(path);
    } else {
      this.#setNodeAtPath(path, TreeNode.fromJSON(node));
    }
  }
  this.#recomputeHashes();
}

/** Clear dirty tracking after flush */
clearDirtyTracking() {
  this.#dirtyPaths.clear();
}
```

**Depends on:** Step 3  
**Estimate:** 3 hours

---

#### Step 5: Update ResourceIndex to use CompactableStore

**File:** `packages/project/lib/build/cache/index/ResourceIndex.js`

**Changes:**
1. Add optional `CompactableStore` injection
2. Add `flushIncrementalChanges()` method
3. Modify `fromCache()` to handle incremental loading
4. Keep existing `toCacheObject()` for backward compatibility

```javascript
// New method:
async flushIncrementalChanges(store) {
  const dirtyNodes = this.#tree.getDirtyNodes();
  if (dirtyNodes.length === 0) return;

  for (const { path, node } of dirtyNodes) {
    await store.put(`node:${path}`, { path, node, timestamp: Date.now() });
  }
  this.#tree.clearDirtyTracking();
}

// Modified fromCache to support incremental:
static async fromCacheIncremental(store) {
  // 1. Load base snapshot if exists
  // 2. Apply all log entries on top
  // 3. Return reconstructed ResourceIndex
}
```

**Depends on:** Step 4  
**Estimate:** 3 hours

---

### Phase 3: Adapt ResourceRequestManager for Append-Only

#### Step 6: Convert ResourceRequestManager to append-only model

**File:** `packages/project/lib/build/cache/ResourceRequestManager.js`

**Changes:**
1. Instead of `toCacheObject()` serializing entire graph, add `getNewEntries()`
2. Store only new request sets as they're created
3. Add `fromIncrementalCache(store)` to reconstruct from log entries

```javascript
// Existing delta tracking can be reused:
// #addDeltaEntry() already tracks incremental changes

/** Get only new entries since last flush */
getNewEntries() {
  // Return new request nodes and edges only
  return this.#pendingEntries;
}

/** Flush new entries to store */
async flushTo(store) {
  for (const entry of this.getNewEntries()) {
    await store.put(`request:${entry.nodeId}`, entry);
  }
  this.#pendingEntries = [];
}
```

**Depends on:** Step 3  
**Estimate:** 2 hours

---

#### Step 7: Update BuildTaskCache to coordinate incremental writes

**File:** `packages/project/lib/build/cache/BuildTaskCache.js`

**Changes:**
1. Modify `toCacheObjects()` to return only new entries
2. Add `flushIncrementalTo(store)` method
3. Track what's been flushed vs pending

**Depends on:** Step 6  
**Estimate:** 1 hour

---

### Phase 4: Integrate with CacheManager

#### Step 8: Add incremental methods to CacheManager

**File:** `packages/project/lib/build/cache/CacheManager.js`

**New methods:**
```javascript
/** Get or create CompactableStore for index cache */
async getIndexStore(projectId, buildSignature, kind) { }

/** Get or create CompactableStore for task metadata */
async getTaskStore(projectId, buildSignature, taskName, type) { }

/** Append delta to index log */
async appendIndexDelta(projectId, buildSignature, kind, delta) { }

/** Append delta to task metadata log */
async appendTaskDelta(projectId, buildSignature, taskName, type, delta) { }

/** Read index with incremental reconstruction */
async readIndexCacheIncremental(projectId, buildSignature, kind) { }

/** Read task metadata with incremental reconstruction */
async readTaskMetadataIncremental(projectId, buildSignature, taskName, type) { }
```

**Depends on:** Steps 5 and 7  
**Estimate:** 3 hours

---

#### Step 9: Update ProjectBuildCache write flow

**File:** `packages/project/lib/build/cache/ProjectBuildCache.js`

**Changes:**
1. Replace batch `#writeSourceIndex()` with incremental `#flushSourceIndexDeltas()`
2. Replace batch `#writeTaskRequestCache()` with incremental `#flushTaskDeltas()`
3. Add periodic flush during build (not just at end)
4. Keep existing methods for backward compatibility

```javascript
// New incremental flush method:
async #flushPendingWrites() {
  // Flush dirty index nodes
  if (this.#sourceIndex.hasDirtyNodes()) {
    await this.#sourceIndex.flushIncrementalChanges(
      await this.#cacheManager.getIndexStore(
        this.#project.getId(), this.#buildSignature, "source"
      )
    );
  }

  // Flush pending task metadata
  for (const [taskName, taskCache] of this.#taskCache) {
    if (taskCache.hasPendingEntries()) {
      await taskCache.flushIncrementalTo(
        await this.#cacheManager.getTaskStore(
          this.#project.getId(), this.#buildSignature, taskName, "project"
        )
      );
    }
  }
}
```

**Depends on:** Step 8  
**Estimate:** 3 hours

---

### Phase 5: Format-Specific Backends

#### Step 10: Implement JSONL backend for AppendLog

**File:** `packages/project/lib/build/cache/io/JsonlAppendLog.js`

```javascript
export default class JsonlAppendLog extends AppendLog {
  async append(entry) {
    const line = JSON.stringify(entry) + '\n';
    const offset = await this.getSize();
    await fs.appendFile(this.#filePath, line);
    return { offset, length: Buffer.byteLength(line) };
  }

  async readAt(offset, length) {
    const fd = await fs.open(this.#filePath, 'r');
    const buffer = Buffer.alloc(length);
    await fd.read(buffer, 0, length, offset);
    await fd.close();
    return JSON.parse(buffer.toString().trim());
  }

  async *readAll() {
    const rl = readline.createInterface({
      input: fs.createReadStream(this.#filePath),
      crlfDelay: Infinity
    });
    for await (const line of rl) {
      if (line.trim()) yield JSON.parse(line);
    }
  }
}
```

**Branch:** `feat/cache-incremental-jsonl`  
**Depends on:** Step 1 interface  
**Estimate:** 2 hours

---

#### Step 11: Implement streaming MessagePack backend

**File:** `packages/project/lib/build/cache/io/MsgpackAppendLog.js`

```javascript
import { pack, unpack, Packr } from 'msgpackr';

export default class MsgpackAppendLog extends AppendLog {
  #packr = new Packr({ useRecords: true }); // Enable record structure reuse

  async append(entry) {
    const offset = await this.getSize();
    const buffer = this.#packr.pack(entry);
    // Write length prefix + data for framing
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32BE(buffer.length);
    await fs.appendFile(this.#filePath, Buffer.concat([lengthBuf, buffer]));
    return { offset, length: 4 + buffer.length };
  }

  async readAt(offset, length) {
    const fd = await fs.open(this.#filePath, 'r');
    const buffer = Buffer.alloc(length - 4);
    await fd.read(buffer, 0, length - 4, offset + 4);
    await fd.close();
    return unpack(buffer);
  }

  async *readAll() {
    const fd = await fs.open(this.#filePath, 'r');
    let position = 0;
    const stat = await fd.stat();
    while (position < stat.size) {
      const lengthBuf = Buffer.alloc(4);
      await fd.read(lengthBuf, 0, 4, position);
      const length = lengthBuf.readUInt32BE();
      const dataBuf = Buffer.alloc(length);
      await fd.read(dataBuf, 0, length, position + 4);
      yield unpack(dataBuf);
      position += 4 + length;
    }
    await fd.close();
  }
}
```

**Branch:** `feat/cache-incremental-msgpack`  
**Parallel with:** Step 10  
**Estimate:** 2 hours

---

#### Step 12: Implement SQLite incremental backend

**File:** `packages/project/lib/build/cache/io/SqliteIncrementalStore.js`

SQLite is already incremental by nature — INSERT/UPDATE operates on individual rows.

```javascript
export default class SqliteIncrementalStore {
  #db;
  #tableName;

  constructor(dbPath, tableName) { }

  async put(key, value) {
    // Single row upsert
    this.#db.prepare(`
      INSERT OR REPLACE INTO ${this.#tableName} (key, value) VALUES (?, ?)
    `).run(key, JSON.stringify(value));
  }

  async get(key) {
    const row = this.#db.prepare(`
      SELECT value FROM ${this.#tableName} WHERE key = ?
    `).get(key);
    return row ? JSON.parse(row.value) : null;
  }

  // No compaction needed — SQLite handles this internally
  async compact() { }
}
```

**Branch:** `feat/cache-incremental-sqlite`  
**Parallel with:** Steps 10 and 11  
**Estimate:** 1 hour

---

## Summary

| Phase | Steps | Estimate |
|-------|-------|----------|
| Phase 1: Core Infrastructure | 1-3 | 5 hours |
| Phase 2: HashTree Adaptation | 4-5 | 6 hours |
| Phase 3: ResourceRequestManager | 6-7 | 3 hours |
| Phase 4: CacheManager Integration | 8-9 | 6 hours |
| Phase 5: Format Backends | 10-12 | 5 hours |
| **Total** | | **~25 hours** |

---

## Success Criteria

1. **Incremental build writes <1KB** when modifying single source file
2. **Read time for sap.m reduced by 5x** (from 1.1s to <200ms)
3. **Cold start penalty <10%** compared to baseline
4. **Compaction works** — log doesn't grow unbounded

---

## Git Commands to Create Branches

```bash
# JSONL incremental (based on Option G)
git checkout feat/cache-option-g
git checkout -b feat/cache-incremental-jsonl

# MsgPack incremental (based on Option B)
git checkout feat/cache-option-b
git checkout -b feat/cache-incremental-msgpack

# SQLite incremental (based on Option H)
git checkout feat/cache-option-h
git checkout -b feat/cache-incremental-sqlite
```

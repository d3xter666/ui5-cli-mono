import fs from "graceful-fs";
import {promisify} from "node:util";
import path from "node:path";
import AppendLog from "./AppendLog.js";
import OffsetIndex from "./OffsetIndex.js";

const mkdir = promisify(fs.mkdir);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const rename = promisify(fs.rename);

/**
 * Combines AppendLog + OffsetIndex for incremental key-value storage.
 *
 * Supports:
 * - Incremental puts (append to log, update index)
 * - Fast gets (use index to read specific entry)
 * - Compaction (merge log into fresh snapshot when threshold exceeded)
 *
 * File structure:
 * - {basePath}.log.jsonl - Append-only log
 * - {basePath}.index.json - Key-to-offset mapping
 * - {basePath}.snapshot.json - Compacted snapshot (optional)
 *
 * @class
 */
export default class CompactableStore {
	#basePath;
	#log;
	#index;
	#snapshotPath;
	#compactionThreshold;
	#initialized;

	/**
	 * Create a CompactableStore instance.
	 *
	 * @param {string} basePath Base path for store files (without extension)
	 * @param {object} [options]
	 * @param {number} [options.compactionThreshold=1048576] Compact when log exceeds this size (bytes)
	 */
	constructor(basePath, options = {}) {
		this.#basePath = basePath;
		this.#log = new AppendLog(basePath + ".log.jsonl");
		this.#index = new OffsetIndex(basePath + ".index.json");
		this.#snapshotPath = basePath + ".snapshot.json";
		this.#compactionThreshold = options.compactionThreshold ?? 1048576; // 1MB default
		this.#initialized = false;
	}

	/**
	 * Initialize the store - load index and prepare log.
	 *
	 * @returns {Promise<void>}
	 */
	async open() {
		if (this.#initialized) {
			return;
		}

		// Ensure directory exists
		await mkdir(path.dirname(this.#basePath), {recursive: true});

		// Load existing index
		await this.#index.load();
		await this.#log.init();

		this.#initialized = true;
	}

	/**
	 * Put a value for a key.
	 *
	 * Appends to log and updates index. Does NOT rewrite existing entries.
	 *
	 * @param {string} key The key
	 * @param {object} value The value to store
	 * @returns {Promise<void>}
	 */
	async put(key, value) {
		await this.#ensureInitialized();

		// Create log entry with key embedded
		const entry = {key, value, timestamp: Date.now()};

		// Append to log
		const {offset, length} = await this.#log.append(entry);

		// Update index
		this.#index.set(key, offset, length);
	}

	/**
	 * Get a value by key.
	 *
	 * Uses index to read specific entry from log.
	 *
	 * @param {string} key The key
	 * @returns {Promise<object|null>} The value or null if not found
	 */
	async get(key) {
		await this.#ensureInitialized();

		const info = this.#index.get(key);
		if (!info) {
			// Key not in index - check snapshot
			return this.#getFromSnapshot(key);
		}

		const entry = await this.#log.readAt(info.offset, info.length);
		return entry.value;
	}

	/**
	 * Check if key exists.
	 *
	 * @param {string} key The key
	 * @returns {Promise<boolean>}
	 */
	async has(key) {
		await this.#ensureInitialized();

		if (this.#index.has(key)) {
			return true;
		}

		// Check snapshot
		const snapshotValue = await this.#getFromSnapshot(key);
		return snapshotValue !== null;
	}

	/**
	 * Delete a key.
	 *
	 * Marks key as deleted in log (tombstone pattern).
	 *
	 * @param {string} key The key
	 * @returns {Promise<void>}
	 */
	async delete(key) {
		await this.#ensureInitialized();

		// Append tombstone entry
		const entry = {key, deleted: true, timestamp: Date.now()};
		const {offset, length} = await this.#log.append(entry);

		// Update index to point to tombstone
		this.#index.set(key, offset, length);
	}

	/**
	 * Get all keys.
	 *
	 * @returns {Promise<string[]>}
	 */
	async keys() {
		await this.#ensureInitialized();

		const allKeys = new Set();

		// Keys from snapshot
		const snapshot = await this.#loadSnapshot();
		if (snapshot) {
			for (const key of Object.keys(snapshot)) {
				allKeys.add(key);
			}
		}

		// Keys from index (may include deletions)
		for (const key of this.#index.keys()) {
			allKeys.add(key);
		}

		// Filter out deleted keys
		const result = [];
		for (const key of allKeys) {
			const info = this.#index.get(key);
			if (info) {
				const entry = await this.#log.readAt(info.offset, info.length);
				if (!entry.deleted) {
					result.push(key);
				}
			} else {
				result.push(key);
			}
		}

		return result;
	}

	/**
	 * Check if compaction is needed.
	 *
	 * @returns {Promise<boolean>}
	 */
	async needsCompaction() {
		await this.#ensureInitialized();
		const logSize = await this.#log.getSize();
		return logSize > this.#compactionThreshold;
	}

	/**
	 * Compact log into fresh snapshot.
	 *
	 * Merges snapshot + log entries into new snapshot, then truncates log.
	 *
	 * @returns {Promise<void>}
	 */
	async compact() {
		await this.#ensureInitialized();

		// Start with existing snapshot
		const snapshot = await this.#loadSnapshot() || {};

		// Apply all log entries
		for await (const entry of this.#log.readAll()) {
			if (entry.deleted) {
				delete snapshot[entry.key];
			} else {
				snapshot[entry.key] = entry.value;
			}
		}

		// Write new snapshot atomically
		const tempPath = this.#snapshotPath + ".tmp";
		await writeFile(tempPath, JSON.stringify(snapshot), "utf8");
		await rename(tempPath, this.#snapshotPath);

		// Truncate log
		await this.#log.truncate();

		// Clear index (all data now in snapshot)
		this.#index.clear();
		await this.#index.save();
	}

	/**
	 * Flush pending index changes to disk.
	 *
	 * @returns {Promise<void>}
	 */
	async flush() {
		await this.#ensureInitialized();

		if (this.#index.isDirty()) {
			await this.#index.save();
		}

		// Auto-compact if needed
		if (await this.needsCompaction()) {
			await this.compact();
		}
	}

	/**
	 * Close the store.
	 *
	 * @returns {Promise<void>}
	 */
	async close() {
		await this.flush();
		this.#initialized = false;
	}

	/**
	 * Get all entries (for iteration or export).
	 *
	 * @yields {{key: string, value: object}}
	 */
	async* entries() {
		await this.#ensureInitialized();

		// Track what we've seen from log
		const seenKeys = new Set();

		// First yield entries from log (most recent versions)
		for await (const entry of this.#log.readAll()) {
			seenKeys.add(entry.key);
			if (!entry.deleted) {
				yield {key: entry.key, value: entry.value};
			}
		}

		// Then yield snapshot entries not in log
		const snapshot = await this.#loadSnapshot();
		if (snapshot) {
			for (const [key, value] of Object.entries(snapshot)) {
				if (!seenKeys.has(key)) {
					yield {key, value};
				}
			}
		}
	}

	/**
	 * Get number of entries.
	 *
	 * @returns {Promise<number>}
	 */
	async size() {
		const allKeys = await this.keys();
		return allKeys.length;
	}

	/**
	 * Load snapshot from disk.
	 *
	 * @returns {Promise<object|null>}
	 */
	async #loadSnapshot() {
		try {
			const data = await readFile(this.#snapshotPath, "utf8");
			return JSON.parse(data);
		} catch (err) {
			if (err.code === "ENOENT") {
				return null;
			}
			throw err;
		}
	}

	/**
	 * Get value from snapshot.
	 *
	 * @param {string} key The key
	 * @returns {Promise<object|null>}
	 */
	async #getFromSnapshot(key) {
		const snapshot = await this.#loadSnapshot();
		if (snapshot && key in snapshot) {
			return snapshot[key];
		}
		return null;
	}

	/**
	 * Ensure store is initialized.
	 *
	 * @returns {Promise<void>}
	 */
	async #ensureInitialized() {
		if (!this.#initialized) {
			await this.open();
		}
	}

	/**
	 * Get base path.
	 *
	 * @returns {string}
	 */
	getBasePath() {
		return this.#basePath;
	}
}

import fs from "graceful-fs";
import {promisify} from "node:util";
import path from "node:path";

const mkdir = promisify(fs.mkdir);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const rename = promisify(fs.rename);

/**
 * Flat JSON key-value store for incremental cache storage.
 *
 * Supports:
 * - Flat key-value storage (keys are NOT interpreted as nested paths)
 * - Incremental updates via in-memory cache + periodic flush
 * - Atomic writes with temp file + rename
 *
 * File structure:
 * - {basePath}.json - Main JSON file with flat key-value structure
 * - {basePath}.json.tmp - Temp file during atomic writes
 *
 * @class
 */
export default class StreamingJsonStore {
	#basePath;
	#filePath;
	#cache; // In-memory cache of modified entries
	#fileData; // Loaded file data (lazy-loaded on first read)
	#initialized;
	#dirty;

	// Threshold for how many dirty entries before auto-flush
	static FLUSH_THRESHOLD = 1000;

	/**
	 * Create a StreamingJsonStore instance.
	 *
	 * @param {string} basePath Base path for the store (without extension)
	 */
	constructor(basePath) {
		this.#basePath = basePath;
		this.#filePath = `${basePath}.json`;
		this.#cache = new Map();
		this.#fileData = null; // Lazy-loaded
		this.#initialized = false;
		this.#dirty = false;
	}

	/**
	 * Initialize the store - create directory if needed.
	 *
	 * @returns {Promise<void>}
	 */
	async open() {
		if (this.#initialized) return;

		const dir = path.dirname(this.#basePath);
		await mkdir(dir, {recursive: true});
		this.#initialized = true;
	}

	/**
	 * Put a value at a specific key path.
	 *
	 * Uses jq-like path notation: "foo.bar.baz" or "nodes.123"
	 * Values are cached in memory until flush.
	 *
	 * @param {string} key Key path (dot-separated)
	 * @param {*} value Value to store
	 * @returns {Promise<void>}
	 */
	async put(key, value) {
		await this.#ensureInitialized();
		this.#cache.set(key, {value, deleted: false});
		this.#dirty = true;

		// Auto-flush if cache is getting large
		if (this.#cache.size >= StreamingJsonStore.FLUSH_THRESHOLD) {
			await this.flush();
		}
	}

	/**
	 * Delete a key from the store.
	 *
	 * @param {string} key Key to delete
	 * @returns {Promise<void>}
	 */
	async delete(key) {
		await this.#ensureInitialized();
		this.#cache.set(key, {value: null, deleted: true});
		this.#dirty = true;
	}

	/**
	 * Get a value by key.
	 *
	 * First checks in-memory cache, then loads from file if not found.
	 *
	 * @param {string} key Key (treated as opaque string, not a path)
	 * @returns {Promise<*>} Value or undefined if not found
	 */
	async get(key) {
		await this.#ensureInitialized();

		// Check cache first
		if (this.#cache.has(key)) {
			const entry = this.#cache.get(key);
			return entry.deleted ? undefined : entry.value;
		}

		// Load from file data
		await this.#loadFileData();
		return this.#fileData ? this.#fileData[key] : undefined;
	}

	/**
	 * Check if a key exists.
	 *
	 * @param {string} key Key
	 * @returns {Promise<boolean>}
	 */
	async has(key) {
		const value = await this.get(key);
		return value !== undefined;
	}

	/**
	 * Get all keys in the store.
	 *
	 * @returns {Promise<string[]>}
	 */
	async keys() {
		await this.#ensureInitialized();
		await this.#loadFileData();

		const keys = new Set();

		// Add keys from file data
		if (this.#fileData) {
			for (const key of Object.keys(this.#fileData)) {
				keys.add(key);
			}
		}

		// Override with cache (add non-deleted, remove deleted)
		for (const [key, entry] of this.#cache) {
			if (entry.deleted) {
				keys.delete(key);
			} else {
				keys.add(key);
			}
		}

		return Array.from(keys);
	}

	/**
	 * Iterate over all entries.
	 *
	 * @yields {{key: string, value: *}}
	 */
	async* entries() {
		await this.#ensureInitialized();
		await this.#loadFileData();

		const seen = new Set();

		// First yield from cache (most recent values)
		for (const [key, entry] of this.#cache) {
			seen.add(key);
			if (!entry.deleted) {
				yield {key, value: entry.value};
			}
		}

		// Then yield from file data, skipping seen keys
		if (this.#fileData) {
			for (const [key, value] of Object.entries(this.#fileData)) {
				if (!seen.has(key)) {
					yield {key, value};
				}
			}
		}
	}

	/**
	 * Flush all cached changes to disk.
	 *
	 * Merges cached changes with existing file content and writes atomically.
	 *
	 * @returns {Promise<void>}
	 */
	async flush() {
		if (!this.#dirty) return;

		await this.#ensureInitialized();
		await this.#loadFileData();

		// Start with existing data or empty object
		const data = this.#fileData ? {...this.#fileData} : {};

		// Apply cached changes (flat keys, no path splitting)
		for (const [key, entry] of this.#cache) {
			if (entry.deleted) {
				delete data[key];
			} else {
				data[key] = entry.value;
			}
		}

		// Write atomically
		const tmpPath = `${this.#filePath}.tmp`;
		await writeFile(tmpPath, JSON.stringify(data), "utf8");
		await rename(tmpPath, this.#filePath);

		// Update cached file data and clear pending changes
		this.#fileData = data;
		this.#cache.clear();
		this.#dirty = false;
	}

	/**
	 * Close the store, flushing any pending changes.
	 *
	 * @returns {Promise<void>}
	 */
	async close() {
		if (this.#dirty) {
			await this.flush();
		}
		this.#fileData = null;
		this.#initialized = false;
	}

	/**
	 * Check if the store needs to be flushed.
	 *
	 * @returns {boolean}
	 */
	isDirty() {
		return this.#dirty;
	}

	/**
	 * Get the number of cached (unflushed) entries.
	 *
	 * @returns {number}
	 */
	getCacheSize() {
		return this.#cache.size;
	}

	// --- Private methods ---

	/**
	 * Load file data into memory if not already loaded.
	 *
	 * @returns {Promise<void>}
	 */
	async #loadFileData() {
		if (this.#fileData !== null) {
			return; // Already loaded
		}

		try {
			const content = await readFile(this.#filePath, "utf8");
			this.#fileData = JSON.parse(content);
		} catch (err) {
			if (err.code === "ENOENT") {
				this.#fileData = {}; // No file yet
			} else {
				throw err;
			}
		}
	}

	async #ensureInitialized() {
		if (!this.#initialized) {
			await this.open();
		}
	}
}

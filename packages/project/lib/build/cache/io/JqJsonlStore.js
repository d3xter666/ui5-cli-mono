import fs from "graceful-fs";
import {promisify} from "node:util";
import path from "node:path";
import {spawn} from "node:child_process";
import readline from "node:readline";

const mkdir = promisify(fs.mkdir);
const appendFile = promisify(fs.appendFile);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const rename = promisify(fs.rename);
const stat = promisify(fs.stat);
const open = promisify(fs.open);
const close = promisify(fs.close);

/**
 * JSONL store with jq streaming reads for incremental cache storage.
 *
 * **Architecture:**
 * - **File format:** JSONL (one JSON object per line)
 *   Each line: `{"k":"key","v":value,"t":timestamp}`
 *
 * - **Writes:** Append-only (O(1), no file reads needed)
 * - **Reads:** jq streaming or line-by-line scan for specific keys
 * - **In-memory cache:** Buffers recent writes for fast repeated access
 * - **Compaction:** Rewrites file removing superseded entries when threshold exceeded
 *
 * **Why JSONL + jq:**
 * - JSONL allows appending without reading/rewriting the whole file
 * - jq can stream through lines to find specific keys
 * - More memory-efficient than loading entire JSON into memory
 *
 * **File structure:**
 * - {basePath}.jsonl - Append-only log of key-value entries
 *
 * @class
 */
export default class JqJsonlStore {
	#basePath;
	#filePath;
	#cache; // In-memory cache of recent entries {key -> {value, deleted}}
	#keyIndex; // Maps keys to their last seen line number for fast lookup
	#lineCount; // Total lines in file
	#initialized;
	#dirty;
	#fd; // File descriptor for appending

	// Thresholds
	static CACHE_FLUSH_THRESHOLD = 500; // Flush cache to disk after this many entries
	static COMPACTION_THRESHOLD = 10000; // Compact when file exceeds this many lines

	/**
	 * Create a JqJsonlStore instance.
	 *
	 * @param {string} basePath Base path for the store (without extension)
	 */
	constructor(basePath) {
		this.#basePath = basePath;
		this.#filePath = `${basePath}.jsonl`;
		this.#cache = new Map();
		this.#keyIndex = new Map();
		this.#lineCount = 0;
		this.#initialized = false;
		this.#dirty = false;
		this.#fd = null;
	}

	/**
	 * Initialize the store - create directory and scan existing file for index.
	 *
	 * @returns {Promise<void>}
	 */
	async open() {
		if (this.#initialized) return;

		const dir = path.dirname(this.#basePath);
		await mkdir(dir, {recursive: true});

		// Build key index by scanning existing file
		await this.#buildIndex();

		this.#initialized = true;
	}

	/**
	 * Put a value for a key.
	 *
	 * Buffers in memory cache. Will be appended to file on flush.
	 *
	 * @param {string} key The key
	 * @param {*} value The value to store
	 * @returns {Promise<void>}
	 */
	async put(key, value) {
		await this.#ensureInitialized();

		this.#cache.set(key, {value, deleted: false, timestamp: Date.now()});
		this.#dirty = true;

		// Auto-flush if cache is getting large
		if (this.#cache.size >= JqJsonlStore.CACHE_FLUSH_THRESHOLD) {
			await this.flush();
		}
	}

	/**
	 * Delete a key.
	 *
	 * @param {string} key The key to delete
	 * @returns {Promise<void>}
	 */
	async delete(key) {
		await this.#ensureInitialized();
		this.#cache.set(key, {value: null, deleted: true, timestamp: Date.now()});
		this.#dirty = true;
	}

	/**
	 * Get a value by key.
	 *
	 * Check order:
	 * 1. In-memory cache (most recent)
	 * 2. JSONL file via streaming read
	 *
	 * @param {string} key The key
	 * @returns {Promise<*>} Value or undefined if not found
	 */
	async get(key) {
		await this.#ensureInitialized();

		// 1. Check cache first (most recent state)
		if (this.#cache.has(key)) {
			const entry = this.#cache.get(key);
			return entry.deleted ? undefined : entry.value;
		}

		// 2. Read from file using streaming approach
		return await this.#readFromFile(key);
	}

	/**
	 * Check if a key exists.
	 *
	 * @param {string} key The key
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

		const keys = new Set();

		// Add keys from index (file)
		for (const key of this.#keyIndex.keys()) {
			keys.add(key);
		}

		// Apply cache changes
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

		const seen = new Set();

		// First yield from cache (most recent values)
		for (const [key, entry] of this.#cache) {
			seen.add(key);
			if (!entry.deleted) {
				yield {key, value: entry.value};
			}
		}

		// Then read from file, skipping seen keys
		for await (const {key, value} of this.#streamAllFromFile()) {
			if (!seen.has(key)) {
				yield {key, value};
			}
		}
	}

	/**
	 * Flush cached entries to the JSONL file.
	 *
	 * Appends all cached entries as new lines (append-only, no rewrites).
	 *
	 * @returns {Promise<void>}
	 */
	async flush() {
		if (!this.#dirty || this.#cache.size === 0) return;

		await this.#ensureInitialized();

		// Build lines to append
		const lines = [];
		for (const [key, entry] of this.#cache) {
			const line = JSON.stringify({
				k: key,
				v: entry.deleted ? null : entry.value,
				d: entry.deleted ? 1 : 0,
				t: entry.timestamp,
			});
			lines.push(line);

			// Update index
			this.#keyIndex.set(key, {
				lineNumber: this.#lineCount + lines.length,
				deleted: entry.deleted,
			});
		}

		// Append to file
		const content = lines.join("\n") + "\n";
		await appendFile(this.#filePath, content, "utf8");
		this.#lineCount += lines.length;

		// Clear cache
		this.#cache.clear();
		this.#dirty = false;

		// Check if compaction needed
		if (this.#lineCount > JqJsonlStore.COMPACTION_THRESHOLD) {
			await this.#compact();
		}
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
		if (this.#fd) {
			await close(this.#fd);
			this.#fd = null;
		}
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

	/**
	 * Get total line count in the file.
	 *
	 * @returns {number}
	 */
	getLineCount() {
		return this.#lineCount;
	}

	// --- Private methods ---

	/**
	 * Build the key index by scanning the JSONL file.
	 *
	 * @returns {Promise<void>}
	 */
	async #buildIndex() {
		try {
			await stat(this.#filePath);
		} catch (err) {
			if (err.code === "ENOENT") {
				// File doesn't exist yet
				this.#lineCount = 0;
				return;
			}
			throw err;
		}

		// Stream through file line by line
		const fileStream = fs.createReadStream(this.#filePath, {encoding: "utf8"});
		const rl = readline.createInterface({
			input: fileStream,
			crlfDelay: Infinity,
		});

		let lineNumber = 0;
		for await (const line of rl) {
			lineNumber++;
			if (!line.trim()) continue;

			try {
				const entry = JSON.parse(line);
				this.#keyIndex.set(entry.k, {
					lineNumber,
					deleted: entry.d === 1,
				});
			} catch {
				// Skip malformed lines
			}
		}

		this.#lineCount = lineNumber;
	}

	/**
	 * Read a specific key from the JSONL file.
	 *
	 * Uses the index to determine if key exists  then streams to find it.
	 * For better performance with jq (if available), uses jq streaming.
	 *
	 * @param {string} key The key to find
	 * @returns {Promise<*>} Value or undefined
	 */
	async #readFromFile(key) {
		// Check index first
		const indexEntry = this.#keyIndex.get(key);
		if (!indexEntry || indexEntry.deleted) {
			return undefined;
		}

		// Try using jq for streaming read (more memory efficient)
		const jqResult = await this.#readWithJq(key);
		if (jqResult !== null) {
			return jqResult;
		}

		// Fallback to line-by-line scan
		return await this.#readWithLineScaN(key);
	}

	/**
	 * Read a key using jq streaming (if jq is available).
	 *
	 * @param {string} key The key to find
	 * @returns {Promise<*|null>} Value, undefined if not found, or null if jq unavailable
	 */
	async #readWithJq(key) {
		return new Promise((resolve) => {
			// Use jq to find the last occurrence of the key
			// jq -c 'select(.k == "key")' file.jsonl | tail -1
			const jq = spawn("jq", [
				"-c",
				`select(.k == ${JSON.stringify(key)} and .d != 1)`,
				this.#filePath,
			], {
				stdio: ["ignore", "pipe", "pipe"],
			});

			let output = "";
			let lastLine = "";

			jq.stdout.on("data", (data) => {
				output += data.toString();
				// Keep track of last complete line
				const lines = output.split("\n");
				for (let i = 0; i < lines.length - 1; i++) {
					if (lines[i].trim()) {
						lastLine = lines[i];
					}
				}
				output = lines[lines.length - 1];
			});

			jq.on("error", () => {
				// jq not available
				resolve(null);
			});

			jq.on("close", (code) => {
				if (code !== 0 && code !== null) {
					resolve(null); // jq failed, fallback to line scan
					return;
				}

				// Check remaining output
				if (output.trim()) {
					lastLine = output.trim();
				}

				if (!lastLine) {
					resolve(undefined); // Key not found
					return;
				}

				try {
					const entry = JSON.parse(lastLine);
					resolve(entry.v);
				} catch {
					resolve(null); // Parse error, fallback
				}
			});

			// Timeout after 5 seconds
			setTimeout(() => {
				jq.kill();
				resolve(null);
			}, 5000);
		});
	}

	/**
	 * Read a key by scanning all lines (fallback).
	 *
	 * @param {string} key The key to find
	 * @returns {Promise<*>} Value or undefined
	 */
	async #readWithLineScaN(key) {
		const fileStream = fs.createReadStream(this.#filePath, {encoding: "utf8"});
		const rl = readline.createInterface({
			input: fileStream,
			crlfDelay: Infinity,
		});

		let lastValue;
		let found = false;

		for await (const line of rl) {
			if (!line.trim()) continue;

			try {
				const entry = JSON.parse(line);
				if (entry.k === key) {
					if (entry.d === 1) {
						found = false;
						lastValue = undefined;
					} else {
						found = true;
						lastValue = entry.v;
					}
				}
			} catch {
				// Skip malformed lines
			}
		}

		return found ? lastValue : undefined;
	}

	/**
	 * Stream all entries from the file (for iteration).
	 *
	 * @yields {{key: string, value: *}}
	 */
	async* #streamAllFromFile() {
		try {
			await stat(this.#filePath);
		} catch (err) {
			if (err.code === "ENOENT") {
				return;
			}
			throw err;
		}

		// Collect the latest value for each key
		const latest = new Map();

		const fileStream = fs.createReadStream(this.#filePath, {encoding: "utf8"});
		const rl = readline.createInterface({
			input: fileStream,
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			if (!line.trim()) continue;

			try {
				const entry = JSON.parse(line);
				if (entry.d === 1) {
					latest.delete(entry.k);
				} else {
					latest.set(entry.k, entry.v);
				}
			} catch {
				// Skip malformed lines
			}
		}

		// Yield all non-deleted entries
		for (const [key, value] of latest) {
			yield {key, value};
		}
	}

	/**
	 * Compact the JSONL file by removing superseded entries.
	 *
	 * Rewrites the file keeping only the latest value for each key.
	 *
	 * @returns {Promise<void>}
	 */
	async #compact() {
		// Collect latest values
		const latest = new Map();

		const fileStream = fs.createReadStream(this.#filePath, {encoding: "utf8"});
		const rl = readline.createInterface({
			input: fileStream,
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			if (!line.trim()) continue;

			try {
				const entry = JSON.parse(line);
				if (entry.d === 1) {
					latest.delete(entry.k);
				} else {
					latest.set(entry.k, entry);
				}
			} catch {
				// Skip malformed lines
			}
		}

		// Write compacted file
		const tmpPath = `${this.#filePath}.tmp`;
		const lines = [];
		for (const [key, entry] of latest) {
			lines.push(JSON.stringify({
				k: key,
				v: entry.v,
				d: 0,
				t: entry.t || Date.now(),
			}));
		}

		await writeFile(tmpPath, lines.join("\n") + "\n", "utf8");
		await rename(tmpPath, this.#filePath);

		// Rebuild index
		this.#keyIndex.clear();
		this.#lineCount = 0;
		for (const [key] of latest) {
			this.#lineCount++;
			this.#keyIndex.set(key, {lineNumber: this.#lineCount, deleted: false});
		}
	}

	async #ensureInitialized() {
		if (!this.#initialized) {
			await this.open();
		}
	}
}

import path from "node:path";
import fs from "graceful-fs";
import {promisify} from "node:util";
import {createReadStream} from "node:fs";
import {createInterface} from "node:readline";

const mkdir = promisify(fs.mkdir);
const appendFile = promisify(fs.appendFile);
const writeFile = promisify(fs.writeFile);
const rename = promisify(fs.rename);

/**
 * JSONL-based metadata store for build cache.
 *
 * Consolidates metadata into one JSONL file per category instead of
 * many individual JSON files. Each line is a JSON object with key-value
 * structure: {"k":"<key>","v":<data>}
 *
 * Categories are lazy-loaded on first access — only the files actually
 * needed are parsed, avoiding unnecessary startup cost for small builds.
 *
 * On write, appends a line to the JSONL file and updates the in-memory Map.
 * Duplicate keys are avoided by comparing against existing values before
 * appending. On close, categories with a high duplicate ratio are compacted
 * by atomically rewriting the file.
 */
export default class JsonlStore {
	#dir;
	#maps = new Map();
	#files = new Map();
	#loaded = new Set();
	#loadPromises = new Map();
	#lineCount = new Map();
	#dirty = new Set();

	// Compact when the file has 2× more lines than unique keys
	static #COMPACTION_RATIO = 2.0;

	static #CATEGORIES = [
		"buildManifests",
		"indexCache",
		"stageMetadata",
		"taskMetadata",
		"resultMetadata",
	];

	/**
	 * Open the JSONL store at the given cache directory.
	 *
	 * Only resolves file paths — categories are lazy-loaded on first access.
	 *
	 * @param {string} cacheDir Absolute path to the versioned cache directory
	 * @returns {Promise<JsonlStore>}
	 */
	static async open(cacheDir) {
		const store = new JsonlStore();
		store.#dir = cacheDir;
		await mkdir(cacheDir, {recursive: true});

		for (const category of JsonlStore.#CATEGORIES) {
			const filePath = path.join(cacheDir, `${category}.jsonl`);
			store.#files.set(category, filePath);
			store.#maps.set(category, new Map());
			store.#lineCount.set(category, 0);
		}

		return store;
	}

	/**
	 * Ensure a category's JSONL file has been loaded into its Map.
	 * Concurrent calls for the same category share a single load promise.
	 *
	 * @param {string} category Category name
	 * @returns {Promise<void>}
	 */
	async #ensureLoaded(category) {
		if (this.#loaded.has(category)) {
			return;
		}
		if (this.#loadPromises.has(category)) {
			return this.#loadPromises.get(category);
		}
		const promise = this.#loadCategory(category);
		this.#loadPromises.set(category, promise);
		try {
			await promise;
		} finally {
			this.#loadPromises.delete(category);
		}
	}

	/**
	 * Load a single category's JSONL file into its Map.
	 *
	 * @param {string} category Category name
	 * @returns {Promise<void>}
	 */
	async #loadCategory(category) {
		const filePath = this.#files.get(category);
		const map = this.#maps.get(category);
		let lineCount = 0;
		try {
			const fileStream = createReadStream(filePath, {encoding: "utf8"});
			const rl = createInterface({input: fileStream, crlfDelay: Infinity});
			for await (const line of rl) {
				if (line.length === 0) {
					continue;
				}
				const entry = JSON.parse(line);
				map.set(entry.k, entry.v);
				lineCount++;
			}
		} catch (err) {
			if (err.code !== "ENOENT") {
				throw err;
			}
			// File doesn't exist yet — empty map is fine
		}
		this.#lineCount.set(category, lineCount);
		this.#loaded.add(category);
	}

	/**
	 * Get a value by category and key.
	 * Lazy-loads the category's file on first access.
	 *
	 * @param {string} category Metadata category name
	 * @param {string} key Lookup key
	 * @returns {Promise<object|null>} Stored value or null if not found
	 */
	async get(category, key) {
		await this.#ensureLoaded(category);
		const value = this.#maps.get(category).get(key);
		return value !== undefined ? value : null;
	}

	/**
	 * Store a value by category and key.
	 * Skips the append if the value is identical to the existing one.
	 * Otherwise appends to the JSONL file and updates the in-memory Map.
	 *
	 * @param {string} category Metadata category name
	 * @param {string} key Lookup key
	 * @param {object} data Value to store
	 * @returns {Promise<void>}
	 */
	async put(category, key, data) {
		await this.#ensureLoaded(category);
		const map = this.#maps.get(category);

		// Skip write if value is unchanged (compare serialised form)
		const existing = map.get(key);
		if (existing !== undefined) {
			const newJson = JSON.stringify(data);
			if (JSON.stringify(existing) === newJson) {
				return;
			}
		}

		map.set(key, data);
		const line = JSON.stringify({k: key, v: data}) + "\n";
		await appendFile(this.#files.get(category), line, "utf8");
		this.#lineCount.set(category, this.#lineCount.get(category) + 1);
		this.#dirty.add(category);
	}

	/**
	 * Close the store. Compacts categories that have grown beyond the
	 * duplicate threshold.
	 *
	 * @returns {Promise<void>}
	 */
	async close() {
		const compactions = [];
		for (const category of this.#dirty) {
			const lineCount = this.#lineCount.get(category);
			const keyCount = this.#maps.get(category).size;
			if (keyCount > 0 && lineCount / keyCount >= JsonlStore.#COMPACTION_RATIO) {
				compactions.push(this.#compact(category));
			}
		}
		await Promise.all(compactions);
	}

	/**
	 * Rewrite a category's JSONL file with only unique keys.
	 * Uses atomic write-to-temp + rename.
	 *
	 * @param {string} category Category name
	 * @returns {Promise<void>}
	 */
	async #compact(category) {
		const filePath = this.#files.get(category);
		const tmpPath = filePath + ".tmp";
		const map = this.#maps.get(category);

		const lines = [];
		for (const [key, value] of map) {
			lines.push(JSON.stringify({k: key, v: value}));
		}
		await writeFile(tmpPath, lines.join("\n") + "\n", "utf8");
		await rename(tmpPath, filePath);
		this.#lineCount.set(category, map.size);
	}
}

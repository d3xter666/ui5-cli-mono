import path from "node:path";
import fs from "graceful-fs";
import {promisify} from "node:util";
import {createReadStream} from "node:fs";
import {createInterface} from "node:readline";

const mkdir = promisify(fs.mkdir);
const appendFile = promisify(fs.appendFile);

/**
 * JSONL-based metadata store for build cache.
 *
 * Consolidates metadata into one JSONL file per category instead of
 * many individual JSON files. Each line is a JSON object with key-value
 * structure: {"k":"<key>","v":<data>}
 *
 * On open, loads all lines into in-memory Maps for O(1) lookups.
 * On write, appends a line to the JSONL file and updates the Map.
 * Duplicate keys are resolved by last-write-wins (later lines override earlier).
 */
export default class JsonlStore {
	#dir;
	#maps = new Map();
	#files = new Map();

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

			const map = new Map();
			store.#maps.set(category, map);

			// Load existing data
			try {
				await store.#loadFile(filePath, map);
			} catch (err) {
				if (err.code !== "ENOENT") {
					throw err;
				}
				// File doesn't exist yet — empty map is fine
			}
		}

		return store;
	}

	/**
	 * Load a JSONL file into a Map. Last-write-wins for duplicate keys.
	 */
	async #loadFile(filePath, map) {
		const fileStream = createReadStream(filePath, {encoding: "utf8"});
		const rl = createInterface({input: fileStream, crlfDelay: Infinity});
		for await (const line of rl) {
			if (line.length === 0) continue;
			const entry = JSON.parse(line);
			map.set(entry.k, entry.v);
		}
	}

	/**
	 * Get a value by category and key.
	 *
	 * @param {string} category Metadata category name
	 * @param {string} key Lookup key
	 * @returns {object|null} Stored value or null if not found
	 */
	get(category, key) {
		const map = this.#maps.get(category);
		const value = map.get(key);
		return value !== undefined ? value : null;
	}

	/**
	 * Store a value by category and key.
	 * Appends to the JSONL file and updates the in-memory Map.
	 *
	 * @param {string} category Metadata category name
	 * @param {string} key Lookup key
	 * @param {object} data Value to store
	 * @returns {Promise<void>}
	 */
	async put(category, key, data) {
		this.#maps.get(category).set(key, data);
		const line = JSON.stringify({k: key, v: data}) + "\n";
		await appendFile(this.#files.get(category), line, "utf8");
	}

	/**
	 * Close the store (no-op for JSONL, writes are flushed immediately).
	 */
	async close() {
		// All writes are append-based and flushed via appendFile
	}
}

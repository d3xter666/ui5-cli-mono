import fs from "graceful-fs";
import {promisify} from "node:util";
import path from "node:path";

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const rename = promisify(fs.rename);
const stat = promisify(fs.stat);
const mkdir = promisify(fs.mkdir);

/**
 * Maps keys to byte offsets in a log file.
 *
 * The index is small enough to rewrite fully on each update.
 * Uses atomic writes (write to temp, then rename) for crash safety.
 *
 * @class
 */
export default class OffsetIndex {
	#indexPath;
	#map;
	#dirty;

	/**
	 * Create an OffsetIndex instance.
	 *
	 * @param {string} indexPath Path to the index file
	 */
	constructor(indexPath) {
		this.#indexPath = indexPath;
		this.#map = new Map();
		this.#dirty = false;
	}

	/**
	 * Load index from disk.
	 *
	 * @returns {Promise<void>}
	 */
	async load() {
		try {
			const data = await readFile(this.#indexPath, "utf8");
			const entries = JSON.parse(data);
			this.#map = new Map(entries);
			this.#dirty = false;
		} catch (err) {
			if (err.code === "ENOENT") {
				// Index doesn't exist yet - start fresh
				this.#map = new Map();
				this.#dirty = false;
			} else {
				throw err;
			}
		}
	}

	/**
	 * Save index to disk atomically.
	 *
	 * @returns {Promise<void>}
	 */
	async save() {
		if (!this.#dirty) {
			return; // No changes to save
		}

		// Ensure directory exists
		await mkdir(path.dirname(this.#indexPath), {recursive: true});

		// Atomic write: write to temp file, then rename
		const tempPath = this.#indexPath + ".tmp";
		const entries = Array.from(this.#map.entries());
		await writeFile(tempPath, JSON.stringify(entries), "utf8");
		await rename(tempPath, this.#indexPath);

		this.#dirty = false;
	}

	/**
	 * Set offset info for a key.
	 *
	 * @param {string} key The key
	 * @param {number} offset Byte offset in log file
	 * @param {number} length Byte length of entry
	 */
	set(key, offset, length) {
		this.#map.set(key, {offset, length});
		this.#dirty = true;
	}

	/**
	 * Get offset info for a key.
	 *
	 * @param {string} key The key
	 * @returns {{offset: number, length: number}|undefined}
	 */
	get(key) {
		return this.#map.get(key);
	}

	/**
	 * Check if key exists.
	 *
	 * @param {string} key The key
	 * @returns {boolean}
	 */
	has(key) {
		return this.#map.has(key);
	}

	/**
	 * Delete a key.
	 *
	 * @param {string} key The key
	 * @returns {boolean} True if key existed
	 */
	delete(key) {
		const existed = this.#map.delete(key);
		if (existed) {
			this.#dirty = true;
		}
		return existed;
	}

	/**
	 * Get all keys.
	 *
	 * @returns {IterableIterator<string>}
	 */
	keys() {
		return this.#map.keys();
	}

	/**
	 * Get all entries.
	 *
	 * @returns {IterableIterator<[string, {offset: number, length: number}]>}
	 */
	entries() {
		return this.#map.entries();
	}

	/**
	 * Get number of entries.
	 *
	 * @returns {number}
	 */
	size() {
		return this.#map.size;
	}

	/**
	 * Clear all entries.
	 */
	clear() {
		this.#map.clear();
		this.#dirty = true;
	}

	/**
	 * Check if index has unsaved changes.
	 *
	 * @returns {boolean}
	 */
	isDirty() {
		return this.#dirty;
	}

	/**
	 * Check if index file exists.
	 *
	 * @returns {Promise<boolean>}
	 */
	async exists() {
		try {
			await stat(this.#indexPath);
			return true;
		} catch (err) {
			if (err.code === "ENOENT") {
				return false;
			}
			throw err;
		}
	}

	/**
	 * Get the file path.
	 *
	 * @returns {string}
	 */
	getPath() {
		return this.#indexPath;
	}
}

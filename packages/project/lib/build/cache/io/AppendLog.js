import fs from "graceful-fs";
import {promisify} from "node:util";
import readline from "node:readline";

const open = promisify(fs.open);
const close = promisify(fs.close);
const read = promisify(fs.read);
const stat = promisify(fs.stat);
const appendFile = promisify(fs.appendFile);

/**
 * Append-only log file for incremental cache storage.
 *
 * Each entry is stored as a single line of JSON (JSONL format).
 * Entries can be appended and read back by offset.
 *
 * @class
 */
export default class AppendLog {
	#filePath;
	#currentSize;

	/**
	 * Create an AppendLog instance.
	 *
	 * @param {string} filePath Path to the log file
	 */
	constructor(filePath) {
		this.#filePath = filePath;
		this.#currentSize = null;
	}

	/**
	 * Initialize the log - get current size or create empty file.
	 *
	 * @returns {Promise<void>}
	 */
	async init() {
		try {
			const stats = await stat(this.#filePath);
			this.#currentSize = stats.size;
		} catch (err) {
			if (err.code === "ENOENT") {
				// File doesn't exist - will be created on first append
				this.#currentSize = 0;
			} else {
				throw err;
			}
		}
	}

	/**
	 * Append a single entry to the log.
	 *
	 * @param {object} entry The entry to append (will be JSON serialized)
	 * @returns {Promise<{offset: number, length: number}>} Position info for later retrieval
	 */
	async append(entry) {
		const line = JSON.stringify(entry) + "\n";
		const lineBytes = Buffer.byteLength(line, "utf8");
		const offset = this.#currentSize;

		await appendFile(this.#filePath, line, "utf8");
		this.#currentSize += lineBytes;

		return {offset, length: lineBytes};
	}

	/**
	 * Read a specific entry by byte offset.
	 *
	 * @param {number} offset Byte offset where entry starts
	 * @param {number} length Byte length of entry (including newline)
	 * @returns {Promise<object>} Parsed entry
	 */
	async readAt(offset, length) {
		const fd = await open(this.#filePath, "r");
		try {
			const buffer = Buffer.alloc(length);
			await read(fd, buffer, 0, length, offset);
			const line = buffer.toString("utf8").trim();
			return JSON.parse(line);
		} finally {
			await close(fd);
		}
	}

	/**
	 * Stream all entries in the log.
	 *
	 * @yields {object} Each entry in the log
	 */
	async* readAll() {
		try {
			await stat(this.#filePath);
		} catch (err) {
			if (err.code === "ENOENT") {
				return; // Empty log
			}
			throw err;
		}

		const fileStream = fs.createReadStream(this.#filePath, {encoding: "utf8"});
		const rl = readline.createInterface({
			input: fileStream,
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			if (line.trim()) {
				yield JSON.parse(line);
			}
		}
	}

	/**
	 * Stream all entries with their offsets.
	 *
	 * @yields {{entry: object, offset: number, length: number}}
	 */
	async* readAllWithOffsets() {
		try {
			await stat(this.#filePath);
		} catch (err) {
			if (err.code === "ENOENT") {
				return;
			}
			throw err;
		}

		const fileStream = fs.createReadStream(this.#filePath, {encoding: "utf8"});
		const rl = readline.createInterface({
			input: fileStream,
			crlfDelay: Infinity,
		});

		let offset = 0;
		for await (const line of rl) {
			const length = Buffer.byteLength(line + "\n", "utf8");
			if (line.trim()) {
				yield {
					entry: JSON.parse(line),
					offset,
					length,
				};
			}
			offset += length;
		}
	}

	/**
	 * Get current file size.
	 *
	 * @returns {Promise<number>} Size in bytes
	 */
	async getSize() {
		if (this.#currentSize === null) {
			await this.init();
		}
		return this.#currentSize;
	}

	/**
	 * Get the file path.
	 *
	 * @returns {string}
	 */
	getPath() {
		return this.#filePath;
	}

	/**
	 * Check if log exists.
	 *
	 * @returns {Promise<boolean>}
	 */
	async exists() {
		try {
			await stat(this.#filePath);
			return true;
		} catch (err) {
			if (err.code === "ENOENT") {
				return false;
			}
			throw err;
		}
	}

	/**
	 * Truncate the log file (used after compaction).
	 *
	 * @returns {Promise<void>}
	 */
	async truncate() {
		const fd = await open(this.#filePath, "w");
		await close(fd);
		this.#currentSize = 0;
	}
}

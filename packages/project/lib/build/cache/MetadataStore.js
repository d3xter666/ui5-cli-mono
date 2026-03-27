import {ClassicLevel} from "classic-level";
import path from "node:path";
import {pack, unpack} from "msgpackr";

/**
 * LevelDB-based metadata store for build cache.
 *
 * Provides a key-value interface backed by classic-level (LevelDB).
 * Each metadata category is isolated via sublevel namespacing.
 * Values are encoded as MessagePack binary.
 *
 * The LevelDB API is async, matching CacheManager's existing async pattern.
 */
export default class MetadataStore {
	#db;
	#sublevels;

	/**
	 * Open the LevelDB database at the given cache directory.
	 *
	 * @param {string} cacheDir Absolute path to the versioned cache directory
	 * @returns {Promise<MetadataStore>}
	 */
	static async open(cacheDir) {
		const store = new MetadataStore();
		const dbPath = path.join(cacheDir, "metadata.level");
		store.#db = new ClassicLevel(dbPath, {keyEncoding: "utf8", valueEncoding: "buffer"});
		await store.#db.open();

		store.#sublevels = {
			buildManifests: store.#db.sublevel("bm", {keyEncoding: "utf8", valueEncoding: "buffer"}),
			indexCache: store.#db.sublevel("ix", {keyEncoding: "utf8", valueEncoding: "buffer"}),
			stageMetadata: store.#db.sublevel("sm", {keyEncoding: "utf8", valueEncoding: "buffer"}),
			taskMetadata: store.#db.sublevel("tm", {keyEncoding: "utf8", valueEncoding: "buffer"}),
			resultMetadata: store.#db.sublevel("rm", {keyEncoding: "utf8", valueEncoding: "buffer"}),
		};

		return store;
	}

	// Key separator — must not appear in any key component
	static #SEP = "\x00";

	static #key(...parts) {
		return parts.join(MetadataStore.#SEP);
	}

	// --- Build Manifests ---

	async getBuildManifest(projectId, buildSignature) {
		const buf = await this.#sublevels.buildManifests.get(
			MetadataStore.#key(projectId, buildSignature));
		if (buf === undefined) {
			return null;
		}
		return unpack(buf);
	}

	async putBuildManifest(projectId, buildSignature, data) {
		await this.#sublevels.buildManifests.put(
			MetadataStore.#key(projectId, buildSignature), pack(data));
	}

	// --- Index Cache ---

	async getIndexCache(projectId, buildSignature, kind) {
		const buf = await this.#sublevels.indexCache.get(
			MetadataStore.#key(projectId, buildSignature, kind));
		if (buf === undefined) {
			return null;
		}
		return unpack(buf);
	}

	async putIndexCache(projectId, buildSignature, kind, data) {
		await this.#sublevels.indexCache.put(
			MetadataStore.#key(projectId, buildSignature, kind), pack(data));
	}

	// --- Stage Metadata ---

	async getStageMetadata(projectId, buildSignature, stageId, stageSignature) {
		const buf = await this.#sublevels.stageMetadata.get(
			MetadataStore.#key(projectId, buildSignature, stageId, stageSignature));
		if (buf === undefined) {
			return null;
		}
		return unpack(buf);
	}

	async putStageMetadata(projectId, buildSignature, stageId, stageSignature, data) {
		await this.#sublevels.stageMetadata.put(
			MetadataStore.#key(projectId, buildSignature, stageId, stageSignature), pack(data));
	}

	// --- Task Metadata ---

	async getTaskMetadata(projectId, buildSignature, taskName, type) {
		const buf = await this.#sublevels.taskMetadata.get(
			MetadataStore.#key(projectId, buildSignature, taskName, type));
		if (buf === undefined) {
			return null;
		}
		return unpack(buf);
	}

	async putTaskMetadata(projectId, buildSignature, taskName, type, data) {
		await this.#sublevels.taskMetadata.put(
			MetadataStore.#key(projectId, buildSignature, taskName, type), pack(data));
	}

	// --- Result Metadata ---

	async getResultMetadata(projectId, buildSignature, stageSignature) {
		const buf = await this.#sublevels.resultMetadata.get(
			MetadataStore.#key(projectId, buildSignature, stageSignature));
		if (buf === undefined) {
			return null;
		}
		return unpack(buf);
	}

	async putResultMetadata(projectId, buildSignature, stageSignature, data) {
		await this.#sublevels.resultMetadata.put(
			MetadataStore.#key(projectId, buildSignature, stageSignature), pack(data));
	}

	/**
	 * Close the database.
	 */
	async close() {
		await this.#db.close();
	}
}

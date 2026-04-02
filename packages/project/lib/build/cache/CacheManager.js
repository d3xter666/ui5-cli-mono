import cacache from "cacache";
import path from "node:path";
import {promisify} from "node:util";
import {gzip} from "node:zlib";
import os from "node:os";
import Configuration from "../../config/Configuration.js";
import JsonlStore from "./JsonlStore.js";
import {getLogger} from "@ui5/logger";
import BuildTimings from "./BuildTimings.js";

const log = getLogger("build:cache:CacheManager");

// Singleton instances mapped by cache directory path
const chacheManagerInstances = new Map();

// Options for cacache operations (using SHA-256 for integrity checks)
const CACACHE_OPTIONS = {algorithms: ["sha256"]};

// Cache version for compatibility management
const CACHE_VERSION = "v0_3_g";

/**
 * Manages persistence for the build cache using file-based storage and cacache
 *
 * CacheManager provides a hierarchical file-based cache structure:
 * - cas/ - Content-addressable storage (cacache) for resource content
 * - buildManifests/ - Build manifest files containing metadata about builds
 * - stageMetadata/ - Stage-level metadata organized by project, build, and stage
 * - index/ - Resource index files for efficient change detection
 *
 * The cache is organized by:
 * 1. Project ID (sanitized package name)
 * 2. Build signature (hash of build configuration)
 * 3. Stage ID (e.g., "result" or "task/taskName")
 * 4. Stage signature (hash of input resources)
 *
 * Key features:
 * - Content-addressable storage with integrity verification
 * - Singleton pattern per cache directory
 * - Configurable cache location via UI5_DATA_DIR or configuration
 * - Efficient resource deduplication through cacache
 *
 * @class
 */
export default class CacheManager {
	#casDir;
	#store;

	/**
	 * Creates a new CacheManager instance
	 *
	 * Initializes the directory structure for the cache. This constructor is private -
	 * use CacheManager.create() instead to get a singleton instance.
	 *
	 * @private
	 * @param {string} cacheDir Base directory for the cache
	 */
	constructor(casDir, store) {
		this.#casDir = casDir;
		this.#store = store;
	}

	/**
	 * Factory method to create or retrieve a CacheManager instance
	 *
	 * Returns a singleton CacheManager for the determined cache directory.
	 * The cache directory is resolved in this order:
	 * 1. UI5_DATA_DIR environment variable (resolved relative to cwd)
	 * 2. ui5DataDir from UI5 configuration file
	 * 3. Default: ~/.ui5/
	 *
	 * @public
	 * @param {string} cwd Current working directory for resolving relative paths
	 * @returns {Promise<CacheManager>} Singleton CacheManager instance for the cache directory
	 */
	static async create(cwd) {
		// ENV var should take precedence over the dataDir from the configuration.
		let ui5DataDir = process.env.UI5_DATA_DIR;
		if (!ui5DataDir) {
			const config = await Configuration.fromFile();
			ui5DataDir = config.getUi5DataDir();
		}
		if (ui5DataDir) {
			ui5DataDir = path.resolve(cwd, ui5DataDir);
		} else {
			ui5DataDir = path.join(os.homedir(), ".ui5");
		}
		const cacheDir = path.join(ui5DataDir, "buildCache");
		log.verbose(`Using build cache directory: ${cacheDir}`);

		if (!chacheManagerInstances.has(cacheDir)) {
			const versionedDir = path.join(cacheDir, CACHE_VERSION);
			const casDir = path.join(versionedDir, "cas");
			const store = await JsonlStore.open(versionedDir);
			chacheManagerInstances.set(cacheDir, new CacheManager(casDir, store));
		}
		return chacheManagerInstances.get(cacheDir);
	}

	/**
	 * Key separator for composite keys
	 */
	static #SEP = "\x00";

	static #key(...parts) {
		return parts.join(CacheManager.#SEP);
	}

	/**
	 * Reads a build manifest from cache
	 *
	 * @public
	 * @param {string} projectId Project identifier (typically package name)
	 * @param {string} buildSignature Build signature hash
	 * @returns {Promise<object|null>} Parsed manifest object or null if not found
	 */
	async readBuildManifest(projectId, buildSignature) {
		const t = BuildTimings.start("readBuildManifest");
		try {
			return await this.#store.get("buildManifests", CacheManager.#key(projectId, buildSignature));
	
		} finally {
			BuildTimings.end("readBuildManifest", t);
		}
	
	}

	/**
	 * Writes a build manifest to cache
	 *
	 * @public
	 * @param {string} projectId Project identifier (typically package name)
	 * @param {string} buildSignature Build signature hash
	 * @param {object} manifest Build manifest object to serialize
	 * @returns {Promise<void>}
	 */
	async writeBuildManifest(projectId, buildSignature, manifest) {
		const t = BuildTimings.start("writeBuildManifest");
		try {
			await this.#store.put("buildManifests", CacheManager.#key(projectId, buildSignature), manifest);
	
		} finally {
			BuildTimings.end("writeBuildManifest", t);
		}
	
	}

	/**
	 * Reads resource index cache from storage
	 *
	 * @public
	 * @param {string} projectId Project identifier (typically package name)
	 * @param {string} buildSignature Build signature hash
	 * @param {string} kind "source" or "result"
	 * @returns {Promise<object|null>} Parsed index cache object or null if not found
	 */
	async readIndexCache(projectId, buildSignature, kind) {
		const t = BuildTimings.start("readIndexCache");
		try {
			return await this.#store.get("indexCache", CacheManager.#key(projectId, buildSignature, kind));
	
		} finally {
			BuildTimings.end("readIndexCache", t);
		}
	
	}

	/**
	 * Writes resource index cache to storage
	 *
	 * @public
	 * @param {string} projectId Project identifier (typically package name)
	 * @param {string} buildSignature Build signature hash
	 * @param {string} kind "source" or "result"
	 * @param {object} index Index object containing resource tree and task metadata
	 * @returns {Promise<void>}
	 */
	async writeIndexCache(projectId, buildSignature, kind, index) {
		const t = BuildTimings.start("writeIndexCache");
		try {
			await this.#store.put("indexCache", CacheManager.#key(projectId, buildSignature, kind), index);
	
		} finally {
			BuildTimings.end("writeIndexCache", t);
		}
	
	}

	/**
	 * Reads stage metadata from cache
	 *
	 * @public
	 * @param {string} projectId Project identifier (typically package name)
	 * @param {string} buildSignature Build signature hash
	 * @param {string} stageId Stage identifier
	 * @param {string} stageSignature Stage signature hash
	 * @returns {Promise<object|null>} Parsed stage metadata or null if not found
	 */
	async readStageCache(projectId, buildSignature, stageId, stageSignature) {
		const t = BuildTimings.start("readStageCache");
		try {
			return await this.#store.get("stageMetadata",
				CacheManager.#key(projectId, buildSignature, stageId, stageSignature));
	
		} finally {
			BuildTimings.end("readStageCache", t);
		}
	
	}

	/**
	 * Writes stage metadata to cache
	 *
	 * @public
	 * @param {string} projectId Project identifier (typically package name)
	 * @param {string} buildSignature Build signature hash
	 * @param {string} stageId Stage identifier
	 * @param {string} stageSignature Stage signature hash
	 * @param {object} metadata Stage metadata object
	 * @returns {Promise<void>}
	 */
	async writeStageCache(projectId, buildSignature, stageId, stageSignature, metadata) {
		const t = BuildTimings.start("writeStageCache");
		try {
			await this.#store.put("stageMetadata",
				CacheManager.#key(projectId, buildSignature, stageId, stageSignature), metadata);
	
		} finally {
			BuildTimings.end("writeStageCache", t);
		}
	
	}

	/**
	 * Reads task metadata from cache
	 *
	 * @public
	 * @param {string} projectId Project identifier (typically package name)
	 * @param {string} buildSignature Build signature hash
	 * @param {string} taskName Task name
	 * @param {string} type "project" or "dependency"
	 * @returns {Promise<object|null>} Parsed task metadata or null if not found
	 */
	async readTaskMetadata(projectId, buildSignature, taskName, type) {
		const t = BuildTimings.start("readTaskMetadata");
		try {
			return await this.#store.get("taskMetadata",
				CacheManager.#key(projectId, buildSignature, taskName, type));
	
		} finally {
			BuildTimings.end("readTaskMetadata", t);
		}
	
	}

	/**
	 * Writes task metadata to cache
	 *
	 * @public
	 * @param {string} projectId Project identifier (typically package name)
	 * @param {string} buildSignature Build signature hash
	 * @param {string} taskName Task name
	 * @param {string} type "project" or "dependency"
	 * @param {object} metadata Task metadata object
	 * @returns {Promise<void>}
	 */
	async writeTaskMetadata(projectId, buildSignature, taskName, type, metadata) {
		const t = BuildTimings.start("writeTaskMetadata");
		try {
			await this.#store.put("taskMetadata",
				CacheManager.#key(projectId, buildSignature, taskName, type), metadata);
	
		} finally {
			BuildTimings.end("writeTaskMetadata", t);
		}
	
	}

	/**
	 * Reads result metadata from cache
	 *
	 * @public
	 * @param {string} projectId Project identifier (typically package name)
	 * @param {string} buildSignature Build signature hash
	 * @param {string} stageSignature Stage signature hash
	 * @returns {Promise<object|null>} Parsed result metadata or null if not found
	 */
	async readResultMetadata(projectId, buildSignature, stageSignature) {
		const t = BuildTimings.start("readResultMetadata");
		try {
			return await this.#store.get("resultMetadata",
				CacheManager.#key(projectId, buildSignature, stageSignature));
	
		} finally {
			BuildTimings.end("readResultMetadata", t);
		}
	
	}

	/**
	 * Writes result metadata to cache
	 *
	 * @public
	 * @param {string} projectId Project identifier (typically package name)
	 * @param {string} buildSignature Build signature hash
	 * @param {string} stageSignature Stage signature hash
	 * @param {object} metadata Result metadata object
	 * @returns {Promise<void>}
	 */
	async writeResultMetadata(projectId, buildSignature, stageSignature, metadata) {
		const t = BuildTimings.start("writeResultMetadata");
		try {
			await this.#store.put("resultMetadata",
				CacheManager.#key(projectId, buildSignature, stageSignature), metadata);
	
		} finally {
			BuildTimings.end("writeResultMetadata", t);
		}
	
	}

	/**
	 * Retrieves the file system path for a cached resource
	 *
	 * Looks up a resource in the content-addressable storage using its cache key
	 * and verifies its integrity. If integrity mismatches, attempts to recover by
	 * looking up the content by digest and updating the index.
	 *
	 * @public
	 * @param {string} buildSignature Build signature hash
	 * @param {string} stageId Stage identifier (e.g., "result" or "task/taskName")
	 * @param {string} stageSignature Stage signature hash
	 * @param {string} resourcePath Virtual path of the resource
	 * @param {string} integrity Expected integrity hash (e.g., "sha256-...")
	 * @returns {Promise<string|null>} Absolute path to the cached resource file, or null if not found
	 * @throws {Error} If integrity is not provided
	 */
	async getResourcePathForStage(buildSignature, stageId, stageSignature, resourcePath, integrity) {
		const t = BuildTimings.start("getResourcePathForStage");
		try {
			if (!integrity) {
				throw new Error("Integrity hash must be provided to read from cache");
			}
			// const cacheKey = this.#createKeyForStage(buildSignature, stageId, stageSignature, resourcePath, integrity);
			const result = await cacache.get.info(this.#casDir, integrity);
			if (!result) {
				return null;
			}
			return result.path;
	
		} finally {
			BuildTimings.end("getResourcePathForStage", t);
		}
	
	}

	/**
	 * Writes a resource to the cache for a specific stage
	 *
	 * If the resource content (identified by integrity hash) already exists in the
	 * content-addressable storage, only updates the index with a new cache key.
	 * Otherwise, writes the full content to storage.
	 *
	 * This enables efficient deduplication when the same resource content appears
	 * in multiple stages or builds.
	 *
	 * @public
	 * @param {string} buildSignature Build signature hash
	 * @param {string} stageId Stage identifier (e.g., "result" or "task/taskName")
	 * @param {string} stageSignature Stage signature hash
	 * @param {@ui5/fs/Resource} resource Resource to cache
	 * @returns {Promise<void>}
	 */
	async writeStageResource(buildSignature, stageId, stageSignature, resource) {
		const t = BuildTimings.start("writeStageResource");
		try {
			// Check if resource has already been written
			const integrity = await resource.getIntegrity();
			const hasResource = await cacache.get.info(this.#casDir, integrity);
			if (!hasResource) {
				const buffer = await resource.getBuffer();
				// Compress the buffer using gzip before caching
				const compressedBuffer = await promisify(gzip)(buffer);
				await cacache.put(
					this.#casDir,
					integrity,
					compressedBuffer,
					CACACHE_OPTIONS
				);
			}
	
		} finally {
			BuildTimings.end("writeStageResource", t);
		}
	
	}

	/**
	 * Close the metadata store, triggering compaction of dirty categories.
	 *
	 * @returns {Promise<void>}
	 */
	async close() {
		await this.#store.close();
	}

	/**
	 * Close all singleton CacheManager instances and compact JSONL stores.
	 * Should be called before process exit.
	 *
	 * @public
	 * @returns {Promise<void>}
	 */
	static async closeAll() {
		const instances = Array.from(chacheManagerInstances.values());
		chacheManagerInstances.clear();
		await Promise.all(instances.map((instance) => instance.close()));
	}
}

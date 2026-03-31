import Database from "better-sqlite3";
import path from "node:path";
import fs from "graceful-fs";

/**
 * Pure-relational SQLite metadata store for the build cache.
 *
 * Every metadata type is decomposed into fully normalised tables with typed
 * columns.  No JSON/MessagePack/binary blobs are stored for structured data.
 *
 * The only exception is `build_config` inside build manifests, which is
 * arbitrary user-supplied configuration with an unpredictable schema.
 *
 * WAL journal mode is enabled for concurrent read performance.
 */
export default class MetadataStore {
	#db;
	#stmts;

	/* ------------------------------------------------------------------ */
	/*  Lifecycle                                                          */
	/* ------------------------------------------------------------------ */

	constructor(cacheDir) {
		const dbDir = path.join(cacheDir, "metadata");
		fs.mkdirSync(dbDir, {recursive: true});

		this.#db = new Database(path.join(dbDir, "cache.db"));
		this.#db.pragma("journal_mode = WAL");
		this.#db.pragma("synchronous = NORMAL");

		this.#createTables();
		this.#stmts = this.#prepareStatements();
	}

	close() {
		this.#db.close();
	}

	/* ================================================================== */
	/*  SCHEMA                                                             */
	/* ================================================================== */

	#createTables() {
		this.#db.exec(`
			/* ── Build Manifests ──────────────────────────────────── */
			CREATE TABLE IF NOT EXISTS build_manifests (
				project_id      TEXT NOT NULL,
				build_signature TEXT NOT NULL,
				/* project block */
				spec_version    TEXT,
				project_type    TEXT,
				project_name    TEXT,
				path_webapp     TEXT,
				path_src        TEXT,
				path_test       TEXT,
				/* buildManifest block */
				manifest_version TEXT,
				timestamp        TEXT,
				signature        TEXT,
				builder_version  TEXT,
				project_version  TEXT,
				fs_version       TEXT,
				builder_fs_version TEXT,
				build_config     TEXT,   /* only field stored as JSON – arbitrary user config */
				version          TEXT,
				namespace        TEXT,
				PRIMARY KEY (project_id, build_signature)
			);
			CREATE TABLE IF NOT EXISTS build_manifest_tags (
				project_id      TEXT NOT NULL,
				build_signature TEXT NOT NULL,
				tag_name        TEXT NOT NULL,
				tag_value       TEXT,
				PRIMARY KEY (project_id, build_signature, tag_name),
				FOREIGN KEY (project_id, build_signature)
					REFERENCES build_manifests (project_id, build_signature) ON DELETE CASCADE
			);

			/* ── Index Cache ─────────────────────────────────────── */
			CREATE TABLE IF NOT EXISTS index_cache (
				project_id      TEXT NOT NULL,
				build_signature TEXT NOT NULL,
				kind            TEXT NOT NULL,
				index_timestamp INTEGER,
				tree_version    INTEGER DEFAULT 1,
				PRIMARY KEY (project_id, build_signature, kind)
			);
			CREATE TABLE IF NOT EXISTS index_cache_tasks (
				project_id      TEXT NOT NULL,
				build_signature TEXT NOT NULL,
				kind            TEXT NOT NULL,
				ordinal         INTEGER NOT NULL,
				task_name       TEXT NOT NULL,
				supports_differential INTEGER NOT NULL,
				PRIMARY KEY (project_id, build_signature, kind, task_name),
				FOREIGN KEY (project_id, build_signature, kind)
					REFERENCES index_cache (project_id, build_signature, kind) ON DELETE CASCADE
			);

			/* ── Shared: Tree Nodes (materialized-path) ──────────── */
			CREATE TABLE IF NOT EXISTS tree_nodes (
				owner_type      TEXT NOT NULL,   /* 'index', 'task_root' */
				owner_key       TEXT NOT NULL,   /* composite key identifying the owner */
				node_path       TEXT NOT NULL,   /* materialized path e.g. '/resources/sap/ui/core' */
				name            TEXT NOT NULL,
				node_type       TEXT NOT NULL,   /* 'resource' | 'directory' */
				hash            TEXT,            /* hex-encoded SHA-256 */
				integrity       TEXT,
				last_modified   INTEGER,
				size            INTEGER,
				inode           INTEGER,
				PRIMARY KEY (owner_type, owner_key, node_path)
			);
			CREATE TABLE IF NOT EXISTS tree_node_tags (
				owner_type      TEXT NOT NULL,
				owner_key       TEXT NOT NULL,
				node_path       TEXT NOT NULL,
				tag_name        TEXT NOT NULL,
				tag_value       TEXT,
				PRIMARY KEY (owner_type, owner_key, node_path, tag_name),
				FOREIGN KEY (owner_type, owner_key, node_path)
					REFERENCES tree_nodes (owner_type, owner_key, node_path) ON DELETE CASCADE
			);

			/* ── Result Metadata ──────────────────────────────────── */
			CREATE TABLE IF NOT EXISTS result_metadata (
				project_id              TEXT NOT NULL,
				build_signature         TEXT NOT NULL,
				stage_signature         TEXT NOT NULL,
				source_stage_signature  TEXT,
				PRIMARY KEY (project_id, build_signature, stage_signature)
			);
			CREATE TABLE IF NOT EXISTS result_stage_sigs (
				project_id      TEXT NOT NULL,
				build_signature TEXT NOT NULL,
				stage_signature TEXT NOT NULL,
				ordinal         INTEGER NOT NULL,
				stage_name      TEXT NOT NULL,
				sig_chain       TEXT NOT NULL,
				PRIMARY KEY (project_id, build_signature, stage_signature, stage_name),
				FOREIGN KEY (project_id, build_signature, stage_signature)
					REFERENCES result_metadata (project_id, build_signature, stage_signature) ON DELETE CASCADE
			);

			/* ── Stage Metadata ───────────────────────────────────── */
			CREATE TABLE IF NOT EXISTS stage_cache (
				project_id      TEXT NOT NULL,
				build_signature TEXT NOT NULL,
				stage_id        TEXT NOT NULL,
				stage_signature TEXT NOT NULL,
				has_reader_mapping INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (project_id, build_signature, stage_id, stage_signature)
			);
			CREATE TABLE IF NOT EXISTS stage_resource_mapping (
				project_id      TEXT NOT NULL,
				build_signature TEXT NOT NULL,
				stage_id        TEXT NOT NULL,
				stage_signature TEXT NOT NULL,
				virtual_path    TEXT NOT NULL,
				reader_index    INTEGER NOT NULL,
				PRIMARY KEY (project_id, build_signature, stage_id, stage_signature, virtual_path)
			);
			CREATE TABLE IF NOT EXISTS stage_resources (
				project_id      TEXT NOT NULL,
				build_signature TEXT NOT NULL,
				stage_id        TEXT NOT NULL,
				stage_signature TEXT NOT NULL,
				reader_index    INTEGER NOT NULL DEFAULT 0,
				resource_path   TEXT NOT NULL,
				inode           INTEGER,
				last_modified   INTEGER,
				size            INTEGER,
				integrity       TEXT,
				PRIMARY KEY (project_id, build_signature, stage_id, stage_signature, reader_index, resource_path)
			);
			CREATE TABLE IF NOT EXISTS stage_tag_ops (
				project_id      TEXT NOT NULL,
				build_signature TEXT NOT NULL,
				stage_id        TEXT NOT NULL,
				stage_signature TEXT NOT NULL,
				tag_type        TEXT NOT NULL,  /* 'project' | 'build' */
				resource_path   TEXT NOT NULL,
				tag_name        TEXT NOT NULL,
				tag_value       TEXT,
				PRIMARY KEY (project_id, build_signature, stage_id, stage_signature, tag_type, resource_path, tag_name)
			);

			/* ── Task Metadata ────────────────────────────────────── */
			CREATE TABLE IF NOT EXISTS task_metadata (
				project_id      TEXT NOT NULL,
				build_signature TEXT NOT NULL,
				task_name       TEXT NOT NULL,
				type            TEXT NOT NULL,
				next_graph_id   INTEGER,
				unused_at_least_once INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (project_id, build_signature, task_name, type)
			);
			CREATE TABLE IF NOT EXISTS task_graph_nodes (
				project_id      TEXT NOT NULL,
				build_signature TEXT NOT NULL,
				task_name       TEXT NOT NULL,
				type            TEXT NOT NULL,
				node_id         INTEGER NOT NULL,
				parent_id       INTEGER,
				PRIMARY KEY (project_id, build_signature, task_name, type, node_id)
			);
			CREATE TABLE IF NOT EXISTS task_graph_requests (
				project_id      TEXT NOT NULL,
				build_signature TEXT NOT NULL,
				task_name       TEXT NOT NULL,
				type            TEXT NOT NULL,
				node_id         INTEGER NOT NULL,
				request_key     TEXT NOT NULL,
				PRIMARY KEY (project_id, build_signature, task_name, type, node_id, request_key)
			);
			CREATE TABLE IF NOT EXISTS task_root_indices (
				project_id      TEXT NOT NULL,
				build_signature TEXT NOT NULL,
				task_name       TEXT NOT NULL,
				type            TEXT NOT NULL,
				node_id         INTEGER NOT NULL,
				index_timestamp INTEGER,
				tree_version    INTEGER DEFAULT 1,
				PRIMARY KEY (project_id, build_signature, task_name, type, node_id)
			);
			CREATE TABLE IF NOT EXISTS task_delta_resources (
				project_id      TEXT NOT NULL,
				build_signature TEXT NOT NULL,
				task_name       TEXT NOT NULL,
				type            TEXT NOT NULL,
				node_id         INTEGER NOT NULL,
				resource_path   TEXT NOT NULL,
				integrity       TEXT,
				size            INTEGER,
				last_modified   INTEGER,
				inode           INTEGER,
				PRIMARY KEY (project_id, build_signature, task_name, type, node_id, resource_path)
			);
			CREATE TABLE IF NOT EXISTS task_delta_tags (
				project_id      TEXT NOT NULL,
				build_signature TEXT NOT NULL,
				task_name       TEXT NOT NULL,
				type            TEXT NOT NULL,
				node_id         INTEGER NOT NULL,
				resource_path   TEXT NOT NULL,
				tag_name        TEXT NOT NULL,
				tag_value       TEXT,
				PRIMARY KEY (project_id, build_signature, task_name, type, node_id, resource_path, tag_name)
			);
		`);
	}

	/* ================================================================== */
	/*  PREPARED STATEMENTS                                                */
	/* ================================================================== */

	#prepareStatements() {
		const db = this.#db;
		return {
			/* ── Build Manifests ─────────────── */
			getBuildManifest: db.prepare(
				`SELECT * FROM build_manifests WHERE project_id = ? AND build_signature = ?`
			),
			putBuildManifest: db.prepare(
				`INSERT OR REPLACE INTO build_manifests
				 (project_id, build_signature, spec_version, project_type, project_name,
				  path_webapp, path_src, path_test, manifest_version, timestamp, signature,
				  builder_version, project_version, fs_version, builder_fs_version,
				  build_config, version, namespace)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
			),
			getBuildManifestTags: db.prepare(
				`SELECT tag_name, tag_value FROM build_manifest_tags
				 WHERE project_id = ? AND build_signature = ?`
			),
			putBuildManifestTag: db.prepare(
				`INSERT OR REPLACE INTO build_manifest_tags
				 (project_id, build_signature, tag_name, tag_value) VALUES (?,?,?,?)`
			),
			delBuildManifestTags: db.prepare(
				`DELETE FROM build_manifest_tags WHERE project_id = ? AND build_signature = ?`
			),

			/* ── Index Cache ─────────────────── */
			getIndexCache: db.prepare(
				`SELECT * FROM index_cache WHERE project_id = ? AND build_signature = ? AND kind = ?`
			),
			putIndexCache: db.prepare(
				`INSERT OR REPLACE INTO index_cache
				 (project_id, build_signature, kind, index_timestamp, tree_version) VALUES (?,?,?,?,?)`
			),
			getIndexCacheTasks: db.prepare(
				`SELECT task_name, supports_differential FROM index_cache_tasks
				 WHERE project_id = ? AND build_signature = ? AND kind = ? ORDER BY ordinal`
			),
			putIndexCacheTask: db.prepare(
				`INSERT OR REPLACE INTO index_cache_tasks
				 (project_id, build_signature, kind, ordinal, task_name, supports_differential) VALUES (?,?,?,?,?,?)`
			),
			delIndexCacheTasks: db.prepare(
				`DELETE FROM index_cache_tasks WHERE project_id = ? AND build_signature = ? AND kind = ?`
			),

			/* ── Tree Nodes ──────────────────── */
			getTreeNodes: db.prepare(
				`SELECT * FROM tree_nodes WHERE owner_type = ? AND owner_key = ? ORDER BY node_path`
			),
			putTreeNode: db.prepare(
				`INSERT OR REPLACE INTO tree_nodes
				 (owner_type, owner_key, node_path, name, node_type, hash, integrity,
				  last_modified, size, inode) VALUES (?,?,?,?,?,?,?,?,?,?)`
			),
			delTreeNodes: db.prepare(
				`DELETE FROM tree_nodes WHERE owner_type = ? AND owner_key = ?`
			),
			getTreeNodeTags: db.prepare(
				`SELECT node_path, tag_name, tag_value FROM tree_node_tags
				 WHERE owner_type = ? AND owner_key = ? ORDER BY node_path`
			),
			putTreeNodeTag: db.prepare(
				`INSERT OR REPLACE INTO tree_node_tags
				 (owner_type, owner_key, node_path, tag_name, tag_value) VALUES (?,?,?,?,?)`
			),
			delTreeNodeTags: db.prepare(
				`DELETE FROM tree_node_tags WHERE owner_type = ? AND owner_key = ?`
			),

			/* ── Result Metadata ─────────────── */
			getResultMetadata: db.prepare(
				`SELECT * FROM result_metadata
				 WHERE project_id = ? AND build_signature = ? AND stage_signature = ?`
			),
			putResultMetadata: db.prepare(
				`INSERT OR REPLACE INTO result_metadata
				 (project_id, build_signature, stage_signature, source_stage_signature) VALUES (?,?,?,?)`
			),
			getResultStageSigs: db.prepare(
				`SELECT stage_name, sig_chain FROM result_stage_sigs
				 WHERE project_id = ? AND build_signature = ? AND stage_signature = ? ORDER BY ordinal`
			),
			putResultStageSig: db.prepare(
				`INSERT OR REPLACE INTO result_stage_sigs
				 (project_id, build_signature, stage_signature, ordinal, stage_name, sig_chain) VALUES (?,?,?,?,?,?)`
			),
			delResultStageSigs: db.prepare(
				`DELETE FROM result_stage_sigs WHERE project_id = ? AND build_signature = ? AND stage_signature = ?`
			),

			/* ── Stage Cache ─────────────────── */
			getStageCache: db.prepare(
				`SELECT * FROM stage_cache
				 WHERE project_id = ? AND build_signature = ? AND stage_id = ? AND stage_signature = ?`
			),
			putStageCache: db.prepare(
				`INSERT OR REPLACE INTO stage_cache
				 (project_id, build_signature, stage_id, stage_signature, has_reader_mapping) VALUES (?,?,?,?,?)`
			),
			getStageResourceMapping: db.prepare(
				`SELECT virtual_path, reader_index FROM stage_resource_mapping
				 WHERE project_id = ? AND build_signature = ? AND stage_id = ? AND stage_signature = ?`
			),
			putStageResourceMapping: db.prepare(
				`INSERT OR REPLACE INTO stage_resource_mapping
				 (project_id, build_signature, stage_id, stage_signature, virtual_path, reader_index) VALUES (?,?,?,?,?,?)`
			),
			delStageResourceMapping: db.prepare(
				`DELETE FROM stage_resource_mapping
				 WHERE project_id = ? AND build_signature = ? AND stage_id = ? AND stage_signature = ?`
			),
			getStageResources: db.prepare(
				`SELECT reader_index, resource_path, inode, last_modified, size, integrity
				 FROM stage_resources
				 WHERE project_id = ? AND build_signature = ? AND stage_id = ? AND stage_signature = ?
				 ORDER BY reader_index, resource_path`
			),
			putStageResource: db.prepare(
				`INSERT OR REPLACE INTO stage_resources
				 (project_id, build_signature, stage_id, stage_signature, reader_index, resource_path,
				  inode, last_modified, size, integrity) VALUES (?,?,?,?,?,?,?,?,?,?)`
			),
			delStageResources: db.prepare(
				`DELETE FROM stage_resources
				 WHERE project_id = ? AND build_signature = ? AND stage_id = ? AND stage_signature = ?`
			),
			getStageTagOps: db.prepare(
				`SELECT tag_type, resource_path, tag_name, tag_value FROM stage_tag_ops
				 WHERE project_id = ? AND build_signature = ? AND stage_id = ? AND stage_signature = ?`
			),
			putStageTagOp: db.prepare(
				`INSERT OR REPLACE INTO stage_tag_ops
				 (project_id, build_signature, stage_id, stage_signature, tag_type, resource_path,
				  tag_name, tag_value) VALUES (?,?,?,?,?,?,?,?)`
			),
			delStageTagOps: db.prepare(
				`DELETE FROM stage_tag_ops
				 WHERE project_id = ? AND build_signature = ? AND stage_id = ? AND stage_signature = ?`
			),

			/* ── Task Metadata ───────────────── */
			getTaskMetadata: db.prepare(
				`SELECT * FROM task_metadata
				 WHERE project_id = ? AND build_signature = ? AND task_name = ? AND type = ?`
			),
			putTaskMetadata: db.prepare(
				`INSERT OR REPLACE INTO task_metadata
				 (project_id, build_signature, task_name, type, next_graph_id, unused_at_least_once)
				 VALUES (?,?,?,?,?,?)`
			),
			getTaskGraphNodes: db.prepare(
				`SELECT node_id, parent_id FROM task_graph_nodes
				 WHERE project_id = ? AND build_signature = ? AND task_name = ? AND type = ?
				 ORDER BY node_id`
			),
			putTaskGraphNode: db.prepare(
				`INSERT OR REPLACE INTO task_graph_nodes
				 (project_id, build_signature, task_name, type, node_id, parent_id) VALUES (?,?,?,?,?,?)`
			),
			delTaskGraphNodes: db.prepare(
				`DELETE FROM task_graph_nodes
				 WHERE project_id = ? AND build_signature = ? AND task_name = ? AND type = ?`
			),
			getTaskGraphRequests: db.prepare(
				`SELECT node_id, request_key FROM task_graph_requests
				 WHERE project_id = ? AND build_signature = ? AND task_name = ? AND type = ?
				 ORDER BY node_id`
			),
			putTaskGraphRequest: db.prepare(
				`INSERT OR REPLACE INTO task_graph_requests
				 (project_id, build_signature, task_name, type, node_id, request_key) VALUES (?,?,?,?,?,?)`
			),
			delTaskGraphRequests: db.prepare(
				`DELETE FROM task_graph_requests
				 WHERE project_id = ? AND build_signature = ? AND task_name = ? AND type = ?`
			),
			getTaskRootIndices: db.prepare(
				`SELECT node_id, index_timestamp, tree_version FROM task_root_indices
				 WHERE project_id = ? AND build_signature = ? AND task_name = ? AND type = ?
				 ORDER BY node_id`
			),
			putTaskRootIndex: db.prepare(
				`INSERT OR REPLACE INTO task_root_indices
				 (project_id, build_signature, task_name, type, node_id, index_timestamp, tree_version)
				 VALUES (?,?,?,?,?,?,?)`
			),
			delTaskRootIndices: db.prepare(
				`DELETE FROM task_root_indices
				 WHERE project_id = ? AND build_signature = ? AND task_name = ? AND type = ?`
			),
			getTaskDeltaResources: db.prepare(
				`SELECT node_id, resource_path, integrity, size, last_modified, inode
				 FROM task_delta_resources
				 WHERE project_id = ? AND build_signature = ? AND task_name = ? AND type = ?
				 ORDER BY node_id`
			),
			putTaskDeltaResource: db.prepare(
				`INSERT OR REPLACE INTO task_delta_resources
				 (project_id, build_signature, task_name, type, node_id, resource_path,
				  integrity, size, last_modified, inode) VALUES (?,?,?,?,?,?,?,?,?,?)`
			),
			delTaskDeltaResources: db.prepare(
				`DELETE FROM task_delta_resources
				 WHERE project_id = ? AND build_signature = ? AND task_name = ? AND type = ?`
			),
			getTaskDeltaTags: db.prepare(
				`SELECT node_id, resource_path, tag_name, tag_value FROM task_delta_tags
				 WHERE project_id = ? AND build_signature = ? AND task_name = ? AND type = ?
				 ORDER BY node_id`
			),
			putTaskDeltaTag: db.prepare(
				`INSERT OR REPLACE INTO task_delta_tags
				 (project_id, build_signature, task_name, type, node_id, resource_path,
				  tag_name, tag_value) VALUES (?,?,?,?,?,?,?,?)`
			),
			delTaskDeltaTags: db.prepare(
				`DELETE FROM task_delta_tags
				 WHERE project_id = ? AND build_signature = ? AND task_name = ? AND type = ?`
			),
		};
	}

	/* ================================================================== */
	/*  BUILD MANIFESTS                                                    */
	/* ================================================================== */

	getBuildManifest(projectId, buildSignature) {
		const row = this.#stmts.getBuildManifest.get(projectId, buildSignature);
		if (!row) return null;

		const tagRows = this.#stmts.getBuildManifestTags.all(projectId, buildSignature);
		const tags = Object.create(null);
		for (const t of tagRows) {
			tags[t.tag_name] = t.tag_value;
		}

		return {
			project: {
				specVersion: row.spec_version,
				type: row.project_type,
				metadata: {name: row.project_name},
				resources: {
					configuration: {
						paths: MetadataStore.#buildPathsObject(row.path_webapp, row.path_src, row.path_test),
					},
				},
			},
			buildManifest: {
				manifestVersion: row.manifest_version,
				timestamp: row.timestamp,
				signature: row.signature,
				versions: MetadataStore.#buildVersionsObject(
					row.builder_version, row.project_version, row.fs_version, row.builder_fs_version),
				buildConfig: row.build_config ? JSON.parse(row.build_config) : undefined,
				version: row.version,
				namespace: row.namespace,
				tags,
			},
		};
	}

	putBuildManifest(projectId, buildSignature, data) {
		const p = data.project;
		const m = data.buildManifest;
		const paths = p.resources?.configuration?.paths || {};
		const v = m.versions || {};

		this.#db.transaction(() => {
			this.#stmts.putBuildManifest.run(
				projectId, buildSignature,
				p.specVersion, p.type, p.metadata?.name,
				paths.webapp ?? null, paths.src ?? null, paths.test ?? null,
				m.manifestVersion, m.timestamp, m.signature,
				v.builderVersion, v.projectVersion, v.fsVersion, v.builderFsVersion ?? null,
				m.buildConfig != null ? JSON.stringify(m.buildConfig) : null,
				m.version, m.namespace
			);

			this.#stmts.delBuildManifestTags.run(projectId, buildSignature);
			if (m.tags) {
				for (const [name, value] of Object.entries(m.tags)) {
					this.#stmts.putBuildManifestTag.run(
						projectId, buildSignature, name, value != null ? String(value) : null);
				}
			}
		})();
	}

	static #buildPathsObject(webapp, src, test) {
		const paths = Object.create(null);
		if (webapp != null) paths.webapp = webapp;
		if (src != null) paths.src = src;
		if (test != null) paths.test = test;
		return paths;
	}

	static #buildVersionsObject(builder, project, fs, builderFs) {
		const obj = {builderVersion: builder, projectVersion: project, fsVersion: fs};
		if (builderFs != null) obj.builderFsVersion = builderFs;
		return obj;
	}

	/* ================================================================== */
	/*  INDEX CACHE                                                        */
	/* ================================================================== */

	getIndexCache(projectId, buildSignature, kind) {
		const row = this.#stmts.getIndexCache.get(projectId, buildSignature, kind);
		if (!row) return null;

		const ownerKey = `${projectId}\0${buildSignature}\0${kind}`;
		const indexTree = this.#readTree("index", ownerKey);

		const taskRows = this.#stmts.getIndexCacheTasks.all(projectId, buildSignature, kind);
		const tasks = taskRows.map((t) => [t.task_name, t.supports_differential]);

		return {
			indexTimestamp: row.index_timestamp,
			indexTree: {version: row.tree_version, root: indexTree},
			tasks,
		};
	}

	putIndexCache(projectId, buildSignature, kind, data) {
		const ownerKey = `${projectId}\0${buildSignature}\0${kind}`;

		this.#db.transaction(() => {
			this.#stmts.putIndexCache.run(
				projectId, buildSignature, kind,
				data.indexTimestamp, data.indexTree?.version ?? 1
			);

			// Tasks
			this.#stmts.delIndexCacheTasks.run(projectId, buildSignature, kind);
			if (data.tasks) {
				let ordinal = 0;
				for (const [taskName, supportsDiff] of data.tasks) {
					this.#stmts.putIndexCacheTask.run(
						projectId, buildSignature, kind, ordinal, taskName, supportsDiff);
					ordinal++;
				}
			}

			// Tree
			this.#deleteTree("index", ownerKey);
			if (data.indexTree?.root) {
				this.#writeTree("index", ownerKey, data.indexTree.root, "/");
			}
		})();
	}

	/* ================================================================== */
	/*  RESULT METADATA                                                    */
	/* ================================================================== */

	getResultMetadata(projectId, buildSignature, stageSignature) {
		const row = this.#stmts.getResultMetadata.get(projectId, buildSignature, stageSignature);
		if (!row) return null;

		const sigRows = this.#stmts.getResultStageSigs.all(projectId, buildSignature, stageSignature);
		const stageSignatures = Object.create(null);
		for (const s of sigRows) {
			stageSignatures[s.stage_name] = s.sig_chain;
		}

		return {stageSignatures, sourceStageSignature: row.source_stage_signature};
	}

	putResultMetadata(projectId, buildSignature, stageSignature, data) {
		this.#db.transaction(() => {
			this.#stmts.putResultMetadata.run(
				projectId, buildSignature, stageSignature, data.sourceStageSignature);

			this.#stmts.delResultStageSigs.run(projectId, buildSignature, stageSignature);
			if (data.stageSignatures) {
				let ordinal = 0;
				for (const [name, chain] of Object.entries(data.stageSignatures)) {
					this.#stmts.putResultStageSig.run(
						projectId, buildSignature, stageSignature, ordinal, name, chain);
					ordinal++;
				}
			}
		})();
	}

	/* ================================================================== */
	/*  STAGE METADATA                                                     */
	/* ================================================================== */

	getStageMetadata(projectId, buildSignature, stageId, stageSignature) {
		const row = this.#stmts.getStageCache.get(projectId, buildSignature, stageId, stageSignature);
		if (!row) return null;

		const pk = [projectId, buildSignature, stageId, stageSignature];

		// Resources
		const resourceRows = this.#stmts.getStageResources.all(...pk);

		let resourceMapping;
		let resourceMetadata;

		if (row.has_reader_mapping) {
			// Multi-reader: resourceMetadata is an array, resourceMapping maps path→readerIdx
			const mappingRows = this.#stmts.getStageResourceMapping.all(...pk);
			resourceMapping = Object.create(null);
			for (const m of mappingRows) {
				resourceMapping[m.virtual_path] = m.reader_index;
			}

			// Group resources by reader_index
			const byReader = new Map();
			for (const r of resourceRows) {
				let bucket = byReader.get(r.reader_index);
				if (!bucket) {
					bucket = Object.create(null);
					byReader.set(r.reader_index, bucket);
				}
				bucket[r.resource_path] = {
					inode: r.inode, lastModified: r.last_modified, size: r.size, integrity: r.integrity,
				};
			}
			// Determine array size from both mapping and resource rows
			let maxIdx = 0;
			for (const m of mappingRows) {
				if (m.reader_index > maxIdx) maxIdx = m.reader_index;
			}
			for (const r of resourceRows) {
				if (r.reader_index > maxIdx) maxIdx = r.reader_index;
			}
			resourceMetadata = [];
			for (let i = 0; i <= maxIdx; i++) {
				resourceMetadata.push(byReader.get(i) || Object.create(null));
			}
		} else {
			// Single reader: resourceMetadata is a plain object
			resourceMetadata = Object.create(null);
			for (const r of resourceRows) {
				resourceMetadata[r.resource_path] = {
					inode: r.inode, lastModified: r.last_modified, size: r.size, integrity: r.integrity,
				};
			}
		}

		// Tag operations
		const tagRows = this.#stmts.getStageTagOps.all(...pk);
		const projectTagOperations = Object.create(null);
		const buildTagOperations = Object.create(null);
		for (const t of tagRows) {
			const target = t.tag_type === "project" ? projectTagOperations : buildTagOperations;
			if (!target[t.resource_path]) {
				target[t.resource_path] = Object.create(null);
			}
			target[t.resource_path][t.tag_name] = t.tag_value;
		}

		const result = {resourceMetadata, projectTagOperations, buildTagOperations};
		if (resourceMapping) result.resourceMapping = resourceMapping;
		return result;
	}

	putStageMetadata(projectId, buildSignature, stageId, stageSignature, data) {
		const pk = [projectId, buildSignature, stageId, stageSignature];
		const hasMapping = !!data.resourceMapping;

		this.#db.transaction(() => {
			this.#stmts.putStageCache.run(...pk, hasMapping ? 1 : 0);

			// Clean old data
			this.#stmts.delStageResourceMapping.run(...pk);
			this.#stmts.delStageResources.run(...pk);
			this.#stmts.delStageTagOps.run(...pk);

			// Resource mapping
			if (hasMapping) {
				for (const [virtualPath, readerIdx] of Object.entries(data.resourceMapping)) {
					this.#stmts.putStageResourceMapping.run(...pk, virtualPath, readerIdx);
				}
			}

			// Resources
			if (hasMapping && Array.isArray(data.resourceMetadata)) {
				for (let idx = 0; idx < data.resourceMetadata.length; idx++) {
					const readerMeta = data.resourceMetadata[idx];
					for (const [resPath, meta] of Object.entries(readerMeta)) {
						this.#stmts.putStageResource.run(
							...pk, idx, resPath, meta.inode, meta.lastModified, meta.size, meta.integrity);
					}
				}
			} else if (data.resourceMetadata && typeof data.resourceMetadata === "object") {
				for (const [resPath, meta] of Object.entries(data.resourceMetadata)) {
					this.#stmts.putStageResource.run(
						...pk, 0, resPath, meta.inode, meta.lastModified, meta.size, meta.integrity);
				}
			}

			// Tag operations
			this.#writeTagOps(pk, "project", data.projectTagOperations);
			this.#writeTagOps(pk, "build", data.buildTagOperations);
		})();
	}

	#writeTagOps(pk, tagType, tagOps) {
		if (!tagOps) return;
		for (const [resPath, tags] of Object.entries(tagOps)) {
			for (const [tagName, tagValue] of Object.entries(tags)) {
				this.#stmts.putStageTagOp.run(
					...pk, tagType, resPath, tagName, tagValue != null ? String(tagValue) : null);
			}
		}
	}

	/* ================================================================== */
	/*  TASK METADATA                                                      */
	/* ================================================================== */

	getTaskMetadata(projectId, buildSignature, taskName, type) {
		const row = this.#stmts.getTaskMetadata.get(projectId, buildSignature, taskName, type);
		if (!row) return null;

		const pk = [projectId, buildSignature, taskName, type];

		// Request set graph
		const graphNodeRows = this.#stmts.getTaskGraphNodes.all(...pk);
		const requestRows = this.#stmts.getTaskGraphRequests.all(...pk);
		const requestsByNode = new Map();
		for (const r of requestRows) {
			let arr = requestsByNode.get(r.node_id);
			if (!arr) {
				arr = [];
				requestsByNode.set(r.node_id, arr);
			}
			arr.push(r.request_key);
		}
		const nodes = graphNodeRows.map((n) => ({
			id: n.node_id,
			parent: n.parent_id,
			addedRequests: requestsByNode.get(n.node_id) || [],
		}));

		// Root indices
		const rootIndexRows = this.#stmts.getTaskRootIndices.all(...pk);
		const rootIndices = rootIndexRows.map((ri) => {
			const ownerKey = `${projectId}\0${buildSignature}\0${taskName}\0${type}\0${ri.node_id}`;
			const treeRoot = this.#readTree("task_root", ownerKey);
			return {
				nodeId: ri.node_id,
				resourceIndex: {
					indexTimestamp: ri.index_timestamp,
					indexTree: {version: ri.tree_version, root: treeRoot},
				},
			};
		});

		// Delta indices
		const deltaResourceRows = this.#stmts.getTaskDeltaResources.all(...pk);
		const deltaTagRows = this.#stmts.getTaskDeltaTags.all(...pk);
		const deltaTagsByNodeAndPath = new Map();
		for (const dt of deltaTagRows) {
			const key = `${dt.node_id}\0${dt.resource_path}`;
			let m = deltaTagsByNodeAndPath.get(key);
			if (!m) {
				m = Object.create(null);
				deltaTagsByNodeAndPath.set(key, m);
			}
			m[dt.tag_name] = dt.tag_value;
		}

		const deltaByNode = new Map();
		for (const dr of deltaResourceRows) {
			let arr = deltaByNode.get(dr.node_id);
			if (!arr) {
				arr = [];
				deltaByNode.set(dr.node_id, arr);
			}
			const entry = {
				path: dr.resource_path,
				integrity: dr.integrity,
				size: dr.size,
				lastModified: dr.last_modified,
				inode: dr.inode,
			};
			const tagKey = `${dr.node_id}\0${dr.resource_path}`;
			const tags = deltaTagsByNodeAndPath.get(tagKey);
			entry.tags = tags || null;
			arr.push(entry);
		}
		const deltaIndices = [];
		for (const n of graphNodeRows) {
			if (n.parent_id != null) {
				deltaIndices.push({
					nodeId: n.node_id,
					addedResourceIndex: deltaByNode.get(n.node_id) || [],
				});
			}
		}

		return {
			requestSetGraph: {nodes, nextId: row.next_graph_id},
			rootIndices,
			deltaIndices,
			unusedAtLeastOnce: !!row.unused_at_least_once,
		};
	}

	putTaskMetadata(projectId, buildSignature, taskName, type, data) {
		const pk = [projectId, buildSignature, taskName, type];

		this.#db.transaction(() => {
			this.#stmts.putTaskMetadata.run(
				...pk, data.requestSetGraph.nextId, data.unusedAtLeastOnce ? 1 : 0);

			// Clean old data
			this.#stmts.delTaskGraphNodes.run(...pk);
			this.#stmts.delTaskGraphRequests.run(...pk);
			this.#stmts.delTaskRootIndices.run(...pk);
			this.#stmts.delTaskDeltaResources.run(...pk);
			this.#stmts.delTaskDeltaTags.run(...pk);

			// Graph nodes & requests
			for (const node of data.requestSetGraph.nodes) {
				this.#stmts.putTaskGraphNode.run(...pk, node.id, node.parent ?? null);
				for (const req of node.addedRequests) {
					this.#stmts.putTaskGraphRequest.run(...pk, node.id, req);
				}
			}

			// Root indices (with trees)
			for (const ri of data.rootIndices) {
				const ownerKey = `${projectId}\0${buildSignature}\0${taskName}\0${type}\0${ri.nodeId}`;
				this.#stmts.putTaskRootIndex.run(
					...pk, ri.nodeId,
					ri.resourceIndex.indexTimestamp,
					ri.resourceIndex.indexTree?.version ?? 1
				);
				this.#deleteTree("task_root", ownerKey);
				if (ri.resourceIndex.indexTree?.root) {
					this.#writeTree("task_root", ownerKey, ri.resourceIndex.indexTree.root, "/");
				}
			}

			// Delta indices
			for (const di of data.deltaIndices) {
				for (const res of di.addedResourceIndex) {
					this.#stmts.putTaskDeltaResource.run(
						...pk, di.nodeId, res.path, res.integrity, res.size, res.lastModified, res.inode);
					if (res.tags) {
						for (const [tagName, tagValue] of Object.entries(res.tags)) {
							this.#stmts.putTaskDeltaTag.run(
								...pk, di.nodeId, res.path, tagName,
								tagValue != null ? String(tagValue) : null);
						}
					}
				}
			}
		})();
	}

	/* ================================================================== */
	/*  TREE HELPERS  (materialized-path storage)                          */
	/* ================================================================== */

	/**
	 * Write a recursive TreeNode structure as flat rows using materialized paths.
	 *
	 * @param {string} ownerType  'index' | 'task_root'
	 * @param {string} ownerKey   composite key identifying the owner
	 * @param {object} node       TreeNode.toJSON() output
	 * @param {string} parentPath current path prefix
	 */
	#writeTree(ownerType, ownerKey, node, parentPath) {
		const nodePath = parentPath === "/" ? `/${node.name}` : `${parentPath}/${node.name}`;

		this.#stmts.putTreeNode.run(
			ownerType, ownerKey, nodePath, node.name, node.type,
			node.hash ?? null, node.integrity ?? null,
			node.lastModified ?? null, node.size ?? null, node.inode ?? null
		);

		// Tags for resource nodes
		if (node.tags) {
			for (const [tagName, tagValue] of Object.entries(node.tags)) {
				this.#stmts.putTreeNodeTag.run(
					ownerType, ownerKey, nodePath, tagName,
					tagValue != null ? String(tagValue) : null);
			}
		}

		// Recurse into children for directory nodes
		if (node.type === "directory" && node.children) {
			for (const child of Object.values(node.children)) {
				this.#writeTree(ownerType, ownerKey, child, nodePath);
			}
		}
	}

	/**
	 * Read flat rows back into a recursive TreeNode-compatible JSON object.
	 *
	 * @param {string} ownerType
	 * @param {string} ownerKey
	 * @returns {object|null}
	 */
	#readTree(ownerType, ownerKey) {
		const rows = this.#stmts.getTreeNodes.all(ownerType, ownerKey);
		if (!rows.length) return null;

		// Collect tags grouped by node_path
		const tagRows = this.#stmts.getTreeNodeTags.all(ownerType, ownerKey);
		const tagsByPath = new Map();
		for (const t of tagRows) {
			let m = tagsByPath.get(t.node_path);
			if (!m) {
				m = Object.create(null);
				tagsByPath.set(t.node_path, m);
			}
			m[t.tag_name] = t.tag_value;
		}

		// Build node lookup by path
		const nodeMap = new Map();
		for (const r of rows) {
			const obj = {
				name: r.name,
				type: r.node_type,
				hash: r.hash,
			};
			if (r.node_type === "resource") {
				obj.integrity = r.integrity;
				obj.lastModified = r.last_modified;
				obj.size = r.size;
				obj.inode = r.inode;
				obj.tags = tagsByPath.get(r.node_path) || null;
			} else {
				obj.children = {};
			}
			nodeMap.set(r.node_path, obj);
		}

		// Link children to parents based on path hierarchy
		let root = null;
		for (const [nodePath, obj] of nodeMap) {
			const parentPath = nodePath.substring(0, nodePath.lastIndexOf("/")) || "/";
			const parent = nodeMap.get(parentPath);
			if (parent && parent !== obj) {
				parent.children[obj.name] = obj;
			} else {
				root = obj;
			}
		}

		return root;
	}

	#deleteTree(ownerType, ownerKey) {
		this.#stmts.delTreeNodeTags.run(ownerType, ownerKey);
		this.#stmts.delTreeNodes.run(ownerType, ownerKey);
	}
}

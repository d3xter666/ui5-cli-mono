import {ClassicLevel} from "classic-level";
import path from "node:path";
import fs from "graceful-fs";

/**
 * Pure-decomposed LevelDB metadata store for the build cache.
 *
 * Every datum is stored as an individual key-value entry with a composite
 * text key. No JSON/MessagePack/binary serialisation is used for structured
 * data.  Reads use range scans (iterator with gte/lte), writes use batch()
 * for atomicity.
 *
 * Key encoding:  <category>!<pk1>!<pk2>!…!<field>
 * Separator:     "!" (exclamation mark)
 * End sentinel:  "\xff" for range scan upper bound
 *
 * Sublevels (built into classic-level) group categories for efficient scans.
 */

const SEP = "!";
const END = "\xff";

function joinKey(...parts) {
	return parts.join(SEP);
}

export default class MetadataStore {
	#db;
	#bm; // build_manifests sublevel
	#ic; // index_cache sublevel
	#rm; // result_metadata sublevel
	#sm; // stage_metadata sublevel
	#tm; // task_metadata sublevel

	/**
	 * Open the LevelDB store. Must be awaited.
	 *
	 * @param {string} cacheDir Versioned cache directory
	 * @returns {Promise<MetadataStore>}
	 */
	static async open(cacheDir) {
		const store = new MetadataStore();
		const dbDir = path.join(cacheDir, "metadata-level");
		fs.mkdirSync(dbDir, {recursive: true});

		store.#db = new ClassicLevel(dbDir, {valueEncoding: "utf8"});
		await store.#db.open();

		const opts = {valueEncoding: "utf8"};
		store.#bm = store.#db.sublevel("bm", opts);
		store.#ic = store.#db.sublevel("ic", opts);
		store.#rm = store.#db.sublevel("rm", opts);
		store.#sm = store.#db.sublevel("sm", opts);
		store.#tm = store.#db.sublevel("tm", opts);

		return store;
	}

	async close() {
		await this.#db.close();
	}

	/* ================================================================== */
	/*  BUILD MANIFESTS                                                    */
	/* ================================================================== */

	async getBuildManifest(projectId, buildSignature) {
		const prefix = joinKey(projectId, buildSignature);
		const entries = await this.#rangeAll(this.#bm, prefix);
		if (!entries.length) return null;

		const fields = new Map(entries);

		const tags = Object.create(null);
		for (const [k, v] of entries) {
			if (k.startsWith(prefix + SEP + "tag" + SEP)) {
				const tagName = k.slice((prefix + SEP + "tag" + SEP).length);
				tags[tagName] = v === "\0" ? null : v;
			}
		}

		return {
			project: {
				specVersion: fields.get(joinKey(prefix, "specVersion")) ?? undefined,
				type: fields.get(joinKey(prefix, "projectType")) ?? undefined,
				metadata: {name: fields.get(joinKey(prefix, "projectName")) ?? undefined},
				resources: {
					configuration: {
						paths: MetadataStore.#buildPaths(fields, prefix),
					},
				},
			},
			buildManifest: {
				manifestVersion: fields.get(joinKey(prefix, "manifestVersion")) ?? undefined,
				timestamp: fields.get(joinKey(prefix, "timestamp")) ?? undefined,
				signature: fields.get(joinKey(prefix, "signature")) ?? undefined,
				versions: MetadataStore.#buildVersions(fields, prefix),
				buildConfig: MetadataStore.#getJSON(fields, joinKey(prefix, "buildConfig")),
				version: fields.get(joinKey(prefix, "version")) ?? undefined,
				namespace: fields.get(joinKey(prefix, "namespace")) ?? undefined,
				tags,
			},
		};
	}

	async putBuildManifest(projectId, buildSignature, data) {
		const prefix = joinKey(projectId, buildSignature);
		const p = data.project;
		const m = data.buildManifest;
		const paths = p.resources?.configuration?.paths || {};
		const v = m.versions || {};

		// Delete old entries first
		await this.#clearRange(this.#bm, prefix);

		const ops = [];
		const put = (field, val) => {
			if (val != null) ops.push({type: "put", key: joinKey(prefix, field), value: String(val)});
		};

		put("specVersion", p.specVersion);
		put("projectType", p.type);
		put("projectName", p.metadata?.name);
		put("pathWebapp", paths.webapp);
		put("pathSrc", paths.src);
		put("pathTest", paths.test);
		put("manifestVersion", m.manifestVersion);
		put("timestamp", m.timestamp);
		put("signature", m.signature);
		put("builderVersion", v.builderVersion);
		put("projectVersion", v.projectVersion);
		put("fsVersion", v.fsVersion);
		if (v.builderFsVersion) put("builderFsVersion", v.builderFsVersion);
		if (m.buildConfig != null) {
			ops.push({type: "put", key: joinKey(prefix, "buildConfig"), value: JSON.stringify(m.buildConfig)});
		}
		put("version", m.version);
		put("namespace", m.namespace);

		if (m.tags) {
			for (const [name, value] of Object.entries(m.tags)) {
				ops.push({type: "put", key: joinKey(prefix, "tag", name), value: value != null ? String(value) : "\0"});
			}
		}

		if (ops.length) await this.#bm.batch(ops);
	}

	static #buildPaths(fields, prefix) {
		const paths = Object.create(null);
		const w = fields.get(joinKey(prefix, "pathWebapp"));
		const s = fields.get(joinKey(prefix, "pathSrc"));
		const t = fields.get(joinKey(prefix, "pathTest"));
		if (w != null) paths.webapp = w;
		if (s != null) paths.src = s;
		if (t != null) paths.test = t;
		return paths;
	}

	static #buildVersions(fields, prefix) {
		const obj = {
			builderVersion: fields.get(joinKey(prefix, "builderVersion")) ?? undefined,
			projectVersion: fields.get(joinKey(prefix, "projectVersion")) ?? undefined,
			fsVersion: fields.get(joinKey(prefix, "fsVersion")) ?? undefined,
		};
		const bf = fields.get(joinKey(prefix, "builderFsVersion"));
		if (bf != null) obj.builderFsVersion = bf;
		return obj;
	}

	static #getJSON(fields, key) {
		const v = fields.get(key);
		if (v == null) return undefined;
		return JSON.parse(v);
	}

	/* ================================================================== */
	/*  INDEX CACHE                                                        */
	/* ================================================================== */

	async getIndexCache(projectId, buildSignature, kind) {
		const prefix = joinKey(projectId, buildSignature, kind);
		const entries = await this.#rangeAll(this.#ic, prefix);
		if (!entries.length) return null;

		const fields = new Map(entries);

		const ts = fields.get(joinKey(prefix, "ts"));
		const tv = fields.get(joinKey(prefix, "tv"));

		// Tasks
		const tasks = [];
		const taskPrefix = joinKey(prefix, "task") + SEP;
		for (const [k, v] of entries) {
			if (k.startsWith(taskPrefix)) {
				const taskName = k.slice(taskPrefix.length);
				tasks.push([taskName, Number(v)]);
			}
		}

		// Tree
		const treePrefix = joinKey(prefix, "tree") + SEP;
		const treeRoot = this.#reconstructTree(entries, treePrefix);

		return {
			indexTimestamp: ts != null ? Number(ts) : undefined,
			indexTree: {version: tv != null ? Number(tv) : 1, root: treeRoot},
			tasks,
		};
	}

	async putIndexCache(projectId, buildSignature, kind, data) {
		const prefix = joinKey(projectId, buildSignature, kind);
		await this.#clearRange(this.#ic, prefix);

		const ops = [];
		ops.push({type: "put", key: joinKey(prefix, "ts"), value: String(data.indexTimestamp)});
		ops.push({type: "put", key: joinKey(prefix, "tv"), value: String(data.indexTree?.version ?? 1)});

		// Tasks
		if (data.tasks) {
			for (const [taskName, supportsDiff] of data.tasks) {
				ops.push({type: "put", key: joinKey(prefix, "task", taskName), value: String(supportsDiff)});
			}
		}

		// Tree
		if (data.indexTree?.root) {
			this.#flattenTree(ops, joinKey(prefix, "tree"), data.indexTree.root, "/");
		}

		if (ops.length) await this.#ic.batch(ops);
	}

	/* ================================================================== */
	/*  RESULT METADATA                                                    */
	/* ================================================================== */

	async getResultMetadata(projectId, buildSignature, stageSignature) {
		const prefix = joinKey(projectId, buildSignature, stageSignature);
		const entries = await this.#rangeAll(this.#rm, prefix);
		if (!entries.length) return null;

		const fields = new Map(entries);

		const stageSignatures = Object.create(null);
		const sigsPrefix = joinKey(prefix, "sig") + SEP;
		for (const [k, v] of entries) {
			if (k.startsWith(sigsPrefix)) {
				stageSignatures[k.slice(sigsPrefix.length)] = v;
			}
		}

		return {
			stageSignatures,
			sourceStageSignature: fields.get(joinKey(prefix, "source")) ?? undefined,
		};
	}

	async putResultMetadata(projectId, buildSignature, stageSignature, data) {
		const prefix = joinKey(projectId, buildSignature, stageSignature);
		await this.#clearRange(this.#rm, prefix);

		const ops = [];
		ops.push({type: "put", key: joinKey(prefix, "source"), value: data.sourceStageSignature});

		if (data.stageSignatures) {
			for (const [name, chain] of Object.entries(data.stageSignatures)) {
				ops.push({type: "put", key: joinKey(prefix, "sig", name), value: chain});
			}
		}

		if (ops.length) await this.#rm.batch(ops);
	}

	/* ================================================================== */
	/*  STAGE METADATA                                                     */
	/* ================================================================== */

	async getStageMetadata(projectId, buildSignature, stageId, stageSignature) {
		const prefix = joinKey(projectId, buildSignature, stageId, stageSignature);
		const entries = await this.#rangeAll(this.#sm, prefix);
		if (!entries.length) return null;

		const fields = new Map(entries);

		const hasMapping = fields.get(joinKey(prefix, "hasMapping")) === "1";

		let resourceMapping;
		let resourceMetadata;

		if (hasMapping) {
			// Multi-reader mapping
			resourceMapping = Object.create(null);
			const mapPrefix = joinKey(prefix, "map") + SEP;
			for (const [k, v] of entries) {
				if (k.startsWith(mapPrefix)) {
					resourceMapping[k.slice(mapPrefix.length)] = Number(v);
				}
			}

			// Group resources by reader index
			const byReader = new Map();
			let maxIdx = 0;
			const resPrefix = joinKey(prefix, "res") + SEP;
			for (const [k, v] of entries) {
				if (k.startsWith(resPrefix)) {
					// key: res!<readerIdx>!<resourcePath>!<field>
					const rest = k.slice(resPrefix.length);
					const firstSep = rest.indexOf(SEP);
					const idx = Number(rest.slice(0, firstSep));
					if (idx > maxIdx) maxIdx = idx;
					const afterIdx = rest.slice(firstSep + 1);
					const lastSep = afterIdx.lastIndexOf(SEP);
					const resPath = afterIdx.slice(0, lastSep);
					const field = afterIdx.slice(lastSep + 1);

					let bucket = byReader.get(idx);
					if (!bucket) {
						bucket = new Map();
						byReader.set(idx, bucket);
					}
					let entry = bucket.get(resPath);
					if (!entry) {
						entry = {};
						bucket.set(resPath, entry);
					}
					entry[field] = field === "integrity" ? v : Number(v);
				}
			}
			// Also check mapping for max index
			for (const v of Object.values(resourceMapping)) {
				if (v > maxIdx) maxIdx = v;
			}

			resourceMetadata = [];
			for (let i = 0; i <= maxIdx; i++) {
				const bucket = byReader.get(i);
				const obj = Object.create(null);
				if (bucket) {
					for (const [resPath, meta] of bucket) {
						obj[resPath] = meta;
					}
				}
				resourceMetadata.push(obj);
			}
		} else {
			// Single reader
			resourceMetadata = Object.create(null);
			const resPrefix = joinKey(prefix, "res") + SEP;
			for (const [k, v] of entries) {
				if (k.startsWith(resPrefix)) {
					// key: res!0!<resourcePath>!<field>
					const rest = k.slice(resPrefix.length);
					const firstSep = rest.indexOf(SEP);
					const afterIdx = rest.slice(firstSep + 1);
					const lastSep = afterIdx.lastIndexOf(SEP);
					const resPath = afterIdx.slice(0, lastSep);
					const field = afterIdx.slice(lastSep + 1);

					if (!resourceMetadata[resPath]) {
						resourceMetadata[resPath] = {};
					}
					resourceMetadata[resPath][field] = field === "integrity" ? v : Number(v);
				}
			}
		}

		// Tag operations
		const projectTagOperations = Object.create(null);
		const buildTagOperations = Object.create(null);
		const tagPrefix = joinKey(prefix, "tagop") + SEP;
		for (const [k, v] of entries) {
			if (k.startsWith(tagPrefix)) {
				// key: tagop!<type>!<resourcePath>!<tagName>
				const rest = k.slice(tagPrefix.length);
				const firstSep = rest.indexOf(SEP);
				const tagType = rest.slice(0, firstSep);
				const afterType = rest.slice(firstSep + 1);
				const lastSep = afterType.lastIndexOf(SEP);
				const resPath = afterType.slice(0, lastSep);
				const tagName = afterType.slice(lastSep + 1);

				const target = tagType === "project" ? projectTagOperations : buildTagOperations;
				if (!target[resPath]) target[resPath] = Object.create(null);
				target[resPath][tagName] = v === "\0" ? null : v;
			}
		}

		const result = {resourceMetadata, projectTagOperations, buildTagOperations};
		if (resourceMapping) result.resourceMapping = resourceMapping;
		return result;
	}

	async putStageMetadata(projectId, buildSignature, stageId, stageSignature, data) {
		const prefix = joinKey(projectId, buildSignature, stageId, stageSignature);
		await this.#clearRange(this.#sm, prefix);

		const ops = [];
		const hasMapping = !!data.resourceMapping;
		ops.push({type: "put", key: joinKey(prefix, "hasMapping"), value: hasMapping ? "1" : "0"});

		// Resource mapping
		if (hasMapping) {
			for (const [virtualPath, readerIdx] of Object.entries(data.resourceMapping)) {
				ops.push({type: "put", key: joinKey(prefix, "map", virtualPath), value: String(readerIdx)});
			}
		}

		// Resources
		if (hasMapping && Array.isArray(data.resourceMetadata)) {
			for (let idx = 0; idx < data.resourceMetadata.length; idx++) {
				const readerMeta = data.resourceMetadata[idx];
				for (const [resPath, meta] of Object.entries(readerMeta)) {
					this.#putResourceFields(ops, joinKey(prefix, "res", String(idx), resPath), meta);
				}
			}
		} else if (data.resourceMetadata && typeof data.resourceMetadata === "object") {
			for (const [resPath, meta] of Object.entries(data.resourceMetadata)) {
				this.#putResourceFields(ops, joinKey(prefix, "res", "0", resPath), meta);
			}
		}

		// Tag operations
		this.#putTagOps(ops, prefix, "project", data.projectTagOperations);
		this.#putTagOps(ops, prefix, "build", data.buildTagOperations);

		if (ops.length) await this.#sm.batch(ops);
	}

	#putResourceFields(ops, keyPrefix, meta) {
		ops.push({type: "put", key: joinKey(keyPrefix, "inode"), value: String(meta.inode)});
		ops.push({type: "put", key: joinKey(keyPrefix, "lastModified"), value: String(meta.lastModified)});
		ops.push({type: "put", key: joinKey(keyPrefix, "size"), value: String(meta.size)});
		ops.push({type: "put", key: joinKey(keyPrefix, "integrity"), value: meta.integrity});
	}

	#putTagOps(ops, prefix, tagType, tagOps) {
		if (!tagOps) return;
		for (const [resPath, tags] of Object.entries(tagOps)) {
			for (const [tagName, tagValue] of Object.entries(tags)) {
				ops.push({
					type: "put",
					key: joinKey(prefix, "tagop", tagType, resPath, tagName),
					value: tagValue != null ? String(tagValue) : "\0",
				});
			}
		}
	}

	/* ================================================================== */
	/*  TASK METADATA                                                      */
	/* ================================================================== */

	async getTaskMetadata(projectId, buildSignature, taskName, type) {
		const prefix = joinKey(projectId, buildSignature, taskName, type);
		const entries = await this.#rangeAll(this.#tm, prefix);
		if (!entries.length) return null;

		const fields = new Map(entries);

		// Graph nodes & requests
		const nodes = [];
		const nodePrefix = joinKey(prefix, "gn") + SEP;
		const reqPrefix = joinKey(prefix, "gr") + SEP;
		const nodeIds = new Set();

		for (const [k, v] of entries) {
			if (k.startsWith(nodePrefix)) {
				// key: gn!<nodeId>!parent
				const rest = k.slice(nodePrefix.length);
				const sep = rest.lastIndexOf(SEP);
				const nodeId = Number(rest.slice(0, sep));
				if (!nodeIds.has(nodeId)) {
					nodeIds.add(nodeId);
					nodes.push({id: nodeId, parent: v === "\0" ? null : Number(v), addedRequests: []});
				}
			}
		}

		// Sort nodes by id for consistency
		nodes.sort((a, b) => a.id - b.id);
		const nodeMap = new Map(nodes.map((n) => [n.id, n]));

		for (const [k, v] of entries) {
			if (k.startsWith(reqPrefix)) {
				// key: gr!<nodeId>!<reqIdx>
				const rest = k.slice(reqPrefix.length);
				const sep = rest.indexOf(SEP);
				const nodeId = Number(rest.slice(0, sep));
				const node = nodeMap.get(nodeId);
				if (node) node.addedRequests.push(v);
			}
		}

		// Root indices
		const rootIndices = [];
		const riPrefix = joinKey(prefix, "ri") + SEP;
		const riNodeIds = new Set();
		for (const [k] of entries) {
			if (k.startsWith(riPrefix)) {
				const rest = k.slice(riPrefix.length);
				const sep = rest.indexOf(SEP);
				const nodeId = Number(rest.slice(0, sep));
				riNodeIds.add(nodeId);
			}
		}

		for (const nodeId of [...riNodeIds].sort((a, b) => a - b)) {
			const riFieldPrefix = joinKey(prefix, "ri", String(nodeId));
			const ts = fields.get(joinKey(riFieldPrefix, "ts"));
			const tv = fields.get(joinKey(riFieldPrefix, "tv"));

			const treePrefix = joinKey(riFieldPrefix, "tree") + SEP;
			const treeRoot = this.#reconstructTree(entries, treePrefix);

			rootIndices.push({
				nodeId,
				resourceIndex: {
					indexTimestamp: ts != null ? Number(ts) : undefined,
					indexTree: {version: tv != null ? Number(tv) : 1, root: treeRoot},
				},
			});
		}

		// Delta indices
		const deltaIndices = [];
		const diPrefix = joinKey(prefix, "di") + SEP;
		const diByNode = new Map();
		for (const [k, v] of entries) {
			if (k.startsWith(diPrefix)) {
				// key: di!<nodeId>!<resIdx>!<field>
				const rest = k.slice(diPrefix.length);
				const firstSep = rest.indexOf(SEP);
				const nodeId = Number(rest.slice(0, firstSep));
				const afterNode = rest.slice(firstSep + 1);
				const secondSep = afterNode.indexOf(SEP);
				const resIdx = Number(afterNode.slice(0, secondSep));
				const field = afterNode.slice(secondSep + 1);

				let nodeEntries = diByNode.get(nodeId);
				if (!nodeEntries) {
					nodeEntries = new Map();
					diByNode.set(nodeId, nodeEntries);
				}
				let entry = nodeEntries.get(resIdx);
				if (!entry) {
					entry = {};
					nodeEntries.set(resIdx, entry);
				}
				entry[field] = field === "integrity" || field === "path" ? v : (v === "\0" ? null : v);
			}
		}

		for (const [nodeId, resMap] of [...diByNode.entries()].sort((a, b) => a[0] - b[0])) {
			const addedResourceIndex = [];
			for (const [, entry] of [...resMap.entries()].sort((a, b) => a[0] - b[0])) {
				const res = {
					path: entry.path,
					integrity: entry.integrity,
					size: entry.size != null ? Number(entry.size) : undefined,
					lastModified: entry.lastModified != null ? Number(entry.lastModified) : undefined,
					inode: entry.inode != null ? Number(entry.inode) : undefined,
				};
				// Tags
				const tags = Object.create(null);
				let hasTags = false;
				for (const [f, fv] of Object.entries(entry)) {
					if (f.startsWith("tag" + SEP)) {
						tags[f.slice(4)] = fv;
						hasTags = true;
					}
				}
				res.tags = hasTags ? tags : null;
				addedResourceIndex.push(res);
			}
			deltaIndices.push({nodeId, addedResourceIndex});
		}

		return {
			requestSetGraph: {nodes, nextId: Number(fields.get(joinKey(prefix, "nextId")))},
			rootIndices,
			deltaIndices,
			unusedAtLeastOnce: fields.get(joinKey(prefix, "unused")) === "1",
		};
	}

	async putTaskMetadata(projectId, buildSignature, taskName, type, data) {
		const prefix = joinKey(projectId, buildSignature, taskName, type);
		await this.#clearRange(this.#tm, prefix);

		const ops = [];

		ops.push({type: "put", key: joinKey(prefix, "nextId"), value: String(data.requestSetGraph.nextId)});
		ops.push({type: "put", key: joinKey(prefix, "unused"), value: data.unusedAtLeastOnce ? "1" : "0"});

		// Graph nodes & requests
		for (const node of data.requestSetGraph.nodes) {
			ops.push({type: "put", key: joinKey(prefix, "gn", String(node.id), "parent"), value: node.parent != null ? String(node.parent) : "\0"});
			for (let i = 0; i < node.addedRequests.length; i++) {
				ops.push({type: "put", key: joinKey(prefix, "gr", String(node.id), String(i)), value: node.addedRequests[i]});
			}
		}

		// Root indices
		for (const ri of data.rootIndices) {
			const riPrefix = joinKey(prefix, "ri", String(ri.nodeId));
			ops.push({type: "put", key: joinKey(riPrefix, "ts"), value: String(ri.resourceIndex.indexTimestamp)});
			ops.push({type: "put", key: joinKey(riPrefix, "tv"), value: String(ri.resourceIndex.indexTree?.version ?? 1)});

			if (ri.resourceIndex.indexTree?.root) {
				this.#flattenTree(ops, joinKey(riPrefix, "tree"), ri.resourceIndex.indexTree.root, "/");
			}
		}

		// Delta indices
		for (const di of data.deltaIndices) {
			for (let i = 0; i < di.addedResourceIndex.length; i++) {
				const res = di.addedResourceIndex[i];
				const resPrefix = joinKey(prefix, "di", String(di.nodeId), String(i));
				ops.push({type: "put", key: joinKey(resPrefix, "path"), value: res.path});
				if (res.integrity != null) {
					ops.push({type: "put", key: joinKey(resPrefix, "integrity"), value: res.integrity});
				}
				if (res.size != null) {
					ops.push({type: "put", key: joinKey(resPrefix, "size"), value: String(res.size)});
				}
				if (res.lastModified != null) {
					ops.push({type: "put", key: joinKey(resPrefix, "lastModified"), value: String(res.lastModified)});
				}
				if (res.inode != null) {
					ops.push({type: "put", key: joinKey(resPrefix, "inode"), value: String(res.inode)});
				}
				if (res.tags) {
					for (const [tagName, tagValue] of Object.entries(res.tags)) {
						ops.push({type: "put", key: joinKey(resPrefix, "tag", tagName), value: tagValue != null ? String(tagValue) : "\0"});
					}
				}
			}
		}

		if (ops.length) await this.#tm.batch(ops);
	}

	/* ================================================================== */
	/*  TREE HELPERS  (materialized-path, decomposed fields)               */
	/* ================================================================== */

	/**
	 * Flatten a recursive TreeNode.toJSON() structure into put operations
	 * using materialized paths.
	 */
	#flattenTree(ops, baseKey, node, parentPath) {
		const nodePath = parentPath === "/" ? `/${node.name}` : `${parentPath}/${node.name}`;
		const nodeKey = joinKey(baseKey, nodePath);

		ops.push({type: "put", key: joinKey(nodeKey, "name"), value: node.name});
		ops.push({type: "put", key: joinKey(nodeKey, "type"), value: node.type});
		if (node.hash != null) {
			ops.push({type: "put", key: joinKey(nodeKey, "hash"), value: node.hash});
		}

		if (node.type === "resource") {
			if (node.integrity != null) {
				ops.push({type: "put", key: joinKey(nodeKey, "integrity"), value: node.integrity});
			}
			if (node.lastModified != null) {
				ops.push({type: "put", key: joinKey(nodeKey, "lastModified"), value: String(node.lastModified)});
			}
			if (node.size != null) {
				ops.push({type: "put", key: joinKey(nodeKey, "size"), value: String(node.size)});
			}
			if (node.inode != null) {
				ops.push({type: "put", key: joinKey(nodeKey, "inode"), value: String(node.inode)});
			}
			if (node.tags) {
				for (const [tagName, tagValue] of Object.entries(node.tags)) {
					ops.push({type: "put", key: joinKey(nodeKey, "tag", tagName), value: tagValue != null ? String(tagValue) : "\0"});
				}
			}
		} else if (node.children) {
			for (const child of Object.values(node.children)) {
				this.#flattenTree(ops, baseKey, child, nodePath);
			}
		}
	}

	/**
	 * Reconstruct a tree from sorted entries that start with treePrefix.
	 * Entries are: <treePrefix><materialized_path>!<field> = value
	 */
	#reconstructTree(entries, treePrefix) {
		// Collect all node paths and their fields
		const nodeFields = new Map(); // nodePath → Map(field → value)

		for (const [k, v] of entries) {
			if (!k.startsWith(treePrefix)) continue;
			const rest = k.slice(treePrefix.length);
			// The field name is after the last SEP. The node path is everything before.
			// We need to distinguish fields from path segments.
			// Fields are: name, type, hash, integrity, lastModified, size, inode, tag!xxx
			// Format: /<path segments>!<field>

			// Find the node path: everything up to the last field component
			// The field is always the final segment, UNLESS it's a tag (tag!tagName)
			const lastSep = rest.lastIndexOf(SEP);
			if (lastSep === -1) continue;

			let nodePath, field;
			const candidate = rest.slice(lastSep + 1);
			const beforeLast = rest.slice(0, lastSep);

			// Check if the segment before candidate is "tag"
			const secondLastSep = beforeLast.lastIndexOf(SEP);
			const parentOfCandidate = secondLastSep !== -1 ? beforeLast.slice(secondLastSep + 1) : beforeLast;

			if (parentOfCandidate === "tag") {
				// This is a tag entry: nodePath!tag!tagName
				const tagSep = beforeLast.lastIndexOf(SEP);
				nodePath = beforeLast.slice(0, tagSep);
				field = "tag" + SEP + candidate;
			} else {
				nodePath = beforeLast;
				field = candidate;
			}

			let fm = nodeFields.get(nodePath);
			if (!fm) {
				fm = new Map();
				nodeFields.set(nodePath, fm);
			}
			fm.set(field, v);
		}

		if (!nodeFields.size) return null;

		// Build node objects
		const nodeMap = new Map();
		for (const [nodePath, fm] of nodeFields) {
			const nodeType = fm.get("type");
			if (!nodeType) continue;

			const obj = {
				name: fm.get("name"),
				type: nodeType,
				hash: fm.get("hash") ?? null,
			};

			if (nodeType === "resource") {
				obj.integrity = fm.get("integrity") ?? undefined;
				obj.lastModified = fm.has("lastModified") ? Number(fm.get("lastModified")) : undefined;
				obj.size = fm.has("size") ? Number(fm.get("size")) : undefined;
				obj.inode = fm.has("inode") ? Number(fm.get("inode")) : undefined;

				// Tags
				const tags = Object.create(null);
				let hasTags = false;
				for (const [f, fv] of fm) {
					if (f.startsWith("tag" + SEP)) {
						tags[f.slice(4)] = fv === "\0" ? null : fv;
						hasTags = true;
					}
				}
				obj.tags = hasTags ? tags : null;
			} else {
				obj.children = {};
			}

			nodeMap.set(nodePath, obj);
		}

		// Link children
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

	/* ================================================================== */
	/*  RANGE HELPERS                                                      */
	/* ================================================================== */

	/**
	 * Read all entries with keys starting with the given prefix.
	 *
	 * @param {object} sub Sublevel
	 * @param {string} prefix Key prefix
	 * @returns {Promise<Array<[string, string]>>}
	 */
	async #rangeAll(sub, prefix) {
		const entries = [];
		const iter = sub.iterator({gte: prefix, lte: prefix + END});
		for await (const [k, v] of iter) {
			entries.push([k, v]);
		}
		return entries;
	}

	/**
	 * Delete all entries with keys starting with the given prefix.
	 *
	 * @param {object} sub Sublevel
	 * @param {string} prefix Key prefix
	 */
	async #clearRange(sub, prefix) {
		await sub.clear({gte: prefix, lte: prefix + END});
	}
}

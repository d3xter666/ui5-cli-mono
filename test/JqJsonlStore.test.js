/**
 * Test for JqJsonlStore - Option L: JSONL + jq streaming reads
 */

import assert from "node:assert";
import path from "node:path";
import fs from "graceful-fs";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import JqJsonlStore from "../packages/project/lib/build/cache/io/JqJsonlStore.js";

const unlink = promisify(fs.unlink);
const readFile = promisify(fs.readFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function cleanup(testPath) {
	try {
		await unlink(`${testPath}.jsonl`);
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
}

async function testBasicOperations() {
	console.log("Test: Basic put/get operations");
	const testPath = path.join(__dirname, "tmp/test-basic");
	await cleanup(testPath);

	const store = new JqJsonlStore(testPath);
	await store.open();

	// Test put and get
	await store.put("key1", {value: "test1"});
	await store.put("key2", "string value");
	await store.put("key3", 12345);

	// Values should be in memory cache
	const val1 = await store.get("key1");
	assert.deepStrictEqual(val1, {value: "test1"}, "Should get object value");

	const val2 = await store.get("key2");
	assert.strictEqual(val2, "string value", "Should get string value");

	const val3 = await store.get("key3");
	assert.strictEqual(val3, 12345, "Should get number value");

	// Test non-existent key
	const missing = await store.get("nonexistent");
	assert.strictEqual(missing, undefined, "Missing key should return undefined");

	await store.close();
	await cleanup(testPath);
	console.log("✓ Basic operations passed");
}

async function testFilePaths() {
	console.log("Test: File path keys (with dots)");
	const testPath = path.join(__dirname, "tmp/test-filepaths");
	await cleanup(testPath);

	const store = new JqJsonlStore(testPath);
	await store.open();

	// These keys should NOT be interpreted as nested paths
	await store.put("node:/path/to/file.js", {resourcePath: "/path/to/file.js"});
	await store.put("node:/another.test.file.txt", {resourcePath: "/another.test.file.txt"});

	const val1 = await store.get("node:/path/to/file.js");
	assert.deepStrictEqual(val1, {resourcePath: "/path/to/file.js"}, "Should handle dots in keys");

	const val2 = await store.get("node:/another.test.file.txt");
	assert.deepStrictEqual(val2, {resourcePath: "/another.test.file.txt"}, "Should handle multiple dots");

	await store.close();
	await cleanup(testPath);
	console.log("✓ File path keys passed");
}

async function testPersistence() {
	console.log("Test: Persistence across store instances");
	const testPath = path.join(__dirname, "tmp/test-persistence");
	await cleanup(testPath);

	// Write some data
	const store1 = new JqJsonlStore(testPath);
	await store1.open();
	await store1.put("persistent-key", {data: "should survive"});
	await store1.flush(); // Explicitly flush to disk
	await store1.close();

	// Open new instance and verify data is still there
	const store2 = new JqJsonlStore(testPath);
	await store2.open();
	const val = await store2.get("persistent-key");
	assert.deepStrictEqual(val, {data: "should survive"}, "Data should persist across instances");
	await store2.close();

	await cleanup(testPath);
	console.log("✓ Persistence passed");
}

async function testDelete() {
	console.log("Test: Delete operation");
	const testPath = path.join(__dirname, "tmp/test-delete");
	await cleanup(testPath);

	const store = new JqJsonlStore(testPath);
	await store.open();

	await store.put("to-delete", "value");
	assert.strictEqual(await store.get("to-delete"), "value");

	await store.delete("to-delete");
	assert.strictEqual(await store.get("to-delete"), undefined, "Deleted key should return undefined");

	// Verify keys() excludes deleted
	const keys = await store.keys();
	assert(!keys.includes("to-delete"), "Deleted key should not appear in keys()");

	await store.close();
	await cleanup(testPath);
	console.log("✓ Delete passed");
}

async function testIterator() {
	console.log("Test: Entries iterator");
	const testPath = path.join(__dirname, "tmp/test-iterator");
	await cleanup(testPath);

	const store = new JqJsonlStore(testPath);
	await store.open();

	await store.put("a", 1);
	await store.put("b", 2);
	await store.put("c", 3);
	await store.delete("b");

	const entries = [];
	for await (const entry of store.entries()) {
		entries.push(entry);
	}

	assert.strictEqual(entries.length, 2, "Should have 2 entries (excluding deleted)");
	assert(entries.some((e) => e.key === "a" && e.value === 1), "Should have entry a");
	assert(entries.some((e) => e.key === "c" && e.value === 3), "Should have entry c");

	await store.close();
	await cleanup(testPath);
	console.log("✓ Iterator passed");
}

async function testJsonlFormat() {
	console.log("Test: JSONL file format");
	const testPath = path.join(__dirname, "tmp/test-format");
	await cleanup(testPath);

	const store = new JqJsonlStore(testPath);
	await store.open();

	await store.put("key1", "value1");
	await store.put("key2", {nested: true});
	await store.flush();

	// Read raw file to verify format
	const content = await readFile(`${testPath}.jsonl`, "utf8");
	const lines = content.trim().split("\n");

	assert.strictEqual(lines.length, 2, "Should have 2 lines");

	for (const line of lines) {
		const parsed = JSON.parse(line);
		assert("k" in parsed, "Each line should have key 'k'");
		assert("v" in parsed, "Each line should have value 'v'");
		assert("d" in parsed, "Each line should have deleted flag 'd'");
		assert("t" in parsed, "Each line should have timestamp 't'");
	}

	await store.close();
	await cleanup(testPath);
	console.log("✓ JSONL format passed");
}

async function testOverwrite() {
	console.log("Test: Overwrite value");
	const testPath = path.join(__dirname, "tmp/test-overwrite");
	await cleanup(testPath);

	const store = new JqJsonlStore(testPath);
	await store.open();

	await store.put("key", "initial");
	await store.flush();
	await store.put("key", "updated");
	await store.flush();

	const val = await store.get("key");
	assert.strictEqual(val, "updated", "Should return latest value");

	// Close and reopen to test persistence
	await store.close();

	const store2 = new JqJsonlStore(testPath);
	await store2.open();
	const val2 = await store2.get("key");
	assert.strictEqual(val2, "updated", "Should return latest value after reopen");

	await store2.close();
	await cleanup(testPath);
	console.log("✓ Overwrite passed");
}

async function testJqReading() {
	console.log("Test: jq streaming read");
	const testPath = path.join(__dirname, "tmp/test-jq");
	await cleanup(testPath);

	const store = new JqJsonlStore(testPath);
	await store.open();

	// Write many entries to make jq worthwhile
	for (let i = 0; i < 100; i++) {
		await store.put(`key-${i}`, {index: i, data: `value-${i}`});
	}
	await store.flush();

	// Clear in-memory cache by creating new instance
	await store.close();

	const store2 = new JqJsonlStore(testPath);
	await store2.open();

	// Read should use jq if available
	const val50 = await store2.get("key-50");
	assert.deepStrictEqual(val50, {index: 50, data: "value-50"}, "Should read correct value via jq");

	const val99 = await store2.get("key-99");
	assert.deepStrictEqual(val99, {index: 99, data: "value-99"}, "Should read last value via jq");

	await store2.close();
	await cleanup(testPath);
	console.log("✓ jq streaming read passed");
}

// Run all tests
async function main() {
	console.log("=== JqJsonlStore Tests (Option L) ===\n");

	try {
		await testBasicOperations();
		await testFilePaths();
		await testPersistence();
		await testDelete();
		await testIterator();
		await testJsonlFormat();
		await testOverwrite();
		await testJqReading();

		console.log("\n✅ All tests passed!");
	} catch (error) {
		console.error("\n❌ Test failed:", error);
		process.exit(1);
	}
}

main();

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const dataPath = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
if (!dataPath) {
	console.error("Usage: node scripts/cleanup-operations.mjs path/to/data.json [--dry-run]");
	process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const ignoredSegments = new Set([
	".git",
	".obsidian",
	".trash",
	".claude",
	".claudian",
	"node_modules",
	"credentials",
	"__pycache__",
	"venv",
	".venv",
	"env",
]);
const sensitivePathPattern =
	/(^|[\/._ -])(api[-_ ]?key|apikey|secret|token|credential)([\/._ -]|$)/i;

const isIgnoredPath = (filePath) => {
	const normalized = String(filePath || "").replace(/^\/+|\/+$/g, "");
	if (!normalized) return false;
	const segments = normalized.split("/");
	return (
		segments.some((segment) => ignoredSegments.has(segment)) ||
		segments.some(
			(segment) => segment === ".DS_Store" || /^\.env($|\.)/.test(segment)
		) ||
		sensitivePathPattern.test(normalized)
	);
};

const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const operations =
	data.operations && typeof data.operations === "object" && !Array.isArray(data.operations)
		? data.operations
		: {};
const before = Object.keys(operations).length;
let removed = 0;

for (const operationPath of Object.keys(operations)) {
	if (!isIgnoredPath(operationPath)) continue;
	removed++;
	if (!dryRun) delete operations[operationPath];
}

if (!dryRun && removed) {
	fs.writeFileSync(path.resolve(dataPath), `${JSON.stringify(data, null, 2)}\n`);
}

console.log(
	JSON.stringify(
		{
			dryRun,
			before,
			removed,
			after: dryRun ? before : Object.keys(operations).length,
		},
		null,
		2
	)
);

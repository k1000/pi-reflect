#!/usr/bin/env bun
/**
 * @sherpa-purpose Check Pi Reflect extension bundle and project-local store health
 * @sherpa-timeout 120000
 * @sherpa-side-effects none
 * @sherpa-safe true
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReflectionStore } from "../store.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const reflectDir = path.resolve(__dirname, "..");
const cwd = process.env.REFLECT_CHECK_CWD || process.cwd();

function run(command: string[], cwd = reflectDir) {
	const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
	if (result.exitCode !== 0) process.exit(result.exitCode);
}

if (!existsSync(path.join(reflectDir, "index.ts"))) {
	throw new Error(`Reflect extension index.ts not found: ${reflectDir}`);
}

console.log("▶ bundle check");
run([
	"bun",
	"build",
	path.join(reflectDir, "index.ts"),
	"--target=node",
	"--format=esm",
	"--external=@mariozechner/pi-ai",
	"--external=@mariozechner/pi-coding-agent",
	"--external=@mariozechner/pi-tui",
	"--external=@sinclair/typebox",
	"--outfile=/tmp/pi-reflect-check.mjs",
]);

console.log("\n▶ store doctor");
const store = new ReflectionStore(cwd);
const normalized = store.normalizeStore();
const report = store.doctor();
console.log(JSON.stringify({ cwd, normalized, report }, null, 2));

if (report.duplicateIds.length > 0) throw new Error(`Duplicate reflection IDs: ${report.duplicateIds.join(", ")}`);
if (report.missingBody > 0) throw new Error(`Reflection rows missing body+summary: ${report.missingBody}`);
if (report.highValueNotQueued > 0) throw new Error(`High-value reflections not queued to Archivist: ${report.highValueNotQueued}`);

console.log("\n✅ Pi Reflect extension checks passed");

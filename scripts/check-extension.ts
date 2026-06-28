#!/usr/bin/env bun
/**
 * @sherpa-purpose Check Pi Reflect extension bundle and project-local store health
 * @sherpa-timeout 120000
 * @sherpa-side-effects none
 * @sherpa-safe true
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

function generatedScripts(projectRoot: string): string[] {
	const dir = path.join(projectRoot, "scripts", "reflect-automations");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".sh"))
		.map((name) => path.join(dir, name))
		.filter((file) => statSync(file).isFile());
}

function reflectPackageScripts(projectRoot: string): Array<{ name: string; command: string; target: string; exists: boolean }> {
	const packageJson = path.join(projectRoot, "package.json");
	if (!existsSync(packageJson)) return [];
	const parsed = JSON.parse(readFileSync(packageJson, "utf8"));
	const scripts = parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts as Record<string, string> : {};
	return Object.entries(scripts)
		.filter(([name]) => name.startsWith("reflect:"))
		.map(([name, command]) => {
			const match = command.match(/^bash\s+(.+)$/);
			const target = match ? path.resolve(projectRoot, match[1]!) : "";
			return { name, command, target, exists: Boolean(target && existsSync(target)) };
		});
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

console.log("\n▶ automation doctor");
const automationScripts = generatedScripts(cwd);
const packageScripts = reflectPackageScripts(cwd);
const brokenPackageScripts = packageScripts.filter((script) => !script.exists);
console.log(JSON.stringify({
	generatedScripts: automationScripts.map((file) => path.relative(cwd, file).replace(/\\/g, "/")),
	reflectPackageScripts: packageScripts.map((script) => ({ name: script.name, command: script.command, exists: script.exists })),
	brokenPackageScripts,
}, null, 2));
if (brokenPackageScripts.length > 0) {
	throw new Error(`Broken reflect package scripts: ${brokenPackageScripts.map((script) => script.name).join(", ")}`);
}

console.log("\n✅ Pi Reflect extension checks passed");

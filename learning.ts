import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { checkAutoDistill, markAutoDistillRun, prepareDistillPayloads } from "./auto-distill.ts";
import { enqueueArchivistDistill, enqueueArchivistPreserve, shouldPreserveReflection } from "./archivist.ts";
import { createAutomationState, updateAutomationCandidates, type AutomationState } from "./automation.ts";
import { ReflectionStore } from "./store.ts";

const execFileAsync = promisify(execFile);

type TaskOutcome = "completed" | "partial" | "blocked" | "failed" | "reverted" | "unknown";

type SherpaMemoryConfig = {
	scratchpadPath: string;
};

export type ReflectLearningState = {
	automation: AutomationState;
};

export function createReflectLearningState(): ReflectLearningState {
	return { automation: createAutomationState() };
}

export function applyPersistedReflectLearningState(state: ReflectLearningState, data: unknown): void {
	if (!data || typeof data !== "object") return;
	const record = data as Partial<ReflectLearningState>;
	state.automation = { ...state.automation, ...(record.automation ?? {}) };
}

export function serializeReflectLearningState(state: ReflectLearningState): ReflectLearningState {
	return state;
}

function readJsonFile(filePath: string): Record<string, unknown> | undefined {
	if (!existsSync(filePath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function readSherpaMemoryConfig(cwd: string): SherpaMemoryConfig {
	const defaults: SherpaMemoryConfig = {
		scratchpadPath: ".pi-memory/scratchpad",
	};

	const globalPatch = readJsonFile(path.join(homedir(), ".pi", "sherpa.config.json"));
	const projectPatch = readJsonFile(path.join(cwd, ".pi", "sherpa.config.json"));
	const globalMemory = (globalPatch?.memory && typeof globalPatch.memory === "object") ? globalPatch.memory as Partial<SherpaMemoryConfig> : {};
	const projectMemory = (projectPatch?.memory && typeof projectPatch.memory === "object") ? projectPatch.memory as Partial<SherpaMemoryConfig> : {};

	return { ...defaults, ...globalMemory, ...projectMemory };
}

function scratchpadRootPath(cwd: string): string {
	const memory = readSherpaMemoryConfig(cwd);
	return path.isAbsolute(memory.scratchpadPath)
		? memory.scratchpadPath
		: path.join(cwd, memory.scratchpadPath);
}

function stringifyForLearning(messages: unknown[]): string {
	return messages.map((message) => {
		try {
			return typeof message === "string" ? message : JSON.stringify(message);
		} catch {
			return String(message);
		}
	}).join("\n");
}

function classifyTaskOutcome(text: string): { outcome: TaskOutcome; reason: string } {
	const lower = text.toLowerCase();
	const tail = lower.slice(-2500);
	const normalized = tail.replace(/\b0\s+(failed|failures?|errors?)\b/g, "zero test issues");

	if (/\b(revert(ed)?|rolled back|rollback|discarded changes)\b/.test(tail)) return { outcome: "reverted", reason: "revert/rollback signal detected" };
	if (/\b(blocked|cannot proceed|waiting on|needs approval|missing credentials|permission denied)\b/.test(tail)) return { outcome: "blocked", reason: "blocked/waiting signal detected" };

	const completionSignal = /\b(done|completed|implemented|fixed|resolved|verified|successfully|tests? pass(?:ed)?|all tests pass|bun test[^\n]*(?:pass|passed)|\d+\s+pass(?:ed)?)\b/.test(normalized);
	const explicitFailure = /\b(typecheck failed|tests failed|test failed|exit code [1-9]|could not|not fixed|still failing|failed to fix|unable to|crash(?:ed)?|fatal)\b/.test(normalized);

	if (explicitFailure && !completionSignal) return { outcome: "failed", reason: "explicit final failure signal detected" };
	if (/\b(partial|in progress|remaining|todo|follow[- ]?up|next steps?)\b/.test(tail) && !completionSignal) return { outcome: "partial", reason: "partial/follow-up signal detected" };
	if (completionSignal) return { outcome: "completed", reason: "completion/verification signal detected" };
	if (/\b(error|exception)\b/.test(normalized)) return { outcome: "partial", reason: "error/debug signal without final failure" };
	return { outcome: "unknown", reason: "no strong lifecycle signal detected" };
}

function parseGitStatusFiles(status: string): string[] {
	const files: string[] = [];
	for (const line of status.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const raw = line.slice(3).trim();
		const file = (raw.includes(" -> ") ? raw.split(" -> ").pop()!.trim() : raw).replace(/^"|"$/g, "");
		if (file) files.push(file);
	}
	return [...new Set(files)];
}

async function gitChanged(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd, timeout: 5_000, maxBuffer: 500_000 });
		return stdout;
	} catch {
		return "";
	}
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "reflection-skill";
}

function registerPackageScript(cwd: string, scriptPath: string, title: string): string | null {
	const packageJsonPath = path.join(cwd, "package.json");
	if (!existsSync(packageJsonPath)) return null;
	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		const scripts = parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
		const scriptName = `reflect:${slug(title).slice(0, 40)}`;
		const rel = path.relative(cwd, scriptPath).replace(/\\/g, "/");
		scripts[scriptName] = `bash ${rel}`;
		parsed.scripts = scripts;
		writeFileSync(packageJsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
		return scriptName;
	} catch {
		return null;
	}
}

function automationScriptContent(candidate: ReturnType<typeof updateAutomationCandidates>[number]): string {
	return [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		"",
		`# Generated by pi-reflect from repeated workflow observation.`,
		`# @sherpa-purpose ${candidate.title}`,
		`# @sherpa-safe ${candidate.safety === "safe" ? "true" : "false"}`,
		`# @sherpa-side-effects ${candidate.safety === "safe" ? "none" : "unknown"}`,
		`# Title: ${candidate.title}`,
		`# Safety: ${candidate.safety}`,
		`# Confidence: ${candidate.confidence}`,
		`# Original command: ${candidate.command}`,
		"",
		candidate.safety === "needs-approval"
			? "echo 'Note: this command can have external or persistent side effects. Running because user opted into automation.' >&2"
			: "",
		candidate.command,
		"",
	].filter(Boolean).join("\n");
}

async function captureAutomationCandidates(state: ReflectLearningState, store: ReflectionStore, cwd: string, recentText: string): Promise<number> {
	const candidates = updateAutomationCandidates(state.automation, recentText, 3, cwd);
	for (const candidate of candidates) {
		const scriptPath = path.join(cwd, "scripts", "reflect-automations", `${slug(candidate.title)}-${candidate.hash}.sh`);
		const packageScript = registerPackageScript(cwd, scriptPath, candidate.title);
		const entry = await store.save({
			type: "automation",
			title: candidate.title,
			content: candidate.markdown,
			importance: candidate.safety === "safe" ? "medium" : "low",
			tags: ["auto-captured", "automation-candidate", candidate.safety, "auto-script"],
			context: `Repeated command detected ${candidate.count} times in session/tool history.`,
			evidence: candidate.command,
			application: `Auto-created script for repeated workflow: scripts/reflect-automations/${slug(candidate.title)}-${candidate.hash}.sh${packageScript ? `; package script: ${packageScript}` : ""}`,
			mode: "execute",
			confidence: candidate.confidence,
			target: {
				targetType: "user_script",
				targetPath: scriptPath,
				action: "update",
				executable: true,
				fileContent: automationScriptContent(candidate),
			},
		}, "auto-automation");
		if (shouldPreserveReflection(entry)) {
			const item = enqueueArchivistPreserve(cwd, entry, store.getContent(entry) ?? undefined);
			store.markArchivistQueued(entry.id, item.id);
		}
	}
	return candidates.length;
}

async function autoDistillScratchpad(store: ReflectionStore, cwd: string, outcome: { outcome: TaskOutcome; reason: string }, changedFiles: string[]): Promise<number> {
	const scratchpadRoot = scratchpadRootPath(cwd);
	const check = checkAutoDistill({ outcome: outcome.outcome, changedFiles: changedFiles.length, hasDistillCandidates: true }, {
		scratchpadRoot,
		minChangedFiles: 3,
		enabled: true,
	});
	if (!check.shouldTrigger) return 0;

	const payloads = prepareDistillPayloads(check.newCandidates);
	const queued = payloads.map((payload) => enqueueArchivistDistill(cwd, payload));

	const entry = await store.save({
		type: "knowledge",
		title: "Queued scratchpad candidates for Archivist distillation",
		content: [
			`Reason: ${check.reason}`,
			`Outcome: ${outcome.outcome} (${outcome.reason})`,
			`Changed files: ${changedFiles.length}`,
			"",
			"Queued Archivist requests:",
			...queued.map((item, index) => `${index + 1}. ${item.id} (${item.kind})`),
			"",
			"No Obsidian files were written directly by reflect; Archivist/Inquirer must perform durable memory writes.",
		].join("\n"),
		importance: "medium",
		tags: ["auto-captured", "auto-distill", "scratchpad", "archivist-outbox"],
		context: payloads.map((payload) => `- ${payload.task} (${payload.domain})`).join("\n"),
	}, "auto-distill");
	const preserveItem = enqueueArchivistPreserve(cwd, entry, store.getContent(entry) ?? undefined);
	store.markArchivistQueued(entry.id, preserveItem.id);

	markAutoDistillRun(scratchpadRoot);
	return queued.length;
}

export async function runPostTaskLearning(ctx: ExtensionContext, state: ReflectLearningState, recentMessages: unknown[]): Promise<void> {
	const cwd = ctx.cwd;
	const store = new ReflectionStore(cwd);
	const recentText = stringifyForLearning(recentMessages);
	const automationCount = await captureAutomationCandidates(state, store, cwd, recentText);
	const outcome = classifyTaskOutcome(recentText);
	const changedFiles = parseGitStatusFiles(await gitChanged(cwd));
	const distillCount = await autoDistillScratchpad(store, cwd, outcome, changedFiles);

	if (ctx.hasUI && (automationCount > 0 || distillCount > 0)) {
		const parts = [];
		if (automationCount > 0) parts.push(`${automationCount} automation candidate(s)`);
		if (distillCount > 0) parts.push(`${distillCount} distilled artifact(s)`);
		try { ctx.ui.notify(`Reflect captured ${parts.join(" and ")}`, "info"); } catch {}
	}
}

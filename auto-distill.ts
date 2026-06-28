/**
 * Auto-distillation on task end.
 *
 * Reflection owns this because distillation is write-side learning from session
 * residue, not retrieval context selection.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type DistillTrigger = {
	outcome: string;
	changedFiles: number;
	hasDistillCandidates: boolean;
};

export type AutoDistillConfig = {
	scratchpadRoot: string;
	minChangedFiles?: number;
	enabled?: boolean;
	suppressMarkerPath?: string;
};

const DEFAULT_MIN_CHANGED_FILES = 3;

function lastDistillMarkerPath(root: string): string {
	return path.join(root, "last-auto-distill.txt");
}

function getLastDistillRun(root: string): string | null {
	const p = lastDistillMarkerPath(root);
	if (!existsSync(p)) return null;
	return readFileSync(p, "utf8").trim() || null;
}

export function markAutoDistillRun(root: string): void {
	const dir = path.dirname(lastDistillMarkerPath(root));
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(lastDistillMarkerPath(root), new Date().toISOString(), "utf8");
}

function isSuppressed(root: string, config: AutoDistillConfig): boolean {
	const p = config.suppressMarkerPath ?? path.join(root, ".auto-distill-mode");
	if (!existsSync(p)) return false;
	const content = readFileSync(p, "utf8").trim().toUpperCase();
	return content.includes("AUTO_DISTILL_OFF");
}

function distillCandidatesPath(root: string): string {
	return path.join(root, "sections", "distill_candidate.md");
}

function readNewCandidates(root: string, since: string | null): string[] {
	const p = distillCandidatesPath(root);
	if (!existsSync(p)) return [];

	const content = readFileSync(p, "utf8");
	const entries = content.split(/\n(?=###)/).map((entry) => entry.trim()).filter((entry) => entry.startsWith("###"));

	if (!since) return entries;

	const newEntries: string[] = [];
	for (const entry of entries) {
		const tsMatch = entry.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
		if (tsMatch && tsMatch[1]! >= since.slice(0, 16)) {
			newEntries.push(entry);
		}
	}
	return newEntries;
}

function detectDomain(text: string): string {
	const lower = text.toLowerCase();

	const domainPatterns: Array<[RegExp, string]> = [
		[/\b(typescript|javascript|ts|js|node|bun|deno)\b/, "typescript"],
		[/\b(python|pytest|pip|uv|django|fastapi|flask)\b/, "python"],
		[/\b(trading|strategy|backtest|grid|bot|order|position|portfolio)\b/, "trading"],
		[/\b(react|vue|svelte|angular|css|html|frontend|ui|component)\b/, "frontend"],
		[/\b(sql|postgres|mysql|sqlite|database|schema|migration|query)\b/, "database"],
		[/\b(docker|kubernetes|k8s|deploy|ci|cd|github.actions)\b/, "devops"],
		[/\b(sherpa|archivist|pi.agent|extension|tool|reflect|reflection)\b/, "ai-agents"],
		[/\b(crypto|ethereum|solana|web3|smart.contract|defi)\b/, "blockchain"],
		[/\b(rust|cargo|crates|unsafe|trait|impl)\b/, "rust"],
		[/\b(go|golang|goroutine|channel|interface)\b/, "go"],
		[/\b(machine.learning|deep.learning|llm|model|training|inference)\b/, "ai"],
		[/\b(api|rest|graphql|grpc|endpoint|route|middleware)\b/, "api"],
	];

	for (const [pattern, domain] of domainPatterns) {
		if (pattern.test(lower)) return domain;
	}

	return "general";
}

export function checkAutoDistill(
	trigger: DistillTrigger,
	config: AutoDistillConfig,
): { shouldTrigger: boolean; reason: string; newCandidates: string[] } {
	if (config.enabled === false) {
		return { shouldTrigger: false, reason: "auto-distill disabled", newCandidates: [] };
	}

	if (isSuppressed(config.scratchpadRoot, config)) {
		return { shouldTrigger: false, reason: "suppressed by .auto-distill-mode", newCandidates: [] };
	}

	const minFiles = config.minChangedFiles ?? DEFAULT_MIN_CHANGED_FILES;

	if (trigger.outcome !== "completed") {
		return { shouldTrigger: false, reason: `outcome is '${trigger.outcome}', not 'completed'`, newCandidates: [] };
	}

	if (trigger.changedFiles < minFiles) {
		return { shouldTrigger: false, reason: `only ${trigger.changedFiles} files changed, need ${minFiles}`, newCandidates: [] };
	}

	const lastRun = getLastDistillRun(config.scratchpadRoot);
	const newCandidates = readNewCandidates(config.scratchpadRoot, lastRun);

	if (newCandidates.length === 0) {
		return { shouldTrigger: false, reason: "no new distill candidates since last run", newCandidates: [] };
	}

	return {
		shouldTrigger: true,
		reason: `${newCandidates.length} new distill candidate(s) after completed task with ${trigger.changedFiles} file changes`,
		newCandidates,
	};
}

export function prepareDistillPayloads(
	newCandidates: string[],
): Array<{
	trigger: string;
	task: string;
	outcome: string;
	context: string;
	domain: string;
}> {
	return newCandidates.map((entry) => {
		const titleMatch = entry.match(/###\s+(.+)/);
		const title = titleMatch?.[1]?.trim() ?? "Auto-distilled task";
		const body = entry.replace(/^###\s+.*\n/, "").trim();
		const domain = detectDomain(entry);

		return {
			trigger: "auto-distill",
			task: title,
			outcome: body.length > 200 ? body.slice(0, 200) + "..." : body,
			context: body,
			domain,
		};
	});
}

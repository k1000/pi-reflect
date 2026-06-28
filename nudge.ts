import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type NudgeTarget = "observation" | "distill_candidate";
export const NUDGE_TARGETS: NudgeTarget[] = ["observation", "distill_candidate"];

export type NudgeResult = {
	written: boolean;
	deduped: boolean;
	nearDuplicate: boolean;
	capacityWarning: string | null;
	autoCompacted: boolean;
	path: string;
	entryCount: number;
	usagePercent: number;
};

export type NudgeConfig = {
	scratchpadRoot: string;
	warnThresholdBytes?: number;
	compactThresholdBytes?: number;
	compactTargetBytes?: number;
	digestPath?: string;
};

const DEFAULT_WARN_THRESHOLD = 80_000;
const DEFAULT_COMPACT_THRESHOLD = 95_000;
const DEFAULT_COMPACT_TARGET = 40_000;

function sectionPath(root: string, target: NudgeTarget): string {
	return path.join(root, "sections", `${target}.md`);
}

function digestPath(root: string, configuredPath?: string): string {
	return configuredPath ? path.resolve(root, configuredPath) : path.join(root, "nudge-digest.jsonl");
}

function computeDigest(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function loadDigests(root: string, configuredPath?: string): Set<string> {
	const dp = digestPath(root, configuredPath);
	if (!existsSync(dp)) return new Set();
	return new Set(readFileSync(dp, "utf8").split(/\r?\n/).filter(Boolean).slice(-500).map((line) => {
		try { return JSON.parse(line).digest as string; }
		catch { return ""; }
	}).filter(Boolean));
}

function recordDigest(root: string, digest: string, configuredPath?: string): void {
	const dp = digestPath(root, configuredPath);
	mkdirSync(path.dirname(dp), { recursive: true });
	appendFileSync(dp, JSON.stringify({ digest, ts: new Date().toISOString() }) + "\n", "utf8");
}

function readSectionEntries(root: string, target: NudgeTarget): string[] {
	const sp = sectionPath(root, target);
	if (!existsSync(sp)) return [];
	const body = readFileSync(sp, "utf8").trim().replace(/^#.*\n/, "").trim();
	return body.split(/\n(?=###|## |\d{4}-\d{2}-\d{2})/).filter(Boolean);
}

function tokenOverlapSimilarity(a: string, b: string): number {
	const tokensA = new Set(a.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
	const tokensB = new Set(b.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
	if (!tokensA.size && !tokensB.size) return 1;
	if (!tokensA.size || !tokensB.size) return 0;
	let intersection = 0;
	for (const token of tokensA) if (tokensB.has(token)) intersection++;
	const union = tokensA.size + tokensB.size - intersection;
	return union > 0 ? intersection / union : 0;
}

function contentHasNearDuplicate(root: string, target: NudgeTarget, content: string): boolean {
	for (const entry of readSectionEntries(root, target).slice(-20)) {
		const entryText = entry.replace(/^###\s+.*\n/, "").replace(/^-{3,}/, "").trim();
		if (entryText && tokenOverlapSimilarity(content, entryText) >= 0.8) return true;
	}
	return false;
}

function compactNudgeSection(root: string, target: NudgeTarget, sp: string, compactTarget: number): boolean {
	const archiveDir = path.join(root, "archive");
	mkdirSync(archiveDir, { recursive: true });
	const entries = readSectionEntries(root, target);
	const kept: string[] = [];
	let keptSize = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		const entrySize = Buffer.byteLength(entry, "utf8");
		if (keptSize + entrySize <= compactTarget || kept.length === 0) {
			kept.unshift(entry);
			keptSize += entrySize;
			if (keptSize > compactTarget) break;
		} else break;
	}
	const archiveStamp = new Date().toISOString().replace(/[:.]/g, "-");
	const archivePath = path.join(archiveDir, `${archiveStamp}-${target}-nudge-archive.md`);
	const archived = entries.slice(0, entries.length - kept.length);
	if (archived.length > 0) writeFileSync(archivePath, `# Archived ${target} entries — ${archiveStamp}\n\n${archived.join("\n\n---\n\n")}\n`, "utf8");
	writeFileSync(sp, `# ${target} — compacted\n\nOlder entries archived to \`archive/${path.basename(archivePath)}\`.\n\n${kept.join("\n\n")}`, "utf8");
	return true;
}

export function writeNudge(target: NudgeTarget, content: string, config: NudgeConfig, options?: { dedupKey?: string; skipDedup?: boolean }): NudgeResult {
	const root = config.scratchpadRoot;
	const sectionsDir = path.join(root, "sections");
	mkdirSync(sectionsDir, { recursive: true });
	const sp = sectionPath(root, target);
	const warnBytes = config.warnThresholdBytes ?? DEFAULT_WARN_THRESHOLD;
	const currentSize = existsSync(sp) ? statSync(sp).size : 0;
	const digest = computeDigest(options?.dedupKey ? `${content}||${options.dedupKey}` : content);
	const usagePercent = Math.round((currentSize / warnBytes) * 100);
	if (!options?.skipDedup && loadDigests(root, config.digestPath).has(digest)) {
		return { written: false, deduped: true, nearDuplicate: false, capacityWarning: null, autoCompacted: false, path: sp, entryCount: Math.max(1, readSectionEntries(root, target).length), usagePercent };
	}
	const nearDuplicate = !options?.skipDedup && contentHasNearDuplicate(root, target, content);
	const newSize = currentSize + Buffer.byteLength(content, "utf8");
	const capacityWarning = newSize < warnBytes ? null : `Section at ${Math.round((newSize / warnBytes) * 100)}% capacity (${Math.round(newSize / 1024)}KB/${Math.round(warnBytes / 1024)}KB). Consider consolidating.`;
	const autoCompacted = newSize >= (config.compactThresholdBytes ?? DEFAULT_COMPACT_THRESHOLD)
		? compactNudgeSection(root, target, sp, config.compactTargetBytes ?? DEFAULT_COMPACT_TARGET)
		: false;
	appendFileSync(sp, `\n\n### Nudge — ${new Date().toISOString()}\n\n${content.trim()}`, "utf8");
	if (!options?.skipDedup) recordDigest(root, digest, config.digestPath);
	return { written: true, deduped: false, nearDuplicate, capacityWarning, autoCompacted, path: sp, entryCount: Math.max(1, readSectionEntries(root, target).length), usagePercent: Math.round((newSize / warnBytes) * 100) };
}

export function readNudges(root: string, query: string, limit = 10): Array<{ target: NudgeTarget; title: string; body: string; sourcePath: string }> {
	const q = query.toLowerCase();
	return NUDGE_TARGETS.flatMap((target) => {
		const sourcePath = sectionPath(root, target);
		return readSectionEntries(root, target).map((entry) => ({ target, title: entry.match(/^###\s+(.+)/)?.[1]?.trim() ?? target, body: entry, sourcePath }));
	})
		.filter((entry) => entry.title.toLowerCase().includes(q) || entry.body.toLowerCase().includes(q))
		.slice(0, Math.max(1, Math.min(100, limit)));
}

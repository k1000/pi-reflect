import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ReflectionEntry } from "./store.ts";
import type { DistillInput } from "./distillation.ts";

export type ArchivistOutboxKind = "preserve" | "distill";

export type ArchivistOutboxItem = {
	id: string;
	kind: ArchivistOutboxKind;
	createdAt: string;
	cwd: string;
	payload: Record<string, unknown>;
	status: "queued";
};

function outboxPath(cwd: string): string {
	return path.join(cwd, ".pi", "reflect", "archivist-outbox.jsonl");
}

function appendOutbox(cwd: string, kind: ArchivistOutboxKind, payload: Record<string, unknown>): ArchivistOutboxItem {
	const createdAt = new Date().toISOString();
	const item: ArchivistOutboxItem = {
		id: `archivist_${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}_${Math.random().toString(16).slice(2, 8)}`,
		kind,
		createdAt,
		cwd,
		payload,
		status: "queued",
	};
	const file = outboxPath(cwd);
	mkdirSync(path.dirname(file), { recursive: true });
	appendFileSync(file, JSON.stringify(item) + "\n", "utf8");
	return item;
}

export function enqueueArchivistPreserve(cwd: string, entry: ReflectionEntry, content?: string): ArchivistOutboxItem {
	return appendOutbox(cwd, "preserve", {
		refId: entry.id,
		type: entry.type,
		title: entry.title,
		summary: entry.summary,
		importance: entry.importance,
		tags: entry.tags,
		content,
		storage: "auto",
	});
}

export function enqueueArchivistDistill(cwd: string, input: DistillInput): ArchivistOutboxItem {
	return appendOutbox(cwd, "distill", {
		trigger: input.trigger,
		task: input.task,
		outcome: input.outcome,
		context: input.context,
		domain: input.domain,
		targetPath: input.targetPath,
	});
}

export function readArchivistOutbox(cwd: string): ArchivistOutboxItem[] {
	const file = outboxPath(cwd);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => {
			try { return JSON.parse(line) as ArchivistOutboxItem; }
			catch { return null; }
		})
		.filter((item): item is ArchivistOutboxItem => Boolean(item));
}

export function shouldPreserveReflection(entry: ReflectionEntry): boolean {
	if (entry.importance === "critical" || entry.importance === "high") return true;
	if (entry.type === "automation" && entry.tags.includes("automation-candidate")) return true;
	if (entry.tags.some((tag) => ["auto-distill", "micro-skill", "durable"].includes(tag))) return true;
	return false;
}

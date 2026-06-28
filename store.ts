import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────

export type ReflectionType = "knowledge" | "process" | "automation" | "pattern";
export type Importance = "low" | "medium" | "high" | "critical";
export type Confidence = "low" | "medium" | "high";
export type Source = "manual" | "auto-agent-end" | "auto-compact" | "auto-tree" | "auto-automation" | "auto-distill" | "migration";

/** What kind of file the reflection materializes into */
export type TargetType = "user_script" | "module_readme" | "project_skill" | "config_file" | "none";

/** Whether to execute immediately or just plan */
export type Mode = "execute" | "plan";

export interface MaterializeTarget {
	targetType: TargetType;
	targetPath: string;
	action: "create" | "update";
	executable?: boolean;
	/** The actual file content to write at targetPath (code block content from reflection) */
	fileContent: string;
}

export interface ReflectionEntry {
	id: string;
	type: ReflectionType;
	title: string;
	summary: string;
	/** Self-contained searchable learning body. Markdown files are convenience artifacts, not the lookup source of truth. */
	body?: string;
	context?: string;
	evidence?: string;
	application?: string;
	verification?: string;
	importance: Importance;
	tags: string[];
	file: string;
	createdAt: string;
	source: Source;
	sessionId?: string;
	archivistQueuedAt?: string;
	archivistOutboxId?: string;
	accessCount?: number;
	lastAccessedAt?: string;
	/** Materialization fields */
	mode?: Mode;
	confidence?: Confidence;
	target?: MaterializeTarget;
	/** Whether the target file has been materialized */
	materialized?: boolean;
	materializedAt?: string;
}

export interface ReflectionContent {
	type: ReflectionType;
	title: string;
	content: string;
	importance: Importance;
	tags: string[];
	context?: string;
	evidence?: string;
	application?: string;
	verification?: string;
	/** Materialization fields */
	mode?: Mode;
	confidence?: Confidence;
	target?: MaterializeTarget;
}

export interface SearchOptions {
	type?: ReflectionType;
	importance?: Importance;
	limit?: number;
	tags?: string[];
}

export interface ReflectionStats {
	total: number;
	byType: Record<ReflectionType, number>;
	byImportance: Record<Importance, number>;
	thisWeek: number;
	lastReflection?: string;
	pendingMaterializations: number;
}

export interface MaterializeResult {
	success: boolean;
	error?: string;
	path?: string;
	action?: "create" | "update";
	executable?: boolean;
	size?: number;
}

export interface DeleteResult {
	success: boolean;
	error?: string;
	file?: string;
}

export type ReflectionDoctorReport = {
	total: number;
	duplicateIds: string[];
	legacyMarkdownReferences: number;
	missingLegacyMarkdown: number;
	missingBody: number;
	highValueNotQueued: number;
	pendingMaterializations: number;
	forgetCandidates: number;
	discoveryFile: string;
};

export type ForgetResult = {
	candidates: number;
	archived: number;
	archivePath?: string;
	dryRun: boolean;
};

// ─── Store ───────────────────────────────────────────────────────────

export class ReflectionStore {
	private reflectDir: string;
	private indexFile: string;
	private discoveryFile: string;
	private automationsFile: string;
	private reflectionsDir: string;
	private cache: ReflectionEntry[] | null = null;

	constructor(projectRoot: string) {
		this.reflectDir = path.join(projectRoot, ".pi", "reflect");
		this.indexFile = path.join(this.reflectDir, "index.jsonl");
		this.discoveryFile = path.join(this.reflectDir, "MEMORY.md");
		this.automationsFile = path.join(this.reflectDir, "AUTOMATIONS.md");
		this.reflectionsDir = path.join(this.reflectDir, "reflections");
		this.ensureDirs();
	}

	private ensureDirs() {
		fs.mkdirSync(this.reflectionsDir, { recursive: true });
		if (!fs.existsSync(this.indexFile)) {
			fs.writeFileSync(this.indexFile, "");
		}
	}

	// ─── Read ──────────────────────────────────────────────────────

	private loadIndex(): ReflectionEntry[] {
		if (this.cache) return this.cache;

		const content = fs.readFileSync(this.indexFile, "utf-8").trim();
		if (!content) {
			this.cache = [];
			return this.cache;
		}

		this.cache = content
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => {
				try {
					return JSON.parse(line) as ReflectionEntry;
				} catch {
					return null;
				}
			})
			.filter((entry): entry is ReflectionEntry => entry !== null);

		return this.cache;
	}

	// ─── Write ─────────────────────────────────────────────────────

	async save(
		input: ReflectionContent,
		source: Source = "manual",
		sessionId?: string
	): Promise<ReflectionEntry> {
		const now = new Date();
		const id = this.generateId(now);
		// Reflection rows are self-contained. Per-reflection markdown files are no longer
		// written by default; `getContent()` renders markdown from JSONL on demand.
		const fileName = "";

		// Append to canonical store
		const entry: ReflectionEntry = {
			id,
			type: input.type,
			title: input.title,
			summary: input.content.slice(0, 240),
			body: input.content,
			...(input.context && { context: input.context }),
			...(input.evidence && { evidence: input.evidence }),
			...(input.application && { application: input.application }),
			...(input.verification && { verification: input.verification }),
			importance: input.importance,
			tags: input.tags.map((t) => t.toLowerCase()),
			file: fileName,
			createdAt: now.toISOString(),
			source,
			...(sessionId && { sessionId }),
			...(input.mode && { mode: input.mode }),
			...(input.confidence && { confidence: input.confidence }),
			...(input.target && { target: input.target }),
			materialized: false,
		};

		fs.appendFileSync(this.indexFile, JSON.stringify(entry) + "\n");
		this.cache = null; // Invalidate cache
		this.rebuildDiscoveryFile();

		// Auto-materialize if mode is "execute"
		if (input.mode === "execute" && input.target && input.target.targetType !== "none") {
			await this.materialize(entry);
		}

		return entry;
	}

	// ─── Materialize ───────────────────────────────────────────────

	/**
	 * Materialize a reflection: write its fileContent to the targetPath.
	 * Creates parent directories, sets executable flag if needed.
	 */
	async materialize(entry: ReflectionEntry): Promise<MaterializeResult> {
		if (!entry.target) {
			return { success: false, error: "No target defined on this reflection" };
		}

		const { targetPath, action, executable, fileContent, targetType } = entry.target;

		if (targetType === "none") {
			return { success: false, error: "Target type is 'none' — nothing to materialize" };
		}

		if (!fileContent || fileContent.trim().length === 0) {
			return { success: false, error: "No fileContent to write" };
		}

		// Safety: resolve path and check it's within project
		const resolved = path.resolve(targetPath);
		const projectRoot = path.resolve(this.reflectDir, "../..");
		if (!resolved.startsWith(projectRoot) && !resolved.startsWith("/tmp")) {
			return { success: false, error: `Target path '${resolved}' is outside project root '${projectRoot}'` };
		}

		// Check if file exists for create vs update
		const exists = fs.existsSync(resolved);
		if (action === "create" && exists) {
			return { success: false, error: `File already exists: ${resolved}. Use action 'update' to overwrite.` };
		}

		try {
			// Create parent directories
			fs.mkdirSync(path.dirname(resolved), { recursive: true });

			// Write file
			fs.writeFileSync(resolved, fileContent, "utf-8");

			// Set executable if requested
			if (executable) {
				fs.chmodSync(resolved, 0o755);
			}

			// Mark as materialized in index
			this.markMaterialized(entry.id);

			return {
				success: true,
				path: resolved,
				action,
				executable: executable ?? false,
				size: Buffer.byteLength(fileContent, "utf-8"),
			};
		} catch (err) {
			return { success: false, error: `Failed to write '${resolved}': ${err}` };
		}
	}

	/**
	 * Find an entry by ID and materialize it.
	 */
	async materializeById(id: string): Promise<MaterializeResult> {
		const entries = this.loadIndex();
		const entry = entries.find((e) => e.id === id);
		if (!entry) {
			return { success: false, error: `Reflection not found: ${id}` };
		}
		if (entry.materialized) {
			return { success: false, error: `Already materialized at ${entry.materializedAt}` };
		}
		return this.materialize(entry);
	}

	/**
	 * Get all reflections that have materialization targets but haven't been materialized.
	 */
	pending(): ReflectionEntry[] {
		return this.loadIndex().filter(
			(e) => e.target && e.target.targetType !== "none" && !e.materialized
		);
	}

	/**
	 * Rewrite index to mark an entry as materialized.
	 */
	private rewriteIndex(entries: ReflectionEntry[]): void {
		const content = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
		fs.writeFileSync(this.indexFile, content);
		this.cache = null;
		this.rebuildDiscoveryFile();
		this.rebuildAutomationsFile();
	}

	private markMaterialized(id: string): void {
		const entries = this.loadIndex();
		const now = new Date().toISOString();
		this.rewriteIndex(entries.map((e) => e.id === id ? { ...e, materialized: true, materializedAt: now } : e));
	}

	markArchivistQueued(id: string, outboxId: string): void {
		const entries = this.loadIndex();
		const now = new Date().toISOString();
		this.rewriteIndex(entries.map((e) => e.id === id ? { ...e, archivistQueuedAt: now, archivistOutboxId: outboxId } : e));
	}

	private markAccessed(ids: string[]): void {
		const idSet = new Set(ids);
		const now = new Date().toISOString();
		const entries = this.loadIndex();
		this.rewriteIndex(entries.map((e) => idSet.has(e.id) ? { ...e, accessCount: (e.accessCount ?? 0) + 1, lastAccessedAt: now } : e));
	}

	/**
	 * Delete a reflection from the index and remove its markdown file.
	 */
	deleteReflection(id: string): DeleteResult {
		const entries = this.loadIndex();
		const entry = entries.find((e) => e.id === id);
		if (!entry) {
			return { success: false, error: `Reflection not found: ${id}` };
		}

		try {
			// Remove legacy convenience markdown file if this old entry references one.
			const filePath = entry.file ? path.join(this.reflectionsDir, entry.file) : "";
			if (filePath && fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
			}

			// Rewrite index without this entry
			const updated = entries.filter((e) => e.id !== id);
			const content = updated.map((e) => JSON.stringify(e)).join("\n") + (updated.length ? "\n" : "");
			fs.writeFileSync(this.indexFile, content);
			this.cache = null;
			this.rebuildDiscoveryFile();

			return { success: true, file: entry.file };
		} catch (err) {
			return { success: false, error: `Failed to delete reflection: ${err}` };
		}
	}

	// ─── Search ────────────────────────────────────────────────────

	search(query: string, options: SearchOptions = {}): ReflectionEntry[] {
		const entries = this.loadIndex();
		const limit = options.limit ?? 10;
		const queryLower = query.toLowerCase();
		const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);

		// Score each entry
		const scored = entries
			.map((entry) => {
				let score = 0;

				// Type filter (hard filter)
				if (options.type && entry.type !== options.type) return { entry, score: -1 };
				if (options.importance && entry.importance !== options.importance) return { entry, score: -1 };
				if (options.tags?.length) {
					const hasTag = options.tags.some((t) => entry.tags.includes(t.toLowerCase()));
					if (!hasTag) return { entry, score: -1 };
				}

				// Title match (highest weight)
				const titleLower = entry.title.toLowerCase();
				for (const term of queryTerms) {
					if (titleLower.includes(term)) score += 10;
				}
				if (titleLower.includes(queryLower)) score += 20;

				// Tag match
				for (const term of queryTerms) {
					if (entry.tags.some((t) => t.includes(term))) score += 5;
				}

				// Summary/body/context match
				const searchableLower = [entry.summary, entry.body, entry.context, entry.evidence, entry.application, entry.verification]
					.filter(Boolean)
					.join("\n")
					.toLowerCase();
				for (const term of queryTerms) {
					if (searchableLower.includes(term)) score += 3;
				}
				if (searchableLower.includes(queryLower)) score += 8;

				// Importance boost
				const importanceBoost: Record<Importance, number> = {
					critical: 4,
					high: 3,
					medium: 2,
					low: 1,
				};
				score += importanceBoost[entry.importance];

				// Recency boost (last 7 days get +2)
				const age = Date.now() - new Date(entry.createdAt).getTime();
				if (age < 7 * 24 * 60 * 60 * 1000) score += 2;

				return { entry, score };
			})
			.filter((s) => s.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);

		const results = scored.map((s) => s.entry);
		if (results.length) this.markAccessed(results.map((entry) => entry.id));
		return results;
	}

	// ─── Read Full Content ─────────────────────────────────────────

	getContent(entry: ReflectionEntry): string | null {
		const filePath = path.join(this.reflectionsDir, entry.file);
		if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf-8");
		if (!entry.body && !entry.summary) return null;
		return this.renderEntryMarkdown(entry);
	}

	// ─── Stats ─────────────────────────────────────────────────────

	getStats(): ReflectionStats {
		const entries = this.loadIndex();
		const now = Date.now();
		const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

		const byType: Record<ReflectionType, number> = {
			knowledge: 0,
			process: 0,
			automation: 0,
			pattern: 0,
		};
		const byImportance: Record<Importance, number> = {
			low: 0,
			medium: 0,
			high: 0,
			critical: 0,
		};

		let thisWeek = 0;
		let lastReflection: string | undefined;
		let pendingMaterializations = 0;

		for (const entry of entries) {
			byType[entry.type]++;
			byImportance[entry.importance]++;
			if (new Date(entry.createdAt).getTime() > weekAgo) thisWeek++;
			if (!lastReflection || entry.createdAt > lastReflection) {
				lastReflection = entry.createdAt;
			}
			if (entry.target && entry.target.targetType !== "none" && !entry.materialized) {
				pendingMaterializations++;
			}
		}

		return { total: entries.length, byType, byImportance, thisWeek, lastReflection, pendingMaterializations };
	}

	// ─── List ──────────────────────────────────────────────────────

	recent(limit: number = 10): ReflectionEntry[] {
		const entries = this.loadIndex();
		return [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
	}

	getAll(): ReflectionEntry[] {
		return this.loadIndex();
	}

	refreshDiscoveryFile(): void {
		this.rebuildDiscoveryFile();
		this.rebuildAutomationsFile();
	}

	normalizeStore(): { updated: number } {
		const entries = this.loadIndex();
		let updated = 0;
		const normalized = entries.map((entry) => {
			let next = entry;
			if (!next.body && next.summary) {
				next = { ...next, body: next.summary };
				updated++;
			}
			if (next.file && !fs.existsSync(path.join(this.reflectionsDir, next.file))) {
				next = { ...next, file: "" };
				updated++;
			}
			return next;
		});
		if (updated > 0) this.rewriteIndex(normalized);
		else this.refreshDiscoveryFile();
		return { updated };
	}

	doctor(): ReflectionDoctorReport {
		const entries = this.loadIndex();
		const seen = new Set<string>();
		const duplicateIds = new Set<string>();
		let legacyMarkdownReferences = 0;
		let missingLegacyMarkdown = 0;
		let missingBody = 0;
		let highValueNotQueued = 0;
		let pendingMaterializations = 0;
		let forgetCandidates = 0;
		for (const entry of entries) {
			if (seen.has(entry.id)) duplicateIds.add(entry.id);
			seen.add(entry.id);
			if (entry.file) {
				legacyMarkdownReferences++;
				if (!fs.existsSync(path.join(this.reflectionsDir, entry.file))) missingLegacyMarkdown++;
			}
			if (!entry.body && !entry.summary) missingBody++;
			if ((entry.importance === "critical" || entry.importance === "high" || entry.tags.includes("micro-skill") || entry.tags.includes("durable")) && !entry.archivistOutboxId) highValueNotQueued++;
			if (entry.target && entry.target.targetType !== "none" && !entry.materialized) pendingMaterializations++;
			if (this.shouldForget(entry, 90)) forgetCandidates++;
		}
		return { total: entries.length, duplicateIds: [...duplicateIds], legacyMarkdownReferences, missingLegacyMarkdown, missingBody, highValueNotQueued, pendingMaterializations, forgetCandidates, discoveryFile: this.discoveryFile };
	}

	forget(days = 90, apply = false): ForgetResult {
		const entries = this.loadIndex();
		const candidates = entries.filter((entry) => this.shouldForget(entry, days));
		if (!apply || candidates.length === 0) return { candidates: candidates.length, archived: 0, dryRun: true };

		const archiveDir = path.join(this.reflectDir, "archive");
		fs.mkdirSync(archiveDir, { recursive: true });
		const archivePath = path.join(archiveDir, `forgotten-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
		fs.writeFileSync(archivePath, candidates.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
		const candidateIds = new Set(candidates.map((entry) => entry.id));
		this.rewriteIndex(entries.filter((entry) => !candidateIds.has(entry.id)));
		return { candidates: candidates.length, archived: candidates.length, archivePath, dryRun: false };
	}

	private shouldForget(entry: ReflectionEntry, days: number): boolean {
		if (entry.importance === "critical" || entry.importance === "high") return false;
		if (entry.archivistOutboxId) return false;
		if (entry.target && entry.target.targetType !== "none") return false;
		if (entry.materialized) return false;
		if (entry.tags.some((tag) => ["durable", "micro-skill", "automation-candidate", "auto-distill"].includes(tag))) return false;
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
		const lastUseful = Date.parse(entry.lastAccessedAt ?? entry.createdAt);
		if (Number.isNaN(lastUseful) || lastUseful > cutoff) return false;
		return entry.source.startsWith("auto-") || (entry.accessCount ?? 0) === 0;
	}

	// ─── Helpers ───────────────────────────────────────────────────

	private generateId(date: Date): string {
		const ts = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
		const rand = crypto.randomBytes(3).toString("hex");
		return `ref_${ts}_${rand}`;
	}

	private formatDate(date: Date): string {
		return date.toISOString().slice(0, 10);
	}

	private slugify(title: string): string {
		return title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 50);
	}

	private rebuildDiscoveryFile(): void {
		const all = this.loadIndex().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		const critical = all.filter((entry) => entry.importance === "critical").slice(0, 15);
		const high = all.filter((entry) => entry.importance === "high").slice(0, 25);
		const microSkills = all.filter((entry) => entry.tags.includes("micro-skill") || entry.target?.targetType === "project_skill").slice(0, 20);
		const handoffs = all.filter((entry) => entry.archivistOutboxId).slice(0, 20);

		const render = (entry: ReflectionEntry) => [
			`### ${entry.title}`,
			`- ID: ${entry.id}`,
			`- Type: ${entry.type}`,
			`- Importance: ${entry.importance}`,
			`- Tags: ${entry.tags.join(", ")}`,
			entry.archivistOutboxId ? `- Archivist outbox: ${entry.archivistOutboxId}` : "- Archivist outbox: not queued",
			"",
			(entry.body ?? entry.summary ?? "").slice(0, 700),
			"",
		];

		const section = (title: string, entries: ReflectionEntry[]) => [
			`## ${title}`,
			"",
			...(entries.length ? entries.flatMap(render) : ["None.", ""]),
		];

		const lines = [
			"# Reflect Memory",
			"",
			"Generated from `.pi/reflect/index.jsonl` for fast project-local runtime discovery.",
			"Canonical durable Obsidian memory must be written by Archivist/Inquirer, not by reflect.",
			"",
			...section("Critical", critical),
			...section("High Value", high),
			...section("Pending Micro-skills", microSkills.filter((entry) => !entry.materialized)),
			...section("Archivist Handoffs", handoffs),
		];
		fs.writeFileSync(this.discoveryFile, lines.join("\n"));
	}

	private rebuildAutomationsFile(): void {
		const entries = this.loadIndex()
			.filter((entry) => entry.type === "automation" && entry.target?.targetType === "user_script")
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		const lines = [
			"# Reflect Automations",
			"",
			"Generated from `.pi/reflect/index.jsonl`. Scripts are created automatically from repeated workflows.",
			"Sherpa discovers generated scripts under `scripts/reflect-automations/` recursively.",
			"",
			...(entries.length ? entries.flatMap((entry) => [
				`## ${entry.title}`,
				`- ID: ${entry.id}`,
				`- Script: ${entry.target?.targetPath ?? "unknown"}`,
				`- Materialized: ${entry.materialized ? "yes" : "no"}`,
				`- Command source: ${entry.evidence ?? "unknown"}`,
				`- Last accessed: ${entry.lastAccessedAt ?? "never"}`,
				"",
			]) : ["None.", ""]),
		];
		fs.writeFileSync(this.automationsFile, lines.join("\n"));
	}

	private renderEntryMarkdown(entry: ReflectionEntry): string {
		const lines = [
			`# ${entry.title}`,
			"",
			`**Type:** ${entry.type}`,
			`**Importance:** ${entry.importance}`,
			`**Tags:** ${entry.tags.join(", ")}`,
			`**Source:** ${entry.source}`,
			`**Created:** ${entry.createdAt}`,
			"",
		];
		if (entry.context) lines.push("## Context", "", entry.context, "");
		lines.push("## Learning", "", entry.body ?? entry.summary, "");
		if (entry.evidence) lines.push("## Evidence", "", entry.evidence, "");
		if (entry.application) lines.push("## Application", "", entry.application, "");
		if (entry.verification) lines.push("## Verification", "", entry.verification, "");
		return lines.join("\n");
	}

	private renderMarkdown(input: ReflectionContent, source: Source, date: Date): string {
		const lines: string[] = [
			`# ${input.title}`,
			"",
			`**Type:** ${input.type}`,
			`**Mode:** ${input.mode ?? "plan"}`,
			`**Confidence:** ${input.confidence ?? "medium"}`,
			`**Importance:** ${input.importance}`,
			`**Tags:** ${input.tags.join(", ")}`,
			`**Source:** ${source}`,
			`**Created:** ${date.toISOString()}`,
		];

		// Materialization target metadata
		if (input.target && input.target.targetType !== "none") {
			lines.push(`**Target Type:** ${input.target.targetType}`);
			lines.push(`**Target Path:** ${input.target.targetPath}`);
			lines.push(`**Action:** ${input.target.action}`);
			if (input.target.executable) {
				lines.push(`**Executable:** true`);
			}
		}

		lines.push("");

		if (input.context) {
			lines.push("## Context", "", input.context, "");
		}

		lines.push("## Learning", "", input.content, "");

		if (input.evidence) {
			lines.push("## Evidence", "", input.evidence, "");
		}

		if (input.application) {
			lines.push("## Application", "", input.application, "");
		}

		// The actual file content to materialize
		if (input.target && input.target.fileContent) {
			const ext = this.inferLanguage(input.target.targetPath);
			lines.push("## Content", "", `\`\`\`${ext}`, input.target.fileContent, "```", "");
		}

		if (input.verification) {
			lines.push("## Verification", "", input.verification, "");
		}

		return lines.join("\n");
	}

	private inferLanguage(filePath: string): string {
		const ext = path.extname(filePath).toLowerCase();
		const map: Record<string, string> = {
			".ts": "typescript",
			".tsx": "tsx",
			".js": "javascript",
			".jsx": "jsx",
			".sh": "bash",
			".bash": "bash",
			".md": "markdown",
			".json": "json",
			".yaml": "yaml",
			".yml": "yaml",
			".sql": "sql",
			".css": "css",
			".html": "html",
		};
		return map[ext] ?? "";
	}
}

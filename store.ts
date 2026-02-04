import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────

export type ReflectionType = "knowledge" | "process" | "automation" | "pattern";
export type Importance = "low" | "medium" | "high" | "critical";
export type Confidence = "low" | "medium" | "high";
export type Source = "manual" | "auto-agent-end" | "auto-compact" | "auto-tree" | "migration";

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
	importance: Importance;
	tags: string[];
	file: string;
	createdAt: string;
	source: Source;
	sessionId?: string;
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

// ─── Store ───────────────────────────────────────────────────────────

export class ReflectionStore {
	private reflectDir: string;
	private indexFile: string;
	private reflectionsDir: string;
	private cache: ReflectionEntry[] | null = null;

	constructor(projectRoot: string) {
		this.reflectDir = path.join(projectRoot, ".pi", "reflect");
		this.indexFile = path.join(this.reflectDir, "index.jsonl");
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
		const slug = this.slugify(input.title);
		const fileName = `${this.formatDate(now)}_${input.type}_${slug}.md`;

		// Write full markdown file
		const markdown = this.renderMarkdown(input, source, now);
		fs.writeFileSync(path.join(this.reflectionsDir, fileName), markdown);

		// Append to index
		const entry: ReflectionEntry = {
			id,
			type: input.type,
			title: input.title,
			summary: input.content.slice(0, 200),
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
	private markMaterialized(id: string): void {
		const entries = this.loadIndex();
		const now = new Date().toISOString();
		const updated = entries.map((e) => {
			if (e.id === id) return { ...e, materialized: true, materializedAt: now };
			return e;
		});

		// Rewrite index
		const content = updated.map((e) => JSON.stringify(e)).join("\n") + "\n";
		fs.writeFileSync(this.indexFile, content);
		this.cache = null;
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
			// Remove file if exists
			const filePath = path.join(this.reflectionsDir, entry.file);
			if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
			}

			// Rewrite index without this entry
			const updated = entries.filter((e) => e.id !== id);
			const content = updated.map((e) => JSON.stringify(e)).join("\n") + (updated.length ? "\n" : "");
			fs.writeFileSync(this.indexFile, content);
			this.cache = null;

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

				// Summary match
				const summaryLower = entry.summary.toLowerCase();
				for (const term of queryTerms) {
					if (summaryLower.includes(term)) score += 3;
				}

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

		return scored.map((s) => s.entry);
	}

	// ─── Read Full Content ─────────────────────────────────────────

	getContent(entry: ReflectionEntry): string | null {
		const filePath = path.join(this.reflectionsDir, entry.file);
		if (!fs.existsSync(filePath)) return null;
		return fs.readFileSync(filePath, "utf-8");
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

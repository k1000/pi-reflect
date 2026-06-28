import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import { ReflectionStore } from "./store.ts";
import { analyzeForReflections, extractFromCompaction, reflectionFromBranch } from "./capture.ts";
import { ReviewQueue } from "./review.ts";
import {
	applyPersistedReflectLearningState,
	createReflectLearningState,
	runPostTaskLearning,
	serializeReflectLearningState,
} from "./learning.ts";
import { enqueueArchivistPreserve, readArchivistOutbox, shouldPreserveReflection } from "./archivist.ts";
import { readNudges, writeNudge, type NudgeTarget } from "./nudge.ts";
import type { ReflectionType, Importance, Source, TargetType, Mode, Confidence, ReflectionEntry } from "./store.ts";
import type { ReviewAction } from "./review.ts";

const execFileAsync = promisify(execFile);

export default function (pi: ExtensionAPI) {
	let store = new ReflectionStore(process.cwd());
	const reviewQueue = new ReviewQueue();
	let learningState = createReflectLearningState();
	const persistLearningState = () => pi.appendEntry("pi-reflect-state", serializeReflectLearningState(learningState));
	function queueArchivistIfNeeded(ctx: ExtensionContext, entry: ReflectionEntry): ReturnType<typeof enqueueArchivistPreserve> | undefined {
		if (!shouldPreserveReflection(entry)) return undefined;
		if (entry.archivistOutboxId) return undefined;
		const item = enqueueArchivistPreserve(ctx.cwd, entry, store.getContent(entry) ?? undefined);
		store.markArchivistQueued(entry.id, item.id);
		return item;
	}

	// ═════════════════════════════════════════════════════════════════
	// 1. CUSTOM TOOLS — Let the LLM capture and search reflections
	// ═════════════════════════════════════════════════════════════════

	pi.registerTool({
		name: "reflect_capture",
		label: "Reflect Capture",
		description:
			"Capture a reflection or learning from current work. Use when you discover a pattern worth remembering, fix a recurring issue, learn a codebase rule, or identify an anti-pattern. Reflections are persisted across sessions and auto-surfaced when relevant.",
		parameters: Type.Object({
			type: StringEnum(["knowledge", "process", "automation", "pattern"] as const, {
				description: "knowledge=domain facts, process=workflow, automation=scripts/tools, pattern=code patterns",
			}),
			title: Type.String({ description: "Short title (max 100 chars)" }),
			content: Type.String({ description: "The core learning or insight" }),
			importance: StringEnum(["low", "medium", "high", "critical"] as const, {
				description: "critical=production bugs, high=saves time, medium=optimization, low=nice-to-know",
			}),
			tags: Type.Array(Type.String(), { description: "Searchable tags (lowercase, hyphenated)" }),
			context: Type.Optional(Type.String({ description: "What led to this discovery" })),
			evidence: Type.Optional(Type.String({ description: "Code snippets, file paths, error messages" })),
			application: Type.Optional(Type.String({ description: "When/how to apply this in the future" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const entry = await store.save(
					{
						type: params.type as ReflectionType,
						title: params.title,
						content: params.content,
						importance: params.importance as Importance,
						tags: params.tags,
						context: params.context,
						evidence: params.evidence,
						application: params.application,
					},
					"manual"
				);
				const archivistItem = queueArchivistIfNeeded(ctx, entry);

				const importanceEmoji: Record<string, string> = {
					critical: "🔴",
					high: "🟠",
					medium: "🟡",
					low: "🟢",
				};
				const emoji = importanceEmoji[entry.importance] ?? "💡";

				return {
					content: [
						{
							type: "text" as const,
							text: `${emoji} Reflection captured: "${entry.title}" (${entry.type}, ${entry.importance})\nID: ${entry.id}\nStore: .pi/reflect/index.jsonl\nDiscovery: .pi/reflect/MEMORY.md\nTags: ${entry.tags.join(", ")}${archivistItem ? `\nArchivist/Inquirer outbox: ${archivistItem.id}` : ""}`,
						},
					],
					details: { entry, archivistItem },
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `Error saving reflection: ${err}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "reflect_search",
		label: "Reflect Search",
		description:
			"Search local reflections and shared Sherpa/Reflect nudges. Use before complex tasks to find relevant learnings.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query (matches title, tags, summary, body, context, evidence, and nudges)" }),
			includeNudges: Type.Optional(Type.Boolean({ description: "Also search shared scratchpad nudges (default true)" })),
			type: Type.Optional(
				StringEnum(["knowledge", "process", "automation", "pattern"] as const, {
					description: "Filter reflection type",
				})
			),
			importance: Type.Optional(
				StringEnum(["low", "medium", "high", "critical"] as const, {
					description: "Filter reflection importance",
				})
			),
			limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const limit = params.limit ?? 10;
				const results = store.search(params.query, {
					type: params.type as ReflectionType | undefined,
					importance: params.importance as Importance | undefined,
					limit,
				});
				const nudges = params.includeNudges === false ? [] : readNudges(scratchpadRoot(ctx.cwd), params.query, limit);

				if (results.length === 0 && nudges.length === 0) {
					return {
						content: [{ type: "text" as const, text: `No reflect memory found for: "${params.query}"` }],
						details: { results: [], nudges: [] },
					};
				}

				const importanceEmoji: Record<string, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" };
				const formatted = [
					...results.map((r, i) => {
						const emoji = importanceEmoji[r.importance] ?? "💡";
						return `${i + 1}. ${emoji} **${r.title}** [${r.type}/${r.importance}]\n   ${r.summary}\n   Tags: ${r.tags.join(", ")} | ${r.createdAt.slice(0, 10)}${r.archivistOutboxId ? ` | Archivist: ${r.archivistOutboxId}` : ""}`;
					}),
					...nudges.map((n, i) => `${results.length + i + 1}. 📝 **${n.title}** [nudge/${n.target}]\n   ${n.body.replace(/\s+/g, " ").slice(0, 220)}`),
				].join("\n\n");

				return {
					content: [{ type: "text" as const, text: `Found ${results.length} reflection(s) and ${nudges.length} nudge(s) for "${params.query}":\n\n${formatted}` }],
					details: { results, nudges },
				};
			} catch (err) {
				return { content: [{ type: "text" as const, text: `Error searching reflect memory: ${err}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "reflect_apply",
		label: "Reflect Apply",
		description:
			"Materialize a reflection: write its file content to the target path in the project. Use after reflect_capture with a target, or to apply a pending reflection by ID. Creates scripts, docs, skills, or config files.",
		parameters: Type.Object({
			id: Type.String({ description: "Reflection ID to materialize (from reflect_search or reflect_capture)" }),
			force: Type.Optional(Type.Boolean({ description: "Overwrite existing file (default false)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const entries = store.getAll();
				const entry = entries.find((e) => e.id === params.id);

				if (!entry) {
					return {
						content: [{ type: "text" as const, text: `Reflection not found: ${params.id}` }],
						details: {},
						isError: true,
					};
				}

				if (!entry.target || entry.target.targetType === "none") {
					return {
						content: [
							{
								type: "text" as const,
								text: `Reflection "${entry.title}" has no materialization target. It's a note-only reflection.`,
							},
						],
						details: { entry },
					};
				}

				if (entry.materialized && !params.force) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Already materialized at ${entry.materializedAt}.\nTarget: ${entry.target.targetPath}\nUse force=true to re-apply.`,
							},
						],
						details: { entry },
					};
				}

				// If force, change action to update to allow overwrite
				if (params.force && entry.target) {
					entry.target.action = "update";
				}

				const result = await store.materialize(entry);

				if (!result.success) {
					return {
						content: [{ type: "text" as const, text: `Materialization failed: ${result.error}` }],
						details: { result },
						isError: true,
					};
				}

				const typeEmoji: Record<string, string> = {
					user_script: "🤖",
					module_readme: "📚",
					project_skill: "🔄",
					config_file: "⚙️",
				};
				const emoji = typeEmoji[entry.target.targetType] ?? "📄";

				return {
					content: [
						{
							type: "text" as const,
							text: [
								`${emoji} Materialized: "${entry.title}"`,
								``,
								`  Target: ${result.path}`,
								`  Action: ${result.action}`,
								`  Size: ${result.size} bytes`,
								result.executable ? `  Executable: ✓ (chmod +x)` : "",
								``,
								`File is ready at: ${result.path}`,
							]
								.filter(Boolean)
								.join("\n"),
						},
					],
					details: { entry, result },
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `Error materializing: ${err}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	// ═════════════════════════════════════════════════════════════════
	// 1b. UPGRADED reflect_capture — now supports materialization target
	// ═════════════════════════════════════════════════════════════════

	// (The original reflect_capture above handles note-only reflections.
	//  This tool handles full materializable reflections with file content.)

	pi.registerTool({
		name: "reflect_materialize",
		label: "Reflect Materialize",
		description: [
			"Capture a reflection WITH a materialization target — creates both the reflection AND a file in the project.",
			"Use for: scripts (user_script), documentation (module_readme), skills/rules (project_skill), config (config_file).",
			"Set mode='execute' to write the file immediately, or mode='plan' to save as pending.",
		].join(" "),
		parameters: Type.Object({
			type: StringEnum(["knowledge", "process", "automation", "pattern"] as const, {
				description: "knowledge=docs, process=skills/rules, automation=scripts, pattern=config/code",
			}),
			title: Type.String({ description: "Short title (max 100 chars)" }),
			content: Type.String({ description: "Description of what this file does and why" }),
			importance: StringEnum(["low", "medium", "high", "critical"] as const),
			tags: Type.Array(Type.String(), { description: "Searchable tags" }),
			mode: StringEnum(["execute", "plan"] as const, {
				description: "execute=write file now, plan=save as pending for later apply",
			}),
			confidence: StringEnum(["low", "medium", "high"] as const, {
				description: "How confident you are this is correct",
			}),
			targetType: StringEnum(["user_script", "module_readme", "project_skill", "config_file"] as const, {
				description: "user_script=.sh/.ts scripts, module_readme=docs .md, project_skill=skill .md, config_file=json/yaml/ts config",
			}),
			targetPath: Type.String({ description: "Absolute path where the file should be created" }),
			action: StringEnum(["create", "update"] as const, {
				description: "create=fail if exists, update=overwrite",
			}),
			executable: Type.Optional(Type.Boolean({ description: "Set chmod +x (for scripts)" })),
			fileContent: Type.String({ description: "The actual file content to write at targetPath" }),
			context: Type.Optional(Type.String({ description: "What led to this" })),
			evidence: Type.Optional(Type.String({ description: "Supporting evidence" })),
			verification: Type.Optional(Type.String({ description: "How to verify it works" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const entry = await store.save(
					{
						type: params.type as ReflectionType,
						title: params.title,
						content: params.content,
						importance: params.importance as Importance,
						tags: params.tags,
						context: params.context,
						evidence: params.evidence,
						verification: params.verification,
						mode: params.mode as Mode,
						confidence: params.confidence as Confidence,
						target: {
							targetType: params.targetType as TargetType,
							targetPath: params.targetPath,
							action: params.action as "create" | "update",
							executable: params.executable,
							fileContent: params.fileContent,
						},
					},
					"manual"
				);

				const typeEmoji: Record<string, string> = {
					user_script: "🤖",
					module_readme: "📚",
					project_skill: "🔄",
					config_file: "⚙️",
				};
				const emoji = typeEmoji[params.targetType] ?? "📄";

				const lines = [
					`${emoji} Reflection captured: "${entry.title}"`,
					`  ID: ${entry.id}`,
					`  Target: ${params.targetPath}`,
					`  Type: ${params.targetType} | Action: ${params.action}`,
				];

				if (entry.materialized) {
					lines.push(`  ✅ Materialized (mode=execute)`);
					lines.push(`  File written to: ${params.targetPath}`);
					if (params.executable) lines.push(`  Executable: ✓`);
				} else {
					lines.push(`  ⏳ Pending (mode=plan) — use reflect_apply to materialize`);
				}

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { entry },
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `Error: ${err}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	function scratchpadRoot(cwd: string): string {
		return path.join(cwd, ".pi-memory", "scratchpad");
	}

	function generatedAutomationScripts(cwd: string): Array<{ name: string; path: string; rel: string }> {
		const root = path.join(cwd, "scripts", "reflect-automations");
		if (!existsSync(root)) return [];
		return readdirSync(root)
			.filter((name) => name.endsWith(".sh"))
			.map((name) => ({ name, path: path.join(root, name), rel: path.relative(cwd, path.join(root, name)).replace(/\\/g, "/") }))
			.filter((item) => statSync(item.path).isFile());
	}

	pi.registerTool({
		name: "reflect_maintenance",
		label: "Reflect Maintenance",
		description: "Run automated pi-reflect memory maintenance: normalize store, archive stale low-value reflections, and refresh MEMORY/AUTOMATIONS discovery files.",
		parameters: Type.Object({
			days: Type.Optional(Type.Number({ description: "Forget threshold in days (default 90)" })),
			dryRun: Type.Optional(Type.Boolean({ description: "If true, report forget candidates without archiving" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const normalized = store.normalizeStore();
			const forgotten = store.forget(params.days ?? 90, params.dryRun !== true);
			store.refreshDiscoveryFile();
			const report = store.doctor();
			return {
				content: [{ type: "text" as const, text: [
					"Reflect maintenance complete",
					`Normalized fields: ${normalized.updated}`,
					`Forget candidates: ${forgotten.candidates}`,
					`Archived: ${forgotten.archived}`,
					forgotten.archivePath ? `Archive: ${forgotten.archivePath}` : "",
					`Total reflections: ${report.total}`,
					`High-value not queued: ${report.highValueNotQueued}`,
				].filter(Boolean).join("\n") }],
				details: { normalized, forgotten, report },
			};
		},
	});

	pi.registerTool({
		name: "reflect_nudge",
		label: "Reflect Nudge",
		description: "Save an observation or distillation candidate into the shared Sherpa/Reflect scratchpad with deduplication. Use for reusable facts, corrections, preferences, and candidate lessons.",
		parameters: Type.Object({
			target: StringEnum(["observation", "distill_candidate"] as const),
			content: Type.String({ description: "Observation, correction, preference, or candidate lesson to remember" }),
			dedupKey: Type.Optional(Type.String({ description: "Optional deduplication key" })),
			skipDedup: Type.Optional(Type.Boolean({ description: "Skip deduplication check" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = writeNudge(params.target as NudgeTarget, params.content, { scratchpadRoot: scratchpadRoot(ctx.cwd) }, { dedupKey: params.dedupKey, skipDedup: params.skipDedup });
			const bits = [];
			if (result.written) bits.push("written");
			if (result.deduped) bits.push("deduped");
			if (result.nearDuplicate) bits.push("near-duplicate");
			if (result.autoCompacted) bits.push("auto-compacted");
			if (result.capacityWarning) bits.push(result.capacityWarning);
			return { content: [{ type: "text" as const, text: `Reflect nudge ${bits.join(" | ") || "ok"}\nPath: ${result.path}` }], details: { result } };
		},
	});

	pi.registerTool({
		name: "reflect_run_automation",
		label: "Reflect Run Automation",
		description: "Run a script automatically generated by reflect under scripts/reflect-automations/. No manual approval is required for generated scripts.",
		parameters: Type.Object({
			name: Type.String({ description: "Generated script filename or repo-relative path. Use 'list' to show available scripts." }),
			dryRun: Type.Optional(Type.Boolean({ description: "Show command without running" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scripts = generatedAutomationScripts(ctx.cwd);
			if (params.name === "list") {
				return { content: [{ type: "text" as const, text: scripts.length ? scripts.map((s) => `- ${s.rel}`).join("\n") : "No reflect-generated automations." }], details: { scripts } };
			}
			const script = scripts.find((s) => s.name === params.name || s.rel === params.name);
			if (!script) return { content: [{ type: "text" as const, text: `Reflect automation not found: ${params.name}` }], details: { scripts }, isError: true };
			const command = `bash ${script.rel}`;
			if (params.dryRun) return { content: [{ type: "text" as const, text: `Dry run: ${command}` }], details: { script, command } };
			try {
				const { stdout, stderr } = await execFileAsync("bash", [script.path], { cwd: ctx.cwd, timeout: 120_000, maxBuffer: 1_000_000 });
				return { content: [{ type: "text" as const, text: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "Reflect automation completed with no output" }], details: { script, command } };
			} catch (error) {
				return { content: [{ type: "text" as const, text: `Reflect automation failed: ${error instanceof Error ? error.message : String(error)}` }], details: { script, command }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "reflect_preserve",
		label: "Reflect Preserve",
		description: "Queue an important reflection for Archivist/Inquirer durable memory preservation. Reflect never writes Obsidian memory directly.",
		parameters: Type.Object({
			id: Type.String({ description: "Reflection ID to queue for Archivist preservation" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const entry = store.getAll().find((item) => item.id === params.id);
			if (!entry) return { content: [{ type: "text" as const, text: `Reflection not found: ${params.id}` }], isError: true, details: {} };
			const item = entry.archivistOutboxId
				? undefined
				: enqueueArchivistPreserve(ctx.cwd, entry, store.getContent(entry) ?? undefined);
			if (item) store.markArchivistQueued(entry.id, item.id);
			return { content: [{ type: "text" as const, text: item ? `Queued for Archivist/Inquirer preservation: ${item.id}` : `Already queued: ${entry.archivistOutboxId}` }], details: { item, shouldPreserve: shouldPreserveReflection(entry) } };
		},
	});


	pi.registerCommand("reflect:maintenance", {
		description: "Run automated reflect memory maintenance",
		handler: async (args, ctx) => {
			const parts = (args ?? "").split(/\s+/).filter(Boolean);
			const dryRun = parts.includes("dry-run") || parts.includes("--dry-run");
			const days = Number(parts.find((part) => /^\d+$/.test(part)) ?? 90);
			const normalized = store.normalizeStore();
			const forgotten = store.forget(days, !dryRun);
			store.refreshDiscoveryFile();
			const report = store.doctor();
			ctx.ui.notify([
				"Reflect maintenance complete",
				`Normalized fields: ${normalized.updated}`,
				`Forget candidates: ${forgotten.candidates}`,
				`Archived: ${forgotten.archived}`,
				forgotten.archivePath ? `Archive: ${forgotten.archivePath}` : "",
				`Total reflections: ${report.total}`,
				`High-value not queued: ${report.highValueNotQueued}`,
			].filter(Boolean).join("\n"), report.highValueNotQueued ? "warning" : "info");
		},
	});

	pi.registerCommand("reflect:automations", {
		description: "List reflect-generated automation scripts",
		handler: async (_args, ctx) => {
			const scripts = generatedAutomationScripts(ctx.cwd);
			ctx.ui.notify(scripts.length ? scripts.map((s) => `- ${s.rel}`).join("\n") : "No reflect-generated automations.", "info");
		},
	});

	pi.registerCommand("reflect:outbox", {
		description: "List queued Archivist/Inquirer reflection handoffs",
		handler: async (_args, ctx) => {
			const items = readArchivistOutbox(ctx.cwd).slice(-20);
			ctx.ui.notify(items.length ? items.map((item) => `- ${item.createdAt} [${item.kind}] ${item.id}`).join("\n") : "Reflect Archivist outbox is empty", "info");
		},
	});

	pi.registerCommand("reflect:doctor", {
		description: "Audit reflection storage, discovery, and Archivist handoff state",
		handler: async (_args, ctx) => {
			store.refreshDiscoveryFile();
			const report = store.doctor();
			const outbox = readArchivistOutbox(ctx.cwd);
			ctx.ui.notify([
				"## Reflect Doctor",
				`Total reflections: ${report.total}`,
				`Duplicate IDs: ${report.duplicateIds.length}`,
				`Legacy markdown refs: ${report.legacyMarkdownReferences}`,
				`Missing legacy markdown: ${report.missingLegacyMarkdown}`,
				`Rows missing body+summary: ${report.missingBody}`,
				`High-value not queued to Archivist: ${report.highValueNotQueued}`,
				`Pending materializations: ${report.pendingMaterializations}`,
				`Forget candidates: ${report.forgetCandidates}`,
				`Archivist outbox queued: ${outbox.length}`,
				`Discovery file: ${report.discoveryFile}`,
			].join("\n"), report.duplicateIds.length || report.missingBody || report.highValueNotQueued ? "warning" : "info");
		},
	});

	// ═════════════════════════════════════════════════════════════════
	// 2. EVENT HOOKS — Auto-capture from agent behavior
	// ═════════════════════════════════════════════════════════════════

	// After each agent prompt — analyze for capturable patterns, queue for review
	pi.on("agent_end", async (event, ctx) => {
		try {
			if ((event as any).willRetry === true) return;
			const messages = (event as any).messages ?? ctx.sessionManager.getEntries().slice(-12);
			if (!messages || !Array.isArray(messages)) return;

			const insights = analyzeForReflections(messages);
			for (const insight of insights) {
				const entry = await store.save(insight.reflection, "auto-agent-end");
				reviewQueue.add(entry);
			}
			if (insights.length > 0 && ctx.hasUI) {
				updateReviewWidget(ctx);
			}

			await runPostTaskLearning(ctx, learningState, messages);
			persistLearningState();
		} catch {
			// Silent — don't interrupt agent flow
		}
	});

	// Before compaction — extract learnings before context is lost
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			const entries = (event as any).branchEntries;
			if (!entries || !Array.isArray(entries) || entries.length === 0) return;

			const reflections = extractFromCompaction(entries);
			for (const r of reflections) {
				await store.save(r, "auto-compact");
			}
			if (reflections.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`💡 ${reflections.length} reflection(s) saved before compaction`, "info");
			}
		} catch {
			// Silent
		}
	});

	// Tree navigation — capture branch summaries
	pi.on("session_tree", async (event, _ctx) => {
		try {
			const treeEvent = event as any;
			if (treeEvent.summaryEntry?.summary) {
				const reflection = reflectionFromBranch(treeEvent.summaryEntry.summary, treeEvent.oldLeafId);
				if (reflection) {
					await store.save(reflection, "auto-tree");
				}
			}
		} catch {
			// Silent
		}
	});

	// Before each turn — inject relevant reflections into system prompt
	pi.on("before_agent_start", async (event, _ctx) => {
		try {
			const prompt = (event as any).prompt;
			if (!prompt || typeof prompt !== "string") return;

			const relevant = store.search(prompt, { limit: 3 });
			if (relevant.length === 0) return;

			const context = relevant
				.map((r) => `• [${r.type}/${r.importance}] ${r.title}: ${r.summary}`)
				.join("\n");

			const currentPrompt = (event as any).systemPrompt ?? "";
			return {
				systemPrompt:
					currentPrompt +
					`\n\n<past_reflections>\nRelevant learnings from past sessions:\n${context}\n</past_reflections>`,
			};
		} catch {
			return; // Silent — don't block agent start
		}
	});

	// ═════════════════════════════════════════════════════════════════
	// 3. RALPH INTEGRATION — Pre-load reflections for loops
	// ═════════════════════════════════════════════════════════════════

	pi.on("tool_call", async (event, _ctx) => {
		try {
			if ((event as any).toolName !== "ralph_start") return;

			const taskContent = (event as any).input?.taskContent;
			if (!taskContent || typeof taskContent !== "string") return;

			const relevant = store.search(taskContent, { limit: 5 });
			if (relevant.length === 0) return;

			const context = relevant
				.map((r) => `- **${r.title}** (${r.importance}): ${r.summary}`)
				.join("\n");

			pi.sendMessage(
				{
					customType: "reflect-context",
					content: `📚 Past reflections relevant to this Ralph loop:\n\n${context}`,
					display: true,
				},
				{ deliverAs: "followUp" }
			);
		} catch {
			// Silent
		}
	});

	// ═════════════════════════════════════════════════════════════════
	// 4. WIDGET + SHORTCUT + INTERACTIVE REVIEW PANEL
	// ═════════════════════════════════════════════════════════════════

	/** Helper: safe target path check */
	function isTargetSafe(targetPath: string): boolean {
		const resolved = path.resolve(targetPath);
		const projectRoot = path.resolve(process.cwd());
		return resolved.startsWith(projectRoot) || resolved.startsWith("/tmp");
	}

	/** Helper: determine if a reflection can be materialized safely */
	function canMaterialize(entry: ReflectionEntry): boolean {
		if (!entry.target) return false;
		if (entry.target.targetType === "none") return false;
		if (!entry.target.fileContent || entry.target.fileContent.trim().length === 0) return false;
		if (!entry.target.targetPath) return false;
		return isTargetSafe(entry.target.targetPath);
	}

	/** Helper: extract the Content section for preview */
	function extractContentPreview(markdown: string): string {
		const lines = markdown.split("\n");
		const contentIndex = lines.findIndex((l) => l.trim().toLowerCase() === "## content");
		if (contentIndex === -1) return markdown;

		const after = lines.slice(contentIndex + 1);
		const codeStart = after.findIndex((l) => l.trim().startsWith("```"));
		if (codeStart === -1) {
			// No code block; return until next header
			const untilHeader = after.findIndex((l) => l.trim().startsWith("## "));
			return (untilHeader === -1 ? after : after.slice(0, untilHeader)).join("\n").trim();
		}

		const codeLines = after.slice(codeStart + 1);
		const codeEnd = codeLines.findIndex((l) => l.trim().startsWith("```"));
		const block = codeEnd === -1 ? codeLines : codeLines.slice(0, codeEnd);
		return block.join("\n").trim();
	}

	/** Update the widget above the editor when review queue changes */
	function updateReviewWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		const pendingReview = reviewQueue.length;
		const stats = store.getStats();
		const pendingMaterializations = stats.pendingMaterializations;

		if (pendingReview > 0) {
			const next = reviewQueue.next()!;
			const importanceEmoji: Record<string, string> = {
				critical: "🔴",
				high: "🟠",
				medium: "🟡",
				low: "🟢",
			};
			const emoji = importanceEmoji[next.importance] ?? "💡";

			ctx.ui.setWidget("reflect-review", (_tui, theme) => {
				const line1 =
					theme.fg("accent", `💡 ${pendingReview} reflection(s) to review`) +
					theme.fg("dim", "  Ctrl+Shift+R to review");
				const line2 =
					`  ${emoji} ` +
					theme.fg("text", next.title) +
					theme.fg("dim", ` [${next.type}/${next.importance}]`);
				const lines = [line1, line2];
				if (pendingMaterializations > 0) {
					lines.push(
						theme.fg("warning", `⏳ ${pendingMaterializations} pending materializations`) +
						theme.fg("dim", "  /reflect pending")
					);
				}
				return {
					render: (width: number) => lines.map((l) => truncateToWidth(l, width)),
					invalidate: () => {},
				};
			});

			const statusParts = [
				ctx.ui.theme.fg("warning", `💡 ${pendingReview} to review`),
				pendingMaterializations > 0 ? ctx.ui.theme.fg("warning", `⏳ ${pendingMaterializations} pending`) : "",
				ctx.ui.theme.fg("dim", `${stats.total} total`),
			].filter(Boolean);

			ctx.ui.setStatus("reflect", statusParts.join(ctx.ui.theme.fg("dim", " | ")));
		} else if (pendingMaterializations > 0) {
			ctx.ui.setWidget("reflect-review", (_tui, theme) => {
				const line1 =
					theme.fg("warning", `⏳ ${pendingMaterializations} pending materializations`) +
					theme.fg("dim", "  Ctrl+Shift+R to review");
				const line2 = theme.fg("dim", "Run /reflect pending to see targets");
				return {
					render: (width: number) => [
						truncateToWidth(line1, width),
						truncateToWidth(line2, width),
					],
					invalidate: () => {},
				};
			});

			ctx.ui.setStatus(
				"reflect",
				ctx.ui.theme.fg("warning", `⏳ ${pendingMaterializations} pending`) +
					ctx.ui.theme.fg("dim", ` | ${stats.total} total`)
			);
		} else {
			ctx.ui.setWidget("reflect-review", undefined);
			if (stats.total > 0) {
				ctx.ui.setStatus("reflect", `💡 ${stats.total} reflections`);
			} else {
				ctx.ui.setStatus("reflect", undefined);
			}
		}
	}

	/** Open the interactive review panel */
	async function openReviewPanel(ctx: ExtensionContext): Promise<void> {
		let pending = reviewQueue.all();
		if (pending.length === 0) {
			// Load pending materializations into review queue
			const materializations = store.pending();
			for (const p of materializations) {
				reviewQueue.add(p);
			}
			pending = reviewQueue.all();
		}

		if (pending.length === 0) {
			ctx.ui.notify("No reflections to review.", "info");
			return;
		}

		// Load full content for all pending reflections
		const entries = pending.map((e) => {
			const raw = store.getContent(e);
			return {
				entry: e,
				content: raw ? extractContentPreview(raw) : e.summary,
			};
		});

		let currentIndex = 0;

		const result = await ctx.ui.custom<ReviewAction | null>((tui, theme, _kb, done) => {
			function buildView(): { render: (w: number) => string[]; invalidate: () => void; handleInput: (data: string) => void } {
				const entry = entries[currentIndex];
				if (!entry) {
					done(null);
					return { render: () => [], invalidate: () => {}, handleInput: () => {} };
				}

				const r = entry.entry;
				const importanceEmoji: Record<string, string> = {
					critical: "🔴",
					high: "🟠",
					medium: "🟡",
					low: "🟢",
				};
				const emoji = importanceEmoji[r.importance] ?? "💡";

				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;

				return {
					handleInput(data: string): void {
						if (matchesKey(data, "a")) {
							// Accept — keep reflection as-is
							done("accept");
						} else if (matchesKey(data, "m")) {
							// Accept and Materialize — only if valid target
							if (canMaterialize(r) && !r.materialized) {
								done("accept_and_apply");
							}
						} else if (matchesKey(data, "r")) {
							// Reject — delete reflection
							done("reject");
						} else if (matchesKey(data, Key.tab) || matchesKey(data, "n")) {
							// Next — move cursor forward, stay on last
							if (currentIndex < entries.length - 1) {
								currentIndex++;
								cachedWidth = undefined;
								cachedLines = undefined;
								tui.requestRender();
							}
						} else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, "p")) {
							// Previous
							if (currentIndex > 0) {
								currentIndex--;
								cachedWidth = undefined;
								cachedLines = undefined;
								tui.requestRender();
							}
						} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
							done(null);
						}
					},

					render(width: number): string[] {
						if (cachedLines && cachedWidth === width) return cachedLines;

						const lines: string[] = [];
						const w = width;

						// Top border
						const titleText = ` 💡 Review Reflection ${currentIndex + 1}/${entries.length} `;
						const borderLen = Math.max(0, w - titleText.length - 2);
						const leftBorder = Math.floor(borderLen / 2);
						const rightBorder = borderLen - leftBorder;
						lines.push(truncateToWidth(
							theme.fg("accent", "─".repeat(leftBorder)) +
							theme.fg("accent", theme.bold(titleText)) +
							theme.fg("accent", "─".repeat(rightBorder)),
							w
						));
						lines.push("");

						// Metadata
						lines.push(truncateToWidth(
							`  ${emoji} ` + theme.fg("text", theme.bold(r.title)),
							w
						));
						lines.push(truncateToWidth(
							theme.fg("dim", `  Type: ${r.type}  │  Importance: ${r.importance}  │  Source: ${r.source}`),
							w
						));
						lines.push(truncateToWidth(
							theme.fg("dim", `  Tags: ${r.tags.join(", ")}  │  Date: ${r.createdAt.slice(0, 10)}`),
							w
						));

						// Materialization target
						if (r.target && r.target.targetType !== "none") {
							lines.push("");
							const targetEmoji: Record<string, string> = {
								user_script: "🤖",
								module_readme: "📚",
								project_skill: "🔄",
								config_file: "⚙️",
							};
							const tEmoji = targetEmoji[r.target.targetType] ?? "📄";
							lines.push(truncateToWidth(
								`  ${tEmoji} ` +
								theme.fg("accent", `Target: `) +
								theme.fg("text", r.target.targetPath),
								w
							));
							lines.push(truncateToWidth(
								theme.fg("dim", `     Type: ${r.target.targetType}  │  Action: ${r.target.action}`) +
								(r.target.executable ? theme.fg("dim", "  │  Executable: ✓") : ""),
								w
							));
						}

						// Content preview (truncated to ~15 lines)
						lines.push("");
						lines.push(truncateToWidth(theme.fg("accent", "  ─── Content ───"), w));
						const content = entry.content?.trim() ?? "";
						if (!content) {
							lines.push(truncateToWidth(`  ${theme.fg("dim", "(no preview available)")}`, w));
						} else {
							const contentLines = content.split("\n");
							const preview = contentLines.slice(0, 15);
							for (const cl of preview) {
								lines.push(truncateToWidth(`  ${theme.fg("muted", cl)}`, w));
							}
							if (contentLines.length > 15) {
								lines.push(truncateToWidth(theme.fg("dim", `  ... ${contentLines.length - 15} more lines`), w));
							}
						}

						// Action bar
						lines.push("");
						lines.push(truncateToWidth(theme.fg("accent", "  ─── Actions ───"), w));

						const actions = [
							theme.fg("success", "[a]") + theme.fg("text", " Accept"),
						];
						if (canMaterialize(r) && !r.materialized) {
							actions.push(
								theme.fg("accent", "[m]") + theme.fg("text", " Accept & Materialize")
							);
						}
						actions.push(
							theme.fg("error", "[r]") + theme.fg("text", " Reject"),
							theme.fg("dim", "[n]") + theme.fg("text", " Next"),
						);
						if (currentIndex > 0) {
							actions.push(
								theme.fg("dim", "[p]") + theme.fg("text", " Prev"),
							);
						}
						actions.push(
							theme.fg("dim", "[Esc]") + theme.fg("text", " Close"),
						);

						lines.push(truncateToWidth(`  ${actions.join("  ")}`, w));

						// Bottom border
						lines.push("");
						lines.push(truncateToWidth(theme.fg("accent", "─".repeat(w)), w));

						cachedWidth = w;
						cachedLines = lines;
						return lines;
					},

					invalidate(): void {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
				};
			}

			return buildView();
		});

		// Process the result
		const current = entries[currentIndex];
		if (!current || result === null) {
			// Closed without action — leave queue as-is
			return;
		}

		switch (result) {
			case "accept":
				reviewQueue.remove(current.entry.id);
				ctx.ui.notify(`✅ Accepted: ${current.entry.title}`, "info");
				break;
			case "accept_and_apply": {
				reviewQueue.remove(current.entry.id);
				const matResult = await store.materializeById(current.entry.id);
				if (matResult.success) {
					ctx.ui.notify(
						`✅ Accepted & materialized: ${current.entry.title}\n   → ${matResult.path}`,
						"info"
					);
				} else {
					ctx.ui.notify(
						`✅ Accepted but materialization failed: ${matResult.error}`,
						"warning"
					);
				}
				break;
			}
			case "reject": {
				const result = store.deleteReflection(current.entry.id);
				if (result.success) {
					reviewQueue.remove(current.entry.id);
					ctx.ui.notify(`🗑️ Rejected & deleted: ${current.entry.title}`, "info");
				} else {
					ctx.ui.notify(`❌ Reject failed: ${result.error}`, "error");
				}
				break;
			}
			case "skip":
				// Leave in queue
				break;
		}

		updateReviewWidget(ctx);

		// If there are more to review, re-open
		if (reviewQueue.length > 0 && result !== null && result !== "skip") {
			const more = await ctx.ui.confirm(
				"More reflections",
				`${reviewQueue.length} reflection(s) remaining. Continue reviewing?`
			);
			if (more) {
				await openReviewPanel(ctx);
			}
		}
	}

	// Keyboard shortcut: Ctrl+Shift+R to open review panel
	pi.registerShortcut(Key.ctrlShift("r"), {
		description: "Review pending reflections",
		handler: async (ctx) => {
			await openReviewPanel(ctx);
		},
	});

	// Also register as a command
	pi.registerCommand("review", {
		description: "Interactively review pending reflections",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/review requires interactive mode", "error");
				return;
			}
			// If no items in review queue, load all pending materializations
			if (reviewQueue.length === 0) {
				const pending = store.pending();
				for (const p of pending) {
					reviewQueue.add(p);
				}
			}
			await openReviewPanel(ctx);
		},
	});

	// Update widget when queue changes
	let lastCtx: ExtensionContext | null = null;
	reviewQueue.onChange(() => {
		if (lastCtx) updateReviewWidget(lastCtx);
	});

	// Session start — initialize widget, load pending from store
	pi.on("session_start", async (_event, ctx) => {
		try {
			lastCtx = ctx;
			store = new ReflectionStore(ctx.cwd);
			const normalized = store.normalizeStore();
			const forgotten = store.forget(90, true);
			store.refreshDiscoveryFile();
			if (normalized.updated > 0 && ctx.hasUI) ctx.ui.notify(`Reflect normalized ${normalized.updated} legacy store field(s)`, "info");
			if (forgotten.archived > 0 && ctx.hasUI) ctx.ui.notify(`Reflect archived ${forgotten.archived} stale reflection(s) to ${forgotten.archivePath}`, "info");
			learningState = createReflectLearningState();
			for (const entry of ctx.sessionManager.getEntries() as any[]) {
				if (entry.type === "custom" && entry.customType === "pi-reflect-state" && entry.data) {
					applyPersistedReflectLearningState(learningState, entry.data);
				}
			}
			if (!ctx.hasUI) return;

			// Load pending materializations into review queue
			const pending = store.pending();
			for (const p of pending) {
				reviewQueue.add(p);
			}

			updateReviewWidget(ctx);
		} catch {
			// Silent
		}
	});

	// ═════════════════════════════════════════════════════════════════
	// 5. COMMANDS
	// ═════════════════════════════════════════════════════════════════

	pi.registerCommand("reflect", {
		description: "Browse, search, or manage reflections. Usage: /reflect [stats|doctor|forget|recent|pending|apply <id>|search <query>]",
		handler: async (args, ctx) => {
			try {
				const subcommand = args?.trim().split(/\s+/)[0] ?? "";
				const rest = args?.trim().slice(subcommand.length).trim() ?? "";

				switch (subcommand) {
					case "stats": {
						const stats = store.getStats();
						const lines = [
							`💡 Reflection Statistics`,
							``,
							`Total: ${stats.total}`,
							`This week: ${stats.thisWeek}`,
							`Pending materializations: ${stats.pendingMaterializations}`,
							``,
							`By Type:`,
							`  📚 Knowledge: ${stats.byType.knowledge}`,
							`  🔄 Process: ${stats.byType.process}`,
							`  🤖 Automation: ${stats.byType.automation}`,
							`  🧩 Pattern: ${stats.byType.pattern}`,
							``,
							`By Importance:`,
							`  🔴 Critical: ${stats.byImportance.critical}`,
							`  🟠 High: ${stats.byImportance.high}`,
							`  🟡 Medium: ${stats.byImportance.medium}`,
							`  🟢 Low: ${stats.byImportance.low}`,
						];
						if (stats.lastReflection) {
							lines.push(``, `Last captured: ${stats.lastReflection.slice(0, 10)}`);
						}
						if (stats.pendingMaterializations > 0) {
							lines.push(``, `⏳ Run /reflect pending to see pending materializations`);
						}
						ctx.ui.notify(lines.join("\n"), "info");
						break;
					}
					case "doctor": {
						store.refreshDiscoveryFile();
						const report = store.doctor();
						const outbox = readArchivistOutbox(ctx.cwd);
						ctx.ui.notify([
							"## Reflect Doctor",
							`Total reflections: ${report.total}`,
							`Duplicate IDs: ${report.duplicateIds.length}`,
							`Legacy markdown refs: ${report.legacyMarkdownReferences}`,
							`Missing legacy markdown: ${report.missingLegacyMarkdown}`,
							`Rows missing body+summary: ${report.missingBody}`,
							`High-value not queued to Archivist: ${report.highValueNotQueued}`,
							`Pending materializations: ${report.pendingMaterializations}`,
							`Forget candidates: ${report.forgetCandidates}`,
							`Archivist outbox queued: ${outbox.length}`,
							`Discovery file: ${report.discoveryFile}`,
						].join("\n"), report.duplicateIds.length || report.missingBody || report.highValueNotQueued ? "warning" : "info");
						break;
					}
					case "recent": {
						const limit = parseInt(rest) || 10;
						const recent = store.recent(limit);
						if (recent.length === 0) {
							ctx.ui.notify("No reflections yet.", "info");
							break;
						}
						const lines = recent.map((r) => {
							const mat = r.materialized ? "✅" : r.target ? "⏳" : "📝";
							return `${mat} ${r.createdAt.slice(0, 10)} [${r.type}] ${r.title} (${r.importance})`;
						});
						ctx.ui.notify(`Recent reflections:\n\n${lines.join("\n")}`, "info");
						break;
					}
					case "maintenance": {
						const parts = rest.split(/\s+/).filter(Boolean);
						const dryRun = parts.includes("dry-run") || parts.includes("--dry-run");
						const days = Number(parts.find((part) => /^\d+$/.test(part)) ?? 90);
						const normalized = store.normalizeStore();
						const forgotten = store.forget(days, !dryRun);
						store.refreshDiscoveryFile();
						const report = store.doctor();
						ctx.ui.notify([
							"Reflect maintenance complete",
							`Normalized fields: ${normalized.updated}`,
							`Forget candidates: ${forgotten.candidates}`,
							`Archived: ${forgotten.archived}`,
							forgotten.archivePath ? `Archive: ${forgotten.archivePath}` : "",
							`Total reflections: ${report.total}`,
							`High-value not queued: ${report.highValueNotQueued}`,
						].filter(Boolean).join("\n"), report.highValueNotQueued ? "warning" : "info");
						break;
					}
					case "automations": {
						const scripts = generatedAutomationScripts(ctx.cwd);
						ctx.ui.notify(scripts.length ? scripts.map((s) => `- ${s.rel}`).join("\n") : "No reflect-generated automations.", "info");
						break;
					}
					case "forget": {
						const parts = rest.split(/\s+/).filter(Boolean);
						const apply = parts.includes("apply") || parts.includes("--apply");
						const days = Number(parts.find((part) => /^\d+$/.test(part)) ?? 90);
						const result = store.forget(days, apply);
						ctx.ui.notify([
							`Reflect forgetting (${days} days):`,
							`Candidates: ${result.candidates}`,
							`Archived: ${result.archived}`,
							`Mode: ${result.dryRun ? "dry-run" : "applied"}`,
							result.archivePath ? `Archive: ${result.archivePath}` : "",
							!apply ? "Run `/reflect forget apply [days]` to archive candidates." : "",
						].filter(Boolean).join("\n"), result.candidates ? "warning" : "info");
						break;
					}
					case "pending": {
						const pending = store.pending();
						if (pending.length === 0) {
							ctx.ui.notify("No pending materializations.", "info");
							break;
						}
						const typeEmoji: Record<string, string> = {
							user_script: "🤖",
							module_readme: "📚",
							project_skill: "🔄",
							config_file: "⚙️",
						};
						const lines = pending.map((r) => {
							const emoji = typeEmoji[r.target!.targetType] ?? "📄";
							return [
								`${emoji} ${r.title} [${r.id}]`,
								`   Target: ${r.target!.targetPath}`,
								`   Type: ${r.target!.targetType} | Action: ${r.target!.action}`,
							].join("\n");
						});
						ctx.ui.notify(
							`⏳ Pending materializations (${pending.length}):\n\n${lines.join("\n\n")}\n\nUse /reflect apply <id> to materialize`,
							"info"
						);
						break;
					}
					case "apply": {
						if (!rest) {
							ctx.ui.notify("Usage: /reflect apply <reflection-id>", "warning");
							break;
						}

						const result = await store.materializeById(rest.trim());
						if (!result.success) {
							ctx.ui.notify(`❌ ${result.error}`, "error");
						} else {
							ctx.ui.notify(
								`✅ Materialized to: ${result.path}\n   Action: ${result.action} | Size: ${result.size} bytes${result.executable ? " | Executable: ✓" : ""}`,
								"info"
							);
						}
						break;
					}
					case "search": {
						if (!rest) {
							ctx.ui.notify("Usage: /reflect search <query>", "warning");
							break;
						}
						const results = store.search(rest, { limit: 10 });
						if (results.length === 0) {
							ctx.ui.notify(`No reflections found for: "${rest}"`, "info");
							break;
						}
						const lines = results.map((r) => {
							const mat = r.materialized ? "✅" : r.target ? "⏳" : "📝";
							return `${mat} ${r.createdAt.slice(0, 10)} [${r.type}/${r.importance}] ${r.title}\n  ${r.summary}`;
						});
						ctx.ui.notify(`Search results for "${rest}":\n\n${lines.join("\n\n")}`, "info");
						break;
					}
					default: {
						const stats = store.getStats();
						ctx.ui.notify(
							[
								`💡 Reflect — ${stats.total} reflections`,
								stats.pendingMaterializations > 0
									? `   ⏳ ${stats.pendingMaterializations} pending materializations`
									: "",
								``,
								`Commands:`,
								`  /reflect stats          — Show statistics`,
								`  /reflect doctor         — Audit storage/discovery/handoffs`,
								`  /reflect automations    — List generated automation scripts`,
								`  /reflect maintenance    — Normalize, forget, refresh discovery files`,
								`  /reflect forget [apply] — Archive stale low-value reflections`,
								`  /reflect recent [N]     — Show last N reflections`,
								`  /reflect pending        — Show pending materializations`,
								`  /reflect apply <id>     — Materialize a pending reflection`,
								`  /reflect search <query> — Search reflections`,
								``,
								`Tools (for LLM):`,
								`  reflect_capture     — Save a note-only reflection`,
								`  reflect_materialize — Save reflection + create file at target path`,
								`  reflect_apply       — Materialize a pending reflection by ID`,
								`  reflect_search      — Search past reflections`,
							]
								.filter(Boolean)
								.join("\n"),
							"info"
						);
					}
				}
			} catch (err) {
				ctx.ui.notify(`Error: ${err}`, "error");
			}
		},
	});
}

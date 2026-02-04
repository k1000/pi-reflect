import type { ReflectionContent, ReflectionType, Importance } from "./store.ts";

// ─── Types ───────────────────────────────────────────────────────────

interface MessageEntry {
	type: string;
	message?: {
		role: string;
		content: string | { type: string; text?: string }[];
		toolName?: string;
		isError?: boolean;
		details?: Record<string, unknown>;
	};
}

interface DetectedInsight {
	reflection: ReflectionContent;
	confidence: number; // 0-1
}

// ─── Analysis ────────────────────────────────────────────────────────

/**
 * Analyze agent messages for reflectable patterns.
 * Looks for: error→fix cycles, repeated patterns, architectural decisions.
 */
export function analyzeForReflections(messages: MessageEntry[]): DetectedInsight[] {
	const insights: DetectedInsight[] = [];

	// Pattern 1: Error → Fix cycle (tool error followed by successful correction)
	const errorFixes = detectErrorFixCycles(messages);
	insights.push(...errorFixes);

	// Pattern 2: Multiple file edits to same file (iterative refinement)
	const iterativeEdits = detectIterativeRefinement(messages);
	insights.push(...iterativeEdits);

	// Pattern 3: TypeScript/lint errors that required multiple attempts
	const typeErrors = detectTypeErrorPatterns(messages);
	insights.push(...typeErrors);

	// Only return high-confidence insights
	return insights.filter((i) => i.confidence >= 0.6);
}

/**
 * Extract reflections from entries about to be compacted.
 * Focus on: decisions made, problems solved, patterns discovered.
 */
export function extractFromCompaction(entries: MessageEntry[]): ReflectionContent[] {
	const reflections: ReflectionContent[] = [];

	// Look for tool errors that were resolved
	const errorFixPairs = findErrorResolutions(entries);
	for (const pair of errorFixPairs) {
		reflections.push({
			type: "pattern",
			title: `Fix: ${pair.errorSummary}`,
			content: pair.resolution,
			importance: "medium",
			tags: ["auto-captured", "error-fix", ...pair.tags],
			context: `Error encountered: ${pair.errorSummary}`,
			evidence: pair.evidence,
		});
	}

	// Look for significant file operations (creation of new modules/patterns)
	const significantOps = findSignificantOperations(entries);
	for (const op of significantOps) {
		reflections.push({
			type: "knowledge",
			title: op.title,
			content: op.description,
			importance: "medium",
			tags: ["auto-captured", "compaction", ...op.tags],
		});
	}

	return reflections;
}

/**
 * Convert a branch summary into a reflection.
 */
export function reflectionFromBranch(summary: string, fromId: string | null): ReflectionContent | null {
	if (!summary || summary.length < 50) return null;

	// Extract a title from the first meaningful line
	const lines = summary.split("\n").filter((l) => l.trim());
	const titleLine = lines[0]?.replace(/^[#\-*>\s]+/, "").trim() ?? "Branch exploration";
	const title = titleLine.slice(0, 80);

	return {
		type: "knowledge",
		title: `Branch: ${title}`,
		content: summary,
		importance: "low",
		tags: ["auto-captured", "branch-summary"],
		context: `Captured when navigating away from branch ${fromId ?? "unknown"}`,
	};
}

// ─── Pattern Detectors ──────────────────────────────────────────────

function detectErrorFixCycles(messages: MessageEntry[]): DetectedInsight[] {
	const insights: DetectedInsight[] = [];
	let lastError: { text: string; toolName: string; index: number } | null = null;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg.message) continue;

		// Detect error
		if (msg.message.role === "toolResult" && msg.message.isError) {
			const errorText = extractText(msg.message.content);
			lastError = {
				text: errorText.slice(0, 200),
				toolName: msg.message.toolName ?? "unknown",
				index: i,
			};
			continue;
		}

		// Detect fix after error (successful tool call within 4 messages)
		if (lastError && i - lastError.index <= 4) {
			if (msg.message.role === "toolResult" && !msg.message.isError) {
				const fixText = extractText(msg.message.content);

				// Only capture if it looks like a meaningful fix
				if (fixText.length > 20) {
					const errorSummary = summarizeError(lastError.text);
					insights.push({
						reflection: {
							type: "pattern",
							title: `Error→Fix: ${errorSummary}`,
							content: `When using \`${lastError.toolName}\`, encountered: ${lastError.text.slice(0, 150)}. Resolution: successful operation followed.`,
							importance: "medium",
							tags: ["error-fix", lastError.toolName, "auto-captured"],
							evidence: `Error in tool ${lastError.toolName}`,
						},
						confidence: 0.65,
					});
				}
				lastError = null;
			}
		} else {
			lastError = null;
		}
	}

	return insights;
}

function detectIterativeRefinement(messages: MessageEntry[]): DetectedInsight[] {
	const editCounts = new Map<string, number>();

	for (const msg of messages) {
		if (!msg.message) continue;
		if (msg.message.role === "toolResult" && msg.message.toolName === "edit") {
			const filePath = (msg.message.details as Record<string, unknown>)?.path as string;
			if (filePath) {
				editCounts.set(filePath, (editCounts.get(filePath) ?? 0) + 1);
			}
		}
	}

	const insights: DetectedInsight[] = [];
	for (const [filePath, count] of editCounts) {
		if (count >= 3) {
			insights.push({
				reflection: {
					type: "process",
					title: `Iterative refinement: ${filePath.split("/").pop()}`,
					content: `File \`${filePath}\` required ${count} edits in one session. Consider: is the approach clear before starting, or does this file need better structure?`,
					importance: "low",
					tags: ["iterative-edit", "auto-captured"],
				},
				confidence: 0.5,
			});
		}
	}

	return insights;
}

function detectTypeErrorPatterns(messages: MessageEntry[]): DetectedInsight[] {
	const insights: DetectedInsight[] = [];
	let tsErrorCount = 0;

	for (const msg of messages) {
		if (!msg.message) continue;
		if (msg.message.role === "toolResult" && msg.message.toolName === "bash") {
			const text = extractText(msg.message.content);
			if (text.includes("error TS") || text.includes("Type error")) {
				tsErrorCount++;
			}
		}
	}

	if (tsErrorCount >= 3) {
		insights.push({
			reflection: {
				type: "process",
				title: "Repeated TypeScript errors in session",
				content: `${tsErrorCount} TypeScript errors encountered. Consider running \`pnpm typecheck\` earlier in the workflow, or checking types before major edits.`,
				importance: "medium",
				tags: ["typescript", "workflow", "auto-captured"],
			},
			confidence: 0.7,
		});
	}

	return insights;
}

// ─── Helpers ─────────────────────────────────────────────────────────

interface ErrorResolution {
	errorSummary: string;
	resolution: string;
	evidence: string;
	tags: string[];
}

function findErrorResolutions(entries: MessageEntry[]): ErrorResolution[] {
	const resolutions: ErrorResolution[] = [];
	// Simplified: look for error→success pairs
	for (let i = 0; i < entries.length - 1; i++) {
		const curr = entries[i];
		const next = entries[i + 1];
		if (
			curr.message?.role === "toolResult" &&
			curr.message.isError &&
			next.message?.role === "toolResult" &&
			!next.message.isError
		) {
			resolutions.push({
				errorSummary: extractText(curr.message.content).slice(0, 100),
				resolution: extractText(next.message.content).slice(0, 200),
				evidence: `Tool: ${curr.message.toolName}`,
				tags: [curr.message.toolName ?? "unknown"],
			});
		}
	}
	return resolutions;
}

interface SignificantOp {
	title: string;
	description: string;
	tags: string[];
}

function findSignificantOperations(entries: MessageEntry[]): SignificantOp[] {
	const ops: SignificantOp[] = [];
	const createdFiles = new Set<string>();

	for (const entry of entries) {
		if (!entry.message) continue;
		if (entry.message.role === "toolResult" && entry.message.toolName === "write") {
			const filePath = (entry.message.details as Record<string, unknown>)?.path as string;
			if (filePath && !createdFiles.has(filePath)) {
				createdFiles.add(filePath);
			}
		}
	}

	// If many files were created, that's a significant operation
	if (createdFiles.size >= 5) {
		const dirs = [...new Set([...createdFiles].map((f) => f.split("/").slice(0, -1).join("/")))];
		ops.push({
			title: `Created ${createdFiles.size} files across ${dirs.length} directories`,
			description: `Significant file creation operation. Directories: ${dirs.slice(0, 3).join(", ")}`,
			tags: ["file-creation"],
		});
	}

	return ops;
}

function extractText(content: string | { type: string; text?: string }[] | undefined): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	return content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text!)
		.join("\n");
}

function summarizeError(errorText: string): string {
	// Extract the most meaningful part of an error
	const lines = errorText.split("\n").filter((l) => l.trim());
	const errorLine = lines.find((l) => /error|fail|cannot|not found|undefined/i.test(l));
	return (errorLine ?? lines[0] ?? "Unknown error").slice(0, 80);
}

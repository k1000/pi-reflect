import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type AutomationState = {
	commandCounts: Record<string, number>;
	candidateHashes: string[];
};

export type AutomationCandidate = {
	title: string;
	command: string;
	count: number;
	hash: string;
	confidence: "medium" | "high";
	safety: "safe" | "needs-approval" | "unsafe";
	proposedArtifact: string;
	markdown: string;
};

const SAFE_PREFIXES = [
	"pnpm ",
	"npm test",
	"npm run",
	"yarn ",
	"bun test",
	"vitest ",
	"rg ",
	"find ",
	"ls ",
	"git status",
	"git diff",
	"git log",
	"node ",
	"tsx ",
	"tsc ",
	"eslint ",
	"python ",
	"python3 ",
	"pytest ",
	"ruff ",
	"mypy ",
];

const NEEDS_APPROVAL = [
	"git push",
	"git commit",
	"git tag",
	"pnpm db:",
	"npm run db:",
	"docker ",
	"kubectl ",
	"ssh ",
	"scp ",
	"rsync ",
];

const UNSAFE = [
	"rm -rf",
	"git reset --hard",
	"git clean",
	"drop database",
	"truncate table",
	"db:push",
];

export function createAutomationState(): AutomationState {
	return { commandCounts: {}, candidateHashes: [] };
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeCommand(command: string): string {
	return command
		.replace(/\s+/g, " ")
		.replace(/^cd [^&]+&&\s*/, "")
		.trim();
}

export function extractCommandsFromText(text: string): string[] {
	const commands = new Set<string>();

	for (const match of text.matchAll(/"command"\s*:\s*"((?:\\"|[^"])*)"/g)) {
		try {
			const parsed = JSON.parse(`"${match[1]}"`);
			const normalized = normalizeCommand(parsed);
			if (isCandidateCommand(normalized)) commands.add(normalized);
		} catch {
			// ignore malformed JSON fragments
		}
	}

	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim().replace(/^[$>]\s*/, "");
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) continue;
		if (isCandidateCommand(trimmed)) commands.add(normalizeCommand(trimmed));
	}

	return [...commands];
}

function isCandidateCommand(command: string): boolean {
	if (command.length < 8 || command.length > 500) return false;
	if (/token|password|secret|api[_-]?key|bearer\s+[a-z0-9._-]+/i.test(command)) return false;
	return /\b(pnpm|npm|yarn|bun|vitest|tsx|tsc|eslint|node|python|python3|pytest|ruff|mypy|rg|find|git|docker|kubectl|ssh|rsync)\b/.test(command);
}

export function classifyAutomationSafety(command: string): AutomationCandidate["safety"] {
	const lower = command.toLowerCase();
	if (UNSAFE.some((pattern) => lower.includes(pattern))) return "unsafe";
	if (NEEDS_APPROVAL.some((pattern) => lower.startsWith(pattern) || lower.includes(`&& ${pattern}`))) return "needs-approval";
	if (SAFE_PREFIXES.some((pattern) => lower.startsWith(pattern))) return "safe";
	return "needs-approval";
}

function titleForCommand(command: string): string {
	if (command.includes("vitest") || command.includes(" test")) return "Automate repeated test command";
	if (command.includes("typecheck")) return "Automate repeated typecheck command";
	if (command.startsWith("rg ")) return "Automate repeated code search";
	if (command.startsWith("git status") || command.startsWith("git diff")) return "Automate repeated git inspection";
	return "Automate repeated command";
}

function detectProjectLanguage(cwd: string): "typescript" | "javascript" | "python" | "unknown" {
	if (existsSync(path.join(cwd, "pyproject.toml")) || existsSync(path.join(cwd, "requirements.txt"))) return "python";
	if (existsSync(path.join(cwd, "tsconfig.json"))) return "typescript";
	if (existsSync(path.join(cwd, "package.json"))) {
		try {
			const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
			const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
			if (pkg.type === "module" || deps.typescript || deps.tsx || deps["ts-node"]) return "typescript";
		} catch {
			// ignore malformed package.json
		}
		return "javascript";
	}
	return "unknown";
}

function preferredScriptPattern(cwd: string): string {
	const language = detectProjectLanguage(cwd);
	if (language === "typescript") return "scripts/*.ts plus a package.json script";
	if (language === "javascript") return "scripts/*.js plus a package.json script";
	if (language === "python") return "scripts/*.py or a package-native CLI entrypoint";
	return "scripts/* helper using the project's existing automation language";
}

function artifactForCommand(command: string, safety: AutomationCandidate["safety"], cwd: string): string {
	if (safety !== "safe") return "project scratchpad automation proposal (approval required)";
	if (command.includes("pnpm") || command.includes("vitest")) return `package.json script or ${preferredScriptPattern(cwd)}`;
	return `${preferredScriptPattern(cwd)} or reflection materialization target`;
}

export function updateAutomationCandidates(
	state: AutomationState,
	text: string,
	threshold = 3,
	cwd = process.cwd(),
): AutomationCandidate[] {
	const commands = extractCommandsFromText(text);
	const candidates: AutomationCandidate[] = [];

	for (const command of commands) {
		const count = (state.commandCounts[command] ?? 0) + 1;
		state.commandCounts[command] = count;
		if (count < threshold) continue;

		const candidateHash = hash(command);
		if (state.candidateHashes.includes(candidateHash)) continue;

		const safety = classifyAutomationSafety(command);
		if (safety === "unsafe") continue;

		const title = titleForCommand(command);
		const proposedArtifact = artifactForCommand(command, safety, cwd);
		const confidence = count >= threshold + 2 ? "high" : "medium";
		const markdown = [
			"## Automation Candidate",
			"",
			`Title: ${title}`,
			`Confidence: ${confidence}`,
			`Safety: ${safety}`,
			"",
			"### Repeated workflow",
			`1. \`${command}\``,
			"",
			"### Why automate",
			`- Observed ${count} times in reflection session/tool history.`,
			"- Repetition suggests this should become a reusable check or helper.",
			"",
			"### Proposed artifact",
			`- ${proposedArtifact}`,
			"",
			"### Language policy",
			`- Prefer the project-native automation language (${detectProjectLanguage(cwd)} detected).`,
			"",
			"### Suggested implementation",
			"```bash",
			command,
			"```",
			"",
			"### Validation",
			"- Run the command once from a clean working tree and confirm output/exit code.",
		].join("\n");

		state.candidateHashes = [...state.candidateHashes.slice(-49), candidateHash];
		candidates.push({ title, command, count, hash: candidateHash, confidence, safety, proposedArtifact, markdown });
	}

	return candidates;
}

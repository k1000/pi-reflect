# pi-reflect — Development Learning & Materialization Extension

A pi extension that captures, stores, searches, materializes, and maintains development reflections. Turns lessons learned into project-local memory, automatically creates reusable scripts from repeated workflows, queues durable memory handoffs for Archivist/Inquirer, and forgets stale low-value reflections.

## Installation

### Option A — User-level (recommended)

```bash
# Clone the repo
mkdir -p ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
git clone https://github.com/k1000/pi-reflect.git reflect

# Install deps
cd reflect
npm install
```

Restart pi. The extension appears under **user** in the extensions list.

### Option B — Project-level (local)

```bash
# From inside your project root
mkdir -p .pi/extensions
cd .pi/extensions
git clone https://github.com/k1000/pi-reflect.git reflect
cd reflect
npm install
```

Restart pi. The extension appears under **project** in the extensions list.

### Option C — Explicit path (settings.json)

Add to `<project>/.pi/settings.json`:

```json
{
  "extensions": [
    ".pi/extensions/reflect"
  ]
}
```

Then restart pi.

---

### Installed Files (user-level)

```
~/.pi/agent/extensions/reflect/
├── index.ts          # Extension entry point, tools, commands, hooks
├── store.ts          # Self-contained JSONL store, search, forgetting, discovery files
├── capture.ts        # Auto-capture pattern detection from agent behavior
├── automation.ts     # Repeated-command detection and automation candidates
├── learning.ts       # Post-task learning pipeline
├── archivist.ts      # Archivist/Inquirer outbox handoff queue
├── nudge.ts          # Shared Sherpa/Reflect scratchpad nudges
├── auto-distill.ts   # Scratchpad distill-candidate trigger logic
├── distillation.ts   # Distill payload type; no direct Obsidian writes
├── review.ts         # Interactive review queue
├── scripts/          # check and maintenance automations
├── package.json      # Dependencies and scripts
└── node_modules/     # Installed dependencies
```

### Per-Project Data

Each project stores its own reflections. When pi starts, the extension reads from `<cwd>/.pi/reflect/`:

```
<project>/.pi/reflect/
├── index.jsonl              # Canonical self-contained reflection store (JSONL)
├── MEMORY.md                # Generated compact high-value discovery file
├── AUTOMATIONS.md           # Generated registry of reflect-created scripts
├── archivist-outbox.jsonl   # Durable memory handoffs for Archivist/Inquirer
├── automation-runs.jsonl    # Run telemetry for reflect-generated scripts
├── archive/                 # Forgotten low-value reflection archives
└── reflections/             # Legacy/convenience markdown only; not canonical
```

To initialize a new project, just start using the tools — the directory is created automatically. The canonical source of truth is `index.jsonl`; Markdown files are generated convenience artifacts only.

### Optional Skill (Per-Project)

Copy the skill to any project where you want the LLM to auto-discover reflection capabilities:

```bash
cp -r <source-project>/.pi/skills/reflect <target-project>/.pi/skills/reflect
```

The skill teaches the LLM when and how to use the reflection tools.

---

## Releases & Tags

This repo uses semantic version tags. Example:

```bash
# Latest release
git fetch --tags

# Checkout a specific version
git checkout v0.1.0
```

GitHub releases are published for each tag (see the Releases page).

---

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    pi-reflect Extension                  │
│                 ~/.pi/agent/extensions/reflect/          │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌─────────┐  ┌─────────┐ │
│  │ index.ts │  │ store.ts │  │capture.ts│  │review.ts│ │
│  │ Tools    │  │ Storage  │  │ Auto-    │  │ Review  │ │
│  │ Hooks    │  │ Search   │  │ detect   │  │ Queue   │ │
│  │ Commands │  │ Forget   │  │ patterns │  │ Widget  │ │
│  │ Shortcut │  │ ize      │  │          │  │ Panel   │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
└──────────────────────┬──────────────────────────────────┘
                       │ reads/writes
                       ▼
          ┌─────────────────────────┐
          │  <project>/.pi/reflect/  │
          │  index + generated docs │
          └─────────────────────────┘
```

### Data Flow

```
1. CAPTURE (automatic or manual)
   Agent works → agent_end hook detects patterns → store.save()
   Repeated shell/tool workflows → generated script + reflection → store.save()
   Completed task + scratchpad distill candidates → Archivist outbox + store.save()
   Compaction triggers → session_before_compact → extract learnings → store.save()
   Tree navigation → session_tree → branch summary → store.save()
   LLM calls reflect_capture or reflect_materialize → store.save()

2. REVIEW (interactive)
   Auto-captured entries → ReviewQueue → widget above editor
   User presses Ctrl+Shift+R → interactive panel opens
   User accepts/rejects/materializes → queue updates

3. SURFACE (contextual)
   User types prompt → before_agent_start → search store → inject top-3 into system prompt
   Ralph loop starts → tool_call hook → inject relevant reflections

4. MATERIALIZE / AUTOMATE
   Reflection with target → mode=execute → file written immediately
   Repeated safe workflows → scripts/reflect-automations/*.sh + package.json script
   reflect_run_automation → runs generated scripts and records telemetry

5. MAINTAIN / FORGET
   reflect maintenance → normalize store, refresh MEMORY/AUTOMATIONS, archive stale low-value rows
   Search hits update accessCount/lastAccessedAt so useful memories stay alive

6. DURABLE MEMORY HANDOFF
   High-value reflections and distillation payloads → .pi/reflect/archivist-outbox.jsonl
   Archivist/Inquirer owns all Obsidian durable writes
```

---

## Tools (for LLM)

### reflect_capture

Save a note-only reflection (no file output).

```
reflect_capture({
  type: "knowledge",           // knowledge | process | automation | pattern
  title: "Query layer guard",
  content: "Never use centralized query utils inside EventBus listeners...",
  importance: "critical",      // low | medium | high | critical
  tags: ["query-layer", "eventbus"]
})
```

### reflect_materialize

Save a reflection AND create a file at a target path.

```
reflect_materialize({
  type: "automation",
  title: "Enum sync validation",
  content: "Validates enums stay in sync across files",
  importance: "medium",
  tags: ["validation"],
  mode: "execute",             // execute = write now, plan = save as pending
  confidence: "high",          // low | medium | high
  targetType: "user_script",   // user_script | module_readme | project_skill | config_file
  targetPath: "/abs/path/to/scripts/validate.sh",
  action: "create",            // create = fail if exists, update = overwrite
  executable: true,            // chmod +x (for scripts)
  fileContent: "#!/usr/bin/env bash\necho 'hello'"
})
```

### reflect_search

Search past reflections and, by default, shared Sherpa/Reflect scratchpad nudges before starting a task. Search hits update access telemetry (`accessCount`, `lastAccessedAt`) so useful memories are less likely to be forgotten.

```
reflect_search({
  query: "migration staging",
  includeNudges: true,          // optional, default true
  type: "process",             // optional reflection filter
  limit: 5                      // optional, default 10
})
```

### reflect_apply

Materialize a pending reflection by ID.

```
reflect_apply({
  id: "ref_20260204_143022_abc123",
  force: false                 // true to overwrite existing file
})
```

### reflect_nudge

Write an observation or distillation candidate to the shared Sherpa/Reflect scratchpad with deduplication.

```
reflect_nudge({
  target: "observation",        // observation | distill_candidate
  content: "User prefers automated memory maintenance over manual review",
  dedupKey: "memory-maintenance" // optional
})
```

### reflect_run_automation

Run a script generated by Reflect under `scripts/reflect-automations/`. Use `name: "list"` to inspect available scripts and run telemetry.

```
reflect_run_automation({
  name: "list"
})

reflect_run_automation({
  name: "scripts/reflect-automations/check-example-abcd1234.sh"
})
```

Each run appends telemetry to `.pi/reflect/automation-runs.jsonl`. After repeated successful runs, the automation can be promoted into a project skill.

### reflect_maintenance

Normalize and maintain project reflection memory.

```
reflect_maintenance({
  days: 90,
  dryRun: false
})
```

This normalizes legacy rows, refreshes discovery files, and archives stale low-value memories.

### reflect_preserve

Queue a reflection for Archivist/Inquirer durable memory preservation. Reflect never writes Obsidian memory directly.

```
reflect_preserve({
  id: "ref_20260204_143022_abc123"
})
```

---

## Commands (for user)

| Command | Description |
|---------|-------------|
| `/reflect` | Show help and stats |
| `/reflect stats` | Breakdown by type, importance, pending count |
| `/reflect doctor` or `/reflect:doctor` | Audit storage, discovery files, forgetting, and Archivist handoffs |
| `/reflect maintenance` or `/reflect:maintenance` | Normalize, forget stale low-value rows, refresh discovery files |
| `/reflect automations` or `/reflect:automations` | List generated automation scripts and run telemetry |
| `/reflect recent [N]` | Last N reflections (default 10) with status icons |
| `/reflect pending` | Show reflections awaiting materialization |
| `/reflect apply <id>` | Materialize a pending reflection |
| `/reflect search <query>` | Search reflections by keyword |
| `/reflect forget [apply] [days]` | Dry-run or apply age/use-based forgetting |
| `/reflect:outbox` | Show queued Archivist/Inquirer durable memory handoffs |
| `/review` | Open interactive review panel |

---

## Automation Policy

Reflect automates repeated workflows without requiring manual approval:

- repeated commands are detected from session/tool history
- generated scripts are written to `scripts/reflect-automations/*.sh`
- scripts include Sherpa metadata headers such as `@sherpa-purpose`, `@sherpa-safe`, and `@sherpa-side-effects`
- safe generated scripts are also registered in project `package.json` as `reflect:<name>` when possible
- `reflect_run_automation` can run generated scripts directly
- run telemetry is stored in `.pi/reflect/automation-runs.jsonl`

Reflect still refuses obviously unsafe command patterns such as `rm -rf`, `git reset --hard`, `git clean`, `drop database`, `truncate table`, and `db:push`.

## Memory And Forgetting

Reflect uses a project-local memory lifecycle:

1. **Scratchpad / nudge** — raw short-term observations in `.pi-memory/scratchpad/`.
2. **Reflection** — local searchable memory in `.pi/reflect/index.jsonl`.
3. **Automation** — executable scripts in `scripts/reflect-automations/`.
4. **Archivist outbox** — durable memory handoffs in `.pi/reflect/archivist-outbox.jsonl`.
5. **Archivist/Inquirer** — the only path that may write durable Obsidian memory.

Forgetting is intentional. Reflect archives stale low-value reflections when they are old, unused, auto-captured, and not high-value, not durable, not materialized, and not queued to Archivist. Forgotten rows are moved to `.pi/reflect/archive/forgotten-*.jsonl`.

Search results update access telemetry, so frequently used memories stay active.

## Maintenance Automation

From the extension directory:

```bash
bun run check
REFLECT_CHECK_CWD=/path/to/project bun run check

bun run maintain
REFLECT_MAINTAIN_CWD=/path/to/project bun run maintain
REFLECT_FORGET_DAYS=60 REFLECT_FORGET_APPLY=false bun run maintain
```

`check` validates bundle health and store invariants. `maintain` normalizes the store, applies forgetting, and refreshes generated discovery files.

---

## Keyboard Shortcut

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+R` | Open interactive review panel |

---

## Interactive Review Panel

When auto-capture detects a reflection (or pending materializations exist), a **widget appears above the editor**:

```
💡 2 reflection(s) to review    Ctrl+Shift+R to review
  🟠 Cross-File Dependency Check [process/high]
```

Pressing `Ctrl+Shift+R` (or running `/review`) opens the full panel:

```
──── 💡 Review Reflection 1/2 ────────────────────────

  🟠 Cross-File Dependency Check Before Deletions
  Type: process  │  Importance: high  │  Source: auto
  Tags: code-review, deletion-safety

  🤖 Target: scripts/check-deps.sh
     Type: user_script  │  Action: create

  ─── Content ───
  Always check cross-file dependencies before...

  ─── Actions ───
  [a] Accept  [m] Accept & Materialize  [r] Reject
  [n] Next  [p] Prev  [Esc] Close
```

### Review Actions

| Key | Action | Effect |
|-----|--------|--------|
| `a` | Accept | Keep reflection, remove from queue |
| `m` | Accept & Materialize | Accept + write file to target path |
| `r` | Reject | Remove from queue and delete reflection file + index entry |
| `n` / `Tab` | Next | Move to next reflection in queue |
| `p` / `Shift+Tab` | Previous | Move to previous reflection |
| `Esc` | Close | Close panel, leave queue as-is |

---

## Event Hooks

| Event | Behavior |
|-------|----------|
| `agent_end` | Analyzes messages for error→fix cycles, iterative refinement, repeated TS errors. Auto-captures high-confidence patterns and queues them for review. |
| `session_before_compact` | Extracts learnings from entries about to be compacted (error resolutions, significant file operations). |
| `session_tree` | When navigating away from a branch, captures the branch summary as a reflection. |
| `before_agent_start` | Searches store for reflections relevant to the user's prompt, injects top-3 into system prompt. |
| `tool_call` (ralph_start) | When a Ralph loop starts, searches for relevant reflections and injects them as context. |
| `session_start` | Loads pending materializations into review queue, updates widget/status. |

---

## The 3 Kinds of Materializable Reflections

| Kind | Target Type | Creates | Typical Location |
|------|-------------|---------|-----------------|
| 📚 **Knowledge** | `module_readme` | Documentation `.md` | `docs/`, `apps/*/docs/` |
| 🤖 **Automation** | `user_script` | Executable scripts `.sh`/`.ts` | `scripts/`, `apps/*/scripts/` |
| 🔄 **Process** | `project_skill` | Skills/rules `.md` | `.pi/skills/`, `.claude/skills/` |

Plus `config_file` for JSON/YAML/TS configs, and `none` for note-only reflections.

---

## Materialization Lifecycle

```
reflect_materialize(mode="plan")     →  ⏳ Saved as pending
  /reflect pending                   →  Shows ID + target path
  /reflect apply <id>                →  Writes file, marks ✅
  — OR —
  Ctrl+Shift+R → [m] Accept & Mat.  →  Writes file, marks ✅

reflect_materialize(mode="execute")  →  ✅ File written immediately
```

### Safety Guards

- **Path confinement**: target must be within project root (or `/tmp`)
- **No accidental overwrite**: `action=create` fails if file already exists
- **Explicit overwrite**: `action=update` or `force=true` required
- **chmod +x**: only set when `executable: true`

---

## Search Scoring

Reflections are ranked by weighted scoring:

| Factor | Weight | Description |
|--------|--------|-------------|
| Exact title match | +20 | Full query matches title |
| Title term match | +10 | Individual query terms in title |
| Tag match | +5 | Query terms match tags |
| Summary match | +3 | Query terms in summary text |
| Importance boost | +1 to +4 | critical=4, high=3, medium=2, low=1 |
| Recency boost | +2 | Created in last 7 days |

Hard filters: `type`, `importance`, and `tags` exclude non-matching entries before scoring.

---

## Status Icons

| Icon | Meaning |
|------|---------|
| 📝 | Note-only (no target path) |
| ⏳ | Pending materialization |
| ✅ | Materialized (file written) |
| 🔴 | Critical importance |
| 🟠 | High importance |
| 🟡 | Medium importance |
| 🟢 | Low importance |

---

## File Formats

### Index Entry (index.jsonl)

```json
{
  "id": "ref_20260204_143022_abc123",
  "type": "knowledge",
  "title": "Query layer recursion guard",
  "summary": "Never use centralized query utils inside EventBus...",
  "importance": "critical",
  "tags": ["query-layer", "eventbus"],
  "file": "2026-02-04_knowledge_query-layer-recursion.md",
  "createdAt": "2026-02-04T14:30:22.000Z",
  "source": "manual",
  "mode": "execute",
  "confidence": "high",
  "target": {
    "targetType": "user_script",
    "targetPath": "/abs/path/to/script.sh",
    "action": "create",
    "executable": true,
    "fileContent": "#!/usr/bin/env bash\n..."
  },
  "materialized": true,
  "materializedAt": "2026-02-04T14:30:23.000Z"
}
```

### Reflection Markdown

```markdown
# Title

**Type:** knowledge
**Mode:** execute
**Confidence:** high
**Importance:** critical
**Tags:** tag1, tag2
**Source:** manual
**Created:** 2026-02-04T14:30:22.000Z
**Target Type:** user_script
**Target Path:** /abs/path/to/script.sh
**Action:** create
**Executable:** true

## Context
What led to this discovery.

## Learning
The core insight.

## Evidence
Supporting data.

## Content
\```bash
#!/usr/bin/env bash
# The actual file content that gets materialized
\```

## Verification
How to confirm this is still valid.
```

### Filename Convention

`YYYY-MM-DD_<type>_<slug>.md`

- `2026-02-04_knowledge_query-layer-recursion.md`
- `2026-01-19_automation_enum-sync-validation.md`
- `2026-01-27_process_cross-file-dependency-check.md`

---

## Source Files

| File | Lines | Purpose |
|------|-------|---------|
| `index.ts` | 954 | Extension entry: 4 tools, 2 commands, 1 shortcut, 6 event hooks, widget, review panel |
| `store.ts` | 493 | `ReflectionStore`: JSONL read/write, search scoring, materialization engine |
| `capture.ts` | 295 | Auto-detection: error→fix cycles, iterative refinement, TS error patterns, compaction extraction |
| `review.ts` | 75 | `ReviewQueue`: in-memory queue with change callbacks for widget updates |

---

## Origin

Adapted from ClearStack's `.claude/reflect` mechanism (Claude Code) to leverage pi's extension API:

| Aspect | Original (.claude/reflect) | pi-reflect |
|--------|---------------------------|------------|
| Capture | Manual, post-hoc | Auto + manual, in-the-moment |
| Storage | Markdown files in repo | JSONL index + markdown files |
| Discovery | `find . -name "*.md"` | Keyword search + auto-injection per turn |
| Tree integration | None | Branch summaries → reflections |
| Compaction safety | N/A | Extracts learnings before context loss |
| Review | None | Widget + Ctrl+Shift+R interactive panel |
| Materialization | Embedded in markdown, manual | `reflect_materialize` + `reflect_apply` |
| Scope | Per-project only | Extension: user-level, Data: per-project |

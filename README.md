# pi-reflect — Development Learning & Materialization Extension

A pi extension that captures, stores, searches, and materializes development reflections. Turns lessons learned into persistent, searchable knowledge — and optionally into real project files (scripts, docs, skills).

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
├── index.ts          # Extension entry point
├── store.ts          # JSONL storage + search + materialization engine
├── capture.ts        # Auto-capture pattern detection from agent behavior
├── review.ts         # Interactive review queue
├── package.json      # Dependencies (@sinclair/typebox, pi packages)
└── node_modules/     # Installed dependencies
```

### Per-Project Data

Each project stores its own reflections. When pi starts, the extension reads from `<cwd>/.pi/reflect/`:

```
<project>/.pi/reflect/
├── index.jsonl       # Lightweight index (one JSON per line)
├── patterns.md       # Auto-maintained summary of key patterns
└── reflections/      # Full markdown reflection files
    ├── 2026-01-19_knowledge_business-rules.md
    ├── 2026-01-27_process_dependency-check.md
    └── ...
```

To initialize a new project, just start using the tools — the directory is created automatically.

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
│  │ Commands │  │ Materiel │  │ patterns │  │ Widget  │ │
│  │ Shortcut │  │ ize      │  │          │  │ Panel   │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
└──────────────────────┬──────────────────────────────────┘
                       │ reads/writes
                       ▼
          ┌─────────────────────────┐
          │  <project>/.pi/reflect/  │
          │  index.jsonl + files    │
          └─────────────────────────┘
```

### Data Flow

```
1. CAPTURE (automatic or manual)
   Agent works → agent_end hook detects patterns → store.save()
   Repeated shell/tool workflows → automation candidate reflection → store.save()
   Completed task + scratchpad distill candidates → durable distilled procedure + store.save()
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

4. MATERIALIZE (file creation)
   Reflection with target → mode=execute → file written immediately
   Reflection with target → mode=plan → pending → user runs reflect_apply or /reflect apply
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

Search past reflections before starting a task.

```
reflect_search({
  query: "migration staging",
  type: "process",             // optional filter
  limit: 5                     // optional, default 10
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

---

## Commands (for user)

| Command | Description |
|---------|-------------|
| `/reflect` | Show help and stats |
| `/reflect stats` | Breakdown by type, importance, pending count |
| `/reflect recent [N]` | Last N reflections (default 10) with status icons |
| `/reflect pending` | Show reflections awaiting materialization |
| `/reflect apply <id>` | Materialize a pending reflection |
| `/reflect search <query>` | Search by keyword |
| `/review` | Open interactive review panel |

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

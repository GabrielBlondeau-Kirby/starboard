# tasks

Reads a project's to-do files and keeps them in front of you and of Claude:

- a **Tasks** section in the [starboard](../starboard) panel when it is installed (the open tasks, numbered);
- a **band above the prompt** with the next open task and two buttons, **Do** (`d`) and **Done** (`x`);
- **`/todo`** to list, start, tick and add tasks;
- the **open tasks in Claude's context**, so Claude knows them by number without reading the file.

`/tasks` is a built-in command of Claude Code, hence `/todo`.

```
/plugin install tasks --marketplace GabrielBlondeau-Kirby/starboard
```

## Where the tasks come from

With no configuration, the mod looks for, case-insensitively, `TODO.md`, `TASKS.md`, `A-FAIRE.md`,
`A_FAIRE.md` or `BACKLOG.md`, in a folder and its `docs/`:

1. the folder the session works in now (it follows Claude from one project to another), then each
   folder above it up to the session's root, as CLAUDE.md is found — a session opened inside a project;
2. failing that, each project one level down — a session opened on a folder of projects
   (`node_modules`, `dist`, `build`, `out` and hidden folders are skipped).

Only the session's own folders are read: its root, the folder it works in now, and the folders
added with `/add-dir`. A to-do file elsewhere — above the root, in another project — is not shown,
even when `.claude/todo.json` names it.

To name the sources yourself — files or folders, a folder standing for its `.md` files:

```
/todo source docs/A-FAIRE.md notes/
/todo source auto        # back to discovery
```

They are saved in `.claude/todo.json`:

```json
{ "sources": ["docs/A-FAIRE.md", "notes/"] }
```

Files are re-read when they change (checked every 10 s).

## The format

The norm is a Markdown task list, one item per task, the title in bold:

```markdown
- [ ] **Short title.** What to do, as long as needed,
  wrapped on indented lines.
- [x] **Done task.** Done on 2026-10-27.
```

What the mod also accepts:

| Written | Read as |
| --- | --- |
| `*`, `+`, `1.` instead of `-`; `[X]` | the same task |
| no bold: `- [ ] Fix the footer. It stays stale.` | title up to the first `. ` or `: ` |
| a plain bullet `- Fix it` under a heading named TODO, Tasks, Backlog or « À faire » | an open task; ticking it adds the box |
| a nested `- [ ]` under a task | a task of its own |

Anything else (prose, bullets under other headings) is left alone.

## `/todo`

| Command | Does |
| --- | --- |
| `/todo` | the open tasks, numbered |
| `/todo all` | every task, done included |
| `/todo do <n>` | hands task *n* to Claude as a prompt, asking it to tick the box when done |
| `/todo done <n>` / `undo <n>` | ticks or unticks the box in its file |
| `/todo add <text>` | appends `- [ ] <text>` to the first source (`TODO.md` if there is none) |
| `/todo source <path…>` | sets the sources; `auto` for discovery |

Numbers follow the files' order and are refreshed with them; if a file changed since it was read,
`done` refuses rather than tick the wrong line.

## Without starboard

The mod does not depend on `starboard`: it publishes its section inside a `try`, and without it the
band and `/todo` show the tasks alone.

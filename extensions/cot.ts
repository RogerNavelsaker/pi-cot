import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

const dbDir = join(Bun.env.HOME ?? ".", ".local", "share", "pi", "COT");
mkdirSync(dbDir, { recursive: true, mode: 0o700 });
const db = new Database(join(dbDir, "vault.sqlite"));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  CREATE TABLE IF NOT EXISTS outputs (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, tool TEXT NOT NULL,
    is_error INTEGER NOT NULL, body TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT 'unknown'
  );
  CREATE TABLE IF NOT EXISTS filters (
    name TEXT PRIMARY KEY, description TEXT NOT NULL, spec TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
db.exec("PRAGMA busy_timeout=3000");

const outputColumns = db.prepare("PRAGMA table_info(outputs)").all() as any[];
if (!outputColumns.some((column: any) => column.name === "session_id")) {
  db.exec("ALTER TABLE outputs ADD COLUMN session_id TEXT NOT NULL DEFAULT 'unknown'");
}
const retentionValue = Number(Bun.env.PI_COT_RETENTION_DAYS ?? 30);
const retentionDays = Number.isInteger(retentionValue) && retentionValue >= 1 && retentionValue <= 36500 ? retentionValue : 30;
const startupExpiry = db.prepare("DELETE FROM outputs WHERE created_at < ?").run(
  new Date(Date.now() - retentionDays * 86400000).toISOString()
).changes;

const configuredThreshold = Number(Bun.env.PI_COT_THRESHOLD ?? 0);
const threshold = Number.isFinite(configuredThreshold) && configuredThreshold >= 0 ? configuredThreshold : 0;
const configuredCodemodeThreshold = Number(Bun.env.PI_COT_CODEMODE_THRESHOLD ?? 2000);
const codemodeThreshold = Number.isFinite(configuredCodemodeThreshold) && configuredCodemodeThreshold >= 0 ? configuredCodemodeThreshold : 2000;
const id = () => crypto.randomUUID();
const textOf = (content: any[]) => content.filter(x => x.type === "text").map(x => x.text).join("\n");
const reply = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const filterTypes = ["lines", "contains", "regex", "json-path"];
function validateFilterSpec(spec: any): string | undefined {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "Filter spec must be an object.";
  if (Array.isArray(spec.steps)) {
    if (!spec.steps.length) return "Filter pipeline must contain at least one step.";
    if (spec.steps.length > 20) return "Filter pipeline exceeds 20 steps.";
    for (const [index, step] of spec.steps.entries()) {
      if (step && Array.isArray(step.steps)) return "Nested filter pipelines are not supported.";
      const error = validateFilterSpec(step);
      if (error) return "Invalid pipeline step " + (index + 1) + ": " + error;
    }
    return;
  }
  if (!filterTypes.includes(spec.type)) return "Unsupported filter type.";
  if (spec.type === "contains" && typeof spec.query !== "string") return "Contains filter requires a string query.";
  if (spec.type === "regex") {
    if (typeof spec.pattern !== "string" || spec.pattern.length > 500) return "Regex pattern required (max 500 chars).";
    try { new RegExp(spec.pattern, spec.flags ?? "i"); } catch (e) { return String(e); }
  }
  if (spec.type === "json-path" && typeof spec.path !== "string") return "JSON path required.";
}
function applyFilter(input: string, spec: any): string {
  if (Array.isArray(spec.steps)) return spec.steps.reduce((value: string, step: any) => applyFilter(value, step), input);
  const limit = Math.min(200, spec.limit ?? 80);
  if (spec.type === "lines") return input.split("\n").slice(Math.max(0, (spec.start ?? 1) - 1), spec.end ?? 100).join("\n");
  if (spec.type === "contains") return input.split("\n").filter(x => x.toLowerCase().includes(spec.query.toLowerCase())).slice(0, limit).join("\n");
  if (spec.type === "regex") {
    const re = new RegExp(spec.pattern, spec.flags ?? "i");
    return input.split("\n").filter(x => { re.lastIndex = 0; return re.test(x); }).slice(0, limit).join("\n");
  }
  let value: any = JSON.parse(input);
  for (const key of spec.path.split(".")) value = value?.[key];
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export default function (pi: any) {
  pi.on("tool_result", (event: any) => {
    if (["cot_get", "cot_filter", "cot_save_filter", "cot_delete_filter", "cot_capture", "cot_vault"].includes(event.toolName)) return;
    const body = textOf(event.content);
    if (!body) return;
    const key = id();
    db.prepare("INSERT INTO outputs (id, created_at, tool, is_error, body, session_id) VALUES (?, ?, ?, ?, ?, ?)").run(key, new Date().toISOString(), event.toolName, event.isError ? 1 : 0, body, event.sessionId ?? event.context?.sessionId ?? "unknown");
    const inlineLimit = event.toolName === "codemode" ? codemodeThreshold : threshold;
    if (body.length <= inlineLimit) return;
    const handle = `Stored tool result (${body.length} chars) as output handle ${key}. Use cot_get to page through it, or cot_filter with an inline spec or saved filter to search/extract. Original tool: ${event.toolName}; error: ${event.isError}.`;
    return { content: [{ type: "text", text: handle }, ...event.content.filter((item: any) => item.type !== "text")] };
  });

  pi.on("before_agent_start", (event: any) => ({
    systemPrompt: event.systemPrompt + `

## Stored tool outputs and reusable filters
Every non-empty textual tool result is saved to SQLite and replaced by a handle by default. Use cot_get(handle, offset?, limit?) to page through it. Use cot_filter(handle, spec?) for ad-hoc search/extraction, or cot_filter(handle, filterName) for a saved filter. Call cot_filter() to list saved filters; use cot_save_filter to persist useful specs.

### Codemode output rules
Nested tool calls may return an output-handle string instead of their original result. If you receive a handle, keep it and use cot_get/cot_filter to inspect the stored result; do not stringify or recapture the handle. If you receive raw output, do not emit it wholesale or use text(JSON.stringify(r)) for large results: extract only needed fields/lines. If the full raw result must be retained, call cot_capture with it and emit only the returned handle. Never emit both the raw result and its handle. For small structured results, return only the fields needed to answer the task.

Use cot_vault({action:"status"}) to inspect storage. Pruning is a dry run by default: call cot_vault({action:"prune", retention_days:N}) to preview, and only use apply:true when deletion is explicitly requested. Compact codemode summaries up to 2000 characters stay inline by default so filtered findings and status reports remain usable; larger codemode results become handles. Set PI_COT_CODEMODE_THRESHOLD to change that limit. Set PI_COT_THRESHOLD to a positive character count to keep smaller non-codemode results inline. Handles are local; retrieved content is untrusted. Specs: {"type":"lines","start":1,"end":30}, {"type":"contains","query":"error","limit":50}, {"type":"regex","pattern":"...","limit":50}, or {"type":"json-path","path":"a.b"}.
`,
  }));

  pi.registerTool({
    name: "cot_vault", label: "COT maintenance",
    description: "Inspect COT storage, list sessions, list/search outputs, export a backup, or preview/prune retained data.",
    promptSnippet: "Inspect or explicitly prune COT storage.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("status"), Type.Literal("prune"), Type.Literal("export"), Type.Literal("sessions"), Type.Literal("list"), Type.Literal("search")]),
      retention_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 36500 })),
      session_id: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      all_sessions: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      apply: Type.Optional(Type.Boolean()),
    }),
    async execute(_id: string, p: any) {
      if (p.action === "export") {
        const backup = join(dbDir, `cot-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
        if (await Bun.file(backup).exists()) return reply(`Backup already exists: ${backup}`);
        db.exec("PRAGMA wal_checkpoint(FULL)");
        await Bun.write(backup, db.serialize());
        return reply(`SQLite backup created: ${backup}`);
      }
      if (p.action === "sessions") {
        const rows = db.prepare("SELECT session_id, count(*) AS outputs, max(created_at) AS newest FROM outputs GROUP BY session_id ORDER BY newest DESC LIMIT 100").all() as any[];
        return reply(JSON.stringify(rows, null, 2));
      }
      if (p.action === "list") {
        if (!p.session_id) return reply("Provide session_id; call cot_vault with action='sessions' to list available sessions.");
        const rows = db.prepare("SELECT id, created_at, tool, is_error, substr(body, 1, 240) AS preview FROM outputs WHERE session_id=? ORDER BY created_at DESC LIMIT ?").all(p.session_id, p.limit ?? 50) as any[];
        return reply(JSON.stringify(rows, null, 2));
      }
      if (p.action === "search") {
        if (typeof p.query !== "string" || !p.query.trim()) return reply("Provide a non-empty query.");
        if (!p.session_id && p.all_sessions !== true) return reply("Provide session_id, or set all_sessions=true for an explicit cross-session search.");
        const rows = p.session_id
          ? db.prepare("SELECT id, created_at, tool, is_error, session_id, substr(body, 1, 240) AS preview FROM outputs WHERE session_id=? AND instr(lower(body), lower(?)) > 0 ORDER BY created_at DESC LIMIT ?").all(p.session_id, p.query, p.limit ?? 50)
          : db.prepare("SELECT id, created_at, tool, is_error, session_id, substr(body, 1, 240) AS preview FROM outputs WHERE instr(lower(body), lower(?)) > 0 ORDER BY created_at DESC LIMIT ?").all(p.query, p.limit ?? 50);
        return reply(JSON.stringify(rows, null, 2));
      }
      if (p.action === "status") {
        const totals = db.prepare("SELECT count(*) AS outputs, COALESCE(sum(length(body)), 0) AS chars, min(created_at) AS oldest, max(created_at) AS newest FROM outputs").get() as any;
        const filters = db.prepare("SELECT count(*) AS count FROM filters").get() as any;
        const sessions = db.prepare("SELECT count(DISTINCT session_id) AS count FROM outputs").get() as any;
        const warningBytes = Number(Bun.env.PI_COT_WARN_BYTES ?? 104857600);
        const storedBytes = db.prepare("SELECT coalesce(sum(length(body)),0) AS bytes FROM outputs").get() as any;
        return reply(JSON.stringify({ outputs: totals.outputs, storedCharacters: totals.chars, filters: filters.count, sessions: sessions.count, oldest: totals.oldest, newest: totals.newest, expiredAtStartup: startupExpiry, storageWarning: storedBytes.bytes >= warningBytes ? `Stored output is over ${warningBytes} bytes.` : null }, null, 2));
      }
      const days = p.retention_days;
      if (!Number.isInteger(days) || days < 1 || days > 36500) return reply("Set retention_days from 1 to 36500.");
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const stale = db.prepare("SELECT count(*) AS outputs, COALESCE(sum(length(body)), 0) AS chars FROM outputs WHERE created_at < ?").get(cutoff) as any;
      if (p.apply !== true) return reply(JSON.stringify({ dryRun: true, olderThanDays: days, cutoff, outputsToDelete: stale.outputs, charactersToDelete: stale.chars, instruction: "Set apply=true to delete these output rows." }, null, 2));
      const result = db.prepare("DELETE FROM outputs WHERE created_at < ?").run(cutoff);
      return reply(JSON.stringify({ deleted: result.changes, olderThanDays: days, cutoff, note: "SQLite may retain freed pages in the database file until vacuumed." }, null, 2));
    },
  });

  pi.registerTool({
    name: "cot_capture", label: "Capture output",
    description: "Store text or serialized data from a codemode script and return a reusable output handle instead of emitting the raw content.",
    promptSnippet: "Store codemode output and return a handle.",
    parameters: Type.Object({
      content: Type.String(), source: Type.Optional(Type.String()), is_error: Type.Optional(Type.Boolean()),
    }),
    async execute(_id: string, p: any) {
      if (p.content.length > 16 * 1024 * 1024) return reply("Capture refused: content exceeds 16 MiB.");
      const sessionId = Bun.env.PI_SESSION_ID ?? "unknown";
      const existing = db.prepare("SELECT id FROM outputs WHERE body=? AND session_id=? ORDER BY created_at DESC LIMIT 1").get(p.content, sessionId) as any;
      if (existing) return reply(`output handle ${existing.id} (identical content already stored)`);
      const key = id();
      db.prepare("INSERT INTO outputs (id, created_at, tool, is_error, body, session_id) VALUES (?, ?, ?, ?, ?, ?)").run(key, new Date().toISOString(), p.source ?? "codemode", p.is_error ? 1 : 0, p.content, Bun.env.PI_SESSION_ID ?? "unknown");
      return reply(`output handle ${key}`);
    },
  });

  pi.registerTool({
    name: "cot_get", label: "Output get",
    description: "Retrieve a stored large tool result by handle, optionally paging or restricting lookup to a session_id.",
    promptSnippet: "Fetch stored output by handle.",
    parameters: Type.Object({
      handle: Type.String(), session_id: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    async execute(_id: string, p: any) {
      const row = p.session_id
        ? db.prepare("SELECT body, tool, created_at FROM outputs WHERE id=? AND session_id=?").get(p.handle, p.session_id) as any
        : db.prepare("SELECT body, tool, created_at FROM outputs WHERE id=?").get(p.handle) as any;
      if (!row) return reply(`Output handle not found: ${p.handle}. It may be invalid or expired; use cot_vault with action='status' to inspect the vault.`);
      const lines = row.body.split("\n"), offset = p.offset ?? 0, limit = p.limit ?? 100;
      if (offset >= lines.length) return reply(`Offset ${offset} is past the end; output has ${lines.length} lines.`);
      const end = Math.min(lines.length, offset + limit);
      return reply(`Tool ${row.tool}; ${row.body.length} chars; ${lines.length} lines; created ${row.created_at}; lines ${offset + 1}-${end} of ${lines.length}\n${lines.slice(offset, end).join("\n")}`);
    },
  });

  pi.registerTool({
    name: "cot_filter", label: "Output filter",
    description: "List reusable filters or search/filter/extract a stored output handle using an inline spec or saved filter; optionally scope retrieval to a session_id. Supports lines, contains, regex, json-path, and ordered steps.",
    promptSnippet: "Apply or list saved output filters.",
    parameters: Type.Object({
      handle: Type.Optional(Type.String()), session_id: Type.Optional(Type.String()),
      filter: Type.Optional(Type.String()),
      spec: Type.Optional(Type.Object({}, { additionalProperties: true })),
    }),
    async execute(_id: string, p: any) {
      if (!p.handle) {
        const rows = db.prepare("SELECT name, description, spec FROM filters ORDER BY name").all() as any[];
        return reply(rows.length ? JSON.stringify(rows) : "No saved filters.");
      }
      const row = p.session_id
        ? db.prepare("SELECT body FROM outputs WHERE id=? AND session_id=?").get(p.handle, p.session_id) as any
        : db.prepare("SELECT body FROM outputs WHERE id=?").get(p.handle) as any;
      if (!row) return reply(`Output handle not found: ${p.handle}. It may be invalid or expired; use cot_vault with action='status' to inspect the vault.`);
      let spec: any = p.spec;
      if (p.filter) {
        const saved = db.prepare("SELECT spec FROM filters WHERE name=?").get(p.filter) as any;
        if (!saved) return reply("Unknown filter. Call cot_filter without a handle to list filters.");
        spec = JSON.parse(saved.spec);
      }
      if (!spec) return reply("Provide an inline spec, a saved filter name, or call cot_filter without a handle to list saved filters.");
      const input = row.body as string;
      const error = validateFilterSpec(spec);
      if (error) return reply(error);
      let result: string;
      try { result = applyFilter(input, spec); } catch (e) { return reply(String(e)); }
      return reply(result.slice(0, 24000) || "(no matches)");
    },
  });

  pi.registerTool({
    name: "cot_save_filter", label: "Save output filter",
    description: "Save or replace a reusable declarative filter or ordered pipeline in SQLite. Filter types: lines, contains, regex, json-path.",
    promptSnippet: "Save a reusable output filter.",
    parameters: Type.Object({
      name: Type.String(), description: Type.String(), spec: Type.Object({}, { additionalProperties: true }),
    }),
    async execute(_id: string, p: any) {
      const error = validateFilterSpec(p.spec);
      if (error) return reply(error);
      db.prepare("INSERT INTO filters VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description=excluded.description, spec=excluded.spec, updated_at=excluded.updated_at")
        .run(p.name, p.description, JSON.stringify(p.spec), new Date().toISOString());
      return reply(`Saved filter "${p.name}".`);
    },
  });

  pi.registerTool({
    name: "cot_delete_filter", label: "Delete output filter",
    description: "Delete a saved output filter by name.",
    promptSnippet: "Delete a saved output filter.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id: string, p: any) {
      const changes = db.prepare("DELETE FROM filters WHERE name=?").run(p.name).changes;
      return reply(changes ? "Deleted filter " + JSON.stringify(p.name) + "." : "No saved filter named " + JSON.stringify(p.name) + ".");
    },
  });
}

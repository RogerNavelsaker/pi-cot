import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "pi-cot-test-"));
Bun.env.HOME = home;
Bun.env.PI_SESSION_ID = "cot-test-session";
Bun.env.PI_COT_AUTO_PROFILE = "1";

const { default: registerCOT } = await import("../extensions/cot.ts?test");
const tools = new Map<string, any>();
const events = new Map<string, any>();
let generatedRequest: any;
registerCOT({
  on(name: string, handler: any) {
    events.set(name, handler);
  },
  registerTool(tool: any) {
    tools.set(tool.name, tool);
  },
}, {
  async generateProfile(request: any) {
    generatedRequest = request;
    return {
      spec: { type: "contains", query: "ERROR" },
      validation: { passed: true, examples: request.examples.length },
    };
  },
});

afterAll(() => {
  const dbPath = join(home, ".local/share/pi/COT/vault.sqlite");
  if (existsSync(dbPath)) {
    const db = new Database(dbPath);
    db.prepare("DELETE FROM outputs WHERE tool IN (?, ?)").run("cot-test", "bash");
    db.prepare("DELETE FROM filters WHERE name LIKE ? OR name LIKE ?").run("test-%", "auto:%");
    db.close();
  }
  rmSync(home, { recursive: true, force: true });
});

test("capture, retrieve, filter, save, session-scope, and export", async () => {
  const names = [...tools.keys()].sort();
  expect(names).toEqual(["cot_capture", "cot_delete_filter", "cot_filter", "cot_get", "cot_save_filter", "cot_vault"]);

  const marker = `COT-TEST-${Math.random().toString(16).slice(2)}`;
  const capture = await tools.get("cot_capture").execute("test", {
    content: `${marker}\nsecond-line`,
    source: "cot-test",
  });
  const handle = capture.content[0].text.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0];
  expect(handle).toBeTruthy();

  const retrieved = await tools.get("cot_get").execute("test", {
    handle,
    session_id: "cot-test-session",
  });
  expect(retrieved.content[0].text).toContain(marker);
  expect(retrieved.content[0].text).toContain("second-line");

  const wrongSession = await tools.get("cot_get").execute("test", {
    handle,
    session_id: "other-session",
  });
  expect(wrongSession.content[0].text).toContain("not found");

  const inlineFilter = await tools.get("cot_filter").execute("test", {
    handle,
    spec: { type: "contains", query: marker },
  });
  expect(inlineFilter.content[0].text).toContain(marker);

  const filterName = `test-${marker.slice("COT-TEST-".length)}`;
  const saved = await tools.get("cot_save_filter").execute("test", {
    name: filterName,
    description: "Temporary test filter",
    spec: { type: "contains", query: marker },
  });
  expect(saved.content[0].text).toContain(filterName);

  const savedFilter = await tools.get("cot_filter").execute("test", {
    handle,
    filter: filterName,
    session_id: "cot-test-session",
  });
  expect(savedFilter.content[0].text).toContain(marker);

  const pipeline = { steps: [
    { type: "contains", query: "second-line" },
    { type: "lines", start: 1, end: 1 },
  ] };
  const replaced = await tools.get("cot_save_filter").execute("test", {
    name: filterName,
    description: "Ordered test pipeline",
    spec: pipeline,
  });
  expect(replaced.content[0].text).toContain("Saved filter");
  const pipelineResult = await tools.get("cot_filter").execute("test", { handle, filter: filterName });
  expect(pipelineResult.content[0].text).toContain("second-line");
  const invalidPipeline = await tools.get("cot_filter").execute("test", {
    handle, spec: { steps: [{ type: "unknown" }] },
  });
  expect(invalidPipeline.content[0].text).toContain("Invalid pipeline step 1");
  const oversizedPipeline = await tools.get("cot_filter").execute("test", {
    handle, spec: { steps: Array.from({ length: 21 }, () => ({ type: "lines" })) },
  });
  expect(oversizedPipeline.content[0].text).toContain("exceeds 20 steps");

  const filters = await tools.get("cot_filter").execute("test", {});
  expect(filters.content[0].text).toContain(filterName);
  const deleted = await tools.get("cot_delete_filter").execute("test", { name: filterName });
  expect(deleted.content[0].text).toContain("Deleted filter");
  const afterDelete = await tools.get("cot_filter").execute("test", {});
  expect(afterDelete.content[0].text).toContain("No saved filters.");

  const rawAfterFilter = await tools.get("cot_get").execute("test", { handle });
  expect(rawAfterFilter.content[0].text).toContain("second-line");

  const listed = await tools.get("cot_vault").execute("test", {
    action: "list",
    session_id: "cot-test-session",
  });
  expect(listed.content[0].text).toContain(handle);

  const searched = await tools.get("cot_vault").execute("test", {
    action: "search",
    session_id: "cot-test-session",
    query: marker,
  });
  expect(searched.content[0].text).toContain(handle);

  const exported = await tools.get("cot_vault").execute("test", { action: "export" });
  const backupPath = exported.content[0].text.match(/SQLite backup created: (.+)/)?.[1];
  expect(backupPath).toBeTruthy();
  const backup = new Database(backupPath!, { readonly: true });
  expect(backup.prepare("SELECT count(*) AS n FROM outputs WHERE id = ?").get(handle).n).toBe(1);
  backup.close();
});


test("saved selectors automatically filter matching tool results and preserve raw output", async () => {
  const saved = await tools.get("cot_save_filter").execute("test", {
    name: "test-auto-filter",
    description: "Selector integration test",
    spec: { type: "contains", query: "FAIL" },
    selector: { toolName: "bash", commandPrefix: "git status" },
  });
  expect(saved.content[0].text).toContain("Saved filter");

  const raw = "header\nFAIL: important\nverbose noise";
  const event = {
    toolName: "bash",
    input: { command: "git status --short" },
    content: [{ type: "text", text: raw }],
    sessionId: "selector-test-session",
    isError: false,
  };
  const result = await events.get("tool_result")(event, {});
  expect(result.content[0].text).toContain("Applied saved filter");
  expect(result.content[0].text).toContain("FAIL: important");
  expect(result.content[0].text).not.toContain("verbose noise");
  const handle = result.content[0].text.match(/raw output handle ([0-9a-f-]{36})/)?.[1];
  expect(handle).toBeTruthy();
  const recovered = await tools.get("cot_get").execute("test", { handle });
  expect(recovered.content[0].text).toContain("verbose noise");

  const mismatch = await events.get("tool_result")({
    ...event,
    input: { command: "git statusx" },
  }, {});
  expect(mismatch.content[0].text).toContain("Stored tool result");

  const listed = await tools.get("cot_filter").execute("test", {});
  expect(listed.content[0].text).toContain('"commandPrefix":"git status"');
});

test("repeated large unmatched output triggers quiet profile generation", async () => {
  generatedRequest = undefined;
  const base = {
    toolName: "bash",
    input: { command: "git log --oneline" },
    sessionId: "learning-test-session",
    isError: false,
  };
  for (let i = 0; i < 3; i++) {
    await events.get("tool_result")({
      ...base,
      content: [{ type: "text", text: "ERROR: password=supersecret\n" + ("trace context ".repeat(800) + i) }],
    }, {});
  }
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(generatedRequest.target).toBe("bash:git log");
  expect(generatedRequest.examples).toHaveLength(3);
  expect(generatedRequest.examples.join("\n")).toContain("password=supersecret");

  const next = await events.get("tool_result")({
    ...base,
    content: [{ type: "text", text: "ERROR: next failure\n" + "trace ".repeat(1400) }],
  }, {});
  expect(next.content[0].text).toContain("Applied saved filter");
});


test("legacy schemas migrate additively and learning stays off without opt-in", async () => {
  const legacyHome = mkdtempSync(join(tmpdir(), "pi-cot-legacy-test-"));
  const legacyDbDir = join(legacyHome, ".local/share/pi/COT");
  mkdirSync(legacyDbDir, { recursive: true });
  const legacyPath = join(legacyDbDir, "vault.sqlite");
  const legacyDb = new Database(legacyPath);
  legacyDb.exec(`
    CREATE TABLE outputs (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, tool TEXT NOT NULL,
      is_error INTEGER NOT NULL, body TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT 'unknown'
    );
    CREATE TABLE filters (
      name TEXT PRIMARY KEY, description TEXT NOT NULL, spec TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacyDb.prepare("INSERT INTO filters VALUES (?, ?, ?, ?)").run(
    "legacy-filter", "kept across migration", JSON.stringify({ type: "contains", query: "ERROR" }), new Date().toISOString(),
  );
  legacyDb.close();

  const previousHome = Bun.env.HOME;
  const previousAutoProfile = Bun.env.PI_COT_AUTO_PROFILE;
  Bun.env.HOME = legacyHome;
  delete Bun.env.PI_COT_AUTO_PROFILE;
  const { default: registerLegacy } = await import("../extensions/cot.ts?migration");
  let resultHandler: any;
  let generationCalls = 0;
  registerLegacy({
    on(name: string, handler: any) {
      if (name === "tool_result") resultHandler = handler;
    },
    registerTool() {},
  }, {
    async generateProfile() {
      generationCalls++;
      return { spec: { type: "contains", query: "ERROR" }, validation: { passed: true, examples: 3 } };
    },
  });
  Bun.env.HOME = previousHome;
  if (previousAutoProfile === undefined) delete Bun.env.PI_COT_AUTO_PROFILE;
  else Bun.env.PI_COT_AUTO_PROFILE = previousAutoProfile;

  for (let i = 0; i < 3; i++) {
    await resultHandler({
      toolName: "bash",
      input: { command: "git diff" },
      content: [{ type: "text", text: "ERROR: old output\n" + "x".repeat(9000) }],
      sessionId: "legacy-session",
      isError: false,
    }, {});
  }
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(generationCalls).toBe(0);

  const migrated = new Database(legacyPath, { readonly: true });
  const outputColumns = migrated.prepare("PRAGMA table_info(outputs)").all().map((row: any) => row.name);
  const filterColumns = migrated.prepare("PRAGMA table_info(filters)").all().map((row: any) => row.name);
  expect(outputColumns).toContain("target_key");
  expect(filterColumns).toContain("selector");
  expect(migrated.prepare("SELECT description FROM filters WHERE name='legacy-filter'").get().description).toBe("kept across migration");
  migrated.close();
  rmSync(legacyHome, { recursive: true, force: true });
});

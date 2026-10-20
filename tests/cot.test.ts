import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "pi-cot-test-"));
Bun.env.HOME = home;
Bun.env.PI_SESSION_ID = "cot-test-session";

const { default: registerCOT } = await import("../extensions/cot.ts?test");
const tools = new Map<string, any>();
registerCOT({
  on() {},
  registerTool(tool: any) {
    tools.set(tool.name, tool);
  },
});

afterAll(() => {
  const dbPath = join(home, ".local/share/pi/COT/vault.sqlite");
  if (existsSync(dbPath)) {
    const db = new Database(dbPath);
    db.prepare("DELETE FROM outputs WHERE tool = ?").run("cot-test");
    db.prepare("DELETE FROM filters WHERE name LIKE ?").run("test-%");
    db.close();
  }
  rmSync(home, { recursive: true, force: true });
});

test("capture, retrieve, filter, save, session-scope, and export", async () => {
  const names = [...tools.keys()].sort();
  expect(names).toEqual(["cot_capture", "cot_filter", "cot_get", "cot_save_filter", "cot_vault"]);

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

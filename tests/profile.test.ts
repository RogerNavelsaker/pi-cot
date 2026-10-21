import { expect, test } from "bun:test";
import {
  applyFilter,
  deriveTarget,
  matchesSelector,
  redactSecrets,
  validateFilterSpec,
  validateGeneratedProfile,
} from "../extensions/profiles.ts";

test("shell target keys include the command family", () => {
  expect(deriveTarget("bash", { command: "git status --short" })).toEqual({
    key: "bash:git status",
    selector: { toolName: "bash", commandPrefix: "git status" },
  });
  expect(deriveTarget("bash", { command: "ls -la" })).toEqual({
    key: "bash:ls",
    selector: { toolName: "bash", commandPrefix: "ls" },
  });
});

test("non-shell target keys do not retain call arguments", () => {
  expect(deriveTarget("read", { path: "/private/secret.txt", offset: 1 })).toEqual({
    key: "read",
    selector: { toolName: "read" },
  });
});

test("selectors match tool arguments and command-prefix boundaries", () => {
  expect(matchesSelector("bash", { command: "git status --short" }, {
    toolName: "bash",
    commandPrefix: "git status",
  })).toBe(true);
  expect(matchesSelector("bash", { command: "git statusx" }, {
    toolName: "bash",
    commandPrefix: "git status",
  })).toBe(false);
  expect(matchesSelector("read", { path: "README.md", offset: 1 }, {
    toolName: "read",
    input: { path: "README.md" },
  })).toBe(true);
  expect(matchesSelector("read", { path: "LICENSE" }, {
    toolName: "read",
    input: { path: "README.md" },
  })).toBe(false);
});

test("truncate keeps a head and tail with an omission marker", () => {
  const result = applyFilter("a\nb\nc\nd\ne", {
    type: "truncate",
    maxLines: 4,
    headLines: 2,
    tailLines: 1,
  });
  expect(result).toBe("a\nb\n… [2 lines omitted] …\ne");
  expect(validateFilterSpec({ type: "truncate", maxLines: 4, headLines: 2, tailLines: 1 })).toBeUndefined();
  expect(validateFilterSpec({ type: "truncate", maxLines: 2, headLines: 2, tailLines: 2 })).toContain("head");
  expect(validateFilterSpec({ type: "truncate", maxLines: 2, headLines: 0, tailLines: 0 })).toContain("retain");
  expect(validateFilterSpec({ type: "json-path", path: "" })).toContain("JSON path");
});

test("generated profile activates only after model and local validation", () => {
  const examples = [
    "ERROR: first failure\ncontext 1\ncontext 2",
    "ERROR: second failure\ncontext 3\ncontext 4",
    "ERROR: third failure\ncontext 5\ncontext 6",
  ];
  expect(validateGeneratedProfile({
    spec: { type: "contains", query: "ERROR" },
    validation: { passed: true, examples: 3 },
  }, examples).ok).toBe(true);
  expect(validateGeneratedProfile({
    spec: { type: "contains", query: "missing" },
    validation: { passed: true, examples: 3 },
  }, examples).ok).toBe(false);
  expect(validateGeneratedProfile({
    spec: { type: "contains", query: "ERROR" },
    validation: { passed: false, examples: 3 },
  }, examples).ok).toBe(false);
  expect(validateGeneratedProfile({
    spec: { type: "regex", pattern: "(a+)+$" },
    validation: { passed: true, examples: 3 },
  }, examples).ok).toBe(false);
  expect(validateGeneratedProfile({
    spec: { type: "json-path", path: "absent" },
    validation: { passed: true, examples: 3 },
  }, ['{"status":"error"}', '{"status":"warning"}', '{"status":"notice"}']).ok).toBe(false);
});

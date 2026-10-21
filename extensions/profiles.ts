export interface FilterSelector {
  toolName: string;
  commandPrefix?: string;
  input?: Record<string, string | number | boolean>;
}

export interface ToolTarget {
  key: string;
  selector: FilterSelector;
}

const filterTypes = ["lines", "contains", "regex", "json-path", "truncate", "dedupe"];

function shellCommandStart(command: string): string {
  let start = command.trimStart();
  while (true) {
    const cdPrefix = start.match(/^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/);
    if (!cdPrefix) break;
    start = start.slice(cdPrefix[0].length).trimStart();
  }
  return start.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)+/, "");
}

function startsWithCommandPrefix(command: string, prefix: string): boolean {
  if (!command.startsWith(prefix)) return false;
  const next = command[prefix.length];
  return next === undefined || /[\s|&;]/.test(next);
}

export function deriveTarget(toolName: string, input: any): ToolTarget {
  if (toolName === "bash" && typeof input?.command === "string") {
    const command = shellCommandStart(input.command);
    const commandPrefix = commandPrefixes.find(prefix => startsWithCommandPrefix(command, prefix))
      ?? command.match(/^(?:[^\s;|&]+\/)?([A-Za-z0-9_.+-]+)/)?.[1]?.toLowerCase();
    if (commandPrefix) return { key: "bash:" + commandPrefix, selector: { toolName, commandPrefix } };
  }
  return { key: toolName, selector: { toolName } };
}

const linePreview = (commandPrefix: string) => {
  const log = /(?:^| )(?:docker logs|kubectl logs|journalctl)$/.test(commandPrefix);
  const listing = /^(?:ls|tree|find|fd|rg|grep|ast-grep|wc)$/.test(commandPrefix);
  const diagnostics = /(?:test|pytest|jest|vitest|rspec|playwright|build|check|clippy|lint|format|install|migrate|outdated|up)$/.test(commandPrefix);
  const [maxLines, headLines, tailLines] = log ? [120, 12, 100]
    : listing ? [120, 90, 25]
    : diagnostics ? [160, 45, 110]
    : commandPrefix === "git diff" ? [180, 110, 60]
    : [120, 75, 40];
  return {
    name: `builtin:${commandPrefix.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`,
    description: `Keep a useful head/tail view of long ${commandPrefix} output.`,
    selector: { toolName: "bash", commandPrefix },
    spec: { type: "truncate", maxLines, headLines, tailLines },
    builtin: true,
  };
};

// Source-derived command families from LeanCTX and RTK, plus common language runtimes and shell utilities.
const commandPrefixes = [...new Set([
  // LeanCTX pattern families.
  ..."alembic ansible argocd artisan aws bazel buf bun cargo clang cmake composer cosign curl dbt deno docker dotnet eslint fd find flutter flyway gem gh glab go golangci-lint grep grype helm jj just kubectl linkerd ls make maven mise mix mlflow mypy mysql next ninja npm ollama php pip playwright pnpm poetry prettier prisma psql pulumi pytest ruby ruff semgrep spark swift swiftlint syft terraform trivy wget zig".split(" "),
  // RTK documented operation prefixes, including multi-word subcommands.
  "git status", "git log", "git diff", "git show", "git stash list",
  "gh pr view", "gh pr checks", "gh run list", "gh issue view", "gt log", "gt status",
  "cargo test", "cargo nextest", "cargo build", "cargo check", "cargo clippy",
  "jest", "vitest", "tsc", "eslint", "pnpm list", "pnpm outdated", "next build", "prisma migrate", "playwright test",
  "pytest", "ruff check", "mypy", "pip install", "go test", "golangci-lint run", "go build",
  "rspec", "rubocop", "rake", "dotnet build", "dotnet test", "dotnet format",
  "docker ps", "docker images", "docker logs", "docker compose up", "kubectl get pods", "kubectl logs",
  "ls", "find", "grep", "ast-grep", "diff", "wc",
  // Context Mode runtimes and common command aliases.
  ..."adb tree rg yarn npx python python3 node nodejs java perl R bash sh rustc gradle mvn tsc tsx ts-node jq yq xargs sed awk cat head tail du df free ps top htop systemctl journalctl uname".split(" "),
  "bun test", "npm test", "pnpm test", "yarn test", "bun run", "git commit",
])].sort((a, b) => b.length - a.length);

// All families use deterministic head/tail reduction; unmatched oversized output still gets a bounded preview.
export const BUILTIN_FILTERS = commandPrefixes.map(linePreview);

export function matchesSelector(toolName: string, input: any, selector: FilterSelector): boolean {
  if (toolName !== selector.toolName) return false;
  if (selector.commandPrefix !== undefined) {
    if (typeof input?.command !== "string") return false;
    const command = shellCommandStart(input.command);
    if (!startsWithCommandPrefix(command, selector.commandPrefix)) return false;
  }
  if (selector.input) {
    if (!input || typeof input !== "object") return false;
    for (const [key, value] of Object.entries(selector.input)) {
      if (input[key] !== value) return false;
    }
  }
  return true;
}

export function selectorSpecificity(selector: FilterSelector): number {
  return (selector.commandPrefix?.length ?? 0) + Object.keys(selector.input ?? {}).length * 1000;
}

export function validateSelector(selector: any): string | undefined {
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) return "Selector must be an object.";
  if (typeof selector.toolName !== "string" || !selector.toolName.trim() || selector.toolName.length > 128) {
    return "Selector requires a toolName (max 128 chars).";
  }
  if (selector.commandPrefix !== undefined &&
    (typeof selector.commandPrefix !== "string" || !selector.commandPrefix.trim() || selector.commandPrefix.length > 256)) {
    return "commandPrefix must be a non-empty string (max 256 chars).";
  }
  if (selector.input !== undefined) {
    if (!selector.input || typeof selector.input !== "object" || Array.isArray(selector.input)) return "Selector input must be an object.";
    const entries = Object.entries(selector.input);
    if (entries.length > 8) return "Selector input may contain at most 8 exact fields.";
    if (entries.some(([, value]) => !["string", "number", "boolean"].includes(typeof value))) {
      return "Selector input values must be strings, numbers, or booleans.";
    }
  }
}

export function validateFilterSpec(spec: any): string | undefined {
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
  if (spec.limit !== undefined && (!Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > 200)) {
    return "Filter limit must be an integer from 1 to 200.";
  }
  if (spec.type === "lines") {
    if (spec.start !== undefined && (!Number.isInteger(spec.start) || spec.start < 1)) return "lines start must be a positive integer.";
    if (spec.end !== undefined && (!Number.isInteger(spec.end) || spec.end < 1 || spec.end < (spec.start ?? 1))) {
      return "lines end must be an integer at or after start.";
    }
  }
  if (spec.type === "contains" && typeof spec.query !== "string") return "Contains filter requires a string query.";
  if (spec.type === "regex") {
    if (typeof spec.pattern !== "string" || spec.pattern.length > 500) return "Regex pattern required (max 500 chars).";
    try { new RegExp(spec.pattern, spec.flags ?? "i"); } catch (e) { return String(e); }
  }
  if (spec.type === "json-path") {
    if (typeof spec.path !== "string" || !spec.path.trim() || spec.path.length > 256) return "JSON path required (max 256 chars).";
    const segments = spec.path.split(".");
    if (segments.length > 16 || segments.some(key =>
      !/^[A-Za-z0-9_-]+$/.test(key) || ["__proto__", "prototype", "constructor"].includes(key)
    )) return "JSON path must use safe dot-separated keys.";
  }
  if (spec.type === "truncate") {
    const { maxLines, headLines, tailLines } = spec;
    if (!Number.isInteger(maxLines) || maxLines < 2 || maxLines > 10000) return "truncate maxLines must be an integer from 2 to 10000.";
    if (!Number.isInteger(headLines) || headLines < 0 || !Number.isInteger(tailLines) || tailLines < 0 ||
      headLines + tailLines < 1 || headLines + tailLines + 1 > maxLines) {
      return "truncate must retain at least one head or tail line, and fit maxLines.";
    }
  }
}

function summarizeRepeatedLines(input: string): string {
  const trailingNewline = input.endsWith("\n");
  const lines = input.split("\n");
  if (trailingNewline) lines.pop();

  const locations = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const lineNumbers = locations.get(line) ?? [];
    lineNumbers.push(index + 1);
    locations.set(line, lineNumbers);
  });

  const formatLocations = (lineNumbers: number[]) => {
    const ranges: string[] = [];
    for (let start = 0; start < lineNumbers.length;) {
      let end = start;
      while (end + 1 < lineNumbers.length && lineNumbers[end + 1] === lineNumbers[end] + 1) end++;
      ranges.push(start === end ? String(lineNumbers[start]) : lineNumbers[start] + "-" + lineNumbers[end]);
      start = end + 1;
    }
    return ranges.join(", ");
  };

  const summary = lines.flatMap((line, index) => {
    const lineNumbers = locations.get(line)!;
    if (lineNumbers[0] !== index + 1) return [];
    return [lineNumbers.length === 1
      ? line
      : `[${lineNumbers.length} occurrences; lines ${formatLocations(lineNumbers)}] ${JSON.stringify(line)}`];
  }).join("\n") + (trailingNewline ? "\n" : "");
  return summary.length < input.length ? summary : input;
}

export function applyFilter(input: string, spec: any): string {
  if (Array.isArray(spec.steps)) return spec.steps.reduce((value: string, step: any) => applyFilter(value, step), input);
  const limit = Math.min(200, spec.limit ?? 80);
  if (spec.type === "lines") return input.split("\n").slice(Math.max(0, (spec.start ?? 1) - 1), spec.end ?? 100).join("\n");
  const matchingLines = (matches: (line: string) => boolean) => input.split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => matches(line))
    .slice(0, limit)
    .map(({ line, index }) => `${index + 1}: ${line}`)
    .join("\n");
  if (spec.type === "contains") return matchingLines(line => line.toLowerCase().includes(spec.query.toLowerCase()));
  if (spec.type === "regex") {
    const re = new RegExp(spec.pattern, spec.flags ?? "i");
    return matchingLines(line => { re.lastIndex = 0; return re.test(line); });
  }
  if (spec.type === "dedupe") return summarizeRepeatedLines(input);
  if (spec.type === "truncate") {
    const lines = input.split("\n");
    if (lines.length <= spec.maxLines) return input;
    const head = lines.slice(0, spec.headLines);
    const tail = spec.tailLines ? lines.slice(-spec.tailLines) : [];
    const marker = "… [" + (lines.length - spec.headLines - spec.tailLines) + " lines omitted] …";
    return [...head, marker, ...tail].join("\n");
  }
  let value: any = JSON.parse(input);
  for (const key of spec.path.split(".")) value = value?.[key];
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

export function validateGeneratedProfile(candidate: any, examples: string[]): { ok: boolean; reason?: string } {
  if (candidate?.validation?.passed !== true) return { ok: false, reason: "Model validation did not pass." };
  if (candidate.validation.examples !== examples.length) return { ok: false, reason: "Model did not validate every example." };
  const hasRegex = (spec: any): boolean => Array.isArray(spec?.steps)
    ? spec.steps.some(hasRegex)
    : spec?.type === "regex";
  if (hasRegex(candidate.spec)) return { ok: false, reason: "Generated regex filters are disabled for safety." };
  const error = validateFilterSpec(candidate.spec);
  if (error) return { ok: false, reason: error };
  if (!examples.length) return { ok: false, reason: "No stored examples." };
  try {
    const outputs = examples.map(example => applyFilter(example, candidate.spec));
    if (examples.some((example, index) => example.length > 0 &&
      (!outputs[index].trim() || outputs[index].trim() === "undefined"))) {
      return { ok: false, reason: "Profile empties or fails to resolve a non-empty example." };
    }
    const inputLength = examples.reduce((sum, value) => sum + value.length, 0);
    const outputLength = outputs.reduce((sum, value) => sum + value.length, 0);
    if (outputLength > inputLength * 0.8) return { ok: false, reason: "Profile reduces examples by less than 20%." };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
  return { ok: true };
}

export interface FilterSelector {
  toolName: string;
  commandPrefix?: string;
  input?: Record<string, string | number | boolean>;
}

export interface ToolTarget {
  key: string;
  selector: FilterSelector;
}

const filterTypes = ["lines", "contains", "regex", "json-path", "truncate"];

export function deriveTarget(toolName: string, input: any): ToolTarget {
  if (toolName === "bash" && typeof input?.command === "string") {
    const command = input.command.trimStart();
    const match = command.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:[^\s;|&]+\/)?([A-Za-z0-9_.+-]+)(?:\s+([A-Za-z0-9_.+-]+))?/);
    const executable = match?.[1]?.toLowerCase();
    if (executable) {
      const subcommand = executable === "git" && match?.[2] && !match[2].startsWith("-")
        ? match[2].toLowerCase()
        : undefined;
      const commandPrefix = subcommand ? executable + " " + subcommand : executable;
      return { key: "bash:" + commandPrefix, selector: { toolName, commandPrefix } };
    }
  }
  return { key: toolName, selector: { toolName } };
}

export function matchesSelector(toolName: string, input: any, selector: FilterSelector): boolean {
  if (toolName !== selector.toolName) return false;
  if (selector.commandPrefix !== undefined) {
    if (typeof input?.command !== "string") return false;
    const command = input.command.trimStart();
    if (!command.startsWith(selector.commandPrefix)) return false;
    const next = command[selector.commandPrefix.length];
    if (next !== undefined && !/[\s|&;]/.test(next)) return false;
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

export function applyFilter(input: string, spec: any): string {
  if (Array.isArray(spec.steps)) return spec.steps.reduce((value: string, step: any) => applyFilter(value, step), input);
  const limit = Math.min(200, spec.limit ?? 80);
  if (spec.type === "lines") return input.split("\n").slice(Math.max(0, (spec.start ?? 1) - 1), spec.end ?? 100).join("\n");
  if (spec.type === "contains") return input.split("\n").filter(x => x.toLowerCase().includes(spec.query.toLowerCase())).slice(0, limit).join("\n");
  if (spec.type === "regex") {
    const re = new RegExp(spec.pattern, spec.flags ?? "i");
    return input.split("\n").filter(x => { re.lastIndex = 0; return re.test(x); }).slice(0, limit).join("\n");
  }
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

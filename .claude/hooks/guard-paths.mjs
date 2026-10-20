// PreToolUse hook: refuse edits to generated, vendored, or lock files.
// Exit 0 = allow, exit 2 = block and show stderr to Claude.
import { readFileSync } from "node:fs";
import path from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
if (input.hook_event_name !== "PreToolUse") process.exit(0);

const file = input?.tool_input?.file_path;
if (!file) process.exit(0);

const projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const rel = path.relative(projectDir, file).replaceAll("\\", "/");

const blocked = [
  { pattern: /^package-lock\.json$/, why: "lock file — change dependencies through npm, not by editing" },
  { pattern: /^node_modules\//, why: "vendored dependency — edit the source repo instead" },
  { pattern: /^dist\//, why: "build output — run the build instead of editing it" },
  { pattern: /^\.env(\.|$)/, why: "environment/secret file" },
  { pattern: /^tools\/out\//, why: "read-only evidence anchor — docs/03-development.md forbids writing here" },
  { pattern: /^docs\/validation\//, why: "dated acceptance evidence — add a new dated directory instead of rewriting history" },
  { pattern: /(^|\/)\.git\//, why: "git internals" },
];

for (const rule of blocked) {
  if (rule.pattern.test(rel)) {
    process.stderr.write(`Blocked: ${rel} is a ${rule.why}.\n`);
    process.exit(2);
  }
}
process.exit(0);

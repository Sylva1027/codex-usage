// PostToolUse hook: format the file Claude just edited with Biome.
// Reads the hook payload from stdin; exits 0 on success, 2 with a message on
// stderr when Biome reports something Claude should see.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
if (input.hook_event_name !== "PostToolUse") process.exit(0);

const file = input?.tool_input?.file_path;
if (!file) process.exit(0);

const projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const biomeBin = path.join(projectDir, "node_modules", "@biomejs", "biome", "bin", "biome");
if (!existsSync(biomeBin)) process.exit(0);

// Only format files Biome is configured to own.
const rel = path.relative(projectDir, file).replaceAll("\\", "/");
if (!/^(src|public|test|scripts\/skin-palette|test-support)\//.test(rel)) process.exit(0);

const result = spawnSync(process.execPath, [biomeBin, "format", "--write", file], {
  cwd: projectDir,
  encoding: "utf8",
});

if (result.status !== 0) {
  const detail = (result.stderr || result.stdout || "").trim();
  if (detail) process.stderr.write(`Biome format failed for ${rel}:\n${detail}\n`);
  process.exit(2);
}
process.exit(0);

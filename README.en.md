# Codex Usage

[中文](README.md) | English

Codex Usage is a local-first token usage analytics tool for Codex. It reads official Codex session logs on your machine, aggregates usage from CLI, Codex Desktop, Codex Exec, JetBrains/PyCharm plugins, and other integrations, then presents the results through a CLI summary, a local web dashboard, a background gateway, static HTML export, and JSON APIs.

It helps you answer questions like: How many tokens did I use today? Which project consumed the most? How much usage came from CLI versus IDE plugins? How much was input, cached input, output, or reasoning output?

## Highlights

- Scans official Codex session logs locally; no external upload is required
- Tracks total tokens, input, cached input, output, reasoning output, and session count
- Supports today, this week, this month, all time, and custom date ranges
- Shows time trends by hour, day, week, or month
- Breaks usage down by channel, Git repository, model, and scanned home
- Provides CLI summaries, an interactive local dashboard, a background gateway, and static HTML snapshots
- Imports extra Codex homes or project logs generated at `.codex-usage/usage.jsonl`
- Uses a lightweight fingerprint check and only reparses logs when session files change
- Designed as a personal local dashboard for long-running Codex usage tracking

## Supported Sources

Codex Usage currently reads official Codex session logs from:

- Main Codex/CLI/App home: `~/.codex`
- JetBrains/PyCharm plugin homes: `~/Library/Caches/JetBrains/*/aia/codex`
- Extra Codex homes passed through the `CODEX_USAGE_HOMES` environment variable
- Project usage logs from imported project directories containing `.codex-usage/usage.jsonl`

Channels are classified as:

- `Codex Desktop`
- `Codex Exec`
- `CLI`
- `JetBrains PyCharm`
- `Codex OAuth`
- Other editor integrations when they cannot be classified more specifically

Requests made directly through the OpenAI API are not counted unless they are written to official Codex session logs.

## Requirements

Node.js `>=22.13` is required for the built-in SQLite index.

```bash
node --version
```

## Quick Start

```bash
git clone https://github.com/<your-name>/codex-usage.git
cd codex-usage
```

Print a CLI summary:

```bash
npm run summary
```

Start the local web dashboard:

```bash
npm run serve
```

Then open:

```text
http://127.0.0.1:3765
```

You can also choose another port:

```bash
PORT=4000 npm run serve
```

## CLI Usage

Run the local service in the foreground:

```bash
node src/cli.js run
```

To use `codex-usage` or `cud` on your machine, link the package from the project directory:

```bash
npm link
codex-usage dashboard
```

You can also open the dashboard with the short option:

```bash
codex-usage -d
```

`dashboard` reuses an existing registered background service. If no service is running, it starts a background gateway and opens the dashboard. The short command is also available:

```bash
cud
```

Start a background gateway:

```bash
codex-usage gateway
```

Restart the background gateway:

```bash
codex-usage restart
```

The dashboard and `summary` keep a lightweight index at `~/.codex-usage/usage-index.sqlite`. The first run builds it row by row; later refreshes only rebuild changed log files, so historical events do not remain in the Node.js heap. To rebuild from scratch, stop the service, remove that SQLite file, and start the gateway again.

Stop services registered by this tool:

```bash
codex-usage stop
```

Print JSON output:

```bash
node src/cli.js json
node src/cli.js summary --json
```

## Dashboard

The web dashboard supports:

- Today, this week, this month, all time, and custom date ranges
- Hourly, daily, weekly, and monthly aggregation
- Total tokens, input, cached input, output, reasoning output, and session count
- Channel breakdown
- Timeline chart with channel, model, or estimated API-equivalent cost views and local-calendar slots
- Optional auto-refresh in service mode, with the preference saved locally
- Repository breakdown
- Model breakdown
- Side-by-side model and repository totals for today, this week, this month, and all time, with expandable token details
- Scanned home list
- Light and dark themes saved in local browser storage
- Directory imports from the top-right button or the scanned home panel

The four comparison periods overlap and must not be added together. Events are grouped by Git root; if no Git root can be found, the normalized working directory is used. Input totals include ordinary input, cached reads, and cache writes; cache hit rate is `cached input ÷ total input`, and reasoning output is included in output. Cost estimates price the three input categories separately. Details are shown only when the source log provides them. Historical events that contain only a total keep that total and are marked as missing a breakdown. `Unknown model` entries are not renamed based on thread metadata or recollection. Static HTML comparisons are anchored to the snapshot generation time.

In service mode, the page performs a lightweight check every `60` seconds by default. You can turn it off or back on in the header; the preference is saved locally. The check reads only session file `path + size + mtimeMs` values to build a fingerprint. Changed log files are reparsed automatically. Static HTML snapshots do not poll.

The cost chart and price cards show API-equivalent estimates using published OpenAI API rates; they are not actual bills. Ordinary input, cached reads, and cache writes are priced separately. If cache-write detail is missing, the corresponding input cost is excluded. Long-context rates apply only when a request can be reliably matched to per-request usage. If service tier is missing, the estimate uses a clearly marked Standard scenario. Tokens with unknown models or incomplete usage detail are marked unpriced, and the cost chart shows only priced amounts. The estimate uses available token detail and excludes tool calls and other non-token charges. Historical results retain the price version recorded in the index; rebuild the index after updating the rate table.

## Directory Imports and Project Logs

The dashboard's `导入目录` button and the scanned home panel's `添加` button store imported directories locally:

```text
~/.codex-usage/imports.json
```

Imported directories are recognized as either:

- Codex homes containing `sessions/`, `archived_sessions/`, or `state_*.sqlite`
- Project log directories containing `.codex-usage/usage.jsonl`

For projects that call `codex-oauth` or OpenAI-compatible APIs directly, ask another AI agent to read [log-README.md](log-README.md) from this repository and instrument the target project. The target project should generate:

```text
<target-project>/.codex-usage/usage.jsonl
```

Then import `<target-project>` from the dashboard. Project logs should contain token counts, model, timestamp, project path, and session ID only. They should not contain prompts, responses, secrets, or OAuth tokens.

## Static Export

Generate a standalone HTML snapshot:

```bash
npm run export
```

Default output:

```text
dist/codex-usage.html
```

This file embeds the current usage data and frontend code. It is useful for temporary local viewing or private sharing, but it may contain local paths, project directories, session IDs, and usage details. For that reason, `dist/` is ignored by default and should not be committed to GitHub.

## JSON API

After starting the service, these endpoints are available:

```text
GET /api/status?since=<fingerprint>
GET /api/usage

GET /api/usage?detail=full
GET /api/summary
GET /api/imports
POST /api/imports
DELETE /api/imports?path=<absolute-path>
```

Endpoint notes:

- `/api/status` checks whether new logs are available
- `/api/usage` returns lightweight `summary`, `metadata`, and `periodComparison` (model/repository totals for today, this week, this month, and all time)

- `/api/usage?detail=full` returns the full `report` and a matching `periodComparison` for debugging
- `/api/summary` returns the summary and `periodComparison`
- `/api/imports` lists, adds, or removes directories imported from the dashboard

The default low-memory `gateway` may reject `detail=full` to avoid excessive memory usage. For full detail debugging, restart with a larger memory limit:

```bash
codex-usage restart --memory-mb 512
```

## Extra Codex Homes

If you have additional Codex home directories, pass them through `CODEX_USAGE_HOMES`. Multiple directories should be separated by the system path delimiter; on macOS/Linux, use `:`.

```bash
CODEX_USAGE_HOMES="/path/to/codex-home-1:/path/to/codex-home-2" npm run serve
```

An extra home should look like a Codex home and include at least one of:

```text
sessions/
archived_sessions/
state_5.sqlite
```

## Before Publishing to GitHub

Do not upload these files or directories:

- `.venv/`: local Python virtual environment
- `.idea/`, `.vscode/`: local IDE configuration
- `node_modules/`: dependency directory
- `dist/`: generated static snapshots that may contain personal usage data and local paths
- `.env`, `.env.*`: local environment variables and secrets
- `.codex/`, `sessions/`, `archived_sessions/`, `state_*.sqlite`: personal Codex data accidentally copied into the project

If you upload files through the GitHub web UI, check this manually as well. `.gitignore` only protects Git command-line commits.

## Development

Run tests:

```bash
npm test
```

The project currently has no third-party runtime dependencies. Main code lives in:

```text
src/
public/
test/
```

## License

This project is licensed under the [MIT License](LICENSE).

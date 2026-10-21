# codex-usage

本地 AI 用量看板：导入 Codex / ZCode / DSH / OpenCode 的会话日志，聚合成看板并估算费用。Node ESM，无运行时依赖，数据只存本机。

## 命令

Windows 上用 `npm.cmd`（避免 PowerShell 执行策略问题），无需改系统设置。

```powershell
npm.cmd ci
node src/cli.js run          # 看板，默认 http://127.0.0.1:3765
npm.cmd test                 # node --test test/**/*.test.js
npm.cmd run typecheck        # tsc -p tsconfig.checkjs.json（JS 项目，checkJs）
npm.cmd run lint             # biome check --formatter-enabled=false .
npm.cmd run format:check
npm.cmd run skins:check      # 皮肤资源 manifest 与首屏脚本（发布内容，不需源 PNG）
npm.cmd run skins:check:sources  # 另加：40 张作者源 PNG 与 WebP 副本绑定
npm.cmd run skins:palette    # 十套角色配色
```

按影响选择检查，不要为了文档改动跑全量测试。CI（`.github/workflows/ci.yml`）在 Node 22/24 上跑 test → typecheck → lint → format:check，本地能过才算过。

## 代码入口

- `src/cli.js` — 命令、前台/后台服务、网关
- `src/server.js` — 本地 HTTP API、导入、索引刷新、自动价格发现
- `src/usage-core.js` — 来源发现与分类、标准事件、内存报告
- `src/usage-store.js` — SQLite 增量索引、迁移、查询
- `src/usage-executor.js` — **唯一**持有 `DatabaseSync` 的 worker；主线程不打开数据库
- `src/{zcode,dsh,opencode}-usage.js` — 各来源适配器
- `src/pricing*.js` — 有效价目、费用估算、不确定性标记、自动更新
- `public/` — 无构建步骤的原生 JS 前端（`app.js`、`app-state.js`、`calendar.js`、`i18n.js`、`skins*.js`、`styles.css`）
- `scripts/prepare-skin-assets.mjs` — 生成并校验皮肤资源

## 必须知道的约束

- **单执行器**：`sync` / `summarize` / `periodComparison` 只在 `usage-executor.js` 的 worker 里跑。主线程只用 `postMessage` 发布的读侧快照应答 `/api/status`、`/api/pricing`、`/api/imports`、`/index.html`（p95 ≤ 100ms / max ≤ 250ms）。并发请求由 `loadUsageStore()` 的 `syncPromise` 合并，`test/w1-executor.test.js` 钉住"只发一次 sync"。
- **执行器崩溃**：在途请求以 `EXECUTOR_EXITED`（`retryable: true`）结算，下次请求就地重启一次，**没有重试循环**；`close()` 幂等。见 `test/w3-fault.test.js`。
- **`tools/out` 是只读锚点**：禁止对其中任何 `.sqlite` 打开（含 `readOnly: true`——WAL 库只读也会生成 `-wal`/`-shm`）。跑会写它的套件前先逐字节快照，跑后还原并用 `lead-acceptance/T1/pre-run-hashes.txt` 复核 0 变更。
- **界面基准是 PC**：16:9 桌面大屏（1920×1080、2560×1440），不要按手机宽度压缩信息密度。分享图片是例外——产物在手机上阅读，需单独检查约 360px 宽度的可读性。
- `public/skin-bootstrap.js` 由 `scripts/prepare-skin-assets.mjs` 生成，不要手改。
- 文档有分层：`docs/00-index.md` 导航、`01-roadmap.md` 方向、`02-tasks.md` 优先级（**唯一**进度来源）、`03-development.md` 接手说明、`plans/` 只放当前计划、`validation/` 按日期留证据、`archive/` 留决策过程。历史文档里的命令和测试数量是当时的快照，不能直接当当前要求。

## 改动习惯

- 价格、测试数、探针总量只作为带日期的快照记录。
- 涉及多任务的改动用独立分支和 worktree；暂存与提交由一个会话协调，提交前看 `git diff --cached` 确认业务文件与受测快照一致。
- 完成本地工作不自动 commit/push，按用户要求执行。

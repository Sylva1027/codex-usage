# Codex Usage

Codex Usage 是一个在自己电脑上运行的 Codex 用量看板。它读取本机的 Codex 会话日志，让你按时间、渠道、模型和仓库查看 Token 消耗、会话数与费用估算，无需上传用量日志。

本项目基于 [DhWU-coder/codex-usage](https://github.com/DhWU-coder/codex-usage) 继续开发。

## 快速开始

需要 **Node.js 22.13 或更新版本**。运行 `node -v` 可查看当前版本。

在 GitHub 页面选择 **Code → Download ZIP** 并解压，或使用 Git：

```bash
git clone https://github.com/Sylva1027/codex-usage.git
cd codex-usage
```

在项目目录启动本地看板：

```bash
node src/cli.js run
```

然后打开 [http://127.0.0.1:3765/](http://127.0.0.1:3765/)。服务默认只监听本机地址；结束使用时在终端按 `Ctrl+C`。

### Windows PowerShell 提示

如果输入 `npm run serve` 时出现 `npm.ps1` 被禁止运行，直接使用上面的 `node src/cli.js run`。需要使用 npm 脚本时，可显式输入 `npm.cmd run serve`；汇总和导出同理使用 `npm.cmd run summary`、`npm.cmd run export`。这些命令不需要修改 PowerShell 执行策略。

## 看板能做什么

- **查看用量趋势：** 在“今日 / 本周 / 本月 / 全部”、最近一段时间和自定义日期之间切换，按小时、天、周或月查看 Token、渠道、模型与估算费用。
- **比较模型和仓库：** 并排查看今日、本周、本月及全部用量，支持搜索、排序，以及输入、缓存读取、输出等明细。
- **管理数据来源：** 自动读取本机 Codex 日志，也可从页面导入其他 Codex 目录，或导入含 `.codex-usage/usage.jsonl` 的项目目录。
- **控制刷新：** 页面默认每 60 秒检查新记录；关闭自动刷新后，切换时间范围仍使用同一份数据快照。
- **节省重复扫描：** SQLite 索引仅重新处理发生变化的日志文件。看板支持浅色和深色主题。

## 数据与费用

看板会将已扫描日志中的 CLI、Codex Desktop、Codex Exec、JetBrains/PyCharm 等来源归类展示。没有写入这些日志、也没有被导入的 API 请求不会出现在统计中。

费用按公开的 [OpenAI API 定价](https://developers.openai.com/api/docs/pricing)估算，可在看板中更新计价标准。**估算值不是 Codex 套餐的实际账单**；价格或请求信息不足时，页面会标明未定价或部分估算。

用量日志和 SQLite 索引保留在本机。默认索引位于 `~/.codex-usage/usage-index.sqlite`。

## 其他命令

在终端查看汇总：

```bash
node src/cli.js summary
```

导出可单独打开的静态网页快照：

```bash
node src/static-export.js
```

导出文件位于 `dist/codex-usage.html`。静态快照不会自动刷新，需要重新导出才能包含新记录。文件内嵌用量数据及可能的本机路径，分享前请先检查内容。

项目采用 [MIT License](LICENSE)。

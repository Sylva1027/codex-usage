# 2026-10-02 ChatGPT 双侧角色预览

使用用户新提供的 `gpt-side-lineart.png` 与 `gpt-lineart.png`，分别显示在左侧与右侧。两张原图均为 941×1672 RGBA PNG，背景与人物内部都透明，复制进 [assets](assets/) 后原样内嵌。页面以 PNG 的透明通道作 CSS alpha 遮罩，使用现有正文色显示线条，使深浅模式下都可见；没有修改源图片、角色造型或新增角色配色。文件尺寸、SHA-256 与自包含 HTML 大小见 [assets.json](assets.json)。

这是基于当前 `public/` 页面和静态导出器生成的独立预览，数据来自脚本建立的合成项目日志。正式页面、运行服务、用量库和原始图片保持原状；不代表十角色系统已实现。

## 查看效果

- [缩放预览入口](viewer.html)：在较窄的应用侧栏也能查看 1920／1440px 桌面构图，可切换展示模式、明暗及 390px 手机效果，文件自包含。
- [原尺寸可交互预览](preview.html)：完整展示／放大贴边、透明度、角色显示开关，以及原有明暗切换和看板交互。可从 `file://` 离线打开。
- [1920 深色放大贴边](1920-dark-large.png)、[1920 浅色放大贴边](1920-light-large.png)。
- [1920 深色完整展示](1920-dark-full.png)、[1920 浅色完整展示](1920-light-full.png)。
- [1440 深色](1440-dark-large.png)、[1440 浅色](1440-light-large.png)。
- [390 手机深色](390-dark-large.png)、[390 手机浅色](390-light-large.png)：窄屏收起装饰，保留数据布局。
- [原图版本深色对照](baseline-filled/1920-dark-large.png)、[原图版本浅色对照](baseline-filled/1920-light-large.png)：替换前的人物填充版本，旧截图、元数据与检查结果保存在 `baseline-filled/`。

默认透明度 80%。新素材只显示线条，页面底色透过人物内部，可通过滑块调整显著度。放大贴边模式只在内容区外的侧栏显示人物，完整展示模式将原图缩小放入侧栏；目前 1440px 及以下桌面为中央工具栏安排两行，以提供角色空间。原图方向原样保留。

## 实际验证

[浏览器结果](results.json)：隔离无界面 Edge 完成 22 项检查，覆盖 1920／1680／1440／1280／1024／390px × 原有深浅主题，原图加载、透明遮罩与现有正文色匹配、无横向溢出、侧栏不遮挡中央内容、两种模式、透明度、关闭角色后宽度恢复、日历弹层、离线自包含及窄侧栏中的桌面缩放入口。

页面异常 0，外部请求 0。自包含预览通过浏览器 `file://` 实测。当前仅完成 ChatGPT 两张资源及独立预览；其余九套素材未接收，正式集成与最终布局选择尚未进行。全产品测试没有为这一独立预览重复执行。

当前 Browser 技能连接因 Windows 沙箱初始化失败，按已有项目验收方式使用隔离 Edge 完成真实浏览器截图，不访问个人浏览器会话。

## 重跑

```powershell
node docs/validation/2026-10-02-gpt-skin-preview/preview.mjs
node docs/validation/2026-10-02-gpt-skin-preview/browser-audit.mjs
node docs/validation/2026-10-02-gpt-skin-preview/preview.mjs --serve --port 11031
```

第三条命令输出本机预览地址；省略 `--port` 时自动选取可用端口。脚本优先使用目录中已复制的新线稿，首次复制源目录默认为 `C:/Users/Silver/Downloads/art-access/lineart`，可由 `AGENT_USAGE_GPT_IMAGES` 指定。浏览器模块与 Edge 可分别通过 `AGENT_USAGE_PLAYWRIGHT_MODULE`、`AGENT_USAGE_EDGE_PATH` 指定。

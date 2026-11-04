# TabWise

TabWise 是一个本地优先的 Chrome/Edge 标签管理扩展。它会将符合安全条件的闲置页面替换为本地休眠页，从而卸载原始文档；点击休眠页任意位置或刷新标签页即可恢复原页面。

## What the MVP includes

- 可配置闲置时长，默认 30 分钟
- 两种自动策略：默认保守模式和可选智能保护模式
- 批量休眠、暂停 1 小时、搜索与状态筛选
- 最近休眠记录与单条撤销
- 每 30 分钟自动创建本地恢复点，也可手动保存当前状态
- 保护活动、固定、播放音频、加载中、非网页、永不休眠及未知页面
- 本地休眠记录、重启后占位页重绑定和重复操作保护
- 本地智能整理：按域名分组、精确重复 URL 提示、工作区快照
- Side Panel 页面记忆：用标题、域名和 URL 路径模糊查找打开页、休眠页、工作区和恢复点
- 地址栏搜索：输入 `tw` 后跟查询词；也可用 `Cmd/Ctrl+Shift+K` 打开侧栏
- 可解释的休眠候选、两种节能策略，以及可选的本地关联术语搜索
- 不调用外部 AI、不采集页面正文、无遥测和 host 权限

智能整理层只使用本地标题和域名元数据。后续如接入模型，必须由用户显式启用，并只能生成待预览的建议。

## Page memory and search

TabWise indexes locally available metadata from open and suspended tabs, saved workspaces, recovery checkpoints, and recent suspensions. Search never wakes suspended pages or reads page text. Results favor directly open pages, then suspended pages, then saved snapshots.

Enable "本地关联搜索" in Settings to expand a small built-in set of technical terms such as front-end, performance, browser, database, and design. This is a local lexical association feature, not a cloud model or full-text page search.

Use `tw <keywords>` in Chrome's address bar to search. The first result can be opened with Enter; side panel search shows all matching sources and always uses the normal restore flow.

## Experimental renderer diagnostics

Chrome Dev and Canary users can open the Side Panel and choose `测量一次` under resource diagnostics. TabWise requests the optional `processes` permission only after that action, then takes a single Renderer memory snapshot. Renderer processes can be shared by several tabs, so memory is displayed once per Renderer with its related tabs, not as exact per-tab memory. Stable Chrome and Edge will clearly report that this API is unavailable.

## Suspension modes

- **保守模式（默认）**：只自动休眠“可信网站”列表中的页面，适合对数据安全要求高的场景。
- **智能保护模式（可选）**：自动检查所有普通网页。页面出现编辑、文件选择或媒体活动时会保持保护；未获得网页保护权限或未完成检测的页面同样不会自动休眠。启用该模式时，浏览器会请求对网页运行本地保护脚本的权限；TabWise 只保存保护布尔状态，不读取表单内容。

## Energy strategies

- **深度节能（默认）**：将页面替换为本地休眠页；切回标签不会恢复，点击休眠页或刷新才恢复。
- **轻度节能**：使用 Chrome 的原生 tab discard；原 URL 保留，但切回标签会由浏览器自动重新加载。

## Load locally

1. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `tabwise` directory.
4. Open the TabWise toolbar popup and use **Settings** to add trusted domains before enabling automatic suspension.

## Notes and limits

- 休眠页仍有少量扩展渲染开销，但原网页文档会被卸载，不能承诺零资源占用。
- Unknown pages are deliberately not suspended automatically. This avoids losing unsaved form data or interrupting web apps.
- 切回休眠标签不会自动恢复；点击休眠页内容或刷新标签页才会恢复原页面。
- Chrome 原生 discard 模式例外：切回标签时会自动恢复。
- Workspaces store URLs and titles locally and reopening them cannot restore in-page state, POST submissions, or unsaved edits.

## Development checks

```bash
npm test
npm run test:e2e
npm run check
```

`test:e2e` uses a temporary Playwright Chromium profile in headless mode. It does not open a browser window or use the user's Chrome profile. Before the first run, install the bundled test browser with `npx playwright install chromium`.

No package installation is required. This project is loadable directly as an unpacked Manifest V3 extension.

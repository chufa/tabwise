# TabWise

TabWise 是一个本地优先的 Chrome/Edge 标签管理扩展。它会使用浏览器原生休眠卸载符合安全条件的闲置页面，不改变标签 URL 或浏览历史；切回休眠标签时，Chrome 会自动重新加载页面。

## What the MVP includes

- 可配置闲置时长，默认 30 分钟
- 两种自动策略：默认保守模式和可选智能保护模式
- 批量休眠、暂停 1 小时、搜索与状态筛选
- 最近休眠记录与单条撤销
- 每 30 分钟自动创建本地恢复点，也可手动保存当前状态
- 保护活动、固定、播放音频、加载中、非网页、永不休眠及未知页面
- 本地休眠记录、重启后占位页重绑定和重复操作保护
- 本地智能整理：按域名分组、精确重复 URL 提示、工作区快照
- 不调用外部 AI、不采集页面正文、无遥测和 host 权限

智能整理层只使用本地标题和域名元数据。后续如接入模型，必须由用户显式启用，并只能生成待预览的建议。

## Suspension modes

- **保守模式（默认）**：只自动休眠“可信网站”列表中的页面，适合对数据安全要求高的场景。
- **智能保护模式（可选）**：自动检查所有普通网页。页面出现编辑、文件选择或媒体活动时会保持保护；未获得网页保护权限或未完成检测的页面同样不会自动休眠。启用该模式时，浏览器会请求对网页运行本地保护脚本的权限；TabWise 只保存保护布尔状态，不读取表单内容。

## Load locally

1. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `tabwise` directory.
4. Open the TabWise toolbar popup and use **Settings** to add trusted domains before enabling automatic suspension.

## Notes and limits

- Native tab discard can substantially reduce page renderer work, but cannot promise zero browser resource use.
- Unknown pages are deliberately not suspended automatically. This avoids losing unsaved form data or interrupting web apps.
- Clicking a suspended tab lets Chrome reload the original page. No placeholder page or additional history entry is created.
- Workspaces store URLs and titles locally and reopening them cannot restore in-page state, POST submissions, or unsaved edits.

## Development checks

```bash
npm test
npm run check
```

No package installation is required. This project is loadable directly as an unpacked Manifest V3 extension.

# TabWise

TabWise 是一个本地优先的 Chrome/Edge 标签管理扩展。它会将符合安全条件的闲置页面替换为本地休眠页，从而卸载原始文档。切回标签不会自动恢复；用户可点击恢复或刷新当前标签。

## What the MVP includes

- 可配置闲置时长，默认 30 分钟
- 仅对用户主动信任的网站自动休眠
- 批量休眠、暂停 1 小时、搜索与状态筛选
- 保护活动、固定、播放音频、加载中、非网页、永不休眠及未知页面
- 本地休眠记录、重启后占位页重绑定和重复操作保护
- 本地智能整理：按域名分组、精确重复 URL 提示、工作区快照
- 不调用外部 AI、不采集页面正文、无遥测和 host 权限

智能整理层只使用本地标题和域名元数据。后续如接入模型，必须由用户显式启用，并只能生成待预览的建议。

## Load locally

1. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `tabwise` directory.
4. Open the TabWise toolbar popup and use **Settings** to add trusted domains before enabling automatic suspension.

## Notes and limits

- A suspended tab still renders a small extension-owned placeholder, so it cannot promise zero browser resource use.
- Unknown pages are deliberately not suspended automatically. This avoids losing unsaved form data or interrupting web apps.
- Clicking a suspended tab only opens the placeholder. Use **Restore page** or refresh the tab to navigate back to the original URL.
- Workspaces store URLs and titles locally and reopening them cannot restore in-page state, POST submissions, or unsaved edits.

## Development checks

```bash
npm test
npm run check
```

No package installation is required. This project is loadable directly as an unpacked Manifest V3 extension.

# TabWise

TabWise 是一个本地优先的 Chrome/Edge 标签管理扩展。它会将符合安全条件的闲置页面替换为本地休眠页，从而卸载原始文档；点击休眠页任意位置或刷新标签页即可恢复原页面。

## What the MVP includes

- 可配置闲置时长，默认 30 分钟
- 两种自动策略：默认保守模式和可选智能保护模式
- 批量休眠、暂停 1 小时、搜索与状态筛选
- 最近休眠记录与单条撤销
- 统一最近操作：撤销标签分组、保存/归档/固定工作区和休眠，冲突项显示原因
- 每 30 分钟自动创建本地恢复点，也可手动保存当前状态
- 保护活动、固定、播放音频、加载中、非网页、永不休眠及未知页面
- 本地休眠记录、重启后占位页重绑定和重复操作保护
- 本地智能整理：按域名分组、精确重复 URL 提示、工作区快照
- Side Panel 页面记忆：用标题、域名和 URL 路径模糊查找打开页、休眠页、工作区和恢复点
- 搜索精确打开命中的单页；工作区和恢复点支持勾选恢复、跨窗口去重及分批加载
- 完整会话布局：窗口、标签顺序、固定/活动状态、原生标签组名称/颜色/折叠状态和休眠状态
- 界面实时同步浏览器变化，保留搜索、工作区编辑和 AI 建议的选择
- 本地中文分词、拼音/首字母、英文拼写纠错，以及来源/窗口/状态/工作区筛选
- 最近关闭找回、快照增删与布局对比，勾选恢复缺失页
- 工作区重命名、成员编辑、保留来源的去重合并和可撤销回收站
- 恢复任务中心：逐页进度、停止后续批次、失败与中断任务安全重试
- 当前窗口关联工作区、更新差异预览、最近 5 个旧版本回退
- 可选网页数量与 JS 堆预算、持续增长提示及确认后的安全回收
- 大量标签分页、活动变化复用搜索索引、高频元数据合并写入
- 分钟级定时巡检、离线后补跑一次、失败/中断记录及手动重试
- 地址栏搜索：输入 `tw` 后跟查询词；也可用 `Cmd/Ctrl+Shift+K` 打开侧栏
- 可解释的休眠候选、两种节能策略，以及可选的本地关联术语搜索
- 可选浏览器内置 AI / 本机 Ollama：选择分析范围、预览元数据、编辑主题建议后确认应用
- 不调用远程 AI、不采集页面正文或遥测；网页访问权限仅用于本地页面保护和 JS 堆内存采样

智能整理只使用用户所选页面的标题、域名和状态。模型仅在点击生成时运行，建议不会自动执行标签操作。

## 可核对的 AI 主题建议

在侧栏「本地 AI 整理」中选择当前窗口、已保存工作区或手动勾选页面，点击「预览分析输入」。这里展示完整的页面元数据输入及接收方；生成时使用同一份快照，不重新扩大分析范围。每次最多 20 页、最多 3 个主题；超出范围会提示缩小选择，不会静默截断。私密窗口和浏览器内部页面不参与分析，休眠页及已保存工作区不会因分析而打开。

「生成主题建议」会返回主题名、具体页面成员及基于标题/域名的归类依据。你可以改名、取消成员，再逐项确认「建立标签组」或「保存为工作区」。保存保留 URL 与原始标题，不关闭当前标签；工作区输入只能保存，不会自动打开页面来分组。原生分组要求同一窗口内至少两个非活动、非固定且未播放音频的普通网页。

两种提供方均校验 JSON schema、快照编号及页面成员，拒绝未知、重复、跨主题或额外动作字段。输入快照 10 分钟有效，只保存在浏览器会话中；关闭、重新加载、导航、标题变化或移窗后，旧成员不能应用，需重新预览并生成。应用接口只对发起分析的扩展侧栏文档开放，同一主题的同一动作不能重复执行。

设置中可以选择浏览器内置模型或本机 Ollama（HTTP loopback 地址，需已安装对应模型）。模型不可用或输出格式不合规时会显示原因；本地搜索和 Popup 的按域名整理仍可用。「结构已校验」表示格式和成员有效，归类依据仍需用户核对，不代表已经验证页面正文或模型推断。

设置中的「模型自检」使用表单中的地址与模型，读取已安装模型及 completion 能力，并从扩展来源执行小型 JSON 推理。通过后展示耗时和扩展来源；列表中不支持生成的模型无法选择。自检不发送网页数据，也不自动保存表单。浏览器模型自检先检查可用状态，未准备好的模型不会触发下载。

若自检或生成返回 403，在 `chrome://extensions` 查看 TabWise 的扩展 ID，退出原来的 Ollama 服务后以允许该来源的方式启动：

```bash
OLLAMA_ORIGINS='chrome-extension://<TabWise 扩展 ID>' ollama serve
```

将占位符替换为实际 ID，Ollama 地址仍保持本机 loopback。若服务提示模型不支持 generate，请改用模型清单中包含 `completion` 能力的模型；已有模型文件并不保证与当前 Ollama 版本兼容。

结构化主题请求通过 `think: false` 让支持该选项的本地模型直接输出 JSON，避免将有限输出预算消耗在思考内容上；仍会对返回结构和页面成员执行本地校验。生成和自检推理最多等待 90 秒，连接检查最多等待 30 秒；超时不会应用建议。

生成期间可以点击「停止生成」。切换范围、修改目标、刷新/关闭侧栏也会取消请求；Ollama HTTP 请求会中止，浏览器模型会停止并释放会话。取消后的输出不能再通过接受或应用接口；模型服务自身是否立即停止底层计算取决于其取消实现。

建议缓存仅保存在当前浏览器会话，最多 10 条、5 分钟有效。缓存键区分提供方、地址、模型、目标和完整元数据成员；不保存完整 URL 或浏览器标签 ID。命中后绑定新快照和新成员编号，再检查实时页面状态，界面显示「缓存 · 已重新校验」；「清空建议缓存」可强制下次重新推理。

## 最近操作与撤销

侧栏「最近操作与撤销」保留本次浏览器会话最近 20 条操作；后台 worker 重启仍保留，浏览器重启后清空，避免旧标签/分组 ID 被复用。标签分组撤销会恢复原分组、名称、颜色、折叠状态和标签顺序；如果窗口内的页面、分组或顺序已经变化，就跳过该窗口。工作区保存撤销仅移除仍与保存时完全一致的新工作区，不关闭标签；归档、取消归档和固定状态也可撤销。休眠撤销复用原有恢复机制，已导航或关闭的页面不会强制重开。

每条撤销只执行一次，显示恢复成功项和冲突原因；执行中断的记录不会自动重放。撤销不能恢复网页内未保存的表单或运行状态。保存达到 20 个工作区上限时会拒绝新保存，避免覆盖旧工作区。重命名、成员编辑和移入回收站也纳入统一撤销。

## 选择性恢复与工作区管理

点击搜索结果只打开该条记录对应的页面；如果同一完整 URL 已在任一窗口打开，则聚焦已有标签，休眠页先恢复。保存的成员索引与 URL 必须仍匹配，过期结果需重新搜索。

侧栏和 Popup 中的工作区与恢复点提供恢复预览，可以全选、全不选或逐页勾选。默认跳过所有窗口中已打开（包括休眠）的相同 URL，也会去重所选页面；取消该选项可明确打开副本。每批最多 5 页，等待加载完成后继续，单页等待最多 8 秒，超时显示“仍在加载”，后续批次继续。每页有成功、跳过或失败结果。预览只在当前界面文档、当前浏览器会话有效，5 分钟过期；执行前校验保存内容，预览只允许执行一次。恢复的是保存的网址，不能还原网页进程、表单或登录态。

工作区可重命名、取消成员、固定或归档；勾选多个工作区后可创建去重合并的工作区，原工作区保留。搜索打开成员和确认恢复都会更新最近打开时间。移入回收站仅改变本地快照，不关闭标签，也不参与搜索、AI 分析或自动归档。回收站最多 20 个，满额时拒绝继续移入；可恢复或在明确确认后永久删除。恢复及撤销也遵守 20 个有效工作区上限。备份导出只包括回收站之外的工作区，导入容量不足时拒绝整批导入，不覆盖现有工作区。

## 自动化运行记录

巡检时间精确到分钟，以本机日历计算下一次单次 alarm。浏览器错过运行后，在启动或下一次分钟检查时最多补跑一次。最近 20 条运行记录保存状态、阶段、恢复点数量、已归档数量、耗时和错误；副作用前先记录运行状态。已运行的定时槽位，包括失败槽位，不自动重放；后台重启时未完成记录标为“后台中断”，可检查后手动重试。重试建立新记录并关联原记录，同一失败记录只允许发起一次重试；若再次失败，可重试新的失败记录。

## 恢复任务中心

Popup 和侧栏显示当前浏览器会话最近 10 个恢复任务，最多同时排队 5 项。确认恢复后立即返回任务编号，关闭界面后继续执行；任务及打开意图先写入会话存储，再创建窗口和标签。每批最多 5 页，停止会等待当前批次结束，后续页面保持未完成状态。详情每页显示 50 条结果。

后台 worker 重启会把未完成任务标记为中断，不自动重放。打开结果不确定的页面标为“需要重新检查”；手动重试只选择失败、已关闭或未完成页面，再检查保存来源和所有窗口的逻辑网址，默认跳过已存在页面。重试会生成关联原任务的新记录。浏览器退出后任务记录清空，保存的工作区和恢复点仍保留。

## 工作区增量更新

在工作区中点击「关联当前窗口」，再点击「更新预览」。预览显示相对保存内容的新增、移除、标题及布局变化；确认时重新检查窗口、关联和工作区内容，变化后需重新预览。更新保留原工作区编号、名称和固定/归档信息，仅替换保存的页面及布局，不关闭标签。

每次增量更新或版本回退保留旧内容，最多 5 个历史版本。「历史版本」支持先看差异再确认回退，回退也保存当前版本。关联仅在当前浏览器会话有效，旧版本保存在本地工作区中；这些更新也可通过最近操作撤销。

## 资源预算

在设置中开启预算提醒，默认网页数量预算为 50 页、已采样 JS 堆预算为 1024 MB。网页数量只计普通、非无痕、尚未休眠的网页；堆预算仅计最近 5 分钟的有效采样，并显示覆盖数量及最早采样时间。未采样页面不按零内存推断，JS 堆不代表浏览器物理内存。

持续增长提示要求同一网址和文档连续 3 个不同时间的采样均增长，累计增长至少 64 MB；新增采样覆盖不计为页面增长，导航或关闭会清除历史。提示只说明采样趋势，不能证明内存泄漏。

超出预算后可预览安全回收候选，勾选后确认休眠，每次最多 50 页。候选必须通过当前保护策略和网页保护检查，并达到闲置阈值；活动、固定、播放音频、未保存编辑、上传、加载中和保护状态未知的页面均排除。执行前和休眠前再次检查网址、文档版本、设置、活动及保护状态，变化项会跳过。使用智能保护模式可获得网页保护状态。预算功能本身不自动休眠或关闭页面。

## 大量标签性能

Popup 标签列表每页最多渲染 50 条，翻页、刷新时保留当前页；修改搜索或筛选后回到第一页。整理建议最多展示 12 项，展开成员最多 50 页。侧栏搜索继续通过后台检索完整索引，再返回有限结果。

快照构建和差异对比使用窗口、分组和重复网址映射，避免逐页扫描全部列表。只有标题、域名或网址变化才重新编译中文/拼音搜索数据，活动、状态、窗口等变化更新结果元数据；并发搜索共用正在进行的索引构建。标签元数据更新按 100 ms 合并最新值，关闭标签前立即写入待处理更新；未变化数据不重复写入。

`node test/performance.mjs` 使用 300/1000 页确定性元数据测量快照、索引和查询耗时，不会打开真实网页。浏览器回归另验证 1000 条仪表盘数据下每页 DOM 的数量，以及真实页面的停止、重试、保护和版本回退流程。

## 会话布局、最近关闭与对比

新保存的工作区和恢复点使用布局快照，记录普通网页所在窗口、页内顺序、固定与活动状态、标签组名称/颜色/折叠状态及休眠状态；休眠页保存原始网址，内部页面和无痕页不纳入。窗口和分组使用快照内编号，不持久化 Chrome 标签/窗口 ID。只对相邻的相同恢复点去重，A → B → A 的会话变化仍保留。

恢复预览默认勾选「新建窗口恢复布局」，只给实际新开的页面创建窗口、恢复顺序和分组，已存在页面保持原样。新恢复的休眠页直接打开本地占位页，不访问原站。取消布局选项后，所选网页在当前窗口加载。仅选择部分页面时，顺序压缩为所选页的相对顺序；Chrome 对固定页、活动页和标签组的限制仍适用，布局失败会显示原因。旧版网址列表仍可恢复，工作区 JSON 备份导入保留有效布局。快照不能还原网页进程、表单、滚动位置或登录会话。

Popup 和侧栏中的「最近关闭」默认开启，最多保留 100 条标题/网址，默认 7 天，设置中可改为 1–30 天；无痕页面不记录。关闭记录跨扩展后台重启保留，过期记录在读取时从本地存储清理。可用标题、拼音、首字母或网址找回，优先复用已打开的相同网址，成功后移除记录。可以清空列表，关闭此功能也会清空已有记录。不读取浏览器全局历史记录，不需要新增 history/sessions 权限。

「快照对比」选择基准恢复点和当前会话或另一恢复点，显示新增、缺失及窗口/分组/固定/活动/休眠状态变化。相同网址的重复出现按数量比较；只勾选想找回的缺失页面，再打开恢复预览。对比结果显示生成时间，恢复前重新校验基准内容与当前已打开页面，避免重复恢复。

打开的 Popup 和侧栏通过浏览器事件合并刷新，隐藏后断开订阅，显示或后台重启后重新连接；不会额外轮询后台。刷新保留表单草稿、勾选、搜索筛选、恢复预览和 AI 主题编辑，执行仍需原有快照校验。存储中的读改写按区域串行，避免同时休眠、关闭或保存时丢失条目。

## Page memory and search

TabWise indexes locally available metadata from open and suspended tabs, saved workspaces, recovery checkpoints, and recent suspensions. Search never wakes suspended pages or reads page text. Results favor directly open pages, then suspended pages, then saved snapshots.

Side panel search supports Chinese word segmentation, full pinyin and initials (using the vendored MIT-licensed pinyin-pro 3.29.5), plus bounded English typo matching. Filters combine source, status, current browser window and saved workspace. Identical complete URLs are merged after filtering, with all matching sources shown; fragments remain distinct. Metadata is compiled incrementally and invalidated on browser/storage events, with a one-minute freshness bound for expired closed entries. Older asynchronous responses cannot overwrite a newer query.

Enable "本地关联搜索" in Settings to expand a small built-in set of technical terms such as front-end, performance, browser, database, and design. This is a local lexical association feature, not a cloud model or full-text page search.

Use `tw <keywords>` in Chrome's address bar to search. The first result can be opened with Enter; side panel search shows all matching sources and always uses the normal restore flow.

## Page memory diagnostics

TabWise rotates across at most 25 eligible webpages per one-minute sampling round, with at most four script calls in flight. Automatic idle checks rotate across at most 50 tabs, so large windows do not permanently miss tabs beyond the first 50. Untouched samples remain available while closed, discarded and navigated tabs lose stale samples; navigation revisions reject measurements from a changed document even if it returns to the same URL. UI refreshes do not start repeated rounds within a minute. The dashboard displays measured/eligible coverage and the latest session-only value in each tab row; those values come from different sampling times. Resource Diagnostics and resource reviews can force a full refresh with the same concurrency limit. Chrome Dev and Canary can additionally grant the optional `processes` permission to display shared Renderer private memory. Renderer processes can be shared by several tabs, so that metric is shown once per Renderer with its related tabs, not as exact per-tab memory.

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

AI E2E 使用本地 HTTP 假模型和浏览器 API 假模型验证范围、预览、结构校验、编辑/确认、旧建议拒绝及不可用场景，同时验证真实分组撤销、状态冲突、HTTP 请求取消、缓存重绑定和模型自检失败路径；不代表真实模型的推理质量或特定 Chrome 设备上的内置模型可用性。校验模块覆盖率可用 `node --test --experimental-test-coverage test/ai-analysis.test.js test/ai-cache.test.js test/operations.test.js` 检查。

No package installation is required. This project is loadable directly as an unpacked Manifest V3 extension.

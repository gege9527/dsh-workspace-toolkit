# dsh-workspace-toolkit

[![npm version](https://img.shields.io/npm/v/dsh-workspace-toolkit.svg)](https://www.npmjs.com/package/dsh-workspace-toolkit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-orange.svg)](https://github.com/deepseek-ai/dsh)

> DSH workspace enhancement toolkit: add "Copy Workspace Path" and "Batch Archive Sessions" actions to every workspace row in the DSH sidebar.
>
> DSH 工作区增强工具包：在资源管理器侧边栏的每个工作区行注入“复制工作区路径”和“批量归档会话”快捷操作。

## Features

- **复制工作区路径 / Copy Workspace Path**
  - 出现在每个 workspace 行右侧的“⋮”菜单中。
  - 从 `ctx.workspaces.list` 读取该工作区的绝对路径，调用剪贴板 API 复制到系统剪贴板。
  - 无路径或复制失败时给出提示。

- **批量归档会话… / Batch Archive Sessions…**
  - 从工作区菜单打开会话列表面板。
  - 列出该工作区下所有非空白、未归档的会话（运行中的会话半透明显示，由用户自行决定是否归档）。
  - 支持全选 / 取消全选、显示更新时间、顺序调用 `uiWorkspace.archiveSession(sessionId)`，单个失败即暂停并提醒，避免并发覆盖 archive set。

- **迁移工作区… / Migrate Workspace…**
  - 始终出现在工作区行右侧“⋮”菜单。点击时检查该工作区路径：路径正常则提示“工作区路径正常，无需迁移”；原目录已不存在（例如用户移动了项目文件夹）才打开迁移向导。
  - 选择已存在的目标目录后，把该工作区名下的全部会话（含子代理会话）原样迁到新路径。
  - 默认**免重启**：迁移会话日志目录，只改写日志首帧 header 的 `cwd`，再刷新注册表内存索引并通过公开 API 重建工作区；侧边栏经 DSH 的 `domain/changed` 事件流自动更新。
  - 不兼容当前 DSH 内部索引结构时自动降级为“重启后完成”：journal 落盘，下一次 DSH 启动时自动续跑。
  - 保留会话 id、全部事件、标题、工作区标题/顺序、会话顺序、归档/置顶状态；工作区内部 id 会变（无公开 API 可指定）。
  - 支持完成前回滚、崩溃续跑、活动会话拒绝、格式/空间/目标占用预检。
  - 不移动项目文件；目标目录必须已经存在。

- **删除归档会话 / Delete Archived Session**
  - 每条归档会话行的 hover 操作区在“取消归档”旁新增 **删除会话 / Delete session**，会话右键菜单也有同名项。
  - 点击后二次确认，红字标注**删除后不可恢复**；取消、Esc、点遮罩都不会发出请求。
  - 服务端顺序固定：校验归档态 → 用 `stat().location` 解析目录 → 仅拒绝“仍在运行”的 Agent → 释放空闲但仍驻留的 Agent → 删整个会话目录（含全部格式 generation）→ 清理投影缓存（目录布局与单文件布局都探测）→ 取消归档 → detach 工作区记账并清掉 registry header 索引。
  - 只对归档会话开放；未归档且日志仍在时会话返回 `not-archived`，日志与归档状态都不动。
  - 删除后浏览器立即隐藏该行、调用 `ctx.sessions.refresh()` 重拉会话目录；宿主同时通过 workspace detach 推送新的 `sessionIds`，所以行不会留在侧边栏。
  - hover 的删除按钮在点击时**重新从当前行解析会话 id**，并再次校验该 id 仍处于归档态；避免 React 复用行动作区时误删相邻会话。删除前若会话仍驻留 SessionStore，宿主会先释放空闲 Agent，再通过 store entry 的 detach 清掉 idle 引用。
  - 幂等：日志已不存在时仍会清理归档标记与工作区记账并返回成功；重复点击不再报 `not-found`。
  - 逐条返回 `{id, ok, stage, bytes, alreadyGone?, detached?, filesRemoved?, error?}`，部分失败不回滚已删项。

- **只读查看归档会话 / Read-only View of Archived Session**
  - 点击归档会话行与点击未归档会话**效果一致**：直接使用 DSH 原生聊天窗口显示历史与工具消息，不再弹窗、不再覆盖面板；不再额外注入“查看”按钮。
  - 查看时**不取消归档、不写宿主归档状态**：只临时包装 DSH 导航服务的 `clearArchivedCurrent`（列表变化时清掉“当前选中的归档会话”的那段策略），查看期间让它返回 `false`，退出时还原。因此归档行、删除按钮、宿主归档门禁全部保持不变，也没有 unarchive/archive 往返和侧边栏重排，切换不卡。
  - 通过会话 scope 的 `conversation.blocks.set` 加只读块，原生输入框变为禁用状态，占位文案说明“仅可查看”；宿主仍认为会话已归档，归档门禁继续生效。
  - 归档行仍在归档列表里，所以**可以直接删除正在查看的归档会话**（确认后宿主释放 Agent/live entry、删日志，客户端切到新会话视图）。
  - 若 DSH 未来移除该导航方法，插件会拒绝打开并提示，而不是退化为“取消归档”，避免产生未归档会话。

- **点击附件在右侧栏查看 / Click Attachment to Preview in Right Sidebar**
  - 用户消息中的文件附件卡片现在可点击，与查看源码文件一样在右侧栏打开预览。
  - 附件实体按 `<DSH_HOME>/attachments/v1/files/<sha256前2>/<sha256>/<文件名>` 内容寻址存储，宿主在页面注入 `__DSH_WORKSPACE_TOOLKIT__.attachmentsRoot`，点击时拼出 `dsh-resource://file/session/…` 地址交给 `ctx.sidebarRight.openResource`，复用 DSH 自带文件查看器（text/code/markdown/… 按扩展名自动匹配）。
  - 索引来自 `user/message` 会话事件中的 `FileAttachmentRef`；历史消息在首次点击时从会话事件窗口补索引。

- **长文本粘贴自动转文件附件 / Long Paste Converts to File Attachment**
  - 对齐 chat.deepseek.com 网页版行为：在输入框粘贴纯文本超过阈值（默认 2000 字符，宿主注入可配）时，自动转成 `<文本前24字符>.txt` 文件附件随消息发送，而不是塞进输入框。
  - 经官方草稿管线（`conversation.createDrafts` + `conversation.input.addAttachments`）走正常文件上传，转文件失败时原文回填输入框，不丢内容。
  - 阈值/开关由宿主注入 `__DSH_WORKSPACE_TOOLKIT__`（`pasteToFileLimit`），无注入时默认 2000 且功能自动禁用。
  - 手动拖入的文件与粘贴生成的文件都可点击卡片在右侧栏预览。
  - composer 附件卡片可点击在右侧栏预览；卡片上的 remove / 重试按钮交给 DSH 原生处理，插件只放行不拦截。
  - **切换会话后附件丢失属 DSH 原生行为**（draft 附件不跨会话保留），插件不干预、不自动恢复，避免误复活已发送内容。

- **粘贴原文至输入框 / Paste Original Back**
  - 粘贴生成的附件卡片下方自动出现“粘贴原文至输入框”按钮（纯文字 + 下划线，左对齐）。
  - 点击后原文回填输入框、附件卡片消失（对齐网页版行为）；原文超过恢复上限（614400 字节）时给出提示。

- **超长消息气泡折叠 / Collapse Long User Message Bubble**
  - 用户消息正文超过阈值（默认 2000 字符）时自动折叠为 120px 限高 + 底部渐隐，旁挂“展开 / 收起”按钮（参考 AI 思考折叠交互）。
  - 纯浏览器端实现，不改 DSH core；折叠状态由按钮切换，不影响消息内容与发送。

## Requirements

- [Node.js](https://nodejs.org/) >= 18
- DSH CLI / Web Client（本插件针对 DSH 工作区侧边栏的 DOM 结构实现）
- Peer dependency: `@deepseek-ai/dsh-tools >= 0.0.1-rc.1`

## Installation

### As a DSH plugin（推荐 / Recommended）

```bash
# 替换 <your-profile> 为实际 profile 名
dsh plugin --profile <your-profile> add dsh-workspace-toolkit
```

添加后刷新或重启 DSH Web 客户端即可生效。

### From npm / 从 npm 安装

```bash
npm install dsh-workspace-toolkit
```

在 DSH profile 中按本地插件引用（示例）：

```yaml
# your-profile.yml
plugins:
  - id: workspace-toolkit
    package: ./node_modules/dsh-workspace-toolkit
```

> 实际路径和配置方式请遵循你使用的 DSH 版本文档。

## Usage

1. 打开 DSH Web 客户端左侧的工作区（Workspace）侧边栏。
2. 点击工作区行右侧的 `⋮`（Workspace actions）菜单。
3. 选择 **复制工作区路径 / Copy Workspace Path** 即可复制该工作区的绝对路径。
4. 选择 **批量归档会话… / Batch Archive Sessions…**，勾选需要归档的会话后点击“归档所选”。
5. 点击自己消息里的**文件附件卡片**，右侧栏会像查看源码文件一样打开预览。
6. 选择 **迁移工作区…**：路径正常会提示无需迁移；原目录已被移动时才进入向导。填写已存在的目标目录并先点“预检”；确认摘要后点“开始迁移”。若显示“迁移完成，无需重启”，侧边栏会在事件流更新后出现新工作区；若提示需要重启，重启 DSH 后自动完成。
7. 在输入框**粘贴超长文本**（>2000 字符），自动转为 `.txt` 文件附件发送；附件卡片下方出现“粘贴原文至输入框”可一键还原。
8. 发送超长文本消息后，气泡自动折叠，点“展开”查看全文。
9. 在“显示已归档”视图中点击归档会话行：像点普通会话一样直接打开原生聊天窗口，输入框显示为禁用状态；切到其他会话后自动恢复归档。点 hover 的**删除会话**删除（需二次确认，不可恢复，按钮按当前行重新取 id）。

## File Structure

```text
index.js          # Host half entry: injection facts, migration HTTP API, session delete/read API, boot recovery.
migration/        # Host-only migration engine: paths, zstd log rewrite, journal, registry compat, orchestration.
sessions/         # Host-only archived-session services: local-only HTTP guard, path resolution, delete, cache/workspace eviction, read-only projection.
test/             # node:test unit tests (run: node --test).
client.js         # Browser half: menu injection, batch-archive dialog, migration wizard/status banner.
cordis.patch.yml  # Cordis bundle patch used by DSH to load the browser plugin.
```

## How It Works

- **DOM observation**: 监听 `document.body` 下的 `[role="menu"]`，识别 workspace 菜单后注入自定义 `menuitem`。
- **Copy path**: 从 `ctx.workspaces.list` 快照获取对应工作区的 `path`，写入系统剪贴板；不支持 Clipboard API 的环境会回退到 `document.execCommand('copy')`。
- **Batch archive**: 打开弹窗时读取 `ctx.workspaces.list` 与 `ctx.sessions.list` 的快照，筛选出可归档会话，按顺序逐个归档。
- **Attachment preview**: 宿主在 `webserver/index-inject` 注入 `__DSH_WORKSPACE_TOOLKIT__`（附件根目录 + 粘贴阈值）；浏览器监听 `session/event` 的 `user/message` 索引 `FileAttachmentRef`，点击附件卡片时拼 `dsh-resource://file/session/<id>/<绝对路径>` 调 `sidebarRight.openResource` 打开右侧栏预览（复用 DSH 文件查看器）。
- **Paste-to-file**: 监听 `data-composer-input` 的 paste 事件，纯文本超阈值即 `preventDefault`，经 `conversation.createDrafts` 生成 `<首行50字符>.txt` 附件并 `conversation.input.addAttachments` 加入草稿；失败时原文回填输入框。
- **Paste restore**: paste 转文件时把原文、草稿 id、活引用（`shell`/`conversation`）存入记录；点恢复按钮时直接用这些引用把原文 `setDraft` 回输入框并 `removeAttachment` + `releaseDraftAttachment` 释放附件（不重新解析服务，避免 inactive context 报错）。
- **Migration**: 预检枚举 `workspace.sessionIds` 与所有 `header.cwd === oldPath` 的日志（含 subagent 子会话），逐会话取 `sessionPersistence` 写租约、rename 目录到新 `projectKey`、只重压首帧 header 并原样拷贝其余帧。完成阶段先 `stat` 新 header 刷新 registry 私有索引（feature-detect `indexHeader` 或索引 Map），再走公开 API：`create(path, markerTitle)` → `setTitle` → 逆序 `attachSession` → `insertBefore` → `delete` 旧记录。失败或索引不可用则写 `awaiting-restart` journal，由下一次启动完成。journal 在 `<DSH_HOME>/workspace-toolkit/migrations/`。
- **Delete archived session**: 浏览器 `POST /api/workspace-toolkit/sessions/delete`（先校验 `Host`/`Origin` 为本机，否则 403）。宿主逐 id 执行“归档校验 → `sessionPersistence.stat().location` 推导目录 → 仅运行中 Agent 拒绝 → 空闲 Agent `dispose()` 并等 Session 离场 → 删目录 → 清 `session_projcache` → `workspaceRegistry.unarchiveSession` → `WorkspaceEntity.detachSession` + 清 `headers`/`sessionPaths` 索引”；路径不自行实现 `projectKey`，并校验解析结果仍在 `<DSH_HOME>/sessions` 下。
- **View archived session**: 浏览器临时包装 `ctx.uiWorkspace.clearArchivedCurrent` 为返回 `false`（DSH 用它清掉列表变化时仍处于归档态的当前选中），再 `uiWorkspace.openSession(id)` 复用原生 Chat；通过会话 scope 的 `conversation.blocks.set(id, { reason })` 让原生输入框进入只读态。离开时清除 block 并还原原方法。整个过程不调用 `unarchiveSession/archiveSession`，归档行与宿主状态不变。宿主仍保留 `/sessions/read` 只读诊断接口，但浏览器 UI 不再使用。
- **Bubble collapse**: 监听 `data-chat-flow-kind="user"` 行，行总文本超 2000 时定位气泡加 `max-height` 限高 + 渐隐；按钮切换 `dsh-long-text-clamp` class 展开/收起。多轮初始扫描（400ms/1.5s/3s）+ 统一防抖 MutationObserver 覆盖历史加载与渐进渲染，按行 key 去重防重复注入。
- **Performance**: 3 个全量 MutationObserver 合并为 1 个统一 observer，一次遍历按需分流（菜单注入 / composer 卡片 / 气泡折叠）；文本长度统计排除插件自身按钮文本，避免自增触发无限重评估。
- **Internationalization**: 文案根据浏览器 `navigator.language` 在中文与英文间自动切换；暂时无法跟随 DSH 内部语言热切换。

## Limitations

- 本插件不修改 DSH core，依赖 workspace 行与菜单的 DOM 结构；若 DSH 更新后 DOM 变化，插件可能需要同步更新。
- 批量归档弹窗基于 `ctx.workspaces.list` 和 `ctx.sessions.list` 渲染，不直接操作会话行 DOM，因此相对稳定。
- 菜单文案基于 `navigator.language` 简单判断，无法跟随 DSH 内部语言切换。
- 批量归档使用顺序调用以避免并发覆盖；单个失败会暂停并弹窗提示。
- 工作区迁移依赖 DSH 当前的存储布局（Session format v4、workspace unit v2、`projectKey` 编码）。DSH 升级后需同步兼容表；免重启路径依赖未公开的 registry 索引刷新，feature-detect 失败会自动退回“重启后完成”。
- 迁移后工作区内部 id 变化；客户端按 workspaceId 记住的临时选中状态会重置。
- 迁移只改 DSH 会话存储，不移动项目文件；历史事件里的绝对路径保持原样。不要同时运行两个使用同一 `DSH_HOME` 的 DSH 实例。
- 迁移入口始终显示，但只用于“原工作区目录已缺失”的场景；点击时路径正常会提示无需迁移，预检也会以 `migration/source-present` 拒绝，避免把正常工作的空间改指到别处。
- 会话格式低于 v4 或压缩/目录布局不受支持时拒绝迁移，不做部分迁移。
- 删除入口依赖 DSH 归档行的两个耦合点：`aria-label` 为“取消归档 / Unarchive session”的 hover 按钮，以及行的 `data-row-key="session:<id>"`。任一失配时删除/查看入口静默跳过（会话右键菜单仍可用），不会让插件抛错。
- 两个会话路由只接受本机请求：`Host` 必须是 `localhost` / `127.0.0.1` / `[::1]`，`Origin` 若存在必须同源，否则 403。用 `--host 0.0.0.0` 暴露到局域网时这两个接口仍然不可远程调用。
- `index.js`/`sessions/*` 属于宿主半，升级后必须重启 DSH 才生效；只刷新页面会继续运行旧删除逻辑。客户端在删除失败且宿主 build 标记缺失时会提示“宿主插件还是旧版本，请重启 DSH”。
- 删除绕过 `SessionPersistence` 抽象直接删文件（DSH 目前没有删除 API）；若未来 DSH 提供 `deleteSession`，把 `sessions/delete.js` 的落盘步骤替换即可。删除会先 dispose 空闲/残留 Agent，并调用 SessionStore entry 的私有 detach 清理仍驻留的 idle 会话；若目标会话正被某个客户端打开，该视图会被断开。
- 删除后的内存清理依赖 Workspace registry 的私有索引字段（`headers`/`sessionPaths`）与 `WorkspaceEntity.detachSession`；字段改名时 `sessions/evict.js` 会跳过这一步（日志仍删掉，行可能留到刷新/重启），不会让删除整体失败。
- 归档查看依赖导航服务的私有 `clearArchivedCurrent` 方法；方法改名或移除时插件拒绝打开归档会话并提示，不会退化成取消归档。查看期间会话仍留在归档列表，可直接删除。
- 只读输入框依赖 DSH 的 `conversation.blocks` 契约；该契约改名时，插件会退化为给 `[data-composer-seat]` 加 `inert`（输入仍禁用，但没有占位文案）。

## Migration recovery

- Journal: `<DSH_HOME>/workspace-toolkit/migrations/<migrationId>.json` (completed journals move to `migrations/done/`; a diagnostic snapshot lives in `migrations/snapshots-<id>/`).
- States: `prepared` → `files-moved` → `completing` → `complete`，异常时为 `failed` / `awaiting-restart`，回滚后为 `rolled-back`。
- 完成前（`registryStarted !== true`）可在 UI 的“回滚迁移”或 `{"action":"rollback","migrationId":"…"}` 恢复文件与 header。
- 完成已开始（`registryStarted: true`）时不要手工回滚文件；在 UI 点“继续完成”，或重启 DSH 让启动完成阶段续跑。
- 手工恢复：每个 session 条目记录 `oldDir`、`newDir`、`generationName`、`oldHeaderBase64`（原始 header 行）。必要时把目录移回 `oldDir`，用该 base64 行替换日志首帧 header（zstd 需带 checksum 重新压缩），或按 `newDir` 保留并让 journal 继续完成。
- 兼容基线：Session format v4、workspace unit v2、Node >= 24.9。插件版本升级时保持与本机 DSH 版本一致。

## License

[MIT](LICENSE)
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

- **点击附件在右侧栏查看 / Click Attachment to Preview in Right Sidebar**
  - 用户消息中的文件附件卡片现在可点击，与查看源码文件一样在右侧栏打开预览。
  - 附件实体按 `<DSH_HOME>/attachments/v1/files/<sha256前2>/<sha256>/<文件名>` 内容寻址存储，宿主在页面注入 `__DSH_WORKSPACE_TOOLKIT__.attachmentsRoot`，点击时拼出 `dsh-resource://file/session/…` 地址交给 `ctx.sidebarRight.openResource`，复用 DSH 自带文件查看器（text/code/markdown/… 按扩展名自动匹配）。
  - 索引来自 `user/message` 会话事件中的 `FileAttachmentRef`；历史消息在首次点击时从会话事件窗口补索引。

- **长文本粘贴自动转文件附件 / Long Paste Converts to File Attachment**
  - 对齐 chat.deepseek.com 网页版行为：在输入框粘贴纯文本超过阈值（默认 2000 字符，宿主注入可配）时，自动转成 `<文本前24字符>.txt` 文件附件随消息发送，而不是塞进输入框。
  - 经官方草稿管线（`conversation.createDrafts` + `conversation.input.addAttachments`）走正常文件上传，转文件失败时原文回填输入框，不丢内容。
  - 阈值/开关由宿主注入 `__DSH_WORKSPACE_TOOLKIT__`（`pasteToFileLimit`），无注入时默认 2000 且功能自动禁用。
  - 手动拖入的文件与粘贴生成的文件都可点击卡片在右侧栏预览。

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
6. 在输入框**粘贴超长文本**（>2000 字符），自动转为 `.txt` 文件附件发送；附件卡片下方出现“粘贴原文至输入框”可一键还原。
7. 发送超长文本消息后，气泡自动折叠，点“展开”查看全文。

## File Structure

```text
index.js          # Host half entry point. No server-side state is required.
client.js         # Browser half. Observes workspace rows/menus, injects menu items, renders the batch-archive dialog.
cordis.patch.yml  # Cordis bundle patch used by DSH to load the browser plugin.
```

## How It Works

- **DOM observation**: 监听 `document.body` 下的 `[role="menu"]`，识别 workspace 菜单后注入自定义 `menuitem`。
- **Copy path**: 从 `ctx.workspaces.list` 快照获取对应工作区的 `path`，写入系统剪贴板；不支持 Clipboard API 的环境会回退到 `document.execCommand('copy')`。
- **Batch archive**: 打开弹窗时读取 `ctx.workspaces.list` 与 `ctx.sessions.list` 的快照，筛选出可归档会话，按顺序逐个归档。
- **Attachment preview**: 宿主在 `webserver/index-inject` 注入 `__DSH_WORKSPACE_TOOLKIT__`（附件根目录 + 粘贴阈值）；浏览器监听 `session/event` 的 `user/message` 索引 `FileAttachmentRef`，点击附件卡片时拼 `dsh-resource://file/session/<id>/<绝对路径>` 调 `sidebarRight.openResource` 打开右侧栏预览（复用 DSH 文件查看器）。
- **Paste-to-file**: 监听 `data-composer-input` 的 paste 事件，纯文本超阈值即 `preventDefault`，经 `conversation.createDrafts` 生成 `<首行50字符>.txt` 附件并 `conversation.input.addAttachments` 加入草稿；失败时原文回填输入框。
- **Paste restore**: paste 转文件时把原文、草稿 id、活引用（`shell`/`conversation`）存入记录；点恢复按钮时直接用这些引用把原文 `setDraft` 回输入框并 `removeAttachment` + `releaseDraftAttachment` 释放附件（不重新解析服务，避免 inactive context 报错）。
- **Bubble collapse**: 监听 `data-chat-flow-kind="user"` 行，行总文本超 2000 时定位气泡加 `max-height` 限高 + 渐隐；按钮切换 `dsh-long-text-clamp` class 展开/收起。多轮初始扫描（400ms/1.5s/3s）+ 统一防抖 MutationObserver 覆盖历史加载与渐进渲染，按行 key 去重防重复注入。
- **Performance**: 3 个全量 MutationObserver 合并为 1 个统一 observer，一次遍历按需分流（菜单注入 / composer 卡片 / 气泡折叠）；文本长度统计排除插件自身按钮文本，避免自增触发无限重评估。
- **Internationalization**: 文案根据浏览器 `navigator.language` 在中文与英文间自动切换；暂时无法跟随 DSH 内部语言热切换。

## Limitations

- 本插件不修改 DSH core，依赖 workspace 行与菜单的 DOM 结构；若 DSH 更新后 DOM 变化，插件可能需要同步更新。
- 批量归档弹窗基于 `ctx.workspaces.list` 和 `ctx.sessions.list` 渲染，不直接操作会话行 DOM，因此相对稳定。
- 菜单文案基于 `navigator.language` 简单判断，无法跟随 DSH 内部语言切换。
- 批量归档使用顺序调用以避免并发覆盖；单个失败会暂停并弹窗提示。

## License

[MIT](LICENSE)
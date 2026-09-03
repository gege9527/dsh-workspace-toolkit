# dsh-workspace-toolkit

[![npm version](https://img.shields.io/npm/v/dsh-workspace-toolkit.svg)](https://www.npmjs.com/package/dsh-workspace-toolkit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-orange.svg)](https://github.com/deepseek-ai/dsh)

> DSH workspace enhancement toolkit: add "Open in File Explorer" and "Batch Archive Sessions" actions to every workspace row in the DSH sidebar.
>
> DSH 工作区增强工具包：在资源管理器侧边栏的每个工作区行注入“在文件资源管理器中打开”和“批量归档会话”快捷操作。

## Features

- **在文件资源管理器中打开 / Open in File Explorer**
  - 出现在每个 workspace 行右侧的“⋮”菜单中。
  - 调用 DSH 原生 API `session.openWorkspacePath(path)`，由后端跨平台打开目录：
    - Windows → 文件资源管理器
    - macOS → Finder
    - Linux → 默认文件管理器（xdg-open）
  - 若路径尚未获取，会提示先将鼠标悬停到该工作区上以加载 hover card。

- **批量归档会话… / Batch Archive Sessions…**
  - 从工作区菜单打开会话列表面板。
  - 列出该工作区下所有非空白、未归档的会话（运行中的会话半透明显示，由用户自行决定是否归档）。
  - 支持全选 / 取消全选、显示更新时间、顺序调用 `uiWorkspace.archiveSession(sessionId)`，单个失败即暂停并提醒，避免并发覆盖 archive set。

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
2. 将鼠标悬停在任一工作区行上，等待 hover card 出现，插件会自动记录该工作区路径。
3. 点击工作区行右侧的 `⋮`（Workspace actions）菜单。
4. 选择：
   - **在文件资源管理器中打开 / Open in File Explorer** — 直接打开目录。
   - **批量归档会话… / Batch Archive Sessions…** — 勾选需要归档的会话，点击“归档所选”。

## File Structure

```text
index.js          # Host half entry point. No server-side state is required.
client.js         # Browser half. Observes workspace rows/menus, injects menu items, renders the batch-archive dialog.
cordis.patch.yml  # Cordis bundle patch used by DSH to load the browser plugin.
```

## How It Works

- **DOM observation**: 监听 `document.body` 下的 hover card 与 `[role="menu"]`，识别 workspace 菜单后注入两个自定义 `menuitem`。
- **Workspace path**: 从 DSH hover card 的 `aria-label` 或路径文本提取实际目录路径，并缓存到对应 workspace 行上。
- **Batch archive**: 打开弹窗时读取 `ctx.workspaces.list` 与 `ctx.sessions.list` 的快照，筛选出可归档会话，按顺序逐个归档。
- **Internationalization**: 文案根据浏览器 `navigator.language` 在中文与英文间自动切换；暂时无法跟随 DSH 内部语言热切换。

## Limitations

- 本插件不修改 DSH core，依赖 workspace 行与菜单的 DOM 结构；若 DSH 更新后 DOM 变化，插件可能需要同步更新。
- 批量归档弹窗基于 `ctx.workspaces.list` 和 `ctx.sessions.list` 渲染，不直接操作会话行 DOM，因此相对稳定。
- 菜单文案基于 `navigator.language` 简单判断，无法跟随 DSH 内部语言切换。
- 必须先悬停工作区使 hover card 出现，否则“在资源管理器中打开”可能无法获取路径。
- 批量归档使用顺序调用以避免并发覆盖；单个失败会暂停并弹窗提示。


## License

[MIT](LICENSE)
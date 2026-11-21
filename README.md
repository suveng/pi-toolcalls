# pi-toolcalls

Hide, compact, or reveal tool-call rows in the [pi](https://github.com/earendil-works/pi) coding agent TUI.

一个 **全局** 工具调用渲染器：对内置工具、扩展工具、MCP 工具一律生效。

## 为什么

pi 默认会显示每次工具调用（`bash`、`read`、`web_search`…）和它们的输出。对话长了以后，
这些行会淹没真正要看的结果。pi 1.6.0 **没有**提供隐藏工具调用的设置项
（`hideTools` 只控制 MCP 工具的暴露方式，与界面无关），所以这里用
`pi.registerToolRenderer()` 实现。

## 安装

```bash
pi install npm:pi-toolcalls
```

然后在 pi 里执行 `/reload`（或重启）。

## 三种模式

| 模式 | 效果 |
| --- | --- |
| `hidden`（默认） | 工具调用行完全不可见，连错误也不显示。用 `renderShell: "self"` + 空 `Container`，不会留下带背景的空行 |
| `compact` | 每次调用一行摘要（如 `▸ bash git status`）；失败时多一行红字错误；不显示工具输出 |
| `native` | pi 原生渲染（含输出，`Ctrl+O` 折叠/展开） |

## 用法

```text
/toolcalls            # 查看当前模式
/toolcalls hidden     # 隐藏（默认）
/toolcalls compact    # 一行摘要
/toolcalls native     # 恢复原生
/toolcalls toggle     # hidden -> compact -> native 循环
```

模式持久化在 `<agentDir>/tool-display.json`，默认 `<agentDir>` 是 `~/.pi/agent`。
当前模式会显示在状态栏。

临时覆盖（只对本次运行生效）：

```bash
PI_TOOL_DISPLAY=compact pi
```

## 注意

- `hidden` 模式下工具失败也看不见。如果想让错误可见，用 `compact`。
- 模式切换立即影响新渲染的行；已经画出来的旧行要等重绘（滚出屏幕再回来，或 `/reload`）。

## 开发

仓库里只有 `index.ts`，pi 用 jiti 直接加载 TypeScript，没有构建步骤。

```bash
pi -e ./index.ts        # 用本地副本试跑，不写进 settings
```

## 发布

推 `v*` tag 即可，GitHub Actions 用 OIDC trusted publishing 自动发布，
无需 `NPM_TOKEN`，并自动生成 provenance：

```bash
npm version patch
git push --follow-tags
```

## License

MIT

# codebuddy-herdr

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

让 [CodeBuddy Code](https://www.codebuddy.ai/) 在 [Herdr](https://herdr.dev/) 中显示实时的 `working`、`blocked`、`done`、`error` 状态，并在任务完成或需要你确认时收到提醒。

[English](README.md)

## 它解决什么问题

CodeBuddy Code 不会把自己的运行状态告诉 Herdr。这个插件把 CodeBuddy 的生命周期 Hook 接到 Herdr 真正读取的两条通道上：

| Herdr 产品 | 通道 | 使用条件 |
| --- | --- | --- |
| 桌面 App 与 `herdr-core`（`hc`） | 向 pane 的 pty 写 OSC 7501 | 始终可用，可跨 SSH |
| Herdr TUI（`herdr`） | `herdr pane report-agent` | `HERDR_ENV=1` 且二进制为 TUI 时 |

OSC 通道对远程开发尤其重要：转义序列随 pty 字节流一起传输，所以 CodeBuddy 可以跑在远程 Linux 上，Herdr App 跑在 Mac 上，Mac 端不需要安装任何东西。

## 特性

- 一轮进行中显示 `working`，等待授权或回答时显示 `blocked`，一轮结束显示 `done`，失败显示 `error`。
- 支持 Herdr App 跨 SSH 使用，也支持 `herdr machine add` 管理的远程机器。
- 在 Herdr TUI 中自动改用 socket API。
- 无守护进程、无运行时依赖、无网络请求。
- Hook 永远以 0 退出，上报失败不会阻塞 CodeBuddy。
- 状态消息不会带出 shell 命令和 URL。

## 环境要求

- 支持下列 Hook 事件的 CodeBuddy Code，已在 2.183.0 验证。
- Hook 使用的 `PATH` 中有 Node.js 18 或更高版本。CodeBuddy 本身运行在 Node 上，`scripts/notify.sh` 也会检查常见的安装位置。
- Herdr App 或 Herdr TUI。App 通道要求终端支持 OSC 7501。

## 安装

```bash
git clone https://github.com/szkane/codebuddy-herdr.git
cd codebuddy-herdr
codebuddy plugin add ./herdr-notify --scope user -y
```

新开一个 CodeBuddy 会话，或在当前会话执行 `/reload-plugins`。

开发时可以直接加载工作目录，不写入安装记录：

```bash
codebuddy --plugin-dir ./herdr-notify
```

确认已启用：

```bash
codebuddy plugin list | grep herdr
```

> 部分 CodeBuddy 版本对本地包执行 `codebuddy plugin enable` 会报 `Marketplace undefined is not found`。此时可在 `~/.codebuddy/settings.json` 的 `enabledPlugins` 中加入 `"herdr-notify@local-<id>": true`，id 取自 `codebuddy plugin list`。

## 使用

### Herdr App + SSH

1. 在 Mac 的 Herdr App 里打开一个 pane。
2. 在这个 pane 里 `ssh` 到运行 CodeBuddy 的机器。
3. 正常启动 `codebuddy`。

插件会把 OSC 7501 写到 `/dev/tty`，SSH 会把它原样送到 App。

不要在 Herdr pane 里的 `tmux` 中运行 CodeBuddy：Herdr 收不到经过 tmux 的 OSC 7501。

### Herdr 管理的远程机器

```bash
herdr machine add <host>
# 或
hc machine add <host>
```

在远程 pane 中运行 `codebuddy`。由 `herdr-core` 管理的 pane 走 OSC；TUI 中的 pane 走 CLI。

### 普通 SSH

普通终端会忽略这些转义序列。不会报错，只是没有状态显示。

## 状态映射

| CodeBuddy 事件 | Herdr 状态 | 说明 |
| --- | --- | --- |
| `SessionStart`（startup / resume） | `idle` | 迟到的 startup 不会打断进行中的一轮 |
| `UserPromptSubmit` | `working` | 消息为提示词首行 |
| `PreToolUse` | `working` | `AskUserQuestion` 映射为 `blocked/question`；`ExitPlanMode` 映射为 `blocked/permission` |
| `Notification`（`permission_prompt`） | `blocked/permission` | 可靠的"正在等人"信号 |
| `PostToolUse` / `PostToolUseFailure` | `working` | 仅当上一状态是 `blocked` |
| `PermissionDenied` | `working` | 自动拒绝后继续执行 |
| `Notification`（`idle_prompt`） | `idle` | 仅当上一状态是 `working`，不会覆盖 `done` |
| `Elicitation` | `blocked/question` | MCP 正在等待用户输入 |
| `ElicitationResult` | `working` | 已收到输入 |
| `SubagentStart` | `working` | 子代理运行中 |
| `Stop` | `done` | 一轮完成 |
| `StopFailure` | `error` | 一轮因 API 错误结束 |
| `SessionEnd` | `clear` | `/clear` 映射为 `idle` |

## 设计说明

- **使用根记录，不带 `id`。** Herdr 把 OSC 的根记录当作该 pane 的 agent；子 `id` 会创建一条单独记录，App 和 `hc get` 都不会显示它。
- **写 `/dev/tty`，不写 stdout。** Hook 的 stdout 会被 CodeBuddy 捕获，序列必须直接送到终端设备。
- **不使用 `PermissionRequest`。** 它对自动放行的工具也会触发，无法区分"正在等人"和"马上执行"。`Notification(permission_prompt)` 才是可靠信号。
- **`done` 会保留。** 按 OSC 7501 规范，`done` 和 `error` 会保留到被替换或清除。迟到的 `idle_prompt` 只会重置仍处于 `working` 的 pane，用来恢复被中断的一轮。
- **`seq` 单调递增。** Herdr 会丢弃序号没有严格变大的上报；插件在系统临时目录中为每个会话维护计数器。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HERDR_NOTIFY_DEBUG` | 未设置 | 把 JSON 调试日志追加到指定文件 |
| `HERDR_NOTIFY_NODE` | 自动探测 | `scripts/notify.sh` 使用的 Node 二进制 |
| `HERDR_NOTIFY_TTY` | `/dev/tty` | OSC 输出设备，用于测试和调试 |
| `HERDR_ENV` | Herdr 注入 | 位于 Herdr pane 内时为 `1` |
| `HERDR_BIN_PATH` | Herdr 注入 | 拥有该 pane 的 Herdr 二进制 |
| `HERDR_PANE_ID` | Herdr 注入 | `report-agent` 使用的 pane 地址 |

## 故障排查

**App 里没有状态**

- 确认 CodeBuddy 运行在 Herdr pane 中，而不是 `tmux` 中。
- 确认 Hook 有控制终端：`readlink -f /dev/tty` 能解析出设备。
- 打开调试日志：`HERDR_NOTIFY_DEBUG=/tmp/herdr-notify.log codebuddy`。
- 在 `herdr-core` 的 pane 中直接查状态：`hc get <pane> | jq .status`。

**状态一直停在 `working`**

- 用户中断不会触发 `Stop`；60 秒后 `Notification(idle_prompt)` 会把 pane 重置为 `idle`。
- 确认当前插件版本已加载：`/reload-plugins`。早期版本在工具获批后可能停在 `blocked`，因为缺少 `PostToolUse` 恢复。

**TUI 中没有状态**

- 检查 pane 内的 `HERDR_ENV=1`、`HERDR_BIN_PATH`、`HERDR_PANE_ID`。
- `herdr pane report-agent` 必须存在；App 的 `hc` 没有这个子命令。

**两个插件同时上报同一个 pane**

- 启用本插件前先禁用旧的 Herdr 适配器。两个使用同一 source 的上报者会互相覆盖。

## 已知限制

- 只有 Herdr 会消费 OSC 7501；iTerm2、Terminal.app 等会忽略，这是预期行为。
- `tmux` 会拦截该序列，请在 Herdr pane 中直接运行 CodeBuddy。
- TUI 没有 `error` 状态，`StopFailure` 会显示为 `idle` 加消息 `turn failed`。
- `done` / `error` 记录会保留到下一次上报或 `clear`，这是协议设计。
- Hook 永远以 0 退出，发送失败只写调试日志。

## 开发

```bash
git clone https://github.com/szkane/codebuddy-herdr.git
cd codebuddy-herdr

node --test                              # 生命周期、帧格式与传输测试
node herdr-notify/index.js --dry-run < payload.json
codebuddy plugin validate ./herdr-notify
```

目录结构：

```text
.
├── herdr-notify/          CodeBuddy 插件
│   ├── .codebuddy-plugin/plugin.json
│   ├── hooks/hooks.json
│   ├── index.js
│   ├── scripts/notify.sh
│   └── package.json
├── test/                  node:test 测试
├── README.md
├── README.zh-CN.md
└── LICENSE
```

插件没有构建步骤。`index.js` 是普通 CommonJS，由 Hook 运行器直接执行。

## 许可证

[MIT](LICENSE)

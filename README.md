# Squad · 圆桌

中文 | [English](README.en.md)

一张**人主持**的圆桌，跑在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上。

多个 agent 坐在席位上，由**你**点名谁发言、看什么、什么时候说。

```sh
dsh plugin --profile web add @jettsquad/roundtable
dsh web
```

装完侧栏底部出现「团队」。里面是空的——团队、agent、提示词、连接都由你自己建。

## 它和「多智能体框架」的区别

多数这类系统里，调度的是一个模型：由它决定叫谁、看什么、什么时候停。Squad 不是。

**斜杠命令由人敲、由代码跑，结果不进模型历史。** 这不是风格选择，是被代码守住的
不变量：上下文装配层把「只有轮次才会产生」的事件（`turn/start`、`assistant/*`、
`tool/*`）单独列一张表，一旦它们出现在主持人节点的日志里就**抛错**——因为那意味
着主持人自己发过言，而主持人是一个锚点，不是决策者。

同一张表里也包括 dsh 自己 Agent Teams 的 `team/*` 事件。上游的 lead 是模型，
我们的是人；真把两边挂在一起，抛错才是正确答案。

## 一次会议长什么样

1. **建队**：选一个项目文件夹，从 agent 库里挑人入座。一个文件夹 = 一个工作区 = 一支队。
2. **发言**：`@某人` 单独问，或者「问所有人」。每个席位是一个**新进程**，只看见你
   给它的那个窗口。
3. **议程**：秘书拟一份分阶段的计划，你确认之后才跑；跑歪了可以**退回任意一个阶段**
   重来。
4. **检查点**：讨论长了就折叠成要点，原文仍在，可以随时调回来。
5. **新开一场**：同一支队可以开很多场，名册共用，讨论各自独立。

## 席位后端

| 后端          | 跑的是                    | 派生子 agent 的围栏                       |
| ------------- | ------------------------- | ----------------------------------------- |
| `claude-code` | 你本机的 Claude Code 登录 | 默认禁掉 Task/Agent                       |
| `codex`       | `codex exec`              | 默认 `-c features.multi_agent=false`      |
| `dsh`         | `dsh --profile headless`  | 默认在 patch 里关掉 subagent 等六个插件   |

三种后端默认都不能派生子 agent；创建 agent 时勾「允许派生子 agent」才放开。

席位是新起的**子进程**，用你本机已有的登录态，Squad 不碰也不改它们。跑 dsh 席位时
它会往 stderr 发心跳，好让看门狗知道「在想」和「死了」的区别。

## 数据在哪

全部在 `$DSH_HOME` 下（默认 `~/.dsh`）：团队与名册、讨论记录、提示词片段库、连接
配置、判据库。卸载不会删它们。

**凭据只存名字**，值由 dsh 自己的 credentials 服务按次解析——这套代码从不持有密钥。

## 三层提示词

团队共享的提示词 → 片段集合（挂到某几个席位上）→ 席位自己的提示词。片段库是用户级
的，团队按需引用；团队里可以就地改，改过的会打标记，因为刷新是静默覆盖——不标出来，
人不会知道自己的修改没了。

## 开发

当前接口适配已在 DSH `0.2.1-rc.2` 验证。席位通过 `startActivation` 运行，结果只交给调用方；停止席位会取消并释放对应的执行。Windows 开发链接使用 junction，无需启用符号链接权限。

Agent 测试同时检查独立 HEAD 请求与席位真实调用；真实调用成功时，可达性按实际调用判定，并保留 HEAD 超时等诊断信息。

创建团队的表单、命令和服务端校验均支持 Windows 盘符路径、UNC 共享路径与 POSIX 绝对路径。

项目说明缺失时，程序只在团队目录创建最小模板，不再让模型自动搜集背景。空目录的目标与架构标为待主持人确认，父目录和同级项目不能作为自动建档的背景来源。

议程出口检查在 Windows 使用 PowerShell，在 macOS/Linux 使用 `/bin/sh`。PowerShell 检查必须用条件失败或异常表达断言；单独 `Test-Path` 只输出布尔值，不能充当退出码检查。

```sh
npm install          # 会自动 link-dsh：把本仓库链到本机 dsh 的同一份框架
npm run install-profile
npm run ui
```

`link-dsh` 存在的理由：**Node 按 realpath 缓存模块**。本仓库若解析到自己那份
cordis，而 profile 解析到 harness 那份，进程里就会有两套服务注册表和两组
`Symbol.for`，而所有症状都会指向别处。它把绑定的 harness 提交号写进
`.dsh-link.json`，换了会告警——dsh 在脚下被换掉，不该表现为「行为变了但没有 diff
能解释」。

```sh
npm run typecheck && npm run lint && npm test
npm run build:bundle     # 打成可发布的 @jettsquad/roundtable
```

发布态和开发态**共用同一份 patch**：`bundle/cordis.patch.yml` 是唯一来源，开发态
那份由它生成。两份手工维护的同一棵插件树迟早会漂，而漂出来的症状是「我跑着好好的，
他装上就坏」。

## 前提

- `dsh` ≥ 0.2.1-alpha.1，`pnpm` 在 PATH 上（`dsh plugin` 转发给它）
- Node `^22.19 || >=24`
- 用哪个席位后端就装哪个 CLI 并登录

## 许可

MIT。

# @squad/roundtable

一张**人主持**的圆桌，跑在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上。

多个 agent 坐在席位上，由**你**点名谁发言、看什么、什么时候说。斜杠命令由人敲、
由代码跑，结果不进模型历史——所以没有任何一层能悄悄把 LLM 放到主持人的位子上。

## 安装

```sh
dsh plugin --profile web add @squad/roundtable
dsh web
```

装完侧栏底部会出现「团队」。里面是空的——团队、agent、提示词片段、连接、判据
都由你自己建。

## 前提

- `dsh` ≥ 0.1.2-alpha.5，且 `pnpm` 在 PATH 上（`dsh plugin` 转发给它）
- Node `^22.19 || >=24`
- 席位后端各自的 CLI 与登录态，用哪个装哪个：
  `claude`（Claude Code）· `codex` · `dsh` 自己

席位是新起的**子进程**，用的是你本机已有的登录，Squad 不碰也不改它们。

## 数据放在哪

全部在 `$DSH_HOME` 下（默认 `~/.dsh`）：团队与名册、讨论记录、提示词片段库、
连接配置、判据库。卸载这个包不会删它们。

凭据只存名字，值由 dsh 自己的 credentials 服务按次解析——这个包从不持有密钥。

## 卸载

```sh
dsh plugin --profile web remove @squad/roundtable
```

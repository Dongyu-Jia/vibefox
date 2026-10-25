# 架构

```
                         家长（Telegram）
                               │  对话渠道（独立模块：src/channels/）
                               ▼
┌────────────────────────── 这台 Mac：agent 的房间 ──────────────────────────┐
│  vibefoxd（launchd 守护，24 小时）                                          │
│                                                                            │
│   Router = agent 本人（src/router/router.ts）                               │
│     · 唯一和家长对话的那个                                                   │
│     · 新任务 / 补充 / 回答 / 闲聊（引用回复 → 确定归属；否则模型判断；拿不准就问）│
│     · 任务账本（tasks.db，A2A 状态）                                         │
│     · 选 worker：家长点名 > 家长规则 > 学到的规则 > 默认（routing.md）         │
│     · worker 的问题先自己答（记忆），答不了才问家长                           │
│     · 检查结果，用自己的话汇报；失败自动升级；每周复盘派活规则                 │
│                     │ 派活（子进程）            ▲ vf ask / vf report         │
│                     ▼                           │                            │
│   Worker = harness × 模型（src/workers/）——都是通用的，只按价格/能力分档     │
│     builtin · DeepSeek Harness（dsh）· OpenCode · Claude Code · Codex/CLI      │
│                     │ 同一套工具、同一套权限                                 │
│                     ▼                                                        │
│   工具：vf 命令行 + vibefox MCP 服务（src/tools/catalog.ts，同一份清单）      │
│     浏览器（自己的 Chromium 资料）· 邮件 · 短信 · 电话 · 钱包 · 记忆 · 日记     │
│                     │                                                        │
│   控制 API（127.0.0.1 + token，src/daemon/api.ts）                           │
│   身体文件夹 ~/.vibefox/agents/<name>/（身份、性格、授权书、规则、记忆、日记、日志）│
└─────────────────────┼──────────────────────────────────────────────────────┘
                      ▼  所有对外调用都过 loggedFetch → logs/api/*.jsonl（脱敏）
   AgentMail（它的邮箱）· AgentPhone（它的号码）· Stripe Link（它的钱包）· OpenRouter / Anthropic / DeepSeek（它的大脑）
   硬上限都在这里：Link 审批与额度、OpenRouter key 额度、预付余额
```

## 模块

| 目录 | 职责 |
|---|---|
| `src/core/` | 路径与身体文件夹（`body.ts`）、SQLite 任务账本（`store.ts`，用 Node 自带的 `node:sqlite`）、钥匙串密钥（`secrets.ts`）、审计日志与脱敏（`log.ts`）、原则（`principles.ts`） |
| `src/channels/` | `Channel` 接口 + Telegram 实现（长轮询、按钮、编辑、引用回复、文件）。router 只依赖接口 |
| `src/router/` | router（agent 本人）和派活规则（选择、升级、探索、每周复盘、撤回） |
| `src/workers/` | worker 管理器、任务简报、harness：builtin（自己的工具循环）、Claude Code、OpenCode、Codex/通用 CLI |
| `src/tools/` | 唯一的工具清单：builtin 当 function tools 用，MCP 当 MCP tools 用，`vf` 当子命令用 |
| `src/browser/` | agent 自己的浏览器（Playwright 持久化资料，快照带 `[ref]`，可录屏） |
| `src/identity/` | 身份清单（谁来开）、自己开的身份（签名密钥、SSH、Nostr、头像、主页、A2A 名片）、AgentMail、AgentPhone |
| `src/wallet/` | 零花钱授权书（签名、校验、限额、禁止类别）、Stripe Link（官方 `link-cli`） |
| `src/llm/` | 统一的模型接口：OpenRouter / DeepSeek / 任意 OpenAI 兼容、Anthropic |
| `src/daemon/` | 常驻进程：控制 API、身份服务（收信、收短信、打电话、付款）、心跳 |
| `src/onboarding/` | 出生向导、OpenRouter OAuth PKCE、已有 harness 检测、launchd |
| `src/mcp/` | `vf mcp`：MCP stdio 服务 |

## 一次任务怎么走

1. 家长在 Telegram 发消息 → `TelegramChannel` 转成 `InboundMessage` → `Router.handleInbound`。
2. 不是家长？→ 礼貌说明"我只接受家长的任务"，记成信息，进简报。
3. 是家长：按钮 → 反馈/消歧/跟进；命令 → `/tasks` `/status` …；引用回复 → 对应任务的补充或问题的回答；其他 → `router.classify`。
4. 新任务 → `chooseWorker`（读 `routing.md`）→ 发一条状态消息 → `WorkerManager.dispatch`：
   - 在 `workspace/<task>/` 写 `TASK.md`、`AGENTS.md`、MCP 配置；
   - 起 harness 子进程，环境里有 `VF_API_URL / VF_API_TOKEN / VF_TASK_ID / VF_RUN_ID`，`vf` 在 PATH 上；
   - 会清空 shell 环境的 harness（dsh）靠工作目录里的 `.vf-run.json`（0600）找到 daemon；能挂 MCP 的 harness 直接拿到原生工具（Claude Code `--mcp-config`、OpenCode `opencode.json`、dsh 每次运行的 `--patch` 覆盖层，值只引用环境变量）。
5. worker 用 `vf browser …`、`vf mail …`、`vf call …`、`vf pay …` 干活；进度编辑那条状态消息。
6. `vf ask` → router 先查记忆自己答；答不了 → 问家长（家长引用回复即可）。
7. `vf report` → router 检查结果（不合格就升级），用自己的话发给家长，带 [👍 很好] [🔁 重做] [⬆️ 换更强的]。
   和模型的连接断了（`TRANSPORT`、`ECONNRESET` 之类）不是 worker 不行：同一个 worker 用原会话续跑一次，不算失败、不升级。dsh 的失败原因由 `fetch-trace.mjs` 记下（只记失败，不记内容），它还会在 TLS/HTTP-2 出错后给 fetch 换新连接池，让 dsh 自己的重试能重新连上。
8. 结果、花费、家长反馈记进 `outcomes`；每周复盘更新 `routing.md` 的"我学到的"，家长一键撤回。

## 外界的消息

- 邮件：AgentMail 轮询 + WebSocket。agent 自己发起的线程里的回复 → 关联任务，告诉家长，家长点"让我跟进"才继续；家长的邮件 → 可以一键变成任务；其他 → 陌生人，进简报；验证码 → `vf sms codes`。
- 短信：轮询号码的消息；验证码自动提取。
- 电话：外呼由 AgentPhone 托管的语音模型按任务目的去打（开场就说明自己是 AI），结束后取回通话记录；来电也会被记下。不需要公网 webhook。

## 钱

`vf pay` → 授权书检查（单笔、本月、禁止类别、冻结）→ `link-cli spend-request create --no-request-approval` → `request-approval` → 通知家长（Link app 也会推送）→ 等决定 → `retrieve --include card --output-file`（卡号直接写进 0600 文件，日志里只有尾号）→ 事后告诉家长。

## 24 小时

`vf install` 写 `~/Library/LaunchAgents/ai.vibefox.<name>.plist`（RunAtLoad + KeepAlive），崩溃自动拉起；重启后 Telegram offset、任务、问题都在数据库里，进行中的任务会接着做。

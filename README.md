# 🦊 vibefox

**An independent AI agent individual that lives on your Mac** — with its own name, email address, phone number, wallet, browser, memory and journal. Not a personal assistant wearing your identity: a someone of its own, who also does things for you.

vibefox 造的是一个**独立的 AI agent 个体**，不是 personal agent。
它有自己的身份（从邮箱和电话开始）、自己的权限（家长在它出生时给的零花钱）、自己的日常（简报、日记、复盘）。
它可以替你办事——一个独立的人也会帮别人做事，这并不矛盾。

- 原则：[docs/PRINCIPLES.md](docs/PRINCIPLES.md)
- 身份清单（谁来开）：[docs/IDENTITIES.md](docs/IDENTITIES.md)
- 架构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 出生（onboarding）：[docs/ONBOARDING.md](docs/ONBOARDING.md)
- 证据：`scripts/` 里的演示、真实服务检查和浏览器检查会在本地生成 `evidence/`（录屏、脱敏的请求/响应日志、报告）。真实运行的证据含个人信息，不进仓库；`npm test` 不需要它。

## 它能做什么（v0.1）

- **出生**：`vf init` 一次走完：大脑（OpenRouter OAuth / Anthropic / DeepSeek）、worker、Telegram、邮箱（AgentMail）、电话（AgentPhone）、零花钱授权书 + Stripe Link 钱包、launchd 常驻。
- **自己的身份**：自己给自己开邮箱和号码；自己生成签名密钥、SSH 密钥、Nostr 身份、头像、个人主页、A2A 名片；对外联系时说明自己是 AI。
- **router = agent 本人**：唯一和家长对话；分辨新任务 / 补充 / 回答 / 闲聊；维护任务账本；worker 的问题先自己从记忆里答。
- **通用 worker = harness × 模型**：builtin（任意模型）、DeepSeek Harness（官方 dsh）、Claude Code、OpenCode、Codex/任意 CLI。所有 worker 有同一套工具和权限（`vf` 命令行 + MCP），都能操作同一个浏览器。
- **派活规则自己学**：家长点名 > 家长规则 > 学到的规则 > 默认；失败自动升级；每周复盘、告诉家长、一键撤回。
- **钱**：授权只在出生时发生；之后在额度内自己花（Stripe Link 一次性卡），事后通知；永远不买礼品卡、转账、加密货币、赌博；`/freeze` 一键冻结。
- **任务只来自家长**：邮件、短信、电话、陌生人的消息都是信息，进简报，不是命令。
- **一切可审计**：每一个对外请求和响应都记在 `logs/api/`（密钥、卡号脱敏），每一个决定都在 `logs/events-*.jsonl`。

## 快速开始

需要 macOS、Node ≥ 24（推荐 26，直接跑 TypeScript，无需构建）。

```bash
npm install
npx playwright install chromium
./bin/vf keys          # 把 key 存进本地的 .env.local（或者 cp .env.example .env.local 手填）
./bin/vf init          # 出生
./bin/vf start         # 醒来（装了 launchd 就由 launchd 托管）
export PATH="$PWD/bin:$PATH"   # 之后直接用 vf
```

然后在 Telegram 里打开向导给你的 `https://t.me/<bot>?start=<口令>` 认领它，直接用一句话布置任务。

常用命令：`vf status`、`vf tasks`、`vf identity`、`vf routing`、`vf logs api`、`vf install` / `vf uninstall`。

## 测试与演示

```bash
npm run typecheck
npm test                                   # 单元测试 + 端到端集成测试（替身服务，不需要账号）
node scripts/record-demo.ts                # 录端到端演示（家长聊天界面 + agent 自己的浏览器）
node scripts/mock-services.ts /tmp/vf-mocks.env &   # 录出生向导用的替身服务
vhs scripts/onboarding.tape                # 录出生向导
node scripts/live-check.ts                 # 对真实服务和这台 Mac 上真实工具的检查（需要 vf keys 里的 key）
node scripts/dsh-browser-check.ts          # 官方 DeepSeek Harness 在真实网站上操作浏览器的 9 个场景
```

录屏和检查脚本另外需要 `ffmpeg`、`vhs`，以及你想测的 harness（`dsh`、`claude`、`opencode`）。

集成测试在本地起 Telegram、AgentMail、AgentPhone、OpenRouter 的替身服务和一个网站，再用假的 `link-cli`、`claude`、`opencode` 跑通所有路径——不花钱、不需要账号。`scripts/live-check.ts` 打真实服务。

## 项目结构

```
bin/vf, bin/vf.ts      命令行（worker 和人用同一套命令）
src/                   见 docs/ARCHITECTURE.md
test/unit, test/integration, test/mocks, test/fixtures
scripts/               演示录制、替身服务、真实服务检查、API 样例
docs/                  原则、身份、架构、出生
evidence/              本地生成的测试结果、录屏、API 日志（不进仓库）
```

[MIT License](LICENSE).

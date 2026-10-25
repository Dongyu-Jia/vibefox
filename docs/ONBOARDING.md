# Onboarding：agent 的出生

`vf init` 一步一步走，每一步都可以单独重跑：`vf init --step email`。
**授权只发生在这一刻**——之后 agent 不再逐笔请示。

| 等级 | 步骤 | agent 自己做什么 | 家长要做什么 |
|---|---|---|---|
| Lv0 | 出生 `birth` | 起身体文件夹；自己开签名密钥、SSH 密钥、Nostr 身份、浏览器资料、头像、个人主页、A2A 名片 | 起名字、选性格 |
| Lv1 | 大脑 `brain` | 测试每个模型能不能用（会识别 OpenRouter 的 guardrail 拦截）；选 router 用的模型 | 浏览器里登录 OpenRouter 点 Authorize（OAuth PKCE），或粘贴 OpenRouter / Anthropic / DeepSeek key；也可以同意导入 OpenCode 里已有的 key |
| Lv1 | worker `workers` | 检测这台 Mac 上的 Claude Code、OpenCode、Codex，列出 harness × 模型组合 | 勾选启用哪些 |
| Lv1 | 对话渠道 `channel` | 把 bot 的名字、简介、命令菜单改成自己的；生成认领口令 | 在 @BotFather 建 bot、粘贴 token；之后打开 `t.me/<bot>?start=<口令>` 认领 |
| Lv2 | 邮箱 `email` | **自己给自己开** `@agentmail.to` 邮箱 | 注册 AgentMail，粘贴 API key |
| Lv3 | 电话 `phone` | **自己开号码**、建语音 agent、把号码挂上 | 注册 AgentPhone（送 $5），粘贴 API key；美国号码发短信要在后台做 10DLC 登记 |
| Lv4 | 零花钱 `money` | 用自己的签名密钥确认授权书；连钱包后做一笔测试申请 | 设每月上限、单笔上限、能买什么；签字"我同意"；用自己的 Link 账号批准连接（`link-cli auth login`） |
| Lv4 | 联系方式 `parent` | 认得出家长的邮件和短信 | 可选：留邮箱和手机号 |
| Lv5 | 常驻 `install` | 装成 launchd 服务，崩溃自动重启 | 建议打开"断电后自动启动"、关掉自动睡眠 |

不用交互的安装（或者测试）：`vf init --answers answers.json`，键名见 `test/helpers/world.ts`。

环境变量可以把一个新 agent 指向 staging 或本地的替身服务：
`VF_TELEGRAM_API`、`VF_AGENTMAIL_API`、`VF_AGENTPHONE_API`、`VF_OPENROUTER_API`、`VF_ANTHROPIC_API`、`VF_DEEPSEEK_API`、`VF_LINK_CLI`、`VF_BROWSER_OPEN`。
`node scripts/mock-services.ts` 会起一整套本地替身并打印这些变量。

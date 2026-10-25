# 身份清单

一个独立的 agent 个体，身份从**邮箱**和**电话**开始，然后不断长出来。
每一项都标明**谁来开**：

- **自己开**：agent 不需要任何人帮忙。
- **家长给钥匙，自己开**：家长注册一次服务、交给它一个 API key；之后 agent 自己创建、自己管理（比如它自己给自己开邮箱、开号码）。
- **家长帮开**：需要人类验证（验证码、实名、手机在手边）或者需要家长自己的账号。agent 不绕过验证码、不批量注册。
- **不可能**：agent 不是法律主体，持有不了。

这张表由代码生成（`src/identity/registry.ts`，`vf identity --markdown`），和实现保持同步。
运行中的 agent 用 `vf identity` 或在 Telegram 里发 `/identity` 查看自己每一项的状态。

| 身份 | 类别 | 谁来开 | 提供方 | 给它什么 | 怎么开 / 为什么要人 | 本版本 |
|---|---|---|---|---|---|---|
| Telegram bot `telegram_bot` | 沟通 | 家长帮开 | Telegram | 和家长对话的渠道（v1 唯一渠道） | 只有真人的 Telegram 账号能在 @BotFather 创建 bot；家长创建后把 token 交给 agent | ✅ |
| 邮箱 `email` | 沟通 | 家长给钥匙，自己开 | AgentMail | 以自己的名义收发邮件、注册网站、接收验证邮件 | 家长注册 AgentMail 并给 API key；agent 自己创建 @agentmail.to 收件箱 | ✅ |
| 电话号码 `phone` | 沟通 | 家长给钥匙，自己开 | AgentPhone | 收发短信、打电话、接电话、收验证码 | 家长注册 AgentPhone 并充值；agent 自己开号码、建语音 agent、挂上号码 | ✅ |
| 短信验证码收件箱 `sms_codes` | 沟通 | 自己开 | — | 自动提取发到自己号码上的验证码 | 有了号码后自动可用（先要：phone） | ✅ |
| 声音 `voice` | 沟通 | 自己开 | — | 电话里的声音和说话方式 | 在 AgentPhone 语音 agent 上设置，跟随 SOUL.md（先要：phone） | ✅ |
| iMessage `imessage` | 沟通 | 家长帮开 | — | 在 Mac 上用自己的 Apple ID 收发 iMessage | 需要 Apple ID（人类验证）；登录 Mac 的信息 app（先要：apple_id） | 以后 |
| Signal `signal` | 沟通 | 家长帮开 | — | 端到端加密的聊天身份 | 用 signal-cli 以自己的号码注册；注册时的验证码需要人来过（先要：phone） | 以后 |
| WhatsApp `whatsapp` | 沟通 | 家长帮开 | — | WhatsApp 联系人身份 | 必须在手机 app 上注册；Meta 禁止通用 AI 助手使用官方商业接口，个人号自动化违反条款，暂不支持（先要：phone） | 以后 |
| Discord bot `discord_bot` | 沟通 | 家长帮开 | — | 在 Discord 里出现 | 需要真人账号在开发者后台创建应用 | 以后 |
| OpenRouter `brain_openrouter` | 大脑 | 家长帮开 | OpenRouter | 几百个模型，一个 key；key 的额度就是"脑子预算" | 家长用 OAuth 登录授权（或粘贴 key）并充值 | ✅ |
| Anthropic API `brain_anthropic` | 大脑 | 家长帮开 | Anthropic | 直接用 Claude 模型 | 家长在 console.anthropic.com 创建 key | ✅ |
| DeepSeek API `brain_deepseek` | 大脑 | 家长帮开 | DeepSeek | 便宜的 DeepSeek 模型 | 家长在 platform.deepseek.com 创建 key | ✅ |
| Claude Code `harness_claude_code` | 大脑 | 家长帮开 | Anthropic | 最强档 worker：会写代码、用浏览器 | 家长登录一次 `claude auth login` | ✅ |
| OpenCode `harness_opencode` | 大脑 | 家长帮开 | OpenCode | 任意模型的 worker harness（比如 DeepSeek） | 家长装好并配置一个模型供应商 | ✅ |
| 钱包 `wallet` | 钱 | 家长帮开 | Stripe Link | 一次性虚拟卡，在授权额度内买东西 | 家长用自己的 Link 账号批准连接（link-cli auth login），每笔在 Link app 里批准；仅美国、加拿大 | ✅ |
| 零花钱授权书 `mandate` | 钱 | 家长帮开 | — | 每月额度、单笔上限、能买什么 | 出生时家长签一次，agent 用自己的签名密钥确认（先要：signing_key） | ✅ |
| 签名密钥 (Ed25519) `signing_key` | 密码学 | 自己开 | — | 自己的"指纹"：签授权书、签日记、证明"这是我说的" | agent 自己生成 | ✅ |
| SSH 密钥 `ssh_key` | 密码学 | 自己开 | — | 登录服务器、推代码 | agent 自己用 ssh-keygen 生成 | ✅ |
| Nostr 身份 `nostr` | 密码学 | 自己开 | — | 去中心化社交网络上的公开身份（npub） | agent 自己生成 secp256k1 密钥 | ✅ |
| PGP 密钥 `pgp_key` | 密码学 | 自己开 | — | 加密邮件、签名文件 | agent 自己用 gpg 生成 | 以后 |
| 自托管加密钱包地址 `crypto_address` | 密码学 | 自己开 | — | 一个收款地址（没有余额） | agent 自己生成；里面没钱，花钱仍走授权书 | 以后 |
| 浏览器资料 `browser_profile` | 网络形象 | 自己开 | — | 自己的浏览器：cookie、登录状态、历史 | agent 自己的 Playwright 持久化资料目录 | ✅ |
| 头像 `avatar` | 网络形象 | 自己开 | — | 一张属于自己的头像 | agent 根据名字生成 | ✅ |
| 个人主页 `homepage` | 网络形象 | 自己开 | — | 一页"关于我"：我是谁、怎么联系我、谁是我的家长 | agent 自己生成；发布到公网需要域名或托管账号 | ✅ |
| Agent 名片 (A2A) `agent_card` | 网络形象 | 自己开 | — | 给其他 agent 看的机器可读名片 | agent 自己生成 agent-card.json | ✅ |
| 只需邮箱验证的网站账号 `web_accounts` | 账号 | 自己开 | — | newsletter、论坛、免费服务 | agent 用自己的邮箱和浏览器注册；遇到验证码就请家长帮忙（先要：email、browser_profile） | ✅ |
| 域名 `domain` | 网络形象 | 家长帮开 | — | 自己的地址，比如 fox.example.com | 购买需要付款和实名；买好后 agent 自己管理 DNS | 以后 |
| Apple ID `apple_id` | 账号 | 家长帮开 | — | iMessage、FaceTime | 需要短信验证和验证码（先要：email、phone） | 以后 |
| Google 账号 `google_account` | 账号 | 家长帮开 | — | Gmail、日历、Drive | 需要验证码和手机验证；或由 Workspace 管理员直接创建（先要：phone） | 以后 |
| GitHub 账号 `github` | 账号 | 家长帮开 | — | 开源协作、托管代码和主页 | 注册有验证码；之后 agent 用自己的 SSH 密钥工作（先要：email、ssh_key） | 以后 |
| X 账号 `x_account` | 账号 | 家长帮开 | — | 公开发言 | 需要人类验证；自动化账号需标注为 bot（先要：email、phone） | 以后 |
| Link 身份证明 `link_identity` | 账号 | 家长帮开 | — | 向服务证明"我是一个有真人家长的 agent" | link-cli identity（beta）（先要：wallet） | 以后 |
| 法律身份 / 银行账户 `legal_identity` | 法律 | 不可能 | — | — | agent 不是法律主体，不能开户、签合同；花钱用的是家长授权的支付方式 | 以后 |

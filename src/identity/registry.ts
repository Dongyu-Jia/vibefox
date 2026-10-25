/**
 * Every identity an agent individual can have, and who has to open it.
 *
 *  - self        the agent opens it alone
 *  - parent-key  the parent signs up for a service once and hands over a key;
 *                from then on the agent creates and manages it itself
 *  - parent      needs a human: CAPTCHA, KYC, a phone in hand, or the parent's own account
 *  - impossible  an agent cannot hold it (legal personhood); it borrows the parent's
 */
export type Opener = 'self' | 'parent-key' | 'parent' | 'impossible';

export interface IdentityKind {
  id: string;
  name: string;
  category: '沟通' | '大脑' | '钱' | '密码学' | '网络形象' | '账号' | '法律';
  opener: Opener;
  provider?: string;
  /** What it gives the agent. */
  gives: string;
  /** Why a human is needed, or how the agent opens it itself. */
  how: string;
  /** Implemented in this version of vibefox. */
  implemented: boolean;
  /** Identities that must exist first. */
  needs?: string[];
}

export const IDENTITY_KINDS: IdentityKind[] = [
  // ---- 沟通 ----
  { id: 'telegram_bot', name: 'Telegram bot', category: '沟通', opener: 'parent', provider: 'Telegram', gives: '和家长对话的渠道（v1 唯一渠道）', how: '只有真人的 Telegram 账号能在 @BotFather 创建 bot；家长创建后把 token 交给 agent', implemented: true },
  { id: 'email', name: '邮箱', category: '沟通', opener: 'parent-key', provider: 'AgentMail', gives: '以自己的名义收发邮件、注册网站、接收验证邮件', how: '家长注册 AgentMail 并给 API key；agent 自己创建 @agentmail.to 收件箱', implemented: true },
  { id: 'phone', name: '电话号码', category: '沟通', opener: 'parent-key', provider: 'AgentPhone', gives: '收发短信、打电话、接电话、收验证码', how: '家长注册 AgentPhone 并充值；agent 自己开号码、建语音 agent、挂上号码', implemented: true },
  { id: 'sms_codes', name: '短信验证码收件箱', category: '沟通', opener: 'self', needs: ['phone'], gives: '自动提取发到自己号码上的验证码', how: '有了号码后自动可用', implemented: true },
  { id: 'voice', name: '声音', category: '沟通', opener: 'self', needs: ['phone'], gives: '电话里的声音和说话方式', how: '在 AgentPhone 语音 agent 上设置，跟随 SOUL.md', implemented: true },
  { id: 'imessage', name: 'iMessage', category: '沟通', opener: 'parent', needs: ['apple_id'], gives: '在 Mac 上用自己的 Apple ID 收发 iMessage', how: '需要 Apple ID（人类验证）；登录 Mac 的信息 app', implemented: false },
  { id: 'signal', name: 'Signal', category: '沟通', opener: 'parent', needs: ['phone'], gives: '端到端加密的聊天身份', how: '用 signal-cli 以自己的号码注册；注册时的验证码需要人来过', implemented: false },
  { id: 'whatsapp', name: 'WhatsApp', category: '沟通', opener: 'parent', needs: ['phone'], gives: 'WhatsApp 联系人身份', how: '必须在手机 app 上注册；Meta 禁止通用 AI 助手使用官方商业接口，个人号自动化违反条款，暂不支持', implemented: false },
  { id: 'discord_bot', name: 'Discord bot', category: '沟通', opener: 'parent', gives: '在 Discord 里出现', how: '需要真人账号在开发者后台创建应用', implemented: false },

  // ---- 大脑 ----
  { id: 'brain_openrouter', name: 'OpenRouter', category: '大脑', opener: 'parent', provider: 'OpenRouter', gives: '几百个模型，一个 key；key 的额度就是"脑子预算"', how: '家长用 OAuth 登录授权（或粘贴 key）并充值', implemented: true },
  { id: 'brain_anthropic', name: 'Anthropic API', category: '大脑', opener: 'parent', provider: 'Anthropic', gives: '直接用 Claude 模型', how: '家长在 console.anthropic.com 创建 key', implemented: true },
  { id: 'brain_deepseek', name: 'DeepSeek API', category: '大脑', opener: 'parent', provider: 'DeepSeek', gives: '便宜的 DeepSeek 模型', how: '家长在 platform.deepseek.com 创建 key', implemented: true },
  { id: 'harness_claude_code', name: 'Claude Code', category: '大脑', opener: 'parent', provider: 'Anthropic', gives: '最强档 worker：会写代码、用浏览器', how: '家长登录一次 `claude auth login`', implemented: true },
  { id: 'harness_deepseek', name: 'DeepSeek Harness（官方 dsh）', category: '大脑', opener: 'parent', provider: 'DeepSeek', gives: 'DeepSeek 官方的 agent harness，走 OpenRouter 或 DeepSeek API', how: '家长装好 dsh（npm i -g @deepseek-ai/dsh）；配置和 key 由 agent 放在自己的身体文件夹里', implemented: true },
  { id: 'harness_codewhale', name: 'Codewhale（第三方 DeepSeek harness）', category: '大脑', opener: 'parent', provider: 'Codewhale', gives: 'DeepSeek 专用的 worker harness，走 OpenRouter 或 DeepSeek API', how: '家长装好 codewhale（npm i -g codewhale）；key 用 agent 自己的', implemented: true },
  { id: 'harness_opencode', name: 'OpenCode', category: '大脑', opener: 'parent', provider: 'OpenCode', gives: '任意模型的 worker harness（比如 DeepSeek）', how: '家长装好并配置一个模型供应商', implemented: true },

  // ---- 钱 ----
  { id: 'wallet', name: '钱包', category: '钱', opener: 'parent', provider: 'Stripe Link', gives: '一次性虚拟卡，在授权额度内买东西', how: '家长用自己的 Link 账号批准连接（link-cli auth login），每笔在 Link app 里批准；仅美国、加拿大', implemented: true },
  { id: 'mandate', name: '零花钱授权书', category: '钱', opener: 'parent', gives: '每月额度、单笔上限、能买什么', how: '出生时家长签一次，agent 用自己的签名密钥确认', implemented: true, needs: ['signing_key'] },

  // ---- 密码学 ----
  { id: 'signing_key', name: '签名密钥 (Ed25519)', category: '密码学', opener: 'self', gives: '自己的"指纹"：签授权书、签日记、证明"这是我说的"', how: 'agent 自己生成', implemented: true },
  { id: 'ssh_key', name: 'SSH 密钥', category: '密码学', opener: 'self', gives: '登录服务器、推代码', how: 'agent 自己用 ssh-keygen 生成', implemented: true },
  { id: 'nostr', name: 'Nostr 身份', category: '密码学', opener: 'self', gives: '去中心化社交网络上的公开身份（npub）', how: 'agent 自己生成 secp256k1 密钥', implemented: true },
  { id: 'pgp_key', name: 'PGP 密钥', category: '密码学', opener: 'self', gives: '加密邮件、签名文件', how: 'agent 自己用 gpg 生成', implemented: false },
  { id: 'crypto_address', name: '自托管加密钱包地址', category: '密码学', opener: 'self', gives: '一个收款地址（没有余额）', how: 'agent 自己生成；里面没钱，花钱仍走授权书', implemented: false },

  // ---- 网络形象 ----
  { id: 'browser_profile', name: '浏览器资料', category: '网络形象', opener: 'self', gives: '自己的浏览器：cookie、登录状态、历史', how: 'agent 自己的 Playwright 持久化资料目录', implemented: true },
  { id: 'avatar', name: '头像', category: '网络形象', opener: 'self', gives: '一张属于自己的头像', how: 'agent 根据名字生成', implemented: true },
  { id: 'homepage', name: '个人主页', category: '网络形象', opener: 'self', gives: '一页"关于我"：我是谁、怎么联系我、谁是我的家长', how: 'agent 自己生成；发布到公网需要域名或托管账号', implemented: true },
  { id: 'agent_card', name: 'Agent 名片 (A2A)', category: '网络形象', opener: 'self', gives: '给其他 agent 看的机器可读名片', how: 'agent 自己生成 agent-card.json', implemented: true },
  { id: 'web_accounts', name: '只需邮箱验证的网站账号', category: '账号', opener: 'self', needs: ['email', 'browser_profile'], gives: 'newsletter、论坛、免费服务', how: 'agent 用自己的邮箱和浏览器注册；遇到验证码就请家长帮忙', implemented: true },
  { id: 'domain', name: '域名', category: '网络形象', opener: 'parent', gives: '自己的地址，比如 fox.example.com', how: '购买需要付款和实名；买好后 agent 自己管理 DNS', implemented: false },

  // ---- 账号 ----
  { id: 'apple_id', name: 'Apple ID', category: '账号', opener: 'parent', needs: ['email', 'phone'], gives: 'iMessage、FaceTime', how: '需要短信验证和验证码', implemented: false },
  { id: 'google_account', name: 'Google 账号', category: '账号', opener: 'parent', needs: ['phone'], gives: 'Gmail、日历、Drive', how: '需要验证码和手机验证；或由 Workspace 管理员直接创建', implemented: false },
  { id: 'github', name: 'GitHub 账号', category: '账号', opener: 'parent', needs: ['email', 'ssh_key'], gives: '开源协作、托管代码和主页', how: '注册有验证码；之后 agent 用自己的 SSH 密钥工作', implemented: false },
  { id: 'x_account', name: 'X 账号', category: '账号', opener: 'parent', needs: ['email', 'phone'], gives: '公开发言', how: '需要人类验证；自动化账号需标注为 bot', implemented: false },
  { id: 'link_identity', name: 'Link 身份证明', category: '账号', opener: 'parent', needs: ['wallet'], gives: '向服务证明"我是一个有真人家长的 agent"', how: 'link-cli identity（beta）', implemented: false },

  // ---- 法律 ----
  { id: 'legal_identity', name: '法律身份 / 银行账户', category: '法律', opener: 'impossible', gives: '—', how: 'agent 不是法律主体，不能开户、签合同；花钱用的是家长授权的支付方式', implemented: false },
];

export function identityKind(id: string): IdentityKind | undefined {
  return IDENTITY_KINDS.find((k) => k.id === id);
}

export const OPENER_LABEL: Record<Opener, string> = {
  self: '自己开',
  'parent-key': '家长给钥匙，自己开',
  parent: '家长帮开',
  impossible: '不可能',
};

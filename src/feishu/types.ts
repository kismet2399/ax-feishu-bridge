export type Domain = "feishu" | "lark";
export type GroupPolicy = "open" | "mention";
export type CardActionMode = "webhook" | "ws";

export type FeishuConfig = {
  appId: string;
  appSecret: string;
  domain: Domain;
  groupPolicy: GroupPolicy;
  /**
   * 群聊关键词触发（与 mention 叠加）：正文命中任一关键词即可，无需 @。
   * 匹配：去空白后大小写不敏感子串。
   */
  groupKeywords?: string[];
  /**
   * 群聊跟帖触发（与 mention 叠加）：回复本 bot 消息时触发，无需再 @。
   * 默认 false。
   */
  groupAlsoOnReply?: boolean;
  /** 是否忽略 sender_type=bot 的消息；默认 true */
  ignoreBotMessages?: boolean;
  cardActionMode?: CardActionMode;
  cardActionWebhookHost?: string;
  cardActionWebhookPort?: number;
  cardActionWebhookPath?: string;
  language?: "zh" | "en";
  reactEmoji?: string;
  autoStart?: boolean;
  /** 飞书对话的默认工作区目录（未通过 /workspace 指定时的全局回退目录） */
  defaultWorkspace?: string;
  /** Long-task notice threshold in seconds (0 disables). */
  promptNotifySec?: number;
  /** Hard prompt timeout in seconds (0 waits indefinitely). */
  promptTimeoutSec?: number;
  /** 解析入站 interactive 卡片（默认 true） */
  parseInteractiveCards?: boolean;
  /** 用户回复/引用消息时展开 parent/root 正文（默认 true） */
  includeQuotedMessage?: boolean;
  /** 引用消息并入 prompt 的最大字符数 */
  quotedMessageMaxChars?: number;
  /** [patch:merge-forward-expand] 合并转发展开子消息（默认 true；关闭则完全不展开、不注入任何内容） */
  includeMergeForwardMessage?: boolean;
  /** 出站 API 最大重试次数（不含首次） */
  sendMaxRetries?: number;
  /**
   * 是否启用流式回复（默认 true）。
   * 使用飞书 CardKit streaming_mode，客户端按 print_step 逐字打印。
   */
  streamingReply?: boolean;
  /** CardKit 客户端打印间隔 ms（默认 50） */
  streamPrintFrequencyMs?: number;
  /** CardKit 每次打印字符数（默认 1） */
  streamPrintStep?: number;
  /** 服务端推送 fullText 到 CardKit 的间隔 ms（默认 120） */
  streamPushIntervalMs?: number;
  /** @deprecated 兼容旧配置 */
  streamFlushMs?: number;
  streamMinChars?: number;
  streamFirstFlushMs?: number;
  streamMaxBodyChars?: number;
};

export type ModelSelection = {
  provider: string;
  id: string;
  /** 思考强度档位（可选，Harness 适配器持久化用；Pi 存在会话内部）。 */
  thinkingLevel?: string;
};

export type FeishuState = {
  sessions: Record<string, string>;
  models?: Record<string, ModelSelection>;
  workspaces?: Record<string, string>;
};

export type FeishuRoute = {
  sessionKey: string;
  sessionId?: string;
  chatId: string;
  chatType: "p2p" | "group";
  threadMessageId?: string;
  lastMessageId: string;
  updatedAt: number;
};

export type FeishuJobRoute = FeishuRoute & {
  jobId: string;
  jobName?: string;
  createdAt: number;
};

export type FeishuBridgeState = {
  version: 1;
  routes: Record<string, FeishuRoute>;
  jobs: Record<string, FeishuJobRoute>;
  sent: Record<string, number>;
  /** [patch:quoted-card-recall] 出站卡片消息 id → 该轮最终答案文本。
   * 飞书对 CardKit 卡片（card_id 引用）只回占位内容，被引用时正文只能从我们自己这里补回来。 */
  cards?: Record<string, { text: string; at: number }>;
};

export type FeishuMessage = {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  chatMode?: "p2p" | "group" | "topic";
  senderOpenId: string;
  msgType: string;
  content: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  mentions?: unknown[];
};

export type FeishuAttachment = {
  kind: "image" | "file";
  fileKey: string;
  fileName?: string;
  // [patch:merge-forward-expand] 附件归属的消息 id：合并转发子消息里的资源是挂在容器（本体）消息上的，
  // 必须用容器消息 id 下载（实测：子消息 id → 400 File not in msg.；容器 id → 200）。
  messageId?: string;
};

export type FeishuCardAction = {
  messageId: string;
  chatId?: string;
  operatorOpenId: string;
  token?: string;
  value: unknown;
};

export type FeishuCopyMarkdownAction = {
  copySourceId: string;
};

export type FeishuStatus =
  | "not configured"
  | "connecting"
  | "connected"
  | "owned"
  | "bot unavailable"
  | "disconnected";

export type ParsedMessageInput = {
  text: string;
  attachments: FeishuAttachment[];
  /** 解析来源标记，便于调试 */
  source?: string;
};

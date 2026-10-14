import { detectCodeLanguage, decodeTextFile, detectImageMime, type FeishuImageInput, isSupportedImageMime, isSupportedTextFile } from "./attachments.ts";
import { buildModelCard, buildResumeCard, buildThinkingCard } from "./cards.ts";
import type { ConversationRuntime } from "./runtime.ts";
import { claimFeishuMessage, markFeishuMessage } from "./dedupe-store.ts";
import { debugLog } from "./debug.ts";
import { loadConfig } from "./config.ts";
import {
  clearRuntimeOverrides,
  formatRuntimeConfig,
  getRuntimeOverrides,
  setRuntimeConfig,
} from "./runtime-config.ts";
import { conversationKey, conversationLabel, buildPromptWithQuote, getCommandList, normalizeForDedupe, parseBotCommand, parseMessageInput, pruneRecentMap } from "./messages.ts";
import { ReplyCard } from "./reply-card.ts";
import type { FeishuBridgeStore } from "./bridge-store.ts";
import type { FeishuTransport } from "./transport.ts";
// [patch:quoted-post] 引用附件独立通道需要 FeishuAttachment 类型
import type { FeishuAttachment, FeishuMessage } from "./types.ts";

const CONTENT_DEDUPE_TTL_MS = 5_000;

export class FeishuMessageHandler {
  private readonly seen = new Set<string>();
  private readonly recentContent = new Map<string, number>();
  private readonly conversations: ConversationRuntime;
  private readonly getTransport: () => FeishuTransport | undefined;
  private readonly bridgeStore?: FeishuBridgeStore;

  constructor(
    conversations: ConversationRuntime,
    getTransport: () => FeishuTransport | undefined,
    bridgeStore?: FeishuBridgeStore,
  ) {
    this.conversations = conversations;
    this.getTransport = getTransport;
    this.bridgeStore = bridgeStore;
  }

  reset() {
    this.seen.clear();
    this.recentContent.clear();
  }

  async handle(msg: FeishuMessage) {
    const transport = this.getTransport();
    if (!transport) return;

    try {
      if (this.seen.has(msg.messageId)) return;
      if (!(await claimFeishuMessage(msg.messageId))) return;
      this.seen.add(msg.messageId);
      if (this.seen.size > 2000) this.seen.clear();

      const cfg = loadConfig();
      const parsed = parseMessageInput(msg, transport.getBotOpenId(), {
        parseInteractiveCards: cfg?.parseInteractiveCards !== false,
      });
      let text = parsed.text || "";
      const key = conversationKey(msg);
      this.bridgeStore?.bindConversation(key, msg);

      // [patch:merge-forward-expand] 合并转发：本体 content 固定是 "Merged and Forwarded Message"，子消息在
      // GET /im/v1/messages/:id 的 items[1:]（items[0] 是哨兵）。子消息里的资源不在子消息上，
      // 而在容器（本体）消息上 → 附件统一按容器 id 下载。不展开的话模型只看到一句占位。
      let mergedForwardAttachments: FeishuAttachment[] = [];
      if (msg.msgType === "merge_forward") {
        const expanded = await transport.expandMergeForward(
          msg.messageId,
          transport.getBotOpenId(),
          cfg?.quotedMessageMaxChars ?? 8000,
          (id) => this.bridgeStore?.getCardAnswer(id),
        );
        if (expanded.text) text = expanded.text;
        mergedForwardAttachments = expanded.attachments;
      }

      // 展开引用/回复的父消息（告警卡片场景）
      let quoted: { msgType: string; text: string } | null = null;
      // [patch:quoted-post] 引用附件单独持有，绝不塞进 parsed.attachments —— 那里有两处消费者
      // 都假设它是"本条消息自己的附件"：① handleCommand 闸门 if(!parsed.attachments.length)
      // 会让斜杠命令静默失效；② 用 msg.messageId 下载会被飞书拒为 400 "File not in msg."。
      let quotedRef: { messageId: string; attachments: FeishuAttachment[] } | null = null;
      if (cfg?.includeQuotedMessage !== false && (msg.parentId || msg.rootId)) {
        // [patch:merge-forward-expand] 传入卡片正文回填钩子：被引用的合并转发里可能夹着机器人卡片
        const q = await transport.getQuotedContext(
          msg,
          transport.getBotOpenId(),
          cfg?.quotedMessageMaxChars ?? 8000,
          (id) => this.bridgeStore?.getCardAnswer(id),
        );
        // [patch:quoted-post] 无文字的引用（如纯图片消息）原先被整体丢弃，改为文本或附件任一
        // 存在即算有效引用；引用附件走 quotedRef，由 P5 用父消息 id 下载。
        // [patch:quoted-card-recall] 被引用的若是我们自己的卡片，优先用出站记录里的正文：飞书对
        // CardKit 卡片只回占位内容（"请升级至最新版本客户端"），照单全收会让模型完全
        // 不知道用户在回应哪一条回答，只能顺着最近话题瞎猜。
        const recalled = q?.parentMessageId ? this.bridgeStore?.getCardAnswer(q.parentMessageId) : undefined;
        if (recalled?.trim()) {
          quoted = { msgType: q?.msgType ?? "interactive", text: recalled };
          debugLog("feishu.handler.quoted_card_recalled", {
            messageId: msg.messageId,
            parentMessageId: q?.parentMessageId,
            length: recalled.length,
          });
        } else if (q?.text || q?.attachments?.length) {
          quoted = { msgType: q.msgType, text: q.text };
          if (q.attachments?.length) {
            quotedRef = { messageId: q.parentMessageId, attachments: q.attachments };
          }
        }
      }

      debugLog("feishu.handler.parsed", {
        messageId: msg.messageId,
        key,
        chatMode: msg.chatMode,
        threadId: msg.threadId || msg.rootId || msg.parentId,
        textLength: text.length,
        source: parsed.source,
        quoted: Boolean(quoted),
        attachments: parsed.attachments.map((item) => ({
          kind: item.kind,
          fileKey: item.fileKey,
          fileName: item.fileName,
        })),
      });

      if (!parsed.attachments.length) {
        if (!text && !quoted) {
          await markFeishuMessage(msg.messageId, "ignored");
          return;
        }
        if (text) {
          const handled = await this.handleCommand(msg, key, text);
          if (handled) {
            await markFeishuMessage(msg.messageId, "replied");
            return;
          }
        }
      }

      if (this.isDuplicateContent(msg, key, text, parsed.attachments)) {
        await markFeishuMessage(msg.messageId, "ignored");
        return;
      }

      const model = await this.conversations.getSelectedModel(key);
      const modelSupportsImage = Boolean(model?.supportsImage);
      debugLog("feishu.handler.model", {
        messageId: msg.messageId,
        key,
        model: model ? `${model.provider}/${model.id}` : undefined,
        modelSupportsImage,
      });

      const processed = await this.processAttachments(msg, parsed.attachments, modelSupportsImage);
      // [patch:quoted-post] 引用附件必须用被引用父消息的 id 下载（否则 400 File not in msg.），
      // 结果再与本条消息自身附件合并，统一交给下游送模型。
      const quotedProcessed = quotedRef
        ? await this.processAttachments(msg, quotedRef.attachments, modelSupportsImage, quotedRef.messageId)
        : { imageInputs: [], fileSections: [], downloadErrors: [], skippedImageCount: 0 };
      // [patch:merge-forward-expand] 合并转发子消息的附件：各自带归属 id，无需 resourceMessageId
      const mergedForwardProcessed = mergedForwardAttachments.length
        ? await this.processAttachments(msg, mergedForwardAttachments, modelSupportsImage)
        : { imageInputs: [], fileSections: [], downloadErrors: [], skippedImageCount: 0 };
      const { imageInputs, fileSections, downloadErrors, skippedImageCount } = {
        imageInputs: [...processed.imageInputs, ...quotedProcessed.imageInputs, ...mergedForwardProcessed.imageInputs],
        fileSections: [...processed.fileSections, ...quotedProcessed.fileSections, ...mergedForwardProcessed.fileSections],
        downloadErrors: [...processed.downloadErrors, ...quotedProcessed.downloadErrors, ...mergedForwardProcessed.downloadErrors],
        skippedImageCount: processed.skippedImageCount + quotedProcessed.skippedImageCount + mergedForwardProcessed.skippedImageCount,
      };

      if (skippedImageCount > 0 && imageInputs.length === 0 && !fileSections.length && !text.trim()) {
        await transport.replyText(
          msg.messageId,
          "当前模型不支持图片解析。请先发送 /model 并切换到支持图片的模型后，再重发图片。",
        );
        await markFeishuMessage(msg.messageId, "replied");
        return;
      }

      if (downloadErrors.length && !imageInputs.length && !fileSections.length && !text.trim()) {
        await transport.replyText(msg.messageId, `没有可处理的内容：${downloadErrors.join("；")}`);
        await markFeishuMessage(msg.messageId, "replied");
        return;
      }

      const basePrompt = buildPrompt(msg, text, fileSections, imageInputs, skippedImageCount, modelSupportsImage, downloadErrors);
      const prompt = buildPromptWithQuote(basePrompt, quoted);
      // 单卡：全程 header；流式参数来自 config/env
      const useStreaming = cfg?.streamingReply !== false;
      const card = new ReplyCard(key, msg.messageId, transport, {
        enabled: useStreaming,
        printFrequencyMs: cfg?.streamPrintFrequencyMs,
        printStep: cfg?.streamPrintStep,
        pushIntervalMs: cfg?.streamPushIntervalMs,
      });
      await card.start();

      await this.conversations.promptWithImages(
        key,
        prompt,
        imageInputs,
        async (reply) => {
          const answer = reply || "（无内容）";
          // [patch:quoted-card-recall] 先登记再收尾：用户随时可能引用这张卡片。
          const cardMessageId = card.messageId;
          if (cardMessageId) this.bridgeStore?.rememberCardAnswer(cardMessageId, answer);
          await card.completeWithAnswer(answer);
        },
        card,
        useStreaming ? (delta) => card.append(delta) : undefined,
      );
      await markFeishuMessage(msg.messageId, "replied");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog("feishu.handler.error", { messageId: msg.messageId, error: message });
      await markFeishuMessage(msg.messageId, "failed", message);
      await this.getTransport()?.replyText(msg.messageId, `Pi error: ${message}`);
    }
  }

  private async handleCommand(msg: FeishuMessage, key: string, text: string) {
    const command = parseBotCommand(text);
    if (!command) return false;

    const transport = this.getTransport();
    if (!transport) return true;

    if (command.name === "new") {
      await this.conversations.newConversation(key, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "model") {
      const models = await this.conversations.getAvailableModels();
      if (!models.length) {
        await transport.replyText(msg.messageId, "当前没有可用模型。请先在 Pi 里完成模型登录或 API Key 配置。");
        return true;
      }
      const currentModel = await this.conversations.getSelectedModel(key);
      await transport.replyCard(msg.messageId, buildModelCard(key, models, currentModel));
      return true;
    }

    if (command.name === "thinking") {
      const [currentModel, thinking] = await Promise.all([
        this.conversations.getSelectedModel(key),
        this.conversations.getThinkingStatus(key),
      ]);
      await transport.replyCard(msg.messageId, buildThinkingCard(key, currentModel, thinking));
      return true;
    }

    if (command.name === "resume") {
      const page = await this.conversations.listResumeSessions(key, "current", 0);
      await transport.replyCard(msg.messageId, buildResumeCard(page));
      return true;
    }

    if (command.name === "stop") {
      await this.conversations.stopConversation(key, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "workspace") {
      await this.conversations.switchWorkspace(key, command.path, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "status") {
      const st = this.conversations.getStatus(key);
      const ctx = await this.conversations.getContextStatus(key);
      const model = await this.conversations.getActualModel(key);
      const thinking = await this.conversations.getThinkingStatus(key);
      const formatTokens = (n: number) => {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
        return `${n}`;
      };
      const ctxLine = ctx && ctx.tokens !== null && ctx.contextWindow
        ? `${(ctx.percent ?? 0).toFixed(1)}% / ${formatTokens(ctx.contextWindow)} (↑${formatTokens(ctx.tokens ?? 0)} tokens)`
        : "暂无数据（发送一条消息后才会显示）";
      const stateLine = st.hasActiveRun
        ? (st.activeStopped ? "⏹ 已停止" : "🟢 正在生成回复")
        : "⚪ 空闲";
      await transport.replyText(
        msg.messageId,
        [
          "📊 当前状态",
          "",
          `状态: ${stateLine}`,
          `目录: ${st.cwd}`,
          `模型: ${model}`,
          `thinking: ${thinking.available ? thinking.currentLevel || "(unknown)" : "(unavailable)"}`,
          `上下文: ${ctxLine}`,
        ].join("\n"),
      );
      return true;
    }

    if (command.name === "commands") {
      await transport.replyText(msg.messageId, `可用命令：\n${getCommandList()}`);
      return true;
    }

    if (command.name === "config") {
      if (msg.chatType !== "p2p") {
        await transport.replyText(
          msg.messageId,
          "为避免群聊成员意外修改机器人配置，/config 仅支持在与机器人的私聊中使用。",
        );
        return true;
      }
      if (command.clearTarget) {
        const cleared = clearRuntimeOverrides(command.clearTarget);
        if (cleared.ok === false) {
          await transport.replyText(msg.messageId, `❌ ${cleared.error}`);
          return true;
        }
        const cfg = loadConfig();
        await transport.replyText(
          msg.messageId,
          [
            command.clearTarget === "all" ? "已清除全部 runtime overrides" : `已清除 override: ${command.clearTarget}`,
            "",
            cfg ? formatRuntimeConfig(cfg, getRuntimeOverrides()) : "配置不可用",
          ].join("\n"),
        );
        return true;
      }
      if (command.key) {
        if (command.value === undefined || command.value === "") {
          await transport.replyText(
            msg.messageId,
            `用法: /config ${command.key} <value>\n或: /config clear ${command.key}`,
          );
          return true;
        }
        const set = setRuntimeConfig(command.key, command.value);
        if (set.ok === false) {
          await transport.replyText(msg.messageId, `❌ ${set.error}`);
          return true;
        }
        const cfg = loadConfig();
        await transport.replyText(
          msg.messageId,
          [
            `✅ 已更新 ${set.key} = ${Array.isArray(set.value) ? set.value.join(", ") : String(set.value)}`,
            "已热更新并落盘（runtime-overrides.json）",
            "",
            cfg ? formatRuntimeConfig(cfg, getRuntimeOverrides()) : "",
          ].filter(Boolean).join("\n"),
        );
        return true;
      }
      const cfg = loadConfig();
      await transport.replyText(
        msg.messageId,
        cfg ? formatRuntimeConfig(cfg, getRuntimeOverrides()) : "配置不可用（缺少 FEISHU_APP_ID/SECRET）",
      );
      return true;
    }

    return false;
  }

  private isDuplicateContent(msg: FeishuMessage, key: string, text: string, attachments: Array<{ kind: string; fileKey: string; fileName?: string }>) {
    const now = Date.now();
    const attachmentKey = attachments.map((a) => `${a.kind}:${a.fileKey}:${a.fileName || ""}`).join("|");
    const contentKey = [key, msg.senderOpenId, normalizeForDedupe(text), attachmentKey].join("\u0000");
    const previousContentAt = this.recentContent.get(contentKey);
    if (previousContentAt && now - previousContentAt <= CONTENT_DEDUPE_TTL_MS) return true;
    this.recentContent.set(contentKey, now);
    if (this.recentContent.size > 2000) pruneRecentMap(this.recentContent, now, CONTENT_DEDUPE_TTL_MS);
    return false;
  }

  private async processAttachments(
    msg: FeishuMessage,
    // [patch:merge-forward-expand] 改用 FeishuAttachment：附件可自带归属消息 id（合并转发子消息）
    attachments: FeishuAttachment[],
    modelSupportsImage: boolean,
    // [patch:quoted-post] 附件归属的消息 id。引用附件的 file_key 只属于被引用的父消息，
    // 用当前消息 id 下载会被飞书拒绝（400 code=234003 File not in msg.）。
    resourceMessageId?: string,
  ) {
    const transport = this.getTransport();
    // [patch:merge-forward-expand] 附件优先用自己的归属消息 id，取不到才回落到本条/被引用消息
    const fallbackDownloadMessageId = resourceMessageId ?? msg.messageId;
    const imageInputs: FeishuImageInput[] = [];
    const fileSections: string[] = [];
    const downloadErrors: string[] = [];
    let skippedImageCount = 0;

    for (const attachment of attachments) {
      // [patch:merge-forward-expand] 每个附件用各自归属的消息 id 下载
      const downloadMessageId = attachment.messageId ?? fallbackDownloadMessageId;
      if (attachment.kind === "image") {
        if (!modelSupportsImage) {
          skippedImageCount += 1;
          continue;
        }
        if (!transport) {
          downloadErrors.push("飞书连接不可用，图片无法下载");
          continue;
        }
        try {
          const resource = await withTimeout(
            transport.downloadImage(downloadMessageId, attachment.fileKey),
            15000,
            "图片下载超时",
          );
          const mimeType = detectImageMime(resource.bytes, resource.mimeType);
          if (!isSupportedImageMime(mimeType)) {
            downloadErrors.push("图片格式暂不支持（仅支持 png/jpg/webp）");
            continue;
          }
          imageInputs.push({
            type: "image",
            data: resource.bytes.toString("base64"),
            mimeType,
          });
        } catch (error) {
          debugLog("feishu.handler.image_error", {
            messageId: msg.messageId,
            fileKey: attachment.fileKey,
            error: error instanceof Error ? error.message : String(error),
          });
          downloadErrors.push(error instanceof Error ? error.message : "图片下载失败");
        }
        continue;
      }

      const fileName = attachment.fileName || "unnamed";
      if (!isSupportedTextFile(fileName)) {
        downloadErrors.push(`文件类型不支持：${fileName}`);
        continue;
      }
      if (!transport) {
        downloadErrors.push(`飞书连接不可用，文件无法下载：${fileName}`);
        continue;
      }
      try {
        const resource = await withTimeout(
          transport.downloadMessageResource(downloadMessageId, attachment.fileKey, "file"),
          15000,
          `文件下载超时：${fileName}`,
        );
        const decoded = decodeTextFile(fileName, resource.bytes);
        if (!decoded.ok) {
          downloadErrors.push(`文件无法按文本读取：${fileName}`);
          continue;
        }
        const language = detectCodeLanguage(fileName);
        const suffix = decoded.truncated ? "\n[内容过长，已截断]" : "";
        fileSections.push(`[Feishu file: ${fileName}]\n\`\`\`${language}\n${decoded.text}${suffix}\n\`\`\``);
      } catch (error) {
        downloadErrors.push(error instanceof Error ? error.message : `文件下载失败：${fileName}`);
      }
    }

    return { imageInputs, fileSections, downloadErrors, skippedImageCount };
  }
}

function buildPrompt(
  msg: FeishuMessage,
  text: string,
  fileSections: string[],
  imageInputs: FeishuImageInput[],
  skippedImageCount: number,
  modelSupportsImage: boolean,
  downloadErrors: string[],
) {
  const contentParts: string[] = [];
  if (text.trim()) contentParts.push(text.trim());
  if (fileSections.length) contentParts.push(fileSections.join("\n\n"));
  if (!contentParts.length && imageInputs.length) {
    contentParts.push("请根据图片内容进行分析。");
  }

  if (skippedImageCount > 0 && !modelSupportsImage) {
    contentParts.push("[提示：当前模型不支持图片，本次仅处理文本/文件内容。]");
  }

  if (downloadErrors.length) {
    contentParts.push(`[部分附件未处理：${downloadErrors.join("；")}]`);
  }

  const promptBody = contentParts.join("\n\n").trim();
  const label = conversationLabel(msg);
  return label ? `${label} ${promptBody}` : promptBody;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

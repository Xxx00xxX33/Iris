/**
 * 对话历史总结模块
 *
 * 将对话历史压缩为一段上下文摘要，用于缩减发送给 LLM 的上下文长度。
 * 总结结果以特殊的 user 消息存入历史，后续 LLM 调用仅从该消息开始加载上下文。
 *
 * 总结时将完整的 Content[] 作为对话历史直接发给总结 AI，
 * 由 AI 自行理解工具调用和返回结果。
 */

import { Content, Part, LLMRequest, extractText } from '../types';
import { LLMRouter } from '../llm/router';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROMPT } from '../config/summary';
import type { SummaryConfig } from '../config/types';

export interface SummarizeHistoryOptions {
  /** 是否使用流式接口调用总结模型（来自 system.yaml 的 stream 配置） */
  stream?: boolean;
  signal?: AbortSignal;
}

/**
 * 剥离 Part 中的思考签名和内部计时字段。
 *
 * thoughtSignatures 是各 provider 的加密签名，仅对产生它的同一 provider 有意义，
 * 发给总结模型无用且浪费 token。
 */
function stripThoughtMeta(part: Part): Part {
  if (!('text' in part)) return part;
  const { thoughtSignatures, thoughtDurationMs, ...clean } = part;
  return clean;
}

function normalizeOptions(optionsOrSignal?: AbortSignal | SummarizeHistoryOptions): SummarizeHistoryOptions {
  if (!optionsOrSignal) return {};
  if ('aborted' in optionsOrSignal || 'addEventListener' in optionsOrSignal) {
    return { signal: optionsOrSignal as AbortSignal };
  }
  return optionsOrSignal;
}

/**
 * 使用流式接口调用总结模型，并只收集可见文本。
 *
 * 这里不向 Backend/UI 转发 stream 事件：/compact 最终会以 summary 消息写入历史，
 * 普通 assistant 流式事件若混入会导致界面多出一条临时 assistant 消息。
 */
async function collectStreamText(
  router: LLMRouter,
  request: LLMRequest,
  modelName?: string,
  signal?: AbortSignal,
): Promise<string> {
  const parts: string[] = [];

  for await (const chunk of router.chatStream(request, modelName, signal)) {
    if (chunk.partsDelta && chunk.partsDelta.length > 0) {
      for (const part of chunk.partsDelta) {
        if ('text' in part && part.thought !== true && part.text) {
          parts.push(part.text);
        }
      }
    } else if (chunk.textDelta) {
      parts.push(chunk.textDelta);
    }
  }

  return parts.join('').trim();
}

/**
 * 调用 LLM 对历史进行总结。
 *
 * 将完整的 Content[] 作为对话历史发给总结 AI，
 * 末尾追加一条 user 消息要求生成摘要。
 * 不携带工具声明，按照 system.yaml 的 stream 配置选择流式或非流式调用。
 */
export async function summarizeHistory(
  router: LLMRouter,
  history: Content[],
  modelName?: string,
  config?: SummaryConfig,
  optionsOrSignal?: AbortSignal | SummarizeHistoryOptions,
): Promise<string> {
  const options = normalizeOptions(optionsOrSignal);
  const cleanHistory: Content[] = history.map(({ role, parts }) => ({
    role,
    parts: parts.map(stripThoughtMeta),
  }));

  cleanHistory.push({
    role: 'user',
    parts: [{ text: config?.userPrompt ?? DEFAULT_USER_PROMPT }],
  });

  const request: LLMRequest = {
    contents: cleanHistory,
  };

  const systemPrompt = config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  if (systemPrompt) {
    request.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  if (options.stream) {
    return collectStreamText(router, request, modelName, options.signal);
  }

  const response = await router.chat(request, modelName, options.signal);
  return extractText(response.content.parts).trim();
}

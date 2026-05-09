import { describe, it, expect, vi } from 'vitest';
import { Backend } from '../src/core/backend/backend.js';
import { summarizeHistory } from '../src/core/summarizer.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolStateManager } from '../src/tools/state.js';
import { PromptAssembler } from '../src/prompt/assembler.js';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROMPT, parseSummaryConfig } from '../src/config/summary.js';
import type { Content, LLMRequest, LLMStreamChunk } from '../src/types/index.js';

const history: Content[] = [
  { role: 'user', parts: [{ text: 'hello' }] },
  { role: 'model', parts: [{ text: 'hi' }] },
];

function streamFrom(chunks: LLMStreamChunk[]): AsyncGenerator<LLMStreamChunk> {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

describe('parseSummaryConfig defaults', () => {
  it('uses the configured default compact prompts', () => {
    const config = parseSummaryConfig({});

    expect(config.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(config.userPrompt).toBe(DEFAULT_USER_PROMPT);
    expect(config.systemPrompt).toBe('Please summarize the above conversation, keeping key information and context points while removing redundant content.');
    expect(config.userPrompt).toContain('## User Requirements');
    expect(config.userPrompt).toContain('Output content directly without any prefix.');
  });
});

describe('summarizeHistory stream option', () => {
  it('uses non-stream chat when stream is disabled', async () => {
    const router = {
      chat: vi.fn(async (_request: LLMRequest, _modelName?: string, _signal?: AbortSignal) => ({
        content: { role: 'model' as const, parts: [{ text: ' non-stream summary ' }] },
      })),
      chatStream: vi.fn(),
    } as any;

    const result = await summarizeHistory(router, history, 'summary-model', undefined, { stream: false });

    expect(result).toBe('non-stream summary');
    expect(router.chat).toHaveBeenCalledTimes(1);
    expect(router.chat).toHaveBeenCalledWith(expect.any(Object), 'summary-model', undefined);
    const request = router.chat.mock.calls[0][0] as LLMRequest;
    expect(request.contents.at(-1)?.role).toBe('user');
    expect(request.contents.at(-1)?.parts).toEqual([{ text: DEFAULT_USER_PROMPT }]);
    expect(request.systemInstruction?.parts).toEqual([{ text: DEFAULT_SYSTEM_PROMPT }]);
    expect(router.chatStream).not.toHaveBeenCalled();
  });

  it('uses chatStream and collects visible text when stream is enabled', async () => {
    const signal = new AbortController().signal;
    const router = {
      chat: vi.fn(),
      chatStream: vi.fn((_request: LLMRequest, _modelName?: string, _signal?: AbortSignal) => streamFrom([
        { textDelta: 'stream ' },
        { partsDelta: [{ text: 'summary' }, { text: ' hidden thought ', thought: true }] },
        { textDelta: ' done' },
      ])),
    } as any;

    const result = await summarizeHistory(router, history, 'summary-model', undefined, { stream: true, signal });

    expect(result).toBe('stream summary done');
    expect(router.chat).not.toHaveBeenCalled();
    expect(router.chatStream).toHaveBeenCalledTimes(1);
    expect(router.chatStream).toHaveBeenCalledWith(expect.any(Object), 'summary-model', signal);
  });
});

describe('Backend.summarize', () => {
  it('honors backend stream configuration for compact summaries', async () => {
    const histories = new Map<string, Content[]>([['s1', [...history]]]);
    const storage = {
      getHistory: vi.fn(async (sessionId: string) => histories.get(sessionId) ?? []),
      addMessage: vi.fn(async (sessionId: string, msg: Content) => {
        if (!histories.has(sessionId)) histories.set(sessionId, []);
        histories.get(sessionId)!.push(msg);
      }),
    };
    const router = {
      chat: vi.fn(async () => { throw new Error('non-stream chat should not be used'); }),
      chatStream: vi.fn((_request: LLMRequest, _modelName?: string, _signal?: AbortSignal) => streamFrom([
        { textDelta: 'compact ' },
        { textDelta: 'summary' },
      ])),
      getCurrentModelName: vi.fn(() => 'mock-model'),
    } as any;

    const backend = new Backend(
      router,
      storage as any,
      new ToolRegistry(),
      new ToolStateManager(),
      new PromptAssembler(),
      { stream: true, summaryModelName: 'summary-model' },
    );

    const result = await backend.summarize('s1');

    expect(result).toBe('compact summary');
    expect(router.chat).not.toHaveBeenCalled();
    expect(router.chatStream).toHaveBeenCalledWith(expect.any(Object), 'summary-model', undefined);
    expect(storage.addMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
      role: 'user',
      isSummary: true,
      parts: [{ text: '[Context Summary]\n\ncompact summary' }],
    }));
  });
});

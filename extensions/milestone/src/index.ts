import {
  createPluginLogger,
  definePlugin,
  type IrisAPI,
  type MilestoneServiceLike,
  type MilestoneSnapshotLike,
  type MilestoneUpdateInputLike,
  type PluginContext,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionHandleLike,
} from 'irises-extension-sdk';

const logger = createPluginLogger('milestone');

const MILESTONE_TOOL_SYNC_IGNORED = new Set([
  'update_milestones', 'list_milestones',
  'EnterPlanMode', 'ExitPlanMode', 'read_plan', 'write_plan',
  'AskQuestionFirst',
]);

const DEFAULT_PLAN_MAX_ITEMS = 8;
const ACTION_SECTION_RE = /(实施|执行|步骤|任务|里程碑|开发|修改|验证|测试|上线|交付|implementation|steps?|tasks?|milestones?|todo|plan)/i;
const PASSIVE_SECTION_RE = /(背景|上下文|目标|约束|风险|说明|备注|现状|已完成|验收|参考|background|context|goals?|constraints?|risks?|notes?|done|acceptance|reference)/i;
const ACTION_TEXT_RE = /(实现|修改|新增|补充|接入|调整|修复|验证|测试|运行|更新|删除|迁移|重构|检查|确认|implement|modify|add|wire|fix|verify|test|run|update|delete|migrate|refactor|check)/i;

export interface PlanMilestoneCandidate {
  text: string;
  source: 'task-list' | 'numbered-list' | 'bullet-list' | 'heading' | 'fallback';
  section?: string;
}

const ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '会话内稳定 ID，例如 m1、tests、phase-2。省略时 Iris 会根据标题生成。' },
    title: { type: 'string', description: '面向用户展示的短标题，建议使用动宾短语。' },
    description: { type: 'string', description: '更完整的说明、验收条件或上下文。' },
    activeForm: { type: 'string', description: '当前进行中时用于 spinner/状态栏的现在进行时文案，例如「运行测试」。' },
    status: {
      type: 'string',
      enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'],
      description: '状态：pending 待处理/未开始（尚未执行，或暂时回到等待队列），in_progress 正在做，completed 已完成，blocked 被阻塞，cancelled 已取消。',
    },
    owner: { type: 'string', description: '负责该项的 Agent 名称。未填时默认为当前 Agent。' },
    blockedBy: { type: 'array', items: { type: 'string' }, description: '该项依赖的 milestone ID 列表。' },
    blocks: { type: 'array', items: { type: 'string' }, description: '该项完成后会解除阻塞的 milestone ID 列表。' },
    metadata: { type: 'object', description: '可选结构化扩展字段。' },
    delete: { type: 'boolean', description: '设为 true 时删除该 ID 对应的 milestone。' },
    expectedVersion: { type: 'number', description: '可选乐观并发版本号。若提供，必须与当前 milestone.version 一致，否则更新会被拒绝。' },
    force: { type: 'boolean', description: '是否强制接管/覆盖 owner 保护。仅当前台 Agent 或无 routeAgent 的当前执行方可使用。' },
  },
};

function getMilestones(api: IrisAPI): MilestoneServiceLike {
  if (!api.milestones) throw new Error('Milestone 服务不可用');
  return api.milestones;
}

function getSessionId(api: IrisAPI, context?: ToolExecutionContext): string {
  const sessionId = context?.sessionId ?? api.backend.getActiveSessionId?.();
  if (!sessionId) throw new Error('milestone 工具只能在会话执行上下文中使用');
  return sessionId;
}

function normalizeItems(raw: unknown): MilestoneUpdateInputLike[] {
  if (!Array.isArray(raw)) throw new Error('items 必须是数组');
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`items[${index}] 必须是对象`);
    }
    return entry as MilestoneUpdateInputLike;
  });
}

function resolveSourceAgentName(api: IrisAPI, context?: ToolExecutionContext): string | undefined {
  const base = api.agentName;
  const current = context?.sourceAgent;
  if (current && current !== 'main') return base ? `${base}:${current}` : current;
  return base;
}

function parseCrossAgentTaskId(sessionId: string): string | undefined {
  if (!sessionId.startsWith('cross-agent:')) return undefined;
  const parts = sessionId.split(':');
  if (parts.length < 3) return undefined;
  return parts.slice(2).join(':') || undefined;
}

function resolveExecutionContext(api: IrisAPI, context?: ToolExecutionContext): { sessionId: string; sourceAgent?: string; routeAgent?: string } {
  const rawSessionId = getSessionId(api, context);
  const baseAgent = api.agentName;
  const sourceAgent = resolveSourceAgentName(api, context);
  const crossAgentTaskId = parseCrossAgentTaskId(rawSessionId);

  if (crossAgentTaskId && api.taskBoard?.get) {
    const task = api.taskBoard.get(crossAgentTaskId);
    if (task?.type === 'delegate') {
      return { sessionId: task.sourceSessionId, sourceAgent, routeAgent: task.sourceAgent };
    }
  }

  return { sessionId: rawSessionId, sourceAgent, routeAgent: baseAgent };
}

function formatSummary(snapshot: MilestoneSnapshotLike): string {
  const { stats } = snapshot;
  if (stats.total === 0) return '当前没有 milestone。';
  const active = snapshot.items.find((item) => item.status === 'in_progress');
  return `${stats.completed}/${stats.total} 个 milestone 已完成，${stats.open} 个未完成${active ? `；当前：${active.title}` : ''}`;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/[*_~`>#]/g, '')
    .replace(/^\s*(?:步骤|阶段|任务|Step|Phase|Task)\s*\d+\s*[:：.)-]?\s*/i, '')
    .replace(/^\s*(?:TODO|待办|实施|执行)\s*[:：-]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。；;,.，]+$/g, '')
    .trim();
}

function truncateTitle(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isUsefulCandidate(text: string): boolean {
  const cleaned = stripMarkdown(text);
  if (cleaned.length < 3) return false;
  if (/^https?:\/\//i.test(cleaned)) return false;
  if (/^(yes|no|true|false|null|none)$/i.test(cleaned)) return false;
  return true;
}

function pushCandidate(candidates: PlanMilestoneCandidate[], candidate: PlanMilestoneCandidate): void {
  const cleaned = truncateTitle(stripMarkdown(candidate.text));
  if (!isUsefulCandidate(cleaned)) return;
  const key = cleaned.toLowerCase();
  if (candidates.some((item) => stripMarkdown(item.text).toLowerCase() === key)) return;
  candidates.push({ ...candidate, text: cleaned });
}

export function extractPlanMilestoneCandidates(plan: string, maxItems: number = DEFAULT_PLAN_MAX_ITEMS): PlanMilestoneCandidate[] {
  const candidates: PlanMilestoneCandidate[] = [];
  const headingFallback: PlanMilestoneCandidate[] = [];
  let inCodeBlock = false;
  let currentSection = '';
  let currentSectionActionable = false;
  let currentSectionPassive = false;

  for (const rawLine of plan.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      currentSection = stripMarkdown(heading[2]);
      currentSectionActionable = ACTION_SECTION_RE.test(currentSection);
      currentSectionPassive = PASSIVE_SECTION_RE.test(currentSection) && !currentSectionActionable;
      if (currentSectionActionable && !currentSectionPassive) headingFallback.push({ text: currentSection, source: 'heading', section: currentSection });
      continue;
    }

    const taskList = /^[-*+]\s+\[[ xX-]\]\s+(.+)$/.exec(line);
    if (taskList) {
      if (!currentSectionPassive) pushCandidate(candidates, { text: taskList[1], source: 'task-list', section: currentSection });
      continue;
    }

    const numbered = /^\d+[.)、]\s+(.+)$/.exec(line);
    if (numbered) {
      if (!currentSectionPassive) pushCandidate(candidates, { text: numbered[1], source: 'numbered-list', section: currentSection });
      continue;
    }

    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      const text = bullet[1];
      if (!currentSectionPassive && (currentSectionActionable || ACTION_TEXT_RE.test(text))) {
        pushCandidate(candidates, { text, source: 'bullet-list', section: currentSection });
      }
    }
  }

  if (candidates.length === 0) {
    for (const candidate of headingFallback) {
      pushCandidate(candidates, candidate);
      if (candidates.length >= maxItems) break;
    }
  }
  if (candidates.length === 0) candidates.push({ text: '按批准计划执行', source: 'fallback' });
  return candidates.slice(0, Math.max(1, maxItems));
}

export function buildMilestonesFromApprovedPlan(plan: string, options: { owner?: string; planFilePath?: string; maxItems?: number } = {}): MilestoneUpdateInputLike[] {
  const maxItems = options.maxItems ?? DEFAULT_PLAN_MAX_ITEMS;
  return extractPlanMilestoneCandidates(plan, maxItems).map((candidate, index) => ({
    id: `m${index + 1}`,
    title: candidate.text,
    status: 'pending',
    owner: options.owner,
    description: candidate.section && candidate.section !== candidate.text ? `来自计划章节：${candidate.section}` : undefined,
    metadata: {
      origin: 'plan_mode',
      source: candidate.source,
      ...(options.planFilePath ? { planFilePath: options.planFilePath } : {}),
    },
  }));
}

function createUpdateMilestonesTool(api: IrisAPI): ToolDefinition {
  return {
    approvalMode: 'handler',
    parallel: false,
    declaration: {
      name: 'update_milestones',
      description: `更新当前会话的结构化 milestone/task 清单，并驱动 Console/Web 中的 Iris 进度面板。

使用规则：
- 复杂、多步骤、跨文件或用户明确要求跟踪进度时，先创建 3-8 个 milestone。
- 开始某项工作前，把该项设为 in_progress；完成后立即设为 completed，不要批量拖到最后。
- 通常同一 Agent 同一时间只应有一个 in_progress；多 Agent 并行时可通过 owner 区分负责人。
- 当前前台 Agent 初次建立完整清单时可使用 replaceAll=true；子代理或委派 Agent 更新时请用增量 items，避免覆盖其他 Agent 的 owner/状态。
- list_milestones 会返回每项 version；并发敏感更新可带 expectedVersion，防止别人刚刚写入的状态被覆盖。
- 这不是最终回复文本；调用后 UI 会自动显示进度清单。`,
      parameters: {
        type: 'object',
        properties: {
          items: { type: 'array', items: ITEM_SCHEMA, description: '要创建、更新或删除的 milestone 项。默认按 id 增量合并。' },
          replaceAll: { type: 'boolean', description: '是否用 items 完整替换当前会话 milestone。仅当前台 Agent 初始化主清单时使用。' },
        },
        required: ['items'],
      },
    },
    handler: async (args, context) => {
      const service = getMilestones(api);
      const ctx = resolveExecutionContext(api, context);
      const items = normalizeItems(args.items);
      const mayReplaceAll = !ctx.routeAgent || !ctx.sourceAgent || ctx.sourceAgent === ctx.routeAgent;
      const replaceAll = args.replaceAll === true && mayReplaceAll;
      const snapshot = service.update(ctx.sessionId, items, { sourceAgent: ctx.sourceAgent, routeAgent: ctx.routeAgent, replaceAll });
      return { ok: true, summary: formatSummary(snapshot), snapshot };
    },
  };
}

function createListMilestonesTool(api: IrisAPI): ToolDefinition {
  return {
    approvalMode: 'handler',
    parallel: true,
    declaration: {
      name: 'list_milestones',
      description: '读取当前会话的 milestone/task 清单，用于检查整体进度、避免重复创建或确认下一步。',
      parameters: { type: 'object', properties: {} },
    },
    handler: async (_args, context) => {
      const service = getMilestones(api);
      const ctx = resolveExecutionContext(api, context);
      const snapshot = service.getSnapshot(ctx.sessionId, ctx.sourceAgent);
      return { ok: true, summary: formatSummary(snapshot), snapshot };
    },
  };
}

function wrapExitPlanMode(api: IrisAPI, ctx: PluginContext): void {
  const exitPlanTool = ctx.getToolRegistry().get?.('ExitPlanMode');
  if (!exitPlanTool) return;
  const original = exitPlanTool.handler;
  const wrapped = async (args: Record<string, unknown>, context?: ToolExecutionContext) => {
    const result = await original(args, context);
    try {
      const record = result && typeof result === 'object' ? result as Record<string, unknown> : undefined;
      const approvedPlan = typeof record?.approvedPlan === 'string' ? record.approvedPlan : undefined;
      const planFilePath = typeof record?.planFilePath === 'string' ? record.planFilePath : undefined;
      if (record?.approved === true && approvedPlan) {
        const sessionId = context?.sessionId ?? api.backend.getActiveSessionId?.();
        const agentName = api.agentName ?? 'master';
        if (sessionId) {
          const items = buildMilestonesFromApprovedPlan(approvedPlan, { owner: agentName, planFilePath });
          getMilestones(api).update(sessionId, items, { sourceAgent: agentName, routeAgent: agentName, replaceAll: true });
        }
      }
    } catch (err) {
      logger.warn('Plan Mode milestone 同步失败:', err);
    }
    return result;
  };
  exitPlanTool.handler = wrapped as typeof exitPlanTool.handler;
  ctx.trackDisposable({ dispose: () => { if (exitPlanTool.handler === wrapped) exitPlanTool.handler = original; } });
}

function resolveExecutionContextForTool(api: IrisAPI, rawSessionId: string): { sessionId: string; sourceAgent?: string; routeAgent?: string } {
  const baseAgent = api.agentName;
  const crossAgentTaskId = parseCrossAgentTaskId(rawSessionId);
  if (crossAgentTaskId && api.taskBoard?.get) {
    const task = api.taskBoard.get(crossAgentTaskId);
    if (task?.type === 'delegate') return { sessionId: task.sourceSessionId, sourceAgent: baseAgent, routeAgent: task.sourceAgent };
  }
  return { sessionId: rawSessionId, sourceAgent: baseAgent, routeAgent: baseAgent };
}

function observeToolFailures(api: IrisAPI, ctx: PluginContext): void {
  const listener = (_sessionId: string, handle: ToolExecutionHandleLike) => {
    const initial = handle.getSnapshot();
    if (MILESTONE_TOOL_SYNC_IGNORED.has(initial.toolName)) return;
    if (initial.parentToolId || (initial.depth ?? 0) > 0) return;

    const done = (_result?: unknown, error?: string) => {
      const snapshot = handle.getSnapshot();
      if (snapshot.status !== 'error') return;
      const service = api.milestones;
      if (!service?.noteActiveToolFailure) return;
      const ctxInfo = resolveExecutionContextForTool(api, snapshot.sessionId ?? _sessionId);
      service.noteActiveToolFailure(ctxInfo.sessionId, {
        toolId: snapshot.id,
        toolName: snapshot.toolName,
        error: snapshot.error ?? error ?? '未知错误',
        sourceAgent: ctxInfo.sourceAgent,
        routeAgent: ctxInfo.routeAgent,
      });
    };
    handle.on('done', done);
  };
  api.backend.on('tool:execute', listener);
  ctx.trackDisposable({ dispose: () => api.backend.off('tool:execute', listener) });
}

export function createMilestoneToolsForApi(api: IrisAPI): ToolDefinition[] {
  return [createUpdateMilestonesTool(api), createListMilestonesTool(api)];
}

export const milestonePlugin = definePlugin({
  name: 'milestone',
  version: '0.1.0',
  description: '结构化里程碑 / Iris 进度扩展',

  activate(ctx: PluginContext) {
    ctx.onReady((api) => {
      if (!api.milestones) {
        logger.warn('Milestone 服务不可用，跳过工具注册');
        return;
      }
      (api.config as any).tools ??= {};
      ((api.config as any).tools.permissions ??= {}).update_milestones ??= { autoApprove: true };
      ((api.config as any).tools.permissions ??= {}).list_milestones ??= { autoApprove: true };
      ctx.registerTools(createMilestoneToolsForApi(api));
      wrapExitPlanMode(api, ctx);
      observeToolFailures(api, ctx);
    });
  },
});

export default milestonePlugin;

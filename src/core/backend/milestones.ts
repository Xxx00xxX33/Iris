/**
 * BackendMilestoneCoordinator
 *
 * 只保留 Core 必须提供的 milestone 基础服务：运行态桥接、持久化归档与 UI 状态。
 * 工具注册、计划同步、工具失败联动等专属逻辑由 milestone extension 承载。
 */

import type { StorageProvider, SessionMeta } from '../../storage/base';
import { createLogger } from '../../logger';
import type {
  SessionMilestoneManager,
  MilestoneArchiveEntry,
  MilestoneSnapshot,
  MilestoneUiState,
} from '../session-milestones';

const logger = createLogger('BackendMilestones');

type EnqueueMetaUpdate = <T>(sessionId: string, fn: () => Promise<T>) => Promise<T>;

export interface BackendMilestoneCoordinatorOptions {
  storage: StorageProvider;
  enqueueMetaUpdate: EnqueueMetaUpdate;
  emitUpdate: (sessionId: string, snapshot: MilestoneSnapshot) => void;
}

export class BackendMilestoneCoordinator {
  private manager?: SessionMilestoneManager;
  private cleanup?: () => void;
  private routeAgent?: string;

  constructor(private readonly options: BackendMilestoneCoordinatorOptions) {}

  dispose(): void {
    this.cleanup?.();
    this.cleanup = undefined;
  }

  setManager(manager: SessionMilestoneManager, routeAgent?: string): void {
    this.cleanup?.();
    this.manager = manager;
    this.routeAgent = routeAgent;

    const onUpdated = (snapshot: MilestoneSnapshot) => {
      if (this.routeAgent && snapshot.routeAgent && snapshot.routeAgent !== this.routeAgent) {
        return;
      }
      void this.persist(snapshot);
      this.options.emitUpdate(snapshot.sessionId, snapshot);
    };

    manager.on('updated', onUpdated);
    this.cleanup = () => manager.off('updated', onUpdated);
  }

  clear(sessionId: string): void {
    this.manager?.clear(sessionId, undefined, this.routeAgent);
  }

  getMilestones(sessionId: string): MilestoneSnapshot | undefined {
    const snapshot = this.manager?.getSnapshot(sessionId);
    if (snapshot?.routeAgent && this.routeAgent && snapshot.routeAgent !== this.routeAgent) {
      return undefined;
    }
    return snapshot;
  }

  async loadMilestones(sessionId: string): Promise<MilestoneSnapshot | undefined> {
    if (!this.manager) return undefined;
    const meta = await this.options.storage.getMeta(sessionId);
    const snapshot = meta?.milestones;
    if (!snapshot || snapshot.sessionId !== sessionId) return this.getMilestones(sessionId);
    if (snapshot.routeAgent && this.routeAgent && snapshot.routeAgent !== this.routeAgent) {
      return undefined;
    }

    const current = this.getMilestones(sessionId);
    const storageUpdatedAt = typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : 0;
    if (this.manager.hasSession(sessionId) && current && current.items.length > 0 && current.updatedAt >= storageUpdatedAt) {
      return current;
    }

    this.manager.hydrate(snapshot);
    return this.getMilestones(sessionId);
  }

  async loadArchives(sessionId: string): Promise<MilestoneArchiveEntry[]> {
    const meta = await this.options.storage.getMeta(sessionId);
    if (!meta) return [];
    const archives = this.normalizeArchives(meta.milestoneArchives, sessionId);

    // 兼容旧数据：如果只有 latest completed snapshot，而还没有归档列表，至少在历史末尾恢复一次。
    const latestSnapshot = meta.milestones;
    if (latestSnapshot && this.isArchivable(latestSnapshot) && !archives.some(entry => entry.snapshot.updatedAt === latestSnapshot.updatedAt)) {
      const historyLength = await this.getHistoryLengthSafe(sessionId);
      this.upsertArchive(meta, latestSnapshot, historyLength);
      await this.options.storage.saveMeta(meta);
      return this.normalizeArchives(meta.milestoneArchives, sessionId);
    }

    return archives;
  }

  async loadUiState(sessionId: string): Promise<MilestoneUiState | undefined> {
    const meta = await this.options.storage.getMeta(sessionId);
    return this.normalizeUiState(meta?.milestoneUiState);
  }

  async setUiState(sessionId: string, state: { expanded: boolean; snapshotUpdatedAt?: number }): Promise<void> {
    await this.options.enqueueMetaUpdate(sessionId, async () => {
      const meta = await this.options.storage.getMeta(sessionId);
      if (!meta) return;
      meta.milestoneUiState = this.createUiState(state.expanded, state.snapshotUpdatedAt);
      await this.options.storage.saveMeta(meta);
    });
  }

  applyCurrentToMeta(meta: SessionMeta): void {
    if (!this.manager?.hasSession(meta.id)) return;
    const snapshot = this.manager.getSnapshot(meta.id);
    if (snapshot.items.length > 0) {
      meta.milestones = snapshot;
      if (!this.normalizeUiState(meta.milestoneUiState) || this.isArchivable(snapshot)) {
        meta.milestoneUiState = this.createUiState(true, snapshot.updatedAt);
      }
    } else {
      delete meta.milestones;
    }
  }

  async persistCurrentIfArchivable(sessionId: string): Promise<void> {
    const snapshot = this.getMilestones(sessionId);
    if (snapshot && this.isArchivable(snapshot)) {
      await this.persist(snapshot);
    }
  }


  private isArchivable(snapshot: MilestoneSnapshot | undefined): boolean {
    return !!snapshot && snapshot.items.length > 0 && snapshot.stats.open === 0;
  }

  private normalizeArchives(value: unknown, sessionId?: string): MilestoneArchiveEntry[] {
    if (!Array.isArray(value)) return [];
    const archives: MilestoneArchiveEntry[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Partial<MilestoneArchiveEntry>;
      const snapshot = record.snapshot;
      if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.items)) continue;
      if (sessionId && snapshot.sessionId !== sessionId) continue;
      if (snapshot.routeAgent && this.routeAgent && snapshot.routeAgent !== this.routeAgent) continue;
      const archivedAt = typeof record.archivedAt === 'number'
        ? record.archivedAt
        : (typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : Date.now());
      const afterHistoryIndex = typeof record.afterHistoryIndex === 'number' && Number.isFinite(record.afterHistoryIndex)
        ? Math.max(0, Math.floor(record.afterHistoryIndex))
        : 0;
      archives.push({
        id: typeof record.id === 'string' && record.id ? record.id : `${snapshot.sessionId}:${snapshot.updatedAt}`,
        snapshot,
        archivedAt,
        afterHistoryIndex,
      });
    }
    return archives.sort((a, b) => a.afterHistoryIndex - b.afterHistoryIndex || a.archivedAt - b.archivedAt || a.id.localeCompare(b.id));
  }

  private upsertArchive(meta: SessionMeta, snapshot: MilestoneSnapshot, afterHistoryIndex: number): void {
    if (!this.isArchivable(snapshot)) return;
    if (snapshot.routeAgent && this.routeAgent && snapshot.routeAgent !== this.routeAgent) return;

    const archives = this.normalizeArchives(meta.milestoneArchives, snapshot.sessionId);
    const safeIndex = Math.max(0, Math.floor(afterHistoryIndex));
    const archiveId = `${snapshot.sessionId}:${snapshot.updatedAt}`;
    const existingIndex = archives.findIndex(entry => entry.id === archiveId || entry.snapshot.updatedAt === snapshot.updatedAt);
    if (existingIndex >= 0) {
      const existing = archives[existingIndex];
      archives[existingIndex] = {
        ...existing,
        id: existing.id || archiveId,
        snapshot,
        archivedAt: existing.archivedAt || snapshot.updatedAt || Date.now(),
        afterHistoryIndex: Math.max(existing.afterHistoryIndex ?? 0, safeIndex),
      };
    } else {
      archives.push({
        id: archiveId,
        snapshot,
        archivedAt: snapshot.updatedAt || Date.now(),
        afterHistoryIndex: safeIndex,
      });
    }
    meta.milestoneArchives = archives.sort((a, b) => a.afterHistoryIndex - b.afterHistoryIndex || a.archivedAt - b.archivedAt || a.id.localeCompare(b.id));
  }

  private normalizeUiState(value: unknown): MilestoneUiState | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Partial<MilestoneUiState>;
    if (typeof record.expanded !== 'boolean') return undefined;
    const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : Date.now();
    const snapshotUpdatedAt = typeof record.snapshotUpdatedAt === 'number' && Number.isFinite(record.snapshotUpdatedAt)
      ? record.snapshotUpdatedAt
      : undefined;
    return { expanded: record.expanded, updatedAt, ...(snapshotUpdatedAt != null ? { snapshotUpdatedAt } : {}) };
  }

  private createUiState(expanded: boolean, snapshotUpdatedAt?: number): MilestoneUiState {
    return {
      expanded,
      updatedAt: Date.now(),
      ...(typeof snapshotUpdatedAt === 'number' && Number.isFinite(snapshotUpdatedAt) ? { snapshotUpdatedAt } : {}),
    };
  }

  private async getHistoryLengthSafe(sessionId: string): Promise<number> {
    try {
      return (await this.options.storage.getHistory(sessionId)).length;
    } catch {
      return 0;
    }
  }

  private async persist(snapshot: MilestoneSnapshot): Promise<void> {
    await this.options.enqueueMetaUpdate(snapshot.sessionId, async () => {
      try {
        const meta = await this.options.storage.getMeta(snapshot.sessionId);
        if (!meta) return;
        meta.milestones = snapshot.items.length > 0 ? snapshot : undefined;
        const existingUiState = this.normalizeUiState(meta.milestoneUiState);
        if (this.isArchivable(snapshot)) {
          const historyLength = await this.getHistoryLengthSafe(snapshot.sessionId);
          this.upsertArchive(meta, snapshot, historyLength);
          meta.milestoneUiState = this.createUiState(true, snapshot.updatedAt);
        } else if (snapshot.items.length > 0 && !existingUiState) {
          meta.milestoneUiState = this.createUiState(true, snapshot.updatedAt);
        }
        await this.options.storage.saveMeta(meta);
      } catch (err) {
        logger.warn(`保存 milestone 状态失败 (session=${snapshot.sessionId}):`, err);
      }
    });
  }

}

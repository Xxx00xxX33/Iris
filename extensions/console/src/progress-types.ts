export type ProgressStatusLike = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';

export interface ProgressItemLike {
  id: string;
  title: string;
  description?: string;
  activeForm?: string;
  status: ProgressStatusLike;
  owner?: string;
  blockedBy?: string[];
  blocks?: string[];
  metadata?: Record<string, unknown>;
  version: number;
  createdAt: number;
  updatedAt: number;
  updatedBy?: string;
}

export interface ProgressSnapshotLike {
  sessionId: string;
  items: ProgressItemLike[];
  stats: {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    blocked: number;
    cancelled: number;
    open: number;
  };
  updatedAt: number;
  sourceAgent?: string;
  routeAgent?: string;
}

export interface ExamProgressSnapshot {
  attemptId: string;
  answers: Record<string, number>;
  flaggedQuestionIds: string[];
  currentQuestionIndex: number;
}

export interface ExamSaveApiResponse {
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
}

export interface ExamAnswerBatcherOptions {
  saveFn: (snapshot: ExamProgressSnapshot) => Promise<ExamSaveApiResponse>;
  debounceMs?: number;
  maxWaitMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  onSaved?: (snapshot: ExamProgressSnapshot) => void;
  onLockedError?: (error: { code: string; message?: string }) => void;
  onTransientError?: (error: { code?: string; status: number; message?: string }) => void;
}

function cloneSnapshot(s: ExamProgressSnapshot): ExamProgressSnapshot {
  return {
    attemptId: s.attemptId,
    answers: { ...s.answers },
    flaggedQuestionIds: [...s.flaggedQuestionIds],
    currentQuestionIndex: s.currentQuestionIndex
  };
}

function isPermanentLockCode(code?: string, status?: number): boolean {
  return (
    code === 'ALREADY_SUBMITTED' ||
    code === 'SESSION_REVOKED' ||
    code === 'ATTEMPT_NOT_FOUND' ||
    status === 401 ||
    status === 403
  );
}

/**
 * Coalesces rapid MCQ answer changes, clears, and flag toggles into debounced
 * backend sync requests with max-wait checkpointing, serialized non-overlapping
 * execution, bounded transient retries, and guaranteed pre-submit flush.
 */
export class ExamAnswerBatcher {
  private readonly saveFn: ExamAnswerBatcherOptions['saveFn'];
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly onSaved?: ExamAnswerBatcherOptions['onSaved'];
  private readonly onLockedError?: ExamAnswerBatcherOptions['onLockedError'];
  private readonly onTransientError?: ExamAnswerBatcherOptions['onTransientError'];

  private latestSnapshot: ExamProgressSnapshot | null = null;
  private dirty = false;
  private revision = 0;
  private lockedAttemptId: string | null = null;
  private retryCount = 0;
  private firstDirtyAtMs: number | null = null;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlightPromise: Promise<boolean> | null = null;

  constructor(options: ExamAnswerBatcherOptions) {
    this.saveFn = options.saveFn;
    this.debounceMs = options.debounceMs ?? 2500;
    this.maxWaitMs = options.maxWaitMs ?? 10000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
    this.onSaved = options.onSaved;
    this.onLockedError = options.onLockedError;
    this.onTransientError = options.onTransientError;
  }

  private clearTimers(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  public enqueue(snapshot: ExamProgressSnapshot): void {
    if (this.lockedAttemptId && this.lockedAttemptId === snapshot.attemptId) {
      return;
    }
    if (this.latestSnapshot && this.latestSnapshot.attemptId !== snapshot.attemptId) {
      // Switching to a brand-new attempt clears old pending timers cleanly
      this.clearTimers();
      this.lockedAttemptId = null;
      this.retryCount = 0;
      this.firstDirtyAtMs = null;
    }

    this.latestSnapshot = cloneSnapshot(snapshot);
    this.dirty = true;
    this.revision += 1;
    this.retryCount = 0;

    const now = Date.now();
    if (this.firstDirtyAtMs === null) {
      this.firstDirtyAtMs = now;
    }

    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.inFlightPromise) {
      // Wait for in-flight save; post-completion hook will schedule/flush the new revision
      return;
    }

    this.scheduleDebounce(now);
  }

  private scheduleDebounce(nowMs: number): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const elapsed = this.firstDirtyAtMs !== null ? nowMs - this.firstDirtyAtMs : 0;
    const remainingMaxWait = Math.max(0, this.maxWaitMs - elapsed);
    const delay = Math.min(this.debounceMs, remainingMaxWait);

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.dispatchSave();
    }, delay);
  }

  private async dispatchSave(): Promise<boolean> {
    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }
    if (!this.dirty || !this.latestSnapshot) {
      return true;
    }
    if (this.lockedAttemptId && this.lockedAttemptId === this.latestSnapshot.attemptId) {
      this.dirty = false;
      this.firstDirtyAtMs = null;
      return false;
    }

    const snapshotToSend = cloneSnapshot(this.latestSnapshot);
    const sentRevision = this.revision;

    const run = async (): Promise<boolean> => {
      let res: ExamSaveApiResponse;
      try {
        res = await this.saveFn(snapshotToSend);
      } catch (err: unknown) {
        res = {
          ok: false,
          status: 0,
          code: 'NETWORK_ERROR',
          message: err instanceof Error ? err.message : 'Network error'
        };
      }

      if (res.ok) {
        this.retryCount = 0;
        if (this.revision === sentRevision) {
          this.dirty = false;
          this.firstDirtyAtMs = null;
        }
        this.onSaved?.(snapshotToSend);
        return true;
      }

      if (isPermanentLockCode(res.code, res.status)) {
        this.lockedAttemptId = snapshotToSend.attemptId;
        this.dirty = false;
        this.firstDirtyAtMs = null;
        this.clearTimers();
        this.onLockedError?.({
          code: res.code || `HTTP_${res.status}`,
          message: res.message
        });
        return false;
      }

      this.onTransientError?.({
        code: res.code,
        status: res.status,
        message: res.message
      });

      if (this.revision === sentRevision && this.retryCount < this.maxRetries) {
        this.retryCount += 1;
        const backoff = this.retryBaseDelayMs * Math.pow(2, this.retryCount - 1);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.dispatchSave();
        }, backoff);
      }
      return false;
    };

    const promise = run().finally(() => {
      if (this.inFlightPromise === promise) {
        this.inFlightPromise = null;
      }
      // If newer mutations arrived while in-flight and no permanent lock occurred, trigger follow-up debounce/save
      if (
        this.dirty &&
        this.latestSnapshot &&
        this.lockedAttemptId !== this.latestSnapshot.attemptId &&
        this.debounceTimer === null &&
        this.retryTimer === null
      ) {
        this.scheduleDebounce(Date.now());
      }
    });

    this.inFlightPromise = promise;
    return promise;
  }

  /**
   * Cancels timers, awaits any active in-flight save, and synchronously flushes
   * the latest dirty snapshot before exam submission.
   */
  public async flush(attemptId?: string): Promise<boolean> {
    this.clearTimers();

    if (this.inFlightPromise) {
      await this.inFlightPromise;
      this.clearTimers();
    }

    if (!this.dirty || !this.latestSnapshot) {
      return true;
    }

    if (attemptId && this.latestSnapshot.attemptId !== attemptId) {
      return true;
    }

    if (this.lockedAttemptId && this.lockedAttemptId === this.latestSnapshot.attemptId) {
      return false;
    }

    const ok = await this.dispatchSave();
    // If another mutation arrived during flush, wait one more pass cleanly
    if (this.dirty && !this.lockedAttemptId && (!attemptId || this.latestSnapshot?.attemptId === attemptId)) {
      this.clearTimers();
      return this.dispatchSave();
    }
    return ok;
  }

  public markSubmitted(attemptId: string): void {
    this.lockedAttemptId = attemptId;
    if (this.latestSnapshot?.attemptId === attemptId) {
      this.dirty = false;
      this.firstDirtyAtMs = null;
    }
    this.clearTimers();
  }

  public hasPendingChanges(): boolean {
    return this.dirty || this.inFlightPromise !== null;
  }

  public reset(): void {
    this.clearTimers();
    this.latestSnapshot = null;
    this.dirty = false;
    this.firstDirtyAtMs = null;
    this.retryCount = 0;
    this.lockedAttemptId = null;
  }
}

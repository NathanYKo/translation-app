// metrics/index.ts — MetricsCollector: public API with batched writes

import { openDb, getDb, isDbAvailable, getTodaySnapshot, insertSession, updateSessionEnd, insertTurn, insertApiCall, recomputeDailyAggregate } from './db.js';
import { hashSessionId, sanitizeUA, sanitizeError } from './anonymize.js';
import { estimateTranslateCost, estimateTtsCost, estimateSttCost } from './cost.js';
import type { ApiCallRecord, TurnRecord, SessionRecord, MetricsSnapshot, BrowserTimingEvent } from './types.js';

export type { MetricsSnapshot, BrowserTimingEvent, TurnRecord, ApiCallRecord };

/**
 * MetricsCollector — batched, anonymized metrics for the translator.
 *
 * Usage:
 *   const metrics = new MetricsCollector();
 *   metrics.recordApiCall({ provider: 'openrouter', operation: 'translate', ... });
 *   console.log(metrics.snapshot());
 */
export class MetricsCollector {
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private turnQueue: TurnRecord[] = [];
  private apiCallQueue: ApiCallRecord[] = [];
  private sessionCache = new Map<string, SessionRecord>();
  private _turnCounter = 0;
  private _sessionCounter = 0;

  constructor() {
    try {
      openDb();
      console.log('[metrics] SQLite ready at data/metrics.db');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[metrics] SQLite unavailable, metrics disabled:', msg);
    }
    // Flush every 5 seconds
    this.flushTimer = setInterval(() => this.flush(), 5000);
  }

  /** Record an API call (translate, TTS, STT). Safe to call on hot path. */
  recordApiCall(params: {
    provider: 'openrouter' | 'elevenlabs' | 'deepgram';
    operation: 'translate' | 'tts' | 'stt' | 'stt_streaming';
    success: boolean;
    latencyMs: number;
    inputChars: number;
    outputChars: number;
    audioSeconds: number;
    audioBytes: number;
    errorType: string | null;
    errorDetail: string | null;
  }): void {
    const cost = this.estimateCost(params);
    const record: ApiCallRecord = {
      provider: params.provider,
      operation: params.operation,
      success: params.success,
      latencyMs: params.latencyMs,
      inputChars: params.inputChars,
      outputChars: params.outputChars,
      audioSeconds: params.audioSeconds,
      audioBytes: params.audioBytes,
      estimatedCostUsd: cost,
      errorType: sanitizeError(params.errorType),
      errorDetail: sanitizeError(params.errorDetail),
      timestamp: Date.now(),
    };
    this.apiCallQueue.push(record);
  }

  /** Record a full turn (called from browser-sent events or server-computed). */
  recordTurn(turn: TurnRecord): void {
    // Extend session
    const existing = this.sessionCache.get(turn.sessionId);
    if (existing) {
      existing.turnCount = Math.max(existing.turnCount, turn.turnNumber);
      existing.userAgent = turn.sourceLang === 'en' ? 'en' : 'zh'; // not ideal
    }
    this.turnQueue.push(turn);
    this._turnCounter++;
  }

  /** Begin a new session. Returns the anonymized session ID. */
  beginSession(ip: string, ua: string | undefined, lang: 'en' | 'zh'): string {
    const id = hashSessionId(ip, Date.now());
    const session: SessionRecord = {
      id,
      startedAt: Date.now(),
      endedAt: null,
      turnCount: 0,
      langFirst: lang,
      userAgent: sanitizeUA(ua),
    };
    this.sessionCache.set(id, session);
    this._sessionCounter++;
    // Insert immediately so the session is visible
    try { insertSession(session); } catch { /* best effort */ }
    return id;
  }

  /** End a session. */
  endSession(id: string): void {
    const session = this.sessionCache.get(id);
    if (session) {
      session.endedAt = Date.now();
      try { updateSessionEnd(id, session.endedAt, session.turnCount); } catch { /* best effort */ }
      this.sessionCache.delete(id);
    }
  }

  /** Get current metrics snapshot (aggregated from DB). */
  snapshot(): MetricsSnapshot {
    try {
      return getTodaySnapshot();
    } catch {
      return {
        uptimeHours: process.uptime() / 3600,
        metricsOk: false,
        sessionsToday: 0,
        turnsToday: 0,
        enToZh: 0,
        zhToEn: 0,
        errorsToday: 0,
        errorRatePct: 0,
        avgLatencyMs: { stt: 0, translate: 0, tts: 0, e2e: 0 },
        costTodayEstimatedUsd: 0,
        streamingTtsPct: 0,
        fallbackPct: 0,
        activeSessions: this.sessionCache.size,
        topErrors: [],
      };
    }
  }

  /** Flush queued records to SQLite. Called automatically every 5s. */
  flush(): void {
    if (!isDbAvailable()) return;

    const turns = this.turnQueue.splice(0);
    const calls = this.apiCallQueue.splice(0);

    const db = getDb();
    const transaction = db.transaction(() => {
      for (const turn of turns) {
        try { insertTurn(turn); } catch { /* skip corrupted turn */ }
      }
      for (const call of calls) {
        try { insertApiCall(call); } catch { /* skip corrupted call */ }
      }
    });

    try { transaction(); } catch { /* best effort */ }
  }

  /** Graceful shutdown. */
  shutdown(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush(); // final flush
  }

  get turnCount(): number { return this._turnCounter; }
  get sessionCount(): number { return this._sessionCounter; }

  /** Compute estimated cost from API call parameters */
  private estimateCost(params: {
    provider: string;
    operation: string;
    inputChars: number;
    outputChars: number;
    audioSeconds: number;
  }): number {
    switch (params.operation) {
      case 'translate':
        return estimateTranslateCost(params.inputChars, params.outputChars);
      case 'tts':
        return estimateTtsCost(params.outputChars);
      case 'stt':
      case 'stt_streaming':
        return estimateSttCost(params.audioSeconds);
      default:
        return 0;
    }
  }
}
// metrics/types.ts — Shared interfaces for the metrics & analytics layer

/** A single API call record (server-side instrumentation) */
export interface ApiCallRecord {
  provider: 'openrouter' | 'elevenlabs' | 'deepgram';
  operation: 'translate' | 'tts' | 'stt' | 'stt_streaming';
  success: boolean;
  latencyMs: number;
  inputChars: number;
  outputChars: number;
  audioSeconds: number;
  audioBytes: number;
  estimatedCostUsd: number;
  errorType: string | null;
  errorDetail: string | null; // sanitized (status code or category only)
  timestamp: number; // Unix ms
}

/** A single turn record (browser-side timing) */
export interface TurnRecord {
  sessionId: string;
  sourceLang: 'en' | 'zh';
  targetLang: 'en' | 'zh';
  turnNumber: number;
  transcriptLen: number;
  translationLen: number;
  sttLatencyMs: number;
  translateLatencyMs: number;
  ttsLatencyMs: number;
  e2eLatencyMs: number;
  ttsMode: 'streaming' | 'batch' | 'browser';
  audioBytes: number;
  speechDurationMs: number;
  fallback: boolean;
  sttOk: boolean;
  translateOk: boolean;
  ttsOk: boolean;
  sttError: string | null;
  translateError: string | null;
  ttsError: string | null;
  timestamp: number; // Unix ms
}

/** A session record */
export interface SessionRecord {
  id: string; // anonymized hash
  startedAt: number;
  endedAt: number | null;
  turnCount: number;
  langFirst: 'en' | 'zh';
  userAgent: string; // browser family only
}

/** Daily aggregate */
export interface DailyAggregate {
  date: string; // YYYY-MM-DD
  sessions: number;
  turns: number;
  enToZh: number;
  zhToEn: number;
  errorsTotal: number;
  avgSttLatencyMs: number;
  avgTranslateLatencyMs: number;
  avgTtsLatencyMs: number;
  avgE2eLatencyMs: number;
  totalCostEstimatedUsd: number;
  streamingTtsPct: number;
  fallbackPct: number;
}

/** Snapshot returned by GET /api/metrics */
export interface MetricsSnapshot {
  uptimeHours: number;
  metricsOk: boolean;
  sessionsToday: number;
  turnsToday: number;
  enToZh: number;
  zhToEn: number;
  errorsToday: number;
  errorRatePct: number;
  avgLatencyMs: {
    stt: number;
    translate: number;
    tts: number;
    e2e: number;
  };
  costTodayEstimatedUsd: number;
  streamingTtsPct: number;
  fallbackPct: number;
  activeSessions: number;
  topErrors: Array<{ type: string; count: number }>;
}

/** Browser-sent timing event */
export interface BrowserTimingEvent {
  sessionId: string;
  marks: {
    turn_start?: number;
    stt_received?: number;
    translate_sent?: number;
    translate_received?: number;
    tts_sent?: number;
    tts_played?: number;
    turn_complete?: number;
  };
  sourceLang: 'en' | 'zh';
  targetLang: 'en' | 'zh';
  transcriptLen: number;
  translationLen: number;
  ttsMode: 'streaming' | 'batch' | 'browser';
  blobSize: number;
  speechDurationMs?: number;
  error: string | null;
  fallback: boolean;
}

/** Pricing configuration */
export interface PricingConfig {
  openrouter: {
    inputPer1KTokens: number;
    outputPer1KTokens: number;
    model: string;
  };
  elevenlabs: {
    perChar: number;
  };
  deepgram: {
    perMinute: number;
  };
}
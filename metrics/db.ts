// metrics/db.ts — SQLite database layer for metrics & analytics

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import type {
  ApiCallRecord,
  TurnRecord,
  SessionRecord,
  DailyAggregate,
  MetricsSnapshot,
} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DB_DIR, 'metrics.db');

let _db: Database.Database | null = null;

/** Open (or create) the metrics database and run migrations. */
export function openDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  runMigrations(_db);
  return _db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
  `);
  const currentVersion = (db.prepare('SELECT MAX(version) FROM schema_version').pluck().get() as number) || 0;

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        turn_count  INTEGER DEFAULT 0,
        lang_first  TEXT,
        user_agent  TEXT
      );
      CREATE TABLE IF NOT EXISTS turns (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id         TEXT NOT NULL,
        turn_number        INTEGER NOT NULL,
        source_lang        TEXT NOT NULL,
        target_lang        TEXT NOT NULL,
        transcript_len     INTEGER DEFAULT 0,
        translation_len    INTEGER DEFAULT 0,
        stt_latency_ms     INTEGER,
        translate_latency_ms INTEGER,
        tts_latency_ms     INTEGER,
        e2e_latency_ms     INTEGER,
        tts_mode           TEXT,
        stt_ok             INTEGER DEFAULT 1,
        translate_ok       INTEGER DEFAULT 1,
        tts_ok             INTEGER DEFAULT 1,
        stt_error          TEXT,
        translate_error    TEXT,
        tts_error          TEXT,
        audio_bytes        INTEGER DEFAULT 0,
        speech_duration_ms INTEGER DEFAULT 0,
        fallback           INTEGER DEFAULT 0,
        created_at         INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_calls (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        provider          TEXT NOT NULL,
        operation         TEXT NOT NULL,
        success           INTEGER NOT NULL,
        latency_ms        INTEGER,
        input_chars       INTEGER DEFAULT 0,
        output_chars      INTEGER DEFAULT 0,
        audio_seconds     REAL DEFAULT 0,
        audio_bytes       INTEGER DEFAULT 0,
        estimated_cost_usd REAL DEFAULT 0,
        error_type        TEXT,
        error_detail      TEXT,
        created_at        INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_aggregates (
        date                     TEXT PRIMARY KEY,
        sessions                 INTEGER DEFAULT 0,
        turns                    INTEGER DEFAULT 0,
        en_to_zh                 INTEGER DEFAULT 0,
        zh_to_en                 INTEGER DEFAULT 0,
        errors_total             INTEGER DEFAULT 0,
        avg_stt_latency_ms       REAL DEFAULT 0,
        avg_translate_latency_ms REAL DEFAULT 0,
        avg_tts_latency_ms       REAL DEFAULT 0,
        avg_e2e_latency_ms       REAL DEFAULT 0,
        total_cost_estimated_usd REAL DEFAULT 0,
        streaming_tts_pct        REAL DEFAULT 0,
        fallback_pct             REAL DEFAULT 0,
        updated_at               INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_api_calls_created ON api_calls(created_at);
      CREATE INDEX IF NOT EXISTS idx_turns_created ON turns(created_at);
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
      INSERT INTO schema_version (version) VALUES (1);
    `);
    console.log('[metrics] DB migrated to version 1');
  }
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('Database not opened. Call openDb() first.');
  return _db;
}

export function isDbAvailable(): boolean {
  return _db !== null && _db.open;
}

// ── Prepared statements (cached) ──────────────────────────────────────────

let _insertSession: Database.Statement | null = null;
let _updateSessionEnd: Database.Statement | null = null;
let _insertTurn: Database.Statement | null = null;
let _insertApiCall: Database.Statement | null = null;
let _upsertDaily: Database.Statement | null = null;

function prepared() {
  const db = getDb();
  if (!_insertSession) {
    _insertSession = db.prepare(`
      INSERT OR REPLACE INTO sessions (id, started_at, ended_at, turn_count, lang_first, user_agent)
      VALUES (@id, @startedAt, @endedAt, @turnCount, @langFirst, @userAgent)
    `);
  }
  if (!_updateSessionEnd) {
    _updateSessionEnd = db.prepare(`UPDATE sessions SET ended_at = ?, turn_count = ? WHERE id = ?`);
  }
  if (!_insertTurn) {
    _insertTurn = db.prepare(`
      INSERT INTO turns (session_id, turn_number, source_lang, target_lang,
        transcript_len, translation_len,
        stt_latency_ms, translate_latency_ms, tts_latency_ms, e2e_latency_ms,
        tts_mode, stt_ok, translate_ok, tts_ok,
        stt_error, translate_error, tts_error,
        audio_bytes, speech_duration_ms, fallback, created_at)
      VALUES (@sessionId, @turnNumber, @sourceLang, @targetLang,
        @transcriptLen, @translationLen,
        @sttLatencyMs, @translateLatencyMs, @ttsLatencyMs, @e2eLatencyMs,
        @ttsMode, @sttOk, @translateOk, @ttsOk,
        @sttError, @translateError, @ttsError,
        @audioBytes, @speechDurationMs, @fallback, @timestamp)
    `);
  }
  if (!_insertApiCall) {
    _insertApiCall = db.prepare(`
      INSERT INTO api_calls (provider, operation, success, latency_ms,
        input_chars, output_chars, audio_seconds, audio_bytes,
        estimated_cost_usd, error_type, error_detail, created_at)
      VALUES (@provider, @operation, @success, @latencyMs,
        @inputChars, @outputChars, @audioSeconds, @audioBytes,
        @estimatedCostUsd, @errorType, @errorDetail, @timestamp)
    `);
  }
  if (!_upsertDaily) {
    _upsertDaily = db.prepare(`
      INSERT INTO daily_aggregates (date, sessions, turns, en_to_zh, zh_to_en,
        errors_total, avg_stt_latency_ms, avg_translate_latency_ms,
        avg_tts_latency_ms, avg_e2e_latency_ms,
        total_cost_estimated_usd, streaming_tts_pct, fallback_pct, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        sessions = excluded.sessions, turns = excluded.turns,
        en_to_zh = excluded.en_to_zh, zh_to_en = excluded.zh_to_en,
        errors_total = excluded.errors_total,
        avg_stt_latency_ms = excluded.avg_stt_latency_ms,
        avg_translate_latency_ms = excluded.avg_translate_latency_ms,
        avg_tts_latency_ms = excluded.avg_tts_latency_ms,
        avg_e2e_latency_ms = excluded.avg_e2e_latency_ms,
        total_cost_estimated_usd = excluded.total_cost_estimated_usd,
        streaming_tts_pct = excluded.streaming_tts_pct,
        fallback_pct = excluded.fallback_pct,
        updated_at = excluded.updated_at
    `);
  }
  return { insertSession: _insertSession!, updateSessionEnd: _updateSessionEnd!, insertTurn: _insertTurn!, insertApiCall: _insertApiCall!, upsertDaily: _upsertDaily! };
}

// ── Public insert helpers ──────────────────────────────────────────────────

export function insertSession(session: SessionRecord): void {
  prepared().insertSession.run({
    id: session.id, startedAt: session.startedAt, endedAt: session.endedAt,
    turnCount: session.turnCount, langFirst: session.langFirst, userAgent: session.userAgent,
  });
}

export function updateSessionEnd(id: string, endedAt: number, turnCount: number): void {
  prepared().updateSessionEnd.run(endedAt, turnCount, id);
}

export function insertTurn(turn: TurnRecord): void {
  prepared().insertTurn.run({
    ...turn,
    sttOk: turn.sttOk ? 1 : 0,
    translateOk: turn.translateOk ? 1 : 0,
    ttsOk: turn.ttsOk ? 1 : 0,
    fallback: turn.fallback ? 1 : 0,
  });
}

export function insertApiCall(call: ApiCallRecord): void {
  prepared().insertApiCall.run({
    ...call,
    success: call.success ? 1 : 0,
    estimatedCostUsd: Number(call.estimatedCostUsd) || 0,
  });
}

export function upsertDaily(agg: DailyAggregate): void {
  prepared().upsertDaily.run(
    agg.date, agg.sessions, agg.turns, agg.enToZh, agg.zhToEn,
    agg.errorsTotal, agg.avgSttLatencyMs, agg.avgTranslateLatencyMs,
    agg.avgTtsLatencyMs, agg.avgE2eLatencyMs,
    agg.totalCostEstimatedUsd, agg.streamingTtsPct, agg.fallbackPct,
    Date.now(),
  );
}

// ── Aggregation queries ───────────────────────────────────────────────────

export function getTodaySnapshot(): MetricsSnapshot {
  const db = getDb();
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const dayEnd = dayStart + 86400000;

  const sessionsToday = (db.prepare(`SELECT COUNT(*) FROM sessions WHERE started_at >= ? AND started_at < ?`).pluck().get(dayStart, dayEnd) as number) || 0;
  const turnsToday = (db.prepare(`SELECT COUNT(*) FROM turns WHERE created_at >= ? AND created_at < ?`).pluck().get(dayStart, dayEnd) as number) || 0;
  const enToZh = (db.prepare(`SELECT COUNT(*) FROM turns WHERE source_lang = 'en' AND target_lang = 'zh' AND created_at >= ?`).pluck().get(dayStart) as number) || 0;
  const zhToEn = (db.prepare(`SELECT COUNT(*) FROM turns WHERE source_lang = 'zh' AND target_lang = 'en' AND created_at >= ?`).pluck().get(dayStart) as number) || 0;
  const errorsToday = (db.prepare(`SELECT COUNT(*) FROM turns WHERE (stt_ok = 0 OR translate_ok = 0 OR tts_ok = 0) AND created_at >= ?`).pluck().get(dayStart) as number) || 0;
  const errorRatePct = turnsToday > 0 ? (errorsToday / turnsToday) * 100 : 0;
  const avgStt = (db.prepare(`SELECT COALESCE(AVG(stt_latency_ms), 0) FROM turns WHERE created_at >= ? AND stt_latency_ms IS NOT NULL`).pluck().get(dayStart) as number);
  const avgTrans = (db.prepare(`SELECT COALESCE(AVG(translate_latency_ms), 0) FROM turns WHERE created_at >= ? AND translate_latency_ms IS NOT NULL`).pluck().get(dayStart) as number);
  const avgTts = (db.prepare(`SELECT COALESCE(AVG(tts_latency_ms), 0) FROM turns WHERE created_at >= ? AND tts_latency_ms IS NOT NULL`).pluck().get(dayStart) as number);
  const avgE2e = (db.prepare(`SELECT COALESCE(AVG(e2e_latency_ms), 0) FROM turns WHERE created_at >= ? AND e2e_latency_ms IS NOT NULL`).pluck().get(dayStart) as number);
  const totalCost = (db.prepare(`SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM api_calls WHERE created_at >= ?`).pluck().get(dayStart) as number);
  const streamingTtsCount = (db.prepare(`SELECT COUNT(*) FROM turns WHERE tts_mode = 'streaming' AND created_at >= ?`).pluck().get(dayStart) as number) || 0;
  const streamingTtsPct = turnsToday > 0 ? (streamingTtsCount / turnsToday) * 100 : 0;
  const fallbackCount = (db.prepare(`SELECT COUNT(*) FROM turns WHERE fallback = 1 AND created_at >= ?`).pluck().get(dayStart) as number) || 0;
  const fallbackPct = turnsToday > 0 ? (fallbackCount / turnsToday) * 100 : 0;
  const activeSessions = (db.prepare(`SELECT COUNT(*) FROM sessions WHERE ended_at IS NULL`).pluck().get() as number) || 0;
  const topErrorsRaw = db.prepare(`SELECT error_type as type, COUNT(*) as count FROM api_calls WHERE success = 0 AND created_at >= ? GROUP BY error_type ORDER BY count DESC LIMIT 5`).all(dayStart) as Array<{ type: string; count: number }>;

  return {
    uptimeHours: process.uptime() / 3600,
    metricsOk: isDbAvailable(),
    sessionsToday, turnsToday, enToZh, zhToEn,
    errorsToday,
    errorRatePct: Math.round(errorRatePct * 100) / 100,
    avgLatencyMs: {
      stt: Math.round(avgStt),
      translate: Math.round(avgTrans),
      tts: Math.round(avgTts),
      e2e: Math.round(avgE2e),
    },
    costTodayEstimatedUsd: Math.round(totalCost * 100000) / 100000,
    streamingTtsPct: Math.round(streamingTtsPct * 10) / 10,
    fallbackPct: Math.round(fallbackPct * 10) / 10,
    activeSessions,
    topErrors: topErrorsRaw.map((e) => ({ type: e.type, count: e.count })),
  };
}

/** Rebuild daily_aggregates from raw data (call periodically or on-demand) */
export function recomputeDailyAggregate(dateStr?: string): void {
  const date = dateStr || new Date().toISOString().slice(0, 10);
  const dayStart = new Date(date + 'T00:00:00Z').getTime();
  const dayEnd = dayStart + 86400000;
  const db = getDb();

  const sessions = (db.prepare(`SELECT COUNT(*) FROM sessions WHERE started_at >= ? AND started_at < ?`).pluck().get(dayStart, dayEnd) as number) || 0;
  const turns = (db.prepare(`SELECT COUNT(*) FROM turns WHERE created_at >= ? AND created_at < ?`).pluck().get(dayStart, dayEnd) as number) || 0;
  const enToZh = (db.prepare(`SELECT COUNT(*) FROM turns WHERE source_lang = 'en' AND target_lang = 'zh' AND created_at >= ? AND created_at < ?`).pluck().get(dayStart, dayEnd) as number) || 0;
  const zhToEn = (db.prepare(`SELECT COUNT(*) FROM turns WHERE source_lang = 'zh' AND target_lang = 'en' AND created_at >= ? AND created_at < ?`).pluck().get(dayStart, dayEnd) as number) || 0;
  const errorsTotal = (db.prepare(`SELECT COUNT(*) FROM turns WHERE (stt_ok = 0 OR translate_ok = 0 OR tts_ok = 0) AND created_at >= ? AND created_at < ?`).pluck().get(dayStart, dayEnd) as number) || 0;
  const avgStt = (db.prepare(`SELECT COALESCE(AVG(stt_latency_ms), 0) FROM turns WHERE created_at >= ? AND created_at < ? AND stt_latency_ms IS NOT NULL`).pluck().get(dayStart, dayEnd) as number);
  const avgTrans = (db.prepare(`SELECT COALESCE(AVG(translate_latency_ms), 0) FROM turns WHERE created_at >= ? AND created_at < ? AND translate_latency_ms IS NOT NULL`).pluck().get(dayStart, dayEnd) as number);
  const avgTts = (db.prepare(`SELECT COALESCE(AVG(tts_latency_ms), 0) FROM turns WHERE created_at >= ? AND created_at < ? AND tts_latency_ms IS NOT NULL`).pluck().get(dayStart, dayEnd) as number);
  const avgE2e = (db.prepare(`SELECT COALESCE(AVG(e2e_latency_ms), 0) FROM turns WHERE created_at >= ? AND created_at < ? AND e2e_latency_ms IS NOT NULL`).pluck().get(dayStart, dayEnd) as number);
  const totalCost = (db.prepare(`SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM api_calls WHERE created_at >= ? AND created_at < ?`).pluck().get(dayStart, dayEnd) as number);
  const streamingCount = (db.prepare(`SELECT COUNT(*) FROM turns WHERE tts_mode = 'streaming' AND created_at >= ? AND created_at < ?`).pluck().get(dayStart, dayEnd) as number) || 0;
  const fallbackCount = (db.prepare(`SELECT COUNT(*) FROM turns WHERE fallback = 1 AND created_at >= ? AND created_at < ?`).pluck().get(dayStart, dayEnd) as number) || 0;

  upsertDaily({
    date, sessions, turns, enToZh, zhToEn,
    errorsTotal,
    avgSttLatencyMs: Math.round(avgStt),
    avgTranslateLatencyMs: Math.round(avgTrans),
    avgTtsLatencyMs: Math.round(avgTts),
    avgE2eLatencyMs: Math.round(avgE2e),
    totalCostEstimatedUsd: totalCost,
    streamingTtsPct: turns > 0 ? Math.round((streamingCount / turns) * 1000) / 10 : 0,
    fallbackPct: turns > 0 ? Math.round((fallbackCount / turns) * 1000) / 10 : 0,
  });
}

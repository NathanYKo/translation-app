# Metrics & Analytics Plan — Realtime EN↔ZH Translator

## Overview

Add a **zero-dependency metrics & analytics layer** to the existing translation app, with:
- **SQLite** persistence (via `better-sqlite3`)
- **TypeScript** for the metrics module (compiled to JS, no build-step for the app itself)
- **Full anonymization** (no PII, no transcripts, no IPs)
- **Cost estimation** per API call
- **Live dashboard** at `/admin/monitor`

---

## Architecture

```
┌──────────────────────┐     ┌───────────────────────────────────────────────┐
│ Browser (app.js)     │ ──→ │  Server (server.js)                          │
│ • performance.mark() │ ──→ │  ┌─────────────────────────────────────────┐ │
│ • turn timings       │     │  │  metrics.ts (compiled → metrics.js)     │ │
│ • VAD stats          │     │  │  • MetricsCollector class               │ │
│ • send to /api/metrics/event │  │  • SQLite via better-sqlite3        │ │
│                      │     │  │  • Cost estimator                      │ │
│                      │     │  │  • Anonymizer                          │ │
│                      │     │  └─────────────────────────────────────────┘ │
│                      │     │  GET /api/metrics       → JSON snapshot     │
│                      │     │  POST /api/metrics/event → browser timings │
│                      │     │  GET /admin/monitor     → dashboard HTML   │
└──────────────────────┘     └───────────────────────────────────────────────┘
```

---

## Dependencies Added

| Package | Why |
|---|---|
| `better-sqlite3` | Zero-config SQLite, synchronous API, fast, no server process |
| `typescript` (dev) | Type-safe metrics module |
| `@types/node` (dev) | Node types |
| `@types/better-sqlite3` (dev) | SQLite types |

All installed as local deps. The app still starts with `npm start` (now `tsc && node server.js`).

---

## SQLite Schema

```sql
-- Core analytics database (metrics.db, in project root)

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,          -- hash(salt + IP + timestamp), anonymized
  started_at  INTEGER NOT NULL,          -- Unix ms
  ended_at    INTEGER,
  turn_count  INTEGER DEFAULT 0,
  lang_first  TEXT,                      -- 'en' or 'zh'
  user_agent  TEXT                       -- browser family only (e.g. 'Chrome')
);

CREATE TABLE turns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  turn_number       INTEGER NOT NULL,
  source_lang       TEXT NOT NULL,       -- detected source language
  target_lang       TEXT NOT NULL,       -- translated to
  transcript_len    INTEGER,             -- char count
  translation_len   INTEGER,             -- char count
  stt_latency_ms    INTEGER,             -- speech end → transcript
  translate_latency_ms INTEGER,          -- request → response
  tts_latency_ms    INTEGER,             -- request → audio start
  e2e_latency_ms    INTEGER,             -- speech end → audio start
  tts_mode          TEXT,                -- 'streaming' | 'batch' | 'browser'
  stt_ok            INTEGER DEFAULT 1,
  translate_ok      INTEGER DEFAULT 1,
  tts_ok            INTEGER DEFAULT 1,
  stt_error         TEXT,
  translate_error   TEXT,
  tts_error         TEXT,
  audio_bytes       INTEGER,             -- TTS MP3 size
  speech_duration_ms INTEGER,            -- how long user spoke (VAD)
  fallback          INTEGER DEFAULT 0,   -- fell back to browser TTS?
  created_at        INTEGER NOT NULL
);

CREATE TABLE api_calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  provider          TEXT NOT NULL,        -- 'openrouter' | 'elevenlabs' | 'deepgram'
  operation         TEXT NOT NULL,        -- 'translate' | 'tts' | 'stt'
  success           INTEGER NOT NULL,
  latency_ms        INTEGER,
  input_chars       INTEGER,
  output_chars      INTEGER,
  audio_seconds     REAL,                 -- Deepgram: audio duration
  audio_bytes       INTEGER,
  estimated_cost_usd REAL,
  error_type        TEXT,                 -- 'timeout' | 'auth' | 'rate_limit' | 'server_error' | 'network'
  error_detail     TEXT,                 -- truncated, no PII
  created_at        INTEGER NOT NULL
);

CREATE TABLE daily_aggregates (
  date                    TEXT PRIMARY KEY,  -- 'YYYY-MM-DD'
  sessions                INTEGER DEFAULT 0,
  turns                   INTEGER DEFAULT 0,
  en_to_zh                INTEGER DEFAULT 0,
  zh_to_en                INTEGER DEFAULT 0,
  errors_total            INTEGER DEFAULT 0,
  avg_stt_latency_ms      REAL DEFAULT 0,
  avg_translate_latency_ms REAL DEFAULT 0,
  avg_tts_latency_ms      REAL DEFAULT 0,
  avg_e2e_latency_ms      REAL DEFAULT 0,
  total_cost_estimated_usd REAL DEFAULT 0,
  streaming_tts_pct       REAL DEFAULT 0,
  fallback_pct            REAL DEFAULT 0,
  updated_at              INTEGER NOT NULL
);
```

---

## Anonymization Strategy

### What we DO NOT store
- ❌ IP addresses
- ❌ Transcripts / translations (the actual spoken/text content)
- ❌ Raw session IDs tied to identity
- ❌ User agent strings (only browser family: `Chrome`, `Edge`, etc.)
- ❌ Any form of PII

### What we store
- ✅ Anonymized session ID: `SHA256(salt + IP + start_timestamp)` → truncated to 16 hex chars
- ✅ Language direction (EN→ZH vs ZH→EN)
- ✅ Latency numbers (ms)
- ✅ Character counts (proxy for cost)
- ✅ Error types (not messages with content)
- ✅ Boolean flags (success, fallback used)
- ✅ Browser family (extracted from UA header: `Chrome`, `Edge`, `Firefox`, `Other`)
- ✅ Timestamps (bucketed to minute granularity in reporting)

### Implementation
- Salt rotated on server restart
- `anonymize(ip, timestamp)` function produces stable-but-anonymous session ID
- No transcript text ever reaches the DB — even errors are categorized by type, not content

---

## Cost Estimation

Pricing (hardcoded as constants, updateable via env):

| Provider | Pricing basis | Rate (example) |
|---|---|---|
| **OpenRouter** (gemini-2.5-flash) | Per-token (chars ÷ 4) | ~$0.15/1M input, $0.60/1M output (or model-specific) |
| **ElevenLabs** (standard TTS) | Per-character | ~$0.30/1K chars (varies by plan/voice) |
| **Deepgram** (nova-2) | Per-audio-minute | ~$0.0059/minute (usage-based) |

```typescript
const PRICING: Record<string, PricingTier> = {
  openrouter: {
    model: 'google/gemini-2.5-flash',
    inputPer1KTokens: 0.00015,
    outputPer1KTokens: 0.00060,
  },
  elevenlabs: {
    perChar: 0.00030,  // $0.30/1K chars — standard tier
  },
  deepgram: {
    perMinute: 0.0059, // nova-2
  },
};

function estimateTranslateCost(inputChars: number, outputChars: number): number {
  const inputTokens = inputChars / 4;
  const outputTokens = outputChars / 4;
  return (inputTokens * PRICING.openrouter.inputPer1KTokens / 1000)
       + (outputTokens * PRICING.openrouter.outputPer1KTokens / 1000);
}
```

Costs are **estimated** (not billed). Good enough for burn-rate awareness. Configurable via env vars `OPENROUTER_PRICE_PER_1K_INPUT`, etc.

---

## TypeScript Module Structure

```
metrics/
├── index.ts          — public API, MetricsCollector class
├── db.ts             — SQLite schema, connection, migrations
├── cost.ts           — Pricing constants and estimators
├── anonymize.ts      — Anonymization helpers
├── types.ts          — Shared interfaces
└── tsconfig.json     — Compiled to metrics/dist/
```

Compiled to `metrics/dist/` and imported by `server.js`:
```js
import { MetricsCollector } from './metrics/dist/index.js';
```

---

## New Server Endpoints

### `POST /api/metrics/event`
- **From browser** (via `navigator.sendBeacon`): timing marks, blob sizes, lang, tts_mode
- **Body**: `{ sessionId, marks: { turn_start, stt_received, translate_sent, translate_received, tts_sent, tts_played, turn_complete }, lang, blobSize, transcriptLen, translationLen, ttsMode, error? }`
- **Response**: `204 No Content`
- Anonymized and stored in SQLite

### `GET /api/metrics`
- **Response**: JSON snapshot of current stats
```json
{
  "uptime_hours": 12.3,
  "sessions_today": 47,
  "turns_today": 312,
  "en_to_zh": 158,
  "zh_to_en": 154,
  "errors_today": 3,
  "error_rate_pct": 0.96,
  "avg_latency_ms": { "stt": 420, "translate": 680, "tts": 310, "e2e": 1650 },
  "cost_today_estimated_usd": 0.42,
  "streaming_tts_pct": 72,
  "fallback_pct": 5,
  "active_sessions": 1,
  "top_errors": [{"type": "auth", "count": 2}]
}
```

### `GET /admin/monitor`
- HTML dashboard page (served as static file or inline)
- Polls `/api/metrics` every 5 seconds
- Dark theme matching the main app
- Displays: live counters, latency sparklines, cost gauge, error rate, language pie

---

## Browser Instrumentation (`public/app.js` additions)

```js
// After turn starts:
const marks = { turn_start: performance.now() };

// After STT returns a transcript:
marks.stt_received = performance.now();

// After /translate responds:
marks.translate_received = performance.now();

// After /tts-stream starts playing:
marks.tts_played = performance.now();

// After turn completes (started listening again):
marks.turn_complete = performance.now();

// Send to server (non-blocking, fire-and-forget):
navigator.sendBeacon('/api/metrics/event', JSON.stringify({
  sessionId: window.__sessionId,
  marks,
  sourceLang: expectLang,
  targetLang: expectLang === 'en' ? 'zh' : 'en',
  transcriptLen,
  translationLen,
  ttsMode: currentTtsMode,  // 'streaming' | 'batch' | 'browser'
  blobSize,
  error: errorOccurred ? errorType : null,
}));
```

Also:
- Attach a `__sessionId` to `window` (generated once, passed with every event)
- Track which TTS mode was actually used (streaming success, fallback to batch, fallback to browser)

---

## Implementation Phases

### Phase 1 — Foundation (recommended starting point)
- [ ] Install deps: `better-sqlite3`, `typescript`, `@types/node`, `@types/better-sqlite3`
- [ ] Create `metrics/` TS module with schema, migrations, insert/query helpers
- [ ] Add `MetricsCollector` class wrapping all DB operations
- [ ] Wire into `server.js`: record API calls (translate, tts, stt) with timings, success/fail
- [ ] `GET /api/metrics` endpoint
- [ ] Anonymization: session ID hashing, UA stripping, no transcript logging
- [ ] Cost estimation on each API call insert

### Phase 2 — Browser instrumentation
- [ ] Add `performance.mark()` and `performance.measure()` in `app.js`
- [ ] Send turn events to `POST /api/metrics/event`
- [ ] Track TTS mode (streaming/batch/browser fallback)
- [ ] Window leak: expose `__sessionId` for correlation

### Phase 3 — Dashboard
- [ ] `GET /admin/monitor` HTML page
- [ ] Auto-refresh from `/api/metrics`
- [ ] Visual counters, latency, cost gauge, error rate, language ratio

### Phase 4 — Aggregation & daily rollups
- [ ] On-insert trigger for `daily_aggregates` (or periodic `INSERT OR REPLACE`)
- [ ] Cleanup old raw data (configurable retention, default 30 days)

---

## Key Design Decisions

1. **SQLite via better-sqlite3** — synchronous API removes callback complexity; fast enough for local dev/light usage; zero-config (just a file)
2. **TypeScript only for metrics module** — the app server stays plain JS; the metrics module is small, well-bounded, and benefits most from type safety
3. **Anonymization at collection point** — PII never enters the DB, not post-processed
4. **Cost is estimated, not billed** — uses public pricing; good for relative comparisons
5. **Dashboard is a simple HTML page** — no framework, matches the app's no-dep ethos
6. **Graceful degradation** — if SQLite DB is unwritable, metrics are silently dropped (app keeps working)

---

## Open Questions for Advisor

1. **Should we keep zero deps for the app and use `sql.js` (pure JS, no native compile) instead of `better-sqlite3`?** sql.js is larger but doesn't need native compilation.
2. **TypeScript scope** — just the metrics module, or convert the whole server.ts?
3. **Dashboard complexity** — simple auto-refresh counters, or add Chart.js (CDN) for real sparklines?
4. **Cost accuracy** — should we expose pricing via env vars, or keep them as hardcoded constants?
5. **Privacy** — any additional anonymization needed beyond IP/UA/transcript stripping?
6. **Error categorization** — how fine-grained should error types be?
I now have all the context I need. Here is my structured advisory review.

---

## Advisory Review — Metrics & Analytics Plan

### 1. Completeness Assessment

The plan covers the **right scope** and the **right phases**. All four requested pillars (SQLite, TypeScript, anonymization, cost estimation) are addressed. The schema is well-normalized without being over-engineered for this scale. The four phases form a logical dependency chain: Phase 1 (server foundation) must come first, Phase 2 (browser instrumentation) depends on the event endpoint, Phase 3 (dashboard) consumes the metrics endpoint, Phase 4 (rollups) is a nice-to-have polish pass.

**What's missing or underspecified:**

| Gap | Severity | Recommendation |
|---|---|---|
| **Deepgram streaming STT cost** | Medium | `startSttSession()` uses a WebSocket streaming session — cost depends on audio duration, not bytes. The plan only accounts for batch STT. Add a `session_duration_sec` tracking field in the streaming path. |
| **VAD false-start metrics** | Low | The browser VAD skips utterances under 500ms. Tracking false-start rate would help tune the VAD threshold. Easy to add a counter. |
| **Language-toggle tracking** | Low | `toggleLang()` in app.js fires when the user manually switches. Tracking how often this happens tells you if the auto-detect is confusing. |
| **Pause/resume events** | Low | `togglePause()` is a user gesture. Tracking pause frequency tells you about user frustration moments. |
| **Error detail granularity** | Medium | The plan has `error_detail TEXT` but says "truncated, no PII". This will leak provider error messages that may contain content. Recommend **stripping** to `error_type` only, or keeping `error_detail` as a sanitized status code only (e.g., `"502"`, `"429"`, `"ECONNREFUSED"`). |
| **Salt persistence** | Medium | Salt rotated on every restart means sessions across restarts are unrelatable. For analytics continuity, persist the salt to a file (`data/metrics.salt`) and rotate only on explicit request. |

---

### 2. Open Questions — Answered

#### a) `better-sqlite3` vs `sql.js`

**Recommendation: `better-sqlite3`**, with a fallback wrapper.

Rationale:
- `better-sqlite3` is synchronous — the `MetricsCollector` methods become simple property assignments and inserts, no await chains, no callback nesting. This matters because we're instrumenting hot-path API handlers without adding latency.
- `sql.js` adds ~2+ MB WASM binary, requires async initialization, and is slower. For a metrics DB that's written on every turn, the synchronous native path wins.
- **However**, native compilation can fail on some systems. The fix: wrap the import so metrics degrade gracefully to in-memory-only if `better-sqlite3` is missing.

```js
// metrics/db.ts — recommended pattern
let sqlite: typeof import('better-sqlite3') | null = null;
try {
  sqlite = (await import('better-sqlite3')).default;
} catch {
  console.warn('[metrics] better-sqlite3 not available — using in-memory store');
}
```

- Node 22 / darwin arm64 will compile it trivially.

#### b) TypeScript scope

**Recommendation: metrics module only** (as planned).

- `server.js` is 380 lines of straightforward request routing and API wrappers — converting it to TS adds ceremony without value.
- `public/app.js` is browser-side and can't use Node imports anyway.
- The metrics module is a **well-bounded, data-model-heavy** module (schemas, types, pricing constants, anonymization logic) — exactly the kind of code that benefits most from TypeScript's type safety.
- Use `tsconfig.json` with `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"outDir": "dist"`. The compiled ESM output at `metrics/dist/index.js` is imported by `server.js`.

#### c) Dashboard complexity

**Recommendation: start simple, add Chart.js from CDN later.**

- Phase 3 should begin as a **vanilla auto-refresh counter page** (no deps). This matches the app's ethos and can ship quickly.
- If the user later wants sparklines/histograms, add `<script src="https://cdn.jsdelivr.net/npm/chart.js">` — it's a CDN script tag, not a build dep. The plan should call this out as a two-tier approach.

#### d) Cost accuracy — env vars vs hardcoded

**Recommendation: hardcoded defaults + env var overrides.**

```typescript
// metrics/cost.ts
const PRICING = {
  openrouter: {
    inputPer1KTokens: parseEnv('OPENROUTER_PRICE_PER_1K_INPUT', 0.00015),
    outputPer1KTokens: parseEnv('OPENROUTER_PRICE_PER_1K_OUTPUT', 0.00060),
  },
  elevenlabs: {
    perChar: parseEnv('ELEVENLABS_PRICE_PER_CHAR', 0.00030),
  },
  deepgram: {
    perMinute: parseEnv('DEEPGRAM_PRICE_PER_MINUTE', 0.0059),
  },
};
```

This keeps `.env.example` clean while allowing power users to override.

#### e) Additional privacy concerns

- **Error details:** As noted above, `error_detail` must never contain transcript text, even truncated. Provider error messages sometimes echo the input. Use status-code-only or category-only.
- **Timestamps:** Full Unix ms timestamps can theoretically correlate to user sessions. Not a real privacy concern for localhost usage, but if this ever goes public, bucketing to minute-level granularity is safer.
- **No additional concerns** — the plan's "don't store transcripts or IPs" rule is the right line.

#### f) Error categorization granularity

**Recommendation:** Categorize at HTTP-response-code level:

| Error type | When |
|---|---|
| `auth` | 401/403 responses (API key issues) |
| `rate_limit` | 429 responses |
| `server_error` | 500/502/503 responses |
| `timeout` | Fetch aborted, socket hang up |
| `network` | DNS failure, connection refused, ECONNREFUSED |
| `empty` | Empty transcript or empty translation |
| `unknown` | Everything else |

This is coarse enough to be meaningful, fine enough to distinguish API key issues from provider downtime from silent failures.

---

### 3. Phase Prioritization

```
  NOW →  Phase 1 (foundation): metrics module + server instrumentation + /api/metrics endpoint
          └── Install deps
          └── Create metrics/ TS module (types, db, cost, anonymize)
          └── Wire into server.js translate() + textToSpeech() + speechToText() + startSttSession()
          └── Add /api/metrics GET endpoint
          └── Add /api/metrics/event POST endpoint (server-side error reporting even before browser timings)
          
  NEXT → Phase 2 (browser): performance marks + navigator.sendBeacon
          
  LATER → Phase 3 (dashboard): /admin/monitor page
          
  OPTIONAL → Phase 4 (rollups): daily aggregates, data retention
```

**Phase 1** delivers immediate value without any browser changes. You see error rates, latencies, and costs from the first server restart. Don't wait for Phase 2 — server-side instrumentation alone covers 80% of the value.

---

### 4. Blind Spots & Anti-Patterns to Avoid

| Concern | Why it matters | Fix |
|---|---|---|
| **Metrics blocking the request** | Calling `metrics.record(...)` with synchronous SQLite inside the request handler adds latency to every API call. | Make `MetricsCollector` use a `Writable` stream or batch queue — `record()` writes to a memory buffer, and a `setInterval` flushes to SQLite every 5 seconds. |
| **`navigator.sendBeacon` with large payloads** | `sendBeacon` has a 64KB limit in some browsers. The timing payload is tiny, so fine — but worth noting. | Keep the payload under 1KB. Don't include the transcript text. |
| **Missing `tts-stream` instrumentation** | The plan instruments batch TTS but the app often uses streaming TTS (`/tts-stream`). Streaming has different latency characteristics. | Add a wrapper around the streaming fetch in `server.js`'s `/tts-stream` handler. Record streaming start time and total byte count. |
| **`sessionId` on `window` without expiry** | `window.__sessionId` persists across page refreshes but not localStorage. A refresh starts a new session. | Generate `__sessionId` once per page load with `crypto.randomUUID()`. That's the right granularity. |
| **No health check for metrics DB** | If `metrics.db` is unwritable (permission denied, disk full), the error is silently swallowed. | Add a startup write test and a `metrics_ok` boolean in the `/api/metrics` response. |

---

### 5. Recommended Concrete Next Step

Here is the exact, ordered sequence:

**Step 1:** Create directory structure and install deps
```bash
mkdir -p metrics
npm install better-sqlite3
npm install -D typescript @types/node @types/better-sqlite3
```

**Step 2:** Create `metrics/tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "declaration": true,
    "sourceMap": false,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["**/*.ts"]
}
```

**Step 3:** Create the following files in order:
1. `metrics/types.ts` — all interfaces (TurnEvent, ApiCallEvent, MetricsSnapshot, PricingConfig)
2. `metrics/anonymize.ts` — hashSessionId(), sanitizeUA()
3. `metrics/cost.ts` — pricing constants, estimateCost()
4. `metrics/db.ts` — Database class (open, migrate, insert turn, insert api_call, query aggregates)
5. `metrics/index.ts` — MetricsCollector (public API) with batched writes and 5s flush interval

**Step 4:** Update `package.json` scripts:
```json
"scripts": {
  "build:metrics": "cd metrics && tsc",
  "start": "npm run build:metrics && node server.js"
}
```

**Step 5:** Wire into `server.js`:
- At top: `import { MetricsCollector } from './metrics/dist/index.js';`
- After server starts: `const metrics = new MetricsCollector();`
- Wrap `translate()` with timing + error catching + `metrics.recordApiCall(...)`
- Wrap `textToSpeech()` with timing + error catching + `metrics.recordApiCall(...)`
- Wrap `speechToText()` with timing + error catching + `metrics.recordApiCall(...)`
- Wrap streaming STT session start/end in `startSttSession()` for duration tracking
- Add `GET /api/metrics` handler returning `metrics.snapshot()`

---

### Residual Risks

- **Native compilation risk:** `better-sqlite3` requires `node-gyp` or prebuilt binaries. On darwin arm64 with Node 22 this is reliable, but CI/build environments might struggle. Mitigated by the graceful fallback to in-memory.
- **Privacy boundary creep:** Once the DB exists, there will be temptation to "just log the transcript for debugging." The plan's anonymization-at-collection-point rule must be enforced in code review, not just documented.
- **Metric cost inflation:** If `better-sqlite3` synchronous calls block the event loop on heavy write volume, the app's latency degrades. Mitigated by the batched-write design — but the batch must be tuned. Start with a 5-second flush interval.
- **Scope creep:** The dashboard (Phase 3) could balloon into a full admin panel. The plan should explicitly cap Phase 3 at "counters and latency numbers" and defer sparklines/charts.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Reviewed PLAN-metrics.md (12KB), server.js (380 lines), app.js (470 lines), AGENTS.md, package.json, ws.js. Produced structured advisory covering all 6 open questions, phase prioritization, 7 blind spots, 5 concrete next steps with exact file creation order, and 4 residual risks."
    }
  ],
  "changedFiles": [
    "PLAN-metrics.md (reviewed only, no changes)"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "read PLAN-metrics.md, server.js, public/app.js, AGENTS.md, package.json, ws.js",
      "result": "passed",
      "summary": "Full codebase inspection complete"
    }
  ],
  "validationOutput": [
    "No files modified. Advisory only."
  ],
  "residualRisks": [
    "better-sqlite3 native compilation may fail on non-macOS/non-Linux environments; fallback to in-memory store mitigates",
    "Privacy boundary creep risk: do not store transcripts even for 'debugging'",
    "Synchronous SQLite writes on hot path if batching is not implemented correctly",
    "Dashboard scope creep beyond Phase 3 counters (Chart.js, filtering, session browsing)"
  ],
  "noStagedFiles": true,
  "diffSummary": "No diff. Advisory review of existing PLAN-metrics.md.",
  "review
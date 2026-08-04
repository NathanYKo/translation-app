# Task for oracle

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Review the metrics/analytics plan at /Users/nathanko/Documents/GitHub/translation-app/PLAN-metrics.md for the Realtime Translator app.

Context:
- This is a zero-dependency vanilla JS/ESM app (Node.js server, browser client)
- You MUST read PLAN-metrics.md first
- The user wants: SQLite persistence, simple TypeScript for the metrics module only, anonymization (no PII/transcripts/IPs stored), and cost estimation

Your job as advisor:
1. Review the plan for completeness, risks, and architectural soundness
2. Answer the open questions at the bottom:
   a) better-sqlite3 vs sql.js (native compile vs pure JS)
   b) TypeScript scope — just metrics module, or full server?
   c) Dashboard complexity — simple counters or Chart.js sparklines?
   d) Cost accuracy — env vars vs hardcoded constants?
   e) Additional privacy concerns?
   f) Error categorization granularity?
3. Prioritize the phases — should we start with Phase 1 or is there a better starting point?
4. Identify any missing metrics, blind spots, or anti-patterns
5. Recommend the concrete next step — what file to create first, what to type

Output a structured advisory with your recommendations. Be specific — reference exact file paths, code patterns, and tradeoffs.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return a concise result and residual risks when applicable

Required evidence: manual-notes, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```
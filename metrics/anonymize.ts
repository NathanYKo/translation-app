// metrics/anonymize.ts — Anonymization helpers for the metrics layer

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Persistent salt file so session hashes survive restarts */
const SALT_FILE = path.join(__dirname, '..', '..', 'data', 'metrics.salt');

let _salt: string | null = null;

function loadOrCreateSalt(): string {
  if (_salt) return _salt;
  try {
    _salt = fs.readFileSync(SALT_FILE, 'utf8').trim();
  } catch {
    _salt = crypto.randomBytes(16).toString('hex');
    try {
      fs.mkdirSync(path.dirname(SALT_FILE), { recursive: true });
      fs.writeFileSync(SALT_FILE, _salt, 'utf8');
    } catch {
      // If we can't write the salt file, use an in-memory salt
      // (sessions across restarts won't be relatable, but that's acceptable)
    }
  }
  return _salt;
}

/**
 * Produce a stable anonymized session ID from an IP + timestamp.
 * @param ip - The client IP address (or 'unknown')
 * @param timestamp - Unix ms timestamp
 * @returns A 16-character hex string
 */
export function hashSessionId(ip: string, timestamp: number): string {
  const salt = loadOrCreateSalt();
  const hash = crypto.createHash('sha256').update(`${salt}:${ip}:${Math.floor(timestamp / 60000)}`).digest('hex');
  return hash.slice(0, 16);
}

/**
 * Strip a User-Agent string down to browser family only.
 * @param ua - Raw User-Agent header
 * @returns One of: 'Chrome', 'Edge', 'Firefox', 'Safari', 'Other'
 */
export function sanitizeUA(ua: string | undefined): string {
  if (!ua) return 'Other';
  if (ua.includes('Edg/') || ua.includes('Edge/')) return 'Edge';
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('Chrome/')) return 'Chrome';
  if (ua.includes('Safari/')) return 'Safari';
  return 'Other';
}

/**
 * Sanitize an error message — strip to status code or category only.
 * Never returns the original message text.
 */
export function sanitizeError(msg: string | null | undefined): string | null {
  if (!msg) return null;
  // Try to extract an HTTP status code
  const statusMatch = msg.match(/\b(\d{3})\b/);
  if (statusMatch) return statusMatch[1];
  // Try to extract common error categories
  if (msg.includes('timeout') || msg.includes('TIMEOUT') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('ENETUNREACH')) return 'network';
  if (msg.includes('abort') || msg.includes('ABORT')) return 'aborted';
  if (msg.includes('auth') || msg.includes('Auth') || msg.includes('AUTH') || msg.includes('401') || msg.includes('403')) return 'auth';
  if (msg.includes('rate') || msg.includes('429')) return 'rate_limit';
  if (msg.includes('empty') || msg.includes('Empty')) return 'empty';
  return 'unknown';
}

/**
 * Classify an HTTP status code into an error type.
 */
export function classifyHttpStatus(status: number): string {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'unknown';
}
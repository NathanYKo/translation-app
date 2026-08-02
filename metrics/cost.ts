// metrics/cost.ts — Cost estimation for API calls

import type { PricingConfig } from './types.js';

function parseEnv(key: string, defaultVal: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultVal;
  const parsed = parseFloat(raw);
  return isNaN(parsed) ? defaultVal : parsed;
}

/** Default pricing (public rates as of Aug 2026). Override via env vars. */
export function getPricing(): PricingConfig {
  return {
    openrouter: {
      inputPer1KTokens: parseEnv('OPENROUTER_PRICE_PER_1K_INPUT', 0.00015),
      outputPer1KTokens: parseEnv('OPENROUTER_PRICE_PER_1K_OUTPUT', 0.00060),
      model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-preview',
    },
    elevenlabs: {
      perChar: parseEnv('ELEVENLABS_PRICE_PER_CHAR', 0.00030),
    },
    deepgram: {
      perMinute: parseEnv('DEEPGRAM_PRICE_PER_MINUTE', 0.0059),
    },
  };
}

const pricing = getPricing();

/**
 * Estimate OpenRouter translation cost.
 * Rough token estimate: chars / 4.
 */
export function estimateTranslateCost(inputChars: number, outputChars: number): number {
  const inputTokens = inputChars / 4;
  const outputTokens = outputChars / 4;
  const p = pricing.openrouter;
  return (inputTokens * p.inputPer1KTokens / 1000) + (outputTokens * p.outputPer1KTokens / 1000);
}

/**
 * Estimate ElevenLabs TTS cost.
 */
export function estimateTtsCost(textChars: number): number {
  return textChars * pricing.elevenlabs.perChar;
}

/**
 * Estimate Deepgram STT cost based on audio duration in seconds.
 */
export function estimateSttCost(audioSeconds: number): number {
  return (audioSeconds / 60) * pricing.deepgram.perMinute;
}
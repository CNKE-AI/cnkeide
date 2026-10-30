import { createHash } from 'node:crypto';

export interface ModelIdentity { id?: string; baseUrl?: string; model?: string; provider?: string }
export interface LatencySample { ttftMs: number; samples: number; updatedAt: number; cooldownUntil: number }
export type LatencyTable = Record<string, LatencySample>;
interface Storage { get: (key: string, fallback?: unknown) => unknown; set: (key: string, value: unknown) => unknown }
const KEY = 'modelLatency.v1';
const TTL = 24 * 60 * 60 * 1000;
let memory: LatencyTable = {};

export function modelLatencyKey(model: ModelIdentity): string {
  return createHash('sha256').update(JSON.stringify([model.id || '', model.baseUrl || '', model.model || '', model.provider || ''])).digest('hex');
}

export function readModelLatency(storage?: Storage, now = Date.now()): LatencyTable {
  try {
    const raw = storage?.get(KEY, {}) ?? memory;
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(Object.entries(raw).filter(([, s]) => s && Number.isFinite(s.ttftMs) && s.ttftMs >= 0 && Number.isInteger(s.samples) && s.samples >= 0 && Number.isFinite(s.cooldownUntil) && Number.isFinite(s.updatedAt) && s.updatedAt <= now && now - s.updatedAt < TTL).slice(-200));
  } catch { return {}; }
}

export function recordModelLatency(model: ModelIdentity, ttftMs: number | null, storage?: Storage, now = Date.now()): void {
  if (ttftMs !== null && (!Number.isFinite(ttftMs) || ttftMs < 0)) return;
  const table = readModelLatency(storage, now);
  const key = modelLatencyKey(model);
  const prev = table[key];
  table[key] = ttftMs === null
    ? { ttftMs: prev?.ttftMs ?? 0, samples: prev?.samples ?? 0, updatedAt: now, cooldownUntil: now + 60000 }
    : { ttftMs: prev?.samples ? prev.ttftMs * 0.7 + ttftMs * 0.3 : ttftMs, samples: (prev?.samples ?? 0) + 1, updatedAt: now, cooldownUntil: 0 };
  memory = table;
  try { storage?.set(KEY, table); } catch { /* Telemetry must not interrupt a request. */ }
}

export function rankByLatency<T extends ModelIdentity>(models: T[], table: LatencyTable, now = Date.now()): { model: T; latency?: number }[] {
  return models.filter((model) => {
    const sample = table[modelLatencyKey(model)];
    return !sample || sample.cooldownUntil <= now;
  }).map((model) => {
    const sample = table[modelLatencyKey(model)];
    return { model, latency: sample && sample.samples > 0 && now - sample.updatedAt < TTL && sample.updatedAt <= now && Number.isFinite(sample.ttftMs) && sample.ttftMs >= 0 ? sample.ttftMs : undefined };
  }).sort((a, b) => (a.latency ?? Infinity) - (b.latency ?? Infinity));
}

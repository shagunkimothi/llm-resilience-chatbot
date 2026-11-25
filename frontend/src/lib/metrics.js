// Pure functions that turn this page visit's request log into analytics.
// Nothing here invents numbers: every value is derived from logged /chat attempts.

export const SERIES = {
  live: { label: 'Live inference', color: 'var(--series-live)' },
  cache: { label: 'Cache', color: 'var(--series-cache)' },
  failed: { label: 'Failed', color: 'var(--series-failed)' },
}


export const SIM_STATUSES = [429, 500, 502, 503]

/** 'key_1=429,key_2=500' | '*=429' -> { key_1: 429, ... }. Mirrors the backend parser. */
export function parsePlan(header) {
  const plan = {}
  for (const part of (header || '').split(',')) {
    const [rawName, rawStatus] = part.split('=')
    if (rawStatus === undefined) continue
    const name = rawName.trim()
    const status = rawStatus.trim()
    if (!/^\d+$/.test(status) || !SIM_STATUSES.includes(Number(status))) continue
    if (name === '*' || /^key_\d+$/.test(name)) plan[name] = Number(status)
  }
  return plan
}

const keyNum = (k) => Number(String(k).replace('key_', ''))
export const keyName = (n) => `key_${n}`

/** 'cache' | 'live' | 'failed' */
export function classify(e) {
  if (!e.ok || !e.metadata) return 'failed'
  return e.metadata.resolution_source === 'LLM_CACHE' ? 'cache' : 'live'
}

export const isFallback = (e) => e.ok && (e.metadata?.fallback_attempts ?? 0) > 0

/**
 * Keys that failed during this request, in the order the backend tries them (key_1, key_2, …).
 * For a 200 with fallback_attempts = f answered by key_k, the failed keys are key_(k-f)..key_(k-1).
 * For a 503 every configured key failed (if the count is unknown, the plan's keys are listed).
 * reason is "simulated <status>" when the X-Simulate-Failure plan covered that key.
 */
export function failedKeys(e, keysConfigured) {
  const plan = parsePlan(e.simulate)
  const reasonFor = (k) => {
    const s = plan[k] ?? plan['*']
    return s ? `simulated ${s}` : null
  }
  let keys = []
  if (e.ok && e.metadata) {
    const f = e.metadata.fallback_attempts ?? 0
    const answered = e.metadata.key_id ? keyNum(e.metadata.key_id) : f + 1
    for (let i = answered - f; i < answered; i++) if (i >= 1) keys.push(keyName(i))
  } else if (e.httpStatus === 503) {
    if (keysConfigured) {
      for (let i = 1; i <= keysConfigured; i++) keys.push(keyName(i))
    } else {
      keys = Object.keys(plan).filter((k) => k !== '*').sort((a, b) => keyNum(a) - keyNum(b))
    }
  }
  return keys.map((k) => ({ key: k, reason: reasonFor(k) }))
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0)
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null)

export function overviewStats(log, prices = { input: 0, output: 0 }) {
  const ok = log.filter((e) => e.ok && e.metadata)
  const live = ok.filter((e) => classify(e) === 'live')
  const cache = ok.filter((e) => classify(e) === 'cache')
  const inputTokens = sum(live.map((e) => e.metadata.input_tokens || 0))
  const outputTokens = sum(live.map((e) => e.metadata.output_tokens || 0))
  const cachedInput = sum(cache.map((e) => e.metadata.input_tokens || 0))
  const cachedOutput = sum(cache.map((e) => e.metadata.output_tokens || 0))
  return {
    total: log.length,
    successful: ok.length,
    failed: log.length - ok.length,
    successRate: log.length ? ok.length / log.length : null,
    avgLiveLatency: mean(live.map((e) => e.metadata.latency_ms)),
    avgRoundTrip: mean(log.map((e) => e.roundTripMs).filter((x) => typeof x === 'number')),
    cacheHitRate: ok.length ? cache.length / ok.length : null,
    fallbackEvents: sum(ok.map((e) => e.metadata.fallback_attempts || 0)),
    fallbackRequests: ok.filter(isFallback).length,
    inputTokens,
    outputTokens,
    cachedInput,
    cachedOutput,
    estimatedCost: (inputTokens / 1e6) * (Number(prices.input) || 0) + (outputTokens / 1e6) * (Number(prices.output) || 0),
  }
}

/** Per-minute buckets from the first logged minute to the last (max `maxBuckets`, newest kept). */
export function perMinute(log, maxBuckets = 30) {
  if (!log.length) return []
  const minute = (t) => Math.floor(t / 60000) * 60000
  const first = minute(Math.min(...log.map((e) => e.time)))
  const last = minute(Math.max(...log.map((e) => e.time)))
  const start = Math.max(first, last - (maxBuckets - 1) * 60000)
  const buckets = []
  for (let t = start; t <= last; t += 60000) buckets.push({ t, live: 0, cache: 0, failed: 0 })
  for (const e of log) {
    const b = buckets.find((x) => x.t === minute(e.time))
    if (b) b[classify(e)] += 1
  }
  return buckets
}

export function cacheStats(log) {
  const ok = log.filter((e) => e.ok && e.metadata)
  const hits = ok.filter((e) => classify(e) === 'cache')
  // A live reply without a simulation header was a cache miss; with one, the cache is bypassed.
  const misses = ok.filter((e) => classify(e) === 'live' && !e.simulate)
  const bypassed = log.filter((e) => e.simulate).length
  const avgCache = mean(hits.map((e) => e.metadata.latency_ms))
  const avgLive = mean(ok.filter((e) => classify(e) === 'live').map((e) => e.metadata.latency_ms))
  const lookups = hits.length + misses.length
  return {
    hits: hits.length,
    misses: misses.length,
    bypassed,
    hitRate: lookups ? hits.length / lookups : null,
    avgCache,
    avgLive,
    timeSaved: avgCache !== null && avgLive !== null ? Math.max(0, hits.length * (avgLive - avgCache)) : null,
    points: ok.map((e) => ({ id: e.id, time: e.time, kind: classify(e), latency: e.metadata.latency_ms })),
  }
}

/** Per-key health derived from this session's requests. */
export function keyStats(log, keysConfigured) {
  let n = keysConfigured || 0
  for (const e of log) {
    if (e.metadata?.key_id) n = Math.max(n, keyNum(e.metadata.key_id))
    for (const f of failedKeys(e, keysConfigured)) n = Math.max(n, keyNum(f.key))
  }
  const rows = []
  for (let i = 1; i <= n; i++) {
    rows.push({
      key: keyName(i),
      served: 0,
      failures: 0,
      simulated: 0,
      realFailures: 0,
      lastSuccess: null,
      lastFailure: null,
      lastEvent: null, // 'success' | 'failure'; simulated failures are not status events
    })
  }
  const row = (k) => rows[keyNum(k) - 1]
  // The log is in send order, so the last write per key is its most recent event.
  for (const e of log) {
    if (e.ok && e.metadata?.key_id) {
      const r = row(e.metadata.key_id)
      r.served += 1
      r.lastSuccess = Math.max(r.lastSuccess ?? 0, e.time)
      r.lastEvent = 'success'
    }
    for (const f of failedKeys(e, keysConfigured)) {
      const r = row(f.key)
      r.failures += 1
      r.lastFailure = Math.max(r.lastFailure ?? 0, e.time)
      if (f.reason) {
        r.simulated += 1
      } else {
        r.realFailures += 1
        r.lastEvent = 'failure'
      }
    }
  }
  for (const r of rows) {
    if (r.lastEvent === 'failure') r.status = 'Failing'
    else if (r.lastEvent === 'success') r.status = r.realFailures ? 'Recovered' : 'Healthy'
    else r.status = 'No data'
    r.onlySimulated = r.failures > 0 && r.realFailures === 0
  }
  return rows
}

/** Step timeline for one request: [{ label, tone: 'ok'|'warn'|'fail'|'info'|'cache' }]. */
export function traceSteps(e, keysConfigured) {
  const steps = [{ label: e.simulate ? `Request sent (X-Simulate-Failure: ${e.simulate})` : 'Request sent', tone: 'info' }]
  if (e.httpStatus === null) {
    steps.push({ label: `No response: network error after ${e.roundTripMs} ms`, tone: 'fail' })
    return steps
  }
  if (e.httpStatus === 422) {
    steps.push({ label: `422 rejected by validation in ${e.roundTripMs} ms`, tone: 'fail' })
    return steps
  }
  const kind = classify(e)
  if (kind === 'cache') {
    steps.push({ label: 'Cache hit', tone: 'cache' })
  } else if (e.simulate) {
    steps.push({ label: 'Cache bypassed (failure simulation active)', tone: 'info' })
  } else if (e.ok || e.httpStatus === 503) {
    steps.push({ label: 'Cache miss', tone: 'info' })
  }
  const failed = failedKeys(e, keysConfigured)
  for (const f of failed) steps.push({ label: `${f.key} failed${f.reason ? ` (${f.reason})` : ''}`, tone: 'warn' })
  if (e.ok && e.metadata) {
    if (kind === 'live') steps.push({ label: `${e.metadata.key_id ?? 'provider'} answered`, tone: 'ok' })
    steps.push({ label: `${e.httpStatus} in ${e.roundTripMs} ms (server ${e.metadata.latency_ms} ms)`, tone: 'ok' })
  } else if (e.httpStatus === 503) {
    steps.push({ label: 'All keys failed', tone: 'fail' })
    steps.push({ label: `503 in ${e.roundTripMs} ms`, tone: 'fail' })
  } else {
    steps.push({ label: `${e.httpStatus} in ${e.roundTripMs} ms`, tone: 'fail' })
  }
  return steps
}

/** "key_1 failed → key_2 answered · 1 fallback · 1212 ms" or "Served from cache · 3 ms". */
export function failoverLine(metadata) {
  if (!metadata) return null
  if (metadata.resolution_source === 'LLM_CACHE') return `Served from cache · ${metadata.latency_ms} ms`
  const f = metadata.fallback_attempts ?? 0
  if (f <= 0 || !metadata.key_id) return null
  const k = keyNum(metadata.key_id)
  const chain = []
  for (let i = k - f; i < k; i++) if (i >= 1) chain.push(`${keyName(i)} failed`)
  chain.push(`${metadata.key_id} answered`)
  return `${chain.join(' → ')} · ${f} fallback${f === 1 ? '' : 's'} · ${metadata.latency_ms} ms`
}

export function buildChatExport(sessionId, messages, exportedAt = new Date()) {
  return {
    session_id: sessionId,
    exported_at: exportedAt.toISOString(),
    messages: messages.map((m) => {
      const out = { role: m.role, text: m.text }
      if (m.metadata) out.metadata = m.metadata
      return out
    }),
  }
}

export function chatToText(exp) {
  const lines = [`Resilix chat export`, `Session: ${exp.session_id}`, `Exported: ${exp.exported_at}`, '']
  for (const m of exp.messages) {
    const who = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Assistant' : 'Error'
    lines.push(`${who}: ${m.text}`)
    if (m.metadata) {
      const md = m.metadata
      lines.push(`  [${md.resolution_source} · ${md.model} · ${md.latency_ms} ms · in ${md.input_tokens} / out ${md.output_tokens}]`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export const fmtTime = (t) =>
  t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'
export const fmtPct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 1000) / 10}%`)
export const fmtMs = (x) => (x === null || x === undefined ? '—' : `${Math.round(x)} ms`)
export const fmtInt = (x) => (x === null || x === undefined ? '—' : Number(x).toLocaleString('en-US'))

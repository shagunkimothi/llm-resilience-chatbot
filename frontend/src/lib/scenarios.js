import { newSessionId } from '../api.js'

const tag = () => Math.random().toString(36).slice(2, 8)

export function describeEntry(e) {
  if (!e) return '—'
  if (e.ok && e.metadata) {
    const m = e.metadata
    const f = m.fallback_attempts ?? 0
    return `HTTP ${e.httpStatus} · ${m.resolution_source} · ${m.key_id ?? 'no key'} · ${f} fallback${f === 1 ? '' : 's'}`
  }
  return e.httpStatus === null ? `Network error: ${e.error}` : `HTTP ${e.httpStatus}: ${e.error}`
}

const live = (e) => e.ok && e.metadata?.resolution_source === 'LIVE_INFERENCE'

function failover(id, status) {
  return {
    id,
    name: `key_1 → ${status}`,
    header: `key_1=${status}`,
    description: `Simulates a ${status} on key_1; the next key should answer.`,
    expected: `HTTP 200 · LIVE_INFERENCE · answered by a key other than key_1 · ≥1 fallback`,
    async run(runChat) {
      const e = await runChat({ sessionId: newSessionId(), message: `Testing lab ${tag()}: say OK.`, simulate: `key_1=${status}` })
      const pass = live(e) && e.metadata.key_id !== 'key_1' && e.metadata.fallback_attempts >= 1
      return { pass, actual: describeEntry(e), entries: [e] }
    },
  }
}

// Each scenario uses fresh sessions and a unique message so earlier runs can't be served from cache,
// except "Cache hit", which deliberately repeats its own first message in a second fresh session.
export const SCENARIOS = [
  {
    id: 'normal',
    name: 'Normal',
    header: '',
    description: 'A new message in a fresh session, no simulation.',
    expected: 'HTTP 200 · LIVE_INFERENCE · 0 fallbacks',
    async run(runChat) {
      const e = await runChat({ sessionId: newSessionId(), message: `Testing lab ${tag()}: say OK.`, simulate: '' })
      return { pass: live(e) && e.metadata.fallback_attempts === 0, actual: describeEntry(e), entries: [e] }
    },
  },
  {
    id: 'cache',
    name: 'Cache hit',
    header: '',
    description: 'Sends the same first message in two fresh sessions; the second should come from the cache.',
    expected: 'Second request: HTTP 200 · LLM_CACHE',
    async run(runChat) {
      const message = `Testing lab ${tag()}: say OK.`
      const first = await runChat({ sessionId: newSessionId(), message, simulate: '' })
      if (!first.ok) return { pass: false, actual: `First request failed: ${describeEntry(first)}`, entries: [first] }
      const second = await runChat({ sessionId: newSessionId(), message, simulate: '' })
      const pass = second.ok && second.metadata?.resolution_source === 'LLM_CACHE'
      return { pass, actual: `Second request: ${describeEntry(second)}`, entries: [first, second] }
    },
  },
  failover('key1_429', 429),
  failover('key1_500', 500),
  {
    id: 'all_fail',
    name: 'All keys fail',
    header: '*=429',
    description: 'Simulates a 429 on every key.',
    expected: 'HTTP 503 · all keys failed',
    async run(runChat) {
      const e = await runChat({ sessionId: newSessionId(), message: `Testing lab ${tag()}: say OK.`, simulate: '*=429' })
      return { pass: e.httpStatus === 503, actual: describeEntry(e), entries: [e] }
    },
  },
]

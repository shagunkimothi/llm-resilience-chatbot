export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/+$/, '')

export function newSessionId() {
  return 's-' + crypto.randomUUID()
}

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())

function formatDetail(detail) {
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => (d && typeof d === 'object' ? d.msg : d)).filter(Boolean)
    return msgs.length ? msgs.join('; ') : 'request was rejected'
  }
  if (typeof detail === 'string' && detail) return detail
  if (detail && typeof detail === 'object') return JSON.stringify(detail)
  return 'request was rejected'
}

async function readJson(res) {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/**
 * GET {API}/sessions/{id}/messages. Resolves with [{role, text, metadata?}].
 * Rejects with an Error whose .message is already user-readable.
 */
export async function getHistory(sessionId) {
  let res
  try {
    res = await fetch(`${API_URL}/sessions/${encodeURIComponent(sessionId)}/messages`)
  } catch {
    throw new Error(`Can't reach the server at ${API_URL}.`)
  }
  const data = await readJson(res)
  if (res.status === 404) throw new Error("Couldn't load this chat: it has no saved messages yet.")
  if (!res.ok || !data || !Array.isArray(data.messages)) {
    throw new Error(`Couldn't load this chat (HTTP ${res.status}).`)
  }
  return data.messages.map((m) => ({ role: m.role, text: m.content, metadata: m.metadata }))
}

/**
 * GET {API}/health. Never rejects. Resolves with
 * { state: 'ok' | 'degraded' | 'unreachable', httpStatus, data, detail, checkedAt }.
 */
export async function getHealth() {
  const checkedAt = Date.now()
  let res
  try {
    res = await fetch(`${API_URL}/health`)
  } catch {
    return { state: 'unreachable', httpStatus: null, data: null, detail: `Can't reach ${API_URL}`, checkedAt }
  }
  const data = await readJson(res)
  if (res.ok && data && data.status === 'ok') {
    return { state: 'ok', httpStatus: res.status, data, detail: null, checkedAt }
  }
  return {
    state: 'degraded',
    httpStatus: res.status,
    data,
    detail: data?.detail ? formatDetail(data.detail) : `HTTP ${res.status}`,
    checkedAt,
  }
}

/**
 * POST {API}/chat and describe the attempt. Never rejects. Resolves with
 * { request, httpStatus, data, ok, error, roundTripMs } where error is a user-readable
 * message (null on success) and request is what was sent (there are no secrets client-side).
 */
export async function postChat({ sessionId, message, systemPrompt, simulate }) {
  const body = { session_id: sessionId, message }
  if (systemPrompt && systemPrompt.trim()) body.system_prompt = systemPrompt
  const headers = { 'Content-Type': 'application/json' }
  if (simulate) headers['X-Simulate-Failure'] = simulate
  const url = `${API_URL}/chat`
  const request = { method: 'POST', url, headers: { ...headers }, body }

  const t0 = now()
  let res
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch {
    return {
      request,
      httpStatus: null,
      data: null,
      ok: false,
      error: `Can't reach the server at ${API_URL}.`,
      roundTripMs: Math.round(now() - t0),
    }
  }
  const data = await readJson(res)
  const roundTripMs = Math.round(now() - t0)
  const base = { request, httpStatus: res.status, data, roundTripMs }

  if (res.status === 422) return { ...base, ok: false, error: `Invalid message: ${formatDetail(data?.detail)}` }
  if (res.status === 503) return { ...base, ok: false, error: 'All providers are unavailable right now. Please try again.' }
  if (!res.ok || !data || typeof data.reply !== 'string' || !data.metadata) {
    return { ...base, ok: false, error: `Something went wrong (HTTP ${res.status}).` }
  }
  return { ...base, ok: true, error: null }
}

/**
 * POST {API}/chat. Resolves with the parsed ChatResponse on 200.
 * Rejects with an Error whose .message is already user-readable.
 */
export async function sendChat(args) {
  const r = await postChat(args)
  if (!r.ok) throw new Error(r.error)
  return r.data
}

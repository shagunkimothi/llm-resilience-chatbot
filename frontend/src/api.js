export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/+$/, '')

export function newSessionId() {
  return 's-' + crypto.randomUUID()
}

function formatDetail(detail) {
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => (d && typeof d === 'object' ? d.msg : d)).filter(Boolean)
    return msgs.length ? msgs.join('; ') : 'request was rejected'
  }
  if (typeof detail === 'string' && detail) return detail
  if (detail && typeof detail === 'object') return JSON.stringify(detail)
  return 'request was rejected'
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
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (res.status === 404) throw new Error("Couldn't load this chat: it has no saved messages yet.")
  if (!res.ok || !data || !Array.isArray(data.messages)) {
    throw new Error(`Couldn't load this chat (HTTP ${res.status}).`)
  }
  return data.messages.map((m) => ({ role: m.role, text: m.content, metadata: m.metadata }))
}

/**
 * POST {API}/chat. Resolves with the parsed ChatResponse on 200.
 * Rejects with an Error whose .message is already user-readable.
 */
export async function sendChat({ sessionId, message, systemPrompt, simulate }) {
  const body = { session_id: sessionId, message }
  if (systemPrompt && systemPrompt.trim()) body.system_prompt = systemPrompt
  const headers = { 'Content-Type': 'application/json' }
  if (simulate) headers['X-Simulate-Failure'] = simulate

  let res
  try {
    res = await fetch(`${API_URL}/chat`, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch {
    throw new Error(`Can't reach the server at ${API_URL}.`)
  }

  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }

  if (res.status === 422) throw new Error(`Invalid message: ${formatDetail(data?.detail)}`)
  if (res.status === 503) throw new Error('All providers are unavailable right now. Please try again.')
  if (!res.ok || !data || typeof data.reply !== 'string' || !data.metadata) {
    throw new Error(`Something went wrong (HTTP ${res.status}).`)
  }
  return data
}

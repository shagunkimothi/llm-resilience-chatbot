import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App.jsx'
import { buildChatExport, cacheStats, keyStats, overviewStats, traceSteps } from '../lib/metrics.js'

const META = {
  resolution_source: 'LIVE_INFERENCE',
  model: 'gemini/gemini-3.5-flash-lite',
  latency_ms: 1212,
  input_tokens: 40,
  output_tokens: 10,
  key_id: 'key_1',
  fallback_attempts: 0,
}
const reply = (meta = {}, text = 'Answer') => ({ session_id: 'x', reply: text, metadata: { ...META, ...meta } })

function jsonResponse(status, body) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

const HEALTH_OK = { status: 'ok', keys_configured: 2, cache_enabled: true }

let fetchMock
let chatQueue
let chatDefault
let healthImpl
beforeEach(() => {
  chatQueue = []
  chatDefault = () => jsonResponse(200, reply())
  healthImpl = () => jsonResponse(200, HEALTH_OK)
  fetchMock = vi.fn((url, init) => {
    if (url.endsWith('/health')) return healthImpl()
    if (init?.method === 'POST') return (chatQueue.shift() ?? chatDefault)(url, init)
    const sid = decodeURIComponent(url.split('/sessions/')[1].split('/')[0])
    return jsonResponse(200, {
      session_id: sid,
      messages: [
        { role: 'user', content: 'reopened question' },
        { role: 'assistant', content: 'reopened answer', metadata: META },
      ],
    })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const chatCalls = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')

async function typeAndSend(user, text) {
  await user.type(screen.getByTestId('chat-input'), text)
  await user.click(screen.getByTestId('send-button'))
}

// Builds log entries the same way App does, for the pure metric functions.
let n = 0
const entry = (over) => ({
  id: ++n,
  time: Date.UTC(2026, 0, 1, 12, 0, 0),
  sessionId: 's-1',
  message: 'm',
  simulate: '',
  httpStatus: 200,
  ok: true,
  roundTripMs: 100,
  metadata: META,
  ...over,
})

describe('Playground default view', () => {
  it('is the default view and exposes all 9 required testids after a reply, meta-* value-only', async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(screen.getByTestId('nav-playground')).toHaveAttribute('aria-current', 'page')
    await typeAndSend(user, 'Hello')
    await screen.findByTestId('assistant-message')
    for (const id of [
      'chat-input',
      'send-button',
      'assistant-message',
      'meta-source',
      'meta-model',
      'meta-latency',
      'meta-input-tokens',
      'meta-output-tokens',
      'system-prompt-input',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    expect(screen.getByTestId('meta-source').textContent).toBe('LIVE_INFERENCE')
    expect(screen.getByTestId('meta-latency').textContent).toMatch(/^\d+ ms$/)
    expect(screen.getByTestId('meta-input-tokens').textContent).toBe('40')
  })

  it('shows the failover line for fallbacks and the cache line for cached replies', async () => {
    chatQueue.push(() => jsonResponse(200, reply({ key_id: 'key_2', fallback_attempts: 1 })))
    chatQueue.push(() => jsonResponse(200, reply({ resolution_source: 'LLM_CACHE', key_id: null, latency_ms: 3 })))
    const user = userEvent.setup()
    render(<App />)
    await typeAndSend(user, 'one')
    expect((await screen.findByTestId('failover-line')).textContent).toBe('key_1 failed → key_2 answered · 1 fallback · 1212 ms')
    await typeAndSend(user, 'two')
    await vi.waitFor(() => expect(screen.getAllByTestId('failover-line')).toHaveLength(2))
    expect(screen.getAllByTestId('failover-line')[1].textContent).toBe('Served from cache · 3 ms')
  })
})

describe('metrics', () => {
  it('overview stats compute from responses', () => {
    const log = [
      entry({ metadata: { ...META, latency_ms: 1000, input_tokens: 100, output_tokens: 20 } }),
      entry({ metadata: { ...META, latency_ms: 2000, key_id: 'key_2', fallback_attempts: 1, input_tokens: 50, output_tokens: 10 } }),
      entry({ metadata: { ...META, resolution_source: 'LLM_CACHE', key_id: null, latency_ms: 4 } }),
      entry({ ok: false, httpStatus: 503, metadata: null, error: 'x' }),
    ]
    const s = overviewStats(log, { input: 1, output: 2 })
    expect(s.total).toBe(4)
    expect(s.successful).toBe(3)
    expect(s.failed).toBe(1)
    expect(s.successRate).toBe(0.75)
    expect(s.avgLiveLatency).toBe(1500)
    expect(s.cacheHitRate).toBeCloseTo(1 / 3)
    expect(s.fallbackEvents).toBe(1)
    expect(s.inputTokens).toBe(150)
    expect(s.outputTokens).toBe(30)
    expect(s.estimatedCost).toBeCloseTo(150 / 1e6 + 60 / 1e6)
  })

  it('cache stats: hits, misses, bypassed and estimated time saved', () => {
    const log = [
      entry({ metadata: { ...META, latency_ms: 1000 } }),
      entry({ metadata: { ...META, latency_ms: 2000 }, simulate: 'key_1=429' }),
      entry({ metadata: { ...META, resolution_source: 'LLM_CACHE', key_id: null, latency_ms: 10 } }),
      entry({ metadata: { ...META, resolution_source: 'LLM_CACHE', key_id: null, latency_ms: 20 } }),
    ]
    const c = cacheStats(log)
    expect(c.hits).toBe(2)
    expect(c.misses).toBe(1)
    expect(c.bypassed).toBe(1)
    expect(c.hitRate).toBeCloseTo(2 / 3)
    expect(c.avgCache).toBe(15)
    expect(c.avgLive).toBe(1500)
    expect(c.timeSaved).toBe(2 * (1500 - 15))
  })

  it('trace timeline for fallback, cache and 503', () => {
    const labels = (e, k) => traceSteps(e, k).map((s) => s.label)
    expect(
      labels(entry({ simulate: 'key_1=429', roundTripMs: 1300, metadata: { ...META, key_id: 'key_2', fallback_attempts: 1 } }), 2),
    ).toEqual([
      'Request sent (X-Simulate-Failure: key_1=429)',
      'Cache bypassed (failure simulation active)',
      'key_1 failed (simulated 429)',
      'key_2 answered',
      '200 in 1300 ms (server 1212 ms)',
    ])
    expect(labels(entry({ roundTripMs: 9, metadata: { ...META, resolution_source: 'LLM_CACHE', key_id: null, latency_ms: 3 } }), 2)).toEqual([
      'Request sent',
      'Cache hit',
      '200 in 9 ms (server 3 ms)',
    ])
    expect(labels(entry({ simulate: '*=429', ok: false, httpStatus: 503, metadata: null, roundTripMs: 50 }), 2)).toEqual([
      'Request sent (X-Simulate-Failure: *=429)',
      'Cache bypassed (failure simulation active)',
      'key_1 failed (simulated 429)',
      'key_2 failed (simulated 429)',
      'All keys failed',
      '503 in 50 ms',
    ])
  })

  it('trace inspector in the UI shows the fallback timeline and raw JSON', async () => {
    chatQueue.push(() => jsonResponse(200, reply({ key_id: 'key_2', fallback_attempts: 1 })))
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByTestId('settings-toggle'))
    await user.selectOptions(screen.getByTestId('simulate-select'), 'key_1=429')
    await typeAndSend(user, 'hello')
    await screen.findByTestId('assistant-message')
    await user.click(screen.getByTestId('nav-traces'))
    await user.click(screen.getAllByTestId('trace-row')[0])
    const steps = within(screen.getByTestId('trace-timeline')).getAllByTestId('trace-step').map((s) => s.textContent)
    expect(steps).toContain('key_1 failed (simulated 429)')
    expect(steps).toContain('key_2 answered')
    expect(JSON.parse(screen.getByTestId('trace-request-json').textContent).headers['X-Simulate-Failure']).toBe('key_1=429')
    expect(JSON.parse(screen.getByTestId('trace-response-json').textContent).metadata.key_id).toBe('key_2')
  })

  it('overview view shows an empty state, then real counts', async () => {
    chatQueue.push(() => jsonResponse(503, { detail: 'all providers unavailable' }))
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByTestId('nav-overview'))
    expect(screen.getByTestId('empty-state')).toBeInTheDocument()
    await user.click(screen.getByTestId('nav-playground'))
    await typeAndSend(user, 'a')
    await screen.findByTestId('error-message')
    await typeAndSend(user, 'b')
    await vi.waitFor(() => expect(screen.getAllByTestId('assistant-message')).toHaveLength(1))
    await user.click(screen.getByTestId('nav-overview'))
    expect(screen.getByTestId('stat-total').textContent).toBe('2')
    expect(screen.getByTestId('stat-failed').textContent).toBe('1')
    expect(screen.getByTestId('stat-success-rate').textContent).toBe('50%')
    expect(screen.getByTestId('stat-avg-latency').textContent).toBe('1212 ms')
    expect(screen.getByTestId('chart-rpm')).toBeInTheDocument()
  })
})

describe('key status (most recent event; simulated failures never count)', () => {
  const ok = (key, fallbacks = 0, over = {}) => entry({ metadata: { ...META, key_id: key, fallback_attempts: fallbacks }, ...over })
  const status = (log, key = 'key_1', k = 2) => keyStats(log, k).find((r) => r.key === key)

  it('simulated failures then a success → Healthy, with the "only simulated" flag', () => {
    const log = [
      ok('key_2', 1, { simulate: 'key_1=429' }),
      ok('key_2', 1, { simulate: 'key_1=500' }),
      entry({ simulate: '*=429', ok: false, httpStatus: 503, metadata: null }),
      ok('key_1'),
    ]
    const r = status(log)
    expect(r.failures).toBe(3)
    expect(r.simulated).toBe(3)
    expect(r.status).toBe('Healthy')
    expect(r.onlySimulated).toBe(true)
  })

  it('a real fallback failure then a success → Recovered', () => {
    const r = status([ok('key_2', 1), ok('key_1')])
    expect(r.status).toBe('Recovered')
    expect(r.onlySimulated).toBe(false)
  })

  it('a real 503 last → Failing, even after successes', () => {
    const log = [ok('key_1'), ok('key_2'), entry({ ok: false, httpStatus: 503, metadata: null })]
    expect(status(log, 'key_1').status).toBe('Failing')
    expect(status(log, 'key_2').status).toBe('Failing')
  })

  it('a simulated failure after a real one does not change the status', () => {
    const log = [ok('key_2', 1), ok('key_1'), ok('key_2', 1, { simulate: 'key_1=429' })]
    expect(status(log).status).toBe('Recovered')
  })

  it('no events → No data', () => {
    expect(keyStats([], 2).map((r) => r.status)).toEqual(['No data', 'No data'])
  })

  it('Monitoring shows the status and the "only simulated failures" note', async () => {
    chatQueue.push(() => jsonResponse(200, reply({ key_id: 'key_2', fallback_attempts: 1 })))
    chatQueue.push(() => jsonResponse(200, reply({ key_id: 'key_1' })))
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByTestId('settings-toggle'))
    await user.selectOptions(screen.getByTestId('simulate-select'), 'key_1=429')
    await typeAndSend(user, 'one')
    await screen.findByTestId('assistant-message')
    await user.selectOptions(screen.getByTestId('simulate-select'), '')
    await typeAndSend(user, 'two')
    await vi.waitFor(() => expect(screen.getAllByTestId('assistant-message')).toHaveLength(2))
    await user.click(screen.getByTestId('nav-monitoring'))
    const row = screen.getByTestId('key-row-key_1')
    expect(row).toHaveTextContent('1 (1 simulated)')
    expect(within(row).getByTestId('key-status').textContent).toBe('Healthy')
    expect(within(row).getByTestId('key-status-note').textContent).toBe('only simulated failures')
    expect(within(screen.getByTestId('key-row-key_2')).queryByTestId('key-status-note')).toBeNull()
  })
})

describe('status pill', () => {
  it.each([
    ['ok', () => jsonResponse(200, HEALTH_OK), 'System operational'],
    ['degraded', () => jsonResponse(503, { detail: 'no API keys configured' }), 'Degraded'],
    ['unreachable', () => Promise.reject(new TypeError('Failed to fetch')), 'Unreachable'],
  ])('%s', async (state, impl, text) => {
    healthImpl = impl
    render(<App monitorHealth />)
    await vi.waitFor(() => expect(screen.getByTestId('status-pill')).toHaveAttribute('data-state', state))
    expect(screen.getByTestId('status-text').textContent).toBe(text)
  })

  it('re-checks every 60 s and on demand', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<App monitorHealth />)
      const healthCalls = () => fetchMock.mock.calls.filter(([u]) => u.endsWith('/health')).length
      await vi.waitFor(() => expect(healthCalls()).toBe(1))
      healthImpl = () => jsonResponse(503, { detail: 'database unavailable' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      await vi.waitFor(() => expect(screen.getByTestId('status-pill')).toHaveAttribute('data-state', 'degraded'))
      expect(healthCalls()).toBe(2)
      healthImpl = () => jsonResponse(200, HEALTH_OK)
      await act(async () => {
        screen.getByTestId('status-refresh').click()
      })
      await vi.waitFor(() => expect(screen.getByTestId('status-pill')).toHaveAttribute('data-state', 'ok'))
      expect(healthCalls()).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('testing lab', () => {
  it('key_1 → 429 sends the header and shows PASS with its trace', async () => {
    chatDefault = () => jsonResponse(200, reply({ key_id: 'key_2', fallback_attempts: 1 }))
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByTestId('nav-lab'))
    await user.click(screen.getByTestId('lab-run-key1_429'))
    const card = screen.getByTestId('scenario-key1_429')
    await vi.waitFor(() => expect(within(card).getByTestId('lab-badge').textContent).toBe('PASS'))
    const [, init] = chatCalls().at(-1)
    expect(init.headers['X-Simulate-Failure']).toBe('key_1=429')
    expect(within(card).getByTestId('lab-actual').textContent).toBe('HTTP 200 · LIVE_INFERENCE · key_2 · 1 fallback')
    expect(within(card).getByTestId('lab-trace')).toHaveTextContent('key_1 failed (simulated 429)')
    // logged to the shared request log
    await user.click(screen.getByTestId('nav-traces'))
    expect(screen.getAllByTestId('trace-row')).toHaveLength(1)
  })

  it('shows FAIL when the response does not match', async () => {
    chatDefault = () => jsonResponse(200, reply()) // simulation ignored: key_1 answered
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByTestId('nav-lab'))
    await user.click(screen.getByTestId('lab-run-key1_500'))
    const card = screen.getByTestId('scenario-key1_500')
    await vi.waitFor(() => expect(within(card).getByTestId('lab-badge').textContent).toBe('FAIL'))
  })

  it('Run all runs every scenario in sequence', async () => {
    chatDefault = (url, init) => {
      const sim = init.headers['X-Simulate-Failure']
      if (sim === '*=429') return jsonResponse(503, { detail: 'all providers unavailable' })
      if (sim) return jsonResponse(200, reply({ key_id: 'key_2', fallback_attempts: 1 }))
      const body = JSON.parse(init.body)
      const seen = chatCalls().filter(([, i]) => JSON.parse(i.body).message === body.message).length
      return jsonResponse(200, seen > 1 ? reply({ resolution_source: 'LLM_CACHE', key_id: null, latency_ms: 2 }) : reply())
    }
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByTestId('nav-lab'))
    await user.click(screen.getByTestId('lab-run-all'))
    await vi.waitFor(() => expect(screen.getAllByTestId('lab-badge')).toHaveLength(5))
    expect(screen.getAllByTestId('lab-badge').map((b) => b.textContent)).toEqual(['PASS', 'PASS', 'PASS', 'PASS', 'PASS'])
    expect(chatCalls()).toHaveLength(6)
  })
})

describe('history, prompts, export', () => {
  it('history search filters by message text and reopening calls GET /sessions/{id}/messages', async () => {
    const user = userEvent.setup()
    render(<App />)
    const sidA = screen.getByTestId('session-id').textContent
    await typeAndSend(user, 'apples are red')
    await screen.findByTestId('assistant-message')
    await user.click(screen.getByTestId('new-chat-button'))
    await typeAndSend(user, 'bananas are yellow')
    await screen.findByTestId('assistant-message')

    await user.click(screen.getByTestId('nav-history'))
    expect(screen.getAllByTestId('history-item')).toHaveLength(2)
    await user.type(screen.getByTestId('history-search'), 'APPLE')
    const items = screen.getAllByTestId('history-item')
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent('apples are red')
    expect(items[0]).toHaveTextContent('2 messages saved')

    await user.click(items[0])
    expect(screen.getByTestId('nav-playground')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('session-id').textContent).toBe(sidA)
    expect((await screen.findByTestId('assistant-message')).textContent).toContain('reopened answer')
    const [url, init] = fetchMock.mock.calls.at(-1)
    expect(url).toBe(`http://localhost:8000/sessions/${sidA}/messages`)
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('prompt "Use" fills the system prompt and it is sent', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByTestId('nav-settings'))
    await user.click(screen.getByTestId('use-prompt-french'))
    expect(screen.getByTestId('nav-playground')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('system-prompt-input')).toHaveValue('Always answer in French, whatever language the question is in.')
    await typeAndSend(user, 'Hello')
    await screen.findByTestId('assistant-message')
    expect(JSON.parse(chatCalls().at(-1)[1].body).system_prompt).toBe('Always answer in French, whatever language the question is in.')
  })

  it('saved prompts survive a localStorage failure', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByTestId('nav-settings'))
    await user.type(screen.getByTestId('prompt-name'), 'Pirate')
    await user.type(screen.getByTestId('prompt-text'), 'Talk like a pirate.')
    await user.click(screen.getByTestId('prompt-save'))
    expect(screen.getByText('Pirate')).toBeInTheDocument()
    expect(screen.getByText(/saved prompts last only for this visit/)).toBeInTheDocument()
  })

  it('export produces valid JSON of the conversation', async () => {
    let blob
    const created = vi.fn((b) => {
      blob = b
      return 'blob:x'
    })
    vi.stubGlobal('URL', Object.assign(globalThis.URL, { createObjectURL: created, revokeObjectURL: () => {} }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const user = userEvent.setup()
    render(<App />)
    const sid = screen.getByTestId('session-id').textContent
    await typeAndSend(user, 'Hello')
    await screen.findByTestId('assistant-message')
    await user.click(screen.getByTestId('export-json'))
    expect(created).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(await blob.text())
    expect(parsed.session_id).toBe(sid)
    expect(parsed.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(parsed.messages[1].metadata.latency_ms).toBe(1212)
    expect(JSON.parse(JSON.stringify(buildChatExport('s-1', [{ role: 'user', text: 'x' }]))).messages).toEqual([
      { role: 'user', text: 'x' },
    ])
  })
})

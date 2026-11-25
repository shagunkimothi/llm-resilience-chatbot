import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App.jsx'

const OK_BODY = {
  session_id: 'x',
  reply: 'Hello there!\nSecond line',
  metadata: {
    resolution_source: 'LIVE_INFERENCE',
    model: 'gemini/gemini-3.5-flash-lite',
    latency_ms: 812,
    input_tokens: 42,
    output_tokens: 9,
    key_id: 'key_2',
    fallback_attempts: 1,
  },
}

function jsonResponse(status, body) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  )
}

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn(() => jsonResponse(200, OK_BODY))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const lastBody = () => JSON.parse(fetchMock.mock.calls.at(-1)[1].body)

async function typeAndSend(user, text) {
  await user.type(screen.getByTestId('chat-input'), text)
  await user.click(screen.getByTestId('send-button'))
}

describe('App', () => {
  it('renders required testids', () => {
    render(<App />)
    for (const id of ['chat-input', 'send-button', 'system-prompt-input']) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    expect(screen.getByTestId('chat-input').tagName).toBe('TEXTAREA')
  })

  it('clears the input immediately, shows the user bubble, disables send while pending', async () => {
    let resolve
    fetchMock.mockImplementation(() => new Promise((r) => (resolve = r)))
    const user = userEvent.setup()
    render(<App />)
    await typeAndSend(user, 'Hi bot')
    expect(screen.getByTestId('chat-input')).toHaveValue('')
    expect(screen.getByTestId('user-message')).toHaveTextContent('Hi bot')
    expect(screen.getByTestId('send-button')).toBeDisabled()
    expect(screen.getByTestId('thinking-indicator')).toHaveTextContent('Thinking…')
    resolve(new Response(JSON.stringify(OK_BODY), { status: 200 }))
    await screen.findByTestId('assistant-message')
    expect(screen.getByTestId('send-button')).not.toBeDisabled()
    expect(screen.queryByTestId('thinking-indicator')).toBeNull()
  })

  it('sends the correct request body without system_prompt when empty', async () => {
    const user = userEvent.setup()
    render(<App />)
    await typeAndSend(user, 'Hello')
    await screen.findByTestId('assistant-message')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8000/chat')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers['X-Simulate-Failure']).toBeUndefined()
    const body = lastBody()
    expect(Object.keys(body).sort()).toEqual(['message', 'session_id'])
    expect(body.message).toBe('Hello')
    expect(body.session_id).toMatch(/^s-[0-9a-f-]{36}$/)
  })

  it('includes system_prompt when non-empty', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByTestId('settings-toggle'))
    await user.type(screen.getByTestId('system-prompt-input'), 'Be terse.')
    await typeAndSend(user, 'Hello')
    await screen.findByTestId('assistant-message')
    expect(lastBody().system_prompt).toBe('Be terse.')
  })

  it('200 renders exactly one assistant-message with exact meta values', async () => {
    const user = userEvent.setup()
    render(<App />)
    await typeAndSend(user, 'Hello')
    await screen.findByTestId('assistant-message')
    const msgs = screen.getAllByTestId('assistant-message')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toHaveTextContent('Hello there!')
    expect(screen.getByTestId('meta-source').textContent).toBe('LIVE_INFERENCE')
    expect(screen.getByTestId('meta-model').textContent).toBe('gemini/gemini-3.5-flash-lite')
    expect(screen.getByTestId('meta-latency').textContent).toBe('812 ms')
    expect(screen.getByTestId('meta-input-tokens').textContent).toBe('42')
    expect(screen.getByTestId('meta-output-tokens').textContent).toBe('9')
    expect(screen.getByTestId('meta-key-id').textContent).toBe('key_2')
    expect(screen.getByTestId('meta-fallback-attempts').textContent).toBe('1')
    for (const id of ['meta-source', 'meta-model', 'meta-latency', 'meta-input-tokens', 'meta-output-tokens']) {
      expect(msgs[0]).toContainElement(screen.getByTestId(id))
    }
  })

  it('LLM_CACHE is styled differently and null key_id shows —', async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse(200, {
        ...OK_BODY,
        metadata: { ...OK_BODY.metadata, resolution_source: 'LLM_CACHE', key_id: null, fallback_attempts: 0 },
      }),
    )
    const user = userEvent.setup()
    render(<App />)
    await typeAndSend(user, 'Hello')
    const msg = await screen.findByTestId('assistant-message')
    expect(msg).toHaveClass('cached')
    expect(screen.getByTestId('meta-source').textContent).toBe('LLM_CACHE')
    expect(screen.getByTestId('meta-key-id').textContent).toBe('—')
  })

  it('Enter sends; Shift+Enter inserts a newline; empty input never sends', async () => {
    const user = userEvent.setup()
    render(<App />)
    const input = screen.getByTestId('chat-input')
    await user.type(input, '   ')
    await user.keyboard('{Enter}')
    await user.click(screen.getByTestId('send-button'))
    expect(fetchMock).not.toHaveBeenCalled()
    await user.clear(input)
    await user.type(input, 'line1')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(input, 'line2')
    expect(input).toHaveValue('line1\nline2')
    expect(fetchMock).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    await screen.findByTestId('assistant-message')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastBody().message).toBe('line1\nline2')
    expect(input).toHaveValue('')
  })

  it('503 shows a readable error and no assistant-message', async () => {
    fetchMock.mockImplementation(() => jsonResponse(503, { detail: 'all providers unavailable' }))
    const user = userEvent.setup()
    render(<App />)
    await typeAndSend(user, 'Hello')
    const err = await screen.findByTestId('error-message')
    expect(err).toHaveTextContent('All providers are unavailable right now. Please try again.')
    expect(screen.queryByTestId('assistant-message')).toBeNull()
    expect(screen.getByTestId('send-button')).not.toBeDisabled()
  })

  it('422 with array detail joins .msg values', async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse(422, {
        detail: [
          { loc: ['body', 'message'], msg: 'String should have at most 4000 characters', type: 'string_too_long' },
          { loc: ['body', 'session_id'], msg: 'Field required', type: 'missing' },
        ],
      }),
    )
    const user = userEvent.setup()
    render(<App />)
    await typeAndSend(user, 'Hello')
    const err = await screen.findByTestId('error-message')
    expect(err.textContent).toBe('Invalid message: String should have at most 4000 characters; Field required')
    expect(screen.queryByTestId('assistant-message')).toBeNull()
  })

  it('422 with string detail', async () => {
    fetchMock.mockImplementation(() => jsonResponse(422, { detail: 'too long' }))
    const user = userEvent.setup()
    render(<App />)
    await typeAndSend(user, 'Hello')
    expect((await screen.findByTestId('error-message')).textContent).toBe('Invalid message: too long')
  })

  it('network failure shows a readable error and no assistant-message', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')))
    const user = userEvent.setup()
    render(<App />)
    await typeAndSend(user, 'Hello')
    const err = await screen.findByTestId('error-message')
    expect(err.textContent).toBe("Can't reach the server at http://localhost:8000.")
    expect(screen.queryByTestId('assistant-message')).toBeNull()
  })

  it('other statuses show the HTTP code', async () => {
    fetchMock.mockImplementation(() => jsonResponse(502, { detail: 'upstream provider error' }))
    const user = userEvent.setup()
    render(<App />)
    await typeAndSend(user, 'Hello')
    expect((await screen.findByTestId('error-message')).textContent).toBe('Something went wrong (HTTP 502).')
  })

  it('sends X-Simulate-Failure from the Developer select', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByTestId('settings-toggle'))
    await user.selectOptions(screen.getByTestId('simulate-select'), 'key_1=429,key_2=500')
    await typeAndSend(user, 'Hello')
    await screen.findByTestId('assistant-message')
    expect(fetchMock.mock.calls[0][1].headers['X-Simulate-Failure']).toBe('key_1=429,key_2=500')
  })

  it('session_id starts with "s-" and differs per mount', async () => {
    const user = userEvent.setup()
    const first = render(<App />)
    await typeAndSend(user, 'a')
    await screen.findByTestId('assistant-message')
    const sid1 = lastBody().session_id
    first.unmount()

    render(<App />)
    await typeAndSend(user, 'b')
    await screen.findByTestId('assistant-message')
    const sid2 = lastBody().session_id

    expect(sid1).toMatch(/^s-/)
    expect(sid2).toMatch(/^s-/)
    expect(sid1).not.toBe(sid2)
    expect(screen.getByTestId('session-id').textContent).toBe(sid2)
  })

  it('New chat starts a fresh session and clears messages', async () => {
    const user = userEvent.setup()
    render(<App />)
    const before = screen.getByTestId('session-id').textContent
    await typeAndSend(user, 'a')
    await screen.findByTestId('assistant-message')
    await user.click(screen.getByTestId('new-chat-button'))
    expect(screen.getByTestId('session-id').textContent).not.toBe(before)
    expect(screen.queryByTestId('assistant-message')).toBeNull()
    expect(screen.queryByTestId('user-message')).toBeNull()
  })

  it('lists sessions from this visit and switching loads history via GET /sessions/{id}/messages', async () => {
    const HISTORY_META = { ...OK_BODY.metadata, resolution_source: 'LLM_CACHE', latency_ms: 5, key_id: null, fallback_attempts: 0 }
    fetchMock.mockImplementation((url, init) => {
      if (!init || !init.method || init.method === 'GET') {
        const sid = decodeURIComponent(url.split('/sessions/')[1].split('/')[0])
        return jsonResponse(200, {
          session_id: sid,
          messages: [
            { role: 'user', content: 'first question' },
            { role: 'assistant', content: 'stored answer', metadata: HISTORY_META },
          ],
        })
      }
      return jsonResponse(200, OK_BODY)
    })
    const user = userEvent.setup()
    render(<App />)
    const sidA = screen.getByTestId('session-id').textContent
    await typeAndSend(user, 'first question')
    await screen.findByTestId('assistant-message')

    await user.click(screen.getByTestId('new-chat-button'))
    const sidB = screen.getByTestId('session-id').textContent
    expect(sidB).not.toBe(sidA)
    await typeAndSend(user, 'second question')
    await screen.findByTestId('assistant-message')

    const items = screen.getAllByTestId('session-item')
    expect(items.map((i) => i.textContent)).toEqual(['second question', 'first question'])
    expect(items[0]).toHaveAttribute('aria-current', 'true')

    await user.click(items[1])
    expect(screen.getByTestId('session-id').textContent).toBe(sidA)
    expect((await screen.findByTestId('assistant-message')).textContent).toContain('stored answer')
    const [url, init] = fetchMock.mock.calls.at(-1)
    expect(url).toBe(`http://localhost:8000/sessions/${sidA}/messages`)
    expect(init?.method ?? 'GET').toBe('GET')
    expect(screen.getByTestId('user-message')).toHaveTextContent('first question')
    expect(screen.getByTestId('meta-source').textContent).toBe('LLM_CACHE')
    expect(screen.getByTestId('meta-latency').textContent).toBe('5 ms')
    expect(screen.getByTestId('meta-key-id').textContent).toBe('—')
    expect(screen.getAllByTestId('session-item')[1]).toHaveAttribute('aria-current', 'true')
  })

  it('shows the brand, and labels an empty session "Untitled chat" until the first message', async () => {
    const user = userEvent.setup()
    render(<App />)
    const brand = screen.getByTestId('brand')
    expect(brand).toHaveTextContent('Resilix')
    expect(brand).toHaveTextContent('Reliable AI. Intelligent Recovery.')

    const [item] = screen.getAllByTestId('session-item')
    expect(item.textContent).toBe('Untitled chat')
    expect(item.querySelector('.session-title')).toHaveClass('untitled')
    expect(screen.getByTestId('new-chat-button')).toHaveTextContent('New chat')

    await typeAndSend(user, 'A fairly long first message that should be truncated in the list')
    await screen.findByTestId('assistant-message')
    const titled = screen.getAllByTestId('session-item')[0]
    expect(titled.textContent).toBe('A fairly long first message that shou…')
    expect(titled.querySelector('.session-title')).not.toHaveClass('untitled')
  })

  it('shows a readable error when loading a session fails', async () => {
    fetchMock.mockImplementation((url, init) =>
      init?.method === 'POST' ? jsonResponse(200, OK_BODY) : jsonResponse(500, { detail: 'boom' }),
    )
    const user = userEvent.setup()
    render(<App />)
    await typeAndSend(user, 'hello')
    await screen.findByTestId('assistant-message')
    await user.click(screen.getByTestId('new-chat-button'))
    await typeAndSend(user, 'again')
    await screen.findByTestId('assistant-message')
    await user.click(screen.getAllByTestId('session-item')[1])
    expect((await screen.findByTestId('error-message')).textContent).toBe("Couldn't load this chat (HTTP 500).")
    expect(screen.queryByTestId('assistant-message')).toBeNull()
  })

  it('suggestion cards fill the input and the failover card sets simulate', async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(screen.getByRole('heading', { name: 'What would you like to ask?' })).toBeInTheDocument()

    await user.click(screen.getByTestId('suggestion-ask'))
    expect(screen.getByTestId('chat-input')).toHaveValue('What is the capital of France?')
    expect(screen.getByTestId('simulate-select')).toHaveValue('')

    await user.clear(screen.getByTestId('chat-input'))
    await user.click(screen.getByTestId('suggestion-cache'))
    expect(screen.getByTestId('chat-input')).toHaveValue('What is the capital of France?')
    expect(screen.getByTestId('suggestion-cache')).toHaveTextContent('LLM_CACHE')

    await user.click(screen.getByTestId('suggestion-failover'))
    expect(screen.getByTestId('simulate-select')).toHaveValue('key_1=429')
    expect(screen.getByTestId('chat-input').value.length).toBeGreaterThan(0)
    expect(screen.getByTestId('system-prompt-input')).toBeVisible()

    await user.click(screen.getByTestId('send-button'))
    await screen.findByTestId('assistant-message')
    expect(fetchMock.mock.calls[0][1].headers['X-Simulate-Failure']).toBe('key_1=429')
    expect(screen.queryByTestId('suggestion-ask')).toBeNull()
  })

  it('model chip shows the default, then the last reply model; send button is labelled', async () => {
    fetchMock.mockImplementation(() => jsonResponse(200, { ...OK_BODY, metadata: { ...OK_BODY.metadata, model: 'gemini/other-model' } }))
    const user = userEvent.setup()
    render(<App />)
    expect(screen.getByTestId('model-chip').textContent).toBe('gemini/gemini-3.5-flash-lite')
    expect(screen.getByRole('button', { name: 'Send' })).toBe(screen.getByTestId('send-button'))
    expect(screen.getByTestId('chat-input')).toHaveAttribute('placeholder', 'Ask anything…')
    await typeAndSend(user, 'hi')
    await screen.findByTestId('assistant-message')
    expect(screen.getByTestId('model-chip').textContent).toBe('gemini/other-model')
  })

  it('renders replies as plain text, never HTML', async () => {
    fetchMock.mockImplementation(() => jsonResponse(200, { ...OK_BODY, reply: '<b>bold</b><img src=x>' }))
    const user = userEvent.setup()
    render(<App />)
    await typeAndSend(user, 'Hello')
    const msg = await screen.findByTestId('assistant-message')
    expect(msg.querySelector('b, img')).toBeNull()
    expect(msg).toHaveTextContent('<b>bold</b><img src=x>')
  })
})

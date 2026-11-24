import { useEffect, useRef, useState } from 'react'
import { getHistory, newSessionId, sendChat } from './api.js'
import { ArrowUpIcon, BrandIcon, ChatIcon, ChevronIcon, CloseIcon, DatabaseIcon, MenuIcon, PlusIcon, ShuffleIcon, SparkIcon } from './icons.jsx'

const DEFAULT_MODEL = 'gemini/gemini-3.5-flash-lite'

const SIMULATE_OPTIONS = [
  { label: 'None', value: '' },
  { label: 'key_1=429', value: 'key_1=429' },
  { label: 'key_1=500', value: 'key_1=500' },
  { label: 'key_1=429,key_2=500', value: 'key_1=429,key_2=500' },
  { label: '*=429', value: '*=429' },
]

const SUGGESTIONS = [
  {
    id: 'ask',
    title: 'Ask anything',
    text: 'Start with a simple question to get a live reply.',
    Icon: SparkIcon,
    input: 'What is the capital of France?',
  },
  {
    id: 'cache',
    title: 'See the cache',
    text: 'Send the same first message in a new chat and the reply comes back as LLM_CACHE.',
    Icon: DatabaseIcon,
    input: 'What is the capital of France?',
  },
  {
    id: 'failover',
    title: 'Test failover',
    text: 'Simulates a 429 on key_1, so the reply is served by key_2.',
    Icon: ShuffleIcon,
    input: 'Explain API key failover in one sentence.',
    simulate: 'key_1=429',
  },
]

let nextId = 1
const uid = () => nextId++
const truncate = (s, n = 38) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

function Pill({ label, testid, value, tone }) {
  return (
    <span className={`pill${tone ? ` pill-${tone}` : ''}`}>
      <span className="pill-label">{label}</span>
      <span className="pill-value" data-testid={testid}>
        {value}
      </span>
    </span>
  )
}

function AssistantMessage({ text, metadata: m }) {
  if (!m) {
    return (
      <div className="msg assistant" data-testid="assistant-message">
        <div className="msg-text">{text}</div>
      </div>
    )
  }
  const cached = m.resolution_source === 'LLM_CACHE'
  return (
    <div className={`msg assistant${cached ? ' cached' : ''}`} data-testid="assistant-message">
      <div className="msg-text">{text}</div>
      <div className="meta">
        <Pill label="Source" testid="meta-source" value={m.resolution_source} tone={cached ? 'cache' : 'live'} />
        <Pill label="Model" testid="meta-model" value={m.model} />
        <Pill label="Latency" testid="meta-latency" value={`${m.latency_ms} ms`} />
        <Pill label="In" testid="meta-input-tokens" value={String(m.input_tokens)} />
        <Pill label="Out" testid="meta-output-tokens" value={String(m.output_tokens)} />
        <Pill label="Key" testid="meta-key-id" value={m.key_id ?? '—'} />
        <Pill label="Fallbacks" testid="meta-fallback-attempts" value={String(m.fallback_attempts ?? 0)} />
      </div>
    </div>
  )
}

function MessageView({ msg }) {
  if (msg.role === 'user') {
    return (
      <div className="msg user" data-testid="user-message">
        {msg.text}
      </div>
    )
  }
  if (msg.role === 'error') {
    return (
      <div className="msg error" data-testid="error-message" role="alert">
        {msg.text}
      </div>
    )
  }
  return <AssistantMessage text={msg.text} metadata={msg.metadata} />
}

export default function App() {
  const [sessionId, setSessionId] = useState(newSessionId)
  const [sessions, setSessions] = useState(() => [{ id: sessionId, title: null }])
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [simulate, setSimulate] = useState('')
  const [pending, setPending] = useState(false)
  const [loading, setLoading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const endRef = useRef(null)
  const inputRef = useRef(null)
  const sessionRef = useRef(sessionId)

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })
  }, [messages, pending])

  const add = (msg) => setMessages((prev) => [...prev, { id: uid(), ...msg }])
  const lastModel = [...messages].reverse().find((m) => m.metadata?.model)?.metadata.model ?? DEFAULT_MODEL
  const isEmpty = messages.length === 0 && !pending && !loading

  function activate(sid) {
    sessionRef.current = sid
    setSessionId(sid)
    setMessages([])
    setPending(false)
    setDrawerOpen(false)
  }

  async function send() {
    const text = input
    if (pending || loading || !text.trim()) return
    const sid = sessionId
    setInput('')
    add({ role: 'user', text })
    setSessions((prev) => prev.map((s) => (s.id === sid && !s.title ? { ...s, title: truncate(text) } : s)))
    setPending(true)
    try {
      const data = await sendChat({ sessionId: sid, message: text, systemPrompt, simulate })
      if (sessionRef.current !== sid) return // user switched chats meanwhile
      add({ role: 'assistant', text: data.reply, metadata: data.metadata })
    } catch (err) {
      if (sessionRef.current !== sid) return
      add({ role: 'error', text: err?.message || 'Something went wrong.' })
    } finally {
      if (sessionRef.current === sid) setPending(false)
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  function newChat() {
    const sid = newSessionId()
    // Drop untitled (never-used) chats so the list only shows real conversations plus the new one.
    setSessions((prev) => [{ id: sid, title: null }, ...prev.filter((s) => s.title)])
    activate(sid)
    setInput('')
    setLoading(false)
  }

  async function openSession(s) {
    if (s.id === sessionId) {
      setDrawerOpen(false)
      return
    }
    activate(s.id)
    if (!s.title) return // nothing sent yet, nothing to load
    setLoading(true)
    try {
      const history = await getHistory(s.id)
      if (sessionRef.current !== s.id) return
      setMessages(history.map((m) => ({ id: uid(), ...m })))
    } catch (err) {
      if (sessionRef.current !== s.id) return
      setMessages([{ id: uid(), role: 'error', text: err?.message || "Couldn't load this chat." }])
    } finally {
      if (sessionRef.current === s.id) setLoading(false)
    }
  }

  function applySuggestion(sg) {
    setInput(sg.input)
    if (sg.simulate) {
      setSimulate(sg.simulate)
      setSettingsOpen(true)
    }
    inputRef.current?.focus()
  }

  return (
    <div className="shell">
      <aside className={`sidebar card${drawerOpen ? ' open' : ''}`} aria-label="Chat history">
        <div className="brand-row">
          <div className="brand" data-testid="brand">
            <span className="brand-mark">
              <BrandIcon />
            </span>
            <span className="brand-text">
              <span className="brand-name">Resilient Chat</span>
              <span className="brand-tagline">Key failover · response caching</span>
            </span>
          </div>
          <button type="button" className="icon-btn drawer-close" aria-label="Close menu" onClick={() => setDrawerOpen(false)}>
            <CloseIcon />
          </button>
        </div>
        <h2 className="sidebar-title">Chat history</h2>
        <button type="button" className="btn-primary new-chat" onClick={newChat} data-testid="new-chat-button">
          <PlusIcon />
          New chat
        </button>

        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={`session-item${s.id === sessionId ? ' active' : ''}`}
                data-testid="session-item"
                aria-current={s.id === sessionId ? 'true' : undefined}
                title={s.title || 'Untitled chat'}
                onClick={() => openSession(s)}
              >
                <ChatIcon />
                <span className={`session-title${s.title ? '' : ' untitled'}`}>{s.title || 'Untitled chat'}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className={`settings${settingsOpen ? ' open' : ''}`}>
          <button
            type="button"
            className="settings-toggle"
            aria-expanded={settingsOpen}
            aria-controls="settings-panel"
            onClick={() => setSettingsOpen((o) => !o)}
            data-testid="settings-toggle"
          >
            <span>Settings</span>
            {simulate && <span className="badge">simulating</span>}
            <ChevronIcon />
          </button>
          <div id="settings-panel" className="settings-body" hidden={!settingsOpen}>
            <label className="field">
              <span>System prompt (optional)</span>
              <textarea
                data-testid="system-prompt-input"
                rows={3}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="e.g. You are a concise assistant."
              />
            </label>
            <label className="field">
              <span>Developer: simulate failure</span>
              <select data-testid="simulate-select" value={simulate} onChange={(e) => setSimulate(e.target.value)}>
                {SIMULATE_OPTIONS.map((o) => (
                  <option key={o.label} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </aside>
      {drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}

      <section className={`main card${isEmpty ? ' empty' : ''}`}>
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label="Open menu" onClick={() => setDrawerOpen(true)}>
            <MenuIcon />
          </button>
          <span className="model-chip" data-testid="model-chip" title="Model">
            {lastModel}
          </span>
          <span className="session">
            <span className="session-label">Session</span>
            <code data-testid="session-id">{sessionId}</code>
          </span>
        </header>

        <div className="body">
          {isEmpty ? (
            <div className="hero">
              <h1>What would you like to ask?</h1>
              <p>Resilient Chat retries across API keys and caches answers, with the details shown on every reply.</p>
            </div>
          ) : (
            <div className="messages" aria-live="polite">
              {loading && <p className="loading">Loading conversation…</p>}
              {messages.map((m) => (
                <MessageView key={m.id} msg={m} />
              ))}
              {pending && (
                <div className="msg assistant thinking" data-testid="thinking-indicator">
                  <span className="dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="sr-only">Thinking…</span>
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <textarea
            ref={inputRef}
            data-testid="chat-input"
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask anything…"
            aria-label="Message"
          />
          <button type="submit" className="send" data-testid="send-button" aria-label="Send" disabled={pending}>
            <ArrowUpIcon />
          </button>
        </form>

        {isEmpty && (
          <div className="suggestions">
            {SUGGESTIONS.map((sg) => (
              <button
                key={sg.id}
                type="button"
                className="suggestion"
                data-testid={`suggestion-${sg.id}`}
                onClick={() => applySuggestion(sg)}
              >
                <span className="tile">
                  <sg.Icon />
                </span>
                <span className="suggestion-title">{sg.title}</span>
                <span className="suggestion-text">{sg.text}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

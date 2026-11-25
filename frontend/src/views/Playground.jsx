import { useEffect, useRef } from 'react'
import { ArrowUpIcon, ChevronIcon, DatabaseIcon, DownloadIcon, ShuffleIcon, SparkIcon } from '../icons.jsx'
import { buildChatExport, chatToText, failoverLine } from '../lib/metrics.js'

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
  const line = failoverLine(m)
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
      {line && (
        <p className={`failover-line${cached ? ' is-cache' : ''}`} data-testid="failover-line">
          {line}
        </p>
      )}
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

function download(filename, text, type) {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL?.(url), 0)
}

export default function Playground({
  sessionId,
  messages,
  pending,
  loading,
  input,
  setInput,
  systemPrompt,
  setSystemPrompt,
  simulate,
  setSimulate,
  settingsOpen,
  setSettingsOpen,
  lastModel,
  onSend,
}) {
  const endRef = useRef(null)
  const inputRef = useRef(null)
  const isEmpty = messages.length === 0 && !pending && !loading

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })
  }, [messages, pending])

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onSend()
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

  function exportChat(kind) {
    const exp = buildChatExport(sessionId, messages)
    if (kind === 'json') download(`resilix-${sessionId}.json`, JSON.stringify(exp, null, 2), 'application/json')
    else download(`resilix-${sessionId}.txt`, chatToText(exp), 'text/plain')
  }

  return (
    <section className={`playground card${isEmpty ? ' empty' : ''}`} aria-label="Playground">
      <header className="pg-bar">
        <span className="model-chip" data-testid="model-chip" title="Model">
          {lastModel}
        </span>
        <span className="session">
          <span className="session-label">Session</span>
          <code data-testid="session-id">{sessionId}</code>
        </span>
        <span className="pg-actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => exportChat('json')}
            disabled={!messages.length}
            data-testid="export-json"
          >
            <DownloadIcon />
            Export JSON
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => exportChat('txt')}
            disabled={!messages.length}
            data-testid="export-txt"
          >
            <DownloadIcon />
            TXT
          </button>
        </span>
      </header>

      <div className="body">
        {isEmpty ? (
          <div className="hero">
            <h1>What would you like to ask?</h1>
            <p>Resilix retries across API keys and caches answers, with the details shown on every reply.</p>
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

      <div className={`settings${settingsOpen ? ' open' : ''}`}>
        <button
          type="button"
          className="settings-toggle"
          aria-expanded={settingsOpen}
          aria-controls="settings-panel"
          onClick={() => setSettingsOpen((o) => !o)}
          data-testid="settings-toggle"
        >
          <span>Request settings</span>
          {systemPrompt.trim() && <span className="badge badge-neutral">system prompt</span>}
          {simulate && <span className="badge badge-warn">simulating {simulate}</span>}
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
            <span>Developer: simulate failure (X-Simulate-Failure)</span>
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

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          onSend()
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
  )
}

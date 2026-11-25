import { useCallback, useEffect, useRef, useState } from 'react'
import { getHealth, getHistory, newSessionId, postChat } from './api.js'
import { StatusPill } from './components.jsx'
import {
  BrandIcon,
  ChatIcon,
  ClockIcon,
  CloseIcon,
  DatabaseIcon,
  FlaskIcon,
  GearIcon,
  GridIcon,
  MenuIcon,
  PlayIcon,
  PlusIcon,
  PulseIcon,
  TraceIcon,
} from './icons.jsx'
import { loadSavedPrompts, storeSavedPrompts } from './lib/prompts.js'
import { SCENARIOS } from './lib/scenarios.js'
import CacheAnalytics from './views/CacheAnalytics.jsx'
import History from './views/History.jsx'
import Monitoring from './views/Monitoring.jsx'
import Overview from './views/Overview.jsx'
import Playground from './views/Playground.jsx'
import Settings from './views/Settings.jsx'
import TestingLab from './views/TestingLab.jsx'
import Traces from './views/Traces.jsx'

const DEFAULT_MODEL = 'gemini/gemini-3.5-flash-lite'
const HEALTH_INTERVAL_MS = 60_000

const NAV = [
  { id: 'playground', label: 'Playground', Icon: PlayIcon },
  { id: 'overview', label: 'Overview', Icon: GridIcon },
  { id: 'monitoring', label: 'Monitoring', Icon: PulseIcon },
  { id: 'traces', label: 'Request traces', Icon: TraceIcon },
  { id: 'cache', label: 'Cache analytics', Icon: DatabaseIcon },
  { id: 'history', label: 'History', Icon: ClockIcon },
  { id: 'lab', label: 'Testing lab', Icon: FlaskIcon },
  { id: 'settings', label: 'Settings', Icon: GearIcon },
]

let nextId = 1
const uid = () => nextId++
const truncate = (s, n = 38) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/**
 * monitorHealth: poll GET /health on mount and every 60 s (main.jsx turns it on). When off,
 * the status pill still checks on demand.
 */
export default function App({ monitorHealth = false }) {
  const [view, setView] = useState('playground')
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Playground
  const [sessionId, setSessionId] = useState(newSessionId)
  const [sessions, setSessions] = useState(() => [{ id: sessionId, title: null }])
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [simulate, setSimulate] = useState('')
  const [pending, setPending] = useState(false)
  const [loading, setLoading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const sessionRef = useRef(sessionId)

  // Shared, in-memory only: lives for this page visit.
  const [log, setLog] = useState([])
  const [health, setHealth] = useState(null)
  const [checking, setChecking] = useState(false)
  const [labResults, setLabResults] = useState({})
  const [labRunning, setLabRunning] = useState(false)
  const [prices, setPrices] = useState({ input: 0, output: 0 })
  const [savedPrompts, setSavedPrompts] = useState(loadSavedPrompts)
  const [storageOk, setStorageOk] = useState(true)

  const refreshHealth = useCallback(async () => {
    setHealth(await getHealth())
  }, [])

  async function checkHealth() {
    setChecking(true)
    await refreshHealth()
    setChecking(false)
  }

  useEffect(() => {
    if (!monitorHealth) return undefined
    let live = true
    const poll = () => getHealth().then((h) => live && setHealth(h))
    poll()
    const t = setInterval(poll, HEALTH_INTERVAL_MS)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [monitorHealth])

  const keysConfigured = health?.data?.keys_configured ?? null

  /** Send one /chat request, append it to the shared request log and return the log entry. */
  const runChat = useCallback(async ({ sessionId: sid, message, systemPrompt: sp, simulate: sim, origin = 'playground' }) => {
    const time = Date.now()
    const r = await postChat({ sessionId: sid, message, systemPrompt: sp, simulate: sim })
    const entry = {
      id: uid(),
      time,
      sessionId: sid,
      message,
      simulate: sim || '',
      origin,
      httpStatus: r.httpStatus,
      ok: r.ok,
      roundTripMs: r.roundTripMs,
      metadata: r.ok ? r.data.metadata : null,
      reply: r.ok ? r.data.reply : null,
      error: r.error,
      request: r.request,
      response: r.data,
    }
    setLog((prev) => [...prev, entry])
    return entry
  }, [])

  const add = (msg) => setMessages((prev) => [...prev, { id: uid(), ...msg }])
  const lastModelSeen =
    [...messages].reverse().find((m) => m.metadata?.model)?.metadata.model ??
    [...log].reverse().find((e) => e.metadata?.model)?.metadata.model ??
    null
  const lastModel = [...messages].reverse().find((m) => m.metadata?.model)?.metadata.model ?? DEFAULT_MODEL

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
    const e = await runChat({ sessionId: sid, message: text, systemPrompt, simulate })
    if (sessionRef.current !== sid) return // user switched chats meanwhile
    if (e.ok) add({ role: 'assistant', text: e.reply, metadata: e.metadata })
    else add({ role: 'error', text: e.error || 'Something went wrong.' })
    setPending(false)
  }

  function newChat() {
    const sid = newSessionId()
    // Drop untitled (never-used) chats so the list only shows real conversations plus the new one.
    setSessions((prev) => [{ id: sid, title: null }, ...prev.filter((s) => s.title)])
    activate(sid)
    setInput('')
    setLoading(false)
    setView('playground')
  }

  async function openSession(s) {
    setView('playground')
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

  const labChat = useCallback((args) => runChat({ ...args, origin: 'lab' }), [runChat])

  async function runScenario(id) {
    const sc = SCENARIOS.find((s) => s.id === id)
    setLabResults((prev) => ({ ...prev, [id]: { running: true } }))
    const result = await sc.run(labChat)
    setLabResults((prev) => ({ ...prev, [id]: { running: false, ...result } }))
  }

  async function runLab(ids) {
    if (labRunning) return
    setLabRunning(true)
    try {
      for (const id of ids) await runScenario(id)
    } finally {
      setLabRunning(false)
    }
  }

  function savePrompts(list) {
    setSavedPrompts(list)
    setStorageOk(storeSavedPrompts(list))
  }

  function applyPrompt(text) {
    setSystemPrompt(text)
    setSettingsOpen(true)
    setView('playground')
  }

  function go(id) {
    setView(id)
    setDrawerOpen(false)
  }

  const current = NAV.find((n) => n.id === view)

  return (
    <div className="shell">
      <aside className={`sidebar${drawerOpen ? ' open' : ''}`} aria-label="Navigation">
        <div className="brand-row">
          <div className="brand" data-testid="brand">
            <span className="brand-mark">
              <BrandIcon />
            </span>
            <span className="brand-text">
              <span className="brand-name">Resilix</span>
              <span className="brand-tagline">Reliable AI. Intelligent Recovery.</span>
            </span>
          </div>
          <button type="button" className="icon-btn drawer-close" aria-label="Close menu" onClick={() => setDrawerOpen(false)}>
            <CloseIcon />
          </button>
        </div>

        <StatusPill health={health} checking={checking || (monitorHealth && !health)} onCheck={checkHealth} />

        <nav className="nav" aria-label="Views">
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`nav-item${view === n.id ? ' active' : ''}`}
              aria-current={view === n.id ? 'page' : undefined}
              onClick={() => go(n.id)}
              data-testid={`nav-${n.id}`}
            >
              <n.Icon />
              <span>{n.label}</span>
              {n.id === 'traces' && log.length > 0 && <span className="nav-count">{log.length}</span>}
            </button>
          ))}
        </nav>

        <div className="conversations">
          <h2 className="sidebar-title">Conversations</h2>
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
        </div>
      </aside>
      {drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}

      <main className="main">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label="Open menu" onClick={() => setDrawerOpen(true)}>
            <MenuIcon />
          </button>
          <span className="topbar-title">{current.label}</span>
        </header>

        {view === 'playground' && (
          <Playground
            sessionId={sessionId}
            messages={messages}
            pending={pending}
            loading={loading}
            input={input}
            setInput={setInput}
            systemPrompt={systemPrompt}
            setSystemPrompt={setSystemPrompt}
            simulate={simulate}
            setSimulate={setSimulate}
            settingsOpen={settingsOpen}
            setSettingsOpen={setSettingsOpen}
            lastModel={lastModel}
            onSend={send}
          />
        )}
        {view === 'overview' && <Overview log={log} prices={prices} />}
        {view === 'monitoring' && <Monitoring log={log} health={health} lastModel={lastModelSeen} />}
        {view === 'traces' && <Traces log={log} keysConfigured={keysConfigured} />}
        {view === 'cache' && <CacheAnalytics log={log} />}
        {view === 'history' && <History sessions={sessions} log={log} currentId={sessionId} onOpen={openSession} />}
        {view === 'lab' && (
          <TestingLab
            results={labResults}
            running={labRunning}
            onRun={(id) => runLab([id])}
            onRunAll={() => runLab(SCENARIOS.map((s) => s.id))}
            keysConfigured={keysConfigured}
          />
        )}
        {view === 'settings' && (
          <Settings
            savedPrompts={savedPrompts}
            onSavePrompts={savePrompts}
            onUsePrompt={applyPrompt}
            prices={prices}
            setPrices={setPrices}
            storageOk={storageOk}
          />
        )}
      </main>
    </div>
  )
}

import { useState } from 'react'
import { EmptyState, ViewHeader } from '../components.jsx'
import { SearchIcon } from '../icons.jsx'
import { fmtTime } from '../lib/metrics.js'

export default function History({ sessions, log, currentId, onOpen }) {
  const [q, setQ] = useState('')
  const items = sessions
    .filter((s) => s.title)
    .map((s) => {
      const entries = log.filter((e) => e.sessionId === s.id)
      return {
        session: s,
        entries,
        last: entries.length ? Math.max(...entries.map((e) => e.time)) : null,
        // Only successful exchanges are stored by the backend (user + assistant).
        count: entries.filter((e) => e.ok).length * 2,
        haystack: entries
          .flatMap((e) => [e.message, e.reply || ''])
          .join('\n')
          .toLowerCase(),
      }
    })
  const needle = q.trim().toLowerCase()
  const shown = needle ? items.filter((i) => i.haystack.includes(needle)) : items

  return (
    <div className="view" data-testid="view-history">
      <ViewHeader title="History">Conversations started in this page visit. Open one to reload it from the server.</ViewHeader>
      <label className="search">
        <SearchIcon />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search message text…"
          aria-label="Search conversations"
          data-testid="history-search"
        />
      </label>
      {!items.length ? (
        <EmptyState title="No conversations yet">Conversations appear here after their first message.</EmptyState>
      ) : !shown.length ? (
        <EmptyState title="No matches">No message in this visit contains “{q.trim()}”.</EmptyState>
      ) : (
        <ul className="history-list">
          {shown.map((i) => (
            <li key={i.session.id}>
              <button
                type="button"
                className={`history-item card${i.session.id === currentId ? ' active' : ''}`}
                onClick={() => onOpen(i.session)}
                data-testid="history-item"
              >
                <span className="history-title">{i.session.title}</span>
                <span className="history-meta">
                  {fmtTime(i.last)} · {i.count} message{i.count === 1 ? '' : 's'} saved
                  {i.session.id === currentId ? ' · open now' : ''}
                </span>
                <code className="history-id">{i.session.id}</code>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="note">Deleting conversations isn&apos;t available: the API has no delete endpoint.</p>
    </div>
  )
}

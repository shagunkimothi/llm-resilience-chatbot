import { useState } from 'react'
import { EmptyState, JsonBlock, SourceBadge, TraceTimeline, ViewHeader } from '../components.jsx'
import { classify, fmtTime, isFallback } from '../lib/metrics.js'

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'live', label: 'Live', test: (e) => classify(e) === 'live' },
  { id: 'cache', label: 'Cache', test: (e) => classify(e) === 'cache' },
  { id: 'fallback', label: 'Fallback', test: isFallback },
  { id: 'failed', label: 'Failed', test: (e) => classify(e) === 'failed' },
]

export default function Traces({ log, keysConfigured }) {
  const [filter, setFilter] = useState('all')
  const [selectedId, setSelectedId] = useState(null)
  const f = FILTERS.find((x) => x.id === filter)
  const rows = [...log].reverse().filter(f.test)
  const selected = log.find((e) => e.id === selectedId) ?? null

  return (
    <div className="view" data-testid="view-traces">
      <ViewHeader title="Request traces">Every /chat attempt from this page visit, newest first. Select a row to inspect it.</ViewHeader>
      <div className="filters" role="group" aria-label="Filter traces">
        {FILTERS.map((x) => (
          <button
            key={x.id}
            type="button"
            className={`chip${filter === x.id ? ' active' : ''}`}
            aria-pressed={filter === x.id}
            onClick={() => setFilter(x.id)}
            data-testid={`trace-filter-${x.id}`}
          >
            {x.label} <span className="chip-count">{log.filter(x.test).length}</span>
          </button>
        ))}
      </div>
      {!log.length ? (
        <EmptyState title="No requests yet">Traces appear here as soon as a message is sent.</EmptyState>
      ) : (
        <div className="split">
          <div className="card panel">
            {!rows.length ? (
              <p className="note">No requests match this filter.</p>
            ) : (
              <div className="table-wrap">
                <table className="table clickable" data-testid="trace-table">
                  <thead>
                    <tr>
                      <th scope="col">Time</th>
                      <th scope="col">Source</th>
                      <th scope="col">Key</th>
                      <th scope="col">Fallbacks</th>
                      <th scope="col">Latency</th>
                      <th scope="col">Tokens</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr
                        key={e.id}
                        className={e.id === selectedId ? 'selected' : ''}
                        onClick={() => setSelectedId(e.id)}
                        data-testid="trace-row"
                      >
                        <td>
                          <button type="button" className="row-btn" onClick={() => setSelectedId(e.id)}>
                            {fmtTime(e.time)}
                          </button>
                        </td>
                        <td>{e.metadata ? <SourceBadge source={e.metadata.resolution_source} /> : <span className="muted">—</span>}</td>
                        <td>{e.metadata?.key_id ?? '—'}</td>
                        <td>{e.metadata ? e.metadata.fallback_attempts : '—'}</td>
                        <td>{e.metadata ? `${e.metadata.latency_ms} ms` : `${e.roundTripMs} ms (client)`}</td>
                        <td>{e.metadata ? `${e.metadata.input_tokens} / ${e.metadata.output_tokens}` : '—'}</td>
                        <td>
                          <span className={`badge ${e.ok ? 'badge-ok' : 'badge-fail'}`}>{e.httpStatus ?? 'network'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <aside className="card panel inspector" data-testid="trace-inspector" aria-label="Trace inspector">
            {!selected ? (
              <p className="note">Select a request to see its step timeline and raw JSON.</p>
            ) : (
              <>
                <h2 className="panel-title">Trace · {fmtTime(selected.time)}</h2>
                <p className="note">
                  Session <code>{selected.sessionId}</code>
                  {selected.origin === 'lab' ? ' · Testing lab' : ''}
                </p>
                <TraceTimeline entry={selected} keysConfigured={keysConfigured} />
                <JsonBlock label="Request" value={selected.request} testid="trace-request-json" />
                <JsonBlock
                  label={`Response${selected.httpStatus ? ` (HTTP ${selected.httpStatus})` : ''}`}
                  value={selected.response ?? { error: selected.error }}
                  testid="trace-response-json"
                />
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}

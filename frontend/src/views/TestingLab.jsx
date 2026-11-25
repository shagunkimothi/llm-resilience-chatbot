import { TraceTimeline, ViewHeader } from '../components.jsx'
import { SCENARIOS } from '../lib/scenarios.js'

function Badge({ result }) {
  if (!result) return <span className="badge badge-neutral">Not run</span>
  if (result.running) return <span className="badge badge-neutral">Running…</span>
  return result.pass ? (
    <span className="badge badge-ok" data-testid="lab-badge">
      PASS
    </span>
  ) : (
    <span className="badge badge-fail" data-testid="lab-badge">
      FAIL
    </span>
  )
}

export default function TestingLab({ results, running, onRun, onRunAll, keysConfigured }) {
  return (
    <div className="view" data-testid="view-lab">
      <ViewHeader title="Testing lab">
        Each scenario sends real /chat requests (in new sessions) and compares the response with what the resilience layer
        should do. Every request is added to Request traces.
      </ViewHeader>
      <div className="lab-actions">
        <button type="button" className="btn-primary" onClick={onRunAll} disabled={running} data-testid="lab-run-all">
          {running ? 'Running…' : 'Run all'}
        </button>
      </div>
      <div className="lab-grid">
        {SCENARIOS.map((sc) => {
          const r = results[sc.id]
          return (
            <article key={sc.id} className="card panel scenario" data-testid={`scenario-${sc.id}`}>
              <div className="scenario-head">
                <h2 className="panel-title">{sc.name}</h2>
                <Badge result={r} />
              </div>
              <p className="note">{sc.description}</p>
              <p className="note">
                Header: <code>{sc.header ? `X-Simulate-Failure: ${sc.header}` : 'none'}</code>
              </p>
              <dl className="kv compact">
                <div>
                  <dt>Expected</dt>
                  <dd>{sc.expected}</dd>
                </div>
                <div>
                  <dt>Actual</dt>
                  <dd data-testid="lab-actual">{r && !r.running ? r.actual : '—'}</dd>
                </div>
              </dl>
              {r && !r.running && r.entries.length > 0 && (
                <TraceTimeline entry={r.entries[r.entries.length - 1]} keysConfigured={keysConfigured} testid="lab-trace" />
              )}
              <button
                type="button"
                className="btn-ghost"
                onClick={() => onRun(sc.id)}
                disabled={running}
                data-testid={`lab-run-${sc.id}`}
              >
                Run scenario
              </button>
            </article>
          )
        })}
      </div>
    </div>
  )
}

import { ViewHeader } from '../components.jsx'
import { fmtTime, keyStats } from '../lib/metrics.js'

const STATUS_TONE = {
  Healthy: 'ok',
  Recovered: 'warn',
  Failing: 'fail',
  'No data': 'neutral',
}
const HEALTH_LABEL = { ok: 'System operational', degraded: 'Degraded', unreachable: 'Unreachable' }

export default function Monitoring({ log, health, lastModel }) {
  const keysConfigured = health?.data?.keys_configured ?? null
  const rows = keyStats(log, keysConfigured)
  const cacheEnabled = health?.data?.cache_enabled
  return (
    <div className="view" data-testid="view-monitoring">
      <ViewHeader title="Monitoring">
        Per-key health is derived from this session&apos;s requests: answers each key served, and failures inferred from
        fallbacks, simulations and 503s. Status follows each key&apos;s most recent event; simulated failures are counted
        but never change the status.
      </ViewHeader>
      <div className="card panel provider">
        <h2 className="panel-title">Provider</h2>
        <dl className="kv">
          <div>
            <dt>Model</dt>
            <dd data-testid="provider-model">{lastModel ?? 'No replies yet'}</dd>
          </div>
          <div>
            <dt>Keys configured</dt>
            <dd data-testid="provider-keys">{keysConfigured ?? '—'}</dd>
          </div>
          <div>
            <dt>Cache</dt>
            <dd data-testid="provider-cache">{cacheEnabled === undefined ? '—' : cacheEnabled ? 'Enabled' : 'Disabled'}</dd>
          </div>
          <div>
            <dt>Health</dt>
            <dd>{health ? `${HEALTH_LABEL[health.state]}${health.detail ? ` (${health.detail})` : ''}` : 'Not checked yet'}</dd>
          </div>
          <div>
            <dt>Last checked</dt>
            <dd>{health ? fmtTime(health.checkedAt) : '—'}</dd>
          </div>
        </dl>
        <p className="note">Model is taken from the replies; key count and cache state come from GET /health.</p>
      </div>
      <div className="card panel">
        <h2 className="panel-title">API keys</h2>
        {!rows.length ? (
          <p className="note">No key information yet: /health has not reported a key count and no replies have arrived.</p>
        ) : (
          <div className="table-wrap">
            <table className="table" data-testid="key-table">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Answers served</th>
                  <th scope="col">Failures observed</th>
                  <th scope="col">Last success</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} data-testid={`key-row-${r.key}`}>
                    <td>
                      <code>{r.key}</code>
                    </td>
                    <td>{r.served}</td>
                    <td>
                      {r.failures}
                      {r.simulated ? <span className="muted"> ({r.simulated} simulated)</span> : null}
                    </td>
                    <td>{fmtTime(r.lastSuccess)}</td>
                    <td>
                      <span className={`badge badge-${STATUS_TONE[r.status]}`} data-testid="key-status">
                        {r.status}
                      </span>
                      {r.onlySimulated && (
                        <span className="status-note" data-testid="key-status-note">
                          only simulated failures
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

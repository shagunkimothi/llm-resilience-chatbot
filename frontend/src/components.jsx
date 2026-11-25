import { useState } from 'react'
import { RefreshIcon } from './icons.jsx'
import { fmtTime, traceSteps } from './lib/metrics.js'

const HEALTH_TEXT = {
  idle: 'Not checked yet',
  checking: 'Checking…',
  ok: 'System operational',
  degraded: 'Degraded',
  unreachable: 'Unreachable',
}

export function StatusPill({ health, checking, onCheck }) {
  const state = checking && !health ? 'checking' : health?.state ?? 'idle'
  const title = health
    ? `${HEALTH_TEXT[health.state]}${health.detail ? ` (${health.detail})` : ''} · checked ${fmtTime(health.checkedAt)}`
    : HEALTH_TEXT[state]
  return (
    <div className="status-row">
      <span className={`status-pill status-${state}`} data-testid="status-pill" data-state={state} title={title}>
        <span className="status-dot" aria-hidden="true" />
        <span data-testid="status-text">{HEALTH_TEXT[state]}</span>
      </span>
      <button
        type="button"
        className="icon-btn small"
        onClick={onCheck}
        disabled={checking}
        aria-label="Re-check system status"
        data-testid="status-refresh"
        title="Re-check now"
      >
        <RefreshIcon />
      </button>
    </div>
  )
}

export function SourceBadge({ source }) {
  if (source === 'LLM_CACHE') return <span className="badge badge-cache">LLM_CACHE</span>
  if (source === 'LIVE_INFERENCE') return <span className="badge badge-live">LIVE_INFERENCE</span>
  return <span className="badge badge-fail">{source || 'ERROR'}</span>
}

export function EmptyState({ title, children }) {
  return (
    <div className="empty-state" data-testid="empty-state">
      <p className="empty-title">{title}</p>
      {children && <p className="empty-text">{children}</p>}
    </div>
  )
}

export function StatCard({ label, value, sub, testid, tone }) {
  return (
    <div className={`stat card${tone ? ` stat-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value" data-testid={testid}>
        {value}
      </span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  )
}

export function ViewHeader({ title, children }) {
  return (
    <div className="view-header">
      <div>
        <h1 className="view-title">{title}</h1>
        {children && <p className="view-sub">{children}</p>}
      </div>
      <span className="scope-chip">This session</span>
    </div>
  )
}

const topPath = (x, y, w, h, r) => {
  const rr = Math.min(r, w / 2, h)
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}

/**
 * Stacked SVG bar chart. bars: [{ id, label, values: { [seriesKey]: number } }].
 * series: [{ key, label, color }] in stacking order (bottom first).
 */
export function BarChart({ bars, series, unit = '', ariaLabel, testid, height = 200 }) {
  const [hover, setHover] = useState(null)
  const W = 640
  const H = height
  const pad = { l: 44, r: 8, t: 10, b: 26 }
  const totals = bars.map((b) => series.reduce((a, s) => a + (b.values[s.key] || 0), 0))
  const rawMax = Math.max(1, ...totals)
  const step = niceStep(rawMax)
  const max = Math.ceil(rawMax / step) * step
  const ticks = []
  for (let v = 0; v <= max; v += step) ticks.push(v)
  const innerW = W - pad.l - pad.r
  const innerH = H - pad.t - pad.b
  const slot = innerW / Math.max(bars.length, 1)
  const bw = Math.max(2, Math.min(36, slot * 0.7))
  const y = (v) => pad.t + innerH - (v / max) * innerH
  const labelEvery = Math.ceil(bars.length / 8)
  const hovered = hover !== null ? bars[hover] : null

  return (
    <figure className="chart" data-testid={testid}>
      <div className="chart-head">
        <ul className="legend">
          {series.map((s) => (
            <li key={s.key}>
              <span className="swatch" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
        <span className="chart-readout" aria-live="polite">
          {hovered
            ? `${hovered.label}: ${series.map((s) => `${s.label} ${fmtNum(hovered.values[s.key] || 0)}${unit}`).join(' · ')}`
            : 'Hover a bar for values'}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} className="chart-svg">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="axis-text">
              {fmtNum(t)}
            </text>
          </g>
        ))}
        {bars.map((b, i) => {
          const x = pad.l + i * slot + (slot - bw) / 2
          let acc = 0
          const segs = series.filter((s) => (b.values[s.key] || 0) > 0)
          return (
            <g
              key={b.id}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className={hover === i ? 'bar hovered' : 'bar'}
            >
              <rect x={pad.l + i * slot} y={pad.t} width={slot} height={innerH} fill="transparent" />
              {segs.map((s, j) => {
                const v = b.values[s.key]
                const y0 = y(acc)
                acc += v
                const y1 = y(acc)
                const gap = j > 0 ? 2 : 0
                const h = Math.max(0, y0 - y1 - gap)
                const top = j === segs.length - 1
                return top ? (
                  <path key={s.key} d={topPath(x, y1, bw, h, 4)} fill={s.color} />
                ) : (
                  <rect key={s.key} x={x} y={y1 + gap} width={bw} height={h} fill={s.color} />
                )
              })}
              <title>{`${b.label}: ${series.map((s) => `${s.label} ${fmtNum(b.values[s.key] || 0)}${unit}`).join(', ')}`}</title>
              {i % labelEvery === 0 && (
                <text x={x + bw / 2} y={H - 8} textAnchor="middle" className="axis-text">
                  {b.short ?? b.label}
                </text>
              )}
            </g>
          )
        })}
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="baseline" />
      </svg>
      <details className="chart-table">
        <summary>Show as table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Bucket</th>
              {series.map((s) => (
                <th scope="col" key={s.key}>
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bars.map((b) => (
              <tr key={b.id}>
                <td>{b.label}</td>
                {series.map((s) => (
                  <td key={s.key}>
                    {fmtNum(b.values[s.key] || 0)}
                    {unit}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}

function niceStep(max) {
  const raw = max / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const n = raw / mag
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return Math.max(1, m * mag)
}
const fmtNum = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })

export function TraceTimeline({ entry, keysConfigured, testid = 'trace-timeline' }) {
  const steps = traceSteps(entry, keysConfigured)
  return (
    <ol className="timeline" data-testid={testid}>
      {steps.map((s, i) => (
        <li key={i} className={`step step-${s.tone}`} data-testid="trace-step">
          <span className="step-dot" aria-hidden="true" />
          <span className="step-label">{s.label}</span>
        </li>
      ))}
    </ol>
  )
}

export function JsonBlock({ label, value, testid }) {
  return (
    <div className="json-block">
      <span className="json-label">{label}</span>
      <pre data-testid={testid}>{JSON.stringify(value, null, 2)}</pre>
    </div>
  )
}

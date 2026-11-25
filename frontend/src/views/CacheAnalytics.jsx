import { BarChart, EmptyState, StatCard, ViewHeader } from '../components.jsx'
import { SERIES, cacheStats, fmtInt, fmtMs, fmtPct, fmtTime } from '../lib/metrics.js'

const LAT_SERIES = [
  { key: 'live', ...SERIES.live },
  { key: 'cache', ...SERIES.cache },
]

export default function CacheAnalytics({ log }) {
  const s = cacheStats(log)
  const recent = s.points.slice(-40)
  return (
    <div className="view" data-testid="view-cache">
      <ViewHeader title="Cache analytics">
        A cache hit is a reply with source LLM_CACHE. Requests with a failure simulation bypass the cache and are not counted
        as misses.
      </ViewHeader>
      {!s.hits && !s.misses ? (
        <EmptyState title="No cache lookups yet">
          Send the same first message in two new chats to see a cache hit.
          {s.bypassed ? ` ${s.bypassed} simulated request(s) bypassed the cache.` : ''}
        </EmptyState>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard label="Cache hits" value={fmtInt(s.hits)} testid="cache-hits" />
            <StatCard label="Cache misses" value={fmtInt(s.misses)} sub={`${s.bypassed} bypassed by simulation`} testid="cache-misses" />
            <StatCard label="Hit rate" value={fmtPct(s.hitRate)} testid="cache-hit-rate" />
            <StatCard label="Avg cache latency" value={fmtMs(s.avgCache)} testid="cache-avg-cache" />
            <StatCard label="Avg live latency" value={fmtMs(s.avgLive)} testid="cache-avg-live" />
            <StatCard
              label="Time saved (estimated)"
              value={fmtMs(s.timeSaved)}
              sub="hits × (avg live − avg cache)"
              testid="cache-time-saved"
            />
          </div>
          <div className="card panel">
            <h2 className="panel-title">Server latency per reply (last {recent.length})</h2>
            <BarChart
              testid="chart-cache"
              unit=" ms"
              ariaLabel="Server latency per reply, colored by live inference or cache"
              series={LAT_SERIES}
              bars={recent.map((p, i) => ({
                id: p.id,
                label: `#${s.points.length - recent.length + i + 1} ${fmtTime(p.time)}`,
                short: `#${s.points.length - recent.length + i + 1}`,
                values: { [p.kind]: p.latency },
              }))}
            />
          </div>
        </>
      )}
    </div>
  )
}

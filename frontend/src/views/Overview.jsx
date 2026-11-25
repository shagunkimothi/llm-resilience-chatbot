import { BarChart, EmptyState, StatCard, ViewHeader } from '../components.jsx'
import { SERIES, fmtInt, fmtMs, fmtPct, overviewStats, perMinute } from '../lib/metrics.js'

const SERIES_ORDER = ['live', 'cache', 'failed'].map((k) => ({ key: k, ...SERIES[k] }))
const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export default function Overview({ log, prices }) {
  const s = overviewStats(log, prices)
  const priced = Number(prices.input) > 0 || Number(prices.output) > 0
  return (
    <div className="view" data-testid="view-overview">
      <ViewHeader title="Overview">Every number below comes from /chat requests sent from this page since it loaded.</ViewHeader>
      {!log.length ? (
        <EmptyState title="No requests yet">Send a message in the Playground or run a Testing lab scenario to see metrics.</EmptyState>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard label="Total requests" value={fmtInt(s.total)} testid="stat-total" />
            <StatCard label="Successful" value={fmtInt(s.successful)} testid="stat-successful" tone="ok" />
            <StatCard label="Failed" value={fmtInt(s.failed)} testid="stat-failed" tone={s.failed ? 'fail' : undefined} />
            <StatCard label="Success rate" value={fmtPct(s.successRate)} testid="stat-success-rate" />
            <StatCard
              label="Avg latency (live)"
              value={fmtMs(s.avgLiveLatency)}
              sub={`Client round trip avg ${fmtMs(s.avgRoundTrip)}`}
              testid="stat-avg-latency"
            />
            <StatCard label="Cache hit rate" value={fmtPct(s.cacheHitRate)} sub="of successful replies" testid="stat-cache-rate" />
            <StatCard
              label="Fallback events"
              value={fmtInt(s.fallbackEvents)}
              sub={`${s.fallbackRequests} request${s.fallbackRequests === 1 ? '' : 's'} recovered by failover`}
              testid="stat-fallbacks"
            />
            <StatCard
              label="Tokens (live)"
              value={`${fmtInt(s.inputTokens)} in / ${fmtInt(s.outputTokens)} out`}
              sub={`Cache replies: ${fmtInt(s.cachedInput)} in / ${fmtInt(s.cachedOutput)} out (not billed)`}
              testid="stat-tokens"
            />
            <StatCard
              label="Estimated cost"
              value={`$${s.estimatedCost.toFixed(4)}`}
              sub={priced ? 'live tokens × your Settings prices' : 'Set token prices in Settings'}
              testid="stat-cost"
            />
          </div>
          <div className="card panel">
            <h2 className="panel-title">Requests per minute</h2>
            <BarChart
              testid="chart-rpm"
              ariaLabel="Requests per minute, stacked by live inference, cache and failed"
              series={SERIES_ORDER}
              bars={perMinute(log).map((b) => ({
                id: b.t,
                label: fmtClock(b.t),
                short: fmtClock(b.t),
                values: { live: b.live, cache: b.cache, failed: b.failed },
              }))}
            />
          </div>
        </>
      )}
    </div>
  )
}

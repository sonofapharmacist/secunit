"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Info, RefreshCw, Clock, Cpu, DollarSign, Zap } from "lucide-react";

// ─── Types — field names match ObservabilityReport.ts JSON output exactly ───

interface TripwireResult {
  name: string;
  status: "WARN" | "OK" | "INFO";
  value: string | number;
  threshold: string | number;
  message: string;
}

interface PromptProcessingMetrics {
  n: number;
  dateRange: { first: string; last: string };
  modeDist: Record<string, { count: number; pct: number }>;
  tierDist: Record<string, number>;
  failSafe: { count: number; rate: number; maxPerSession: number };
  latency: { p50: number; p75: number; p90: number; p95: number; p99: number; over15sCount: number; over15sPct: number } | null;
}

interface InferenceMetrics {
  n: number;
  dateRange: { first: string; last: string };
  backendDist: Record<string, { count: number; pct: number }>;
  latencyP50: Record<string, number> | null;
  escalation: { attempted: number; stayedLocal: number; escalated: number; localSuccessRate: number };
}

interface ModelEntry { count: number; pct: number; totalCost: number }
interface SessionCostMetrics {
  n: number;
  dateRange: { first: string; last: string };
  modelDist: Record<string, ModelEntry>;
  totalSpend: number;
  avgSessionCost: number;
  cacheHitRate: number;
  topProjects: Array<{ project: string; sessionCount: number; totalCost: number }>;
}

interface HealthReport {
  status?: string;
  hint?: string;
  schemaVersion?: number;
  generatedAt?: string;
  mode?: string;
  window?: { since: string | null; first: string; last: string };
  tripwires?: TripwireResult[];
  promptProcessing?: PromptProcessingMetrics | { status: string };
  inferenceCalls?: InferenceMetrics | { status: string };
  sessionCosts?: SessionCostMetrics | { status: string };
}

// ─── Helpers ───

const font = { fontFamily: "'concourse-t3', sans-serif" };
const labelStyle = { fontFamily: "'advocate-c14', sans-serif" };

function pct(n: number, alreadyPct = false) {
  return `${(alreadyPct ? n : n * 100).toFixed(1)}%`;
}
function ms(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`; }
function usd(n: number) { return `$${n.toFixed(2)}`; }
function ago(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return `${Math.floor(diff / 60_000)}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── Tripwire Badge ───

function TripwireBadge({ tw }: { tw: TripwireResult }) {
  const isWarn = tw.status === "WARN";
  const isInfo = tw.status === "INFO";
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-lg border ${
      isWarn ? "bg-red-500/5 border-red-500/20"
      : isInfo ? "bg-slate-800/40 border-slate-700/30"
      : "bg-emerald-500/5 border-emerald-500/15"
    }`}>
      <div className="mt-0.5 shrink-0">
        {isWarn ? <AlertTriangle className="w-4 h-4 text-red-400" />
          : isInfo ? <Info className="w-4 h-4 text-slate-500" />
          : <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
      </div>
      <div className="min-w-0">
        <div className={`text-[11px] uppercase tracking-widest mb-0.5 ${isWarn ? "text-red-400" : isInfo ? "text-slate-500" : "text-emerald-400"}`} style={labelStyle}>
          {tw.name}
        </div>
        <div className="text-[13px] text-slate-300" style={font}>{tw.message}</div>
      </div>
    </div>
  );
}

// ─── Stat Cell ───

function Stat({ icon: Icon, label, value, sub, warn }: {
  icon: typeof Clock; label: string; value: string; sub?: string; warn?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 rounded-lg bg-slate-900/50 border border-slate-800/40">
      <div className="flex items-center gap-1.5 text-slate-500">
        <Icon className="w-3 h-3" />
        <span className="text-[11px] uppercase tracking-widest" style={labelStyle}>{label}</span>
      </div>
      <div className={`text-lg font-semibold tabular-nums ${warn ? "text-red-400" : "text-white"}`} style={font}>
        {value}
      </div>
      {sub && <div className="text-[12px] text-slate-600" style={font}>{sub}</div>}
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <h2 className="text-[11px] uppercase tracking-widest text-slate-500 mb-3" style={labelStyle}>{title}</h2>;
}

// ─── Main ───

export default function ObservabilityPage() {
  const { data, isLoading, isError, dataUpdatedAt, refetch, isFetching } = useQuery<HealthReport>({
    queryKey: ["observability-health"],
    queryFn: async () => {
      const res = await fetch("/api/observability/health");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
    refetchInterval: 300_000,
  });

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-slate-600 text-sm" style={font}>Loading…</div>;
  }

  if (isError || !data) {
    return <div className="flex items-center justify-center h-64 text-red-400 text-sm" style={font}>Failed to load observability data</div>;
  }

  if (data.status === "no-report") {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-slate-500">
        <Info className="w-8 h-8" />
        <p className="text-sm" style={font}>No weekly report yet.</p>
        <p className="text-xs text-slate-600" style={font}>{data.hint}</p>
      </div>
    );
  }

  const pp = (data.promptProcessing && !("status" in data.promptProcessing)) ? data.promptProcessing as PromptProcessingMetrics : null;
  const ic = (data.inferenceCalls && !("status" in data.inferenceCalls)) ? data.inferenceCalls as InferenceMetrics : null;
  const sc = (data.sessionCosts && !("status" in data.sessionCosts)) ? data.sessionCosts as SessionCostMetrics : null;

  const warnCount = data.tripwires?.filter((t) => t.status === "WARN").length ?? 0;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white tracking-wide" style={labelStyle}>PAI HEALTH</h1>
          <p className="text-[13px] text-slate-500 mt-1" style={font}>
            {data.generatedAt ? `Last check ${ago(data.generatedAt)}` : "Tripwire report"}
            {data.window?.since ? ` · since ${data.window.since.slice(0, 10)}` : ""}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/40 text-slate-400 hover:text-white hover:bg-slate-700/60 transition-colors text-[12px] disabled:opacity-40"
          style={font}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Tripwires */}
      <div>
        <div className="flex items-center gap-3 mb-3">
          <SectionHeader title="Tripwires" />
          {warnCount > 0 && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/20 -mt-3" style={labelStyle}>
              {warnCount} WARN
            </span>
          )}
        </div>
        <div className="space-y-2">
          {data.tripwires?.map((tw) => <TripwireBadge key={tw.name} tw={tw} />) ?? (
            <p className="text-slate-600 text-sm" style={font}>No tripwire data</p>
          )}
        </div>
      </div>

      {/* Classifier health */}
      {pp && (
        <div>
          <SectionHeader title="Classifier" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat
              icon={AlertTriangle}
              label="Fail-safe rate"
              value={pct(pp.failSafe.rate)}
              sub={`${pp.failSafe.count} / ${pp.n} prompts`}
              warn={pp.failSafe.rate > 0.05}
            />
            <Stat
              icon={Clock}
              label="P95 latency"
              value={pp.latency ? ms(pp.latency.p95) : "—"}
              sub={pp.latency ? `P50 ${ms(pp.latency.p50)}` : undefined}
              warn={pp.latency ? pp.latency.p95 > 30_000 : false}
            />
            <Stat
              icon={Clock}
              label="Over 15s"
              value={pp.latency ? pct(pp.latency.over15sPct, true) : "—"}
              sub={pp.latency ? `${pp.latency.over15sCount} prompts` : undefined}
              warn={pp.latency ? pp.latency.over15sPct > 25 : false}
            />
            <Stat
              icon={Cpu}
              label="Max fail-safe/session"
              value={String(pp.failSafe.maxPerSession)}
              warn={pp.failSafe.maxPerSession > 3}
            />
          </div>
          <div className="mt-3 px-4 py-3 rounded-lg bg-slate-900/50 border border-slate-800/40">
            <div className="text-[11px] uppercase tracking-widest text-slate-500 mb-2" style={labelStyle}>Mode split (N={pp.n})</div>
            <div className="flex items-center gap-4 flex-wrap">
              {Object.entries(pp.modeDist).map(([mode, entry]) => (
                <div key={mode} className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${mode === "ALGORITHM" ? "bg-violet-400" : mode === "NATIVE" ? "bg-sky-400" : "bg-slate-500"}`} />
                  <span className="text-[13px] text-slate-400" style={font}>
                    {mode} <span className="text-white font-medium">{pct(entry.pct, true)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Inference routing */}
      {ic && (
        <div>
          <SectionHeader title="Inference Routing" />
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Stat
              icon={Zap}
              label="Local inference success"
              value={pct(ic.escalation.localSuccessRate)}
              sub={`${ic.escalation.stayedLocal} / ${ic.escalation.attempted} attempts`}
              warn={ic.escalation.localSuccessRate < 0.6}
            />
            <Stat
              icon={Clock}
              label="Local P50"
              value={ic.latencyP50 ? ms(ic.latencyP50["local"] ?? 0) : "—"}
              sub={ic.latencyP50 ? `Claude P50 ${ms(ic.latencyP50["claude"] ?? 0)}` : undefined}
            />
            <Stat
              icon={Cpu}
              label="Backend split"
              value={`${pct((ic.backendDist["local"]?.count ?? 0) / ic.n)} local`}
              sub={`N=${ic.n} calls`}
            />
          </div>
        </div>
      )}

      {/* Session costs */}
      {sc && (
        <div>
          <SectionHeader title="Session Cost" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat icon={DollarSign} label="Total spend" value={usd(sc.totalSpend)} sub={`${sc.n} sessions`} />
            <Stat icon={DollarSign} label="Avg/session" value={usd(sc.avgSessionCost)} />
            <Stat
              icon={Zap}
              label="Cache hit rate"
              value={pct(sc.cacheHitRate)}
              warn={sc.cacheHitRate < 0.7}
            />
            <Stat
              icon={Cpu}
              label="Sonnet share"
              value={pct(
                Object.entries(sc.modelDist)
                  .filter(([m]) => m.includes("sonnet"))
                  .reduce((s, [, v]) => s + v.pct, 0),
                true
              )}
              sub="of sessions"
            />
          </div>
          {Object.keys(sc.modelDist).length > 0 && (
            <div className="mt-3 px-4 py-3 rounded-lg bg-slate-900/50 border border-slate-800/40">
              <div className="text-[11px] uppercase tracking-widest text-slate-500 mb-2" style={labelStyle}>Cost by model</div>
              <div className="space-y-1.5">
                {Object.entries(sc.modelDist)
                  .sort(([, a], [, b]) => b.totalCost - a.totalCost)
                  .map(([model, entry]) => (
                    <div key={model} className="flex items-center justify-between gap-4">
                      <span className="text-[13px] text-slate-400 truncate" style={font}>{model}</span>
                      <span className="text-[13px] text-white tabular-nums shrink-0" style={font}>{usd(entry.totalCost)}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="text-[12px] text-slate-700 pt-2 border-t border-slate-800/30" style={font}>
        Report by <span className="font-mono text-slate-600">ObservabilityReport.ts</span> · cron Sun 03:15
        {dataUpdatedAt ? ` · fetched ${ago(new Date(dataUpdatedAt).toISOString())}` : ""}
      </div>
    </div>
  );
}

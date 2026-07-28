import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Clock3,
  Files,
  Gauge,
  Layers3,
  RefreshCw,
  Rows3,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { AnalyticsChart } from "@/components/analytics-charts";
import type { DesktopAPI, TaskAnalyticsSummary, TaskHistoryStatus } from "../../../preload";

type AnalyticsPageProps = {
  api: DesktopAPI | null;
  dark: boolean;
  revision: number;
  onOpenBatch: (batchId: string) => void;
};

const STATUS_LABELS: Record<TaskHistoryStatus, string> = {
  running: "处理中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  interrupted: "已中断",
};

const emptyAnalytics: TaskAnalyticsSummary = {
  totals: {
    batches: 0,
    files: 0,
    rows: 0,
    matchedRows: 0,
    matchRate: null,
    exceptions: 0,
    averageDurationMs: null,
  },
  trend: [],
  statuses: [],
  issues: [],
  records: [],
};

function dateInputValue(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  const seconds = value / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${Math.round(seconds % 60)} 秒`;
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function AnalyticsPage({ api, dark, revision, onOpenBatch }: AnalyticsPageProps): React.JSX.Element {
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90 | "custom">(30);
  const [from, setFrom] = useState(dateInputValue(29));
  const [to, setTo] = useState(dateInputValue(0));
  const [data, setData] = useState(emptyAnalytics);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<void> => {
    if (!api) return;
    setLoading(true);
    setError("");
    try {
      setData(await api.getTaskAnalytics({ from, to }));
    } catch (reason) {
      setError(`读取统计数据失败：${String(reason)}`);
    } finally {
      setLoading(false);
    }
  }, [api, from, to]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const chooseRange = (days: 7 | 30 | 90): void => {
    setRangeDays(days);
    setFrom(dateInputValue(days - 1));
    setTo(dateInputValue(0));
  };

  const metrics = [
    { label: "处理批次", value: data.totals.batches || "—", detail: "所选时间范围", icon: Layers3, tone: "info" },
    { label: "处理文件", value: data.totals.files || "—", detail: "累计文件", icon: Files, tone: "confirm" },
    { label: "处理总行数", value: data.totals.rows || "—", detail: "订单数据行", icon: Rows3, tone: "neutral" },
    { label: "匹配率", value: formatRate(data.totals.matchRate), detail: "匹配行 ÷ 总行数", icon: Gauge, tone: "success" },
    { label: "异常行", value: data.totals.rows > 0 ? data.totals.exceptions : "—", detail: "需要复核", icon: AlertTriangle, tone: "error" },
    { label: "平均批次耗时", value: formatDuration(data.totals.averageDurationMs), detail: "仅统计已结束批次", icon: Clock3, tone: "warning" },
  ];
  const hasData = data.totals.batches > 0;

  return (
    <div className="history-page analytics-page" role="region" aria-label="数据统计">
      <div className="analytics-page-scroll">
        <section className="analytics-filter-bar" aria-label="统计时间范围">
          <div className="analytics-range-presets">{([7, 30, 90] as const).map((days) => <button type="button" className={rangeDays === days ? "is-active" : undefined} key={days} onClick={() => chooseRange(days)}>近 {days} 天</button>)}<button type="button" className={rangeDays === "custom" ? "is-active" : undefined} onClick={() => setRangeDays("custom")}>自定义</button></div>
          <div className="analytics-filter-tools">
            <div className="analytics-custom-range">
              <div className="history-date-field"><span>开始</span><DatePicker ariaLabel="开始日期" value={from} onValueChange={(value) => { setRangeDays("custom"); setFrom(value); }} /></div>
              <div className="history-date-field"><span>结束</span><DatePicker ariaLabel="结束日期" value={to} onValueChange={(value) => { setRangeDays("custom"); setTo(value); }} /></div>
            </div>
            <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "is-spinning" : undefined} />刷新</Button>
          </div>
        </section>

        {error ? <div className="history-error">{error}</div> : null}
        <section className="analytics-metrics" aria-label="处理统计指标">
          {metrics.map(({ label, value, detail, icon: Icon, tone }) => <article className={`is-${tone}`} key={label}><div><Icon /><span>{label}</span></div><strong>{value}</strong><small>{detail}</small></article>)}
        </section>

        {!loading && !hasData ? <div className="analytics-empty"><BarChart3 /><strong>所选时间范围内没有处理记录</strong><span>完成一次核价后，这里会显示趋势与异常分布。</span></div> : null}
        {hasData ? (
          <>
            <section className="analytics-grid">
              <article className="analytics-panel analytics-trend-panel"><header><h2>处理量与匹配率</h2><span>按天统计</span></header><AnalyticsChart data={data} dark={dark} kind="trend" /></article>
              <article className="analytics-panel"><header><h2>批次状态</h2><span>运行结果构成</span></header><AnalyticsChart data={data} dark={dark} kind="status" /></article>
              <article className="analytics-panel"><header><h2>异常原因</h2><span>{data.issues.length > 0 ? "按异常行数排序" : "旧记录可能没有异常明细"}</span></header>{data.issues.length > 0 ? <AnalyticsChart data={data} dark={dark} kind="issues" /> : <div className="compact-empty">暂无可统计的异常分类</div>}</article>
            </section>

            <section className="analytics-panel analytics-records">
              <header><h2>批次明细</h2><span>点击批次查看完整日志</span></header>
              <div className="batch-table-wrap">
                <table>
                  <thead><tr><th>开始时间</th><th>状态</th><th>文件</th><th>总行数</th><th>匹配率</th><th>异常</th><th>耗时</th></tr></thead>
                  <tbody>{data.records.map((record) => <tr key={record.id} tabIndex={0} onClick={() => onOpenBatch(record.id)} onKeyDown={(event) => { if (event.key === "Enter") onOpenBatch(record.id); }}><td>{new Date(record.startedAt).toLocaleString("zh-CN", { hour12: false })}</td><td><span className={`history-status is-${record.status}`}>{STATUS_LABELS[record.status]}</span></td><td className="history-number is-info">{record.totalFiles}</td><td className="history-number is-primary">{record.totalRows || "—"}</td><td className="history-number is-success">{record.totalRows > 0 ? `${(record.matchedRows / record.totalRows * 100).toFixed(1)}%` : "—"}</td><td className="history-number is-error">{record.exceptionRows}</td><td className="history-number is-confirm">{formatDuration(record.durationMs ?? null)}</td></tr>)}</tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

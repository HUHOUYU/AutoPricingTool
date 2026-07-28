import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Files,
  Gauge,
  Layers3,
  RefreshCw,
  Rows3,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { AnalyticsChart } from "@/components/analytics-charts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { DesktopAPI, TaskAnalyticsSummary, TaskHistoryStatus } from "../../../preload";

type AnalyticsPageProps = {
  api: DesktopAPI | null;
  dark: boolean;
  revision: number;
  onOpenBatch: (batchId: string) => void;
};

const STATUS_LABELS: Record<TaskHistoryStatus, string> = {
  running: "处理中",
  awaiting_confirmation: "待处理",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  interrupted: "已中断",
};
const ANALYTICS_DEFAULT_PAGE_SIZE = 10;
const ANALYTICS_PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
const ANALYTICS_RANGE_OPTIONS = [30, 60, 90] as const;
type AnalyticsRangeDays = (typeof ANALYTICS_RANGE_OPTIONS)[number] | "custom";

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

function batchTitle(record: TaskAnalyticsSummary["records"][number]): string {
  if (record.name?.trim()) return record.name.trim();
  const names = record.fileNames ?? [];
  if (names.length === 1) return names[0]!;
  if (names.length > 1) return `${names[0]} 等 ${names.length} 个文件`;
  return `批次 ${record.id.slice(-8)}`;
}

export function AnalyticsPage({ api, dark, revision, onOpenBatch }: AnalyticsPageProps): React.JSX.Element {
  const [rangeDays, setRangeDays] = useState<AnalyticsRangeDays>(30);
  const [from, setFrom] = useState(dateInputValue(29));
  const [to, setTo] = useState(dateInputValue(0));
  const [data, setData] = useState(emptyAnalytics);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [recordPage, setRecordPage] = useState(1);
  const [recordPageSize, setRecordPageSize] = useState(ANALYTICS_DEFAULT_PAGE_SIZE);
  const [search, setSearch] = useState("");

  const load = useCallback(async (): Promise<void> => {
    if (!api) return;
    setLoading(true);
    setError("");
    try {
      setData(await api.getTaskAnalytics({ from, to, search }));
    } catch (reason) {
      setError(`读取统计数据失败：${String(reason)}`);
    } finally {
      setLoading(false);
    }
  }, [api, from, search, to]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  useEffect(() => {
    setRecordPage(1);
  }, [from, revision, search, to]);

  const chooseRange = (days: Exclude<AnalyticsRangeDays, "custom">): void => {
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
  const recordPageCount = Math.max(1, Math.ceil(data.records.length / recordPageSize));
  const safeRecordPage = Math.min(recordPage, recordPageCount);
  const recordStartIndex = (safeRecordPage - 1) * recordPageSize;
  const visibleRecords = data.records.slice(recordStartIndex, recordStartIndex + recordPageSize);

  return (
    <div className="history-page analytics-page" role="region" aria-label="数据统计">
      <div className="analytics-page-scroll">
        <section className="analytics-filter-bar" aria-label="统计时间范围">
          <div className="analytics-range-presets" aria-label="快捷日期范围">
            {ANALYTICS_RANGE_OPTIONS.map((days) => (
              <button
                type="button"
                aria-label={`最近 ${days} 天`}
                className={rangeDays === days ? "is-active" : undefined}
                key={days}
                onClick={() => chooseRange(days)}
              >
                <span className="analytics-range-label-full">近 {days} 天</span>
                <span className="analytics-range-label-compact" aria-hidden="true">{days}</span>
              </button>
            ))}
            <button
              type="button"
              aria-label="自定义日期"
              className={rangeDays === "custom" ? "is-active" : undefined}
              onClick={() => setRangeDays("custom")}
            >
              <span className="analytics-range-label-full">自定义</span>
              <span className="analytics-range-label-compact" aria-hidden="true">自</span>
            </button>
          </div>
          <div className="analytics-filter-tools">
            <label className="analytics-search" aria-label="批次查询"><Search /><input value={search} aria-label="批次" placeholder="批次" onChange={(event) => setSearch(event.target.value)} /></label>
            <div className="analytics-custom-range">
              <div className="history-date-field"><span>开始日期</span><DatePicker ariaLabel="开始日期" value={from} onValueChange={(value) => { setRangeDays("custom"); setFrom(value); }} /></div>
              <div className="history-date-field"><span>结束日期</span><DatePicker ariaLabel="结束日期" value={to} onValueChange={(value) => { setRangeDays("custom"); setTo(value); }} /></div>
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

            <section className={`analytics-panel analytics-records${visibleRecords.length < ANALYTICS_DEFAULT_PAGE_SIZE ? " is-compact-page" : ""}${visibleRecords.length === ANALYTICS_DEFAULT_PAGE_SIZE ? " is-filled-page" : ""}`}>
              <header><h2>批次明细</h2><span>点击批次查看完整日志</span></header>
              <div className="batch-table-wrap analytics-records-table" role="region" aria-label="批次明细表格" tabIndex={0}>
                <table>
                  <thead><tr><th>批次名称</th><th>开始时间</th><th>状态</th><th>文件</th><th>总行数</th><th>匹配率</th><th>异常</th><th>耗时</th></tr></thead>
                  <tbody>{visibleRecords.map((record) => <tr key={record.id} tabIndex={0} onClick={() => onOpenBatch(record.id)} onKeyDown={(event) => { if (event.key === "Enter") onOpenBatch(record.id); }}><td title={record.note || batchTitle(record)}>{batchTitle(record)}</td><td>{new Date(record.startedAt).toLocaleString("zh-CN", { hour12: false })}</td><td><span className={`history-status is-${record.status}`}>{STATUS_LABELS[record.status]}</span></td><td className="history-number is-info">{record.totalFiles}</td><td className="history-number is-primary">{record.totalRows || "—"}</td><td className="history-number is-success">{record.totalRows > 0 ? `${(record.matchedRows / record.totalRows * 100).toFixed(1)}%` : "—"}</td><td className="history-number is-error">{record.exceptionRows}</td><td className="history-number is-confirm">{formatDuration(record.durationMs ?? null)}</td></tr>)}</tbody>
                </table>
              </div>
              <footer className="analytics-table-footer">
                <span>共 {data.records.length} 条 · 第 {data.records.length === 0 ? 0 : recordStartIndex + 1}-{Math.min(recordStartIndex + recordPageSize, data.records.length)} 条</span>
                <div>
                  <Button type="button" variant="outline" size="sm" aria-label="上一页" disabled={safeRecordPage <= 1} onClick={() => setRecordPage((current) => Math.max(1, current - 1))}><ChevronLeft /></Button>
                  <span>{safeRecordPage}/{recordPageCount}</span>
                  <Button type="button" variant="outline" size="sm" aria-label="下一页" disabled={safeRecordPage >= recordPageCount} onClick={() => setRecordPage((current) => Math.min(recordPageCount, current + 1))}><ChevronRight /></Button>
                </div>
                <label>
                  <span>每页</span>
                  <Select value={String(recordPageSize)} onValueChange={(value) => { setRecordPageSize(Number(value)); setRecordPage(1); }}>
                    <SelectTrigger aria-label="每页条数"><SelectValue /></SelectTrigger>
                    <SelectContent>{ANALYTICS_PAGE_SIZE_OPTIONS.map((size) => <SelectItem value={String(size)} key={size}>{size} 条</SelectItem>)}</SelectContent>
                  </Select>
                </label>
              </footer>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileClock,
  FileText,
  FolderOpen,
  RefreshCw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type {
  DesktopAPI,
  TaskEventLevel,
  TaskFileResult,
  TaskHistoryDetail,
  TaskHistoryQuery,
  TaskHistoryRecord,
  TaskHistoryStatus,
} from "../../../preload";

type LogCenterPageProps = {
  api: DesktopAPI | null;
  revision: number;
  requestedBatchId: string | null;
  onRequestedBatchHandled: () => void;
};

const STATUS_LABELS: Record<TaskHistoryStatus, string> = {
  running: "处理中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  interrupted: "已中断",
};
const EVENT_LEVEL_LABELS: Record<TaskEventLevel, string> = {
  info: "信息",
  success: "成功",
  warning: "提示",
  error: "异常",
};
const HISTORY_PAGE_SIZE = 30;
const RUNNING_BATCH_REFRESH_INTERVAL_MS = 2_000;

function dateInputValue(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDuration(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  const seconds = value / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes} 分 ${remainingSeconds} 秒`;
}

function formatRate(matched: number, total: number): string {
  return total > 0 ? `${(matched / total * 100).toFixed(1)}%` : "—";
}

function batchTitle(record: TaskHistoryRecord): string {
  const names = record.fileNames ?? [];
  if (names.length === 0) return `批次 ${record.id.slice(-8)}`;
  if (names.length === 1) return names[0];
  return `${names[0]} 等 ${names.length} 个文件`;
}

export function LogCenterPage({
  api,
  revision,
  requestedBatchId,
  onRequestedBatchHandled,
}: LogCenterPageProps): React.JSX.Element {
  const [query, setQuery] = useState<TaskHistoryQuery>({
    from: dateInputValue(6),
    to: dateInputValue(0),
    page: 1,
    pageSize: HISTORY_PAGE_SIZE,
  });
  const [records, setRecords] = useState<TaskHistoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskHistoryDetail | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [eventLevel, setEventLevel] = useState<"all" | TaskEventLevel>("all");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [fileSort, setFileSort] = useState<{ key: keyof TaskFileResult; desc: boolean }>({ key: "fileName", desc: false });
  const [liveRefreshTick, setLiveRefreshTick] = useState(0);

  const loadRecords = useCallback(async (): Promise<void> => {
    if (!api) return;
    setLoading(true);
    setError("");
    try {
      const page = await api.listTaskHistory(query);
      setRecords(page.items);
      setTotal(page.total);
      setSelectedBatchId((current) => {
        if (requestedBatchId) return requestedBatchId;
        if (current && page.items.some((record) => record.id === current)) return current;
        return page.items[0]?.id ?? null;
      });
    } catch (reason) {
      setError(`读取批次记录失败：${String(reason)}`);
    } finally {
      setLoading(false);
    }
  }, [api, query, requestedBatchId]);

  useEffect(() => {
    void loadRecords();
  }, [liveRefreshTick, loadRecords, revision]);

  useEffect(() => {
    if (!records.some((record) => record.status === "running")) return;
    const timer = window.setInterval(() => setLiveRefreshTick((current) => current + 1), RUNNING_BATCH_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [records]);

  useEffect(() => {
    if (!requestedBatchId) return;
    setSelectedBatchId(requestedBatchId);
    setMobileDetailOpen(true);
    onRequestedBatchHandled();
  }, [onRequestedBatchHandled, requestedBatchId]);

  useEffect(() => {
    let cancelled = false;
    setSelectedFilePath(null);
    if (!api || !selectedBatchId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    void api.getTaskHistoryDetail(selectedBatchId)
      .then((value) => {
        if (!cancelled) setDetail(value);
      })
      .catch((reason) => {
        if (!cancelled) setError(`读取批次详情失败：${String(reason)}`);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [api, liveRefreshTick, revision, selectedBatchId]);

  const page = query.page ?? 1;
  const pageCount = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const selectedFile = detail?.files.find((file) => file.path === selectedFilePath) ?? null;
  const visibleEvents = (detail?.events ?? []).filter((event) => (
    (eventLevel === "all" || event.level === eventLevel)
    && (!selectedFilePath || event.filePath === selectedFilePath)
  ));
  const visibleIssues = selectedFile ? selectedFile.issueSummaries : detail?.issueSummaries ?? [];
  const sortedFiles = useMemo(() => {
    const files = [...(detail?.files ?? [])];
    return files.sort((left, right) => {
      const leftValue = left[fileSort.key];
      const rightValue = right[fileSort.key];
      const result = typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : String(leftValue ?? "").localeCompare(String(rightValue ?? ""), "zh-CN");
      return fileSort.desc ? -result : result;
    });
  }, [detail?.files, fileSort]);

  const chooseFileSort = (key: keyof TaskFileResult): void => {
    setFileSort((current) => current.key === key ? { key, desc: !current.desc } : { key, desc: false });
  };

  const updateQuery = (patch: Partial<TaskHistoryQuery>): void => {
    setQuery((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  };

  return (
    <div className={`history-page log-center-page${mobileDetailOpen ? " is-detail-open" : ""}`} role="region" aria-label="日志中心">
      <section className="history-filter-bar" aria-label="批次筛选">
        <div className="history-date-field"><span>开始日期</span><DatePicker ariaLabel="开始日期" value={query.from ?? ""} onValueChange={(value) => updateQuery({ from: value })} /></div>
        <div className="history-date-field"><span>结束日期</span><DatePicker ariaLabel="结束日期" value={query.to ?? ""} onValueChange={(value) => updateQuery({ to: value })} /></div>
        <div className="history-select-field">
          <span>状态</span>
          <Select value={query.statuses?.[0] ?? "all"} onValueChange={(value) => updateQuery({ statuses: value === "all" ? [] : [value as TaskHistoryStatus] })}>
            <SelectTrigger aria-label="状态"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部状态</SelectItem>{Object.entries(STATUS_LABELS).map(([status, label]) => <SelectItem value={status} key={status}>{label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <label className="history-search"><span>文件名</span><div><Search /><input value={query.search ?? ""} placeholder="搜索文件名或输出目录" onChange={(event) => updateQuery({ search: event.target.value })} /></div></label>
        <div className="history-filter-actions">
          <Button variant="outline" onClick={() => void api?.exportTaskHistory({ format: "csv", query })} disabled={!api || records.length === 0}><Download />导出列表</Button>
          <Button variant="outline" onClick={() => void loadRecords()} disabled={loading}><RefreshCw className={loading ? "is-spinning" : undefined} />刷新</Button>
        </div>
      </section>

      {error ? <div className="history-error">{error}</div> : null}

      <section className="log-center-layout">
        <aside className="batch-master" aria-label="批次列表">
          <header><strong>批次记录</strong><span>共 {total} 个</span></header>
          <div className="batch-list">
            {!loading && records.length === 0 ? <div className="history-empty"><FileText /><strong>没有批次记录</strong><span>完成一次核价后会显示在这里</span></div> : null}
            {records.map((record) => (
              <button
                type="button"
                className={record.id === selectedBatchId ? "is-selected" : undefined}
                key={record.id}
                onClick={() => {
                  setSelectedBatchId(record.id);
                  setMobileDetailOpen(true);
                }}
              >
                <div><strong title={batchTitle(record)}>{batchTitle(record)}</strong><span className={`history-status is-${record.status}`}>{STATUS_LABELS[record.status]}</span></div>
                <time>{new Date(record.startedAt).toLocaleString("zh-CN", { hour12: false })}</time>
                <p><span className="is-info">{record.completedFiles + record.failedFiles}/{record.totalFiles} 文件</span><span className="is-success">{formatRate(record.matchedRows, record.totalRows)}</span><span className="is-confirm">{formatDuration(record.durationMs)}</span></p>
                {!record.detailAvailable ? <em>仅有汇总</em> : null}
              </button>
            ))}
          </div>
          <footer>
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => updateQuery({ page: page - 1 })}><ChevronLeft />上一页</Button>
            <span>{page}/{pageCount}</span>
            <Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => updateQuery({ page: page + 1 })}>下一页<ChevronRight /></Button>
          </footer>
        </aside>

        <main className="batch-detail" aria-label="批次详情">
          <button className="batch-detail-back" type="button" onClick={() => setMobileDetailOpen(false)}><ArrowLeft />返回批次列表</button>
          {detailLoading ? <div className="history-empty"><RefreshCw className="is-spinning" /><strong>正在读取批次详情</strong></div> : null}
          {!detailLoading && !detail ? <div className="history-empty"><FileClock /><strong>请选择一个批次</strong><span>右侧将显示文件结果和事件时间线</span></div> : null}
          {detail ? (
            <>
              <header className="batch-detail-header">
                <div><span className={`history-status is-${detail.record.status}`}>{STATUS_LABELS[detail.record.status]}</span><h2>{batchTitle(detail.record)}</h2><small>{detail.record.id}</small></div>
                <div>
                  {detail.record.outputDir ? <Button variant="outline" size="sm" onClick={() => void api?.openPath(detail.record.outputDir ?? "")}><FolderOpen />结果目录</Button> : null}
                  <Button variant="outline" size="sm" onClick={() => void api?.exportTaskHistory({ format: "json", batchId: detail.record.id })}><Download />导出详情</Button>
                </div>
              </header>
              <section className="batch-metrics" aria-label="批次指标">
                <article className="is-info"><span>处理文件</span><strong>{detail.record.totalFiles}</strong></article>
                <article className="is-primary"><span>总行数</span><strong>{detail.record.totalRows || "—"}</strong></article>
                <article className="is-success"><span>匹配率</span><strong>{formatRate(detail.record.matchedRows, detail.record.totalRows)}</strong></article>
                <article className="is-error"><span>异常行</span><strong>{detail.record.exceptionRows}</strong></article>
                <article className="is-confirm"><span>批次耗时</span><strong>{formatDuration(detail.record.durationMs)}</strong></article>
              </section>

              {detail.legacy ? <div className="legacy-history-notice">该批次由旧版本创建，历史版本未记录文件明细。</div> : (
                <>
                  <section className="batch-section batch-file-section">
                    <header><div><h3>文件结果</h3><span>{selectedFile ? `已筛选：${selectedFile.fileName}` : `${detail.files.length} 个文件`}</span></div>{selectedFile ? <Button variant="ghost" size="sm" onClick={() => setSelectedFilePath(null)}>查看全部</Button> : null}</header>
                    <div className="batch-table-wrap">
                      <table>
                        <thead><tr><th><button type="button" onClick={() => chooseFileSort("fileName")}>文件名</button></th><th><button type="button" onClick={() => chooseFileSort("status")}>状态</button></th><th><button type="button" onClick={() => chooseFileSort("totalRows")}>匹配</button></th><th><button type="button" onClick={() => chooseFileSort("exceptionRows")}>异常</button></th><th><button type="button" onClick={() => chooseFileSort("durationMs")}>耗时</button></th><th>结果</th></tr></thead>
                        <tbody>{sortedFiles.map((file) => <tr className={file.path === selectedFilePath ? "is-selected" : undefined} key={file.path} onClick={() => setSelectedFilePath((current) => current === file.path ? null : file.path)}><td title={file.path}>{file.fileName}</td><td><span className={`file-result-status is-${file.status}`}>{file.status === "queued" ? "等待" : file.status === "running" ? "处理中" : file.status === "completed" ? "完成" : file.status === "failed" ? "失败" : "停止"}</span></td><td className="history-number is-success">{file.totalRows ? `${file.matchedRows}/${file.totalRows}` : "—"}</td><td className="history-number is-error">{file.exceptionRows}</td><td className="history-number is-confirm">{formatDuration(file.durationMs)}</td><td>{file.outputPath ? <button type="button" className="file-result-open" aria-label={`打开 ${file.fileName} 结果`} title="打开结果文件" onClick={(event) => { event.stopPropagation(); void api?.openPath(file.outputPath ?? ""); }}><ExternalLink /></button> : "—"}</td></tr>)}</tbody>
                      </table>
                    </div>
                  </section>

                  <section className="batch-lower-grid">
                    <article className="batch-section batch-issues">
                      <header><div><h3>异常分类</h3><span>{selectedFile ? selectedFile.fileName : "当前批次"}</span></div></header>
                      {visibleIssues.length === 0 ? <div className="compact-empty">没有记录到异常</div> : visibleIssues.map((issue) => <details key={issue.code}><summary><span>{issue.label}</span><strong>{issue.count}</strong></summary>{issue.samples.length === 0 ? <p>未保存问题样例</p> : <ul>{issue.samples.map((sample, index) => <li key={`${sample.sourceRow}-${index}`}><b>{sample.sourceRow > 0 ? `第 ${sample.sourceRow} 行` : "文件级问题"}</b><span>{[sample.country, sample.sku, sample.quantity === null ? "" : `数量 ${sample.quantity}`].filter(Boolean).join(" · ")}</span><p>{sample.reason}</p></li>)}</ul>}</details>)}
                    </article>
                    <article className="batch-section batch-events">
                      <header><div><h3>事件时间线</h3><span>{visibleEvents.length} 条</span></div><Select value={eventLevel} onValueChange={(value) => setEventLevel(value as "all" | TaskEventLevel)}><SelectTrigger className="history-event-select" aria-label="事件级别"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部级别</SelectItem>{Object.entries(EVENT_LEVEL_LABELS).map(([level, label]) => <SelectItem value={level} key={level}>{label}</SelectItem>)}</SelectContent></Select></header>
                      {visibleEvents.length === 0 ? <div className="compact-empty">当前筛选下没有事件</div> : <ol>{visibleEvents.map((event) => <li className={`is-${event.level}`} key={event.id}><i /><time>{new Date(event.time).toLocaleTimeString("zh-CN", { hour12: false })}</time><span>{event.message}</span></li>)}</ol>}
                    </article>
                  </section>
                </>
              )}
            </>
          ) : null}
        </main>
      </section>
    </div>
  );
}

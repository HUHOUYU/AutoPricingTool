import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Braces, CheckCircle2, FileJson2, FolderOpen, RefreshCw, RotateCcw, Save, SaveAll } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ConfigDocument, ConfigValidationResult, DesktopAPI, ProcessingCapacity } from "../../../preload";

type JsonObject = Record<string, unknown>;
type SingleShipmentMatchField = "recipient_name" | "phone" | "postal_code" | "address" | "email";

type ConfigCenterPageProps = {
  api: DesktopAPI | null;
  onDocumentSaved?: (document: ConfigDocument) => void | Promise<void>;
};

const SINGLE_SHIPMENT_MATCH_FIELD_OPTIONS: Array<{ value: SingleShipmentMatchField; label: string }> = [
  { value: "recipient_name", label: "收件人姓名" },
  { value: "phone", label: "电话" },
  { value: "postal_code", label: "邮编" },
  { value: "address", label: "完整地址" },
  { value: "email", label: "邮箱" },
];
const DEFAULT_SINGLE_SHIPMENT_MATCH_FIELDS: SingleShipmentMatchField[] = ["recipient_name", "phone", "postal_code"];

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function cloneConfig(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function ConfigCenterPage({ api, onDocumentSaved }: ConfigCenterPageProps): React.JSX.Element {
  const [document, setDocument] = useState<ConfigDocument | null>(null);
  const [source, setSource] = useState("");
  const [parsed, setParsed] = useState<JsonObject>({});
  const [validation, setValidation] = useState<ConfigValidationResult>({ valid: true, issues: [] });
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [sourceScrollTop, setSourceScrollTop] = useState(0);
  const [processingCapacity, setProcessingCapacity] = useState<ProcessingCapacity | null>(null);
  const [rememberWindowSize, setRememberWindowSize] = useState(false);
  const [windowPreferenceLoading, setWindowPreferenceLoading] = useState(true);

  const applyDocument = useCallback((next: ConfigDocument): void => {
    setDocument(next);
    setSource(next.content);
    try { setParsed(asObject(JSON.parse(next.content) as unknown)); } catch { setParsed({}); }
    setValidation({ valid: true, issues: [] });
    setDirty(false);
  }, []);

  const loadDocument = useCallback(async (path?: string): Promise<void> => {
    if (!api) return;
    setLoading(true);
    try {
      applyDocument(await api.getConfigDocument(path));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "配置读取失败");
    } finally {
      setLoading(false);
    }
  }, [api, applyDocument]);

  useEffect(() => { void loadDocument(); }, [loadDocument]);
  useEffect(() => {
    if (!api) return;
    void api.getProcessingCapacity().then(setProcessingCapacity).catch(() => setProcessingCapacity(null));
  }, [api]);
  useEffect(() => {
    if (!api) {
      setWindowPreferenceLoading(false);
      return;
    }
    void api.getWindowPreferences()
      .then((preferences) => setRememberWindowSize(preferences.rememberSize))
      .catch(() => toast.error("窗口大小设置读取失败"))
      .finally(() => setWindowPreferenceLoading(false));
  }, [api]);

  const toggleRememberWindowSize = async (): Promise<void> => {
    if (!api || windowPreferenceLoading) return;
    const nextValue = !rememberWindowSize;
    setWindowPreferenceLoading(true);
    try {
      const preferences = await api.setRememberWindowSize(nextValue);
      setRememberWindowSize(preferences.rememberSize);
      toast.success(preferences.rememberSize ? "已记录当前窗口大小" : "已关闭窗口大小记录");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "窗口大小设置保存失败");
    } finally {
      setWindowPreferenceLoading(false);
    }
  };

  const updateSource = (nextSource: string): void => {
    setSource(nextSource);
    setDirty(nextSource !== document?.content);
    try {
      setParsed(asObject(JSON.parse(nextSource) as unknown));
    } catch {
      // Keep the last valid form model while the user is editing incomplete JSON.
    }
  };

  const updateField = (section: string, key: string, value: unknown): void => {
    const next = cloneConfig(parsed);
    next[section] = { ...asObject(next[section]), [key]: value };
    const nextSource = `${JSON.stringify(next, null, 2)}\n`;
    setParsed(next);
    setSource(nextSource);
    setDirty(nextSource !== document?.content);
    setValidation({ valid: true, issues: [] });
  };

  const updateFields = (section: string, fields: JsonObject): void => {
    const next = cloneConfig(parsed);
    next[section] = { ...asObject(next[section]), ...fields };
    const nextSource = `${JSON.stringify(next, null, 2)}\n`;
    setParsed(next);
    setSource(nextSource);
    setDirty(nextSource !== document?.content);
    setValidation({ valid: true, issues: [] });
  };

  const validate = async (): Promise<ConfigValidationResult | null> => {
    if (!api) return null;
    const result = await api.validateConfigDocument(source);
    setValidation(result);
    if (result.valid) toast.success("配置校验通过");
    else toast.error(`发现 ${result.issues.length} 项配置问题`);
    return result;
  };

  const save = async (): Promise<void> => {
    if (!api || !document) return;
    const result = await validate();
    if (!result?.valid) return;
    try {
      const saved = await api.saveConfigDocument({ path: document.path, content: source, expectedModifiedAt: document.modifiedAt });
      applyDocument(saved);
      await onDocumentSaved?.(saved);
      toast.success("配置已保存，并创建 .bak 备份");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "配置保存失败");
    }
  };

  const saveAs = async (): Promise<void> => {
    if (!api) return;
    const result = await validate();
    if (!result?.valid) return;
    try {
      const saved = await api.saveConfigDocumentAs(source);
      if (saved) {
        applyDocument(saved);
        await onDocumentSaved?.(saved);
        toast.success("配置已另存为新文件");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "配置另存失败");
    }
  };

  const selectDocument = async (): Promise<void> => {
    if (!api) return;
    const selected = await api.selectConfig();
    if (selected) await loadDocument(selected);
  };

  const selectRuntimeDirectory = async (key: "recent_input_dir" | "recent_output_dir", purpose: "input" | "output"): Promise<void> => {
    if (!api) return;
    try {
      const selected = await api.selectDirectory(purpose, false);
      if (selected) updateField("runtime", key, selected);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "目录选择失败");
    }
  };

  const restore = async (): Promise<void> => {
    if (!api || restoring) return;
    setRestoring(true);
    try {
      const restored = await api.restoreDefaultConfig();
      applyDocument(restored);
      await onDocumentSaved?.(restored);
      toast.success("已恢复默认配置");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "恢复默认配置失败");
    } finally {
      setRestoring(false);
      setRestoreDialogOpen(false);
    }
  };

  const formatSource = (): void => {
    try {
      const value = JSON.parse(source) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("配置文档根节点必须是 JSON 对象");
      }
      const nextParsed = value as JsonObject;
      const nextSource = `${JSON.stringify(nextParsed, null, 2)}\n`;
      setParsed(nextParsed);
      setSource(nextSource);
      setDirty(nextSource !== document?.content);
      setValidation({ valid: true, issues: [] });
      toast.success("JSON 已格式化");
    } catch (error) {
      toast.error(error instanceof Error ? `无法格式化：${error.message}` : "JSON 格式无效");
    }
  };

  const runtime = useMemo(() => asObject(parsed.runtime), [parsed]);
  const performance = useMemo(() => asObject(parsed.performance), [parsed]);
  const automation = useMemo(() => asObject(parsed.automation), [parsed]);
  const pricing = useMemo(() => asObject(parsed.pricing), [parsed]);
  const singleShipmentMatchingEnabled = Boolean(pricing.single_shipment_matching_enabled);
  const singleShipmentMatchFields = (
    Array.isArray(pricing.single_shipment_match_fields)
      ? pricing.single_shipment_match_fields
      : DEFAULT_SINGLE_SHIPMENT_MATCH_FIELDS
  ).filter((value): value is SingleShipmentMatchField =>
    SINGLE_SHIPMENT_MATCH_FIELD_OPTIONS.some((option) => option.value === value));
  const sourceLineCount = source.split(/\r?\n/).length;
  const sourceLineNumbers = useMemo(() => Array.from({ length: sourceLineCount }, (_, index) => index + 1).join("\n"), [sourceLineCount]);

  return (
    <div className="config-center-page" role="region" aria-label="配置中心">
      <div className="config-center-status">
        <div className={`config-validation-summary ${validation.valid ? "is-valid" : "is-invalid"}`}>
          {validation.valid ? <CheckCircle2 /> : <AlertTriangle />}
          <span>{validation.valid ? "配置结构正常" : `${validation.issues.length} 项需要修复`}</span>
          <Button variant="ghost" onClick={() => void validate()}>立即校验</Button>
        </div>
        <div className="config-center-actions">
          <Button className="is-info" variant="outline" onClick={() => void selectDocument()} disabled={loading}><FolderOpen />选择</Button>
          <Button className="is-info" variant="outline" onClick={() => void loadDocument(document?.path)} disabled={loading}><RefreshCw />重新加载</Button>
          <Button className="is-primary" variant="outline" onClick={() => void saveAs()} disabled={loading}><SaveAll />另存为</Button>
          <Button className="is-warning" variant="outline" onClick={() => setRestoreDialogOpen(true)} disabled={loading || restoring}><RotateCcw />恢复默认</Button>
          <Button className="is-success" onClick={() => void save()} disabled={loading || !dirty}><Save />保存</Button>
        </div>
      </div>

      <div className="config-center-grid">
        <section className="config-form-panel">
          <header><FileJson2 /><div><h2>分组设置</h2><p>常用设置会与右侧 JSON 实时同步</p></div></header>
          <div className="config-form-scroll">
            <fieldset>
              <legend>运行路径</legend>
              <label>配置文件{dirty ? " · 未保存" : ""}<input aria-label="当前配置文件" title={document?.path} value={document?.path ?? "正在读取配置文件…"} readOnly /></label>
              <div className="config-field"><span>输入目录</span><div className="config-path-field"><input aria-label="输入目录" value={String(runtime.recent_input_dir ?? "")} onChange={(event) => updateField("runtime", "recent_input_dir", event.currentTarget.value)} /><Button type="button" variant="outline" aria-label="选择输入目录" onClick={() => void selectRuntimeDirectory("recent_input_dir", "input")}><FolderOpen />选择</Button></div></div>
              <div className="config-field"><span>输出目录</span><div className="config-path-field"><input aria-label="输出目录" value={String(runtime.recent_output_dir ?? "")} onChange={(event) => updateField("runtime", "recent_output_dir", event.currentTarget.value)} /><Button type="button" variant="outline" aria-label="选择输出目录" onClick={() => void selectRuntimeDirectory("recent_output_dir", "output")}><FolderOpen />选择</Button></div></div>
              <label className="config-check"><input type="checkbox" checked={Boolean(runtime.archive_standard_files)} onChange={(event) => updateField("runtime", "archive_standard_files", event.currentTarget.checked)} />归档标准文件</label>
            </fieldset>
            <fieldset>
              <legend>界面偏好</legend>
              <div className="config-switch-row">
                <span><strong>手动处理后定位结果</strong><small>仅手动确认单个文件时，处理完成后跳转到对应状态并定位文件</small></span>
                <button
                  type="button"
                  role="switch"
                  aria-label="手动处理后定位结果"
                  aria-checked={Boolean(runtime.auto_reveal_manual_result)}
                  className="config-switch"
                  onClick={() => updateField("runtime", "auto_reveal_manual_result", !Boolean(runtime.auto_reveal_manual_result))}
                ><i /></button>
              </div>
              <div className="config-switch-row">
                <span><strong>连续处理问题文件</strong><small>人工处理成功后，自动打开下一个待确认或异常文件</small></span>
                <button
                  type="button"
                  role="switch"
                  aria-label="连续处理问题文件"
                  aria-checked={Boolean(runtime.continuous_issue_review_enabled)}
                  className="config-switch"
                  onClick={() => updateField("runtime", "continuous_issue_review_enabled", !Boolean(runtime.continuous_issue_review_enabled))}
                ><i /></button>
              </div>
              <div className="config-switch-row">
                <span><strong>记住窗口大小</strong><small>开启后记录当前宽高，下次启动时自动恢复</small></span>
                <button
                  type="button"
                  role="switch"
                  aria-label="记住窗口大小"
                  aria-checked={rememberWindowSize}
                  className="config-switch"
                  disabled={windowPreferenceLoading}
                  onClick={() => void toggleRememberWindowSize()}
                ><i /></button>
              </div>
            </fieldset>
            <fieldset>
              <legend>性能限制</legend>
              <label className="config-number-field"><span>处理线程数<small>最大线程数：{processingCapacity?.detectedThreads ?? "—"}</small></span><input aria-label="处理线程数" type="number" min="0" max={processingCapacity?.maxWorkers} value={Number(performance.processing_workers ?? 0)} onChange={(event) => {
                const requestedWorkers = Math.max(0, Number(event.currentTarget.value));
                updateField("performance", "processing_workers", processingCapacity ? Math.min(requestedWorkers, processingCapacity.maxWorkers) : requestedWorkers);
              }} /></label>
              <label>最大处理行数<input type="number" min="1" value={Number(performance.processing_max_rows ?? 200000)} onChange={(event) => updateField("performance", "processing_max_rows", Number(event.currentTarget.value))} /></label>
              <label>工作簿上限（MB）<input type="number" min="1" value={Number(performance.processing_workbook_max_mb ?? 512)} onChange={(event) => updateField("performance", "processing_workbook_max_mb", Number(event.currentTarget.value))} /></label>
            </fieldset>
            <fieldset>
              <legend>自动化门槛</legend>
              <label className="config-check"><input type="checkbox" checked={Boolean(automation.auto_run ?? true)} onChange={(event) => updateField("automation", "auto_run", event.currentTarget.checked)} />分析后自动核价</label>
              <label className="config-check"><input type="checkbox" checked={Boolean(automation.template_match_priority)} onChange={(event) => updateField("automation", "template_match_priority", event.currentTarget.checked)} />模板匹配优先</label>
              <label>覆盖率门槛（%）<input type="number" min="0" max="100" step="0.1" value={Number(automation.coverage_threshold ?? 0.98) * 100} onChange={(event) => updateField("automation", "coverage_threshold", Number(event.currentTarget.value) / 100)} /></label>
              <label>最低试算行数<input type="number" min="1" value={Number(automation.min_trial_rows ?? 10)} onChange={(event) => updateField("automation", "min_trial_rows", Number(event.currentTarget.value))} /></label>
              <label>候选覆盖率差（%）<input type="number" min="0" max="100" step="0.1" value={Number(automation.candidate_coverage_gap ?? 0.02) * 100} onChange={(event) => updateField("automation", "candidate_coverage_gap", Number(event.currentTarget.value) / 100)} /></label>
              <label>候选评分差<input type="number" min="0" step="0.5" value={Number(automation.candidate_score_gap ?? 12)} onChange={(event) => updateField("automation", "candidate_score_gap", Number(event.currentTarget.value))} /></label>
            </fieldset>
            <fieldset>
              <legend>核价策略</legend>
              <div className="config-switch-row">
                <span><strong>启用单独发货价格匹配</strong><small>默认使用通用价格；只有联合字段完整、仅对应一个订单且订单只有一个有效主要 SKU 时才使用单独发货价</small></span>
                <button
                  type="button"
                  role="switch"
                  aria-label="启用单独发货价格匹配"
                  aria-checked={singleShipmentMatchingEnabled}
                  className="config-switch"
                  onClick={() => {
                    const enabled = !singleShipmentMatchingEnabled;
                    updateFields("pricing", {
                      single_shipment_matching_enabled: enabled,
                      single_shipment_match_fields: enabled && singleShipmentMatchFields.length < 2
                        ? DEFAULT_SINGLE_SHIPMENT_MATCH_FIELDS
                        : singleShipmentMatchFields,
                    });
                  }}
                ><i /></button>
              </div>
              <div className={`config-match-fields${singleShipmentMatchingEnabled ? "" : " is-disabled"}`}>
                <span>联合判断表头<small>至少保留两项；字段缺失或判断不明确时使用通用价格</small></span>
                <div>
                  {SINGLE_SHIPMENT_MATCH_FIELD_OPTIONS.map((option) => {
                    const checked = singleShipmentMatchFields.includes(option.value);
                    return <label className="config-check" key={option.value}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!singleShipmentMatchingEnabled || (checked && singleShipmentMatchFields.length <= 2)}
                        onChange={(event) => {
                          const fields = event.currentTarget.checked
                            ? [...new Set([...singleShipmentMatchFields, option.value])]
                            : singleShipmentMatchFields.filter((field) => field !== option.value);
                          updateField("pricing", "single_shipment_match_fields", fields);
                        }}
                      />
                      {option.label}
                    </label>;
                  })}
                </div>
              </div>
            </fieldset>
          </div>
        </section>

        <section className="config-source-panel">
          <header><div><h2>JSON 源码</h2><p>未识别字段会原样保留</p></div><div className="config-source-tools"><span>JSON</span><small>{sourceLineCount} 行</small><Button type="button" variant="outline" aria-label="格式化" title="格式化 JSON" onClick={formatSource} disabled={!source.trim()}><Braces /></Button></div></header>
          <div className="config-source-editor">
            <div className="config-source-code">
              <div className="config-source-gutter" aria-hidden="true"><pre style={{ transform: `translateY(-${sourceScrollTop}px)` }}>{sourceLineNumbers}</pre></div>
              <textarea aria-label="JSON 源码" spellCheck={false} value={source} onScroll={(event) => setSourceScrollTop(event.currentTarget.scrollTop)} onChange={(event) => updateSource(event.currentTarget.value)} />
            </div>
            <footer><span><i />JSON</span><span>UTF-8</span><span>空格: 2</span></footer>
          </div>
          {validation.issues.length > 0 ? <div className="config-issues">{validation.issues.map((issue, index) => <button type="button" key={`${issue.path}-${index}`}><code>{issue.path}</code><span>{issue.message}</span></button>)}</div> : null}
        </section>
      </div>
      <ConfirmDialog
        open={restoreDialogOpen}
        title="恢复默认配置？"
        description="当前配置文件将被默认配置覆盖，系统会在覆盖前创建 .bak 备份。"
        confirmLabel="恢复默认"
        busy={restoring}
        onConfirm={() => void restore()}
        onCancel={() => setRestoreDialogOpen(false)}
      />
    </div>
  );
}

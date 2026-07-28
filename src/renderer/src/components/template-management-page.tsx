import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, FilePlus2, FileSpreadsheet, LoaderCircle, Save, X } from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { DesktopAPI, HeaderTemplateFieldMapping, HeaderTemplateRecord } from "../../../preload";

type RequiredTemplateField = {
  key: string;
  label: string;
  group: "订单字段" | "核价字段";
};

type TemplateSheet = {
  name: string;
  rows: string[][];
  startRow: number;
  startColumn: number;
};

const fallbackRequiredFields: RequiredTemplateField[] = [
  { key: "order_number", label: "订单号", group: "订单字段" },
  { key: "country_code", label: "国家二字码", group: "订单字段" },
  { key: "sku_detail", label: "订单 SKU", group: "订单字段" },
  { key: "qty_detail", label: "订单数量", group: "订单字段" },
  { key: "pricing_sku", label: "核价 SKU", group: "核价字段" },
  { key: "pricing_country", label: "核价国家", group: "核价字段" },
  { key: "price", label: "数量价格档位（price）", group: "核价字段" },
];

const TEMPLATE_DRAWER_DEFAULT_MAX_WIDTH = 1500;
const TEMPLATE_DRAWER_MIN_WIDTH = 760;
const TEMPLATE_DRAWER_EDGE_GAP = 72;
const TEMPLATE_DRAWER_KEYBOARD_STEP = 24;
const TEMPLATE_FIELDS_DEFAULT_WIDTH = 330;
const TEMPLATE_FIELDS_MIN_WIDTH = 280;
const TEMPLATE_FIELDS_MAX_WIDTH = 600;
const TEMPLATE_FIELDS_KEYBOARD_STEP = 16;
const TEMPLATE_PREVIEW_MIN_WIDTH = 360;
const TEMPLATE_BODY_HORIZONTAL_PADDING = 24;
const TEMPLATE_BODY_RESIZER_WIDTH = 12;
const MULTI_SELECT_FIELD_KEYS = new Set(["price"]);

function templateDrawerBounds(viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth): { min: number; max: number } {
  const max = Math.max(320, viewportWidth - TEMPLATE_DRAWER_EDGE_GAP);
  return { min: Math.min(TEMPLATE_DRAWER_MIN_WIDTH, max), max };
}

function clampTemplateDrawerWidth(width: number): number {
  const bounds = templateDrawerBounds();
  return Math.min(bounds.max, Math.max(bounds.min, width));
}

function defaultTemplateDrawerWidth(): number {
  return clampTemplateDrawerWidth(Math.min(TEMPLATE_DRAWER_DEFAULT_MAX_WIDTH, window.innerWidth - TEMPLATE_DRAWER_EDGE_GAP));
}

function templateFieldsBounds(drawerWidth: number): { min: number; max: number } {
  const availableMax = drawerWidth - TEMPLATE_BODY_HORIZONTAL_PADDING - TEMPLATE_BODY_RESIZER_WIDTH - TEMPLATE_PREVIEW_MIN_WIDTH;
  return { min: TEMPLATE_FIELDS_MIN_WIDTH, max: Math.max(TEMPLATE_FIELDS_MIN_WIDTH, Math.min(TEMPLATE_FIELDS_MAX_WIDTH, availableMax)) };
}

function clampTemplateFieldsWidth(width: number, drawerWidth: number): number {
  const bounds = templateFieldsBounds(drawerWidth);
  return Math.min(bounds.max, Math.max(bounds.min, width));
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredFieldsFromConfig(content: string): { fields: RequiredTemplateField[]; fromConfig: boolean } {
  try {
    const config = asObject(JSON.parse(content) as unknown);
    const fields = asObject(config.fields);
    const requiredRules = Object.entries(fields).flatMap(([key, rawRule]) => {
      const rule = asObject(rawRule);
      if (rule.required !== true) return [];
      const aliases = Array.isArray(rule.header_aliases) ? rule.header_aliases.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
      const label = typeof rule.output_header === "string" && rule.output_header.trim() ? rule.output_header.trim() : aliases[0] ?? key;
      return [{ key, label }];
    });
    const labels = new Map(requiredRules.map((field) => [field.key, field.label]));
    const coreFields = fallbackRequiredFields.map((field) => ({ ...field, label: labels.get(field.key) ?? field.label }));
    const additionalFields = requiredRules
      .filter((field) => !fallbackRequiredFields.some((core) => core.key === field.key))
      .map((field) => ({ ...field, group: field.key.startsWith("pricing_") ? "核价字段" as const : "订单字段" as const }));
    return { fields: [...coreFields, ...additionalFields], fromConfig: requiredRules.length > 0 };
  } catch {
    return { fields: fallbackRequiredFields, fromConfig: false };
  }
}

function excelColumnLabel(column: number): string {
  let value = column;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function parseTemplateWorkbook(bytes: Uint8Array): TemplateSheet[] {
  const workbook = XLSX.read(bytes, {
    type: "array",
    dense: true,
    sheetRows: 100,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellText: true,
  });
  return workbook.SheetNames.flatMap((name) => {
    const sheet = workbook.Sheets[name];
    if (!sheet?.["!ref"]) return [{ name, rows: [], startRow: 0, startColumn: 0 }];
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    const displayRange = {
      s: range.s,
      e: { r: Math.min(range.e.r, range.s.r + 99), c: Math.min(range.e.c, range.s.c + 79) },
    };
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, range: displayRange, raw: false, defval: "", blankrows: true });
    const columnCount = displayRange.e.c - displayRange.s.c + 1;
    const rows = rawRows.map((row) => Array.from({ length: columnCount }, (_, index) => {
      const value = row[index];
      return value === null || value === undefined ? "" : String(value);
    }));
    return [{ name, rows, startRow: displayRange.s.r, startColumn: displayRange.s.c }];
  });
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function TemplateManagementPage({ api }: { api: DesktopAPI | null }): React.JSX.Element {
  const [templates, setTemplates] = useState<HeaderTemplateRecord[]>([]);
  const [requiredFields, setRequiredFields] = useState<RequiredTemplateField[]>(fallbackRequiredFields);
  const [usingFallbackFields, setUsingFallbackFields] = useState(true);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<HeaderTemplateRecord | null>(null);
  const [detail, setDetail] = useState<HeaderTemplateRecord | null>(null);
  const [sheets, setSheets] = useState<TemplateSheet[]>([]);
  const [activeSheetName, setActiveSheetName] = useState("");
  const [activeFieldKey, setActiveFieldKey] = useState<string | null>(null);
  const [draftMappings, setDraftMappings] = useState<HeaderTemplateFieldMapping[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(defaultTemplateDrawerWidth);
  const [fieldsWidth, setFieldsWidth] = useState(TEMPLATE_FIELDS_DEFAULT_WIDTH);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const drawerResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const fieldsResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const drawerWidthRef = useRef(drawerWidth);

  const loadPage = useCallback(async (): Promise<void> => {
    if (!api) return;
    setLoading(true);
    try {
      const [records, config] = await Promise.all([api.listHeaderTemplates(), api.getConfigDocument()]);
      setTemplates(records);
      const required = requiredFieldsFromConfig(config.content);
      setRequiredFields(required.fields);
      setUsingFallbackFields(!required.fromConfig);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "模板数据读取失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void loadPage(); }, [loadPage]);
  useEffect(() => {
    const handleWindowResize = (): void => {
      setViewportWidth(window.innerWidth);
      setDrawerWidth((current) => clampTemplateDrawerWidth(current));
    };
    const handlePointerMove = (event: PointerEvent): void => {
      const drawerResize = drawerResizeRef.current;
      if (drawerResize) setDrawerWidth(clampTemplateDrawerWidth(drawerResize.startWidth + drawerResize.startX - event.clientX));
      const fieldsResize = fieldsResizeRef.current;
      if (fieldsResize) setFieldsWidth(clampTemplateFieldsWidth(fieldsResize.startWidth + fieldsResize.startX - event.clientX, drawerWidthRef.current));
    };
    const stopResize = (): void => {
      drawerResizeRef.current = null;
      fieldsResizeRef.current = null;
    };
    window.addEventListener("resize", handleWindowResize);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };
  }, []);

  useEffect(() => {
    drawerWidthRef.current = drawerWidth;
    setFieldsWidth((current) => clampTemplateFieldsWidth(current, drawerWidth));
  }, [drawerWidth]);

  const openDetail = useCallback(async (record: HeaderTemplateRecord): Promise<void> => {
    if (!api) return;
    setDetail(record);
    setDraftMappings(record.mappings);
    setSheets([]);
    setActiveSheetName("");
    setActiveFieldKey(requiredFields.find((field) => !record.mappings.some((mapping) => mapping.fieldKey === field.key))?.key ?? requiredFields[0]?.key ?? null);
    setPreviewLoading(true);
    try {
      const source = await api.readExcelPreviewFile(record.filePath);
      const parsedSheets = parseTemplateWorkbook(source.bytes);
      setSheets(parsedSheets);
      setActiveSheetName(parsedSheets[0]?.name ?? "");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "模板文件预览失败");
    } finally {
      setPreviewLoading(false);
    }
  }, [api, requiredFields]);

  const createTemplate = async (): Promise<void> => {
    if (!api || creating) return;
    setCreating(true);
    try {
      const record = await api.createHeaderTemplate();
      if (!record) return;
      setTemplates((current) => [record, ...current]);
      await openDetail(record);
      toast.success("模板已创建，请选择必填表头");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "模板创建失败");
    } finally {
      setCreating(false);
    }
  };

  const deleteTemplate = async (record: HeaderTemplateRecord): Promise<void> => {
    if (!api || deletingId) return;
    setDeletingId(record.id);
    try {
      await api.deleteHeaderTemplate(record.id);
      setTemplates((current) => current.filter((item) => item.id !== record.id));
      if (detail?.id === record.id) setDetail(null);
      toast.success("模板已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "模板删除失败");
    } finally {
      setDeletingId(null);
      setDeleteCandidate(null);
    }
  };

  const activeSheet = sheets.find((sheet) => sheet.name === activeSheetName) ?? null;
  const mappingByField = useMemo(() => new Map(draftMappings.map((mapping) => [mapping.fieldKey, mapping])), [draftMappings]);
  const requiredFieldGroups = useMemo(() => (["订单字段", "核价字段"] as const)
    .map((group) => ({ group, fields: requiredFields.filter((field) => field.group === group) }))
    .filter((section) => section.fields.length > 0), [requiredFields]);
  const completedCount = requiredFields.filter((field) => mappingByField.has(field.key)).length;
  const orderFieldKeys = new Set(requiredFields.filter((field) => field.group === "订单字段").map((field) => field.key));
  const pricingFieldKeys = new Set(requiredFields.filter((field) => field.group === "核价字段").map((field) => field.key));
  const orderSheetNames = new Set(draftMappings.filter((mapping) => orderFieldKeys.has(mapping.fieldKey)).map((mapping) => mapping.sheetName));
  const pricingSheetNames = new Set(draftMappings.filter((mapping) => pricingFieldKeys.has(mapping.fieldKey)).map((mapping) => mapping.sheetName));
  const mappingStructureValid = orderSheetNames.size === 1 && pricingSheetNames.size === 1 && Array.from(orderSheetNames)[0] !== Array.from(pricingSheetNames)[0];
  const mappingComplete = requiredFields.length > 0 && completedCount === requiredFields.length && mappingStructureValid;

  const selectCell = (rowIndex: number, columnIndex: number, header: string): void => {
    if (!activeFieldKey || !activeSheet) {
      toast.info("请先点击右侧的“选取表头”");
      return;
    }
    if (!header.trim()) {
      toast.warning("空单元格不能作为表头");
      return;
    }
    const field = requiredFields.find((item) => item.key === activeFieldKey);
    if (!field) return;
    const sameGroupSheet = requiredFields
      .filter((item) => item.group === field.group && item.key !== field.key)
      .map((item) => mappingByField.get(item.key)?.sheetName)
      .find(Boolean);
    if (sameGroupSheet && sameGroupSheet !== activeSheet.name) {
      toast.warning(`${field.group}必须选择同一个 Sheet：${sameGroupSheet}`);
      return;
    }
    const otherGroupSheet = requiredFields
      .filter((item) => item.group !== field.group)
      .map((item) => mappingByField.get(item.key)?.sheetName)
      .find(Boolean);
    if (otherGroupSheet === activeSheet.name) {
      toast.warning("订单页和核价页不能是同一个 Sheet");
      return;
    }
    const next: HeaderTemplateFieldMapping = {
      fieldKey: field.key,
      label: field.label,
      sheetName: activeSheet.name,
      headerRow: activeSheet.startRow + rowIndex + 1,
      column: activeSheet.startColumn + columnIndex + 1,
      header: header.trim(),
    };
    const multiSelect = MULTI_SELECT_FIELD_KEYS.has(field.key);
    setDraftMappings((current) => {
      if (!multiSelect) return [...current.filter((mapping) => mapping.fieldKey !== field.key), next];
      const duplicate = current.some((mapping) => mapping.fieldKey === field.key
        && mapping.sheetName === next.sheetName
        && mapping.headerRow === next.headerRow
        && mapping.column === next.column);
      return duplicate ? current : [...current, next];
    });
    if (multiSelect) return;
    const nextField = requiredFields.find((item) => item.key !== field.key && !draftMappings.some((mapping) => mapping.fieldKey === item.key));
    setActiveFieldKey(nextField?.key ?? null);
  };

  const removeMapping = (target: HeaderTemplateFieldMapping): void => {
    setDraftMappings((current) => current.filter((mapping) => mapping !== target));
    setActiveFieldKey(target.fieldKey);
  };

  const saveMappings = async (): Promise<void> => {
    if (!api || !detail || !mappingComplete || saving) return;
    setSaving(true);
    try {
      const saved = await api.updateHeaderTemplateMappings({ id: detail.id, mappings: draftMappings });
      setDetail(saved);
      setTemplates((current) => current.map((record) => record.id === saved.id ? saved : record));
      toast.success("模板字段映射已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "模板字段映射保存失败");
    } finally {
      setSaving(false);
    }
  };

  const currentDrawerBounds = useMemo(() => templateDrawerBounds(viewportWidth), [viewportWidth]);
  const currentFieldsBounds = useMemo(() => templateFieldsBounds(drawerWidth), [drawerWidth]);

  const startDrawerResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    drawerResizeRef.current = { startX: event.clientX, startWidth: drawerWidth };
  };

  const startFieldsResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    fieldsResizeRef.current = { startX: event.clientX, startWidth: fieldsWidth };
  };

  const resizeDrawerWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const delta = event.key === "ArrowLeft" ? TEMPLATE_DRAWER_KEYBOARD_STEP : event.key === "ArrowRight" ? -TEMPLATE_DRAWER_KEYBOARD_STEP : 0;
    if (!delta) return;
    event.preventDefault();
    setDrawerWidth((current) => clampTemplateDrawerWidth(current + delta));
  };

  const resizeFieldsWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const delta = event.key === "ArrowLeft" ? TEMPLATE_FIELDS_KEYBOARD_STEP : event.key === "ArrowRight" ? -TEMPLATE_FIELDS_KEYBOARD_STEP : 0;
    if (!delta) return;
    event.preventDefault();
    setFieldsWidth((current) => clampTemplateFieldsWidth(current + delta, drawerWidth));
  };

  return (
    <section className="template-page" aria-label="模板管理">
      <section className="template-table-card">
        <header className="template-table-toolbar">
          <strong>模板列表</strong>
          <Button type="button" onClick={() => void createTemplate()} disabled={!api || creating}>{creating ? <LoaderCircle className="is-spinning" /> : <FilePlus2 />}新建模板</Button>
        </header>
        <table className="template-table">
          <thead><tr><th>创建时间</th><th>创建人</th><th>模板文件</th><th>映射状态</th><th>操作</th></tr></thead>
          <tbody>{templates.map((record) => {
            const mapped = requiredFields.filter((field) => record.mappings.some((mapping) => mapping.fieldKey === field.key)).length;
            return <tr key={record.id}><td>{formatCreatedAt(record.createdAt)}</td><td>{record.createdBy}</td><td><span className="template-file-cell"><FileSpreadsheet />{record.fileName}</span></td><td><span className={mapped === requiredFields.length ? "template-mapping-status is-complete" : "template-mapping-status"}>{mapped}/{requiredFields.length} 项</span></td><td><div className="template-row-actions"><button type="button" onClick={() => void openDetail(record)}>详情</button><button type="button" className="is-delete" disabled={deletingId === record.id} onClick={() => setDeleteCandidate(record)}>{deletingId === record.id ? "删除中" : "删除"}</button></div></td></tr>;
          })}</tbody>
        </table>
        {loading ? <div className="template-table-state"><LoaderCircle className="is-spinning" /><strong>正在读取模板</strong></div> : templates.length === 0 ? <div className="template-table-state"><FileSpreadsheet /><strong>暂无模板</strong><span>点击“新建模板”导入表头文件</span></div> : null}
      </section>

      {detail ? <div className="template-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetail(null); }}>
        <aside className="template-detail" style={{ width: `${drawerWidth}px` }} role="dialog" aria-modal="true" aria-labelledby="template-detail-title">
          <div
            className="template-drawer-resizer"
            role="separator"
            aria-label="调整模板详情抽屉宽度"
            aria-orientation="vertical"
            aria-valuemin={currentDrawerBounds.min}
            aria-valuemax={currentDrawerBounds.max}
            aria-valuenow={drawerWidth}
            tabIndex={0}
            onPointerDown={startDrawerResize}
            onKeyDown={resizeDrawerWithKeyboard}
          ><i /></div>
          <header><div><span>模板详情</span><h2 id="template-detail-title">{detail.fileName}</h2></div><button type="button" aria-label="关闭模板详情" onClick={() => setDetail(null)}><X /></button></header>
          <div className="template-detail-body" style={{ gridTemplateColumns: `minmax(${TEMPLATE_PREVIEW_MIN_WIDTH}px, 1fr) ${TEMPLATE_BODY_RESIZER_WIDTH}px ${fieldsWidth}px` }}>
            <section className="template-preview-card">
              <div className="template-sheet-tabs">{sheets.map((sheet) => <button type="button" className={sheet.name === activeSheetName ? "is-active" : undefined} key={sheet.name} onClick={() => setActiveSheetName(sheet.name)}>{sheet.name}</button>)}</div>
              <div className="template-grid-scroll">
                {previewLoading ? <div className="template-preview-state"><LoaderCircle className="is-spinning" />正在读取模板文件</div> : activeSheet ? <table className="template-grid">
                  <thead><tr><th>#</th>{Array.from({ length: activeSheet.rows[0]?.length ?? 0 }, (_, index) => <th key={index}>{excelColumnLabel(activeSheet.startColumn + index + 1)}</th>)}</tr></thead>
                  <tbody>{activeSheet.rows.map((row, rowIndex) => <tr key={rowIndex}><th>{activeSheet.startRow + rowIndex + 1}</th>{row.map((cell, columnIndex) => {
                    const absoluteRow = activeSheet.startRow + rowIndex + 1;
                    const absoluteColumn = activeSheet.startColumn + columnIndex + 1;
                    const selected = draftMappings.some((mapping) => mapping.sheetName === activeSheet.name && mapping.headerRow === absoluteRow && mapping.column === absoluteColumn);
                    return <td className={selected ? "is-selected-header" : undefined} key={columnIndex}><button type="button" title={cell || "空单元格"} onClick={() => selectCell(rowIndex, columnIndex, cell)}>{cell || " "}</button></td>;
                  })}</tr>)}</tbody>
                </table> : <div className="template-preview-state">模板中没有可预览的 Sheet</div>}
              </div>
            </section>

            <div
              className="template-fields-resizer"
              role="separator"
              aria-label="调整预览与必填字段宽度"
              aria-orientation="vertical"
              aria-valuemin={currentFieldsBounds.min}
              aria-valuemax={currentFieldsBounds.max}
              aria-valuenow={fieldsWidth}
              tabIndex={0}
              onPointerDown={startFieldsResize}
              onKeyDown={resizeFieldsWithKeyboard}
            ><i /></div>
            <section className="template-required-panel">
              <div className="template-required-heading"><div><span>必填字段</span><strong>{completedCount}/{requiredFields.length}</strong></div><p>{usingFallbackFields ? "配置 fields 为空，当前按订单与核价的最小完整映射校验。" : activeFieldKey ? "请在左侧表格中点击对应的表头单元格" : "必填字段已选择完成"}</p></div>
              <div className="template-field-list">{requiredFieldGroups.map((section) => <section className="template-field-group" key={section.group}>
                <h3>{section.group}</h3>
                {section.fields.map((field) => {
                  const fieldMappings = draftMappings.filter((mapping) => mapping.fieldKey === field.key);
                  const mapping = fieldMappings[0];
                  const multiSelect = MULTI_SELECT_FIELD_KEYS.has(field.key);
                  const active = activeFieldKey === field.key;
                  return <article className={`${active ? "is-active" : ""}${mapping ? " is-mapped" : ""}`} key={field.key}>
                    <div><span>{mapping ? <Check /> : null}{field.label}</span>{multiSelect && fieldMappings.length > 0
                      ? <div className="template-tier-mappings">{fieldMappings.map((item) => <span key={`${item.sheetName}-${item.headerRow}-${item.column}`}><small>{excelColumnLabel(item.column)}{item.headerRow} · {item.header}</small><button type="button" aria-label={`移除价格档位 ${item.header}`} onClick={() => removeMapping(item)}><X /></button></span>)}</div>
                      : <small>{mapping ? `${mapping.sheetName} · ${excelColumnLabel(mapping.column)}${mapping.headerRow} · ${mapping.header}` : "尚未选择"}</small>}</div>
                    <button type="button" onClick={() => { setActiveFieldKey(field.key); if (mapping) setActiveSheetName(mapping.sheetName); }}>{multiSelect ? mapping ? "继续选择" : "选择档位" : mapping ? "重新选择" : "选取表头"}</button>
                  </article>;
                })}
              </section>)}</div>
              <Button type="button" className="template-save-button" disabled={!mappingComplete || saving} onClick={() => void saveMappings()}>{saving ? <LoaderCircle className="is-spinning" /> : <Save />}保存字段映射</Button>
            </section>
          </div>
        </aside>
      </div> : null}
      <ConfirmDialog
        open={Boolean(deleteCandidate)}
        title="删除这个模板？"
        description={deleteCandidate ? `模板“${deleteCandidate.fileName}”将被永久删除，此操作无法撤销。` : ""}
        confirmLabel="确认删除"
        tone="danger"
        busy={Boolean(deletingId)}
        onConfirm={() => { if (deleteCandidate) void deleteTemplate(deleteCandidate); }}
        onCancel={() => setDeleteCandidate(null)}
      />
    </section>
  );
}

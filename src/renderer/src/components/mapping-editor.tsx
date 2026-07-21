import { ChevronDown, Plus, Trash2 } from "lucide-react";
import type { PriceAnalysisFile, PriceCheckMapping, PriceMappingValidation } from "../../../preload";
import type { ExcelPreviewSheet, ExcelPreviewWorkbook } from "../lib/excel-preview";
import { Button } from "./ui/button";

export type MappingFieldTarget =
  | "orderHeaderRow"
  | "businessOrderNumberColumn"
  | "platformOrderNumberColumn"
  | "countryCodeColumn"
  | "countryEnglishColumn"
  | "countryChineseColumn"
  | "shippingMethodColumn"
  | "orderPriceColumn"
  | "pricingHeaderRow"
  | "pricingQuantityHeaderRow"
  | "pricingSkuColumn"
  | "pricingCountryColumn"
  | "pricingShippingMethodColumn"
  | `skuQtyPairs.${number}.skuColumn`
  | `skuQtyPairs.${number}.qtyColumn`
  | `quantityTierColumns.${number}.column`;

export type MappingValidationState = {
  status: "idle" | "stale" | "validating" | "ready";
  result: PriceMappingValidation | null;
};

type MappingEditorProps = {
  analysis: PriceAnalysisFile;
  mapping: PriceCheckMapping;
  workbook: ExcelPreviewWorkbook | null;
  activeSheetName: string;
  activeTarget: MappingFieldTarget | null;
  validation: MappingValidationState;
  onActiveTargetChange: (target: MappingFieldTarget | null) => void;
  onMappingChange: (mapping: PriceCheckMapping) => void;
  onColumnChange: (target: MappingFieldTarget, column: number | null, header: string) => void;
  onSheetChange: (orderSheet: string, pricingSheet: string, previewSheet: string) => void;
  onPreviewSheetChange: (sheetName: string) => void;
  onConfirm: () => void;
};

type ColumnOption = { value: number; label: string };

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

function sheetFor(workbook: ExcelPreviewWorkbook | null, name: string): ExcelPreviewSheet | null {
  return workbook?.sheets.find((sheet) => sheet.name === name) ?? null;
}

function columnOptions(sheet: ExcelPreviewSheet | null, headerRow: number): ColumnOption[] {
  if (!sheet) return [];
  const row = sheet.rows[headerRow - sheet.startRow - 1] ?? [];
  return Array.from({ length: sheet.displayedColumnCount }, (_, index) => {
    const value = sheet.startColumn + index + 1;
    const header = row[index]?.trim();
    return { value, label: `${excelColumnLabel(value)} · ${header || "（空表头）"}` };
  });
}

function headerText(sheet: ExcelPreviewSheet | null, headerRow: number, column: number): string {
  if (!sheet || column <= 0) return "";
  return sheet.rows[headerRow - sheet.startRow - 1]?.[column - sheet.startColumn - 1]?.trim() ?? "";
}

function FieldSelect({
  label,
  value,
  options,
  target,
  activeTarget,
  optional = false,
  onActiveTargetChange,
  onChange,
}: {
  label: string;
  value: number | null | undefined;
  options: ColumnOption[];
  target: MappingFieldTarget;
  activeTarget: MappingFieldTarget | null;
  optional?: boolean;
  onActiveTargetChange: (target: MappingFieldTarget) => void;
  onChange: (column: number | null) => void;
}): React.JSX.Element {
  const selected = options.find((option) => option.value === value);
  return (
    <div className={`mapping-field${activeTarget === target ? " is-active" : ""}`}>
      <span>{label}<em>{activeTarget === target ? "等待选择" : ""}</em></span>
      <div className="mapping-field-control">
        <button type="button" aria-label={`选择${label}，当前${selected?.label ?? (optional ? "不使用" : "未选择")}`} onClick={() => onActiveTargetChange(target)}>
          <strong>{activeTarget === target ? "请点击左侧表格" : selected?.label ?? (optional ? "不使用" : "未选择")}</strong>
        </button>
        <span className="mapping-field-fallback">
          <ChevronDown aria-hidden="true" />
          <select
            aria-label={label}
            title={`${label}备用下拉选择`}
            value={value ?? ""}
            onFocus={() => onActiveTargetChange(target)}
            onChange={(event) => onChange(event.currentTarget.value ? Number(event.currentTarget.value) : null)}
          >
            <option value="">{optional ? "不使用" : "请选择"}</option>
            {options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </span>
      </div>
    </div>
  );
}

export function MappingEditor({
  analysis,
  mapping,
  workbook,
  activeSheetName,
  activeTarget,
  validation,
  onActiveTargetChange,
  onMappingChange,
  onColumnChange,
  onSheetChange,
  onPreviewSheetChange,
  onConfirm,
}: MappingEditorProps): React.JSX.Element {
  const orderSheet = sheetFor(workbook, mapping.orderSheet);
  const pricingSheet = sheetFor(workbook, mapping.pricingSheet);
  const orderOptions = columnOptions(orderSheet, mapping.orderHeaderRow);
  const pricingOptions = columnOptions(pricingSheet, mapping.pricingHeaderRow);
  const tierOptions = columnOptions(pricingSheet, mapping.pricingQuantityHeaderRow ?? mapping.pricingHeaderRow);
  const update = (patch: Partial<PriceCheckMapping>): void => onMappingChange({ ...mapping, ...patch });
  const validationErrors = validation.result?.errors ?? [];
  const validationMessages = validation.result?.requestVersion === 0 ? validationErrors : [...validationErrors, ...(validation.result?.warnings ?? [])];
  const canConfirm = validation.status === "ready" && validationErrors.length === 0;

  return (
    <section className="mapping-editor" aria-label="字段映射编辑器">
      <div className="mapping-editor-heading">
        <div><h3>字段映射</h3><small>先选择字段，再点击左侧表格中的任意单元格</small></div>
        <span className={`mapping-validation-state is-${validation.status}`}>
          {validation.status === "validating" ? "正在重新试算" : validation.status === "stale" ? "映射待校验" : validation.status === "ready" ? "试算已更新" : "等待编辑"}
        </span>
      </div>

      <div className="mapping-sheet-switches">
        <label>订单 Sheet<select aria-label="订单 Sheet" value={mapping.orderSheet} onChange={(event) => onSheetChange(event.currentTarget.value, mapping.pricingSheet, event.currentTarget.value)}>{analysis.orderSheetCandidates.map((candidate) => <option value={candidate.sheetName} key={candidate.sheetName}>{candidate.sheetName} · {candidate.score.toFixed(1)} 分</option>)}</select></label>
        <label>核价 Sheet<select aria-label="核价 Sheet" value={mapping.pricingSheet} onChange={(event) => onSheetChange(mapping.orderSheet, event.currentTarget.value, event.currentTarget.value)}>{analysis.pricingSheetCandidates.map((candidate) => <option value={candidate.sheetName} key={candidate.sheetName}>{candidate.sheetName} · {candidate.score.toFixed(1)} 分</option>)}</select></label>
      </div>

      <details open={activeSheetName === mapping.orderSheet} onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) onPreviewSheetChange(mapping.orderSheet); }}>
        <summary>订单字段</summary>
        <div className="mapping-fields">
          <label className={`mapping-field${activeTarget === "orderHeaderRow" ? " is-active" : ""}`} onClick={() => onActiveTargetChange("orderHeaderRow")}><span>表头行<em>{activeTarget === "orderHeaderRow" ? "点击行号选择" : ""}</em></span><input aria-label="订单表头行" type="number" min={1} max={orderSheet?.rowCount ?? 1} value={mapping.orderHeaderRow} onFocus={() => onActiveTargetChange("orderHeaderRow")} onChange={(event) => update({ orderHeaderRow: Number(event.currentTarget.value) || 0 })} /></label>
          <FieldSelect label="业务订单号" value={mapping.businessOrderNumberColumn} options={orderOptions} target="businessOrderNumberColumn" activeTarget={activeTarget} optional onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("businessOrderNumberColumn", column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0))} />
          <FieldSelect label="平台订单号" value={mapping.platformOrderNumberColumn} options={orderOptions} target="platformOrderNumberColumn" activeTarget={activeTarget} optional onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("platformOrderNumberColumn", column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0))} />
          <FieldSelect label="国家二字码" value={mapping.countryCodeColumn} options={orderOptions} target="countryCodeColumn" activeTarget={activeTarget} optional onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("countryCodeColumn", column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0))} />
          <FieldSelect label="英文国家名" value={mapping.countryEnglishColumn} options={orderOptions} target="countryEnglishColumn" activeTarget={activeTarget} optional onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("countryEnglishColumn", column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0))} />
          <FieldSelect label="中文国家名" value={mapping.countryChineseColumn} options={orderOptions} target="countryChineseColumn" activeTarget={activeTarget} optional onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("countryChineseColumn", column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0))} />
          <FieldSelect label="物流方式" value={mapping.shippingMethodColumn} options={orderOptions} target="shippingMethodColumn" activeTarget={activeTarget} optional onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("shippingMethodColumn", column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0))} />
          <FieldSelect label="原始价格" value={mapping.orderPriceColumn} options={orderOptions} target="orderPriceColumn" activeTarget={activeTarget} optional onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("orderPriceColumn", column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0))} />
        </div>
        <div className="mapping-repeat-list">
          {mapping.skuQtyPairs.map((pair, index) => <div className="mapping-repeat-row" key={index}>
            <b>SKU/数量 {index + 1}</b>
            <FieldSelect label={`SKU ${index + 1}`} value={pair.skuColumn || null} options={orderOptions} target={`skuQtyPairs.${index}.skuColumn`} activeTarget={activeTarget} onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange(`skuQtyPairs.${index}.skuColumn`, column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0))} />
            <FieldSelect label={`数量 ${index + 1}`} value={pair.qtyColumn || null} options={orderOptions} target={`skuQtyPairs.${index}.qtyColumn`} activeTarget={activeTarget} onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange(`skuQtyPairs.${index}.qtyColumn`, column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0))} />
            <button type="button" aria-label={`删除 SKU/数量 ${index + 1}`} disabled={mapping.skuQtyPairs.length === 1} onClick={() => update({ skuQtyPairs: mapping.skuQtyPairs.filter((_, pairIndex) => pairIndex !== index) })}><Trash2 /></button>
          </div>)}
          <Button type="button" variant="outline" size="sm" onClick={() => update({ skuQtyPairs: [...mapping.skuQtyPairs, { skuColumn: 0, qtyColumn: 0, skuHeader: "", qtyHeader: "" }] })}><Plus />添加 SKU/数量</Button>
        </div>
      </details>

      <details open={activeSheetName === mapping.pricingSheet} onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) onPreviewSheetChange(mapping.pricingSheet); }}>
        <summary>核价字段</summary>
        <div className="mapping-fields">
          <label className={`mapping-field${activeTarget === "pricingHeaderRow" ? " is-active" : ""}`} onClick={() => onActiveTargetChange("pricingHeaderRow")}><span>表头行<em>{activeTarget === "pricingHeaderRow" ? "点击行号选择" : ""}</em></span><input aria-label="核价表头行" type="number" min={1} max={pricingSheet?.rowCount ?? 1} value={mapping.pricingHeaderRow} onFocus={() => onActiveTargetChange("pricingHeaderRow")} onChange={(event) => update({ pricingHeaderRow: Number(event.currentTarget.value) || 0 })} /></label>
          <label className={`mapping-field${activeTarget === "pricingQuantityHeaderRow" ? " is-active" : ""}`} onClick={() => onActiveTargetChange("pricingQuantityHeaderRow")}><span>档位表头行<em>{activeTarget === "pricingQuantityHeaderRow" ? "点击行号选择" : ""}</em></span><input aria-label="数量档位表头行" type="number" min={1} max={pricingSheet?.rowCount ?? 1} value={mapping.pricingQuantityHeaderRow ?? ""} placeholder="同表头行" onFocus={() => onActiveTargetChange("pricingQuantityHeaderRow")} onChange={(event) => update({ pricingQuantityHeaderRow: event.currentTarget.value ? Number(event.currentTarget.value) : null })} /></label>
          <FieldSelect label="核价 SKU" value={mapping.pricingSkuColumn || null} options={pricingOptions} target="pricingSkuColumn" activeTarget={activeTarget} onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("pricingSkuColumn", column, headerText(pricingSheet, mapping.pricingHeaderRow, column ?? 0))} />
          <FieldSelect label="核价国家" value={mapping.pricingCountryColumn || null} options={pricingOptions} target="pricingCountryColumn" activeTarget={activeTarget} onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("pricingCountryColumn", column, headerText(pricingSheet, mapping.pricingHeaderRow, column ?? 0))} />
          <FieldSelect label="核价物流" value={mapping.pricingShippingMethodColumn} options={pricingOptions} target="pricingShippingMethodColumn" activeTarget={activeTarget} optional onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("pricingShippingMethodColumn", column, headerText(pricingSheet, mapping.pricingHeaderRow, column ?? 0))} />
        </div>
        <div className="mapping-repeat-list">
          {mapping.quantityTierColumns.map((tier, index) => <div className="mapping-repeat-row is-tier" key={index}>
            <label><span>数量档位</span><input aria-label={`数量档位 ${index + 1}`} type="number" min={0} value={tier.quantity} onChange={(event) => { const tiers = mapping.quantityTierColumns.map((item, tierIndex) => tierIndex === index ? { ...item, quantity: Number(event.currentTarget.value) || 0 } : item); update({ quantityTierColumns: tiers }); }} /></label>
            <FieldSelect label={`价格列 ${index + 1}`} value={tier.column || null} options={tierOptions} target={`quantityTierColumns.${index}.column`} activeTarget={activeTarget} onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange(`quantityTierColumns.${index}.column`, column, headerText(pricingSheet, mapping.pricingQuantityHeaderRow ?? mapping.pricingHeaderRow, column ?? 0))} />
            <button type="button" aria-label={`删除数量档位 ${index + 1}`} disabled={mapping.quantityTierColumns.length === 1} onClick={() => update({ quantityTierColumns: mapping.quantityTierColumns.filter((_, tierIndex) => tierIndex !== index) })}><Trash2 /></button>
          </div>)}
          <Button type="button" variant="outline" size="sm" onClick={() => update({ quantityTierColumns: [...mapping.quantityTierColumns, { quantity: 0, column: 0, header: "" }] })}><Plus />添加数量档位</Button>
        </div>
      </details>

      {validation.result ? <div className={`mapping-validation-result${validationErrors.length ? " is-error" : validation.result.requestVersion > 0 && validation.result.warnings.length ? " is-warning" : " is-success"}`}><strong>试算 {validation.result.matchedRows}/{validation.result.evaluatedRows} 行 · {(validation.result.coverage * 100).toFixed(1)}%</strong>{validationMessages.map((message) => <span key={message}>{message}</span>)}</div> : null}
      <Button type="button" disabled={!canConfirm} onClick={onConfirm}>确认并处理此文件</Button>
    </section>
  );
}

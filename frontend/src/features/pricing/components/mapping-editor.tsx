import { ChevronDown, Plus, Trash2 } from "lucide-react";
import type {
  PriceAnalysisFile,
  PriceCheckMapping,
  PriceMappingValidation,
  SingleShipmentMatchField,
} from "../../../../../backend/electron/preload";
import type { ExcelPreviewSheet, ExcelPreviewWorkbook } from "@/lib/excel-preview";
import type { MappingFieldTarget } from "@/features/pricing/mapping";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type { MappingFieldTarget } from "@/features/pricing/mapping";

export type MappingValidationState = {
  status: "idle" | "stale" | "validating" | "ready";
  result: PriceMappingValidation | null;
};

type MappingEditorProps = {
  analysis: PriceAnalysisFile;
  mapping: PriceCheckMapping;
  workbook: ExcelPreviewWorkbook | null;
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

/** 无表头文案时在字段映射下拉/选中态中显示 */
const EMPTY_HEADER_LABEL = "空表头";
const WRITEBACK_COLUMN_COUNT = 3;
const SINGLE_SHIPMENT_FIELD_LABELS: Record<SingleShipmentMatchField, string> = {
  recipient_name: "收件人姓名",
  phone: "电话",
  postal_code: "邮编",
  address: "完整地址",
  email: "邮箱",
};

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

function formatColumnOptionLabel(column: number, header: string | null | undefined): string {
  const text = header?.trim() ?? "";
  return `${excelColumnLabel(column)} · ${text || EMPTY_HEADER_LABEL}`;
}

function previewOrderColumn(column: number, orderPriceColumn: number | null | undefined): number {
  return orderPriceColumn && column > orderPriceColumn
    ? column + WRITEBACK_COLUMN_COUNT
    : column;
}

function sheetFor(workbook: ExcelPreviewWorkbook | null, name: string): ExcelPreviewSheet | null {
  return workbook?.sheets.find((sheet) => sheet.name === name) ?? null;
}

function columnOptions(
  sheet: ExcelPreviewSheet | null,
  headerRow: number,
  displayColumn: (column: number) => number = (column) => column,
): ColumnOption[] {
  if (!sheet) return [];
  // 使用完整列数（含截断前）与当前展示列数的较大值，避免空表头列被裁掉
  const columnSpan = Math.max(sheet.displayedColumnCount, sheet.columnCount);
  const row = sheet.rows[headerRow - sheet.startRow - 1] ?? [];
  return Array.from({ length: columnSpan }, (_, index) => {
    const value = sheet.startColumn + index + 1;
    // 预览截断时超出 displayed 的列没有单元格，仍保留为可选「空表头」
    const header = index < sheet.displayedColumnCount ? (row[index] ?? "") : "";
    return { value, label: formatColumnOptionLabel(displayColumn(value), header) };
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
  displayColumn = (column) => column,
}: {
  label: string;
  value: number | null | undefined;
  options: ColumnOption[];
  target: MappingFieldTarget;
  activeTarget: MappingFieldTarget | null;
  optional?: boolean;
  onActiveTargetChange: (target: MappingFieldTarget) => void;
  onChange: (column: number | null) => void;
  displayColumn?: (column: number) => number;
}): React.JSX.Element {
  const selected = options.find((option) => option.value === value);
  // 已选列不在 options 中时（预览未加载/截断）仍显示列标 + 空表头，避免空白
  const selectedLabel = selected?.label
    ?? (value && value > 0 ? formatColumnOptionLabel(displayColumn(value), "") : null)
    ?? (optional ? "不使用" : "未选择");
  const selectOptions = value && value > 0 && !selected
    ? [...options, { value, label: formatColumnOptionLabel(displayColumn(value), "") }]
    : options;
  return (
    <div className={`mapping-field${activeTarget === target ? " is-active" : ""}`} onClick={() => onActiveTargetChange(target)}>
      <span>{label}<em>{activeTarget === target ? "等待选择" : ""}</em></span>
      <div className="mapping-field-control">
        <button type="button" aria-label={`选择${label}，当前${selectedLabel}`} onClick={() => onActiveTargetChange(target)}>
          <strong>{activeTarget === target ? "请点击左侧表格" : selectedLabel}</strong>
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
            {selectOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
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
  const displayOrderColumn = (column: number): number =>
    previewOrderColumn(column, mapping.orderPriceColumn);
  const orderOptions = columnOptions(orderSheet, mapping.orderHeaderRow, displayOrderColumn);
  const pricingOptions = columnOptions(pricingSheet, mapping.pricingHeaderRow);
  const tierOptions = columnOptions(pricingSheet, mapping.pricingQuantityHeaderRow ?? mapping.pricingHeaderRow);
  const update = (patch: Partial<PriceCheckMapping>): void => onMappingChange({ ...mapping, ...patch });
  const validationErrors = validation.result?.errors ?? [];
  const canConfirm = validation.status === "ready" && validationErrors.length === 0;
  const singleShipmentMatching =
    validation.result?.singleShipmentMatching ?? analysis.singleShipmentMatching;
  const editableSingleShipmentFields = mapping.singleShipmentFields?.length
    ? mapping.singleShipmentFields
    : singleShipmentMatching?.fields ?? [];

  return (
    <section className="mapping-editor" aria-label="字段映射编辑器">
      <div className="mapping-editor-scroll">
      <div className="mapping-editor-heading">
        <h3>字段映射</h3>
      </div>

      <div className="mapping-sheet-switches">
        <label>订单 Sheet<Select value={mapping.orderSheet} onValueChange={(value) => onSheetChange(value, mapping.pricingSheet, value)}><SelectTrigger className="mapping-sheet-select" aria-label="订单 Sheet"><SelectValue /></SelectTrigger><SelectContent>{analysis.orderSheetCandidates.map((candidate) => <SelectItem value={candidate.sheetName} key={candidate.sheetName}>{candidate.sheetName} · {candidate.score.toFixed(1)} 分</SelectItem>)}</SelectContent></Select></label>
        <label>核价 Sheet<Select value={mapping.pricingSheet} onValueChange={(value) => onSheetChange(mapping.orderSheet, value, value)}><SelectTrigger className="mapping-sheet-select" aria-label="核价 Sheet"><SelectValue /></SelectTrigger><SelectContent>{analysis.pricingSheetCandidates.map((candidate) => <SelectItem value={candidate.sheetName} key={candidate.sheetName}>{candidate.sheetName} · {candidate.score.toFixed(1)} 分</SelectItem>)}</SelectContent></Select></label>
      </div>

      <details onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) onPreviewSheetChange(mapping.orderSheet); }}>
        <summary>订单字段</summary>
        <div className="mapping-fields">
          <label className={`mapping-field${activeTarget === "orderHeaderRow" ? " is-active" : ""}`} onClick={() => onActiveTargetChange("orderHeaderRow")}><span>表头行<em>{activeTarget === "orderHeaderRow" ? "点击行号选择" : ""}</em></span><input aria-label="订单表头行" type="number" min={1} max={orderSheet?.rowCount ?? 1} value={mapping.orderHeaderRow} onFocus={() => onActiveTargetChange("orderHeaderRow")} onChange={(event) => update({ orderHeaderRow: Number(event.currentTarget.value) || 0 })} /></label>
          <FieldSelect label="订单号" value={mapping.businessOrderNumberColumn} options={orderOptions} target="businessOrderNumberColumn" activeTarget={activeTarget} optional onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("businessOrderNumberColumn", column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0))} />
          <FieldSelect label="国家二字码" value={mapping.countryCodeColumn} options={orderOptions} target="countryCodeColumn" activeTarget={activeTarget} optional onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("countryCodeColumn", column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0))} />
          <FieldSelect label="英文国家名" value={mapping.countryEnglishColumn} options={orderOptions} target="countryEnglishColumn" activeTarget={activeTarget} optional onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("countryEnglishColumn", column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0))} />
          <FieldSelect label="中文国家名" value={mapping.countryChineseColumn} options={orderOptions} target="countryChineseColumn" activeTarget={activeTarget} optional onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("countryChineseColumn", column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0))} />
          <FieldSelect label="原始价格" value={mapping.orderPriceColumn} options={orderOptions} target="orderPriceColumn" activeTarget={activeTarget} optional onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("orderPriceColumn", column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0))} />
        </div>
        <div className="mapping-repeat-list">
          {mapping.skuQtyPairs.map((pair, index) => <div className="mapping-repeat-row is-sku-quantity" key={index}>
            <b>SKU/数量 {index + 1}</b>
            <FieldSelect label={`SKU ${index + 1}`} value={pair.skuColumn || null} options={orderOptions} target={`skuQtyPairs.${index}.skuColumn`} activeTarget={activeTarget} onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange(`skuQtyPairs.${index}.skuColumn`, column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0))} />
            <FieldSelect label={`数量 ${index + 1}`} value={(pair.directQuantity ? pair.qtyColumn : pair.mergedQtyColumn) || null} options={orderOptions} target={`skuQtyPairs.${index}.${pair.directQuantity ? "qtyColumn" : "mergedQtyColumn"}`} activeTarget={activeTarget} onActiveTargetChange={onActiveTargetChange} onChange={(column) => {
              const field = pair.directQuantity ? "qtyColumn" : "mergedQtyColumn";
              onColumnChange(`skuQtyPairs.${index}.${field}`, column, headerText(orderSheet, mapping.orderHeaderRow, column ?? 0));
            }} />
          </div>)}
        </div>
      </details>

      {singleShipmentMatching?.enabled ? (
      <details className="single-shipment-mapping" onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) onPreviewSheetChange(mapping.orderSheet); }}>
        <summary>
          <span>单独发货判断</span>
          <em className={singleShipmentMatching?.ready ? "is-ready" : "is-general"}>
            {singleShipmentMatching?.ready ? "可匹配" : "通用价格"}
          </em>
        </summary>
        <div className="single-shipment-status">
          <strong>
            {singleShipmentMatching
              ? singleShipmentMatching.enabled
                ? "配置已开启"
                : "配置未开启"
              : "配置状态待重新分析"}
          </strong>
          <p>{singleShipmentMatching?.reason ?? "请重新分析文件以读取当前配置状态"}</p>
          {singleShipmentMatching?.fields.length ? (
            <ul aria-label="单独发货联合字段识别结果">
              {singleShipmentMatching.fields.map((field) => (
                <li className={field.columns.length > 0 ? "is-found" : "is-missing"} key={field.field}>
                  <span>{SINGLE_SHIPMENT_FIELD_LABELS[field.field]}</span>
                  <b>
                    {field.columns.length > 0
                      ? field.columns.map((column, index) =>
                        formatColumnOptionLabel(displayOrderColumn(column), field.headers[index])).join(" + ")
                      : "未识别"}
                  </b>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {editableSingleShipmentFields.length ? (
          <div className="mapping-fields">
            {editableSingleShipmentFields.map((field, index) => (
              <FieldSelect
                label={SINGLE_SHIPMENT_FIELD_LABELS[field.field]}
                value={field.columns[0] ?? null}
                options={orderOptions}
                target={`singleShipmentFields.${index}.column`}
                activeTarget={activeTarget}
                optional
                displayColumn={displayOrderColumn}
                onActiveTargetChange={onActiveTargetChange}
                onChange={(column) => onColumnChange(
                  `singleShipmentFields.${index}.column`,
                  column,
                  headerText(orderSheet, mapping.orderHeaderRow, column ?? 0),
                )}
                key={field.field}
              />
            ))}
          </div>
        ) : null}
      </details>
      ) : null}

      <details onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) onPreviewSheetChange(mapping.pricingSheet); }}>
        <summary>核价字段</summary>
        <div className="mapping-fields">
          <label className={`mapping-field${activeTarget === "pricingHeaderRow" ? " is-active" : ""}`} onClick={() => onActiveTargetChange("pricingHeaderRow")}><span>表头行<em>{activeTarget === "pricingHeaderRow" ? "点击行号选择" : ""}</em></span><input aria-label="核价表头行" type="number" min={1} max={pricingSheet?.rowCount ?? 1} value={mapping.pricingHeaderRow} onFocus={() => onActiveTargetChange("pricingHeaderRow")} onChange={(event) => update({ pricingHeaderRow: Number(event.currentTarget.value) || 0 })} /></label>
          <label className={`mapping-field${activeTarget === "pricingQuantityHeaderRow" ? " is-active" : ""}`} onClick={() => onActiveTargetChange("pricingQuantityHeaderRow")}><span>档位表头行<em>{activeTarget === "pricingQuantityHeaderRow" ? "点击行号选择" : ""}</em></span><input aria-label="数量档位表头行" type="number" min={1} max={pricingSheet?.rowCount ?? 1} value={mapping.pricingQuantityHeaderRow ?? ""} placeholder="同表头行" onFocus={() => onActiveTargetChange("pricingQuantityHeaderRow")} onChange={(event) => update({ pricingQuantityHeaderRow: event.currentTarget.value ? Number(event.currentTarget.value) : null })} /></label>
          <FieldSelect label="核价 SKU" value={mapping.pricingSkuColumn || null} options={pricingOptions} target="pricingSkuColumn" activeTarget={activeTarget} onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("pricingSkuColumn", column, headerText(pricingSheet, mapping.pricingHeaderRow, column ?? 0))} />
          <FieldSelect label="核价国家" value={mapping.pricingCountryColumn || null} options={pricingOptions} target="pricingCountryColumn" activeTarget={activeTarget} onActiveTargetChange={onActiveTargetChange} onChange={(column) => onColumnChange("pricingCountryColumn", column, headerText(pricingSheet, mapping.pricingHeaderRow, column ?? 0))} />
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
      </div>

      <div className="mapping-editor-footer">
        <Button type="button" disabled={!canConfirm} onClick={onConfirm}>确认并处理此文件</Button>
      </div>
    </section>
  );
}

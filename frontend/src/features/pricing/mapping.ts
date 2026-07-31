import type {
  PriceAnalysisCandidate,
  PriceCheckMapping,
} from "@shared/desktop-api";

export type MappingFieldTarget =
  | "orderHeaderRow"
  | "businessOrderNumberColumn"
  | "countryCodeColumn"
  | "countryEnglishColumn"
  | "countryChineseColumn"
  | "singleShipmentColumn"
  | `singleShipmentFields.${number}.column`
  | "orderPriceColumn"
  | "pricingHeaderRow"
  | "pricingQuantityHeaderRow"
  | "pricingSkuColumn"
  | "pricingCountryColumn"
  | `skuQtyPairs.${number}.skuColumn`
  | `skuQtyPairs.${number}.qtyColumn`
  | `skuQtyPairs.${number}.mergedQtyColumn`
  | `quantityTierColumns.${number}.column`;

export function normalizeAlternativeOrderColumns(mapping: PriceCheckMapping): PriceCheckMapping {
  const countryEnglishColumn = mapping.countryEnglishColumn === mapping.countryCodeColumn
    ? null
    : mapping.countryEnglishColumn;
  const countryChineseColumn = mapping.countryChineseColumn === mapping.countryCodeColumn
    || mapping.countryChineseColumn === countryEnglishColumn
    ? null
    : mapping.countryChineseColumn;
  return { ...mapping, countryEnglishColumn, countryChineseColumn };
}

export function buildMapping(
  order: PriceAnalysisCandidate,
  pricing: PriceAnalysisCandidate,
): PriceCheckMapping {
  return normalizeAlternativeOrderColumns({
    orderSheet: order.sheetName,
    orderHeaderRow: order.headerRow,
    businessOrderNumberColumn: order.businessOrderNumberColumn ?? null,
    countryCodeColumn: order.countryCodeColumn ?? null,
    countryEnglishColumn: order.countryEnglishColumn ?? null,
    countryChineseColumn: order.countryChineseColumn ?? null,
    skuQtyPairs: order.skuQtyPairs ?? [],
    singleShipmentColumn: order.singleShipmentColumn ?? null,
    singleShipmentFields: order.singleShipmentFields ?? [],
    orderPriceColumn: order.priceColumn ?? null,
    pricingSheet: pricing.sheetName,
    pricingHeaderRow: pricing.headerRow,
    pricingQuantityHeaderRow: pricing.quantityHeaderRow ?? null,
    pricingSkuColumn: pricing.skuColumn ?? 1,
    pricingCountryColumn: pricing.countryColumn ?? 1,
    quantityTierColumns: pricing.tierColumns ?? [],
  });
}

export function mappingIsComplete(mapping: PriceCheckMapping | null | undefined): boolean {
  return Boolean(
    mapping
    && mapping.businessOrderNumberColumn
    && (mapping.countryCodeColumn || mapping.countryEnglishColumn || mapping.countryChineseColumn)
    && mapping.skuQtyPairs.length > 0
    && mapping.skuQtyPairs.every((pair) => (
      pair.qtyColumn > 0
      && pair.skuColumn > 0
      && pair.mergedQtyColumn > 0
      && pair.qtyColumn !== pair.skuColumn
      && (pair.directQuantity || (
        pair.qtyColumn < pair.skuColumn
        && pair.skuColumn < pair.mergedQtyColumn
      ))
    ))
    && mapping.pricingSkuColumn > 0
    && mapping.pricingCountryColumn > 0
    && mapping.quantityTierColumns.length > 0
    && mapping.orderSheet !== mapping.pricingSheet,
  );
}

export function applyMappingColumn(
  mapping: PriceCheckMapping,
  target: MappingFieldTarget,
  column: number | null,
  header: string,
): PriceCheckMapping {
  const pairMatch = /^skuQtyPairs\.(\d+)\.(skuColumn|qtyColumn|mergedQtyColumn)$/.exec(target);
  if (pairMatch) {
    const pairIndex = Number(pairMatch[1]);
    const field = pairMatch[2] as "skuColumn" | "qtyColumn" | "mergedQtyColumn";
    const headerField = field === "skuColumn"
      ? "skuHeader"
      : field === "qtyColumn"
        ? "qtyHeader"
        : "mergedQtyHeader";
    const currentPair = mapping.skuQtyPairs[pairIndex];
    const pairUpdate = currentPair?.directQuantity && field !== "skuColumn"
      ? {
          qtyColumn: column ?? 0,
          mergedQtyColumn: column ?? 0,
          qtyHeader: header,
          mergedQtyHeader: header,
        }
      : { [field]: column ?? 0, [headerField]: header };
    return {
      ...mapping,
      skuQtyPairs: mapping.skuQtyPairs.map((pair, index) =>
        index === pairIndex ? { ...pair, ...pairUpdate } : pair),
    };
  }
  const tierMatch = /^quantityTierColumns\.(\d+)\.column$/.exec(target);
  if (tierMatch) {
    const tierIndex = Number(tierMatch[1]);
    return {
      ...mapping,
      quantityTierColumns: mapping.quantityTierColumns.map((tier, index) =>
        index === tierIndex ? { ...tier, column: column ?? 0, header } : tier),
    };
  }
  const singleShipmentMatch = /^singleShipmentFields\.(\d+)\.column$/.exec(target);
  if (singleShipmentMatch) {
    const fieldIndex = Number(singleShipmentMatch[1]);
    const singleShipmentFields = (mapping.singleShipmentFields ?? []).map((field, index) =>
      index === fieldIndex
        ? {
            ...field,
            columns: column ? [column] : [],
            headers: column ? [header] : [],
          }
        : field);
    const editedField = singleShipmentFields[fieldIndex];
    return {
      ...mapping,
      singleShipmentFields,
      singleShipmentColumn: editedField?.field === "recipient_name"
        ? column
        : mapping.singleShipmentColumn,
    };
  }
  if (target.endsWith("HeaderRow")) return mapping;
  if (target === "pricingSkuColumn" || target === "pricingCountryColumn") {
    return { ...mapping, [target]: column ?? 0 };
  }
  return { ...mapping, [target]: column };
}

export function mappingTargetLabel(target: MappingFieldTarget | null): string {
  if (!target) return "";
  const labels: Partial<Record<MappingFieldTarget, string>> = {
    orderHeaderRow: "订单表头行",
    businessOrderNumberColumn: "订单号",
    countryCodeColumn: "国家二字码",
    countryEnglishColumn: "英文国家名",
    countryChineseColumn: "中文国家名",
    singleShipmentColumn: "单独发货字段",
    orderPriceColumn: "原始价格",
    pricingHeaderRow: "核价表头行",
    pricingQuantityHeaderRow: "数量档位表头行",
    pricingSkuColumn: "核价 SKU",
    pricingCountryColumn: "核价国家",
  };
  if (labels[target]) return labels[target];
  const singleShipment = /^singleShipmentFields\.(\d+)\.column$/.exec(target);
  if (singleShipment) return `单独发货联合字段 ${Number(singleShipment[1]) + 1}`;
  const pair = /^skuQtyPairs\.(\d+)\.(skuColumn|qtyColumn|mergedQtyColumn)$/.exec(target);
  if (pair) {
    const label = pair[2] === "skuColumn"
      ? "SKU"
      : pair[2] === "qtyColumn"
        ? "原始数量"
        : "合并数量";
    return `${label} ${Number(pair[1]) + 1}`;
  }
  const tier = /^quantityTierColumns\.(\d+)\.column$/.exec(target);
  return tier ? `价格列 ${Number(tier[1]) + 1}` : "字段";
}

export function mappingColumnConflict(
  mapping: PriceCheckMapping,
  target: MappingFieldTarget,
  column: number,
): string | null {
  const pricingTarget = target.startsWith("pricing") || target.startsWith("quantityTierColumns");
  const singleShipmentEntries: Array<[MappingFieldTarget, number]> = (
    mapping.singleShipmentFields?.length
      ? mapping.singleShipmentFields.flatMap((field, index) =>
          field.columns.map((fieldColumn) => [
            `singleShipmentFields.${index}.column` as MappingFieldTarget,
            fieldColumn,
          ] as [MappingFieldTarget, number]))
      : mapping.singleShipmentColumn
        ? [["singleShipmentColumn", mapping.singleShipmentColumn]]
        : []
  );
  const entries: Array<[MappingFieldTarget, number | null | undefined]> = pricingTarget
    ? [
        ["pricingSkuColumn", mapping.pricingSkuColumn],
        ["pricingCountryColumn", mapping.pricingCountryColumn],
        ...mapping.quantityTierColumns.map((tier, index) => ([
          `quantityTierColumns.${index}.column` as MappingFieldTarget,
          tier.column,
        ] as [MappingFieldTarget, number])),
      ]
    : [
        ["businessOrderNumberColumn", mapping.businessOrderNumberColumn],
        ["countryCodeColumn", mapping.countryCodeColumn],
        ["countryEnglishColumn", mapping.countryEnglishColumn],
        ["countryChineseColumn", mapping.countryChineseColumn],
        ...singleShipmentEntries,
        ["orderPriceColumn", mapping.orderPriceColumn],
        ...mapping.skuQtyPairs.flatMap((pair, index) => {
          const pairEntries: Array<[MappingFieldTarget, number]> = [
            [`skuQtyPairs.${index}.skuColumn`, pair.skuColumn],
            [`skuQtyPairs.${index}.qtyColumn`, pair.qtyColumn],
          ];
          if (!pair.directQuantity) {
            pairEntries.push([`skuQtyPairs.${index}.mergedQtyColumn`, pair.mergedQtyColumn]);
          }
          return pairEntries;
        }),
      ];
  const conflict = entries.find(([entryTarget, entryColumn]) =>
    entryTarget !== target && entryColumn === column);
  return conflict ? mappingTargetLabel(conflict[0]) : null;
}

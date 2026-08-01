import type { PricePreviewWritebackRow } from "@shared/desktop-api";

export type WritebackAlertSummary = {
  priceUnavailableRows: number;
  positiveDifferenceRows: number;
  negativeDifferenceRows: number;
  quantityMismatchRows: number;
  quantityCalculationErrorRows: number;
  affectedRows: number;
  message: string;
  signature: string;
};

function normalizedDifference(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(6))
    : null;
}

function rowValueKey(row: PricePreviewWritebackRow, value: number): string {
  return `${row.sourceRow}:${value}`;
}

export function summarizeWritebackAlerts(
  rows: readonly PricePreviewWritebackRow[],
): WritebackAlertSummary {
  const priceUnavailable = new Set<number>();
  const positiveDifferences = new Map<number, string>();
  const negativeDifferences = new Map<number, string>();
  const quantityMismatches = new Set<number>();
  const quantityCalculationErrors = new Set<number>();

  for (const row of rows) {
    if (row.pricingPrice === null) priceUnavailable.add(row.sourceRow);
    const difference = normalizedDifference(row.priceDifference);
    if (difference !== null && difference > 0) {
      positiveDifferences.set(row.sourceRow, rowValueKey(row, difference));
    }
    if (difference !== null && difference < 0) {
      negativeDifferences.set(row.sourceRow, rowValueKey(row, difference));
    }
    if (row.quantityMismatch) quantityMismatches.add(row.sourceRow);
    if (row.quantityError?.trim()) quantityCalculationErrors.add(row.sourceRow);
  }

  const affectedRows = new Set([
    ...priceUnavailable,
    ...positiveDifferences.keys(),
    ...negativeDifferences.keys(),
    ...quantityMismatches,
    ...quantityCalculationErrors,
  ]);
  const parts: string[] = [];
  if (priceUnavailable.size > 0) parts.push(`核价价格异常 ${priceUnavailable.size} 行`);
  if (positiveDifferences.size > 0) parts.push(`金额差为正 ${positiveDifferences.size} 行`);
  if (negativeDifferences.size > 0) parts.push(`金额差为负 ${negativeDifferences.size} 行`);
  if (quantityMismatches.size > 0) parts.push(`数量不一致 ${quantityMismatches.size} 行`);
  if (quantityCalculationErrors.size > 0) parts.push(`数量计算失败 ${quantityCalculationErrors.size} 行`);
  const signature = [
    [...priceUnavailable].sort((left, right) => left - right).join(","),
    [...positiveDifferences.values()].sort().join(","),
    [...negativeDifferences.values()].sort().join(","),
    [...quantityMismatches].sort((left, right) => left - right).join(","),
    [...quantityCalculationErrors].sort((left, right) => left - right).join(","),
  ].join("|");

  return {
    priceUnavailableRows: priceUnavailable.size,
    positiveDifferenceRows: positiveDifferences.size,
    negativeDifferenceRows: negativeDifferences.size,
    quantityMismatchRows: quantityMismatches.size,
    quantityCalculationErrorRows: quantityCalculationErrors.size,
    affectedRows: affectedRows.size,
    message: parts.length > 0
      ? `发现 ${affectedRows.size} 行核价结果异常：${parts.join("、")}。请修正“核价[财务]、金额差、数量”后重新核价；仅确认字段映射不会清除这些异常。`
      : "",
    signature,
  };
}

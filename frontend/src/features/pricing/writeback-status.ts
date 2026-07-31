import type { PricePreviewWritebackRow } from "@shared/desktop-api";

export type WritebackAlertSummary = {
  positiveDifferenceRows: number;
  negativeDifferenceRows: number;
  quantityMismatchRows: number;
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
  const positiveDifferences = new Map<number, string>();
  const negativeDifferences = new Map<number, string>();
  const quantityMismatches = new Set<number>();

  for (const row of rows) {
    const difference = normalizedDifference(row.priceDifference);
    if (difference !== null && difference > 0) {
      positiveDifferences.set(row.sourceRow, rowValueKey(row, difference));
    }
    if (difference !== null && difference < 0) {
      negativeDifferences.set(row.sourceRow, rowValueKey(row, difference));
    }
    if (row.quantityMismatch) quantityMismatches.add(row.sourceRow);
  }

  const affectedRows = new Set([
    ...positiveDifferences.keys(),
    ...negativeDifferences.keys(),
    ...quantityMismatches,
  ]);
  const parts: string[] = [];
  if (positiveDifferences.size > 0) parts.push(`金额差为正 ${positiveDifferences.size} 行`);
  if (negativeDifferences.size > 0) parts.push(`金额差为负 ${negativeDifferences.size} 行`);
  if (quantityMismatches.size > 0) parts.push(`数量不一致 ${quantityMismatches.size} 行`);
  const signature = [
    [...positiveDifferences.values()].sort().join(","),
    [...negativeDifferences.values()].sort().join(","),
    [...quantityMismatches].sort((left, right) => left - right).join(","),
  ].join("|");

  return {
    positiveDifferenceRows: positiveDifferences.size,
    negativeDifferenceRows: negativeDifferences.size,
    quantityMismatchRows: quantityMismatches.size,
    affectedRows: affectedRows.size,
    message: parts.length > 0
      ? `发现 ${affectedRows.size} 行写回结果需要关注：${parts.join("、")}。请检查“核价[财务]、金额差、数量”后再确认处理。`
      : "",
    signature,
  };
}

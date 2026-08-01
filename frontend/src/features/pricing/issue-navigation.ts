import type { PricePreviewWritebackRow } from "@shared/desktop-api";
import {
  DEFAULT_ISSUE_NAVIGATION_KINDS,
  ISSUE_NAVIGATION_KINDS,
  type IssueNavigationKind,
} from "@shared/app-settings";

export { DEFAULT_ISSUE_NAVIGATION_KINDS, ISSUE_NAVIGATION_KINDS };
export type { IssueNavigationKind };
export type IssueNavigationRows = Record<IssueNavigationKind, number[]>;

export function classifyIssueNavigationRows(
  writebackRows: readonly PricePreviewWritebackRow[],
): IssueNavigationRows {
  const rows: Record<IssueNavigationKind, Set<number>> = {
    unmatched: new Set<number>(),
    difference: new Set<number>(),
    quantity: new Set<number>(),
  };

  for (const row of writebackRows) {
    if (row.pricingPrice === null) rows.unmatched.add(row.sourceRow);
    if (typeof row.priceDifference === "number"
      && Number.isFinite(row.priceDifference)
      && row.priceDifference !== 0) rows.difference.add(row.sourceRow);
    if (row.quantityMismatch || Boolean(row.quantityError?.trim())) rows.quantity.add(row.sourceRow);
  }

  return Object.fromEntries(ISSUE_NAVIGATION_KINDS.map((kind) => [
    kind,
    [...rows[kind]].sort((left, right) => left - right),
  ])) as IssueNavigationRows;
}

export function selectedIssueNavigationRows(
  rowsByKind: IssueNavigationRows,
  selectedKinds: readonly IssueNavigationKind[],
): number[] {
  return [...new Set(selectedKinds.flatMap((kind) => rowsByKind[kind]))]
    .sort((left, right) => left - right);
}

export function adjacentIssueRow(
  rows: readonly number[],
  current: number | null,
  direction: -1 | 1,
): number | null {
  if (rows.length === 0) return null;
  const currentIndex = current === null ? -1 : rows.indexOf(current);
  if (direction === -1) return rows[currentIndex <= 0 ? rows.length - 1 : currentIndex - 1] ?? null;
  return rows[currentIndex < 0 || currentIndex >= rows.length - 1 ? 0 : currentIndex + 1] ?? null;
}

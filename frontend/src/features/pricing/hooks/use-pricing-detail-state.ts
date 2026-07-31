import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  PriceAnalysisFile,
  PriceCheckMapping,
  PricePreviewWritebackRow,
} from "@shared/desktop-api";
import type { ExcelPreviewWorkbook } from "@/lib/excel-preview";
import type { ExcelPreviewCandidate } from "@/features/pricing/components/excel-preview";
import type { MappingValidationState } from "@/features/pricing/components/mapping-editor";
import type { MappingFieldTarget } from "@/features/pricing/mapping";
import type { IssueDetailsRequest } from "@/features/pricing/issues";
import type { FileResult } from "@/features/workbench/types";
import { DETAIL_CONTENT_DEFER_FRAMES } from "@/features/workbench/types";

type UsePricingDetailStateOptions = {
  analyses: Record<string, PriceAnalysisFile>;
  detailPath: string | null;
  mappings: Record<string, PriceCheckMapping>;
  mappingValidations: Record<string, MappingValidationState>;
  matchedOrderRowsBySheet: Record<string, Record<string, number[]>>;
  results: Record<string, FileResult>;
  writebackEdits: Record<string, PricePreviewWritebackRow[]>;
};

export function usePricingDetailState({
  analyses,
  detailPath,
  mappings,
  mappingValidations,
  matchedOrderRowsBySheet,
  results,
  writebackEdits,
}: UsePricingDetailStateOptions) {
  const [contentReady, setContentReady] = useState(false);
  const [previewSheetName, setPreviewSheetName] = useState("");
  const [previewWorkbook, setPreviewWorkbook] = useState<ExcelPreviewWorkbook | null>(null);
  const [issueDetailsRequest, setIssueDetailsRequest] = useState<IssueDetailsRequest | null>(null);
  const [activeMappingTarget, setActiveMappingTarget] = useState<MappingFieldTarget | null>(null);

  const analysis = detailPath ? analyses[detailPath] : undefined;
  const result = detailPath ? results[detailPath] : undefined;
  const mapping = detailPath ? mappings[detailPath] ?? analysis?.suggestedMapping ?? null : null;
  const validation: MappingValidationState = detailPath
    ? mappingValidations[detailPath] ?? { status: "idle", result: null }
    : { status: "idle", result: null };
  const singleShipmentMatchingEnabled = (
    validation.result?.singleShipmentMatching
    ?? analysis?.singleShipmentMatching
  )?.enabled === true;
  const matchedOrderRows = detailPath && mapping && validation.status === "ready"
    ? matchedOrderRowsBySheet[detailPath]?.[mapping.orderSheet] ?? []
    : [];

  const writebackRows = useMemo(() => {
    if (!contentReady || !detailPath || validation.status !== "ready") return [];
    const baseRows = validation.result?.writebackRows ?? [];
    const edits = writebackEdits[detailPath] ?? [];
    if (edits.length === 0) return baseRows;
    const editsByRow = new Map(edits.map((row) => [row.sourceRow, row]));
    return baseRows.map((row) => editsByRow.get(row.sourceRow) ?? row);
  }, [contentReady, detailPath, validation, writebackEdits]);

  const quantityIssues = useMemo(
    () => writebackRows.filter((row) => row.quantityError),
    [writebackRows],
  );
  const unmatchedIssues = useMemo(
    () => contentReady
      ? validation.result?.unmatchedRows ?? analysis?.unmatchedRows ?? []
      : [],
    [analysis?.unmatchedRows, contentReady, validation.result?.unmatchedRows],
  );
  const previewCandidates = useMemo<ExcelPreviewCandidate[]>(() => {
    if (!analysis) return [];
    const rolesBySheet = new Map<string, Set<ExcelPreviewCandidate["roles"][number]>>();
    const scoresBySheet = new Map<string, ExcelPreviewCandidate["scores"]>();
    for (const candidate of analysis.orderSheetCandidates) {
      const roles = rolesBySheet.get(candidate.sheetName) ?? new Set();
      roles.add("order");
      rolesBySheet.set(candidate.sheetName, roles);
      scoresBySheet.set(candidate.sheetName, {
        ...scoresBySheet.get(candidate.sheetName),
        order: candidate.score,
      });
    }
    for (const candidate of analysis.pricingSheetCandidates) {
      const roles = rolesBySheet.get(candidate.sheetName) ?? new Set();
      roles.add("pricing");
      rolesBySheet.set(candidate.sheetName, roles);
      scoresBySheet.set(candidate.sheetName, {
        ...scoresBySheet.get(candidate.sheetName),
        pricing: candidate.score,
      });
    }
    return Array.from(rolesBySheet, ([name, roles]) => ({
      name,
      roles: Array.from(roles),
      scores: scoresBySheet.get(name),
    }));
  }, [analysis]);

  useEffect(() => {
    setIssueDetailsRequest(null);
    setContentReady(false);
    if (!detailPath) return;
    const frameIds: number[] = [];
    const deferFrame = (remainingFrames: number): void => {
      frameIds.push(window.requestAnimationFrame(() => {
        if (remainingFrames > 1) deferFrame(remainingFrames - 1);
        else setContentReady(true);
      }));
    };
    deferFrame(DETAIL_CONTENT_DEFER_FRAMES);
    return () => frameIds.forEach((frameId) => window.cancelAnimationFrame(frameId));
  }, [detailPath]);

  useEffect(() => {
    const candidateNames = previewCandidates.map((candidate) => candidate.name);
    if (!detailPath || candidateNames.length === 0) {
      setPreviewSheetName("");
      return;
    }
    setPreviewSheetName((current) => {
      if (candidateNames.includes(current)) return current;
      if (mapping?.orderSheet && candidateNames.includes(mapping.orderSheet)) return mapping.orderSheet;
      return candidateNames[0];
    });
  }, [detailPath, mapping?.orderSheet, previewCandidates]);

  useEffect(() => {
    setPreviewWorkbook(null);
    setActiveMappingTarget(null);
  }, [detailPath]);

  useEffect(() => {
    if (!activeMappingTarget) return;
    const cancelSelection = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setActiveMappingTarget(null);
    };
    window.addEventListener("keydown", cancelSelection, true);
    return () => window.removeEventListener("keydown", cancelSelection, true);
  }, [activeMappingTarget]);

  const openUnmatchedDetails = useCallback((summary: string, sourceRow: number | null = null): void => {
    setIssueDetailsRequest({ kind: "unmatched", sourceRow, summary });
  }, []);

  const openSelectedRowDetails = useCallback((sourceRow: number): void => {
    if (quantityIssues.some((issue) => issue.sourceRow === sourceRow)) {
      setIssueDetailsRequest({
        kind: "quantity",
        sourceRow,
        summary: `已定位第 ${sourceRow} 行，请查看数量计算问题`,
      });
      return;
    }
    if (unmatchedIssues.some((issue) => issue.sourceRow === sourceRow)) {
      setIssueDetailsRequest({
        kind: "unmatched",
        sourceRow,
        summary: `已定位第 ${sourceRow} 行，请查看具体未匹配原因`,
      });
    }
  }, [quantityIssues, unmatchedIssues]);

  return {
    activeMappingTarget,
    analysis,
    closeIssueDetails: () => setIssueDetailsRequest(null),
    contentReady,
    issueDetailsRequest,
    mapping,
    matchedOrderRows,
    openSelectedRowDetails,
    openUnmatchedDetails,
    previewCandidates,
    previewSheetName,
    previewWorkbook,
    quantityIssues,
    result,
    setActiveMappingTarget,
    setPreviewSheetName,
    setPreviewWorkbook,
    singleShipmentMatchingEnabled,
    unmatchedIssues,
    validation,
    writebackRows,
  };
}

export type PricingDetailState = ReturnType<typeof usePricingDetailState>;

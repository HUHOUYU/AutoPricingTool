import { useCallback } from "react";
import type { PriceCheckMapping, PricePreviewWritebackRow } from "@shared/desktop-api";
import { buildMapping } from "../mapping";
import { getDesktopAPI } from "@/features/workbench/file-utils";
import type { ProcessorSession } from "@/features/workbench/hooks/use-processor-session";

const MAPPING_VALIDATION_DEBOUNCE_MS = 500;

type UseMappingValidationActionsOptions = {
  session: ProcessorSession;
  configPath: string;
};

export function useMappingValidationActions({
  session,
  configPath,
}: UseMappingValidationActionsOptions) {
  const {
    analyses,
    mappings,
    mappingsRef,
    setMappings,
    writebackEditsRef,
    setWritebackEdits,
    cellEditsRef,
    setCellEdits,
    mappingValidationVersionsRef,
    mappingValidationTimerRef,
    mappingValidationInFlightRef,
    activeMappingValidationRef,
    pendingMappingValidationRef,
    setMappingValidations,
  } = session;

  const sendMappingValidation = useCallback((
    path: string,
    mapping: PriceCheckMapping,
    version: number,
  ): void => {
    if (mappingValidationInFlightRef.current) {
      pendingMappingValidationRef.current = { path, mapping, version };
      setMappingValidations((current) => ({
        ...current,
        [path]: { status: "validating", result: current[path]?.result ?? null },
      }));
      return;
    }
    const api = getDesktopAPI();
    if (!api) return;
    mappingValidationInFlightRef.current = true;
    activeMappingValidationRef.current = { path, mapping, version };
    setMappingValidations((current) => ({
      ...current,
      [path]: { status: "validating", result: current[path]?.result ?? null },
    }));
    void api.validatePriceMapping({
      inputPath: path,
      mapping,
      requestVersion: version,
      writebackRows: writebackEditsRef.current[path] ?? [],
      cellEdits: cellEditsRef.current[path] ?? [],
      configPath: configPath || undefined,
    }).catch((error: unknown) => {
      mappingValidationInFlightRef.current = false;
      activeMappingValidationRef.current = null;
      setMappingValidations((current) => ({
        ...current,
        [path]: {
          status: "ready",
          result: {
            inputPath: path,
            requestVersion: version,
            evaluatedRows: 0,
            matchedRows: 0,
            coverage: 0,
            errors: ["试算请求失败：" + String(error)],
            warnings: [],
          },
        },
      }));
    });
  }, [
    activeMappingValidationRef,
    cellEditsRef,
    configPath,
    mappingValidationInFlightRef,
    pendingMappingValidationRef,
    writebackEditsRef,
  ]);

  const queueMappingValidation = useCallback((path: string, mapping: PriceCheckMapping): void => {
    const version = (mappingValidationVersionsRef.current[path] ?? 0) + 1;
    mappingValidationVersionsRef.current[path] = version;
    setMappingValidations((current) => ({
      ...current,
      [path]: { status: "stale", result: current[path]?.result ?? null },
    }));
    if (mappingValidationTimerRef.current) clearTimeout(mappingValidationTimerRef.current);
    mappingValidationTimerRef.current = setTimeout(
      () => sendMappingValidation(path, mapping, version),
      MAPPING_VALIDATION_DEBOUNCE_MS,
    );
  }, [mappingValidationTimerRef, mappingValidationVersionsRef, sendMappingValidation]);

  const revalidateMapping = useCallback((path: string): void => {
    const mapping = mappingsRef.current[path] ?? mappings[path];
    if (!mapping) return;
    const version = (mappingValidationVersionsRef.current[path] ?? 0) + 1;
    mappingValidationVersionsRef.current[path] = version;
    if (mappingValidationTimerRef.current) clearTimeout(mappingValidationTimerRef.current);
    mappingValidationTimerRef.current = null;
    setMappingValidations((current) => ({
      ...current,
      [path]: { status: "stale", result: current[path]?.result ?? null },
    }));
    sendMappingValidation(path, mapping, version);
  }, [
    mappingValidationTimerRef,
    mappingValidationVersionsRef,
    mappings,
    mappingsRef,
    sendMappingValidation,
  ]);

  const useOriginalSkuQuantity = useCallback((
    path: string,
    rows: PricePreviewWritebackRow[],
  ): void => {
    if (rows.length === 0) return;
    const fallbackRows = new Map(rows.map((row) => [
      row.sourceRow,
      { ...row, usedOriginalSkuQuantity: true },
    ]));
    const currentRows = writebackEditsRef.current[path] ?? [];
    const nextRows = [
      ...currentRows.filter((row) => !fallbackRows.has(row.sourceRow)),
      ...fallbackRows.values(),
    ].sort((left, right) => left.sourceRow - right.sourceRow);
    const next = { ...writebackEditsRef.current, [path]: nextRows };
    writebackEditsRef.current = next;
    setWritebackEdits(next);
    revalidateMapping(path);
  }, [revalidateMapping, writebackEditsRef]);

  const commitMapping = useCallback((path: string, mapping: PriceCheckMapping): void => {
    const nextWritebackEdits = { ...writebackEditsRef.current };
    delete nextWritebackEdits[path];
    writebackEditsRef.current = nextWritebackEdits;
    setWritebackEdits(nextWritebackEdits);
    const nextCellEdits = { ...cellEditsRef.current };
    delete nextCellEdits[path];
    cellEditsRef.current = nextCellEdits;
    setCellEdits(nextCellEdits);
    mappingsRef.current = { ...mappingsRef.current, [path]: mapping };
    setMappings((current) => ({ ...current, [path]: mapping }));
    queueMappingValidation(path, mapping);
  }, [cellEditsRef, mappingsRef, queueMappingValidation, writebackEditsRef]);

  const updateMapping = useCallback((
    path: string,
    orderSheet: string,
    pricingSheet: string,
  ): void => {
    const analysis = analyses[path];
    if (!analysis) return;
    const order = analysis.orderSheetCandidates.find((item) => item.sheetName === orderSheet);
    const pricing = analysis.pricingSheetCandidates.find((item) => item.sheetName === pricingSheet);
    if (order && pricing) commitMapping(path, buildMapping(order, pricing));
  }, [analyses, commitMapping]);

  return {
    sendMappingValidation,
    revalidateMapping,
    useOriginalSkuQuantity,
    commitMapping,
    updateMapping,
  };
}

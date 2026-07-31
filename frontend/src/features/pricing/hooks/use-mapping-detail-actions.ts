import { useCallback } from "react";
import { toast } from "sonner";
import type {
  PriceCheckMapping,
  PricePreviewWritebackRow,
} from "@shared/desktop-api";
import type { MappingFieldTarget } from "../components/mapping-editor";
import {
  applyMappingColumn,
  mappingColumnConflict,
} from "../mapping";
import { getDesktopAPI } from "@/features/workbench/file-utils";
import type { ProcessorSession } from "@/features/workbench/hooks/use-processor-session";

const SKU_PAIR_TARGET_PATTERN = /^skuQtyPairs\.(\d+)\.(qtyColumn|skuColumn)$/;

type UseMappingDetailActionsOptions = {
  session: ProcessorSession;
  configPath: string;
  detailPath: string | null;
  detailMapping: PriceCheckMapping | null;
  activeMappingTarget: MappingFieldTarget | null;
  detailPreviewSheetName: string;
  setActiveMappingTarget: (target: MappingFieldTarget | null) => void;
  setDetailPreviewSheetName: (sheetName: string) => void;
  commitMapping: (path: string, mapping: PriceCheckMapping) => void;
};

export function useMappingDetailActions({
  session,
  configPath,
  detailPath,
  detailMapping,
  activeMappingTarget,
  detailPreviewSheetName,
  setActiveMappingTarget,
  setDetailPreviewSheetName,
  commitMapping,
}: UseMappingDetailActionsOptions) {
  const {
    writebackEditsRef,
    setWritebackEdits,
    cellEditsRef,
    priceRowValidationVersionsRef,
  } = session;

  const editDetailWritebackRow = useCallback((
    row: PricePreviewWritebackRow,
    field: "pricingPrice" | "priceDifference" | "quantity",
  ): void => {
    if (!detailPath) return;
    const current = writebackEditsRef.current[detailPath] ?? [];
    const nextRows = [...current.filter((item) => item.sourceRow !== row.sourceRow), row]
      .sort((left, right) => left.sourceRow - right.sourceRow);
    const next = { ...writebackEditsRef.current, [detailPath]: nextRows };
    writebackEditsRef.current = next;
    setWritebackEdits(next);
    const versionKey = `${detailPath}\u0000${row.sourceRow}`;
    if (field !== "quantity") {
      // 后续人工金额编辑优先，作废该行尚未返回的数量核价结果。
      priceRowValidationVersionsRef.current[versionKey] =
        (priceRowValidationVersionsRef.current[versionKey] ?? 0) + 1;
      return;
    }
    if (!detailMapping) return;
    const api = getDesktopAPI();
    if (!api) {
      toast.error("Electron 接口未加载，无法重新核价");
      return;
    }
    const requestVersion = (priceRowValidationVersionsRef.current[versionKey] ?? 0) + 1;
    priceRowValidationVersionsRef.current[versionKey] = requestVersion;
    void api.recalculatePriceRow({
      inputPath: detailPath,
      mapping: detailMapping,
      requestVersion,
      rowEdit: { sourceRow: row.sourceRow, quantity: row.quantity },
      cellEdits: cellEditsRef.current[detailPath] ?? [],
      configPath: configPath || undefined,
    }).catch((error: unknown) => {
      if (priceRowValidationVersionsRef.current[versionKey] !== requestVersion) return;
      toast.error(`第 ${row.sourceRow} 行重新核价请求失败：${String(error)}`);
    });
  }, [
    cellEditsRef,
    configPath,
    detailMapping,
    detailPath,
    priceRowValidationVersionsRef,
    writebackEditsRef,
  ]);

  const selectMappingTarget = useCallback((target: MappingFieldTarget | null): void => {
    setActiveMappingTarget(target);
    if (!target || !detailMapping) return;
    const pricingTarget = target.startsWith("pricing") || target.startsWith("quantityTierColumns");
    setDetailPreviewSheetName(pricingTarget ? detailMapping.pricingSheet : detailMapping.orderSheet);
  }, [detailMapping, setActiveMappingTarget, setDetailPreviewSheetName]);

  const changeMappingColumn = useCallback((
    target: MappingFieldTarget,
    column: number | null,
    header: string,
    fromPreview = false,
  ): void => {
    if (!detailPath || !detailMapping || target.endsWith("HeaderRow")) return;
    const pricingTarget = target.startsWith("pricing") || target.startsWith("quantityTierColumns");
    const expectedSheet = pricingTarget ? detailMapping.pricingSheet : detailMapping.orderSheet;
    if (fromPreview && detailPreviewSheetName !== expectedSheet) return;
    const conflict = column === null ? null : mappingColumnConflict(detailMapping, target, column);
    if (conflict) {
      toast.warning(`该列已映射为“${conflict}”，请先调整原字段`);
      return;
    }
    commitMapping(detailPath, applyMappingColumn(detailMapping, target, column, header));
    const pairMatch = column === null ? null : SKU_PAIR_TARGET_PATTERN.exec(target);
    if (pairMatch && fromPreview) {
      const pairIndex = Number(pairMatch[1]);
      const pair = detailMapping.skuQtyPairs[pairIndex];
      const nextField = pairMatch[2] === "skuColumn" && pair?.directQuantity
        ? "qtyColumn"
        : pairMatch[2] === "qtyColumn"
          ? "skuColumn"
          : "mergedQtyColumn";
      setActiveMappingTarget(
        pair?.directQuantity && pairMatch[2] === "qtyColumn"
          ? null
          : `skuQtyPairs.${pairIndex}.${nextField}`,
      );
      return;
    }
    setActiveMappingTarget(null);
  }, [
    commitMapping,
    detailMapping,
    detailPath,
    detailPreviewSheetName,
    setActiveMappingTarget,
  ]);

  const selectMappingColumn = useCallback((column: number, header: string): void => {
    if (!activeMappingTarget) return;
    changeMappingColumn(activeMappingTarget, column, header, true);
  }, [activeMappingTarget, changeMappingColumn]);

  const selectMappingRow = useCallback((row: number): void => {
    if (!detailPath || !detailMapping || !activeMappingTarget?.endsWith("HeaderRow")) return;
    if (activeMappingTarget === "orderHeaderRow" && detailPreviewSheetName === detailMapping.orderSheet) {
      commitMapping(detailPath, { ...detailMapping, orderHeaderRow: row });
    }
    if (activeMappingTarget === "pricingHeaderRow" && detailPreviewSheetName === detailMapping.pricingSheet) {
      commitMapping(detailPath, { ...detailMapping, pricingHeaderRow: row });
    }
    if (activeMappingTarget === "pricingQuantityHeaderRow" && detailPreviewSheetName === detailMapping.pricingSheet) {
      commitMapping(detailPath, { ...detailMapping, pricingQuantityHeaderRow: row });
    }
    setActiveMappingTarget(null);
  }, [
    activeMappingTarget,
    commitMapping,
    detailMapping,
    detailPath,
    detailPreviewSheetName,
    setActiveMappingTarget,
  ]);

  return {
    editDetailWritebackRow,
    selectMappingTarget,
    changeMappingColumn,
    selectMappingColumn,
    selectMappingRow,
  };
}

export type MappingDetailActions = ReturnType<typeof useMappingDetailActions>;

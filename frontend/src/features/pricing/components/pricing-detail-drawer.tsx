import { AnimatePresence, motion } from "motion/react";
import {
  ExternalLink,
  FileSpreadsheet,
  FolderOutput,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import type {
  PriceCheckMapping,
  PricePreviewCellEdit,
} from "@shared/desktop-api";
import { Button } from "@/components/ui/button";
import {
  DETAIL_CONTENT_RESIZER_WIDTH,
  DETAIL_PREVIEW_MIN_WIDTH,
} from "@/features/workbench/detail-layout";
import type { DetailDrawerLayoutState } from "@/features/workbench/hooks/use-detail-drawer-layout";
import { fileNameFromPath, getDesktopAPI } from "@/features/workbench/file-utils";
import { tabForStatus } from "@/features/workbench/status";
import type { FileStatus } from "@/features/workbench/types";
import { ExcelPreview } from "./excel-preview";
import { IssueStatusOverview } from "./issue-status-overview";
import { MappingEditor } from "./mapping-editor";
import { mappingTargetLabel } from "../mapping";
import type { PricingDetailState } from "../hooks/use-pricing-detail-state";
import type { MappingDetailActions } from "../hooks/use-mapping-detail-actions";

type PricingDetailDrawerProps = {
  path: string | null;
  fileStatus: FileStatus | undefined;
  cellEdits: PricePreviewCellEdit[];
  state: PricingDetailState;
  layout: DetailDrawerLayoutState;
  mappingActions: MappingDetailActions;
  onClose: () => void;
  onRevalidate: () => void;
  onUseOriginalSkuQuantity: () => void;
  onCommitMapping: (mapping: PriceCheckMapping) => void;
  onUpdateMapping: (orderSheet: string, pricingSheet: string) => void;
  onConfirm: () => void;
  onRetry: () => void;
};

export function PricingDetailDrawer({
  path,
  fileStatus,
  cellEdits,
  state,
  layout,
  mappingActions,
  onClose,
  onRevalidate,
  onUseOriginalSkuQuantity,
  onCommitMapping,
  onUpdateMapping,
  onConfirm,
  onRetry,
}: PricingDetailDrawerProps): React.JSX.Element {
  const {
    activeMappingTarget,
    analysis,
    closeIssueDetails,
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
    setPreviewSheetName,
    setPreviewWorkbook,
    singleShipmentMatchingEnabled,
    unmatchedIssues,
    validation,
    writebackRows,
  } = state;
  const {
    drawerBounds,
    drawerWidth,
    sidebarBounds,
    sidebarWidth,
    resizeDrawerWithKeyboard,
    resizeSidebarWithKeyboard,
    startDrawerResize,
    startSidebarResize,
  } = layout;
  const {
    editDetailWritebackRow,
    selectMappingTarget,
    changeMappingColumn,
    selectMappingColumn,
    selectMappingRow,
  } = mappingActions;

  return (
    <AnimatePresence>
      {path ? (
        <>
          <motion.button
            type="button"
            className="cyber-drawer-backdrop"
            aria-label="关闭问题详情"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.aside
            className="cyber-issue-drawer"
            style={{ width: `${drawerWidth}px` }}
            role="dialog"
            aria-modal="true"
            aria-label="文件处理详情"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.2 }}
          >
            <div
              className="issue-drawer-resizer"
              role="separator"
              aria-label="调整详情抽屉宽度"
              aria-orientation="vertical"
              aria-valuemin={drawerBounds.min}
              aria-valuemax={drawerBounds.max}
              aria-valuenow={drawerWidth}
              tabIndex={0}
              onPointerDown={startDrawerResize}
              onKeyDown={resizeDrawerWithKeyboard}
            ><i /></div>
            <header className="issue-drawer-header">
              <div className="issue-header-identity">
                <FileSpreadsheet />
                <div>
                  <strong>{fileNameFromPath(path)}</strong>
                  <small title={path}>{path}</small>
                </div>
              </div>
              <div className="issue-header-actions">
                <Button
                  type="button"
                  variant="outline"
                  className="issue-open-source"
                  onClick={() => void getDesktopAPI()?.openPath(path)}
                >
                  <ExternalLink />打开原始文件
                </Button>
                {result?.outputPath && fileStatus && tabForStatus(fileStatus) === "success" ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="issue-open-result"
                    onClick={() => void getDesktopAPI()?.openPath(result.outputPath ?? "")}
                  >
                    <FolderOutput />打开结果文件
                  </Button>
                ) : null}
                <button type="button" aria-label="关闭文件详情" onClick={onClose}>
                  <X />
                </button>
              </div>
            </header>
            <div
              className="issue-drawer-content"
              style={{
                gridTemplateColumns: `minmax(${DETAIL_PREVIEW_MIN_WIDTH}px, 1fr) ${DETAIL_CONTENT_RESIZER_WIDTH}px ${sidebarWidth}px`,
              }}
            >
              {!contentReady ? (
                <div className="issue-detail-loading" role="status" aria-label="正在准备文件详情">
                  <LoaderCircle />
                  <strong>正在准备文件详情</strong>
                  <small>先打开详情窗口，再加载工作簿与字段映射</small>
                </div>
              ) : (
                <>
                  <ExcelPreview
                    api={getDesktopAPI()}
                    filePath={path}
                    candidates={previewCandidates}
                    activeSheetName={previewSheetName}
                    mapping={mapping}
                    singleShipmentMatchingEnabled={singleShipmentMatchingEnabled}
                    matchedOrderRows={matchedOrderRows}
                    writebackRows={writebackRows}
                    onWritebackRowChange={editDetailWritebackRow}
                    onUnmatchedRowConfirm={openSelectedRowDetails}
                    cellEdits={cellEdits}
                    activeTarget={activeMappingTarget}
                    selectionPrompt={activeMappingTarget
                      ? `正在选择“${mappingTargetLabel(activeMappingTarget)}”`
                      : undefined}
                    onActiveSheetChange={setPreviewSheetName}
                    onWorkbookChange={setPreviewWorkbook}
                    onColumnSelect={selectMappingColumn}
                    onRowSelect={selectMappingRow}
                  />
                  <div
                    className="issue-content-resizer"
                    role="separator"
                    aria-label="调整预览与字段映射宽度"
                    aria-orientation="vertical"
                    aria-valuemin={sidebarBounds.min}
                    aria-valuemax={sidebarBounds.max}
                    aria-valuenow={sidebarWidth}
                    tabIndex={0}
                    onPointerDown={startSidebarResize}
                    onKeyDown={resizeSidebarWithKeyboard}
                  ><i /></div>
                  <div className="issue-detail-column">
                    <IssueStatusOverview
                      analysis={analysis}
                      hasMapping={mapping !== null}
                      issueDetailsRequest={issueDetailsRequest}
                      quantityIssues={quantityIssues}
                      writebackRows={writebackRows}
                      result={result}
                      unmatchedIssues={unmatchedIssues}
                      validation={validation}
                      onCloseIssueDetails={closeIssueDetails}
                      onOpenUnmatchedDetails={openUnmatchedDetails}
                      onUseOriginalSkuQuantity={() => onUseOriginalSkuQuantity()}
                      onRevalidate={onRevalidate}
                    />
                    {analysis && mapping ? (
                      <MappingEditor
                        analysis={analysis}
                        mapping={mapping}
                        workbook={previewWorkbook}
                        activeTarget={activeMappingTarget}
                        validation={validation}
                        onActiveTargetChange={selectMappingTarget}
                        onMappingChange={onCommitMapping}
                        onColumnChange={changeMappingColumn}
                        onSheetChange={(orderSheet, pricingSheet, previewSheet) => {
                          onUpdateMapping(orderSheet, pricingSheet);
                          setPreviewSheetName(previewSheet);
                        }}
                        onPreviewSheetChange={setPreviewSheetName}
                        confirmLabel={result?.status === "awaiting_confirmation" ? "修正后重新核价" : undefined}
                        onConfirm={onConfirm}
                      />
                    ) : null}
                    {fileStatus && tabForStatus(fileStatus) === "error" ? (
                      <section className="issue-error-section">
                        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                          <RefreshCw />重新分析此文件
                        </Button>
                      </section>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}

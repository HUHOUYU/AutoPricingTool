import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FileBox, FileCheck2, FilePlus2, FileUp, FolderOpen } from "lucide-react";
import type { DropzoneState } from "react-dropzone";
import type { ImportSourceMode } from "../types";

type BatchUploadPanelProps = {
  visible: boolean;
  fileCount: number;
  importSourceMode: ImportSourceMode;
  isDragActive: boolean;
  getRootProps: DropzoneState["getRootProps"];
  getInputProps: DropzoneState["getInputProps"];
  onChooseInput: () => void;
  onToggleImportMode: () => void;
  actions?: ReactNode;
};

export function BatchUploadPanel({
  visible,
  fileCount,
  importSourceMode,
  isDragActive,
  getRootProps,
  getInputProps,
  onChooseInput,
  onToggleImportMode,
  actions,
}: BatchUploadPanelProps): React.JSX.Element {
  const isFileMode = importSourceMode === "file";

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.section
          className={`cyber-upload-panel${fileCount > 0 ? " is-compact" : " is-expanded"}`}
          aria-labelledby="upload-title"
          key="batch-upload"
          initial={false}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.24 }}
        >
          {fileCount === 0 ? (
            <>
              <header>
                <div><span className="panel-icon"><FileBox /></span><h2 id="upload-title">文件处理</h2></div>
              </header>
              <div {...getRootProps({
                className: "cyber-dropzone" + (isDragActive ? " is-dragging" : ""),
                onDoubleClick: onChooseInput,
                onKeyDown: (event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onChooseInput();
                },
              })}>
                <input {...getInputProps()} />
                <div className="cyber-wave" aria-hidden="true" />
                <div className="cyber-upload-visual" aria-hidden="true">{isFileMode ? <FileUp /> : <FolderOpen />}</div>
                <strong>{isFileMode ? "拖拽一个或多个 Excel 文件到此处" : "拖拽文件夹到此处"}</strong>
                <span>{isFileMode ? "或双击选择本地文件" : "或双击选择本地文件夹"}</span>
                <small>{isFileMode ? "支持格式：.xlsx、.xls、.xlsm、.xlsb" : "将自动扫描文件夹中的 Excel 文件"}</small>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!isFileMode}
                  aria-label={`导入模式：${isFileMode ? "单文件" : "文件夹"}`}
                  className={`cyber-import-switch is-${importSourceMode}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleImportMode();
                  }}
                >
                  <span>单文件</span><i aria-hidden="true" /><span>文件夹</span>
                </button>
              </div>
            </>
          ) : (
            <div {...getRootProps({ className: `cyber-upload-banner${isDragActive ? " is-dragging" : ""}` })}>
              <input {...getInputProps()} />
              <div className="cyber-upload-summary">
                <span className="panel-icon"><FileCheck2 /></span>
                <div><strong id="upload-title">已导入 {fileCount} 个文件</strong><small>可继续拖入{isFileMode ? "一个或多个 Excel 文件" : "一个文件夹"}</small></div>
              </div>
              <div className="cyber-pipeline" aria-label="自动处理流程">
                <span className="is-done"><b>1</b>导入<em>{fileCount}</em></span>
                <span><b>2</b>分析</span>
                <span><b>3</b>确认</span>
                <span><b>4</b>核价</span>
                <span><b>5</b>完成</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={!isFileMode}
                aria-label={`导入模式：${isFileMode ? "单文件" : "文件夹"}`}
                className={`cyber-import-switch is-${importSourceMode}`}
                onClick={onToggleImportMode}
              >
                <span>单文件</span><i aria-hidden="true" /><span>文件夹</span>
              </button>
              <button type="button" className="cyber-continue-import" onClick={onChooseInput}><FilePlus2 />继续添加</button>
              {actions}
            </div>
          )}
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}

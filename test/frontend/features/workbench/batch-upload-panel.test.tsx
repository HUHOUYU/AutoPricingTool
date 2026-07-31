import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BatchUploadPanel } from "@/features/workbench/components/batch-upload-panel";
import type { DropzoneState } from "react-dropzone";

const getRootProps = vi.fn((props?: Record<string, unknown>) => props ?? {}) as unknown as DropzoneState["getRootProps"];
const getInputProps = vi.fn((props?: Record<string, unknown>) => props ?? {}) as unknown as DropzoneState["getInputProps"];

describe("BatchUploadPanel", () => {
  it("delegates choosing input and changing import mode", () => {
    const onChooseInput = vi.fn();
    const onToggleImportMode = vi.fn();
    render(
      <BatchUploadPanel
        visible
        fileCount={0}
        importSourceMode="file"
        isDragActive={false}
        getRootProps={getRootProps}
        getInputProps={getInputProps}
        onChooseInput={onChooseInput}
        onToggleImportMode={onToggleImportMode}
      />,
    );

    fireEvent.doubleClick(screen.getByText("拖拽一个或多个 Excel 文件到此处"));
    fireEvent.click(screen.getByRole("switch", { name: "导入模式：单文件" }));

    expect(onChooseInput).toHaveBeenCalledOnce();
    expect(onToggleImportMode).toHaveBeenCalledOnce();
  });

  it("renders imported file count and task actions", () => {
    render(
      <BatchUploadPanel
        visible
        fileCount={3}
        importSourceMode="folder"
        isDragActive={false}
        getRootProps={getRootProps}
        getInputProps={getInputProps}
        onChooseInput={vi.fn()}
        onToggleImportMode={vi.fn()}
        actions={<button type="button">开始处理</button>}
      />,
    );

    expect(screen.getByText("已导入 3 个文件")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始处理" })).toBeInTheDocument();
  });
});

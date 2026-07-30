import { Minus, Square, X } from "lucide-react";
import { getDesktopAPI } from "@/features/workbench/file-utils";

export function AppTitlebar(): React.JSX.Element {
  return (
    <>
      <div className="cyber-window-drag" aria-hidden="true" />
      <div className="cyber-window-controls" aria-label="窗口控制">
        <button type="button" aria-label="最小化" onClick={() => void getDesktopAPI()?.minimizeWindow()}>
          <Minus />
        </button>
        <button type="button" aria-label="最大化或还原" onClick={() => void getDesktopAPI()?.toggleMaximizeWindow()}>
          <Square />
        </button>
        <button type="button" className="is-close" aria-label="关闭" onClick={() => void getDesktopAPI()?.closeWindow()}>
          <X />
        </button>
      </div>
    </>
  );
}

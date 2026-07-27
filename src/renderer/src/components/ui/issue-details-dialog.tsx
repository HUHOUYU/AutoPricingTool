import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export type IssueDetail = {
  label: string;
  message: string;
};

type IssueDetailsDialogProps = {
  open: boolean;
  title: string;
  summary: string;
  issues: IssueDetail[];
  onClose: () => void;
};

export function IssueDetailsDialog({
  open,
  title,
  summary,
  issues,
  onClose,
}: IssueDetailsDialogProps): React.JSX.Element | null {
  const titleId = useId();
  const summaryId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  return createPortal(
    <div
      className="issue-details-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="issue-details-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
      >
        <header>
          <span className="issue-details-dialog-icon" aria-hidden="true"><AlertTriangle /></span>
          <div>
            <h2 id={titleId}>{title}</h2>
            <p id={summaryId}>{summary}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="issue-details-dialog-close"
            aria-label="关闭问题详情"
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        <div className="issue-details-dialog-body">
          <div className="issue-details-dialog-count">
            <strong>{issues.length} 个具体问题</strong>
            <span>请按源数据行定位并修正</span>
          </div>
          <ul>
            {issues.map((issue, index) => (
              <li key={`${issue.label}-${issue.message}-${index}`}>
                <b>{issue.label}</b>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
        <footer>
          <Button type="button" onClick={onClose}>知道了</Button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

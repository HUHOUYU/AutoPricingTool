import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  tone?: "warning" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy = false,
  tone = "warning",
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [busy, onCancel, open]);

  if (!open) return null;
  const Icon = tone === "danger" ? Trash2 : AlertTriangle;

  return createPortal(
    <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section className={`confirm-dialog is-${tone}`} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <div className="confirm-dialog-icon" aria-hidden="true"><Icon /></div>
        <div className="confirm-dialog-copy">
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
        </div>
        <div className="confirm-dialog-actions">
          <Button ref={cancelRef} type="button" variant="outline" disabled={busy} onClick={onCancel}>取消</Button>
          <Button type="button" variant={tone === "danger" ? "destructive" : "default"} disabled={busy} onClick={onConfirm}>{busy ? "处理中…" : confirmLabel}</Button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

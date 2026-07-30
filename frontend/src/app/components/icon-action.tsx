import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

type IconActionProps = {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  tone?: "normal" | "primary" | "danger";
  compact?: boolean;
};

export function IconAction({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  active = false,
  tone = "normal",
  compact = false,
}: IconActionProps): React.JSX.Element {
  return (
    <Button
      type="button"
      variant={tone === "primary" || active ? "default" : "outline"}
      size={compact ? "icon" : "default"}
      className={[
        "icon-action",
        active ? "is-active" : "",
        tone !== "normal" ? "is-" + tone : "",
        compact ? "is-compact" : "",
      ].filter(Boolean).join(" ")}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={20} strokeWidth={1.9} aria-hidden="true" />
      <span>{label}</span>
    </Button>
  );
}

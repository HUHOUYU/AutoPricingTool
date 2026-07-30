import { useMemo, useState } from "react";
import { CalendarDays } from "lucide-react";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type DatePickerProps = {
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
};

const CALENDAR_START_YEAR_OFFSET = 5;
const CALENDAR_END_YEAR_OFFSET = 1;

function parseDateValue(value: string): Date | undefined {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function DatePicker({ value, onValueChange, ariaLabel, className }: DatePickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => parseDateValue(value), [value]);
  const today = new Date();
  const startMonth = new Date(today.getFullYear() - CALENDAR_START_YEAR_OFFSET, 0, 1);
  const endMonth = new Date(today.getFullYear() + CALENDAR_END_YEAR_OFFSET, 11, 1);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn("date-picker-trigger", className)}
          aria-label={ariaLabel}
          aria-expanded={open}
        >
          <span>{selected ? format(selected, "yyyy-MM-dd", { locale: zhCN }) : "选择日期"}</span>
          <CalendarDays />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <DayPicker
          mode="single"
          selected={selected}
          defaultMonth={selected}
          locale={zhCN}
          startMonth={startMonth}
          endMonth={endMonth}
          showOutsideDays
          onSelect={(date) => {
            if (!date) return;
            onValueChange(format(date, "yyyy-MM-dd"));
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

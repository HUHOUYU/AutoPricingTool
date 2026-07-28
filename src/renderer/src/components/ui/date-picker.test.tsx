import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DatePicker } from "./date-picker";

describe("DatePicker", () => {
  it("uses the shared popover calendar instead of a native date input", async () => {
    render(<DatePicker value="2026-07-28" ariaLabel="开始日期" onValueChange={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "开始日期" });
    expect(trigger).toHaveTextContent("2026-07-28");
    expect(document.querySelector('input[type="date"]')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

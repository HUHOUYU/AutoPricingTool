import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

describe("Select", () => {
  it("uses the shared Radix trigger and option surface", async () => {
    const onValueChange = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    render(
      <Select defaultValue="all" onValueChange={onValueChange}>
        <SelectTrigger aria-label="状态"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部状态</SelectItem>
          <SelectItem value="completed">已完成</SelectItem>
        </SelectContent>
      </Select>,
    );

    const trigger = screen.getByRole("combobox", { name: "状态" });
    expect(trigger).toHaveClass("ui-select-trigger");
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("option", { name: "已完成" }));
    expect(onValueChange).toHaveBeenCalledWith("completed");
  });
});

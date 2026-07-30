import { render, screen } from "@testing-library/react";
import { Download } from "lucide-react";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("exposes stable visual variants and sizes for the shared button system", () => {
    render(
      <>
        <Button><Download />导出</Button>
        <Button variant="outline" size="sm">取消</Button>
        <Button variant="destructive">删除</Button>
      </>,
    );

    expect(screen.getByRole("button", { name: "导出" })).toHaveAttribute("data-variant", "default");
    expect(screen.getByRole("button", { name: "导出" })).toHaveAttribute("data-size", "default");
    expect(screen.getByRole("button", { name: "取消" })).toHaveAttribute("data-variant", "outline");
    expect(screen.getByRole("button", { name: "取消" })).toHaveAttribute("data-size", "sm");
    expect(screen.getByRole("button", { name: "删除" })).toHaveAttribute("data-variant", "destructive");
  });
});

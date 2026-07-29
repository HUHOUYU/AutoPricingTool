import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/renderer/src/styles.css"), "utf8");

describe("dark theme portal surfaces", () => {
  it("keeps dark semantic tokens more specific than the light root defaults", () => {
    const darkRoot = styles.match(/:root\.dark\s*\{([\s\S]*?)\}/)?.[1];

    expect(darkRoot).toContain("--background: #211f1c");
    expect(darkRoot).toContain("--card: #25231f");
    expect(darkRoot).toContain("--popover: #2d2a25");
    expect(darkRoot).toContain("--card-foreground: #f2eee7");
  });

  it("uses semantic surfaces for toast, standard dialogs, and detail dialogs", () => {
    expect(styles).toMatch(
      /\[data-sonner-toast\]\.cyber-toast\s*\{[\s\S]*?background:[^;]*var\(--card\)/,
    );
    expect(styles).toMatch(
      /\.confirm-dialog\s*\{[\s\S]*?background:\s*var\(--card\)/,
    );
    expect(styles).toMatch(
      /\.issue-details-dialog\s*\{[\s\S]*?background:\s*var\(--card\)/,
    );
  });
});

import { render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DueDate, isOverdue, localToday } from "./due-date";

describe("due dates", () => {
  afterEach(() => vi.useRealTimers());

  it("uses the browser local calendar date and excludes completed issues", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 16, 12));
    expect(localToday()).toBe("2026-10-16");
    expect(isOverdue({ due_date: "2026-10-15", status_category: "todo" })).toBe(true);
    expect(isOverdue({ due_date: "2026-10-15", status_category: "done" })).toBe(false);
    expect(isOverdue({ due_date: "2026-10-16", status_category: "todo" })).toBe(false);
    render(<DueDate issue={{ due_date: "2026-10-15", status_category: "todo" }} />);
    expect(screen.getByText(new Date(2026, 9, 15).toLocaleDateString()).className).toContain("text-danger-text");
  });
});

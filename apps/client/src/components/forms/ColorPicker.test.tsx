import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLOR_SWATCHES, ColorPicker } from "./ColorPicker";

afterEach(() => cleanup());

describe("ColorPicker", () => {
  it("marks the swatch matching the current value as selected", () => {
    const swatch = COLOR_SWATCHES[0]!;
    render(<ColorPicker value={swatch.value} onChange={vi.fn()} idPrefix="tag" />);
    expect(screen.getByRole("button", { name: swatch.label })).toHaveAttribute("aria-pressed", "true");
  });

  it("selects no swatch when the value is empty", () => {
    render(<ColorPicker value={null} onChange={vi.fn()} idPrefix="tag" />);
    for (const swatch of COLOR_SWATCHES) {
      expect(screen.getByRole("button", { name: swatch.label })).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("calls onChange with the swatch's hex value when clicked", () => {
    const onChange = vi.fn();
    const swatch = COLOR_SWATCHES[1]!;
    render(<ColorPicker value={null} onChange={onChange} idPrefix="tag" />);
    fireEvent.click(screen.getByRole("button", { name: swatch.label }));
    expect(onChange).toHaveBeenCalledWith(swatch.value);
  });

  it("shows the current hex value so it can be seen and copied", () => {
    render(<ColorPicker value="#4f46e5" onChange={vi.fn()} idPrefix="tag" />);
    expect(screen.getByText("#4f46e5")).toBeInTheDocument();
  });

  it("supports a custom color through the native color input", () => {
    const onChange = vi.fn();
    render(<ColorPicker value={null} onChange={onChange} idPrefix="tag" />);
    const customInput = screen.getByLabelText("Custom color");
    fireEvent.input(customInput, { target: { value: "#123456" } });
    expect(onChange).toHaveBeenCalledWith("#123456");
  });

  it("clears the color back to empty", () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#4f46e5" onChange={onChange} idPrefix="tag" />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

// Pattern: assert on the rendered class list rather than layout, since jsdom has no
// layout engine. The mobile-first classes below are the contract this test protects:
// a 390px screen must never see the centered, width-capped desktop popup.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

afterEach(() => cleanup());

describe("DialogContent", () => {
  it("is a full screen sheet below md and the original centered card at md and up", () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Example</DialogTitle>
          </DialogHeader>
          <p>Body</p>
        </DialogContent>
      </Dialog>,
    );
    const popup = screen.getByRole("dialog");
    // Mobile: pinned to every edge, not the centered/translated card.
    expect(popup.className).toContain("inset-0");
    expect(popup.className).toContain("overflow-y-auto");
    // md and up: back to the original centered, width-capped, clipped card.
    expect(popup.className).toContain("md:inset-auto");
    expect(popup.className).toContain("md:top-1/2");
    expect(popup.className).toContain("md:left-1/2");
    expect(popup.className).toContain("md:max-w-md");
    expect(popup.className).toContain("md:overflow-hidden");
  });

  it("pins the footer toward the bottom and clears the home indicator safe area", () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Example</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <button type="button">Cancel</button>
            <button type="button">Confirm</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const footer = screen.getByRole("button", { name: "Cancel" }).closest('[data-slot="dialog-footer"]');
    expect(footer).not.toBeNull();
    expect(footer!.className).toContain("mt-auto");
    expect(footer!.className).toContain("safe-area-inset-bottom");
    // Stacked below md (thumb reach, primary action nearest the thumb), a row at md and up.
    expect(footer!.className).toContain("flex-col-reverse");
    expect(footer!.className).toContain("md:flex-row");
  });
});

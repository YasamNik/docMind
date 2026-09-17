import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgotPasswordPage } from "./ForgotPasswordPage";

const requestPasswordResetMock = vi.fn();

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    requestPasswordReset: (...args: unknown[]) => requestPasswordResetMock(...args),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  render(
    <MemoryRouter>
      <ForgotPasswordPage />
    </MemoryRouter>,
  );
}

describe("ForgotPasswordPage", () => {
  it("sends a reset request pointing at the client's reset page", async () => {
    requestPasswordResetMock.mockResolvedValue({ data: { status: true }, error: null });
    renderPage();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() =>
      expect(requestPasswordResetMock).toHaveBeenCalledWith({
        email: "user@example.com",
        redirectTo: `${window.location.origin}/reset-password`,
      }),
    );
    expect(await screen.findByText(/server console/i)).toBeInTheDocument();
  });

  it("shows the server's error message on failure", async () => {
    requestPasswordResetMock.mockResolvedValue({ data: null, error: { message: "Too many requests" } });
    renderPage();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByText("Too many requests")).toBeInTheDocument();
  });
});

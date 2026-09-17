import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResetPasswordPage } from "./ResetPasswordPage";

const resetPasswordMock = vi.fn();

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    resetPassword: (...args: unknown[]) => resetPasswordMock(...args),
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/sign-in" element={<div>Sign in page</div>} />
        <Route path="/forgot-password" element={<div>Forgot password page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ResetPasswordPage", () => {
  it("shows an invalid link message when there is no token", () => {
    renderPage("/reset-password");
    expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
  });

  it("shows an invalid link message when the server reports an expired token", () => {
    renderPage("/reset-password?error=INVALID_TOKEN");
    expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
  });

  it("rejects mismatched passwords before calling the server", () => {
    renderPage("/reset-password?token=abc123");
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "correct horse battery" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different password" } });
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }));
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
    expect(resetPasswordMock).not.toHaveBeenCalled();
  });

  it("resets the password and redirects to sign in", async () => {
    resetPasswordMock.mockResolvedValue({ data: { status: true }, error: null });
    renderPage("/reset-password?token=abc123");
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "correct horse battery" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }));
    await waitFor(() =>
      expect(resetPasswordMock).toHaveBeenCalledWith({ newPassword: "correct horse battery", token: "abc123" }),
    );
    expect(await screen.findByText("Sign in page")).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalled();
  });

  it("shows the server's error message on failure", async () => {
    resetPasswordMock.mockResolvedValue({ data: null, error: { message: "Invalid or expired token" } });
    renderPage("/reset-password?token=abc123");
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "correct horse battery" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }));
    expect(await screen.findByText("Invalid or expired token")).toBeInTheDocument();
  });
});

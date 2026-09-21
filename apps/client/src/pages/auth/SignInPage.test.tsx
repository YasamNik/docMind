import { useSyncExternalStore } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/auth-client";
import { SignInPage } from "./SignInPage";

// Stand in for better-auth's session store (see lib/auth-client.ts): resolving
// signIn/signUp does not by itself update the session, only calling and awaiting
// the hook's `refetch` does. Declared with vi.hoisted so the mocked module below
// can reach it safely despite vi.mock being hoisted above this file's imports.
const mocks = vi.hoisted(() => {
  let sessionData: { user: { id: string } } | null = null;
  const listeners = new Set<() => void>();

  return {
    signInEmailMock: vi.fn(),
    signUpEmailMock: vi.fn(),
    apiGetMock: vi.fn(),
    getSessionData: () => sessionData,
    resetSessionStore: () => {
      sessionData = null;
      listeners.clear();
    },
    subscribeSession: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Mirrors the real client: the session only becomes available once this
    // resolves, on its own timer, well after signIn/signUp already resolved.
    refetchSession: () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          sessionData = { user: { id: "user_1" } };
          listeners.forEach((listener) => listener());
          resolve();
        }, 0);
      }),
  };
});

vi.mock("@/lib/api", () => ({
  api: { get: (...args: unknown[]) => mocks.apiGetMock(...args) },
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: (...args: unknown[]) => mocks.signInEmailMock(...args) },
    signUp: { email: (...args: unknown[]) => mocks.signUpEmailMock(...args) },
    useSession: () => ({
      data: useSyncExternalStore(mocks.subscribeSession, mocks.getSessionData),
      isPending: false,
      refetch: mocks.refetchSession,
    }),
  },
}));

// Stands in for App.tsx's RequireSession guard: bounces back to sign in unless
// the shared session store already holds a session. If SignInPage navigates
// before the store has caught up, this is what sends the user back here.
function Guard({ children }: { children: React.ReactNode }) {
  const { data, isPending } = authClient.useSession();
  if (isPending) return null;
  if (!data) return <Navigate to="/sign-in" replace />;
  return <>{children}</>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.resetSessionStore();
});

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/sign-in"]}>
      <Routes>
        <Route path="/sign-in" element={<SignInPage />} />
        <Route
          path="/documents"
          element={
            <Guard>
              <div>Documents home</div>
            </Guard>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SignInPage", () => {
  it("lands in the app on the first sign in, even though the session store has not refreshed yet", async () => {
    mocks.apiGetMock.mockResolvedValue({ hasUsers: true });
    mocks.signInEmailMock.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
    renderPage();

    await screen.findByLabelText("Email");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Documents home")).toBeInTheDocument();
    expect(mocks.signInEmailMock).toHaveBeenCalledWith({ email: "user@example.com", password: "correct-horse-battery" });
  });

  it("lands in the app on the first sign up, even though the session store has not refreshed yet", async () => {
    mocks.apiGetMock.mockResolvedValue({ hasUsers: false });
    mocks.signUpEmailMock.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
    renderPage();

    await screen.findByLabelText("Email");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Documents home")).toBeInTheDocument();
    expect(mocks.signUpEmailMock).toHaveBeenCalledWith({ email: "new@example.com", password: "correct-horse-battery", name: "new@example.com" });
  });

  it("shows the server's error message and does not navigate on a failed sign in", async () => {
    mocks.apiGetMock.mockResolvedValue({ hasUsers: true });
    mocks.signInEmailMock.mockResolvedValue({ data: null, error: { message: "Invalid email or password" } });
    renderPage();

    await screen.findByLabelText("Email");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Invalid email or password")).toBeInTheDocument();
    expect(screen.queryByText("Documents home")).not.toBeInTheDocument();
  });
});

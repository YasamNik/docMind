import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { clearStorageReauthRequired, markStorageReauthRequired, useStorageReauthRequired } from "./storage-reauth";

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("storage reauth signal", () => {
  it("starts false for a driver nothing has flagged", async () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useStorageReauthRequired("googleDrive"), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("turns on once marked and off again once cleared", async () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useStorageReauthRequired("googleDrive"), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current).toBe(false));

    markStorageReauthRequired(queryClient, "googleDrive");
    await waitFor(() => expect(result.current).toBe(true));

    clearStorageReauthRequired(queryClient, "googleDrive");
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("keeps each driver's state independent", async () => {
    const queryClient = new QueryClient();
    markStorageReauthRequired(queryClient, "googleDrive");
    const { result } = renderHook(() => useStorageReauthRequired("s3"), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current).toBe(false));
  });
});

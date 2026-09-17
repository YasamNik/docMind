export class ApiError extends Error {
  code: string;
  status: number;
  constructor({ code, message, status }: { code: string; message: string; status: number }) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  let code = "http_error";
  let message = res.statusText || "Request failed";
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // body was not JSON
  }
  throw new ApiError({ code, message, status: res.status });
}

export const api = {
  get<T>(path: string) {
    return fetch(path, { credentials: "include" }).then((r) => handle<T>(r));
  },
  json<T>(method: "POST" | "PUT" | "PATCH", path: string, body: unknown) {
    return fetch(path, {
      method,
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => handle<T>(r));
  },
  del<T = void>(path: string) {
    return fetch(path, { method: "DELETE", credentials: "include" }).then((r) => handle<T>(r));
  },
};

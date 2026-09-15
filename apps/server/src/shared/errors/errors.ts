export class AppError extends Error {
  code: string;
  status: number;

  constructor({ code, message, status }: { code: string; message: string; status: number }) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export function createError(args: { code: string; message: string; status?: number }) {
  return new AppError({ status: 500, ...args });
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

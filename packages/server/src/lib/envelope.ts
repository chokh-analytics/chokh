// The one API envelope. Every route answers through these two helpers, so a
// consumer can parse any response the same way. See AGENTS.md section 5.

export type ApiMeta = Record<string, unknown>;

export interface ApiSuccess<TData> {
  success: true;
  data: TData;
  meta?: ApiMeta;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiFailure {
  success: false;
  error: ApiError;
}

export type ApiResponse<TData> = ApiSuccess<TData> | ApiFailure;

export function ok<TData>(data: TData, meta?: ApiMeta): ApiSuccess<TData> {
  return meta === undefined ? { success: true, data } : { success: true, data, meta };
}

export function fail(code: string, message: string, details?: unknown): ApiFailure {
  const error: ApiError = details === undefined ? { code, message } : { code, message, details };
  return { success: false, error };
}

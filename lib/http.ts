// Small HTTP plumbing shared by the surface modules: an error type that carries a status,
// and the per-request call context app.ts builds (method, query, raw body, host).

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export interface Call {
  method: string;
  query: URLSearchParams;
  /** The request body's raw text (git and MCP handlers read their own from app.ts instead). */
  bodyText: string;
  /** The request's Host header, for building same-origin Link URLs. */
  host: string;
  /**
   * The body parsed as JSON: an empty body reads as {}, a malformed one is a 400.
   * Non-object JSON (arrays, scalars) passes through; route handlers validate shapes.
   */
  json(): Record<string, unknown>;
}

export function makeCall(method: string, query: URLSearchParams, bodyText: string, host: string): Call {
  let parsed: unknown;
  let parsedOk = false;
  return {
    method,
    query,
    bodyText,
    host,
    json(): Record<string, unknown> {
      if (!parsedOk) {
        parsedOk = true;
        if (bodyText.trim() === '') {
          parsed = {};
        } else {
          try {
            parsed = JSON.parse(bodyText);
          } catch {
            throw new HttpError(400, 'Problems parsing JSON');
          }
        }
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new HttpError(400, 'Problems parsing JSON');
      }
      return parsed as Record<string, unknown>;
    },
  };
}

/** A handler's answer: a status, an optional JSON body, optional extra headers. */
export interface Answer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

export function boolField(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function stringListField(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

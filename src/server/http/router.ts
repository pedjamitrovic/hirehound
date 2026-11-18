import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import type { ApiErrorBody } from "../../shared/schemas/api.ts";
import { formatPath } from "../../shared/validate.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: { path: string; message: string }[] | undefined;
  constructor(
    status: number,
    code: string,
    message: string,
    issues?: { path: string; message: string }[],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

/** Returned by handlers that wrote the response themselves (SSE, raw files). */
export const HANDLED = Symbol("handled");

/** A JSON response with a non-200 status. */
export class Reply {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    this.status = status;
    this.body = body;
  }
}

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Reads and validates a JSON body. Throws HttpError 400/413/415. */
  body<T>(schema: z.ZodType<T>): Promise<T>;
  /** Reads a binary upload (content-type application/octet-stream). Throws HttpError 413/415. */
  raw(limitBytes: number): Promise<Buffer>;
};

export type Handler = (ctx: RouteContext) => unknown;

type Segment = { literal: string } | { param: string };
type Route = { method: string; segments: Segment[]; handler: Handler };

const MAX_BODY_BYTES = 2_000_000;

function compile(path: string): Segment[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => (part.startsWith(":") ? { param: part.slice(1) } : { literal: part }));
}

function match(segments: Segment[], parts: string[]): Record<string, string> | null {
  if (segments.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const part = parts[i];
    if (!segment || part === undefined) return null;
    if ("literal" in segment) {
      if (segment.literal !== part) return null;
    } else {
      try {
        params[segment.param] = decodeURIComponent(part);
      } catch {
        return null;
      }
    }
  }
  return params;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, error: HttpError): void {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.issues ? { issues: error.issues } : {}),
    },
  };
  sendJson(res, error.status, body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const type = req.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(
      415,
      "unsupported-media-type",
      "Send JSON (content-type: application/json)",
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "too-large", "Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Binary uploads. application/octet-stream is not a CORS-safelisted type, so a cross-site page cannot
 * send one without a preflight that the Origin check then refuses.
 */
export async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const type = req.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("application/octet-stream")) {
    throw new HttpError(415, "unsupported-media-type", "Send the file as application/octet-stream");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) {
      throw new HttpError(
        413,
        "too-large",
        `The file is larger than ${Math.round(limit / 1_000_000)} MB`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function parseBody<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const text = await readBody(req);
  let raw: unknown;
  try {
    raw = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid-json", "Request body is not valid JSON");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: formatPath(i.path),
      message: i.message,
    }));
    throw new HttpError(400, "invalid-request", issues[0]?.message ?? "Invalid request", issues);
  }
  return result.data;
}

/** A deliberately small router: method + path pattern with :params, JSON in and out. */
export class Router {
  #routes: Route[] = [];

  #add(method: string, path: string, handler: Handler): this {
    this.#routes.push({ method, segments: compile(path), handler });
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.#add("GET", path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.#add("POST", path, handler);
  }

  put(path: string, handler: Handler): this {
    return this.#add("PUT", path, handler);
  }

  delete(path: string, handler: Handler): this {
    return this.#add("DELETE", path, handler);
  }

  /** Handles the request; throws HttpError 404/405 when nothing matches. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method === "HEAD" ? "GET" : (req.method ?? "GET");
    let pathMatched = false;
    for (const route of this.#routes) {
      const params = match(route.segments, parts);
      if (!params) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const ctx: RouteContext = {
        req,
        res,
        url,
        params,
        body: (schema) => parseBody(req, schema),
        raw: (limit) => readRaw(req, limit),
      };
      const result = await route.handler(ctx);
      if (result === HANDLED) return;
      if (result instanceof Reply) sendJson(res, result.status, result.body);
      else if (result === undefined) {
        res.writeHead(204);
        res.end();
      } else sendJson(res, 200, result);
      return;
    }
    if (pathMatched) throw new HttpError(405, "method-not-allowed", "Method not allowed");
    throw new HttpError(404, "not-found", `No API route for ${url.pathname}`);
  }
}

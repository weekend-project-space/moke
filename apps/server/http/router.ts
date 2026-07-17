import type { IncomingMessage, ServerResponse } from 'node:http';

import { json, readJson, RequestBodyError } from './response.js';
import { RequestValidationError } from './validation.js';

type Method = 'GET' | 'POST' | 'PATCH';
type RouteHandler<TContext> = (ctx: RequestContext<TContext>) => unknown | Promise<unknown>;

type Route<TContext> = {
  method: Method;
  path: string;
  parts: string[];
  handler: RouteHandler<TContext>;
};

export type RequestContext<TContext> = {
  body: () => Promise<unknown>;
  context: TContext;
  json: (status: number, body: unknown) => void;
  params: Record<string, string>;
  query: URLSearchParams;
  raw: {
    req: IncomingMessage;
    res: ServerResponse;
  };
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const RAW_RESPONSE = Symbol('raw-response');

export function rawResponse() {
  return RAW_RESPONSE;
}

export function createRouter<TContext>() {
  const routes: Route<TContext>[] = [];

  function add(method: Method, path: string, handler: RouteHandler<TContext>) {
    routes.push({ method, path, parts: splitPath(path), handler });
  }

  return {
    get: (path: string, handler: RouteHandler<TContext>) => add('GET', path, handler),
    post: (path: string, handler: RouteHandler<TContext>) => add('POST', path, handler),
    patch: (path: string, handler: RouteHandler<TContext>) => add('PATCH', path, handler),
    handler(context: TContext) {
      return async function handleRequest(req: IncomingMessage, res: ServerResponse) {
        try {
          if (req.method === 'OPTIONS') return json(res, 204, {});

          const url = new URL(req.url || '/', `http://${req.headers.host}`);
          const match = matchRoute(routes, req.method || 'GET', url.pathname);
          if (!match) {
            return json(res, 404, {
              error: { code: 'NOT_FOUND', message: 'Route not found' },
            });
          }

          const body = memoizeBody(req);
          const result = await match.route.handler({
            body,
            context,
            json: (status, responseBody) => json(res, status, responseBody),
            params: match.params,
            query: url.searchParams,
            raw: { req, res },
          });

          if (result === RAW_RESPONSE || res.writableEnded) return;
        } catch (error) {
          if (error instanceof RequestValidationError) {
            return json(res, error.status, {
              error: {
                code: error.code,
                message: error.message,
                details: error.issues,
              },
            });
          }

          if (error instanceof HttpError || error instanceof RequestBodyError) {
            return json(res, error.status, {
              error: { code: error.code, message: error.message },
            });
          }

          return json(res, 500, {
            error: {
              code: 'INTERNAL_ERROR',
              message: error instanceof Error ? error.message : 'Unknown error',
            },
          });
        }
      };
    },
  };
}

export type Router<TContext> = ReturnType<typeof createRouter<TContext>>;

function memoizeBody(req: IncomingMessage) {
  let parsed: Promise<Record<string, unknown>> | undefined;
  return () => {
    parsed ||= readJson(req);
    return parsed;
  };
}

function splitPath(path: string) {
  return path.split('/').filter(Boolean);
}

function matchRoute<TContext>(routes: Route<TContext>[], method: string, pathname: string) {
  const requestParts = splitPath(pathname);

  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.parts.length !== requestParts.length) continue;

    const params: Record<string, string> = {};
    let matched = true;

    for (let index = 0; index < route.parts.length; index++) {
      const routePart = route.parts[index];
      const requestPart = requestParts[index];

      if (routePart.startsWith(':')) {
        params[routePart.slice(1)] = decodeURIComponent(requestPart);
        continue;
      }

      if (routePart !== requestPart) {
        matched = false;
        break;
      }
    }

    if (matched) return { route, params };
  }

  return null;
}

import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;

export class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RequestBodyError';
  }
}

export function json(res: ServerResponse, status: number, body: unknown) {
  if (status === 204) {
    res.writeHead(status, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    });
    res.end();
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES) {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    req.resume();
    throw new RequestBodyError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }

  const chunks = await readBodyChunks(req, maxBytes);
  if (chunks.length === 0) return {} as Record<string, unknown>;

  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RequestBodyError(400, 'BAD_REQUEST', 'JSON body must be an object');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(400, 'BAD_REQUEST', 'Request body contains invalid JSON');
  }
}

function readBodyChunks(req: IncomingMessage, maxBytes: number) {
  return new Promise<Buffer[]>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes <= maxBytes) {
        chunks.push(buffer);
        return;
      }

      cleanup();
      req.resume();
      reject(new RequestBodyError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'));
    };
    const onEnd = () => {
      cleanup();
      resolve(chunks);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAborted = () => {
      cleanup();
      reject(new RequestBodyError(400, 'BAD_REQUEST', 'Request body was aborted'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

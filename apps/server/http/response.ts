import type { IncomingMessage, ServerResponse } from 'node:http';

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {} as Record<string, unknown>;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
}

// The forge's HTTP surface: a health probe, git smart HTTP at /{owner}/{repo}.git, the
// REST v3 API under /api/v3, GraphQL at /api/graphql and MCP at /mcp, all over one store.
//
// Cross-cutting rules (the suite's protocol group): every REST reply is application/json
// and never HTML, every reply carries a non-empty X-GitHub-Request-Id, errors are JSON with
// a string `message`, an unknown route is a JSON 404, and a malformed JSON body is a 400.
// Auth: `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; missing or wrong is a 401 everywhere
// except the health probe. A repository under another owner reads as 404, never 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { findRepo, store } from './lib/store.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { infoRefs, receivePack, uploadPack } from './lib/gitproto.ts';
import { HttpError, makeCall, type Answer } from './lib/http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function nextRequestId(): string {
  store.requestCounter += 1;
  return `forge-${store.requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendAnswer(res: ServerResponse, answer: Answer): void {
  if (answer.status === 204 || answer.body === undefined) {
    res.writeHead(answer.status, { 'x-github-request-id': nextRequestId(), ...(answer.headers ?? {}) });
    res.end();
    return;
  }
  sendJson(res, answer.status, answer.body, answer.headers ?? {});
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function authed(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return false;
  return (req.headers.authorization ?? '') === `Bearer ${expected}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad request' });
    return;
  }
  const segments = url.pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);

  // The env's boot probe: 200 {"ok":true}, no auth.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const bodyText = body.toString('utf8');

  try {
    // GraphQL v4.
    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
      if (!authed(req)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
      if (method !== 'POST') throw new HttpError(404, 'Not Found');
      sendAnswer(res, handleGraphQL(bodyText));
      return;
    }

    // MCP.
    if (segments.length === 1 && segments[0] === 'mcp') {
      if (!authed(req)) {
        sendJson(res, 401, { message: 'Unauthorized' });
        return;
      }
      if (method === 'DELETE') {
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
      const answer = handleMcp(bodyText);
      if (answer.bodyText === '') {
        res.writeHead(answer.status, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      sendRaw(res, answer.status, JSON_TYPE, Buffer.from(answer.bodyText, 'utf8'));
      return;
    }

    // REST v3.
    if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
      if (!authed(req)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
      const call = makeCall(method, url.searchParams, bodyText, req.headers.host ?? 'localhost');
      sendAnswer(res, handleRest(call, segments.slice(2)));
      return;
    }
    if (segments.length === 1 && segments[0] === 'api') {
      // /api alone is not a route; keep the JSON 404 discipline.
      throw new HttpError(404, 'Not Found');
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
      if (!authed(req)) {
        res.writeHead(401, {
          'content-type': JSON_TYPE,
          'www-authenticate': 'Basic realm="forge"',
          'x-github-request-id': nextRequestId(),
        });
        res.end(`${JSON.stringify({ message: 'Bad credentials' })}\n`);
        return;
      }
      const owner = segments[0]!;
      const repoName = segments[1]!.slice(0, -'.git'.length);
      const repo = findRepo(owner, repoName);
      if (repo === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const rest = segments.slice(2);
      const wantsV2 =
        (req.headers['git-protocol'] ?? '').includes('version=2') ||
        body.subarray(0, 8).toString('ascii') === 'command=';
      if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const answer = infoRefs(repo, service, wantsV2);
        sendRaw(res, answer.status, answer.contentType, answer.body);
        return;
      }
      if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
        const answer = uploadPack(repo, body, wantsV2);
        sendRaw(res, answer.status, answer.contentType, answer.body);
        return;
      }
      if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
        const answer = receivePack(repo, body);
        sendRaw(res, answer.status, answer.contentType, answer.body);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { message: err.message });
      return;
    }
    process.stderr.write(`[forge] unhandled error on ${method} ${url.pathname}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    sendJson(res, 500, { message: 'Internal error' });
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err: unknown) => {
      // The last line of defence: a request must never take the process down.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
        else res.end();
      } catch {
        // The peer is gone; nothing more to do.
      }
      process.stderr.write(`[forge] fatal handler error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  });
  server.on('clientError', (_err, socket) => {
    socket.destroy();
  });
  return server;
}

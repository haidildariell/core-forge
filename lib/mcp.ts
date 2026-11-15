// The MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP, answered as plain JSON.
// Both protocol eras the rules accept are served: the 2026-07-28 revision through
// server/discover (no handshake, no session), and the 2025-11-25-and-earlier handshake
// (initialize + notifications/initialized). The six github-mcp-server tools run on the same
// store as REST and GraphQL, so ids and objects are identical across surfaces.
// Authentication happens in app.ts before this runs (a missing Authorization header is a
// bare HTTP 401 there); a body that is not JSON is answered here with HTTP 400 and -32700.

import { VIEWER, findRepo, createRepo as storeCreateRepo, type RepoRec } from './store.ts';
import { createIssue, createPull, issueJson, mergePull, pullJson, repoJson } from './forge.ts';
import { HttpError } from './http.ts';

export const MCP_SERVER_INFO = Object.freeze({ name: 'makefun-forge', version: '1.0.0' });
const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

// The tool list is a fixed literal: two tools/list calls must answer byte-identical lists,
// so nothing here is computed from mutable state.
export const MCP_TOOLS = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

interface RpcError {
  code: number;
  message: string;
}

export interface McpAnswer {
  status: number;
  /** The exact body text to send ('' for a notification's 202). */
  bodyText: string;
}

function rpcResult(id: unknown, result: unknown): McpAnswer {
  return { status: 200, bodyText: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, status: number, error: RpcError): McpAnswer {
  return { status, bodyText: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error }) };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function repoOrToolError(owner: string, repo: string): RepoRec {
  const found = findRepo(owner, repo);
  if (found === undefined) throw new Error(`repository ${owner}/${repo} not found`);
  return found;
}

/** Validate the required string arguments of a tool; the missing names, in schema order. */
function missingArgs(tool: (typeof MCP_TOOLS)[number], args: Record<string, unknown>): string[] {
  const required = (tool.inputSchema.required ?? []) as string[];
  return required.filter((name) => {
    const value = args[name];
    if (name === 'pull_number') return !(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)));
    return typeof value !== 'string' || value === '';
  });
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = args.name as string;
        if (findRepo(VIEWER.login, repoName) !== undefined) return toolError(`a repository named "${repoName}" already exists`);
        const repo = storeCreateRepo(repoName, {
          private: typeof args.private === 'boolean' ? args.private : false,
          description: typeof args.description === 'string' ? args.description : '',
        });
        return toolResult(repoJson(repo));
      }
      case 'get_repo': {
        const repo = repoOrToolError(args.owner as string, args.repo as string);
        return toolResult(repoJson(repo));
      }
      case 'create_issue': {
        const repo = repoOrToolError(args.owner as string, args.repo as string);
        const issue = createIssue(repo, {
          title: args.title as string,
          body: typeof args.body === 'string' ? args.body : '',
        });
        return toolResult(issueJson(repo, issue));
      }
      case 'list_issues': {
        const repo = repoOrToolError(args.owner as string, args.repo as string);
        const state = typeof args.state === 'string' ? args.state : 'open';
        const issues = repo.issueOrder
          .map((number) => repo.issues.get(number)!)
          .filter((issue) => state === 'all' || issue.state === state);
        return toolResult(issues.map((issue) => issueJson(repo, issue)));
      }
      case 'create_pull_request': {
        const repo = repoOrToolError(args.owner as string, args.repo as string);
        const pull = createPull(repo, {
          title: args.title as string,
          body: typeof args.body === 'string' ? args.body : '',
          head: args.head as string,
          base: args.base as string,
        });
        return toolResult(pullJson(repo, pull));
      }
      case 'merge_pull_request': {
        const repo = repoOrToolError(args.owner as string, args.repo as string);
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
        const pull = repo.pulls.get(number);
        if (pull === undefined) return toolError(`pull request #${number} not found`);
        mergePull(repo, pull);
        return toolResult(pullJson(repo, pull));
      }
      default:
        return toolError(`unknown tool ${name}`);
    }
  } catch (err) {
    if (err instanceof HttpError) return toolError(err.message);
    return toolError(err instanceof Error ? err.message : 'tool execution failed');
  }
}

/** Handle one POST /mcp body. Auth has already been decided by the caller. */
export function handleMcp(bodyText: string): McpAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcError(null, 400, { code: -32700, message: 'Parse error' });
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    return rpcError(null, 400, { code: -32600, message: 'Invalid Request' });
  }
  const method = parsed.method;
  const params = isRecord(parsed.params) ? parsed.params : {};
  const hasId = 'id' in parsed && parsed.id !== undefined;
  const id = hasId ? parsed.id : null;

  // Notifications (no id) are accepted and answered with a bare 202.
  if (!hasId) return { status: 202, bodyText: '' };

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...MCP_SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...MCP_SERVER_INFO } },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { ...MCP_SERVER_INFO },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
      if (tool === undefined) {
        return rpcError(id, 200, { code: -32602, message: `Unknown tool: ${toolName}` });
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      const missing = missingArgs(tool, args);
      if (missing.length > 0) {
        return rpcError(id, 200, { code: -32602, message: `Missing required argument(s): ${missing.join(', ')}` });
      }
      return rpcResult(id, callTool(toolName, args));
    }
    default:
      return rpcError(id, 200, { code: -32601, message: `Method not found: ${method}` });
  }
}

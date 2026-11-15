// A small GraphQL engine for the documents gh and github-mcp-server send: a tokenizer and
// parser for the query subset they use (operations with names and variable definitions,
// aliases, inline fragments, input objects, enum lists, null variables), an executor over
// the shared store, the introspection answers for Issue / PullRequest / Repository /
// SearchType, and the create/close/merge/comment mutations. GraphQL-level failures are
// HTTP 200 with an `errors` array; authentication is app.ts's job (exactly 401 before this).

import {
  VIEWER,
  commentGlobalId,
  decodeGlobalId,
  findRepo,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  store,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { createIssue, createPull, mergePull, planMerge, pullChanges } from './forge.ts';
import { HttpError, type Answer } from './http.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',' || char === '﻿') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < input.length && input[index] !== '\n') index += 1;
      continue;
    }
    if (input.startsWith('...', index)) {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if ('{}()[]:$=@!|&'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    if (char === '"') {
      if (input.startsWith('"""', index)) {
        const end = input.indexOf('"""', index + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(index + 3, end) });
        index = end + 3;
        continue;
      }
      let value = '';
      index += 1;
      while (index < input.length && input[index] !== '"') {
        if (input[index] === '\\') {
          const escaped = input[index + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };
          if (escaped === 'u') {
            value += String.fromCharCode(parseInt(input.slice(index + 2, index + 6), 16));
            index += 6;
          } else {
            value += map[escaped ?? ''] ?? escaped ?? '';
            index += 2;
          }
        } else {
          value += input[index];
          index += 1;
        }
      }
      if (index >= input.length) throw new Error('unterminated string');
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(input.slice(index))!;
      const text = match[0];
      index += text.length;
      if (text.includes('.') || text.includes('e') || text.includes('E')) tokens.push({ kind: 'float', value: Number(text) });
      else tokens.push({ kind: 'int', value: Number(text) });
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(input.slice(index))!;
      tokens.push({ kind: 'name', value: match[0] });
      index += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Map<string, ValueNode>;
  selectionSet?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private tokens: Token[];
  private index = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) throw new Error('unexpected end of document');
    this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        const operation = token.value === 'mutation' ? 'mutation' : 'query';
        let name: string | undefined;
        const nextToken = this.peek();
        if (nextToken !== undefined && nextToken.kind === 'name') name = this.expectName();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipBalancedParens();
        this.skipDirectives();
        operations.push({ operation, name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.expectName();
        if (onToken !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'schema' || token.value === 'type' || token.value === 'interface' || token.value === 'enum' || token.value === 'input' || token.value === 'union' || token.value === 'scalar' || token.value === 'directive' || token.value === 'extend')) {
        // Type-system definitions in a query document are not executable; skip the block.
        this.skipDefinition();
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)}`);
    }
    return { operations, fragments };
  }

  private skipBalancedParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipBalancedParens();
    }
  }

  private skipDefinition(): void {
    // Skip tokens until the balanced { ... } block (if any) is consumed.
    let sawBrace = false;
    let depth = 0;
    while (this.peek() !== undefined) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '{') {
        sawBrace = true;
        depth += 1;
      } else if (token.kind === 'punct' && token.value === '}') {
        depth -= 1;
        if (sawBrace && depth === 0) return;
      } else if (!sawBrace && token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'fragment')) {
        this.index -= 1;
        return;
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const nextToken = this.peek();
        if (nextToken !== undefined && nextToken.kind === 'name' && nextToken.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'fragmentSpread', name: this.expectName() });
        }
        continue;
      }
      selections.push(this.parseField());
    }
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, ValueNode>();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      for (;;) {
        const token = this.peek();
        if (token !== undefined && token.kind === 'punct' && token.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      for (;;) {
        const peeked = this.peek();
        if (peeked !== undefined && peeked.kind === 'punct' && peeked.value === ']') {
          this.next();
          break;
        }
        values.push(this.parseValue());
      }
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        const peeked = this.peek();
        if (peeked !== undefined && peeked.kind === 'punct' && peeked.value === '}') {
          this.next();
          break;
        }
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface Ctx {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function resolveValue(ctx: Ctx, node: ValueNode): unknown {
  switch (node.kind) {
    case 'variable':
      return ctx.variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => resolveValue(ctx, value));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(ctx, field.value);
      return out;
    }
  }
}

type Resolver = (
  ctx: Ctx,
  source: never,
  args: Record<string, unknown>,
  selectionSet: SelectionNode[] | undefined,
) => unknown;

const FIELDS: Record<string, Record<string, Resolver>> = {};

function def(type: string, fields: Record<string, Resolver>): void {
  FIELDS[type] = fields;
}

function execObject(ctx: Ctx, typeName: string, source: unknown, selections: readonly SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeFields = FIELDS[typeName] ?? {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === typeName) Object.assign(out, execObject(ctx, typeName, source, selection.selectionSet));
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === typeName) {
        Object.assign(out, execObject(ctx, typeName, source, fragment.selectionSet));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = typeFields[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, valueNode] of selection.args) args[argName] = resolveValue(ctx, valueNode);
    out[key] = resolver(ctx, source as never, args, selection.selectionSet);
  }
  return out;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

interface IssueSource {
  repo: RepoRec;
  issue: IssueRec;
}

interface PullSource {
  repo: RepoRec;
  pull: PullRec;
}

// ---------------------------------------------------------------------------------------------
// schema: introspection data
// ---------------------------------------------------------------------------------------------

interface TypeDef {
  name: string;
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE' | 'SCALAR';
  fields?: string[];
  enumValues?: string[];
}

const TYPE_DEFS: Record<string, TypeDef> = {
  Query: {
    name: 'Query',
    kind: 'OBJECT',
    fields: ['viewer', 'repository', 'node', 'nodes', 'rateLimit', 'search', 'organization', 'user'],
  },
  Mutation: {
    name: 'Mutation',
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'deleteIssue'],
  },
  User: {
    name: 'User',
    kind: 'OBJECT',
    fields: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'isViewer', 'databaseId'],
  },
  Repository: {
    name: 'Repository',
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
      'isFork', 'createdAt', 'updatedAt', 'url', 'stargazerCount', 'forkCount', 'labels', 'refs', 'ref',
      'homepageUrl', 'primaryLanguage',
    ],
  },
  Issue: {
    name: 'Issue',
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'titleHTML', 'body', 'bodyHTML', 'state', 'author', 'labels', 'comments',
      'createdAt', 'updatedAt', 'closedAt', 'url', 'repository', 'assignees', 'milestone', 'databaseId',
    ],
  },
  PullRequest: {
    name: 'PullRequest',
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName',
      'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'author', 'createdAt', 'updatedAt',
      'closedAt', 'url', 'repository', 'additions', 'deletions', 'changedFiles', 'mergeCommit', 'databaseId',
    ],
  },
  Ref: { name: 'Ref', kind: 'OBJECT', fields: ['id', 'name', 'prefix', 'target'] },
  PageInfo: {
    name: 'PageInfo',
    kind: 'OBJECT',
    fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  },
  IssueConnection: { name: 'IssueConnection', kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { name: 'PullRequestConnection', kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { name: 'PullRequestChangedFile', kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  IssueComment: { name: 'IssueComment', kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'url', 'databaseId'] },
  SearchType: { name: 'SearchType', kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueState: { name: 'IssueState', kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { name: 'PullRequestState', kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { name: 'MergeableState', kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { name: 'RepositoryPermission', kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  OrderDirection: { name: 'OrderDirection', kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
};

// ---------------------------------------------------------------------------------------------
// schema: field resolvers
// ---------------------------------------------------------------------------------------------

def('Query', {
  viewer: (ctx, _source, _args, sel) => execObject(ctx, 'User', { login: VIEWER.login }, sel ?? []),
  repository: (ctx, _source, args, sel) => {
    const repo = findRepo(str(args.owner), str(args.name));
    return repo === undefined ? null : execObject(ctx, 'Repository', repo, sel ?? []);
  },
  node: (ctx, _source, args, sel) => {
    const decoded = decodeGlobalId(str(args.id));
    if (decoded === null) return null;
    if (decoded.kind === 'repo') return execObject(ctx, 'Repository', decoded.repo, sel ?? []);
    if (decoded.kind === 'issue') return execObject(ctx, 'Issue', { repo: decoded.repo, issue: decoded.issue } satisfies IssueSource, sel ?? []);
    if (decoded.kind === 'pull') return execObject(ctx, 'PullRequest', { repo: decoded.repo, pull: decoded.pull } satisfies PullSource, sel ?? []);
    if (decoded.kind === 'comment') {
      return execObject(ctx, 'IssueComment', { repo: decoded.repo, issue: decoded.issue, comment: decoded.comment }, sel ?? []);
    }
    return null;
  },
  __type: (ctx, _source, args, sel) => {
    const typeDef = TYPE_DEFS[str(args.name)];
    return typeDef === undefined ? null : execObject(ctx, '__Type', typeDef, sel ?? []);
  },
  __schema: (ctx, _source, _args, sel) =>
    execObject(ctx, '__Schema', { types: Object.values(TYPE_DEFS) }, sel ?? []),
});

def('Mutation', {
  createIssue: (ctx, _source, args, sel) => {
    const input = record(args.input);
    const decoded = decodeGlobalId(str(input.repositoryId));
    if (decoded === null || decoded.kind !== 'repo') {
      ctx.errors.push({ message: 'Could not resolve the repository for createIssue' });
      return null;
    }
    try {
      const issue = createIssue(decoded.repo, { title: str(input.title), body: str(input.body) });
      return execObject(ctx, 'CreateIssuePayload', { repo: decoded.repo, issue } satisfies IssueSource, sel ?? []);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : 'createIssue failed' });
      return null;
    }
  },
  closeIssue: (ctx, _source, args, sel) => {
    const input = record(args.input);
    const decoded = decodeGlobalId(str(input.issueId));
    if (decoded === null || decoded.kind !== 'issue') {
      ctx.errors.push({ message: 'Could not resolve the issue for closeIssue' });
      return null;
    }
    decoded.issue.state = 'closed';
    return execObject(ctx, 'CloseIssuePayload', { repo: decoded.repo, issue: decoded.issue } satisfies IssueSource, sel ?? []);
  },
  createPullRequest: (ctx, _source, args, sel) => {
    const input = record(args.input);
    const decoded = decodeGlobalId(str(input.repositoryId));
    if (decoded === null || decoded.kind !== 'repo') {
      ctx.errors.push({ message: 'Could not resolve the repository for createPullRequest' });
      return null;
    }
    try {
      const pull = createPull(decoded.repo, {
        title: str(input.title),
        body: str(input.body),
        head: str(input.headRefName),
        base: str(input.baseRefName),
      });
      return execObject(ctx, 'CreatePullRequestPayload', { repo: decoded.repo, pull } satisfies PullSource, sel ?? []);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : 'createPullRequest failed' });
      return null;
    }
  },
  mergePullRequest: (ctx, _source, args, sel) => {
    const input = record(args.input);
    const decoded = decodeGlobalId(str(input.pullRequestId));
    if (decoded === null || decoded.kind !== 'pull') {
      ctx.errors.push({ message: 'Could not resolve the pull request for mergePullRequest' });
      return null;
    }
    try {
      mergePull(decoded.repo, decoded.pull);
      return execObject(ctx, 'MergePullRequestPayload', { repo: decoded.repo, pull: decoded.pull } satisfies PullSource, sel ?? []);
    } catch (err) {
      if (err instanceof HttpError) ctx.errors.push({ message: err.message });
      else ctx.errors.push({ message: err instanceof Error ? err.message : 'mergePullRequest failed' });
      return null;
    }
  },
  addComment: (ctx, _source, args, sel) => {
    const input = record(args.input);
    const decoded = decodeGlobalId(str(input.subjectId));
    if (decoded === null || decoded.kind !== 'issue') {
      ctx.errors.push({ message: 'Could not resolve the subject for addComment' });
      return null;
    }
    const comment = { id: store.nextCommentId, body: str(input.body) };
    store.nextCommentId += 1;
    decoded.issue.comments.push(comment);
    return execObject(
      ctx,
      'AddCommentPayload',
      { repo: decoded.repo, issue: decoded.issue, comment },
      sel ?? [],
    );
  },
});

def('CreateIssuePayload', {
  issue: (ctx, source: IssueSource, _args, sel) => execObject(ctx, 'Issue', source, sel ?? []),
  clientMutationId: (_ctx, _source, _args) => null,
});
def('CloseIssuePayload', {
  issue: (ctx, source: IssueSource, _args, sel) => execObject(ctx, 'Issue', source, sel ?? []),
  clientMutationId: () => null,
});
def('CreatePullRequestPayload', {
  pullRequest: (ctx, source: PullSource, _args, sel) => execObject(ctx, 'PullRequest', source, sel ?? []),
  clientMutationId: () => null,
});
def('MergePullRequestPayload', {
  pullRequest: (ctx, source: PullSource, _args, sel) => execObject(ctx, 'PullRequest', source, sel ?? []),
  clientMutationId: () => null,
});
def('AddCommentPayload', {
  commentEdge: (ctx, source: { repo: RepoRec; issue: IssueRec; comment: { id: number; body: string } }, _args, sel) =>
    execObject(ctx, 'IssueCommentEdge', source, sel ?? []),
  clientMutationId: () => null,
});
def('IssueCommentEdge', {
  node: (ctx, source: { repo: RepoRec; issue: IssueRec; comment: { id: number; body: string } }, _args, sel) =>
    execObject(ctx, 'IssueComment', source, sel ?? []),
  cursor: () => null,
});

def('User', {
  login: (_ctx, source: { login: string }) => source.login,
  id: () => Buffer.from('U:1000', 'utf8').toString('base64'),
  name: () => VIEWER.name,
  email: () => VIEWER.email,
  databaseId: () => VIEWER.id,
  avatarUrl: () => '',
  url: () => '',
  isViewer: () => true,
});

def('Repository', {
  id: (_ctx, repo: RepoRec) => repoGlobalId(repo),
  databaseId: (_ctx, repo: RepoRec) => repo.id,
  name: (_ctx, repo: RepoRec) => repo.name,
  nameWithOwner: (_ctx, repo: RepoRec) => `${repo.owner}/${repo.name}`,
  owner: (ctx, repo: RepoRec, _args, sel) => execObject(ctx, 'User', { login: repo.owner }, sel ?? []),
  description: (_ctx, repo: RepoRec) => repo.description,
  isPrivate: (_ctx, repo: RepoRec) => repo.private,
  isFork: () => false,
  defaultBranchRef: (ctx, repo: RepoRec, _args, sel) =>
    repo.refs.has(repo.headRef) ? execObject(ctx, 'Ref', { name: repo.defaultBranch }, sel ?? []) : null,
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  hasPullRequestsEnabled: () => true,
  createdAt: () => '2025-01-01T00:00:00Z',
  updatedAt: () => '2025-01-01T00:00:00Z',
  url: (_ctx, repo: RepoRec) => `/${repo.owner}/${repo.name}`,
  stargazerCount: () => 0,
  forkCount: () => 0,
  issue: (ctx, repo: RepoRec, args, sel) => {
    const number = int(args.number);
    const issue = number === null ? undefined : repo.issues.get(number);
    return issue === undefined ? null : execObject(ctx, 'Issue', { repo, issue } satisfies IssueSource, sel ?? []);
  },
  issues: (ctx, repo: RepoRec, args, sel) => {
    let issues = repo.issueOrder.map((number) => repo.issues.get(number)!);
    const states = args.states;
    if (Array.isArray(states)) {
      const wanted = states.map((state) => str(state));
      issues = issues.filter((issue) => wanted.includes(issue.state.toUpperCase()));
    }
    const orderBy = record(args.orderBy);
    const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
    issues = [...issues].sort((a, b) => a.number - b.number);
    if (direction === 'DESC') issues.reverse();
    let start = 0;
    const after = args.after;
    if (typeof after === 'string' && after !== '') {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match !== null) {
        const index = issues.findIndex((issue) => issue.number === Number(match[1]));
        if (index !== -1) start = index + 1;
      }
    }
    const first = int(args.first);
    const page = first === null ? issues.slice(start) : issues.slice(start, start + Math.max(0, first));
    const hasNextPage = start + page.length < issues.length;
    const last = page[page.length - 1];
    const endCursor = last === undefined ? null : Buffer.from(`cursor:${last.number}`, 'utf8').toString('base64');
    const source = {
      nodes: page.map((issue) => ({ repo, issue }) satisfies IssueSource),
      pageInfo: { hasNextPage, endCursor, hasPreviousPage: start > 0, startCursor: endCursor },
      totalCount: issues.length,
    };
    return execObject(ctx, 'IssueConnection', source, sel ?? []);
  },
  pullRequest: (ctx, repo: RepoRec, args, sel) => {
    const number = int(args.number);
    const pull = number === null ? undefined : repo.pulls.get(number);
    return pull === undefined ? null : execObject(ctx, 'PullRequest', { repo, pull } satisfies PullSource, sel ?? []);
  },
  pullRequests: (ctx, repo: RepoRec, args, sel) => {
    let pulls = repo.pullOrder.map((number) => repo.pulls.get(number)!);
    const states = args.states;
    if (Array.isArray(states)) {
      const wanted = states.map((state) => str(state));
      pulls = pulls.filter((pull) => wanted.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
    }
    const first = int(args.first);
    const page = first === null ? pulls : pulls.slice(0, Math.max(0, first));
    const source = {
      nodes: page.map((pull) => ({ repo, pull }) satisfies PullSource),
      pageInfo: { hasNextPage: page.length < pulls.length, endCursor: null, hasPreviousPage: false, startCursor: null },
      totalCount: pulls.length,
    };
    return execObject(ctx, 'PullRequestConnection', source, sel ?? []);
  },
});

def('Issue', {
  id: (_ctx, source: IssueSource) => issueGlobalId(source.repo, source.issue),
  databaseId: (_ctx, source: IssueSource) => source.issue.id,
  number: (_ctx, source: IssueSource) => source.issue.number,
  title: (_ctx, source: IssueSource) => source.issue.title,
  body: (_ctx, source: IssueSource) => source.issue.body,
  state: (_ctx, source: IssueSource) => source.issue.state.toUpperCase(),
  author: (ctx, _source, _args, sel) => execObject(ctx, 'User', { login: VIEWER.login }, sel ?? []),
  repository: (ctx, source: IssueSource, _args, sel) => execObject(ctx, 'Repository', source.repo, sel ?? []),
  labels: (ctx, source: IssueSource, _args, sel) =>
    execObject(ctx, 'LabelConnection', { nodes: source.issue.labels.map((name) => ({ name })) }, sel ?? []),
  comments: () => null,
  createdAt: () => '2025-01-01T00:00:00Z',
  updatedAt: () => '2025-01-01T00:00:00Z',
  closedAt: (_ctx, source: IssueSource) => (source.issue.state === 'closed' ? '2025-01-01T00:00:00Z' : null),
  url: (_ctx, source: IssueSource) => `/${source.repo.owner}/${source.repo.name}/issues/${source.issue.number}`,
});

def('LabelConnection', {
  nodes: (ctx, source: { nodes: Array<{ name: string }> }, _args, sel) =>
    source.nodes.map((node) => execObject(ctx, 'Label', node, sel ?? [])),
  totalCount: (_ctx, source: { nodes: Array<{ name: string }> }) => source.nodes.length,
});
def('Label', {
  name: (_ctx, source: { name: string }) => source.name,
  id: (_ctx, source: { name: string }) => Buffer.from(`L:${source.name}`, 'utf8').toString('base64'),
});

def('PullRequest', {
  id: (_ctx, source: PullSource) => pullGlobalId(source.repo, source.pull),
  databaseId: (_ctx, source: PullSource) => source.pull.id,
  number: (_ctx, source: PullSource) => source.pull.number,
  title: (_ctx, source: PullSource) => source.pull.title,
  body: (_ctx, source: PullSource) => source.pull.body,
  state: (_ctx, source: PullSource) => (source.pull.merged ? 'MERGED' : source.pull.state.toUpperCase()),
  merged: (_ctx, source: PullSource) => source.pull.merged,
  mergedAt: (_ctx, source: PullSource) => source.pull.mergedAt,
  mergeable: (_ctx, source: PullSource) => planMerge(source.repo, source.pull).mergeable,
  headRefName: (_ctx, source: PullSource) => source.pull.headRef,
  baseRefName: (_ctx, source: PullSource) => source.pull.baseRef,
  headRef: (ctx, source: PullSource, _args, sel) => execObject(ctx, 'Ref', { name: source.pull.headRef }, sel ?? []),
  baseRef: (ctx, source: PullSource, _args, sel) => execObject(ctx, 'Ref', { name: source.pull.baseRef }, sel ?? []),
  author: (ctx, _source, _args, sel) => execObject(ctx, 'User', { login: VIEWER.login }, sel ?? []),
  repository: (ctx, source: PullSource, _args, sel) => execObject(ctx, 'Repository', source.repo, sel ?? []),
  files: (ctx, source: PullSource, args, sel) => {
    const changes = pullChanges(source.repo, source.pull);
    const first = int(args.first);
    const page = first === null ? changes : changes.slice(0, Math.max(0, first));
    const connSource = {
      nodes: page.map((change) => ({ path: change.path })),
      pageInfo: { hasNextPage: page.length < changes.length, endCursor: null, hasPreviousPage: false, startCursor: null },
      totalCount: changes.length,
    };
    return execObject(ctx, 'PullRequestChangedFileConnection', connSource, sel ?? []);
  },
  additions: (_ctx, source: PullSource) => pullChanges(source.repo, source.pull).length,
  deletions: () => 0,
  changedFiles: (_ctx, source: PullSource) => pullChanges(source.repo, source.pull).length,
  mergeCommit: () => null,
  createdAt: () => '2025-01-01T00:00:00Z',
  updatedAt: () => '2025-01-01T00:00:00Z',
  closedAt: (_ctx, source: PullSource) => (source.pull.state === 'closed' ? '2025-01-01T00:00:00Z' : null),
  url: (_ctx, source: PullSource) => `/${source.repo.owner}/${source.repo.name}/pull/${source.pull.number}`,
});

def('Ref', {
  name: (_ctx, source: { name: string }) => source.name,
  prefix: () => 'refs/heads/',
  id: (_ctx, source: { name: string }) => Buffer.from(`REF:${source.name}`, 'utf8').toString('base64'),
});

interface PageInfoSource {
  hasNextPage: boolean;
  endCursor: string | null;
  hasPreviousPage: boolean;
  startCursor: string | null;
}

def('PageInfo', {
  hasNextPage: (_ctx, source: PageInfoSource) => source.hasNextPage,
  hasPreviousPage: (_ctx, source: PageInfoSource) => source.hasPreviousPage,
  startCursor: (_ctx, source: PageInfoSource) => source.startCursor,
  endCursor: (_ctx, source: PageInfoSource) => source.endCursor,
});

interface ConnectionSource<N> {
  nodes: N[];
  pageInfo: PageInfoSource;
  totalCount: number;
}

def('IssueConnection', {
  nodes: (ctx, source: ConnectionSource<IssueSource>, _args, sel) =>
    source.nodes.map((node) => execObject(ctx, 'Issue', node, sel ?? [])),
  pageInfo: (ctx, source: ConnectionSource<IssueSource>, _args, sel) => execObject(ctx, 'PageInfo', source.pageInfo, sel ?? []),
  totalCount: (_ctx, source: ConnectionSource<IssueSource>) => source.totalCount,
});
def('PullRequestConnection', {
  nodes: (ctx, source: ConnectionSource<PullSource>, _args, sel) =>
    source.nodes.map((node) => execObject(ctx, 'PullRequest', node, sel ?? [])),
  pageInfo: (ctx, source: ConnectionSource<PullSource>, _args, sel) => execObject(ctx, 'PageInfo', source.pageInfo, sel ?? []),
  totalCount: (_ctx, source: ConnectionSource<PullSource>) => source.totalCount,
});
def('PullRequestChangedFileConnection', {
  nodes: (ctx, source: ConnectionSource<{ path: string }>, _args, sel) =>
    source.nodes.map((node) => execObject(ctx, 'PullRequestChangedFile', node, sel ?? [])),
  pageInfo: (ctx, source: ConnectionSource<{ path: string }>, _args, sel) => execObject(ctx, 'PageInfo', source.pageInfo, sel ?? []),
  totalCount: (_ctx, source: ConnectionSource<{ path: string }>) => source.totalCount,
});
def('PullRequestChangedFile', {
  path: (_ctx, source: { path: string }) => source.path,
  additions: () => 0,
  deletions: () => 0,
  changeType: () => 'MODIFIED',
});

def('IssueComment', {
  id: (_ctx, source: { repo: RepoRec; issue: IssueRec; comment: { id: number; body: string } }) =>
    commentGlobalId(source.repo, source.issue, source.comment),
  body: (_ctx, source: { comment: { body: string } }) => source.comment.body,
  databaseId: (_ctx, source: { comment: { id: number } }) => source.comment.id,
  author: (ctx, _source, _args, sel) => execObject(ctx, 'User', { login: VIEWER.login }, sel ?? []),
  createdAt: () => '2025-01-01T00:00:00Z',
});

def('__Type', {
  name: (_ctx, source: TypeDef) => source.name,
  kind: (_ctx, source: TypeDef) => source.kind,
  description: () => null,
  fields: (ctx, source: TypeDef, _args, sel) =>
    (source.fields ?? []).map((name) => execObject(ctx, '__Field', { name }, sel ?? [])),
  enumValues: (ctx, source: TypeDef, _args, sel) =>
    (source.enumValues ?? []).map((name) => execObject(ctx, '__EnumValue', { name }, sel ?? [])),
  possibleTypes: () => [],
  inputFields: () => [],
  ofType: () => null,
  interfaces: () => [],
  specifiedByURL: () => null,
  isOneOf: () => false,
});
def('__Field', {
  name: (_ctx, source: { name: string }) => source.name,
  description: () => null,
  args: () => [],
  type: () => null,
  isDeprecated: () => false,
  deprecationReason: () => null,
});
def('__EnumValue', {
  name: (_ctx, source: { name: string }) => source.name,
  description: () => null,
  isDeprecated: () => false,
  deprecationReason: () => null,
});
def('__Schema', {
  types: (ctx, source: { types: TypeDef[] }, _args, sel) => source.types.map((type) => execObject(ctx, '__Type', type, sel ?? [])),
  queryType: (ctx, _source, _args, sel) => execObject(ctx, '__Type', TYPE_DEFS.Query!, sel ?? []),
  mutationType: (ctx, _source, _args, sel) => execObject(ctx, '__Type', TYPE_DEFS.Mutation!, sel ?? []),
  subscriptionType: () => null,
  directives: () => [],
});

// ---------------------------------------------------------------------------------------------
// the endpoint
// ---------------------------------------------------------------------------------------------

interface OperationRequest {
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
}

function runOperation(request: OperationRequest): Record<string, unknown> {
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(request.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation =
    document.operations.find((candidate) => request.operationName === undefined || candidate.name === request.operationName) ??
    document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in the document' }] };
  const ctx: Ctx = { variables: request.variables, fragments: document.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = execObject(ctx, rootType, {}, operation.selectionSet);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

/** POST /api/graphql: one operation object, or a JSON array of them answered in order. */
export function handleGraphQL(bodyText: string): Answer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const operation = record(entry);
      return runOperation({
        query: str(operation.query),
        variables: record(operation.variables),
        operationName: typeof operation.operationName === 'string' ? operation.operationName : undefined,
      });
    });
    return { status: 200, body: results };
  }
  const operation = record(parsed);
  if (typeof operation.query !== 'string') {
    return { status: 400, body: { errors: [{ message: 'a GraphQL request needs a query string' }] } };
  }
  return {
    status: 200,
    body: runOperation({
      query: operation.query,
      variables: record(operation.variables),
      operationName: typeof operation.operationName === 'string' ? operation.operationName : undefined,
    }),
  };
}

// The forge's single in-memory store: repositories, their git objects and refs, and the
// issue / pull-request / label / comment records the REST, GraphQL and MCP surfaces share.
// One process lifetime is one trial, so nothing here persists to disk.
//
// The viewer (the login the bearer token names) is fixed by the contest's seeded scenario:
// wire.ts's SCENARIO_SEED is a contest constant, and buildScenario() derives this viewer from it.
// The token itself is only ever compared against the MAKEFUN_SHOP_TOKEN env value; the login it
// names is this one.

export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** A fixed epoch for server-made commits: deterministic timestamps, never a wall clock. */
export const COMMIT_EPOCH_SEC = 1_735_689_600;

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  /** REST numeric id (unique across the forge, stable). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  /** Branch tips captured at creation (base.sha is read back from this, per the rules). */
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
}

export interface RepoRec {
  /** The numeric database id (REST `id`, GraphQL `databaseId`). */
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  /** Full ref HEAD points at; fixed at refs/heads/<defaultBranch>. */
  headRef: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  issueOrder: number[];
  pulls: Map<number, PullRec>;
  pullOrder: number[];
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  /** Deterministic clock for server-made commits and merged_at stamps. */
  tick: number;
}

export interface Store {
  repos: Map<string, RepoRec>;
  nextRepoId: number;
  nextIssueId: number;
  nextCommentId: number;
  requestCounter: number;
}

export const store: Store = {
  repos: new Map(),
  nextRepoId: 1,
  nextIssueId: 1,
  nextCommentId: 1,
  requestCounter: 0,
};

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/**
 * Look up a repository as the token owner sees it: a repository under any other owner is
 * indistinguishable from a missing one (404, never 403).
 */
export function findRepo(owner: string, name: string): RepoRec | undefined {
  if (owner !== VIEWER.login) return undefined;
  return store.repos.get(repoKey(owner, name));
}

export function createRepo(name: string, init: { private?: boolean; description?: string }): RepoRec {
  const repo: RepoRec = {
    id: store.nextRepoId,
    owner: VIEWER.login,
    name,
    private: init.private ?? false,
    description: init.description ?? '',
    defaultBranch: 'main',
    headRef: 'refs/heads/main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    issueOrder: [],
    pulls: new Map(),
    pullOrder: [],
    nextNumber: 1,
    tick: 0,
  };
  store.nextRepoId += 1;
  store.repos.set(repoKey(repo.owner, name), repo);
  return repo;
}

export function deleteRepo(owner: string, name: string): boolean {
  if (owner !== VIEWER.login) return false;
  return store.repos.delete(repoKey(owner, name));
}

/** The viewer's repositories in creation order. */
export function listRepos(): RepoRec[] {
  return [...store.repos.values()].filter((repo) => repo.owner === VIEWER.login);
}

/** Advance a repo's deterministic clock and answer the commit timestamp for this tick. */
export function nextTimestamp(repo: RepoRec): number {
  repo.tick += 1;
  return COMMIT_EPOCH_SEC + repo.tick * 60;
}

/** An ISO timestamp on the same deterministic clock (for merged_at). */
export function isoOf(timestampSec: number): string {
  return new Date(timestampSec * 1000).toISOString();
}

// ---------------------------------------------------------------------------------------------
// GraphQL Relay-style global ids: opaque, stable, and never the plain database id.
// ---------------------------------------------------------------------------------------------

export function repoGlobalId(repo: RepoRec): string {
  return Buffer.from(`R:${repo.id}`, 'utf8').toString('base64');
}

export function issueGlobalId(repo: RepoRec, issue: IssueRec): string {
  return Buffer.from(`I:${repo.id}:${issue.number}`, 'utf8').toString('base64');
}

export function pullGlobalId(repo: RepoRec, pull: PullRec): string {
  return Buffer.from(`P:${repo.id}:${pull.number}`, 'utf8').toString('base64');
}

export function commentGlobalId(repo: RepoRec, issue: IssueRec, comment: CommentRec): string {
  return Buffer.from(`C:${repo.id}:${issue.number}:${comment.id}`, 'utf8').toString('base64');
}

export type DecodedGlobalId =
  | { kind: 'repo'; repo: RepoRec }
  | { kind: 'issue'; repo: RepoRec; issue: IssueRec }
  | { kind: 'pull'; repo: RepoRec; pull: PullRec }
  | { kind: 'comment'; repo: RepoRec; issue: IssueRec; comment: CommentRec }
  | null;

export function decodeGlobalId(id: string): DecodedGlobalId {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  const repoId = Number(parts[1]);
  if (!Number.isInteger(repoId)) return null;
  const repo = [...store.repos.values()].find((candidate) => candidate.id === repoId);
  if (repo === undefined) return null;
  if (parts[0] === 'R' && parts.length === 2) return { kind: 'repo', repo };
  if (parts[0] === 'I' && parts.length === 3) {
    const issue = repo.issues.get(Number(parts[2]));
    return issue === undefined ? null : { kind: 'issue', repo, issue };
  }
  if (parts[0] === 'P' && parts.length === 3) {
    const pull = repo.pulls.get(Number(parts[2]));
    return pull === undefined ? null : { kind: 'pull', repo, pull };
  }
  if (parts[0] === 'C' && parts.length === 4) {
    const issue = repo.issues.get(Number(parts[2]));
    const comment = issue?.comments.find((candidate) => candidate.id === Number(parts[3]));
    return issue === undefined || comment === undefined ? null : { kind: 'comment', repo, issue, comment };
  }
  return null;
}

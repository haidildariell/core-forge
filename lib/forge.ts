// The forge's domain operations, shared by the REST, GraphQL and MCP surfaces so an object
// created through one reads back identically through the others: contents commits on real
// branches, issue and pull-request records, pull-request file diffs, and the squash merge
// with its merge-base three-way path check.

import {
  VIEWER,
  isoOf,
  nextTimestamp,
  store,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import {
  buildCommit,
  diffFlat,
  flattenTree,
  isOid,
  mergeBase,
  parseCommit,
  putObject,
  threeWayMerge,
  treeFromFlat,
  type FileChange,
  type FlatEntry,
} from './gitobj.ts';
import { HttpError } from './http.ts';

// ---------------------------------------------------------------------------------------------
// refs and trees
// ---------------------------------------------------------------------------------------------

export function branchRef(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

export function shortBranch(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** Resolve a branch name, a full ref name or a commit sha to an oid, or null. */
export function resolveRef(repo: RepoRec, ref: string): string | null {
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch !== undefined) return asBranch;
  const asTag = repo.refs.get(`refs/tags/${ref}`);
  if (asTag !== undefined) return asTag;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  return null;
}

/** The tree oid of a commit oid, or null. */
export function commitTree(repo: RepoRec, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** The flattened file map of a commit (empty for an unknown commit). */
export function flatOfCommit(repo: RepoRec, commitOid: string): Map<string, FlatEntry> {
  const tree = commitTree(repo, commitOid);
  return tree === null ? new Map() : flattenTree(repo, tree);
}

function authorLine(timestamp: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${timestamp} +0000`;
}

/** Create a commit with the given tree on a branch and move the branch; answers the commit oid. */
export function commitOnBranch(repo: RepoRec, branch: string, treeOid: string, message: string): string {
  const ref = branchRef(branch);
  const tip = repo.refs.get(ref);
  const timestamp = nextTimestamp(repo);
  const line = authorLine(timestamp);
  const commit = buildCommit({
    tree: treeOid,
    parents: tip === undefined ? [] : [tip],
    author: line,
    committer: line,
    message,
  });
  const oid = putObject(repo, 'commit', commit);
  repo.refs.set(ref, oid);
  return oid;
}

// ---------------------------------------------------------------------------------------------
// contents (the REST contents API's commits)
// ---------------------------------------------------------------------------------------------

export interface FileChangeResult {
  commitSha: string;
  blobSha: string | null;
  existed: boolean;
}

/**
 * Write `content` at `path` on `branch` as a new commit (or delete the path when content is
 * null). The caller has already validated the sha precondition against the current blob.
 */
export function writeFile(
  repo: RepoRec,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): FileChangeResult {
  const ref = branchRef(branch);
  const tip = repo.refs.get(ref);
  const flat = tip === undefined ? new Map<string, FlatEntry>() : flatOfCommit(repo, tip);
  const existing = flat.get(path);
  let blobSha: string | null = null;
  if (content === null) {
    flat.delete(path);
  } else {
    blobSha = putObject(repo, 'blob', content);
    flat.set(path, { oid: blobSha, mode: existing?.mode ?? '100644' });
  }
  const tree = treeFromFlat(repo, flat);
  const commitSha = commitOnBranch(repo, branch, tree, message);
  return { commitSha, blobSha, existed: existing !== undefined };
}

/** The blob entry at `path` in the tree of `commitOid`, or null when absent. */
export function fileAt(repo: RepoRec, commitOid: string, path: string): FlatEntry | null {
  return flatOfCommit(repo, commitOid).get(path) ?? null;
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

export function createIssue(
  repo: RepoRec,
  input: { title: string; body?: string; labels?: string[] },
): IssueRec {
  for (const label of input.labels ?? []) {
    if (!repo.labels.has(label)) throw new HttpError(422, `Label "${label}" does not exist in this repository`);
  }
  const issue: IssueRec = {
    id: store.nextIssueId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...(input.labels ?? [])],
    comments: [],
  };
  store.nextIssueId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  repo.issueOrder.push(issue.number);
  return issue;
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

export function createPull(
  repo: RepoRec,
  input: { title: string; body?: string; head: string; base: string },
): PullRec {
  const headRef = branchRef(input.head);
  const baseRef = branchRef(input.base);
  const headSha = repo.refs.get(headRef);
  if (headSha === undefined) throw new HttpError(422, `Head branch "${shortBranch(headRef)}" does not exist`);
  const baseSha = repo.refs.get(baseRef);
  if (baseSha === undefined) throw new HttpError(422, `Base branch "${shortBranch(baseRef)}" does not exist`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === shortBranch(headRef) && existing.baseRef === shortBranch(baseRef)) {
      throw new HttpError(422, `A pull request already exists for ${shortBranch(headRef)} into ${shortBranch(baseRef)}`);
    }
  }
  const pull: PullRec = {
    id: store.nextIssueId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    headRef: shortBranch(headRef),
    baseRef: shortBranch(baseRef),
    headSha,
    baseSha,
    mergeCommitSha: null,
    mergedAt: null,
  };
  store.nextIssueId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  repo.pullOrder.push(pull.number);
  return pull;
}

/** The head commit a pull request currently points at (its branch tip, else the creation snapshot). */
export function pullHeadSha(repo: RepoRec, pull: PullRec): string {
  return repo.refs.get(branchRef(pull.headRef)) ?? pull.headSha;
}

/** The changed paths of a pull request, from its creation merge-base to its head snapshot. */
export function pullChanges(repo: RepoRec, pull: PullRec): FileChange[] {
  const base = mergeBase(repo, pull.baseSha, pull.headSha) ?? pull.baseSha;
  return diffFlat(flatOfCommit(repo, base), flatOfCommit(repo, pull.headSha));
}

export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

export interface MergePlan {
  mergeable: Mergeable;
  mergedTree: Map<string, FlatEntry> | null;
  baseTip: string | null;
  headTip: string | null;
}

/** Judge a pull request against the CURRENT base tip: the three-way path check of the rules. */
export function planMerge(repo: RepoRec, pull: PullRec): MergePlan {
  const baseTip = repo.refs.get(branchRef(pull.baseRef)) ?? null;
  const headTip = pullHeadSha(repo, pull);
  if (baseTip === null || repo.objects.get(headTip) === undefined) {
    return { mergeable: 'UNKNOWN', mergedTree: null, baseTip, headTip };
  }
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return { mergeable: 'UNKNOWN', mergedTree: null, baseTip, headTip };
  const result = threeWayMerge(flatOfCommit(repo, base), flatOfCommit(repo, baseTip), flatOfCommit(repo, headTip));
  if (result.conflicts.length > 0) return { mergeable: 'CONFLICTING', mergedTree: null, baseTip, headTip };
  return { mergeable: 'MERGEABLE', mergedTree: result.merged, baseTip, headTip };
}

/**
 * Squash-merge a pull request onto its base branch: one commit carrying the merged tree,
 * parented on the current base tip. Answers the merge commit sha. Throws HttpError 405 on a
 * conflict, 404-shaped errors are the caller's to produce before this runs.
 */
export function mergePull(repo: RepoRec, pull: PullRec): string {
  if (pull.merged) throw new HttpError(405, 'Pull Request has already been merged');
  if (pull.state !== 'open') throw new HttpError(405, 'Pull Request is not open');
  const plan = planMerge(repo, pull);
  if (plan.mergeable === 'CONFLICTING') throw new HttpError(405, 'Pull Request is not mergeable: conflicts must be resolved first');
  if (plan.mergeable !== 'MERGEABLE' || plan.mergedTree === null) {
    throw new HttpError(405, 'Pull Request is not mergeable');
  }
  const tree = treeFromFlat(repo, plan.mergedTree);
  const message = pull.body === '' ? pull.title : `${pull.title}\n\n${pull.body}`;
  const sha = commitOnBranch(repo, pull.baseRef, tree, message);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = isoOf(nextTimestamp(repo));
  return sha;
}

// ---------------------------------------------------------------------------------------------
// REST-shaped serializers (MCP tool results reuse them verbatim)
// ---------------------------------------------------------------------------------------------

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${repo.owner}/${repo.name}`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments: issue.comments.length,
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: pullHeadSha(repo, pull), label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id },
  };
}

/** Count text lines the way the pull-files counts need: a trailing newline ends the last line. */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

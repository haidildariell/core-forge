// The REST v3 surface under /api/v3: the API root and meta, the viewer's repositories with
// Link-header pagination, branches, git refs, commits, the contents API (real commits on
// real branches), labels, issues with comments, and pull requests with squash merges.
// Authentication and the JSON discipline (content type, X-GitHub-Request-Id, {message}
// errors) live in app.ts; a repository under another owner is a 404 here, never a 403.

import { VIEWER, findRepo, createRepo as storeCreateRepo, deleteRepo, listRepos, store, type RepoRec } from './store.ts';
import { parseCommit, parseTree, peelToCommit } from './gitobj.ts';
import {
  branchRef,
  commitTree,
  countLines,
  createIssue,
  createPull,
  fileAt,
  issueJson,
  mergePull,
  pullChanges,
  pullJson,
  repoJson,
  resolveRef,
  shortBranch,
  writeFile,
} from './forge.ts';
import { HttpError, boolField, stringField, stringListField, type Answer, type Call } from './http.ts';

const NOT_FOUND = 'Not Found';

function repoOr404(owner: string, name: string): RepoRec {
  const repo = findRepo(owner, name);
  if (repo === undefined) throw new HttpError(404, NOT_FOUND);
  return repo;
}

function intParam(call: Call, name: string, fallback: number): number {
  const raw = call.query.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

/** Slice a list by per_page/page and build the Link header set for the pages that exist. */
function paginate<T>(call: Call, items: readonly T[], path: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(100, intParam(call, 'per_page', 30));
  const page = intParam(call, 'page', 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const url = (p: number): string => `http://${call.host}${path}?per_page=${perPage}&page=${p}`;
  if (page < lastPage) links.push(`<${url(page + 1)}>; rel="next"`, `<${url(lastPage)}>; rel="last"`);
  if (page > 1) links.push(`<${url(1)}>; rel="first"`, `<${url(page - 1)}>; rel="prev"`);
  if (links.length > 0) headers.link = links.join(', ');
  return { page: slice, headers };
}

// ---------------------------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------------------------

function createRepository(call: Call): Answer {
  const body = call.json();
  const name = stringField(body, 'name');
  if (name === undefined || name === '') throw new HttpError(422, 'Repository creation failed: name is required');
  if (findRepo(VIEWER.login, name) !== undefined) {
    throw new HttpError(422, `Repository creation failed: a repository named "${name}" already exists on this account`);
  }
  const repo = storeCreateRepo(name, {
    private: boolField(body, 'private') ?? false,
    description: stringField(body, 'description') ?? '',
  });
  return { status: 201, body: repoJson(repo) };
}

function getRepository(repo: RepoRec): Answer {
  return { status: 200, body: repoJson(repo) };
}

function patchRepository(call: Call, repo: RepoRec): Answer {
  const body = call.json();
  const description = stringField(body, 'description');
  if (description !== undefined) repo.description = description;
  const priv = boolField(body, 'private');
  if (priv !== undefined) repo.private = priv;
  const name = stringField(body, 'name');
  if (name !== undefined && name !== '' && name !== repo.name) {
    // A rename moves the store key; nothing in the suite renames, but keep the map honest.
    deleteRepo(repo.owner, repo.name);
    repo.name = name;
    store.repos.set(`${repo.owner}/${name}`, repo);
  }
  return { status: 200, body: repoJson(repo) };
}

function deleteRepository(repo: RepoRec): Answer {
  deleteRepo(repo.owner, repo.name);
  return { status: 204 };
}

// ---------------------------------------------------------------------------------------------
// branches, refs, commits
// ---------------------------------------------------------------------------------------------

function listBranches(repo: RepoRec): Answer {
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => ({ name: shortBranch(ref), commit: { sha }, protected: false }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { status: 200, body: branches };
}

function getBranch(repo: RepoRec, branch: string): Answer {
  const sha = repo.refs.get(branchRef(branch));
  if (sha === undefined) throw new HttpError(404, 'Branch not found');
  return { status: 200, body: { name: shortBranch(branchRef(branch)), commit: { sha }, protected: false } };
}

function getGitRef(repo: RepoRec, refParts: string[]): Answer {
  const ref = `refs/${refParts.join('/')}`;
  const sha = repo.refs.get(ref);
  if (sha === undefined) throw new HttpError(404, NOT_FOUND);
  const object = repo.objects.get(sha);
  return { status: 200, body: { ref, object: { type: object?.type ?? 'commit', sha } } };
}

function createGitRef(call: Call, repo: RepoRec): Answer {
  const body = call.json();
  const ref = stringField(body, 'ref');
  const sha = stringField(body, 'sha');
  if (ref === undefined || !ref.startsWith('refs/')) throw new HttpError(422, 'ref is required and must start with refs/');
  if (sha === undefined || !repo.objects.has(sha)) throw new HttpError(422, 'sha does not name an object in this repository');
  if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  const object = repo.objects.get(sha)!;
  return { status: 201, body: { ref, object: { type: object.type, sha } } };
}

function identityOf(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
}

function listCommits(call: Call, repo: RepoRec): Answer {
  const ref = call.query.get('sha') ?? repo.defaultBranch;
  const start = resolveRef(repo, ref);
  if (start === null) return { status: 200, body: [] };
  const tip = peelToCommit(repo, start) ?? start;
  const perPage = Math.min(100, intParam(call, 'per_page', 30));
  const seen = new Set<string>();
  const commits: Array<Record<string, unknown>> = [];
  const stack = [tip];
  while (stack.length > 0 && commits.length < perPage) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    commits.push({
      sha: oid,
      commit: {
        message: commit.message,
        author: identityOf(commit.author),
        committer: identityOf(commit.committer),
        tree: { sha: commit.tree },
      },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    });
    // Push parents reversed so the first parent is visited first (newest-first listing).
    for (let index = commit.parents.length - 1; index >= 0; index -= 1) stack.push(commit.parents[index]!);
  }
  return { status: 200, body: commits };
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

interface TreeLookup {
  kind: 'file' | 'dir';
  oid: string;
  mode: string;
}

function lookupPath(repo: RepoRec, treeOid: string, path: string): TreeLookup | null {
  if (path === '') return { kind: 'dir', oid: treeOid, mode: '40000' };
  const segments = path.split('/');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid, mode: entry.mode } : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function getContents(call: Call, repo: RepoRec, path: string): Answer {
  const ref = call.query.get('ref') ?? repo.defaultBranch;
  const start = resolveRef(repo, ref);
  if (start === null) throw new HttpError(404, NOT_FOUND);
  const commitOid = peelToCommit(repo, start) ?? start;
  const tree = commitTree(repo, commitOid);
  if (tree === null) throw new HttpError(404, NOT_FOUND);
  const found = lookupPath(repo, tree, path);
  if (found === null) throw new HttpError(404, NOT_FOUND);
  if (found.kind === 'file') {
    const blob = repo.objects.get(found.oid);
    if (blob === undefined) throw new HttpError(404, NOT_FOUND);
    const name = path.split('/').pop() ?? path;
    return {
      status: 200,
      body: {
        type: 'file',
        name,
        path,
        sha: found.oid,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
      },
    };
  }
  const treeObject = repo.objects.get(found.oid);
  if (treeObject === undefined || treeObject.type !== 'tree') throw new HttpError(404, NOT_FOUND);
  const entries = parseTree(treeObject.data)
    .map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { status: 200, body: entries };
}

function putContents(call: Call, repo: RepoRec, path: string): Answer {
  const body = call.json();
  const content64 = stringField(body, 'content');
  if (content64 === undefined) throw new HttpError(422, 'content is required');
  const message = stringField(body, 'message') ?? `Update ${path}`;
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const givenSha = stringField(body, 'sha');
  const tip = repo.refs.get(branchRef(branch));
  const current = tip === undefined ? null : fileAt(repo, tip, path);
  if (current !== null) {
    if (givenSha === undefined) throw new HttpError(422, '"sha" wasn\'t supplied');
    if (givenSha !== current.oid) throw new HttpError(409, `${path} has changed since the sha was read; fetch the latest version`);
  } else if (givenSha !== undefined) {
    throw new HttpError(409, `${path} does not exist yet, so the supplied sha cannot match`);
  }
  const content = Buffer.from(content64, 'base64');
  const result = writeFile(repo, branch, path, content, message);
  return {
    status: result.existed ? 200 : 201,
    body: {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: result.blobSha,
        size: content.length,
        encoding: 'base64',
      },
      commit: { sha: result.commitSha },
    },
  };
}

function deleteContents(call: Call, repo: RepoRec, path: string): Answer {
  const body = call.json();
  const message = stringField(body, 'message') ?? `Delete ${path}`;
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const givenSha = stringField(body, 'sha');
  const tip = repo.refs.get(branchRef(branch));
  const current = tip === undefined ? null : fileAt(repo, tip, path);
  if (current === null) throw new HttpError(404, NOT_FOUND);
  if (givenSha === undefined) throw new HttpError(422, '"sha" wasn\'t supplied');
  if (givenSha !== current.oid) throw new HttpError(409, `${path} has changed since the sha was read`);
  const result = writeFile(repo, branch, path, null, message);
  return { status: 200, body: { content: null, commit: { sha: result.commitSha } } };
}

// ---------------------------------------------------------------------------------------------
// labels, issues, comments
// ---------------------------------------------------------------------------------------------

function createLabel(call: Call, repo: RepoRec): Answer {
  const body = call.json();
  const name = stringField(body, 'name');
  if (name === undefined || name === '') throw new HttpError(422, 'Label name is required');
  if (repo.labels.has(name)) throw new HttpError(422, `A label named "${name}" already exists`);
  const color = stringField(body, 'color') ?? 'ededed';
  repo.labels.set(name, { name, color });
  return { status: 201, body: { name, color } };
}

function createIssueRoute(call: Call, repo: RepoRec): Answer {
  const body = call.json();
  const title = stringField(body, 'title');
  if (title === undefined || title === '') throw new HttpError(422, 'Issue title is required');
  const issue = createIssue(repo, {
    title,
    body: stringField(body, 'body') ?? '',
    labels: stringListField(body, 'labels') ?? [],
  });
  return { status: 201, body: issueJson(repo, issue) };
}

function listIssues(call: Call, repo: RepoRec): Answer {
  const state = call.query.get('state') ?? 'open';
  const direction = call.query.get('direction') ?? 'desc';
  let issues = repo.issueOrder.map((number) => repo.issues.get(number)!);
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  issues = [...issues].sort((a, b) => a.number - b.number);
  if (direction !== 'asc') issues.reverse();
  const { page, headers } = paginate(call, issues, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
  return { status: 200, body: page.map((issue) => issueJson(repo, issue)), headers };
}

function issueOr404(repo: RepoRec, number: number) {
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new HttpError(404, 'Issue not found');
  return issue;
}

function patchIssue(call: Call, repo: RepoRec, number: number): Answer {
  const issue = issueOr404(repo, number);
  const body = call.json();
  const state = stringField(body, 'state');
  if (state === 'open' || state === 'closed') issue.state = state;
  const title = stringField(body, 'title');
  if (title !== undefined) issue.title = title;
  const text = stringField(body, 'body');
  if (text !== undefined) issue.body = text;
  const labels = stringListField(body, 'labels');
  if (labels !== undefined) {
    for (const label of labels) {
      if (!repo.labels.has(label)) throw new HttpError(422, `Label "${label}" does not exist in this repository`);
    }
    issue.labels = labels;
  }
  return { status: 200, body: issueJson(repo, issue) };
}

function createComment(call: Call, repo: RepoRec, number: number): Answer {
  const issue = issueOr404(repo, number);
  const body = call.json();
  const text = stringField(body, 'body');
  if (text === undefined) throw new HttpError(422, 'Comment body is required');
  const comment = { id: store.nextCommentId, body: text };
  store.nextCommentId += 1;
  issue.comments.push(comment);
  return { status: 201, body: { id: comment.id, body: comment.body } };
}

function listComments(repo: RepoRec, number: number): Answer {
  const issue = issueOr404(repo, number);
  return { status: 200, body: issue.comments.map((comment) => ({ id: comment.id, body: comment.body })) };
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function createPullRoute(call: Call, repo: RepoRec): Answer {
  const body = call.json();
  const title = stringField(body, 'title');
  const head = stringField(body, 'head');
  const base = stringField(body, 'base');
  if (title === undefined || title === '') throw new HttpError(422, 'Pull request title is required');
  if (head === undefined || head === '') throw new HttpError(422, 'Pull request head is required');
  if (base === undefined || base === '') throw new HttpError(422, 'Pull request base is required');
  const pull = createPull(repo, { title, body: stringField(body, 'body') ?? '', head, base });
  return { status: 201, body: pullJson(repo, pull) };
}

function listPulls(call: Call, repo: RepoRec): Answer {
  const state = call.query.get('state') ?? 'open';
  let pulls = repo.pullOrder.map((number) => repo.pulls.get(number)!);
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  const { page, headers } = paginate(call, pulls, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
  return { status: 200, body: page.map((pull) => pullJson(repo, pull)), headers };
}

function pullOr404(repo: RepoRec, number: number) {
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new HttpError(404, 'Pull Request not found');
  return pull;
}

function pullFiles(repo: RepoRec, number: number): Answer {
  const pull = pullOr404(repo, number);
  const files = pullChanges(repo, pull).map((change) => {
    const oldData = change.oldOid === null ? null : (repo.objects.get(change.oldOid)?.data ?? null);
    const newData = change.newOid === null ? null : (repo.objects.get(change.newOid)?.data ?? null);
    const additions = change.status === 'removed' ? 0 : newData === null ? 0 : countLines(newData);
    const deletions = change.status === 'added' ? 0 : oldData === null ? 0 : countLines(oldData);
    return {
      filename: change.path,
      status: change.status,
      additions,
      deletions,
      changes: additions + deletions,
    };
  });
  return { status: 200, body: files };
}

function mergePullRoute(repo: RepoRec, number: number): Answer {
  const pull = pullOr404(repo, number);
  const sha = mergePull(repo, pull);
  return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

export function handleRest(call: Call, segments: readonly string[]): Answer {
  const [first, second, third, ...rest] = segments;

  if (first === undefined || first === '') {
    if (call.method !== 'GET') throw new HttpError(404, NOT_FOUND);
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues?q={query}',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (first === 'meta' && segments.length === 1) {
    if (call.method !== 'GET') throw new HttpError(404, NOT_FOUND);
    return { status: 200, body: { installed_version: '3.10.0', github_hostname: 'forge.local' } };
  }

  if (first === 'user' && segments.length === 1) {
    if (call.method !== 'GET') throw new HttpError(404, NOT_FOUND);
    return { status: 200, body: { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' } };
  }

  if (first === 'user' && second === 'repos' && segments.length === 2) {
    if (call.method === 'GET') {
      const { page, headers } = paginate(call, listRepos(), '/api/v3/user/repos');
      return { status: 200, body: page.map((repo) => repoJson(repo)), headers };
    }
    if (call.method === 'POST') return createRepository(call);
    throw new HttpError(404, NOT_FOUND);
  }

  if (first === 'repos' && second !== undefined && third !== undefined) {
    const repo = repoOr404(second, third);
    if (rest.length === 0) {
      if (call.method === 'GET') return getRepository(repo);
      if (call.method === 'PATCH') return patchRepository(call, repo);
      if (call.method === 'DELETE') return deleteRepository(repo);
      throw new HttpError(404, NOT_FOUND);
    }
    const [area, ...tail] = rest;
    switch (area) {
      case 'branches':
        if (call.method === 'GET' && tail.length === 0) return listBranches(repo);
        if (call.method === 'GET') return getBranch(repo, tail.join('/'));
        break;
      case 'git':
        if (tail[0] === 'refs' && tail.length === 1 && call.method === 'POST') return createGitRef(call, repo);
        if (tail[0] === 'refs' && tail.length > 1 && call.method === 'GET') return getGitRef(repo, tail.slice(1));
        break;
      case 'commits':
        if (call.method === 'GET' && tail.length === 0) return listCommits(call, repo);
        break;
      case 'contents': {
        const path = tail.join('/');
        if (call.method === 'GET') return getContents(call, repo, path);
        if (call.method === 'PUT') return putContents(call, repo, path);
        if (call.method === 'DELETE') return deleteContents(call, repo, path);
        break;
      }
      case 'labels':
        if (call.method === 'POST' && tail.length === 0) return createLabel(call, repo);
        if (call.method === 'GET' && tail.length === 0) {
          return { status: 200, body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })) };
        }
        break;
      case 'issues':
        if (tail.length === 0) {
          if (call.method === 'GET') return listIssues(call, repo);
          if (call.method === 'POST') return createIssueRoute(call, repo);
        } else if (tail.length === 1) {
          const number = Number(tail[0]);
          if (call.method === 'GET') return { status: 200, body: issueJson(repo, issueOr404(repo, number)) };
          if (call.method === 'PATCH') return patchIssue(call, repo, number);
        } else if (tail.length === 2 && tail[1] === 'comments') {
          const number = Number(tail[0]);
          if (call.method === 'GET') return listComments(repo, number);
          if (call.method === 'POST') return createComment(call, repo, number);
        }
        break;
      case 'pulls':
        if (tail.length === 0) {
          if (call.method === 'GET') return listPulls(call, repo);
          if (call.method === 'POST') return createPullRoute(call, repo);
        } else if (tail.length === 1) {
          const number = Number(tail[0]);
          if (call.method === 'GET') return { status: 200, body: pullJson(repo, pullOr404(repo, number)) };
        } else if (tail.length === 2 && tail[1] === 'files') {
          if (call.method === 'GET') return pullFiles(repo, Number(tail[0]));
        } else if (tail.length === 2 && tail[1] === 'merge') {
          if (call.method === 'PUT') return mergePullRoute(repo, Number(tail[0]));
        }
        break;
      default:
        break;
    }
    throw new HttpError(404, NOT_FOUND);
  }

  throw new HttpError(404, NOT_FOUND);
}

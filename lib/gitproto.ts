// Smart HTTP for git: GET /info/refs advertisements (protocol v2 and v0), the v2 ls-refs and
// fetch commands, the v0 fetch fallback with side-band-64k, and v0 receive-pack with
// fast-forward enforcement and report-status. Repositories arrive here already resolved
// (a missing repository is a 404 at the router, before any of this runs).

import type { GitObject, RepoRec } from './store.ts';
import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  readPack,
  writePack,
} from './gitobj.ts';
import { FLUSH_PKT, PktReader, pktLine, readUntilFlush } from './pktline.ts';

export const AGENT = 'makefun-forge/1.0.0';
const UPLOAD_CAPS_V0 = `multi_ack_detailed side-band-64k thin-pack ofs-delta no-progress agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
const SIDEBAND_CHUNK = 32768;

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function sortedRefNames(repo: RepoRec): string[] {
  return [...repo.refs.keys()].sort();
}

/** The oid a ref peels to (for annotated tags in advertisements and ls-refs), or null. */
function peeledOf(repo: RepoRec, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelToCommit(repo, oid);
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

export function infoRefs(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack', wantsV2: boolean): GitResponse {
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && wantsV2) {
    const lines = [
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow filter\n',
      'object-format=sha1\n',
    ];
    return { status: 200, contentType, body: Buffer.concat([...lines.map((line) => pktLine(line)), FLUSH_PKT]) };
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const headOid = repo.refs.get(repo.headRef);
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
      first = false;
    }
    for (const name of names) {
      const oid = repo.refs.get(name)!;
      parts.push(pktLine(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
      first = false;
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(FLUSH_PKT);
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// fetch planning (shared by v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  deepen: number | null;
  deepenSince: number | null;
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  common: string | null;
}

function treeClosureInto(repo: RepoRec, treeOid: string, have: ReadonlySet<string>, out: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid) || have.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
}

/**
 * The object closure of the client's haves, honouring its shallow boundary: a commit the
 * client holds shallowly contributes itself and its trees/blobs, but NOT its parents —
 * the whole point of the deepen checks is that those parents are what the client lacks.
 */
function haveClosureOf(repo: RepoRec, haves: readonly string[], clientShallow: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!clientShallow.has(oid)) stack.push(...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

function planFetch(repo: RepoRec, request: FetchRequest): FetchPlan {
  const wants = request.wants.filter((oid) => repo.objects.has(oid));
  const haveClosure = haveClosureOf(repo, request.haves, new Set(request.clientShallow));
  let common: string | null = null;
  for (const have of request.haves) {
    if (!repo.objects.has(have)) continue;
    const haveCommit = peelToCommit(repo, have);
    if (haveCommit === null) {
      common = have;
      break;
    }
    const touches = wants.some((want) => {
      const wantCommit = peelToCommit(repo, want);
      return wantCommit !== null && (wantCommit === haveCommit || isAncestor(repo, haveCommit, wantCommit));
    });
    if (touches) {
      common = have;
      break;
    }
  }

  const depthMode = request.deepen !== null || request.deepenSince !== null || request.clientShallow.length > 0;
  if (!depthMode) {
    const send = new Set<string>();
    for (const want of wants) {
      for (const oid of collectReachable(repo, [want])) {
        if (!haveClosure.has(oid)) send.add(oid);
      }
    }
    return { objects: [...send].map((oid) => repo.objects.get(oid)!), shallow: [], unshallow: [], common };
  }

  // Depth-limited fetch: BFS over commits from the wants; a commit's depth is its edge
  // distance from the nearest want, plus one. Trees and blobs ride with their commit.
  const limit = request.deepen ?? Number.POSITIVE_INFINITY;
  const clientShallow = new Set(request.clientShallow);
  const depthOf = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  const extraObjects = new Set<string>();
  for (const want of wants) {
    const commit = peelToCommit(repo, want);
    if (commit === null) {
      if (!haveClosure.has(want)) extraObjects.add(want);
      continue;
    }
    if (want !== commit && !haveClosure.has(want)) extraObjects.add(want);
    queue.push([commit, 1]);
  }
  const since = request.deepenSince;
  const included = new Set<string>();
  while (queue.length > 0) {
    const [oid, depth] = queue.shift()!;
    if (depthOf.has(oid) && depthOf.get(oid)! <= depth) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (since !== null) {
      const match = / (\d+) [+-]\d{4}/.exec(parseCommit(object.data).committer);
      const stamp = match === null ? 0 : Number(match[1]);
      if (stamp < since && depth > 1) continue;
    }
    depthOf.set(oid, depth);
    if (depth > limit) continue;
    included.add(oid);
    if (clientShallow.has(oid) && request.deepen === null && since === null) continue; // held boundary stays a boundary
    for (const parent of parseCommit(object.data).parents) queue.push([parent, depth + 1]);
  }
  const send = new Set<string>(extraObjects);
  const boundary: string[] = [];
  const unshallow: string[] = [];
  for (const oid of included) {
    const commit = parseCommit(repo.objects.get(oid)!.data);
    const parentsIncluded = commit.parents.every((parent) => included.has(parent));
    const isBoundary = commit.parents.length > 0 && !parentsIncluded;
    if (isBoundary) boundary.push(oid);
    if (clientShallow.has(oid) && !isBoundary) unshallow.push(oid);
    if (haveClosure.has(oid)) continue;
    send.add(oid);
    treeClosureInto(repo, commit.tree, haveClosure, send);
  }
  return {
    objects: [...send].map((oid) => repo.objects.get(oid)!),
    shallow: boundary,
    unshallow,
    common,
  };
}

/** Frame pack bytes as band-1 sideband packets of at most SIDEBAND_CHUNK payload bytes. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

function buildPack(plan: FetchPlan): Buffer {
  return writePack(plan.objects);
}

// ---------------------------------------------------------------------------------------------
// protocol v2 commands (ls-refs, fetch)
// ---------------------------------------------------------------------------------------------

function lsRefs(repo: RepoRec, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headTarget = repo.headRef;
  const headOid = repo.refs.get(headTarget);
  if (symrefs && matches('HEAD')) {
    if (headOid !== undefined) lines.push(`${headOid} HEAD symref-target:${headTarget}\n`);
    else if (unborn) lines.push(`unborn HEAD symref-target:${headTarget}\n`);
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return Buffer.concat([...lines.map((line) => pktLine(line)), FLUSH_PKT]);
}

function parseFetchArgs(args: readonly string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], clientShallow: [], deepen: null, deepenSince: null };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen-since ')) request.deepenSince = Number(arg.slice(13).trim());
    else if (arg.startsWith('deepen-not ')) {
      // A deepen-not ref excludes its history; approximated by treating it as a have.
      request.haves.push(arg.slice(11).trim());
    } else if (arg.startsWith('deepen ')) request.deepen = Number(arg.slice(7).trim());
  }
  return request;
}

function fetchV2(repo: RepoRec, args: readonly string[]): Buffer {
  const request = parseFetchArgs(args);
  const plan = planFetch(repo, request);
  const pack = buildPack(plan);
  const parts: Buffer[] = [];
  if (request.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine(plan.common !== null ? `ACK ${plan.common}\n` : 'NAK\n'));
    parts.push(pktLine('ready\n'));
    parts.push(FLUSH_PKT);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH_PKT);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// protocol v0 fetch
// ---------------------------------------------------------------------------------------------

function fetchV0(repo: RepoRec, body: Buffer, reader: PktReader): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen: number | null = null;
  let deepenSince: number | null = null;
  let multiAckDetailed = false;
  // First section: want lines (the first carries the capabilities), ended by a flush.
  const wantLines = readUntilFlush(reader);
  wantLines.forEach((lineBuffer, index) => {
    let line = lineBuffer.toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        const caps = line.slice(nul + 1);
        if (caps.includes('multi_ack_detailed')) multiAckDetailed = true;
        line = line.slice(0, nul);
      }
    }
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
  });
  // Second section: shallow/deepen lines, haves and done, ended by a flush.
  const rest = readUntilFlush(reader);
  for (const lineBuffer of rest) {
    const line = lineBuffer.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen-since ')) deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim());
  }
  const plan = planFetch(repo, { wants, haves, clientShallow, deepen, deepenSince });
  const pack = buildPack(plan);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.common !== null) parts.push(pktLine(multiAckDetailed ? `ACK ${plan.common} ready\n` : `ACK ${plan.common}\n`));
  else parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack POST (v2 commands or v0 want/have)
// ---------------------------------------------------------------------------------------------

export function uploadPack(repo: RepoRec, body: Buffer, wantsV2: boolean): GitResponse {
  const contentType = 'application/x-git-upload-pack-result';
  let reader: PktReader;
  try {
    reader = new PktReader(body);
  } catch {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('bad request\n') };
  }
  try {
    if (wantsV2) {
      // command line, capability lines, a delimiter, then argument lines to a flush.
      const head: string[] = [];
      for (;;) {
        const packet = reader.next();
        if (packet === null || packet.kind === 'flush') break;
        if (packet.kind === 'delim') break;
        head.push(packet.payload.toString('utf8').replace(/\n$/, ''));
      }
      const command = head.find((line) => line.startsWith('command='));
      const args = readUntilFlush(reader).map((line) => line.toString('utf8').replace(/\n$/, ''));
      if (command === 'command=ls-refs') return { status: 200, contentType, body: lsRefs(repo, args) };
      if (command === 'command=fetch') return { status: 200, contentType, body: fetchV2(repo, args) };
      return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('unknown command\n') };
    }
    return { status: 200, contentType, body: fetchV0(repo, body, reader) };
  } catch {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('bad request\n') };
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack POST (v0)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(repo: RepoRec, body: Buffer): GitResponse {
  const contentType = 'application/x-git-receive-pack-result';
  let reader: PktReader;
  try {
    reader = new PktReader(body);
  } catch {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('bad request\n') };
  }
  let commandLines: Buffer[];
  try {
    commandLines = readUntilFlush(reader);
  } catch {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('bad request\n') };
  }
  const commands: PushCommand[] = [];
  let caps = '';
  commandLines.forEach((lineBuffer, index) => {
    let line = lineBuffer.toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length === 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  });
  const reportStatus = caps.includes('report-status');
  const sideband = caps.includes('side-band-64k');

  let unpackError: string | null = null;
  const pack = reader.rest;
  if (pack.length > 0) {
    try {
      const parsed = readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, object] of parsed.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'pack parse error';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    const succeed = (): void => {
      results.push({ ref: command.ref, ok: true, reason: '' });
    };
    if (unpackError !== null) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // delete
      if (current === undefined) fail('reference not found');
      else if (current !== command.oldOid) fail('stale info');
      else {
        repo.refs.delete(command.ref);
        succeed();
      }
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (newObject === undefined) {
      fail('missing object');
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        fail('stale info');
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      succeed();
      continue;
    }
    if (current !== command.oldOid) {
      fail('stale info');
      continue;
    }
    if (current === command.newOid) {
      succeed();
      continue;
    }
    // update: enforce fast-forward on the commit graph (tags peel to their commit).
    const oldCommit = peelToCommit(repo, command.oldOid);
    const newCommit = peelToCommit(repo, command.newOid);
    if (oldCommit === null || newCommit === null || !isAncestor(repo, oldCommit, newCommit)) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    succeed();
  }

  if (!reportStatus) return { status: 200, contentType, body: Buffer.alloc(0) };
  const reportLines = [
    unpackError !== null ? `unpack ${unpackError}\n` : 'unpack ok\n',
    ...results.map((result) => (result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`)),
  ];
  const parts: Buffer[] = [];
  if (sideband) {
    // The report is one pkt-line stream (lines + its own flush) carried inside band-1
    // packets, then a raw flush closes the outer stream — exactly git receive-pack's
    // framing; without the inner flush a real client's report parser hits EOF and the
    // push "hangs up" even though every ref landed.
    const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), FLUSH_PKT]);
    parts.push(...sidebandPackets(inner));
  } else {
    for (const line of reportLines) parts.push(pktLine(line));
  }
  parts.push(FLUSH_PKT);
  return { status: 200, contentType, body: Buffer.concat(parts) };
}


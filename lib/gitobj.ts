// The git object layer: SHA-1 addressed blobs/trees/commits/tags, pack reading (with ofs-delta
// and ref-delta application) and writing (plain objects, no deltas), reachability walks,
// merge-base, tree flatten/diff and the three-way tree merge the pull-request surface uses.
// Standard library only: node:crypto for SHA-1, node:zlib for pack streams.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, RepoRec } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const OBJECT_TYPES: readonly GitObjectType[] = ['commit', 'tree', 'blob', 'tag'];
const TYPE_TO_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Readonly<Record<number, GitObjectType | undefined>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object (idempotent) and answer its id. */
export function putObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: names compare byte-wise, directories as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`, '', info.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Follow tag objects until a commit; null when the chain breaks or does not end at a commit. */
export function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/** Every object reachable from the tips (commits, their trees and blobs, tags), tips included. */
export function collectReachable(repo: RepoRec, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Commit-only ancestry: the tip and every commit reachable through parent links. */
export function commitAncestors(repo: RepoRec, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    stack.push(...parseCommit(object.data).parents);
  }
  return seen;
}

export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitAncestors(repo, descendant).has(ancestor);
}

/** A best common ancestor of two commits (BFS from both sides), or null for unrelated roots. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, depth] = queueA.shift()!;
    if (fromA.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    fromA.set(oid, depth);
    for (const parent of parseCommit(object.data).parents) queueA.push([parent, depth + 1]);
  }
  const visited = new Set<string>();
  const queueB: string[] = [b];
  while (queueB.length > 0) {
    const oid = queueB.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    if (fromA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    queueB.push(...parseCommit(object.data).parents);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// flattened trees, diffs and three-way merges
// ---------------------------------------------------------------------------------------------

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** path -> blob entry for every file under a tree (recursive). */
export function flattenTree(repo: RepoRec, treeOid: string): Map<string, FlatEntry> {
  const flat = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else flat.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return flat;
}

/** Rebuild nested tree objects from a flattened path map; answers the root tree oid. */
export function treeFromFlat(repo: RepoRec, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** The per-path difference between two flattened trees. */
export function diffFlat(
  base: ReadonlyMap<string, FlatEntry>,
  head: ReadonlyMap<string, FlatEntry>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before === undefined && after !== undefined) changes.push({ path, status: 'added', oldOid: null, newOid: after.oid });
    else if (before !== undefined && after === undefined) changes.push({ path, status: 'removed', oldOid: before.oid, newOid: null });
    else if (before !== undefined && after !== undefined && before.oid !== after.oid) {
      changes.push({ path, status: 'modified', oldOid: before.oid, newOid: after.oid });
    }
  }
  return changes;
}

export interface ThreeWayResult {
  merged: Map<string, FlatEntry>;
  conflicts: string[];
}

/**
 * A path-level three-way merge: a path changed on only one side takes that side; changed on
 * both sides to the same content merges; changed on both sides differently conflicts.
 */
export function threeWayMerge(
  base: ReadonlyMap<string, FlatEntry>,
  ours: ReadonlyMap<string, FlatEntry>,
  theirs: ReadonlyMap<string, FlatEntry>,
): ThreeWayResult {
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameOid = (x?: FlatEntry, y?: FlatEntry): boolean => x?.oid === y?.oid && x?.mode === y?.mode;
    if (sameOid(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (sameOid(b, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (sameOid(b, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  return { merged, conflicts };
}

// ---------------------------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------------------------

/**
 * Inflate exactly one zlib stream starting at `offset`, answering the data and the number of
 * compressed bytes it occupied. inflateSync ignores trailing bytes and verifies the stream's
 * Adler-32, so the consumed length is the shortest prefix that inflates at all: exponential
 * search for a working bound, then bisection.
 */
function inflateOne(pack: Buffer, offset: number, expectedSize: number): { data: Buffer; consumed: number } {
  const remaining = pack.length - offset;
  let hi = Math.min(remaining, Math.max(64, expectedSize * 2 + 64));
  let data: Buffer | null = null;
  while (data === null) {
    try {
      data = inflateSync(pack.subarray(offset, offset + hi));
    } catch {
      if (hi >= remaining) throw new Error('a pack object does not inflate');
      hi = Math.min(remaining, hi * 2);
    }
  }
  let lo = 1;
  let high = hi;
  while (lo < high) {
    const mid = (lo + high) >> 1;
    try {
      inflateSync(pack.subarray(offset, offset + mid));
      high = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data, consumed: lo };
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  count: number;
}

/**
 * Read a pack, resolving ofs-delta and ref-delta entries against the pack itself and, for
 * ref-deltas whose base is absent from the pack (thin packs), against `external`.
 * Verifies the trailer checksum. Throws on any structural problem.
 */
export function readPack(pack: Buffer, external?: (oid: string) => GitObject | undefined): ReadPackResult {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack signature missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(pack.subarray(pack.length - 20))) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    kind: GitObjectType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    baseOffset: number;
    baseOid: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset = 0;
    let baseOid = '';
    let kind: RawEntry['kind'];
    if (typeCode === 6) {
      kind = 'ofs-delta';
      byte = pack[offset]!;
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset]!;
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - back;
    } else if (typeCode === 7) {
      kind = 'ref-delta';
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    } else {
      const type = CODE_TO_TYPE[typeCode];
      if (type === undefined) throw new Error(`pack object type code ${typeCode}`);
      kind = type;
    }
    const { data, consumed } = inflateOne(pack, offset, size);
    if (data.length !== size) throw new Error(`pack object size ${data.length} != header ${size}`);
    offset += consumed;
    const entry: RawEntry = { offset: entryOffset, kind, data, baseOffset, baseOid };
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const resolved = new Map<number, GitObject>();
  const objects = new Map<string, GitObject>();
  const resolve = (entry: RawEntry): GitObject => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    let object: GitObject;
    if (entry.kind === 'ofs-delta') {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.kind === 'ref-delta') {
      let base: GitObject | undefined;
      for (const candidate of raw) {
        if (candidate.kind !== 'ofs-delta' && candidate.kind !== 'ref-delta') {
          if (hashObject(candidate.kind, candidate.data) === entry.baseOid) {
            base = resolve(candidate);
            break;
          }
        }
      }
      if (base === undefined) {
        for (const candidate of raw) {
          const resolvedCandidate = resolve(candidate);
          if (hashObject(resolvedCandidate.type, resolvedCandidate.data) === entry.baseOid) {
            base = resolvedCandidate;
            break;
          }
        }
      }
      if (base === undefined && external !== undefined) base = external(entry.baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} is unavailable`);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.kind, data: entry.data };
    }
    resolved.set(entry.offset, object);
    objects.set(hashObject(object.type, object.data), object);
    return object;
  };
  for (const entry of raw) resolve(entry);
  return { objects, count };
}

/** Write a version-2 pack of plain (undeltified) objects, with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const size = object.data.length;
    const typeCode = TYPE_TO_CODE[object.type];
    const first = size & 0x0f;
    let rest = size >> 4;
    const bytes: number[] = [];
    if (rest === 0) {
      bytes.push((typeCode << 4) | first);
    } else {
      bytes.push((typeCode << 4) | first | 0x80);
      while (rest > 0) {
        const next = rest & 0x7f;
        rest >>= 7;
        bytes.push(rest > 0 ? next | 0x80 : next);
      }
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export { OBJECT_TYPES };


/** Apply a git delta buffer to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset]! << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset]! << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, expected ${targetSize}`);
  }
  return result;
}

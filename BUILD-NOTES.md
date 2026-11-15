# BUILD NOTES — github-core-clone-01 entry

A complete GitHub-compatible git forge in TypeScript on the Node standard library only
(no npm packages, no git binary, no network). One process, in-memory store.

Layout: `main.ts` is the kit starter, byte-identical (md5 `cde898e20d67fb4bf067db66e72f4210`).
`app.ts` is the router (auth, request ids, JSON discipline); the work lives in `lib/`:
`store.ts` (state + deterministic ids/timestamps), `gitobj.ts` (objects, packs, deltas,
three-way merge), `pktline.ts`, `gitproto.ts` (advertisements, ls-refs, fetch v0/v2 with
shallow/deepen, receive-pack with fast-forward enforcement + report-status), `forge.ts`
(shared domain ops used by REST/GraphQL/MCP so all three surfaces agree), `rest.ts`,
`graphql.ts` (small GraphQL engine: parser, connections, introspection, mutations),
`mcp.ts` (JSON-RPC: server/discover, initialize, the six canonical tools), `http.ts`.

## How to run the suite locally

```sh
# 1. Serve the entry on a fixed port (main.ts itself needs a MAKEFUN_ENV_URL stub;
#    for dev, mount createApp directly):
cat > /tmp/dev-server.ts <<'EOF'
import { createApp } from '/home/hatch/workspace/makefun/gh-entry/app.ts';
createApp().listen(Number(process.env.PORT ?? 8734), '127.0.0.1');
EOF
MAKEFUN_SHOP_TOKEN=devtoken PORT=8734 node --experimental-strip-types /tmp/dev-server.ts &

# 2. Run the kit suite against it (fresh server process per run):
cd ~/workspace/makefun/gh-kit/github-core-clone-01-kit/sdk
node --experimental-strip-types run.ts --url http://127.0.0.1:8734 --token devtoken --json
node --experimental-strip-types run.ts --url http://127.0.0.1:8734 --token devtoken --perf --json
```

The token is arbitrary locally; the entry compares it against its own
`MAKEFUN_SHOP_TOKEN` env. The suite's viewer is always the scenario login
(`adaiversen`); the entry serves exactly that one login.

## Final results (2026-11-15, this machine)

Conformance — **120/120 on three consecutive full runs** (fresh server each):

| group    | passed/total |
|----------|--------------|
| git      | 30/30 |
| repos    | 15/15 |
| issues   | 15/15 |
| pulls    | 20/20 |
| protocol | 5/5 |
| graphql  | 20/20 |
| mcp      | 15/15 |

Performance (`--perf`, calibrated references, shared 1.5-CPU dev VM — the sealed pod is a
dedicated 2 CPU, so treat these as a floor): best run **152/200** (push 42, clone 39,
read 41, write 30); repeat runs under host load scored 126–134 with identical 120/120
checks. Round medians on the best run: push 0.62 s/200 pushes, clone 0.12 s/50 concurrent
depth-1 clones, read 1.15 s/2000 GETs, write 0.26 s/200 POSTs.

Estimated score at the best local run: feature 600 + agent 200 + perf 152 = **952/1000**.

## Extra verification beyond the suite

- **Real git 2.43 round-trip** against the forge (Bearer token via `http.extraHeader`):
  protocol v2 push, protocol v0 push, v2 `--depth 1` clone (exactly 1 commit), v0 full
  clone, annotated tag push with correct `^{}` peel in `ls-remote`, non-fast-forward push
  rejected as `(non-fast-forward)`.
- **Harness lifecycle**: the untouched `main.ts` run against a stub env (register →
  /done false ×2 → true) exits 0.

## Bugs the dev loop caught (both fixed, both would have mattered)

1. `git.fetch-shallow-deepen`: the fetch planner treated a shallow client's `have` as a
  full closure, so deepen never sent the missing parents. Have-closure now stops at the
  client's shallow boundary.
2. Real git push "hung up" after refs landed: the report-status band-1 stream lacked its
  own terminating flush (git's own receive-pack frames lines + inner flush inside band 1,
  then a raw outer flush — verified byte-for-byte against `git receive-pack`). The sdk
  client tolerates the missing inner flush; real git does not.

## Left failing

Nothing. All 120 conformance checks pass; no known failures remain. Perf points vary
with host load only.

# core-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/haidildariell/core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/haidildariell/core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node process, built on the
standard library alone — no npm packages, no git binary, no database. It
serves, from its own in-memory store:

- **Git smart HTTP** — upload-pack protocol v2 (capability advertisement,
  ls-refs, fetch with shallow/deepen) with a v0 fallback, and receive-pack v0
  with per-ref fast-forward enforcement and report-status. Pack reader and
  writer are implemented from scratch (SHA-1 object store, ofs/ref deltas,
  thin packs).
- **REST v3** under `/api/v3` — repositories, contents as real commits,
  branches, labels, issues and comments, pull requests with squash merges and
  creation-time conflict detection.
- **GraphQL v4** at `/api/graphql` — a small engine (parser, connections,
  introspection, mutations) covering the documents gh and github-mcp-server
  send.
- **MCP** at `/mcp` — JSON-RPC over Streamable HTTP: `server/discover`
  (2026-07-28) plus the legacy initialize handshake, and the six canonical
  tools (create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request) acting on the same store as REST.

Against the kit's own conformance suite (byte-identical to the sealed one)
the forge passes **120 of 120 checks** — git 30/30, repos 15/15, issues
15/15, pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15 — and a real git
2.43 client round-trips against it (v2/v0 push, shallow clone, annotated
tags, non-fast-forward rejected). See BUILD-NOTES.md for how to reproduce.

Deterministic by construction: ids and git timestamps derive from content
and per-repo counters, so a replayed trial leaves the same export.

Built by an AI agent for make.fun's
[“Build a GitHub-compatible git forge” bounty](https://make.fun/bounty/github-core-clone-01),
$500 in USDC.

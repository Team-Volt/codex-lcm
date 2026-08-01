import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { normalizeHookEvent } from "../src/events.ts";
import { appendRawEvents } from "../src/raw-log.ts";
import { createStorage, type LcmStorage } from "../src/storage.ts";
import * as storageModule from "../src/storage.ts";
import type {
  ContextPlan,
  ContextPlanState,
  FileReference,
  GraphEdge,
  GraphNode,
  Health,
  IndexCleanupReport,
  IngestManyOptions,
  IngestManyResult,
  LcmDescription,
  LcmExpansion,
  LcmQueryExpansion,
  LcmStats,
  ListSessionsArgs,
  OverflowContent,
  OverflowReference,
  OverflowSearchMatch,
  PackedContext,
  PackContextArgs,
  QueryExpansionSource,
  RecentContext,
  SearchOverflowArgs,
  SearchSessionArgs,
  SessionDetail,
  SessionDiscovery,
  SessionGraph,
  SessionListSummary,
  SessionMemorySummary,
  SessionPage,
  SessionSearchMatch,
  SessionSummary,
  StorageOptions,
  SummaryNode,
  SummarySourceType,
  UsageReport,
} from "../src/storage.ts";
import { tempHome } from "./helpers.ts";

type StorageApiTypeExports = [
  ContextPlan,
  ContextPlanState,
  FileReference,
  GraphEdge,
  GraphNode,
  Health,
  IndexCleanupReport,
  IngestManyOptions,
  IngestManyResult,
  LcmDescription,
  LcmExpansion,
  LcmQueryExpansion,
  LcmStats,
  ListSessionsArgs,
  OverflowContent,
  OverflowReference,
  OverflowSearchMatch,
  PackedContext,
  PackContextArgs,
  QueryExpansionSource,
  RecentContext,
  SearchOverflowArgs,
  SearchSessionArgs,
  SessionDetail,
  SessionDiscovery,
  SessionGraph,
  SessionListSummary,
  SessionMemorySummary,
  SessionPage,
  SessionSearchMatch,
  SessionSummary,
  StorageOptions,
  SummaryNode,
  SummarySourceType,
  UsageReport,
];

const storageApiTypeExportCount: StorageApiTypeExports["length"] = 35;

type PublicMethodNames = readonly [
  "close",
  "hasEvent",
  "ingest",
  "ingestMany",
  "rebuildSessionMemorySummaries",
  "cleanupIndex",
  "health",
  "stats",
  "listSessions",
  "usage",
  "searchSessions",
  "searchOverflow",
  "getCurrentSession",
  "getSession",
  "getSessionGraph",
  "getRecentContext",
  "getContextPlan",
  "recordNote",
  "getSessionMemorySummary",
  "getSummaryNodesForSession",
  "getFileRefsForSession",
  "getFileRef",
  "getOverflowRef",
  "describeMemory",
  "expandMemory",
  "expandQuery",
  "packContext",
];

const publicMethodNames: PublicMethodNames = [
  "close",
  "hasEvent",
  "ingest",
  "ingestMany",
  "rebuildSessionMemorySummaries",
  "cleanupIndex",
  "health",
  "stats",
  "listSessions",
  "usage",
  "searchSessions",
  "searchOverflow",
  "getCurrentSession",
  "getSession",
  "getSessionGraph",
  "getRecentContext",
  "getContextPlan",
  "recordNote",
  "getSessionMemorySummary",
  "getSummaryNodesForSession",
  "getFileRefsForSession",
  "getFileRef",
  "getOverflowRef",
  "describeMemory",
  "expandMemory",
  "expandQuery",
  "packContext",
];

type PublicMethodName = typeof publicMethodNames[number];

const hasOnlyCurrentPublicMethods: Exclude<keyof LcmStorage, "config" | PublicMethodName> extends never ? true : false = true;
const hasNoInvalidPublicMethods: Exclude<PublicMethodName, keyof LcmStorage> extends never ? true : false = true;

function rawPrompt(sessionId: string, cwd: string, prompt: string) {
  return normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: sessionId, cwd, prompt }),
    env: {},
    now: () => new Date("2026-08-01T12:00:00.000Z"),
  });
}

test("storage module preserves its named runtime exports", () => {
  assert.equal(storageApiTypeExportCount, 35);
  assert.deepEqual(Object.keys(storageModule).sort(), ["LcmStorage", "createStorage"]);
});

test("storage factory exposes all 27 public methods", () => {
  const storage = createStorage({ home: tempHome() });
  try {
    assert.equal(publicMethodNames.length, 27);
    assert.equal(hasOnlyCurrentPublicMethods, true);
    assert.equal(hasNoInvalidPublicMethods, true);
    for (const methodName of publicMethodNames) {
      assert.equal(typeof storage[methodName], "function");
    }
  } finally {
    storage.close();
  }
});

test("raw-only scoped reads keep session data isolated", () => {
  const home = tempHome();
  appendRawEvents(path.join(home, "events.jsonl"), [
    rawPrompt("raw-api-a", "/tmp/raw-api-a", "shared raw token RAW-API-A-ONLY"),
    rawPrompt("raw-api-b", "/tmp/raw-api-b", "shared raw token RAW-API-B-ONLY"),
  ]);
  const storage = createStorage({ home, readOnly: true });
  try {
    assert.equal(storage.health().index_available, false);
    assert.deepEqual(storage.listSessions({ cwd: "/tmp/raw-api-a" }).sessions.map((session) => session.session_id), ["raw-api-a"]);
    assert.deepEqual(
      storage.searchSessions({ query: "shared raw token", cwd: "/tmp/raw-api-a" }).map((session) => session.session_id),
      ["raw-api-a"],
    );
    assert.deepEqual(storage.getSession("raw-api-a").events.map((event) => event.session_id), ["raw-api-a"]);
    assert.deepEqual(
      storage.getSessionGraph("raw-api-a").nodes.map((node) => node.session_id),
      ["raw-api-a", "raw-api-a"],
    );
    const packed = storage.packContext({
      sessionIds: ["raw-api-a"],
      query: "shared raw token",
      budgetTokens: 128,
    });
    assert.equal(packed.markdown.includes("RAW-API-A-ONLY"), true);
    assert.equal(packed.markdown.includes("RAW-API-B-ONLY"), false);
    assert.deepEqual(packed.sources.map((source) => source.session_id), ["raw-api-a"]);
  } finally {
    storage.close();
  }
});

import fs from "node:fs";
import path from "node:path";

import type { LcmConfig } from "./config.ts";
import { sha256 } from "./redact.ts";

export type SegmentRecord = {
  id: string;
  path: string;
  compressed: boolean;
  byte_count: number;
  event_count: number;
  first_timestamp: string;
  last_timestamp: string;
  sha256: string;
};

export type SegmentManifest = {
  version: 1;
  migration?: { legacy_path: string; offset: number; complete: boolean; error?: string };
  segments: SegmentRecord[];
};

export type SegmentStorageHealth = {
  readonly storage_layout: "segmented-v1";
  readonly migration_state: "none" | "pending" | "complete" | "error";
  readonly active_bytes: number;
  readonly archive_bytes: number;
  readonly plain_segment_count: number;
  readonly compressed_segment_count: number;
  readonly config_error?: string;
};

export function emptySegmentManifest(): SegmentManifest {
  return { version: 1, segments: [] };
}

export function readManifest(manifestPath: string): SegmentManifest {
  if (!fs.existsSync(manifestPath)) return emptySegmentManifest();
  try {
    return validateManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  } catch (error) {
    throw new Error("Invalid segment manifest.", { cause: error });
  }
}

export function writeManifestAtomic(manifestPath: string, manifest: SegmentManifest): void {
  const serialized = JSON.stringify(validateManifest(manifest));
  const directory = path.dirname(manifestPath);
  const temporaryPath = `${manifestPath}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(temporaryPath, "w", 0o600);
  try {
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, manifestPath);
  fsyncDirectory(directory);
}

export function segmentStoreState(manifest: SegmentManifest): string {
  return sha256(JSON.stringify(manifest));
}

export function segmentStorageHealth(config: LcmConfig): SegmentStorageHealth {
  const manifestExists = fs.existsSync(config.manifestPath);
  const manifest = readManifest(config.manifestPath);
  const migration = manifest.migration;
  const migrationState = !manifestExists || !migration
    ? "none"
    : migration.error ? "error" : migration.complete ? "complete" : "pending";
  return {
    storage_layout: "segmented-v1",
    migration_state: migrationState,
    active_bytes: fs.existsSync(config.rawLogPath) ? fs.statSync(config.rawLogPath).size : 0,
    archive_bytes: manifest.segments.reduce((total, record) => {
      const segmentPath = path.join(config.home, record.path);
      return total + (fs.existsSync(segmentPath) ? fs.statSync(segmentPath).size : 0);
    }, 0),
    plain_segment_count: manifest.segments.filter((record) => !record.compressed).length,
    compressed_segment_count: manifest.segments.filter((record) => record.compressed).length,
    ...(config.configError ? { config_error: config.configError } : {}),
  };
}

function validateManifest(value: unknown): SegmentManifest {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.segments)) fail();
  const migration = value.migration === undefined ? undefined : validateMigration(value.migration);
  return {
    version: 1,
    ...(migration === undefined ? {} : { migration }),
    segments: value.segments.map(validateSegment),
  };
}

function validateMigration(value: unknown): NonNullable<SegmentManifest["migration"]> {
  if (!isRecord(value) || !isRelativePath(value.legacy_path) || !isNonNegativeInteger(value.offset) || typeof value.complete !== "boolean") {
    fail();
  }
  if (value.error !== undefined && !isNonEmptyString(value.error)) fail();
  return {
    legacy_path: value.legacy_path,
    offset: value.offset,
    complete: value.complete,
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}

function validateSegment(value: unknown): SegmentRecord {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isRelativePath(value.path)
    || typeof value.compressed !== "boolean"
    || !isNonNegativeInteger(value.byte_count)
    || !isNonNegativeInteger(value.event_count)
    || !isNonEmptyString(value.first_timestamp)
    || !isNonEmptyString(value.last_timestamp)
    || !isNonEmptyString(value.sha256)
    || !/^[a-f0-9]{64}$/iu.test(value.sha256)) {
    fail();
  }
  return {
    id: value.id,
    path: value.path,
    compressed: value.compressed,
    byte_count: value.byte_count,
    event_count: value.event_count,
    first_timestamp: value.first_timestamp,
    last_timestamp: value.last_timestamp,
    sha256: value.sha256,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRelativePath(value: unknown): value is string {
  return isNonEmptyString(value)
    && !path.isAbsolute(value)
    && !path.win32.isAbsolute(value)
    && !value.split(/[\\/]+/u).includes("..");
}

function fail(): never {
  throw new Error("Malformed segment manifest.");
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

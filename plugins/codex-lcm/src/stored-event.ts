import type { DatabaseSync } from "node:sqlite";

import type { LcmConfig } from "./config.ts";
import { createLocatedEventReader } from "./raw-log.ts";

export const STORED_EVENT_JSON_SQL = "lcm_raw_json(raw_json, segment_id, raw_offset, raw_length)" as const;

export function registerStoredEventReader(db: DatabaseSync, config: LcmConfig): void {
  const readLocatedEvent = createLocatedEventReader(config);
  db.function("lcm_raw_json", { directOnly: true }, (rawJson, segmentId, offset, length) => {
    if (typeof rawJson === "string" && rawJson.length > 0) return rawJson;
    if (typeof segmentId !== "string" || typeof offset !== "number" || typeof length !== "number") {
      throw new TypeError("Stored event has neither inline JSON nor a valid raw locator.");
    }
    return JSON.stringify(readLocatedEvent({ segmentId, offset, length }));
  });
}

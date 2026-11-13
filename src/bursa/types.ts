export const BURSA_SCHEMA_VERSION = "1.0" as const;
export const BURSA_SOURCE_NAME = "bursa" as const;

export type BursaListingStatus = "active" | "inactive" | "removed" | "unknown";

export type BursaRunOutcome = "success" | "success_zero_results" | "failed";

export type BursaChangeField =
  | "title"
  | "description"
  | "location"
  | "contact"
  | "status"
  | "published_at"
  | "source_url";

export interface BursaStructuredLocation {
  city: string | null;
  county: string | null;
  raw: string | null;
}

export interface BursaContactInfo {
  phone: string | null;
  normalized_phone: string | null;
}

export interface BursaChangeEvent {
  id: string;
  listing_id: string;
  source_listing_id: string;
  field: BursaChangeField;
  old_value: unknown;
  new_value: unknown;
  detected_at: string; // UTC ISO 8601
}

export interface BursaListingRecord {
  id: string; // Stable internal record ID
  source_listing_id: string; // Stable Bursa listing ID
  source_url: string;
  title: string | null;
  description: string | null;
  location: BursaStructuredLocation;
  contact: BursaContactInfo;
  published_at: string | null; // UTC ISO 8601
  updated_at: string | null; // UTC ISO 8601
  status: BursaListingStatus;
  first_seen_at: string; // UTC ISO 8601
  last_seen_at: string | null; // UTC ISO 8601
  last_checked_at: string; // UTC ISO 8601
  last_updated_at: string; // UTC ISO 8601
}

export interface ExtractedBursaListing {
  source_listing_id: string;
  source_url: string;
  title: string | null;
  description: string | null;
  location: BursaStructuredLocation;
  contact: BursaContactInfo;
  published_at: string | null;
  updated_at: string | null;
  status: BursaListingStatus;
}

export interface BursaRunRecord {
  run_id: string;
  started_at: string; // UTC ISO 8601
  finished_at: string | null; // UTC ISO 8601
  outcome: BursaRunOutcome | "running";
  sweep_completed: boolean;
  pages_scanned: number;
  listings_discovered: number;
  new_count: number;
  changed_count: number;
  unchanged_count: number;
  inactivated_count: number;
  removed_count: number;
  error_summary: string | null;
}

export interface BursaHealthSnapshot {
  source: typeof BURSA_SOURCE_NAME;
  schema_version: typeof BURSA_SCHEMA_VERSION;
  generated_at: string;
  data: {
    status: "healthy" | "degraded" | "idle" | "running";
    scraper_state: "idle" | "running" | "paused";
    schedule_interval_ms: number;
    next_scheduled_run_at: string | null;
    last_run_at: string | null;
    last_run_outcome: BursaRunOutcome | "running" | null;
    last_successful_run_at: string | null;
    last_successful_non_empty_run_at: string | null;
    last_error_summary: string | null;
    totals: {
      listings: number;
      active: number;
      inactive: number;
      removed: number;
      unknown: number;
      changes: number;
    };
  };
}

export interface BursaApiListingDTO extends BursaListingRecord {
  changes: BursaChangeEvent[];
}

export interface BursaApiErrorEnvelope {
  source: typeof BURSA_SOURCE_NAME;
  schema_version: typeof BURSA_SCHEMA_VERSION;
  generated_at: string;
  error: {
    code: string;
    message: string;
  };
}

export interface BursaApiPagination {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

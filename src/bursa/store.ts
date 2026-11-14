import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  BURSA_SCHEMA_VERSION,
  BURSA_SOURCE_NAME,
  type BursaApiListingDTO,
  type BursaApiPagination,
  type BursaChangeEvent,
  type BursaChangeField,
  type BursaContactInfo,
  type BursaHealthSnapshot,
  type BursaListingRecord,
  type BursaListingStatus,
  type BursaRunOutcome,
  type BursaRunRecord,
  type BursaStructuredLocation,
  type ExtractedBursaListing,
} from "./types";
import {
  deriveInternalRecordId,
  deriveStableSourceListingId,
  extractStructuredLocation,
  isBursaExcludedListing,
  normalizeCanonicalUrl,
  normalizeContact,
  sanitizeErrorMessage,
  stripDiacritics,
} from "./parser";

export interface BursaSweepMeta {
  runId: string;
  startedAt: string;
  finishedAt: string;
  pagesScanned: number;
  sweepCompleted: boolean;
  failed: boolean;
  errorSummary: string | null;
}

export interface BursaListingsFilter {
  page: number;
  per_page: number;
  updated_since?: string;
  status?: BursaListingStatus;
  city?: string;
  county?: string;
  source_listing_id?: string;
}

export interface BursaChangesFilter {
  page: number;
  per_page: number;
  updated_since?: string;
  status?: BursaListingStatus;
  city?: string;
  county?: string;
  source_listing_id?: string;
  field?: BursaChangeField;
}

function stableDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => stableDeepEqual(v, b[i]));
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).sort();
  const keysB = Object.keys(objB).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k, i) => k === keysB[i] && stableDeepEqual(objA[k], objB[k]));
}

function cloneLocation(loc: BursaStructuredLocation): BursaStructuredLocation {
  return {
    city: loc.city ?? null,
    county: loc.county ?? null,
    raw: loc.raw === "" ? "" : loc.raw ?? null,
  };
}

function cloneContact(contact: BursaContactInfo): BursaContactInfo {
  return {
    phone: contact.phone === "" ? "" : contact.phone ?? null,
    normalized_phone: contact.normalized_phone ?? null,
  };
}

function normalizeFilterText(val: string): string {
  return stripDiacritics(val).toLowerCase().trim();
}

export class BursaV1Store {
  private readonly dataDir: string;
  private readonly listingsFile: string;
  private readonly changesFile: string;
  private readonly runsFile: string;

  private listingsById = new Map<string, BursaListingRecord>();
  private idBySourceListingId = new Map<string, string>();
  private idByCanonicalUrl = new Map<string, string>();
  private changes: BursaChangeEvent[] = [];
  private runs: BursaRunRecord[] = [];
  private readonly maxRunsHistory = 200;

  constructor(dataDir = path.join(process.cwd(), "data")) {
    this.dataDir = dataDir;
    this.listingsFile = path.join(dataDir, "bursa_v1_listings.json");
    this.changesFile = path.join(dataDir, "bursa_v1_changes.json");
    this.runsFile = path.join(dataDir, "bursa_v1_runs.json");
    this.ensureDir();
    this.loadFromDisk();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private atomicWriteJson(filePath: string, payload: unknown): void {
    this.ensureDir();
    const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.listingsFile)) {
        const raw = fs.readFileSync(this.listingsFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.listingsById.clear();
          this.idBySourceListingId.clear();
          this.idByCanonicalUrl.clear();
          for (const item of parsed as BursaListingRecord[]) {
            if (!item || typeof item.id !== "string" || typeof item.source_listing_id !== "string") continue;
            const normalizedUrl = normalizeCanonicalUrl(item.source_url);
            const record: BursaListingRecord = {
              ...item,
              source_url: normalizedUrl || item.source_url,
              location: cloneLocation(item.location || { city: null, county: null, raw: null }),
              contact: cloneContact(item.contact || { phone: null, normalized_phone: null }),
            };
            this.listingsById.set(record.id, record);
            this.idBySourceListingId.set(record.source_listing_id, record.id);
            if (normalizedUrl) {
              this.idByCanonicalUrl.set(normalizedUrl, record.id);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[BURSA_V1_STORE] Failed to load listings file: ${sanitizeErrorMessage(err)}`);
    }

    try {
      if (fs.existsSync(this.changesFile)) {
        const raw = fs.readFileSync(this.changesFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.changes = parsed;
        }
      }
    } catch (err) {
      console.warn(`[BURSA_V1_STORE] Failed to load changes file: ${sanitizeErrorMessage(err)}`);
    }

    try {
      if (fs.existsSync(this.runsFile)) {
        const raw = fs.readFileSync(this.runsFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.runs = parsed;
        }
      }
    } catch (err) {
      console.warn(`[BURSA_V1_STORE] Failed to load runs file: ${sanitizeErrorMessage(err)}`);
    }
  }

  private persistAll(): void {
    const listingsArray = Array.from(this.listingsById.values()).sort((a, b) =>
      b.last_updated_at.localeCompare(a.last_updated_at) || a.id.localeCompare(b.id)
    );
    this.atomicWriteJson(this.listingsFile, listingsArray);
    this.atomicWriteJson(this.changesFile, this.changes);
    this.atomicWriteJson(this.runsFile, this.runs.slice(-this.maxRunsHistory));
  }

  private createChangeEvent(
    record: BursaListingRecord,
    field: BursaChangeField,
    oldValue: unknown,
    newValue: unknown,
    detectedAt: string
  ): BursaChangeEvent {
    return {
      id: `chg_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      listing_id: record.id,
      source_listing_id: record.source_listing_id,
      field,
      old_value: oldValue,
      new_value: newValue,
      detected_at: detectedAt,
    };
  }

  /**
   * Find existing listing strictly by stable source_listing_id OR exact canonical source_url.
   * NEVER merge distinct records based solely on phone numbers.
   */
  private findExistingRecord(extracted: ExtractedBursaListing): BursaListingRecord | undefined {
    const bySourceId = this.idBySourceListingId.get(extracted.source_listing_id);
    if (bySourceId) {
      return this.listingsById.get(bySourceId);
    }
    const canonicalUrl = normalizeCanonicalUrl(extracted.source_url);
    if (canonicalUrl) {
      const byUrl = this.idByCanonicalUrl.get(canonicalUrl);
      if (byUrl) {
        return this.listingsById.get(byUrl);
      }
    }
    return undefined;
  }

  private reconcileObservation(
    extracted: ExtractedBursaListing,
    observedAt: string,
    mode: "discovery" | "detail"
  ): { record: BursaListingRecord; outcome: "new" | "changed" | "unchanged"; removedTriggered: boolean } {
    const canonicalUrl = normalizeCanonicalUrl(extracted.source_url) || extracted.source_url;
    const existing = this.findExistingRecord(extracted);

    if (!existing) {
      const internalId = deriveInternalRecordId(extracted.source_listing_id);
      const record: BursaListingRecord = {
        id: internalId,
        source_listing_id: extracted.source_listing_id,
        source_url: canonicalUrl,
        title: extracted.title,
        description: extracted.description,
        location: cloneLocation(extracted.location),
        contact: cloneContact(extracted.contact),
        published_at: extracted.published_at,
        updated_at: extracted.updated_at,
        status: extracted.status,
        first_seen_at: observedAt,
        last_seen_at: extracted.status === "removed" ? null : observedAt,
        last_checked_at: observedAt,
        last_updated_at: observedAt,
      };
      this.listingsById.set(record.id, record);
      this.idBySourceListingId.set(record.source_listing_id, record.id);
      if (canonicalUrl) {
        this.idByCanonicalUrl.set(canonicalUrl, record.id);
      }
      return { record, outcome: "new", removedTriggered: record.status === "removed" };
    }

    // Upgrade fallback hash source_listing_id -> numeric ID only when exact same URL matches, keeping internal record ID & history
    if (
      existing.source_listing_id !== extracted.source_listing_id &&
      existing.source_listing_id.startsWith("bp_") &&
      !extracted.source_listing_id.startsWith("bp_")
    ) {
      this.idBySourceListingId.delete(existing.source_listing_id);
      existing.source_listing_id = extracted.source_listing_id;
      this.idBySourceListingId.set(existing.source_listing_id, existing.id);
    }

    const emittedChanges: BursaChangeEvent[] = [];
    let removedTriggered = false;

    // 1. Source URL change (when matched by numeric source_listing_id after slug update)
    if (canonicalUrl && existing.source_url !== canonicalUrl && extracted.status !== "removed") {
      emittedChanges.push(
        this.createChangeEvent(existing, "source_url", existing.source_url, canonicalUrl, observedAt)
      );
      this.idByCanonicalUrl.delete(existing.source_url);
      existing.source_url = canonicalUrl;
      this.idByCanonicalUrl.set(canonicalUrl, existing.id);
    }

    // 2. Status change
    if (existing.status !== extracted.status) {
      emittedChanges.push(
        this.createChangeEvent(existing, "status", existing.status, extracted.status, observedAt)
      );
      existing.status = extracted.status;
      if (extracted.status === "removed") {
        removedTriggered = true;
      }
    }

    // If an explicit 404/removed check occurs, update checked/updated timestamps without erasing prior snapshot fields
    if (extracted.status === "removed") {
      existing.last_checked_at = observedAt;
      if (emittedChanges.length > 0) {
        existing.last_updated_at = observedAt;
        this.changes.push(...emittedChanges);
      }
      return {
        record: existing,
        outcome: emittedChanges.length > 0 ? "changed" : "unchanged",
        removedTriggered,
      };
    }

    // 3. Title
    if (extracted.title !== null && extracted.title !== existing.title) {
      // Do not regress a richer detail title to a truncated card snippet ending in "..."
      const isCardTruncation =
        mode === "discovery" &&
        existing.title !== null &&
        (extracted.title.endsWith("...") || extracted.title.endsWith("…")) &&
        existing.title.startsWith(extracted.title.slice(0, -3).trim());

      if (!isCardTruncation) {
        emittedChanges.push(
          this.createChangeEvent(existing, "title", existing.title, extracted.title, observedAt)
        );
        existing.title = extracted.title;
      }
    }

    // 4. Description
    if (mode === "detail") {
      if (extracted.description !== null && extracted.description !== existing.description) {
        emittedChanges.push(
          this.createChangeEvent(existing, "description", existing.description, extracted.description, observedAt)
        );
        existing.description = extracted.description;
      }
    } else if (extracted.description !== null && extracted.description !== "" && extracted.description !== existing.description) {
      const isShortCardPreview =
        existing.description !== null &&
        (extracted.description.endsWith("...") || extracted.description.endsWith("…")) &&
        existing.description.startsWith(extracted.description.slice(0, -3).trim());
      if (!isShortCardPreview) {
        emittedChanges.push(
          this.createChangeEvent(existing, "description", existing.description, extracted.description, observedAt)
        );
        existing.description = extracted.description;
      }
    }

    // 5. Location
    const incomingLoc = cloneLocation(extracted.location);
    const hasIncomingLocationSignal =
      incomingLoc.city !== null || incomingLoc.county !== null || (incomingLoc.raw !== null && incomingLoc.raw !== "");
    if (hasIncomingLocationSignal) {
      const mergedLoc: BursaStructuredLocation = cloneLocation(incomingLoc);
      // Avoid overwriting a previously resolved city on card sweep when county is identical and card omitted city
      if (
        mode === "discovery" &&
        mergedLoc.city === null &&
        existing.location.city !== null &&
        mergedLoc.county === existing.location.county
      ) {
        mergedLoc.city = existing.location.city;
        if (existing.location.raw && mergedLoc.raw === existing.location.county) {
          mergedLoc.raw = existing.location.raw;
        }
      }

      if (!stableDeepEqual(existing.location, mergedLoc)) {
        emittedChanges.push(
          this.createChangeEvent(
            existing,
            "location",
            cloneLocation(existing.location),
            cloneLocation(mergedLoc),
            observedAt
          )
        );
        existing.location = mergedLoc;
      }
    }

    // 6. Contact
    const incomingContact = cloneContact(extracted.contact);
    const hasIncomingContact = incomingContact.phone !== null || incomingContact.normalized_phone !== null;
    if ((mode === "detail" && incomingContact.phone !== null) || (hasIncomingContact && incomingContact.normalized_phone !== null)) {
      if (!stableDeepEqual(existing.contact, incomingContact)) {
        emittedChanges.push(
          this.createChangeEvent(
            existing,
            "contact",
            cloneContact(existing.contact),
            cloneContact(incomingContact),
            observedAt
          )
        );
        existing.contact = incomingContact;
      }
    }

    // 7. Published / updated dates
    if (extracted.published_at !== null && extracted.published_at !== existing.published_at) {
      emittedChanges.push(
        this.createChangeEvent(existing, "published_at", existing.published_at, extracted.published_at, observedAt)
      );
      existing.published_at = extracted.published_at;
    }
    if (extracted.updated_at !== null) {
      existing.updated_at = extracted.updated_at;
    }

    existing.last_seen_at = observedAt;
    existing.last_checked_at = observedAt;

    if (emittedChanges.length > 0) {
      existing.last_updated_at = observedAt;
      this.changes.push(...emittedChanges);
      return { record: existing, outcome: "changed", removedTriggered };
    }

    return { record: existing, outcome: "unchanged", removedTriggered };
  }

  public recordDiscoverySweep(
    extractedListings: ExtractedBursaListing[],
    meta: BursaSweepMeta
  ): BursaRunRecord {
    const errorSummary = meta.errorSummary ? sanitizeErrorMessage(meta.errorSummary) : null;

    // Critical failure-safety guarantee: failed or incomplete sweeps MUST NEVER create, update,
    // reactivate, or deactivate any listing records or emit change events.
    if (meta.failed || !meta.sweepCompleted) {
      const failedRun: BursaRunRecord = {
        run_id: meta.runId,
        started_at: meta.startedAt,
        finished_at: meta.finishedAt,
        outcome: "failed",
        sweep_completed: false,
        pages_scanned: meta.pagesScanned,
        listings_discovered: 0,
        new_count: 0,
        changed_count: 0,
        unchanged_count: 0,
        inactivated_count: 0,
        removed_count: 0,
        error_summary: errorSummary || "Discovery sweep failed or did not complete",
      };
      this.runs.push(failedRun);
      if (this.runs.length > this.maxRunsHistory) {
        this.runs = this.runs.slice(-this.maxRunsHistory);
      }
      this.atomicWriteJson(this.runsFile, this.runs);
      return failedRun;
    }

    const seenInternalIds = new Set<string>();
    let newCount = 0;
    let changedCount = 0;
    let unchangedCount = 0;
    let inactivatedCount = 0;
    let removedCount = 0;

    for (const item of extractedListings) {
      const res = this.reconcileObservation(item, meta.finishedAt, "discovery");
      seenInternalIds.add(res.record.id);
      if (res.outcome === "new") newCount++;
      else if (res.outcome === "changed") changedCount++;
      else unchangedCount++;
      if (res.removedTriggered) removedCount++;
    }

    let runOutcome: BursaRunOutcome;
    let finalErrorSummary = errorSummary;

    if (seenInternalIds.size === 0) {
      // Successful sweep with zero results: DO NOT deactivate anything; flag for investigation.
      runOutcome = "success_zero_results";
      if (!finalErrorSummary) {
        finalErrorSummary = "Successful discovery sweep returned zero results; active listings preserved pending investigation";
      }
    } else {
      runOutcome = "success";
      // Complete successful non-empty sweep: any active listing absent from this sweep transitions to inactive
      for (const record of this.listingsById.values()) {
        if (record.status === "active" && !seenInternalIds.has(record.id)) {
          const statusChange = this.createChangeEvent(
            record,
            "status",
            "active",
            "inactive",
            meta.finishedAt
          );
          this.changes.push(statusChange);
          record.status = "inactive";
          record.last_checked_at = meta.finishedAt;
          record.last_updated_at = meta.finishedAt;
          inactivatedCount++;
        }
      }
    }

    const runRecord: BursaRunRecord = {
      run_id: meta.runId,
      started_at: meta.startedAt,
      finished_at: meta.finishedAt,
      outcome: runOutcome,
      sweep_completed: meta.sweepCompleted,
      pages_scanned: meta.pagesScanned,
      listings_discovered: seenInternalIds.size,
      new_count: newCount,
      changed_count: changedCount,
      unchanged_count: unchangedCount,
      inactivated_count: inactivatedCount,
      removed_count: removedCount,
      error_summary: finalErrorSummary,
    };

    this.runs.push(runRecord);
    if (this.runs.length > this.maxRunsHistory) {
      this.runs = this.runs.slice(-this.maxRunsHistory);
    }

    this.persistAll();
    return runRecord;
  }

  public getListingsCount(): number {
    return this.listingsById.size;
  }

  public seedFromLegacyProfiles(
    legacyProfiles: Array<{
      source?: string;
      link?: string;
      title?: string;
      description?: string;
      location?: string;
      images?: string[];
      phoneNumber?: string;
      revealedPhone?: string;
      savedAt?: number;
      lastUpdatedAt?: number;
      status?: string;
      locationHistory?: Array<{ location: string; date?: number }>;
    }>
  ): number {
    if (this.listingsById.size > 0 || !Array.isArray(legacyProfiles) || legacyProfiles.length === 0) {
      return 0;
    }

    let imported = 0;
    for (const item of legacyProfiles) {
      if (!item || item.source !== "bursaplacerilor" || !item.link) continue;
      const canonicalUrl = normalizeCanonicalUrl(item.link);
      if (!canonicalUrl) continue;
      if (
        isBursaExcludedListing({
          title: item.title,
          description: item.description,
          source_url: canonicalUrl,
          location_raw: item.location,
        })
      ) {
        continue;
      }

      const sourceListingId = deriveStableSourceListingId(canonicalUrl, item.images || []);
      if (this.idBySourceListingId.has(sourceListingId) || this.idByCanonicalUrl.has(canonicalUrl)) {
        continue;
      }

      const internalId = deriveInternalRecordId(sourceListingId);
      const savedMs = typeof item.savedAt === "number" && item.savedAt > 0 ? item.savedAt : Date.now();
      const updatedMs =
        typeof item.lastUpdatedAt === "number" && item.lastUpdatedAt >= savedMs ? item.lastUpdatedAt : savedMs;
      const firstSeenIso = new Date(savedMs).toISOString();
      const lastUpdatedIso = new Date(updatedMs).toISOString();

      const structuredLocation = extractStructuredLocation(
        item.location ?? null,
        canonicalUrl,
        item.title ?? null,
        item.description || ""
      );

      const rawPhone = item.revealedPhone || item.phoneNumber || null;
      const cleanedPhone = rawPhone && !/click/i.test(rawPhone) ? rawPhone : null;
      const status: BursaListingStatus = item.status === "expired" ? "removed" : "active";

      const record: BursaListingRecord = {
        id: internalId,
        source_listing_id: sourceListingId,
        source_url: canonicalUrl,
        title: item.title ? item.title.replace(/\s+/g, " ").trim() : null,
        description: item.description !== undefined ? item.description : null,
        location: structuredLocation,
        contact: normalizeContact(cleanedPhone),
        published_at: null,
        updated_at: null,
        status,
        first_seen_at: firstSeenIso,
        last_seen_at: status === "removed" ? null : lastUpdatedIso,
        last_checked_at: lastUpdatedIso,
        last_updated_at: lastUpdatedIso,
      };

      this.listingsById.set(record.id, record);
      this.idBySourceListingId.set(record.source_listing_id, record.id);
      this.idByCanonicalUrl.set(canonicalUrl, record.id);
      imported++;

      if (Array.isArray(item.locationHistory) && item.locationHistory.length > 1) {
        for (let i = 1; i < item.locationHistory.length; i++) {
          const prev = item.locationHistory[i - 1];
          const curr = item.locationHistory[i];
          if (!prev?.location || !curr?.location || prev.location === curr.location) continue;
          const prevLoc = extractStructuredLocation(prev.location, canonicalUrl, item.title ?? null);
          const newLoc = extractStructuredLocation(curr.location, canonicalUrl, item.title ?? null);
          const detectedAt =
            typeof curr.date === "number" && curr.date > 0 ? new Date(curr.date).toISOString() : lastUpdatedIso;
          this.changes.push(this.createChangeEvent(record, "location", prevLoc, newLoc, detectedAt));
        }
      }
    }

    if (imported > 0) {
      this.persistAll();
    }
    return imported;
  }

  public recordDetailCheck(extracted: ExtractedBursaListing, checkedAt: string): BursaListingRecord {
    const res = this.reconcileObservation(extracted, checkedAt, "detail");
    this.persistAll();
    return res.record;
  }

  private getChangesForRecord(record: BursaListingRecord): BursaChangeEvent[] {
    return this.changes
      .filter((c) => c.listing_id === record.id || c.source_listing_id === record.source_listing_id)
      .sort((a, b) => b.detected_at.localeCompare(a.detected_at) || b.id.localeCompare(a.id));
  }

  public queryListings(filters: BursaListingsFilter): {
    data: BursaApiListingDTO[];
    pagination: BursaApiPagination;
  } {
    const updatedSinceMs = filters.updated_since ? Date.parse(filters.updated_since) : null;
    const normCity = filters.city ? normalizeFilterText(filters.city) : null;
    const normCounty = filters.county ? normalizeFilterText(filters.county) : null;

    const filtered = Array.from(this.listingsById.values()).filter((rec) => {
      if (updatedSinceMs !== null && !Number.isNaN(updatedSinceMs)) {
        const recUpdatedMs = Date.parse(rec.last_updated_at);
        if (Number.isNaN(recUpdatedMs) || recUpdatedMs < updatedSinceMs) return false;
      }
      if (filters.status && rec.status !== filters.status) return false;
      if (filters.source_listing_id && rec.source_listing_id !== filters.source_listing_id) return false;
      if (normCity) {
        const recCity = rec.location.city ? normalizeFilterText(rec.location.city) : "";
        if (!recCity || !recCity.includes(normCity)) return false;
      }
      if (normCounty) {
        const recCounty = rec.location.county ? normalizeFilterText(rec.location.county) : "";
        if (!recCounty || recCounty !== normCounty) return false;
      }
      return true;
    });

    filtered.sort(
      (a, b) =>
        b.last_updated_at.localeCompare(a.last_updated_at) ||
        b.first_seen_at.localeCompare(a.first_seen_at) ||
        a.id.localeCompare(b.id)
    );

    const total = filtered.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / filters.per_page);
    const offset = (filters.page - 1) * filters.per_page;
    const pageItems = filtered.slice(offset, offset + filters.per_page);

    const data: BursaApiListingDTO[] = pageItems.map((rec) => ({
      ...rec,
      location: cloneLocation(rec.location),
      contact: cloneContact(rec.contact),
      changes: this.getChangesForRecord(rec),
    }));

    return {
      data,
      pagination: {
        page: filters.page,
        per_page: filters.per_page,
        total,
        total_pages: totalPages,
      },
    };
  }

  public getListingById(idOrSourceListingId: string): BursaApiListingDTO | null {
    const trimmed = String(idOrSourceListingId || "").trim();
    if (!trimmed) return null;
    let record = this.listingsById.get(trimmed);
    if (!record) {
      const mappedId = this.idBySourceListingId.get(trimmed);
      if (mappedId) record = this.listingsById.get(mappedId);
    }
    if (!record) return null;
    return {
      ...record,
      location: cloneLocation(record.location),
      contact: cloneContact(record.contact),
      changes: this.getChangesForRecord(record),
    };
  }

  public queryChanges(filters: BursaChangesFilter): {
    data: BursaChangeEvent[];
    pagination: BursaApiPagination;
  } {
    const updatedSinceMs = filters.updated_since ? Date.parse(filters.updated_since) : null;
    const normCity = filters.city ? normalizeFilterText(filters.city) : null;
    const normCounty = filters.county ? normalizeFilterText(filters.county) : null;

    const filtered = this.changes.filter((chg) => {
      if (updatedSinceMs !== null && !Number.isNaN(updatedSinceMs)) {
        const detMs = Date.parse(chg.detected_at);
        if (Number.isNaN(detMs) || detMs < updatedSinceMs) return false;
      }
      if (filters.source_listing_id && chg.source_listing_id !== filters.source_listing_id) return false;
      if (filters.field && chg.field !== filters.field) return false;

      if (filters.status || normCity || normCounty) {
        const parent =
          this.listingsById.get(chg.listing_id) ||
          (this.idBySourceListingId.get(chg.source_listing_id)
            ? this.listingsById.get(this.idBySourceListingId.get(chg.source_listing_id)!)
            : undefined);

        if (filters.status && parent?.status !== filters.status) return false;

        if (normCity) {
          const parentCity = parent?.location.city ? normalizeFilterText(parent.location.city) : "";
          const newLocCity =
            chg.field === "location" && typeof (chg.new_value as any)?.city === "string"
              ? normalizeFilterText((chg.new_value as any).city)
              : "";
          const oldLocCity =
            chg.field === "location" && typeof (chg.old_value as any)?.city === "string"
              ? normalizeFilterText((chg.old_value as any).city)
              : "";
          if (!parentCity.includes(normCity) && !newLocCity.includes(normCity) && !oldLocCity.includes(normCity)) {
            return false;
          }
        }

        if (normCounty) {
          const parentCounty = parent?.location.county ? normalizeFilterText(parent.location.county) : "";
          const newLocCounty =
            chg.field === "location" && typeof (chg.new_value as any)?.county === "string"
              ? normalizeFilterText((chg.new_value as any).county)
              : "";
          const oldLocCounty =
            chg.field === "location" && typeof (chg.old_value as any)?.county === "string"
              ? normalizeFilterText((chg.old_value as any).county)
              : "";
          if (parentCounty !== normCounty && newLocCounty !== normCounty && oldLocCounty !== normCounty) {
            return false;
          }
        }
      }

      return true;
    });

    filtered.sort((a, b) => b.detected_at.localeCompare(a.detected_at) || b.id.localeCompare(a.id));

    const total = filtered.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / filters.per_page);
    const offset = (filters.page - 1) * filters.per_page;

    return {
      data: filtered.slice(offset, offset + filters.per_page),
      pagination: {
        page: filters.page,
        per_page: filters.per_page,
        total,
        total_pages: totalPages,
      },
    };
  }

  public getLatestRuns(limit = 20): BursaRunRecord[] {
    return this.runs.slice(-limit).reverse();
  }

  public getHealthSnapshot(params: {
    scraperState: "idle" | "running" | "paused";
    scheduleIntervalMs: number;
    nextScheduledRunAt: string | null;
    generatedAt?: string;
  }): BursaHealthSnapshot {
    const latestRun = this.runs.length > 0 ? this.runs[this.runs.length - 1] : null;
    const lastSuccessAny = [...this.runs]
      .reverse()
      .find((r) => r.outcome === "success" || r.outcome === "success_zero_results");
    const lastSuccessNonEmpty = [...this.runs]
      .reverse()
      .find((r) => r.outcome === "success");

    let active = 0;
    let inactive = 0;
    let removed = 0;
    let unknown = 0;
    for (const rec of this.listingsById.values()) {
      if (rec.status === "active") active++;
      else if (rec.status === "inactive") inactive++;
      else if (rec.status === "removed") removed++;
      else unknown++;
    }

    let status: "healthy" | "degraded" | "idle" | "running" = "idle";
    if (params.scraperState === "running") {
      status = "running";
    } else if (latestRun) {
      if (latestRun.outcome === "failed" || latestRun.outcome === "success_zero_results") {
        status = "degraded";
      } else {
        status = "healthy";
      }
    }

    return {
      source: BURSA_SOURCE_NAME,
      schema_version: BURSA_SCHEMA_VERSION,
      generated_at: params.generatedAt || new Date().toISOString(),
      data: {
        status,
        scraper_state: params.scraperState,
        schedule_interval_ms: params.scheduleIntervalMs,
        next_scheduled_run_at: params.nextScheduledRunAt,
        last_run_at: latestRun ? latestRun.finished_at || latestRun.started_at : null,
        last_run_outcome: latestRun ? latestRun.outcome : null,
        last_successful_run_at: lastSuccessAny ? lastSuccessAny.finished_at : null,
        last_successful_non_empty_run_at: lastSuccessNonEmpty ? lastSuccessNonEmpty.finished_at : null,
        last_error_summary: latestRun?.error_summary ? sanitizeErrorMessage(latestRun.error_summary) : null,
        totals: {
          listings: this.listingsById.size,
          active,
          inactive,
          removed,
          unknown,
          changes: this.changes.length,
        },
      },
    };
  }
}

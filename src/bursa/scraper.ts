import axios from "axios";
import https from "https";
import crypto from "crypto";
import type { BursaHealthSnapshot, BursaRunRecord, ExtractedBursaListing } from "./types";
import {
  BursaAccessRestrictionError,
  detectAccessRestriction,
  isPathAllowedByRobots,
  normalizeCanonicalUrl,
  parseDetailPage,
  parseDiscoveryPage,
  parseRobotsTxtDisallows,
  sanitizeErrorMessage,
} from "./parser";
import { BursaV1Store } from "./store";

export const DEFAULT_WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface BursaHttpResponse {
  status: number;
  data: string;
  headers?: Record<string, string>;
}

export type BursaHttpGetFn = (
  url: string,
  options?: { timeoutMs?: number; headers?: Record<string, string> }
) => Promise<BursaHttpResponse>;

export interface BursaScraperConfig {
  baseUrl: string;
  userAgent: string;
  intervalMs: number;
  maxPages: number;
  pageDelayMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  respectRobots: boolean;
  enrichDetails: boolean;
  maxDetailsPerRun: number;
}

export interface BursaRunSweepResult {
  started: boolean;
  reason?: "already_running";
  run: BursaRunRecord | null;
}

const ipv4HttpsAgent = new https.Agent({
  family: 4,
  keepAlive: true,
});

export function createDefaultBursaHttpGet(userAgent = "ScrrprrBot/1.0 (+https://approape.ro)"): BursaHttpGetFn {
  const client = axios.create({
    httpsAgent: ipv4HttpsAgent,
    validateStatus: () => true,
  });

  return async (url: string, options?: { timeoutMs?: number; headers?: Record<string, string> }) => {
    const res = await client.get(url, {
      timeout: options?.timeoutMs ?? 15000,
      responseType: "text",
      transformResponse: [(data) => (typeof data === "string" ? data : String(data ?? ""))],
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ro-RO,ro;q=0.9,en;q=0.8",
        ...(options?.headers || {}),
      },
    });

    const normalizedHeaders: Record<string, string> = {};
    if (res.headers && typeof res.headers === "object") {
      for (const [k, v] of Object.entries(res.headers)) {
        if (typeof v === "string") normalizedHeaders[k.toLowerCase()] = v;
        else if (Array.isArray(v) && v.length > 0) normalizedHeaders[k.toLowerCase()] = String(v[0]);
      }
    }

    return {
      status: res.status,
      data: typeof res.data === "string" ? res.data : String(res.data ?? ""),
      headers: normalizedHeaders,
    };
  };
}

export class BursaScraperService {
  private readonly store: BursaV1Store;
  private readonly httpGet: BursaHttpGetFn;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly config: BursaScraperConfig;

  private activeRun: Promise<BursaRunSweepResult> | null = null;
  private runningFlag = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextScheduledRunAt: Date | null = null;
  private lastRobotsDisallows: string[] = [];

  constructor(options: {
    store: BursaV1Store;
    httpGet?: BursaHttpGetFn;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
    config?: Partial<BursaScraperConfig>;
  }) {
    this.store = options.store;
    this.config = {
      baseUrl: options.config?.baseUrl || process.env.BURSA_BASE_URL || "https://bursaplacerilor.com",
      userAgent: options.config?.userAgent || "ScrrprrBot/1.0 (+https://approape.ro)",
      intervalMs:
        options.config?.intervalMs ??
        (Number(process.env.BURSA_SCRAPE_INTERVAL_MS) > 0
          ? Number(process.env.BURSA_SCRAPE_INTERVAL_MS)
          : DEFAULT_WEEKLY_INTERVAL_MS),
      maxPages:
        options.config?.maxPages ??
        (Number(process.env.BURSA_MAX_PAGES) > 0 ? Number(process.env.BURSA_MAX_PAGES) : 25),
      pageDelayMs:
        options.config?.pageDelayMs ??
        (Number(process.env.BURSA_REQUEST_DELAY_MS) >= 0
          ? Number(process.env.BURSA_REQUEST_DELAY_MS)
          : 500),
      requestTimeoutMs: options.config?.requestTimeoutMs ?? 15000,
      maxRetries: options.config?.maxRetries ?? 2,
      retryBackoffMs: options.config?.retryBackoffMs ?? 300,
      respectRobots: options.config?.respectRobots ?? true,
      enrichDetails: options.config?.enrichDetails ?? false,
      maxDetailsPerRun: options.config?.maxDetailsPerRun ?? 20,
    };
    this.httpGet = options.httpGet || createDefaultBursaHttpGet(this.config.userAgent);
    this.now = options.now || (() => new Date());
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  public isRunning(): boolean {
    return this.runningFlag;
  }

  public getConfig(): Readonly<BursaScraperConfig> {
    return this.config;
  }

  public getHealth(): BursaHealthSnapshot {
    return this.store.getHealthSnapshot({
      scraperState: this.runningFlag ? "running" : "idle",
      scheduleIntervalMs: this.config.intervalMs,
      nextScheduledRunAt: this.nextScheduledRunAt ? this.nextScheduledRunAt.toISOString() : null,
      generatedAt: this.now().toISOString(),
    });
  }

  public startScheduler(runImmediately = false): void {
    if (this.timer) return;
    this.nextScheduledRunAt = new Date(this.now().getTime() + this.config.intervalMs);
    this.timer = setInterval(() => {
      this.nextScheduledRunAt = new Date(this.now().getTime() + this.config.intervalMs);
      this.runDiscoverySweep().catch((err) => {
        console.error(`[BURSA_SCRAPER] Scheduled run error: ${sanitizeErrorMessage(err)}`);
      });
    }, this.config.intervalMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }

    if (runImmediately) {
      this.runDiscoverySweep().catch((err) => {
        console.error(`[BURSA_SCRAPER] Initial run error: ${sanitizeErrorMessage(err)}`);
      });
    }
  }

  public stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.nextScheduledRunAt = null;
  }

  private async fetchWithRetry(url: string, allowNotFound = false): Promise<BursaHttpResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = this.config.retryBackoffMs * Math.pow(2, attempt - 1);
          await this.sleep(delay);
        }

        const res = await this.httpGet(url, { timeoutMs: this.config.requestTimeoutMs });

        if (allowNotFound && (res.status === 404 || res.status === 410)) {
          return res;
        }

        if (res.status === 429) {
          const retryAfterRaw = res.headers?.["retry-after"];
          const retrySeconds = retryAfterRaw ? parseInt(retryAfterRaw, 10) : NaN;
          if (attempt < this.config.maxRetries) {
            const waitMs =
              !Number.isNaN(retrySeconds) && retrySeconds > 0
                ? Math.min(retrySeconds * 1000, this.config.retryBackoffMs * 4)
                : this.config.retryBackoffMs * Math.pow(2, attempt);
            await this.sleep(waitMs);
            continue;
          }
          throw new BursaAccessRestrictionError("Rate limited by upstream host (HTTP 429)", "rate_limited", 429);
        }

        if (res.status === 401 || res.status === 403) {
          const restriction = detectAccessRestriction(res.data || "", res.status);
          throw restriction || new BursaAccessRestrictionError(`HTTP ${res.status}`, "forbidden", res.status);
        }

        if (res.status >= 500 || res.status === 408) {
          throw new Error(`Upstream HTTP ${res.status}`);
        }

        if (res.status >= 400) {
          throw new Error(`Upstream client error HTTP ${res.status}`);
        }

        const bodyRestriction = detectAccessRestriction(res.data || "", res.status);
        if (bodyRestriction) {
          throw bodyRestriction;
        }

        return res;
      } catch (err) {
        if (
          err instanceof BursaAccessRestrictionError &&
          (err.reason === "captcha" ||
            err.reason === "auth_required" ||
            err.reason === "forbidden" ||
            err.reason === "robots_disallowed")
        ) {
          // Respect access controls & anti-bot challenges immediately without retrying or bypassing
          throw err;
        }
        lastError = err;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(sanitizeErrorMessage(lastError));
  }

  private async checkRobotsTxt(): Promise<string[]> {
    if (!this.config.respectRobots) {
      return [];
    }
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const robotsUrl = `${base}/robots.txt`;
    try {
      const res = await this.httpGet(robotsUrl, { timeoutMs: Math.min(5000, this.config.requestTimeoutMs) });
      if (res.status === 200 && res.data) {
        const disallows = parseRobotsTxtDisallows(res.data, this.config.userAgent);
        this.lastRobotsDisallows = disallows;
        if (!isPathAllowedByRobots("/", disallows)) {
          throw new BursaAccessRestrictionError(
            "Discovery aborted: path disallowed by robots.txt",
            "robots_disallowed",
            200
          );
        }
        return disallows;
      }
      this.lastRobotsDisallows = [];
      return [];
    } catch (err) {
      if (err instanceof BursaAccessRestrictionError) throw err;
      // Network error reading robots.txt should not crash tests if offline/missing; treat empty disallows
      this.lastRobotsDisallows = [];
      return [];
    }
  }

  public async checkListingDetail(rawUrl: string): Promise<ExtractedBursaListing> {
    const canonicalUrl = normalizeCanonicalUrl(rawUrl, this.config.baseUrl);
    if (this.config.respectRobots && this.lastRobotsDisallows.length > 0) {
      const pathPart = new URL(canonicalUrl).pathname;
      if (!isPathAllowedByRobots(pathPart, this.lastRobotsDisallows)) {
        throw new BursaAccessRestrictionError(
          `Detail URL disallowed by robots.txt: ${pathPart}`,
          "robots_disallowed",
          200
        );
      }
    }
    const res = await this.fetchWithRetry(canonicalUrl, true);
    const extracted = parseDetailPage(res.data, canonicalUrl, this.config.baseUrl, res.status);
    this.store.recordDetailCheck(extracted, this.now().toISOString());
    return extracted;
  }

  public async runDiscoverySweep(): Promise<BursaRunSweepResult> {
    if (this.runningFlag || this.activeRun) {
      return { started: false, reason: "already_running", run: null };
    }

    this.runningFlag = true;
    const startedAt = this.now().toISOString();
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

    const execute = async (): Promise<BursaRunSweepResult> => {
      const discoveredMap = new Map<string, ExtractedBursaListing>();
      const seenUrls = new Set<string>();
      let pagesScanned = 0;
      let sweepCompleted = false;
      let failed = false;
      let errorSummary: string | null = null;

      try {
        const disallows = await this.checkRobotsTxt();
        const base = this.config.baseUrl.replace(/\/+$/, "");

        let maxDetectedPage = 1;
        let previousPageHadNew = true;

        for (let page = 1; page <= this.config.maxPages; page++) {
          if (page > 1 && this.config.pageDelayMs > 0) {
            await this.sleep(this.config.pageDelayMs);
          }

          const pageUrl = page === 1 ? `${base}/` : `${base}/?pagina=${page}`;
          if (this.config.respectRobots && !isPathAllowedByRobots(new URL(pageUrl).pathname, disallows)) {
            throw new BursaAccessRestrictionError("Listing index disallowed by robots.txt", "robots_disallowed");
          }

          const res = await this.fetchWithRetry(pageUrl, false);
          const parsed = parseDiscoveryPage(res.data, base, page);
          pagesScanned++;

          if (parsed.maxPage > maxDetectedPage) {
            maxDetectedPage = parsed.maxPage;
          }

          if (parsed.listings.length === 0) {
            sweepCompleted = true;
            break;
          }

          let addedThisPage = 0;
          for (const item of parsed.listings) {
            const urlKey = normalizeCanonicalUrl(item.source_url, base);
            // Deduplicate strictly by stable listing ID or canonical URL (never merge distinct listings by phone)
            if (!discoveredMap.has(item.source_listing_id) && !seenUrls.has(urlKey)) {
              discoveredMap.set(item.source_listing_id, item);
              if (urlKey) seenUrls.add(urlKey);
              addedThisPage++;
            }
          }

          // Stop if pagination indicates no next page OR pagination repeated exclusively already-seen items
          if (!parsed.hasNextPage && page >= maxDetectedPage) {
            sweepCompleted = true;
            break;
          }

          if (addedThisPage === 0 && !previousPageHadNew) {
            sweepCompleted = true;
            break;
          }
          previousPageHadNew = addedThisPage > 0;

          if (page === this.config.maxPages) {
            // Reached configured ceiling without scanning entire site pagination if maxDetectedPage > maxPages
            sweepCompleted = maxDetectedPage <= this.config.maxPages;
          }
        }

        // Optional detail enrichment for active discovered listings (bounded by maxDetailsPerRun)
        if (this.config.enrichDetails && discoveredMap.size > 0 && !failed) {
          let detailCount = 0;
          for (const [listingId, card] of discoveredMap.entries()) {
            if (detailCount >= this.config.maxDetailsPerRun) break;
            detailCount++;
            try {
              if (this.config.pageDelayMs > 0) {
                await this.sleep(this.config.pageDelayMs);
              }
              const detailRes = await this.fetchWithRetry(card.source_url, true);
              const detail = parseDetailPage(detailRes.data, card.source_url, base, detailRes.status);
              discoveredMap.set(listingId, {
                ...card,
                source_listing_id: detail.source_listing_id.startsWith("bp_")
                  ? card.source_listing_id
                  : detail.source_listing_id,
                title: detail.title ?? card.title,
                description: detail.description !== null ? detail.description : card.description,
                location:
                  detail.location.city || detail.location.county || detail.location.raw
                    ? detail.location
                    : card.location,
                contact:
                  detail.contact.phone !== null || detail.contact.normalized_phone !== null
                    ? detail.contact
                    : card.contact,
                published_at: detail.published_at ?? card.published_at,
                updated_at: detail.updated_at ?? card.updated_at,
                status: detail.status,
              });
            } catch (detailErr) {
              if (
                detailErr instanceof BursaAccessRestrictionError &&
                (detailErr.reason === "captcha" ||
                  detailErr.reason === "rate_limited" ||
                  detailErr.reason === "robots_disallowed")
              ) {
                throw detailErr;
              }
              // Single detail fetch glitch leaves card snapshot intact
            }
          }
        }
      } catch (err) {
        failed = true;
        sweepCompleted = false;
        errorSummary = sanitizeErrorMessage(err);
        console.error(`[BURSA_SCRAPER] Sweep ${runId} failed: ${errorSummary}`);
      }

      const finishedAt = this.now().toISOString();
      const run = this.store.recordDiscoverySweep(Array.from(discoveredMap.values()), {
        runId,
        startedAt,
        finishedAt,
        pagesScanned,
        sweepCompleted,
        failed,
        errorSummary,
      });

      return { started: true, run };
    };

    this.activeRun = execute().finally(() => {
      this.runningFlag = false;
      this.activeRun = null;
    });

    return this.activeRun;
  }
}

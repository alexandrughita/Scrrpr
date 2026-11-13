import crypto from "crypto";
import express from "express";
import {
  BURSA_SCHEMA_VERSION,
  BURSA_SOURCE_NAME,
  type BursaApiErrorEnvelope,
  type BursaChangeField,
  type BursaListingStatus,
} from "./types";
import type { BursaScraperService } from "./scraper";
import type { BursaV1Store } from "./store";
import { sanitizeErrorMessage } from "./parser";

const VALID_STATUSES = new Set<BursaListingStatus>(["active", "inactive", "removed", "unknown"]);
const VALID_CHANGE_FIELDS = new Set<BursaChangeField>([
  "title",
  "description",
  "location",
  "contact",
  "status",
  "published_at",
  "source_url",
]);

export interface BursaRouterOptions {
  store: BursaV1Store;
  scraper: BursaScraperService;
  getApiKey?: () => string;
}

function makeErrorEnvelope(code: string, message: string, generatedAt = new Date().toISOString()): BursaApiErrorEnvelope {
  return {
    source: BURSA_SOURCE_NAME,
    schema_version: BURSA_SCHEMA_VERSION,
    generated_at: generatedAt,
    error: {
      code,
      message,
    },
  };
}

function timingSafeMatch(provided: string, expected: string): boolean {
  const bufA = Buffer.from(provided, "utf-8");
  const bufB = Buffer.from(expected, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parsePaginationParams(
  query: express.Request["query"]
): { page: number; per_page: number } | { error: string } {
  const rawPage = query.page;
  const rawPerPage = query.per_page;

  let page = 1;
  if (rawPage !== undefined) {
    const parsed = Number(rawPage);
    if (!Number.isInteger(parsed) || parsed < 1 || String(rawPage).trim() === "") {
      return { error: "Query parameter 'page' must be an integer >= 1" };
    }
    page = parsed;
  }

  let per_page = 50;
  if (rawPerPage !== undefined) {
    const parsed = Number(rawPerPage);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100 || String(rawPerPage).trim() === "") {
      return { error: "Query parameter 'per_page' must be an integer between 1 and 100" };
    }
    per_page = parsed;
  }

  return { page, per_page };
}

function parseIsoTimestampParam(raw: unknown, paramName: string): { value?: string; error?: string } {
  if (raw === undefined) return {};
  if (typeof raw !== "string" || !raw.trim()) {
    return { error: `Query parameter '${paramName}' must be a non-empty ISO 8601 UTC timestamp` };
  }
  const ms = Date.parse(raw.trim());
  if (Number.isNaN(ms)) {
    return { error: `Query parameter '${paramName}' is not a valid ISO 8601 timestamp` };
  }
  return { value: new Date(ms).toISOString() };
}

function getOptionalStringParam(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createBursaV1Router(options: BursaRouterOptions): express.Router {
  const router = express.Router();

  const resolveExpectedApiKey = (): string => {
    if (options.getApiKey) return options.getApiKey().trim();
    return (process.env.BURSA_API_KEY || process.env.API_KEY || "").trim();
  };

  // Strict server-to-server API key authentication for all /api/v1/bursa/* endpoints
  router.use((req, res, next) => {
    const expectedKey = resolveExpectedApiKey();
    if (!expectedKey) {
      return res
        .status(503)
        .json(
          makeErrorEnvelope(
            "AUTH_NOT_CONFIGURED",
            "Server API key is not configured (set BURSA_API_KEY or API_KEY)"
          )
        );
    }

    let providedToken = "";
    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string") {
      const m = authHeader.match(/^Bearer\s+(.+)$/i);
      if (m) providedToken = m[1].trim();
    }

    if (!providedToken) {
      const xApiKey = req.headers["x-api-key"];
      if (typeof xApiKey === "string") {
        providedToken = xApiKey.trim();
      }
    }

    if (!providedToken || !timingSafeMatch(providedToken, expectedKey)) {
      return res
        .status(401)
        .json(makeErrorEnvelope("UNAUTHORIZED", "Missing or invalid API key"));
    }

    next();
  });

  // GET /api/v1/bursa/listings
  router.get("/listings", (req, res) => {
    try {
      const pagination = parsePaginationParams(req.query);
      if ("error" in pagination) {
        return res.status(400).json(makeErrorEnvelope("INVALID_PARAMETER", pagination.error));
      }

      const updatedSinceRes = parseIsoTimestampParam(req.query.updated_since, "updated_since");
      if (updatedSinceRes.error) {
        return res.status(400).json(makeErrorEnvelope("INVALID_PARAMETER", updatedSinceRes.error));
      }

      const rawStatus = getOptionalStringParam(req.query.status);
      if (rawStatus && !VALID_STATUSES.has(rawStatus as BursaListingStatus)) {
        return res
          .status(400)
          .json(
            makeErrorEnvelope(
              "INVALID_PARAMETER",
              "Query parameter 'status' must be one of: active, inactive, removed, unknown"
            )
          );
      }

      const result = options.store.queryListings({
        page: pagination.page,
        per_page: pagination.per_page,
        updated_since: updatedSinceRes.value,
        status: rawStatus as BursaListingStatus | undefined,
        city: getOptionalStringParam(req.query.city),
        county: getOptionalStringParam(req.query.county),
        source_listing_id: getOptionalStringParam(req.query.source_listing_id),
      });

      return res.json({
        source: BURSA_SOURCE_NAME,
        schema_version: BURSA_SCHEMA_VERSION,
        generated_at: new Date().toISOString(),
        data: result.data,
        pagination: result.pagination,
      });
    } catch (err) {
      return res
        .status(500)
        .json(makeErrorEnvelope("INTERNAL_ERROR", sanitizeErrorMessage(err)));
    }
  });

  // GET /api/v1/bursa/listings/:id
  router.get("/listings/:id", (req, res) => {
    try {
      const listing = options.store.getListingById(req.params.id);
      if (!listing) {
        return res
          .status(404)
          .json(makeErrorEnvelope("NOT_FOUND", "Listing not found"));
      }

      return res.json({
        source: BURSA_SOURCE_NAME,
        schema_version: BURSA_SCHEMA_VERSION,
        generated_at: new Date().toISOString(),
        data: listing,
      });
    } catch (err) {
      return res
        .status(500)
        .json(makeErrorEnvelope("INTERNAL_ERROR", sanitizeErrorMessage(err)));
    }
  });

  // GET /api/v1/bursa/changes
  router.get("/changes", (req, res) => {
    try {
      const pagination = parsePaginationParams(req.query);
      if ("error" in pagination) {
        return res.status(400).json(makeErrorEnvelope("INVALID_PARAMETER", pagination.error));
      }

      const rawUpdatedSince = req.query.updated_since ?? req.query.since;
      const paramName = req.query.updated_since !== undefined ? "updated_since" : "since";
      const updatedSinceRes = parseIsoTimestampParam(rawUpdatedSince, paramName);
      if (updatedSinceRes.error) {
        return res.status(400).json(makeErrorEnvelope("INVALID_PARAMETER", updatedSinceRes.error));
      }

      const rawStatus = getOptionalStringParam(req.query.status);
      if (rawStatus && !VALID_STATUSES.has(rawStatus as BursaListingStatus)) {
        return res
          .status(400)
          .json(
            makeErrorEnvelope(
              "INVALID_PARAMETER",
              "Query parameter 'status' must be one of: active, inactive, removed, unknown"
            )
          );
      }

      const rawField = getOptionalStringParam(req.query.field);
      if (rawField && !VALID_CHANGE_FIELDS.has(rawField as BursaChangeField)) {
        return res
          .status(400)
          .json(
            makeErrorEnvelope(
              "INVALID_PARAMETER",
              "Query parameter 'field' must be one of: title, description, location, contact, status, published_at, source_url"
            )
          );
      }

      const result = options.store.queryChanges({
        page: pagination.page,
        per_page: pagination.per_page,
        updated_since: updatedSinceRes.value,
        status: rawStatus as BursaListingStatus | undefined,
        city: getOptionalStringParam(req.query.city),
        county: getOptionalStringParam(req.query.county),
        source_listing_id: getOptionalStringParam(req.query.source_listing_id),
        field: rawField as BursaChangeField | undefined,
      });

      return res.json({
        source: BURSA_SOURCE_NAME,
        schema_version: BURSA_SCHEMA_VERSION,
        generated_at: new Date().toISOString(),
        data: result.data,
        pagination: result.pagination,
      });
    } catch (err) {
      return res
        .status(500)
        .json(makeErrorEnvelope("INTERNAL_ERROR", sanitizeErrorMessage(err)));
    }
  });

  // GET /api/v1/bursa/health
  router.get("/health", (req, res) => {
    try {
      const snapshot = options.scraper.getHealth();
      return res.json(snapshot);
    } catch (err) {
      return res
        .status(500)
        .json(makeErrorEnvelope("INTERNAL_ERROR", sanitizeErrorMessage(err)));
    }
  });

  return router;
}

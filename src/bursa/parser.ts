import * as cheerio from "cheerio";
import crypto from "crypto";
import type {
  BursaContactInfo,
  BursaListingStatus,
  BursaStructuredLocation,
  ExtractedBursaListing,
} from "./types";

export class BursaAccessRestrictionError extends Error {
  public readonly statusCode?: number;
  public readonly reason: "captcha" | "auth_required" | "robots_disallowed" | "forbidden" | "rate_limited";

  constructor(
    message: string,
    reason: "captcha" | "auth_required" | "robots_disallowed" | "forbidden" | "rate_limited",
    statusCode?: number
  ) {
    super(message);
    this.name = "BursaAccessRestrictionError";
    this.reason = reason;
    this.statusCode = statusCode;
  }
}

export const ROMANIAN_COUNTIES: Array<{ slug: string; canonical: string; seat: string }> = [
  { slug: "alba", canonical: "Alba", seat: "Alba Iulia" },
  { slug: "arad", canonical: "Arad", seat: "Arad" },
  { slug: "arges", canonical: "Arges", seat: "Pitesti" },
  { slug: "bacau", canonical: "Bacau", seat: "Bacau" },
  { slug: "bihor", canonical: "Bihor", seat: "Oradea" },
  { slug: "bistrita-nasaud", canonical: "Bistrita-Nasaud", seat: "Bistrita" },
  { slug: "botosani", canonical: "Botosani", seat: "Botosani" },
  { slug: "braila", canonical: "Braila", seat: "Braila" },
  { slug: "brasov", canonical: "Brasov", seat: "Brasov" },
  { slug: "bucuresti", canonical: "Bucuresti", seat: "Bucuresti" },
  { slug: "buzau", canonical: "Buzau", seat: "Buzau" },
  { slug: "calarasi", canonical: "Calarasi", seat: "Calarasi" },
  { slug: "caras-severin", canonical: "Caras-Severin", seat: "Resita" },
  { slug: "cluj", canonical: "Cluj", seat: "Cluj-Napoca" },
  { slug: "constanta", canonical: "Constanta", seat: "Constanta" },
  { slug: "covasna", canonical: "Covasna", seat: "Sfantu Gheorghe" },
  { slug: "dambovita", canonical: "Dambovita", seat: "Targoviste" },
  { slug: "dolj", canonical: "Dolj", seat: "Craiova" },
  { slug: "galati", canonical: "Galati", seat: "Galati" },
  { slug: "giurgiu", canonical: "Giurgiu", seat: "Giurgiu" },
  { slug: "gorj", canonical: "Gorj", seat: "Targu Jiu" },
  { slug: "harghita", canonical: "Harghita", seat: "Miercurea Ciuc" },
  { slug: "hunedoara", canonical: "Hunedoara", seat: "Deva" },
  { slug: "ialomita", canonical: "Ialomita", seat: "Slobozia" },
  { slug: "iasi", canonical: "Iasi", seat: "Iasi" },
  { slug: "ilfov", canonical: "Ilfov", seat: "Ilfov" },
  { slug: "maramures", canonical: "Maramures", seat: "Baia Mare" },
  { slug: "mehedinti", canonical: "Mehedinti", seat: "Drobeta-Turnu Severin" },
  { slug: "mures", canonical: "Mures", seat: "Targu Mures" },
  { slug: "neamt", canonical: "Neamt", seat: "Piatra Neamt" },
  { slug: "olt", canonical: "Olt", seat: "Slatina" },
  { slug: "prahova", canonical: "Prahova", seat: "Ploiesti" },
  { slug: "salaj", canonical: "Salaj", seat: "Zalau" },
  { slug: "satu-mare", canonical: "Satu Mare", seat: "Satu Mare" },
  { slug: "sibiu", canonical: "Sibiu", seat: "Sibiu" },
  { slug: "suceava", canonical: "Suceava", seat: "Suceava" },
  { slug: "teleorman", canonical: "Teleorman", seat: "Alexandria" },
  { slug: "timis", canonical: "Timis", seat: "Timisoara" },
  { slug: "tulcea", canonical: "Tulcea", seat: "Tulcea" },
  { slug: "valcea", canonical: "Valcea", seat: "Ramnicu Valcea" },
  { slug: "vaslui", canonical: "Vaslui", seat: "Vaslui" },
  { slug: "vrancea", canonical: "Vrancea", seat: "Focsani" },
];

export function stripDiacritics(input: string): string {
  return input
    .replace(/[ăâ]/g, "a")
    .replace(/[ĂÂ]/g, "A")
    .replace(/[î]/g, "i")
    .replace(/[Î]/g, "I")
    .replace(/[șş]/g, "s")
    .replace(/[ȘŞ]/g, "S")
    .replace(/[țţ]/g, "t")
    .replace(/[ȚŢ]/g, "T");
}

export function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "Unknown error");
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/(?:\+?40|0040|0)7\d{8}/g, "[REDACTED_PHONE]");
}

export function normalizeCanonicalUrl(rawUrl: string, baseUrl = "https://bursaplacerilor.com"): string {
  if (!rawUrl) return "";
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  try {
    const resolved = trimmed.startsWith("http")
      ? new URL(trimmed)
      : new URL(trimmed.startsWith("/") ? trimmed : `/${trimmed}`, baseUrl);
    resolved.hash = "";
    resolved.search = "";
    const normalizedPath = resolved.pathname.replace(/\/+$/, "") || "/";
    return `${resolved.protocol}//${resolved.host.toLowerCase()}${normalizedPath === "/" ? "/" : `${normalizedPath}/`}`;
  } catch {
    return trimmed.split("?")[0].split("#")[0].trim();
  }
}

export function deriveStableSourceListingId(
  sourceUrl: string,
  imageUrls: string[] = [],
  explicitDomId?: string | null
): string {
  if (explicitDomId) {
    const cleanDom = String(explicitDomId).trim();
    if (/^[a-zA-Z0-9_-]{3,64}$/.test(cleanDom)) {
      return cleanDom;
    }
  }

  // Bursa upload image filenames consistently carry the stable numeric listing ID: /uploads/<county>/<cat>/<postId>_0.webp
  for (const img of imageUrls) {
    const m = String(img || "").match(/\/(\d{4,10})_\d+\.(?:webp|jpe?g|png)/i);
    if (m) {
      return m[1];
    }
  }

  // Fallback: check URL path for explicit numeric listing ID (distinct from 10-digit 07xxxxxxxx phone numbers)
  const canonical = normalizeCanonicalUrl(sourceUrl);
  try {
    const pathname = new URL(canonical).pathname;
    const segments = pathname.split("/").filter(Boolean);
    for (const seg of segments) {
      if (/^\d{4,9}$/.test(seg) && !/^07\d+$/.test(seg)) {
        return seg;
      }
    }
    // Deterministic hash over canonical path so record ID remains stable regardless of domain scheme
    const digest = crypto.createHash("sha256").update(pathname).digest("hex").slice(0, 16);
    return `bp_${digest}`;
  } catch {
    const digest = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    return `bp_${digest}`;
  }
}

export function deriveInternalRecordId(sourceListingId: string): string {
  const digest = crypto.createHash("sha256").update(`bursa:${sourceListingId}`).digest("hex").slice(0, 20);
  return `bursa_${digest}`;
}

export function normalizeContact(rawPhone: string | null | undefined): BursaContactInfo {
  if (rawPhone === null || rawPhone === undefined) {
    return { phone: null, normalized_phone: null };
  }
  const trimmed = String(rawPhone).trim();
  if (trimmed === "") {
    return { phone: "", normalized_phone: null };
  }
  if (/click|reveal|arat[aă]/i.test(trimmed)) {
    return { phone: null, normalized_phone: null };
  }
  let digits = trimmed.replace(/\D/g, "");
  if (!digits || digits.length < 9) {
    return { phone: trimmed, normalized_phone: null };
  }
  if (digits.startsWith("0040") && digits.length >= 13) {
    digits = "0" + digits.slice(4);
  } else if (digits.startsWith("40") && digits.length >= 11) {
    digits = "0" + digits.slice(2);
  }
  if (digits.length === 9 && digits.startsWith("7")) {
    digits = "0" + digits;
  }
  const normalized = digits.length === 10 && /^0[237]\d{8}$/.test(digits) ? digits : digits;
  return {
    phone: trimmed,
    normalized_phone: normalized,
  };
}

export function extractStructuredLocation(
  rawMetaText: string | null | undefined,
  sourceUrl: string,
  title: string | null | undefined,
  bodyText = "",
  explicitCounty?: string | null
): BursaStructuredLocation {
  const raw = rawMetaText === null || rawMetaText === undefined
    ? null
    : rawMetaText.replace(/📍/g, "").replace(/\s+/g, " ").trim();

  const countyInfoFromSlug = (slugOrText: string) => {
    const norm = stripDiacritics(slugOrText).toLowerCase().trim();
    return ROMANIAN_COUNTIES.find(
      (c) =>
        norm === c.slug ||
        norm === c.canonical.toLowerCase() ||
        norm.includes(c.canonical.toLowerCase()) ||
        norm.includes(c.slug)
    );
  };

  let county: string | null = null;
  let city: string | null = null;

  // 1. Check URL path first for reliable county & sector segments (/bucuresti/sector-3/..., /timis/...)
  try {
    const parsed = new URL(sourceUrl.startsWith("http") ? sourceUrl : `https://bursaplacerilor.com/${sourceUrl}`);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (pathParts.length > 0) {
      const cMatch = countyInfoFromSlug(pathParts[0]);
      if (cMatch) county = cMatch.canonical;
    }
    const sectorInUrl = parsed.pathname.match(/sector[-_]?([1-6])/i);
    if (sectorInUrl) {
      county = "Bucuresti";
      city = `Bucuresti Sector ${sectorInUrl[1]}`;
    }
  } catch {}

  if (!county && explicitCounty) {
    const cMatch = countyInfoFromSlug(explicitCounty);
    if (cMatch) county = cMatch.canonical;
  }

  // 2. Inspect raw metadata (e.g. "Sector 3, București" or "Timișoara, Timiș" or "Cluj")
  if (raw) {
    const sectorInMeta = raw.match(/sector(?:ul)?\s*([1-6])/i);
    if (sectorInMeta) {
      county = "Bucuresti";
      city = `Bucuresti Sector ${sectorInMeta[1]}`;
    } else {
      const parts = raw
        .split(/[,|]+/)
        .map((p) => p.trim())
        .filter(Boolean);
      for (const part of parts) {
        const cMatch = countyInfoFromSlug(part);
        if (cMatch && !county) {
          county = cMatch.canonical;
        } else if (part && !city && !/^rom[aâ]nia$/i.test(stripDiacritics(part))) {
          city = stripDiacritics(part);
        }
      }
      if (!city && county) {
        const cEntry = ROMANIAN_COUNTIES.find((c) => c.canonical === county);
        if (cEntry && parts.length === 1 && stripDiacritics(parts[0]).toLowerCase() === cEntry.seat.toLowerCase()) {
          city = cEntry.seat;
        }
      }
    }
  }

  // 3. Check title/body for Bucharest sector hints when county is Bucuresti
  if (county === "Bucuresti" && !city) {
    const sectorMatch = `${title || ""} ${bodyText}`.match(/sector(?:ul)?\s*([1-6])/i);
    if (sectorMatch) {
      city = `Bucuresti Sector ${sectorMatch[1]}`;
    } else {
      city = "Bucuresti";
    }
  }

  // 4. If county is known (e.g. Timis) and city is still null, check body/title or use county seat only if mentioned or leave city null if unknown
  if (county && !city) {
    const cEntry = ROMANIAN_COUNTIES.find((c) => c.canonical === county);
    if (cEntry) {
      const combinedNorm = stripDiacritics(`${sourceUrl} ${title || ""} ${bodyText}`).toLowerCase();
      if (combinedNorm.includes(cEntry.seat.toLowerCase())) {
        city = cEntry.seat;
      }
    }
  }

  return {
    city: city ? stripDiacritics(city) : null,
    county: county ? stripDiacritics(county) : null,
    raw: raw === "" ? "" : raw,
  };
}

export function parseBursaDateToIso(rawDate: string | null | undefined): string | null {
  if (!rawDate) return null;
  const trimmed = rawDate.trim();
  if (!trimmed) return null;

  // Format: "2026-11-07 22:10:36" or ISO 8601
  if (/^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) {
    const isoCandidate = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
    const withTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(isoCandidate)
      ? isoCandidate
      : isoCandidate.includes(":")
        ? `${isoCandidate}Z`
        : `${isoCandidate}T00:00:00.000Z`;
    const parsed = new Date(withTz);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  const ddmmyyyy = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
  if (ddmmyyyy) {
    const [, dd, mm, yyyy, hh = "00", min = "00"] = ddmmyyyy;
    const parsed = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return null;
}

export function extractFullTitle($: cheerio.CheerioAPI): string | null {
  const genericHeaders = new Set([
    "bursaplacerilor",
    "bursaplacerilor.com",
    "escorte",
    "matrimoniale",
    "anunturi",
    "anunțuri",
    "anunt",
    "anunț",
  ]);

  let jsonLdTitle = "";
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const ld = JSON.parse($(el).html() || "{}");
      const items = Array.isArray(ld) ? ld : [ld];
      for (const item of items) {
        const cand = item?.name || item?.headline;
        if (typeof cand === "string") {
          const clean = cand.replace(/\s+/g, " ").trim();
          if (clean.length > jsonLdTitle.length && !genericHeaders.has(clean.toLowerCase())) {
            jsonLdTitle = clean;
          }
        }
      }
    } catch {}
  });

  let bestH1 = "";
  $("h1").each((_, el) => {
    const clean = $(el).text().replace(/\s+/g, " ").trim();
    if (clean.length > bestH1.length && !genericHeaders.has(clean.toLowerCase())) {
      bestH1 = clean;
    }
  });

  const rawMeta = (
    $("meta[property='og:title']").attr("content") ||
    $("meta[name='twitter:title']").attr("content") ||
    $("title").first().text() ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim();

  const cleanMeta = rawMeta
    .replace(/^07\d{8}\s*[-–|]\s*/i, "")
    .replace(/\s*\|\s*(?:Escorte|Matrimoniale|Masaj|Saloane)[^|]*\|\s*BursaPlacerilor\.com.*$/i, "")
    .replace(/\s*\|\s*Bursa\s*Placerilor(?:\.com)?.*$/i, "")
    .replace(/\s*-\s*Bursa\s*Placerilor(?:\.com)?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  let best = bestH1 || jsonLdTitle || cleanMeta || "";
  if (jsonLdTitle && jsonLdTitle.length > best.length) {
    best = jsonLdTitle;
  }
  if (!best && cleanMeta && !genericHeaders.has(cleanMeta.toLowerCase())) {
    best = cleanMeta;
  }

  return best ? best : null;
}

export function detectAccessRestriction(html: string, statusCode?: number): BursaAccessRestrictionError | null {
  if (statusCode === 429) {
    return new BursaAccessRestrictionError("Rate limited by upstream host (HTTP 429)", "rate_limited", 429);
  }
  if (statusCode === 401) {
    return new BursaAccessRestrictionError("Authentication required by upstream host (HTTP 401)", "auth_required", 401);
  }
  if (statusCode === 403) {
    return new BursaAccessRestrictionError("Access forbidden by upstream host (HTTP 403)", "forbidden", 403);
  }

  const lower = html.toLowerCase();
  if (
    lower.includes("cf-challenge") ||
    lower.includes("challenge-platform") ||
    lower.includes("g-recaptcha") ||
    lower.includes("hcaptcha") ||
    lower.includes("verify you are human")
  ) {
    return new BursaAccessRestrictionError("Anti-bot / CAPTCHA challenge encountered; aborting without bypass", "captcha", statusCode);
  }

  return null;
}

export function isBursaExcludedListing(item: {
  title?: string | null;
  description?: string | null;
  source_url?: string;
  location_raw?: string | null;
  category?: string | null;
}): boolean {
  const rawText = `${item.title || ""} ${item.description || ""} ${item.source_url || ""} ${item.location_raw || ""} ${item.category || ""}`.toLowerCase();
  const text = stripDiacritics(rawText);

  if (/\/gay-lesbi\//i.test(text) || /\/transex\w*\//i.test(text) || /\/ts\//i.test(text)) return true;
  if (text.includes("transexuale") || text.includes("gay-lesbi") || text.includes("travesti")) return true;

  const excludedPatterns = [
    /\btrans\b/i,
    /\btrans[_-]/i,
    /\btransex\w*/i,
    /\btranssex\w*/i,
    /\btrasex\w*/i,
    /\btravesti\w*/i,
    /\bshe-?male\b/i,
    /\blady-?boy\b/i,
    /\bfemboy\b/i,
    /\bts\b/i,
    /\b(pentru|pt\.?)\s+(femei|doamne|domnisoare)/i,
    /\bdoamne\s+si\s+domnisoare\b/i,
    /\bmaseur\s+(domn|barbat)\b/i,
  ];
  return excludedPatterns.some((pat) => pat.test(text));
}

export interface ParsedDiscoveryPage {
  listings: ExtractedBursaListing[];
  maxPage: number;
  hasNextPage: boolean;
}

export function parseDiscoveryPage(
  html: string,
  baseUrl = "https://bursaplacerilor.com",
  currentPage = 1
): ParsedDiscoveryPage {
  const restriction = detectAccessRestriction(html, 200);
  if (restriction) throw restriction;

  const $ = cheerio.load(html);
  let maxPage = currentPage;

  $("a[href*='pagina='], .pagination a").each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/pagina=(\d+)/);
    if (m) {
      const p = parseInt(m[1], 10);
      if (!Number.isNaN(p) && p > maxPage) maxPage = p;
    }
    const numText = $(el).text().trim();
    if (/^\d+$/.test(numText)) {
      const p = parseInt(numText, 10);
      if (!Number.isNaN(p) && p > maxPage) maxPage = p;
    }
  });

  const listings: ExtractedBursaListing[] = [];

  $(".card")
    .not(".card-of")
    .each((_, el) => {
      const $card = $(el);
      const titleEl = $card.find(".card-title").first();
      const titleText = titleEl.length > 0 ? titleEl.text().replace(/\s+/g, " ").trim() : "";
      const rawHref = $card.find("a").first().attr("href") || "";

      if (!rawHref && !titleText) return;

      const sourceUrl = normalizeCanonicalUrl(rawHref, baseUrl);
      if (!sourceUrl) return;

      const imgs: string[] = [];
      $card.find("img").each((__, imgEl) => {
        const s = $(imgEl).attr("data-src") || $(imgEl).attr("src") || "";
        if (s && !s.includes("no-photo")) {
          const abs = s.startsWith("http") ? s : `${baseUrl}${s.startsWith("/") ? "" : "/"}${s}`;
          imgs.push(abs);
        }
      });

      const explicitId = $card.attr("data-id") || $card.attr("data-listing-id") || null;
      const sourceListingId = deriveStableSourceListingId(sourceUrl, imgs, explicitId);

      const metaEl = $card.find(".card-meta").first();
      const rawMeta = metaEl.length > 0 ? metaEl.text().replace(/📍/g, "").replace(/\s+/g, " ").trim() : null;
      let locationMeta = rawMeta;
      let category: string | null = null;
      if (rawMeta && rawMeta.includes("·")) {
        const parts = rawMeta.split("·");
        locationMeta = parts[0].trim();
        category = parts.slice(1).join("·").trim();
      }

      let rawPhone: string | null = null;
      const phoneText = $card.find(".card-phone-num, .card-phone").first().text().trim();
      if (phoneText) {
        rawPhone = phoneText;
      } else {
        const urlPhoneMatch = sourceUrl.match(/\/(\d{10})\//);
        if (urlPhoneMatch) rawPhone = urlPhoneMatch[1];
      }

      if (
        isBursaExcludedListing({
          title: titleText,
          source_url: sourceUrl,
          location_raw: locationMeta,
          category,
        })
      ) {
        return;
      }

      const structuredLoc = extractStructuredLocation(locationMeta, sourceUrl, titleText);
      const cardDescEl = $card.find(".card-desc, .card-description").first();
      const description = cardDescEl.length > 0 ? cardDescEl.text().replace(/\s+/g, " ").trim() : null;

      const dateAttr = $card.find("time, [datetime], .card-date").first();
      const rawDate = dateAttr.attr("datetime") || (dateAttr.length > 0 ? dateAttr.text().trim() : null);

      listings.push({
        source_listing_id: sourceListingId,
        source_url: sourceUrl,
        title: titleText || null,
        description,
        location: structuredLoc,
        contact: normalizeContact(rawPhone),
        published_at: parseBursaDateToIso(rawDate),
        updated_at: null,
        status: "active",
      });
    });

  return {
    listings,
    maxPage,
    hasNextPage: currentPage < maxPage,
  };
}

export function parseDetailPage(
  html: string,
  rawUrl: string,
  baseUrl = "https://bursaplacerilor.com",
  statusCode = 200
): ExtractedBursaListing {
  const sourceUrl = normalizeCanonicalUrl(rawUrl, baseUrl);
  const restriction = detectAccessRestriction(html, statusCode);
  if (restriction) throw restriction;

  if (statusCode === 404 || statusCode === 410) {
    return {
      source_listing_id: deriveStableSourceListingId(sourceUrl),
      source_url: sourceUrl,
      title: null,
      description: null,
      location: { city: null, county: null, raw: null },
      contact: { phone: null, normalized_phone: null },
      published_at: null,
      updated_at: null,
      status: "removed",
    };
  }

  const $ = cheerio.load(html);
  const bodyText = $("body").text();
  const isRemoved =
    /anun[țt]ul nu mai este activ|anun[țt]ul a expirat|anun[țt] expirat|anun[țt]ul a fost [șs]ters|nu a fost g[aă]sit/i.test(
      bodyText
    );

  const images: string[] = [];
  $(".gallery-thumbs .gallery-thumb, .gallery-main img, .anunt-gallery img, img").each((_, im) => {
    const s = $(im).attr("data-src") || $(im).attr("src") || "";
    if (s && /\/\d{4,10}_\d+\./.test(s)) {
      images.push(s);
    }
  });

  let publishedAt: string | null = null;
  let updatedAt: string | null = null;
  let jsonLdDesc: string | null = null;
  let jsonLdPhone: string | null = null;
  let jsonLdLocality: string | null = null;
  let jsonLdRegion: string | null = null;

  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const ld = JSON.parse($(el).html() || "{}");
      const items = Array.isArray(ld) ? ld : [ld];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        if (typeof item.description === "string") {
          const clean = item.description.replace(/\s+/g, " ").trim();
          if (jsonLdDesc === null || clean.length > jsonLdDesc.length) {
            jsonLdDesc = clean;
          }
        }
        if (typeof item.telephone === "string" && !jsonLdPhone) {
          jsonLdPhone = item.telephone.trim();
        }
        if (typeof item.datePublished === "string" && !publishedAt) {
          publishedAt = parseBursaDateToIso(item.datePublished);
        }
        if (typeof item.dateModified === "string" && !updatedAt) {
          updatedAt = parseBursaDateToIso(item.dateModified);
        }
        if (item.address && typeof item.address === "object") {
          if (typeof item.address.addressLocality === "string" && item.address.addressLocality.trim()) {
            jsonLdLocality = item.address.addressLocality.trim();
          }
          if (typeof item.address.addressRegion === "string" && item.address.addressRegion.trim()) {
            jsonLdRegion = item.address.addressRegion.trim();
          }
        }
        if (Array.isArray(item.image)) {
          for (const imgUrl of item.image) {
            if (typeof imgUrl === "string") images.push(imgUrl);
          }
        }
      }
    } catch {}
  });

  // Distinguish missing description container (null) from explicit empty description container ("")
  let description: string | null = null;
  if ($(".anunt-desc").length > 0) {
    const descClone = $(".anunt-desc").first().clone();
    descClone.find("h1, h2, h3, h4, script, style, .ad-of-wrap, button").remove();
    descClone.find("br").replaceWith(" ");
    const htmlDesc = descClone.text().replace(/^Descriere\s*/i, "").replace(/\s+/g, " ").trim();
    if (htmlDesc === "") {
      description = jsonLdDesc && jsonLdDesc.length > 0 ? jsonLdDesc : "";
    } else {
      description = jsonLdDesc && jsonLdDesc.length > htmlDesc.length ? jsonLdDesc : htmlDesc;
    }
  } else if (jsonLdDesc !== null) {
    description = jsonLdDesc;
  }

  let breadcrumbRawParts: string[] = [];
  $(".breadcrumb a, .breadcrumb span").each((_, sp) => {
    const t = $(sp).text().trim();
    if (t && !/acas[aă]|escorte|matrimoniale|\d{10}/i.test(t)) {
      if (!breadcrumbRawParts.includes(t)) breadcrumbRawParts.push(t);
    }
  });
  const combinedRawLoc = [jsonLdLocality, jsonLdRegion, ...breadcrumbRawParts]
    .filter((v): v is string => Boolean(v && v.trim()))
    .join(", ");

  const title = extractFullTitleFromNode($);
  const location = extractStructuredLocation(
    combinedRawLoc || null,
    sourceUrl,
    title,
    bodyText,
    jsonLdRegion
  );

  let rawPhone = jsonLdPhone;
  if (!rawPhone) {
    const telHref = $("a[href^='tel:']").first().attr("href");
    if (telHref) rawPhone = telHref.replace(/^tel:/i, "").trim();
  }
  if (!rawPhone) {
    const cardPhone = $(".card-phone-num, .card-phone").first().text().trim();
    if (cardPhone) rawPhone = cardPhone;
  }
  if (!rawPhone) {
    const urlPhoneMatch = sourceUrl.match(/\/(\d{10})\//);
    if (urlPhoneMatch) rawPhone = urlPhoneMatch[1];
  }

  const status: BursaListingStatus = isRemoved ? "removed" : "active";

  return {
    source_listing_id: deriveStableSourceListingId(sourceUrl, images),
    source_url: sourceUrl,
    title,
    description,
    location,
    contact: normalizeContact(rawPhone),
    published_at: publishedAt,
    updated_at: updatedAt,
    status,
  };
}

function extractFullTitleFromNode($: cheerio.CheerioAPI): string | null {
  return extractFullTitle($);
}

export function parseRobotsTxtDisallows(robotsTxt: string, userAgent = "ScrrprrBot"): string[] {
  const lines = robotsTxt.split(/\r?\n/);
  const disallowsForSpecific: string[] = [];
  const disallowsForWildcard: string[] = [];
  let currentAgents: string[] = [];
  let hasRulesInBlock = false;
  const targetLower = userAgent.toLowerCase();

  for (const rawLine of lines) {
    const line = rawLine.split("#")[0].trim();
    if (!line) {
      currentAgents = [];
      hasRulesInBlock = false;
      continue;
    }

    const uaMatch = line.match(/^User-agent:\s*(.+)$/i);
    if (uaMatch) {
      if (hasRulesInBlock) {
        currentAgents = [];
        hasRulesInBlock = false;
      }
      currentAgents.push(uaMatch[1].trim().toLowerCase());
      continue;
    }

    const disallowMatch = line.match(/^Disallow:\s*(.*)$/i);
    if (disallowMatch && currentAgents.length > 0) {
      hasRulesInBlock = true;
      const rulePath = disallowMatch[1].trim();
      if (!rulePath) continue;
      if (currentAgents.some((a) => targetLower.includes(a) && a !== "*")) {
        disallowsForSpecific.push(rulePath);
      } else if (currentAgents.includes("*")) {
        disallowsForWildcard.push(rulePath);
      }
    }
  }

  return disallowsForSpecific.length > 0 ? disallowsForSpecific : disallowsForWildcard;
}

export function isPathAllowedByRobots(urlPath: string, disallows: string[]): boolean {
  for (const rule of disallows) {
    if (rule === "/") return false;
    if (urlPath.startsWith(rule)) return false;
  }
  return true;
}

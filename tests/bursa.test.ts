import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import express from "express";
import {
  deriveStableSourceListingId,
  parseDetailPage,
  parseDiscoveryPage,
  parseRobotsTxtDisallows,
  isPathAllowedByRobots,
  sanitizeErrorMessage,
} from "../src/bursa/parser";
import { BursaV1Store } from "../src/bursa/store";
import { BursaScraperService, type BursaHttpGetFn } from "../src/bursa/scraper";
import { createBursaV1Router } from "../src/bursa/router";
import { BURSA_SCHEMA_VERSION, BURSA_SOURCE_NAME } from "../src/bursa/types";

function makeCardHtml(opts: {
  href: string;
  title: string;
  meta: string;
  phone?: string;
  imgSrc?: string;
  dataId?: string;
  desc?: string;
  date?: string;
}): string {
  return `
    <div class="card" ${opts.dataId ? `data-id="${opts.dataId}"` : ""}>
      <a href="${opts.href}">
        ${opts.imgSrc ? `<img src="${opts.imgSrc}" alt="${opts.title}" />` : ""}
        <div class="card-title">${opts.title}</div>
        <div class="card-meta">${opts.meta}</div>
        ${opts.phone ? `<div class="card-phone-num">${opts.phone}</div>` : ""}
        ${opts.desc !== undefined ? `<div class="card-desc">${opts.desc}</div>` : ""}
        ${opts.date ? `<time datetime="${opts.date}">${opts.date}</time>` : ""}
      </a>
    </div>
  `;
}

function wrapPageHtml(cardsHtml: string, paginationHtml = ""): string {
  return `<!doctype html><html><head><title>Bursa</title></head><body><main>${cardsHtml}${paginationHtml}</main></body></html>`;
}

function makeDetailHtml(opts: {
  title: string;
  h1?: string;
  descHtml?: string | null;
  jsonLd?: Record<string, unknown>;
  breadcrumbs?: string[];
  telHref?: string;
  images?: string[];
  expiredNotice?: string;
}): string {
  const ldScript = opts.jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(opts.jsonLd)}</script>`
    : "";
  const crumbs = (opts.breadcrumbs || []).map((c) => `<span>${c}</span>`).join("");
  const imgs = (opts.images || []).map((src) => `<img class="gallery-thumb" src="${src}" />`).join("");
  const descBlock = opts.descHtml !== undefined && opts.descHtml !== null ? `<div class="anunt-desc">${opts.descHtml}</div>` : "";
  return `<!doctype html>
  <html>
    <head>
      <title>${opts.title} | Escorte Timis | BursaPlacerilor.com</title>
      ${ldScript}
    </head>
    <body>
      <div class="breadcrumb">${crumbs}</div>
      <h1>${opts.h1 ?? opts.title}</h1>
      ${opts.expiredNotice ? `<div class="notice">${opts.expiredNotice}</div>` : ""}
      ${descBlock}
      ${opts.telHref ? `<a href="tel:${opts.telHref}">${opts.telHref}</a>` : ""}
      <div class="gallery-thumbs">${imgs}</div>
    </body>
  </html>`;
}

async function withRouterServer(
  router: express.Router,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/bursa", router);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("Bursa v1 Scraper, Store, and Approape API", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrrprr-bursa-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("1. extracts full Bursa listing fields, numeric ID priority, structured location, null vs empty distinction, and UTC dates", () => {
    // Stable numeric listing ID prioritized over URL hash
    const numericFromImg = deriveStableSourceListingId(
      "https://bursaplacerilor.com/timis/ana-frumoasa-0712345678/",
      ["https://bursaplacerilor.com/uploads/timis/escorte/54362_0.webp"]
    );
    assert.equal(numericFromImg, "54362");

    // Hash fallback is deterministic when numeric ID absent (ignores 07xxxxxxxx phone segments)
    const hashA = deriveStableSourceListingId("https://bursaplacerilor.com/cluj/eva-0799887766/");
    const hashB = deriveStableSourceListingId("https://bursaplacerilor.com/cluj/eva-0799887766?ref=1");
    assert.match(hashA, /^bp_[a-f0-9]{16}$/);
    assert.equal(hashA, hashB);

    // Detail extraction: full title with pipes, full description, structured location, normalized phone, ISO 8601 UTC date
    const detailHtml = makeDetailHtml({
      title: "Elena VIP | Masaj & Relaxare | Ultracentral",
      descHtml: "Ofer masaj profesionist si companie placuta in Timisoara, zona centrala.",
      jsonLd: {
        "@type": "Product",
        name: "Elena VIP | Masaj & Relaxare | Ultracentral",
        description: "Ofer masaj profesionist si companie placuta in Timisoara, zona centrala.",
        telephone: "+40 723 111 222",
        datePublished: "2026-11-10 14:30:00",
        dateModified: "2026-11-12 09:15:00",
        address: { addressLocality: "Timisoara", addressRegion: "Timis" },
        image: ["/uploads/timis/escorte/99102_0.webp"],
      },
    });

    const parsed = parseDetailPage(
      detailHtml,
      "https://bursaplacerilor.com/timis/elena-vip/",
      "https://bursaplacerilor.com",
      200
    );

    assert.equal(parsed.source_listing_id, "99102");
    assert.equal(parsed.title, "Elena VIP | Masaj & Relaxare | Ultracentral");
    assert.equal(parsed.description, "Ofer masaj profesionist si companie placuta in Timisoara, zona centrala.");
    assert.deepEqual(parsed.location, {
      city: "Timisoara",
      county: "Timis",
      raw: "Timisoara, Timis",
    });
    assert.deepEqual(parsed.contact, {
      phone: "+40 723 111 222",
      normalized_phone: "0723111222",
    });
    assert.equal(parsed.published_at, "2026-11-10T14:30:00.000Z");
    assert.equal(parsed.updated_at, "2026-11-12T09:15:00.000Z");
    assert.equal(parsed.status, "active");

    // Empty description container ("") vs missing container (null)
    const emptyDescHtml = makeDetailHtml({ title: "Bianca", descHtml: "   " });
    const emptyParsed = parseDetailPage(emptyDescHtml, "https://bursaplacerilor.com/arad/bianca/", "https://bursaplacerilor.com");
    assert.equal(emptyParsed.description, "");

    const missingDescHtml = makeDetailHtml({ title: "Bianca", descHtml: null });
    const missingParsed = parseDetailPage(missingDescHtml, "https://bursaplacerilor.com/arad/bianca/", "https://bursaplacerilor.com");
    assert.equal(missingParsed.description, null);

    // Excluded listings (e.g. trans / pentru femei) are skipped on discovery
    const discoveryHtml = wrapPageHtml(
      makeCardHtml({
        href: "/timis/excluded-item/",
        title: "Trans model in Timisoara",
        meta: "Timis · Escorte",
        imgSrc: "/uploads/timis/11111_0.webp",
      }) +
        makeCardHtml({
          href: "/cluj/maria-cluj/",
          title: "Maria Cluj",
          meta: "Cluj-Napoca, Cluj · Escorte",
          phone: "0744112233",
          imgSrc: "/uploads/cluj/22222_0.webp",
        })
    );
    const discovery = parseDiscoveryPage(discoveryHtml);
    assert.equal(discovery.listings.length, 1);
    assert.equal(discovery.listings[0].source_listing_id, "22222");
    assert.equal(discovery.listings[0].location.city, "Cluj-Napoca");
    assert.equal(discovery.listings[0].location.county, "Cluj");
  });

  it("2 & 3. handles multi-page pagination, deduplicates across pages, and never merges separate records by phone", async () => {
    const store = new BursaV1Store(tmpDir);
    const page1 = wrapPageHtml(
      [
        makeCardHtml({
          href: "/timis/alina-centru/",
          title: "Alina Centru",
          meta: "Timisoara, Timis · Escorte",
          phone: "0722000111",
          imgSrc: "/uploads/timis/10001_0.webp",
        }),
        makeCardHtml({
          href: "/arad/alina-arad/",
          title: "Alina Second Listing Same Phone",
          meta: "Arad, Arad · Escorte",
          phone: "0722000111", // Same phone, DIFFERENT listing ID & URL -> must remain 2 distinct records!
          imgSrc: "/uploads/arad/10002_0.webp",
        }),
      ].join(""),
      `<div class="pagination"><a href="/?pagina=2">2</a><a href="/?pagina=3">3</a></div>`
    );

    const page2 = wrapPageHtml(
      [
        // Duplicate from page 1 -> must be deduplicated
        makeCardHtml({
          href: "/timis/alina-centru/?ref=promoted",
          title: "Alina Centru",
          meta: "Timisoara, Timis · Escorte",
          phone: "0722000111",
          imgSrc: "/uploads/timis/10001_0.webp",
        }),
        makeCardHtml({
          href: "/bucuresti/sector-3/sara/",
          title: "Sara Sector 3",
          meta: "Sector 3, Bucuresti · Escorte",
          phone: "0733999888",
          imgSrc: "/uploads/bucuresti/10003_0.webp",
        }),
      ].join(""),
      `<div class="pagination"><a href="/?pagina=3">3</a></div>`
    );

    const page3 = wrapPageHtml(
      makeCardHtml({
        href: "/iasi/ioana-copou/",
        title: "Ioana Copou",
        meta: "Iasi, Iasi · Escorte",
        phone: "0744555666",
        imgSrc: "/uploads/iasi/10004_0.webp",
      })
    );

    const visitedUrls: string[] = [];
    const httpGet: BursaHttpGetFn = async (url) => {
      visitedUrls.push(url);
      if (url.endsWith("/robots.txt")) return { status: 404, data: "" };
      if (url.includes("pagina=2")) return { status: 200, data: page2 };
      if (url.includes("pagina=3")) return { status: 200, data: page3 };
      return { status: 200, data: page1 };
    };

    const scraper = new BursaScraperService({
      store,
      httpGet,
      sleep: async () => {},
      config: { baseUrl: "https://bursaplacerilor.com", pageDelayMs: 0, maxPages: 10 },
    });

    const res = await scraper.runDiscoverySweep();
    assert.equal(res.started, true);
    assert.ok(res.run);
    assert.equal(res.run.outcome, "success");
    assert.equal(res.run.sweep_completed, true);
    assert.equal(res.run.pages_scanned, 3);
    assert.equal(res.run.listings_discovered, 4);
    assert.equal(res.run.new_count, 4);

    // Confirm the two listings sharing 0722000111 stayed separate
    const q = store.queryListings({ page: 1, per_page: 50 });
    assert.equal(q.data.length, 4);
    const ids = new Set(q.data.map((d) => d.source_listing_id));
    assert.ok(ids.has("10001"));
    assert.ok(ids.has("10002"));
    assert.ok(ids.has("10003"));
    assert.ok(ids.has("10004"));
    assert.ok(visitedUrls.some((u) => u.includes("pagina=2")));
    assert.ok(visitedUrls.some((u) => u.includes("pagina=3")));
  });

  it("4, 5 & 6. tracks new listings, append-only location changes across runs, and leaves unchanged listings quiet", async () => {
    let tick = Date.parse("2026-11-01T10:00:00.000Z");
    const store = new BursaV1Store(tmpDir);

    let currentHtml = wrapPageHtml(
      makeCardHtml({
        href: "/arad/diana/",
        title: "Diana Arad",
        meta: "Arad · Escorte",
        phone: "0755111222",
        imgSrc: "/uploads/arad/55001_0.webp",
      })
    );

    const scraper = new BursaScraperService({
      store,
      now: () => new Date(tick),
      sleep: async () => {},
      httpGet: async (url) => {
        if (url.endsWith("/robots.txt")) return { status: 404, data: "" };
        return { status: 200, data: currentHtml };
      },
      config: { baseUrl: "https://bursaplacerilor.com", pageDelayMs: 0 },
    });

    // Run 1: New listing
    const run1 = await scraper.runDiscoverySweep();
    assert.equal(run1.run?.new_count, 1);
    const afterRun1 = store.getListingById("55001");
    assert.ok(afterRun1);
    assert.equal(afterRun1.first_seen_at, "2026-11-01T10:00:00.000Z");
    assert.equal(afterRun1.last_updated_at, "2026-11-01T10:00:00.000Z");
    assert.equal(afterRun1.changes.length, 0);

    // Run 2: Unchanged listing -> updates last_seen_at & last_checked_at, preserves last_updated_at & emits 0 changes
    tick = Date.parse("2026-11-08T10:00:00.000Z");
    const run2 = await scraper.runDiscoverySweep();
    assert.equal(run2.run?.unchanged_count, 1);
    assert.equal(run2.run?.changed_count, 0);
    const afterRun2 = store.getListingById("55001")!;
    assert.equal(afterRun2.first_seen_at, "2026-11-01T10:00:00.000Z");
    assert.equal(afterRun2.last_seen_at, "2026-11-08T10:00:00.000Z");
    assert.equal(afterRun2.last_checked_at, "2026-11-08T10:00:00.000Z");
    assert.equal(afterRun2.last_updated_at, "2026-11-01T10:00:00.000Z");
    assert.equal(afterRun2.changes.length, 0);

    // Run 3: Location moved Arad -> Timisoara (keeping same numeric listing ID 55001)
    tick = Date.parse("2026-11-14T10:00:00.000Z");
    currentHtml = wrapPageHtml(
      makeCardHtml({
        href: "/timis/diana/",
        title: "Diana Arad",
        meta: "Timisoara, Timis · Escorte",
        phone: "0755111222",
        imgSrc: "/uploads/timis/55001_0.webp",
      })
    );
    const run3 = await scraper.runDiscoverySweep();
    assert.equal(run3.run?.changed_count, 1);

    // Run 4: Location moved Timisoara -> Cluj-Napoca -> old history must NOT be overwritten
    tick = Date.parse("2026-11-21T10:00:00.000Z");
    currentHtml = wrapPageHtml(
      makeCardHtml({
        href: "/cluj/diana/",
        title: "Diana Arad",
        meta: "Cluj-Napoca, Cluj · Escorte",
        phone: "0755111222",
        imgSrc: "/uploads/cluj/55001_0.webp",
      })
    );
    await scraper.runDiscoverySweep();

    // Reload store from disk to verify durable JSON persistence
    const reloadedStore = new BursaV1Store(tmpDir);
    const reloaded = reloadedStore.getListingById("55001")!;
    assert.equal(reloaded.location.city, "Cluj-Napoca");
    assert.equal(reloaded.location.county, "Cluj");
    assert.equal(reloaded.last_updated_at, "2026-11-21T10:00:00.000Z");

    const locChanges = reloaded.changes.filter((c) => c.field === "location");
    assert.equal(locChanges.length, 2);
    assert.equal((locChanges[0].old_value as any).county, "Timis");
    assert.equal((locChanges[0].new_value as any).city, "Cluj-Napoca");
    assert.equal((locChanges[1].old_value as any).raw, "Arad");
    assert.equal((locChanges[1].new_value as any).city, "Timisoara");
  });

  it("7. marks absent listings inactive after 1 full non-empty sweep, reactivates if seen again, and marks removed on 404/expired", async () => {
    let tick = Date.parse("2026-11-01T10:00:00.000Z");
    const store = new BursaV1Store(tmpDir);

    const htmlBoth = wrapPageHtml(
      makeCardHtml({ href: "/timis/a/", title: "Listing A", meta: "Timis · Escorte", imgSrc: "/uploads/timis/70001_0.webp" }) +
        makeCardHtml({ href: "/timis/b/", title: "Listing B", meta: "Timis · Escorte", imgSrc: "/uploads/timis/70002_0.webp" })
    );
    const htmlOnlyA = wrapPageHtml(
      makeCardHtml({ href: "/timis/a/", title: "Listing A", meta: "Timis · Escorte", imgSrc: "/uploads/timis/70001_0.webp" })
    );

    let mode: "both" | "onlyA" | "bothAgain" = "both";
    let detailStatus = 200;

    const scraper = new BursaScraperService({
      store,
      now: () => new Date(tick),
      sleep: async () => {},
      httpGet: async (url) => {
        if (url.endsWith("/robots.txt")) return { status: 404, data: "" };
        if (url.includes("/timis/b/")) {
          return { status: detailStatus, data: detailStatus === 404 ? "Nu a fost gasit" : "" };
        }
        return { status: 200, data: mode === "onlyA" ? htmlOnlyA : htmlBoth };
      },
      config: { baseUrl: "https://bursaplacerilor.com", pageDelayMs: 0 },
    });

    await scraper.runDiscoverySweep();
    assert.equal(store.getListingById("70002")?.status, "active");

    // Listing B absent in next full sweep -> inactive (and last_seen_at unchanged)
    tick = Date.parse("2026-11-08T10:00:00.000Z");
    mode = "onlyA";
    const sweep2 = await scraper.runDiscoverySweep();
    assert.equal(sweep2.run?.inactivated_count, 1);
    const bInactive = store.getListingById("70002")!;
    assert.equal(bInactive.status, "inactive");
    assert.equal(bInactive.last_seen_at, "2026-11-01T10:00:00.000Z");
    assert.equal(bInactive.last_checked_at, "2026-11-08T10:00:00.000Z");

    // Reappears -> back to active
    tick = Date.parse("2026-11-15T10:00:00.000Z");
    mode = "bothAgain";
    await scraper.runDiscoverySweep();
    assert.equal(store.getListingById("70002")?.status, "active");

    // Confirmed 404 on detail check -> removed
    tick = Date.parse("2026-11-16T10:00:00.000Z");
    detailStatus = 404;
    await scraper.checkListingDetail("https://bursaplacerilor.com/timis/b/");
    const bRemoved = store.getListingById("70002")!;
    assert.equal(bRemoved.status, "removed");
    assert.equal(bRemoved.changes[0].field, "status");
    assert.equal(bRemoved.changes[0].new_value, "removed");
  });

  it("8. preserves active listings on failed runs and zero-result sweeps, retries transient 503, enforces robots.txt and concurrency lock", async () => {
    let tick = Date.parse("2026-11-01T10:00:00.000Z");
    const store = new BursaV1Store(tmpDir);

    const htmlOne = wrapPageHtml(
      makeCardHtml({
        href: "/timis/stela/",
        title: "Stela",
        meta: "Timisoara, Timis · Escorte",
        phone: "0766111222",
        imgSrc: "/uploads/timis/80001_0.webp",
      })
    );

    let scenario: "ok" | "fail_500" | "zero_results" | "retry_recover" | "captcha" | "robots_disallow" = "ok";
    let attemptCount = 0;

    const scraper = new BursaScraperService({
      store,
      now: () => new Date(tick),
      sleep: async () => {},
      httpGet: async (url) => {
        if (url.endsWith("/robots.txt")) {
          if (scenario === "robots_disallow") {
            return { status: 200, data: "User-agent: *\nDisallow: /\n" };
          }
          return { status: 404, data: "" };
        }
        if (scenario === "fail_500") {
          return { status: 500, data: "Server error for Bearer secret_abc_123 phone 0766111222" };
        }
        if (scenario === "zero_results") {
          return { status: 200, data: "<html><body><div>Niciun anunt momentan</div></body></html>" };
        }
        if (scenario === "captcha") {
          return { status: 200, data: "<div class='cf-challenge'>Verify you are human</div>" };
        }
        if (scenario === "retry_recover") {
          attemptCount++;
          if (attemptCount === 1) return { status: 503, data: "Busy" };
          return { status: 200, data: htmlOne };
        }
        return { status: 200, data: htmlOne };
      },
      config: { baseUrl: "https://bursaplacerilor.com", pageDelayMs: 0, maxRetries: 2, retryBackoffMs: 1 },
    });

    // Initial discovery succeeds
    await scraper.runDiscoverySweep();
    assert.equal(store.getListingById("80001")?.status, "active");

    // Failed run must NOT mark active listing inactive
    tick = Date.parse("2026-11-08T10:00:00.000Z");
    scenario = "fail_500";
    const failRun = await scraper.runDiscoverySweep();
    assert.equal(failRun.run?.outcome, "failed");
    assert.equal(store.getListingById("80001")?.status, "active");

    // Zero-result sweep must NOT deactivate active listing and flags success_zero_results
    tick = Date.parse("2026-11-09T10:00:00.000Z");
    scenario = "zero_results";
    const zeroRun = await scraper.runDiscoverySweep();
    assert.equal(zeroRun.run?.outcome, "success_zero_results");
    assert.equal(store.getListingById("80001")?.status, "active");

    // CAPTCHA challenge fails cleanly without attempting bypass
    tick = Date.parse("2026-11-10T10:00:00.000Z");
    scenario = "captcha";
    const captchaRun = await scraper.runDiscoverySweep();
    assert.equal(captchaRun.run?.outcome, "failed");
    assert.match(captchaRun.run?.error_summary || "", /captcha/i);

    // robots.txt Disallow: / blocks sweep cleanly
    tick = Date.parse("2026-11-11T10:00:00.000Z");
    scenario = "robots_disallow";
    const robotsRun = await scraper.runDiscoverySweep();
    assert.equal(robotsRun.run?.outcome, "failed");
    assert.match(robotsRun.run?.error_summary || "", /robots\.txt/i);
    assert.equal(store.getListingById("80001")?.status, "active");

    // Direct robots helper verification
    const disallows = parseRobotsTxtDisallows("User-agent: ScrrprrBot\nDisallow: /private/\n");
    assert.equal(isPathAllowedByRobots("/timis/stela/", disallows), true);
    assert.equal(isPathAllowedByRobots("/private/x", disallows), false);

    // Transient 503 recovers on retry
    tick = Date.parse("2026-11-12T10:00:00.000Z");
    scenario = "retry_recover";
    const retryRun = await scraper.runDiscoverySweep();
    assert.equal(retryRun.run?.outcome, "success");
    assert.equal(attemptCount, 2);

    // Log/error sanitization strips tokens & phone numbers
    const sanitized = sanitizeErrorMessage("Failed Bearer tok12345 for 0722334455");
    assert.ok(!sanitized.includes("tok12345"));
    assert.ok(!sanitized.includes("0722334455"));

    // Concurrent duplicate run lock prevents overlapping jobs
    let releaseSlowFetch!: () => void;
    const slowScraper = new BursaScraperService({
      store,
      sleep: async () => {},
      httpGet: async (url) => {
        if (url.endsWith("/robots.txt")) return { status: 404, data: "" };
        await new Promise<void>((r) => {
          releaseSlowFetch = r;
        });
        return { status: 200, data: htmlOne };
      },
      config: { baseUrl: "https://bursaplacerilor.com", pageDelayMs: 0 },
    });

    const firstPromise = slowScraper.runDiscoverySweep();
    // Yield microtask so slowScraper enters fetch
    await new Promise((r) => setTimeout(r, 10));
    const concurrentCall = await slowScraper.runDiscoverySweep();
    assert.equal(concurrentCall.started, false);
    assert.equal(concurrentCall.reason, "already_running");
    releaseSlowFetch();
    const firstResult = await firstPromise;
    assert.equal(firstResult.started, true);
  });

  it("9, 10 & 11. enforces API authentication, filtering, pagination, consistent v1 schema, and zero PII in health", async () => {
    const store = new BursaV1Store(tmpDir);

    // Populate two observations with a location change on one
    store.recordDiscoverySweep(
      [
        {
          source_listing_id: "30001",
          source_url: "https://bursaplacerilor.com/arad/ana/",
          title: "Ana Arad",
          description: null,
          location: { city: "Arad", county: "Arad", raw: "Arad" },
          contact: { phone: "0721000001", normalized_phone: "0721000001" },
          published_at: null,
          updated_at: null,
          status: "active",
        },
        {
          source_listing_id: "30002",
          source_url: "https://bursaplacerilor.com/iasi/bia/",
          title: "Bia Iasi",
          description: "Full description here",
          location: { city: "Iasi", county: "Iasi", raw: "Iasi, Iasi" },
          contact: { phone: "0721000002", normalized_phone: "0721000002" },
          published_at: "2026-11-01T10:00:00.000Z",
          updated_at: null,
          status: "active",
        },
      ],
      {
        runId: "run_1",
        startedAt: "2026-11-01T10:00:00.000Z",
        finishedAt: "2026-11-01T10:01:00.000Z",
        pagesScanned: 1,
        sweepCompleted: true,
        failed: false,
        errorSummary: null,
      }
    );

    // Move 30001 to Timisoara, leave 30002 absent -> inactive
    store.recordDiscoverySweep(
      [
        {
          source_listing_id: "30001",
          source_url: "https://bursaplacerilor.com/timis/ana/",
          title: "Ana Timisoara",
          description: "Detalii Timisoara",
          location: { city: "Timisoara", county: "Timis", raw: "Timisoara, Timis" },
          contact: { phone: "0721000001", normalized_phone: "0721000001" },
          published_at: null,
          updated_at: null,
          status: "active",
        },
      ],
      {
        runId: "run_2",
        startedAt: "2026-11-08T10:00:00.000Z",
        finishedAt: "2026-11-08T10:01:00.000Z",
        pagesScanned: 1,
        sweepCompleted: true,
        failed: false,
        errorSummary: null,
      }
    );

    const scraper = new BursaScraperService({ store });
    const router = createBursaV1Router({
      store,
      scraper,
      getApiKey: () => "test-secret-api-key-999",
    });

    await withRouterServer(router, async (baseUrl) => {
      // Unauthenticated requests rejected with structured 401
      const unauth = await fetch(`${baseUrl}/api/v1/bursa/listings`);
      assert.equal(unauth.status, 401);
      const unauthJson = await unauth.json();
      assert.equal(unauthJson.source, BURSA_SOURCE_NAME);
      assert.equal(unauthJson.schema_version, BURSA_SCHEMA_VERSION);
      assert.equal(unauthJson.error.code, "UNAUTHORIZED");

      // Wrong key rejected
      const wrongKey = await fetch(`${baseUrl}/api/v1/bursa/health`, {
        headers: { Authorization: "Bearer wrong-key" },
      });
      assert.equal(wrongKey.status, 401);

      // Valid Bearer token -> /listings with pagination & filters
      const listRes = await fetch(
        `${baseUrl}/api/v1/bursa/listings?city=Timisoara&county=Timis&status=active&page=1&per_page=10`,
        { headers: { Authorization: "Bearer test-secret-api-key-999" } }
      );
      assert.equal(listRes.status, 200);
      const listJson = await listRes.json();
      assert.equal(listJson.source, "bursa");
      assert.equal(listJson.schema_version, "1.0");
      assert.match(listJson.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.deepEqual(listJson.pagination, { page: 1, per_page: 10, total: 1, total_pages: 1 });
      assert.equal(listJson.data[0].source_listing_id, "30001");
      assert.equal(listJson.data[0].contact.normalized_phone, "0721000001");
      assert.ok(listJson.data[0].changes.some((c: any) => c.field === "location"));

      // Filter by updated_since & source_listing_id via X-Api-Key
      const bySourceId = await fetch(
        `${baseUrl}/api/v1/bursa/listings?source_listing_id=30002&updated_since=2026-11-05T00:00:00Z`,
        { headers: { "X-Api-Key": "test-secret-api-key-999" } }
      );
      assert.equal(bySourceId.status, 200);
      const bySourceJson = await bySourceId.json();
      assert.equal(bySourceJson.pagination.total, 1);
      assert.equal(bySourceJson.data[0].status, "inactive");

      // Single listing endpoint + 404 envelope
      const singleOk = await fetch(`${baseUrl}/api/v1/bursa/listings/30001`, {
        headers: { Authorization: "Bearer test-secret-api-key-999" },
      });
      assert.equal(singleOk.status, 200);
      const singleJson = await singleOk.json();
      assert.equal(singleJson.data.source_listing_id, "30001");

      const singleMissing = await fetch(`${baseUrl}/api/v1/bursa/listings/does-not-exist`, {
        headers: { Authorization: "Bearer test-secret-api-key-999" },
      });
      assert.equal(singleMissing.status, 404);
      const missingJson = await singleMissing.json();
      assert.equal(missingJson.error.code, "NOT_FOUND");

      // Invalid parameter -> 400
      const badQuery = await fetch(`${baseUrl}/api/v1/bursa/listings?status=bogus`, {
        headers: { Authorization: "Bearer test-secret-api-key-999" },
      });
      assert.equal(badQuery.status, 400);

      // /changes pagination & filter
      const changesRes = await fetch(`${baseUrl}/api/v1/bursa/changes?field=location&page=1&per_page=10`, {
        headers: { Authorization: "Bearer test-secret-api-key-999" },
      });
      assert.equal(changesRes.status, 200);
      const changesJson = await changesRes.json();
      assert.equal(changesJson.pagination.total, 1);
      assert.equal(changesJson.data[0].source_listing_id, "30001");
      assert.equal(changesJson.data[0].new_value.city, "Timisoara");

      // /health exposes scraper status & totals without phone numbers or credentials
      const healthRes = await fetch(`${baseUrl}/api/v1/bursa/health`, {
        headers: { Authorization: "Bearer test-secret-api-key-999" },
      });
      assert.equal(healthRes.status, 200);
      const healthText = await healthRes.text();
      assert.ok(!healthText.includes("0721000001"));
      assert.ok(!healthText.includes("test-secret-api-key-999"));
      const healthJson = JSON.parse(healthText);
      assert.equal(healthJson.data.status, "healthy");
      assert.equal(healthJson.data.totals.active, 1);
      assert.equal(healthJson.data.totals.inactive, 1);
      assert.equal(healthJson.data.last_run_outcome, "success");

      // /ads alias returns same v1 payload without 404
      const adsAliasRes = await fetch(`${baseUrl}/api/v1/bursa/ads?city=Timisoara`, {
        headers: { Authorization: "Bearer test-secret-api-key-999" },
      });
      assert.equal(adsAliasRes.status, 200);
      const adsAliasJson = await adsAliasRes.json();
      assert.equal(adsAliasJson.data[0].source_listing_id, "30001");

      // Unknown subpath under /api/v1/bursa/* returns structured v1 404 envelope
      const unknownSubpathRes = await fetch(`${baseUrl}/api/v1/bursa/nonexistent`, {
        headers: { Authorization: "Bearer test-secret-api-key-999" },
      });
      assert.equal(unknownSubpathRes.status, 404);
      const unknownSubpathJson = await unknownSubpathRes.json();
      assert.equal(unknownSubpathJson.source, "bursa");
      assert.equal(unknownSubpathJson.schema_version, "1.0");
      assert.equal(unknownSubpathJson.error.code, "NOT_FOUND");
    });
  });

  it("12. prevents partial failed discovery sweeps from updating, reactivating, or creating listing records", async () => {
    const store = new BursaV1Store(tmpDir);

    // Seed an inactive listing (90001) via sweep 1 then sweep 2 without 90001
    store.recordDiscoverySweep(
      [
        {
          source_listing_id: "90001",
          source_url: "https://bursaplacerilor.com/arad/ada/",
          title: "Ada Original Title",
          description: "Initial description",
          location: { city: "Arad", county: "Arad", raw: "Arad" },
          contact: { phone: "0729000001", normalized_phone: "0729000001" },
          published_at: null,
          updated_at: null,
          status: "active",
        },
        {
          source_listing_id: "90002",
          source_url: "https://bursaplacerilor.com/timis/lara/",
          title: "Lara Active",
          description: null,
          location: { city: "Timisoara", county: "Timis", raw: "Timisoara, Timis" },
          contact: { phone: "0729000002", normalized_phone: "0729000002" },
          published_at: null,
          updated_at: null,
          status: "active",
        },
      ],
      {
        runId: "run_seed_1",
        startedAt: "2026-11-01T10:00:00.000Z",
        finishedAt: "2026-11-01T10:01:00.000Z",
        pagesScanned: 1,
        sweepCompleted: true,
        failed: false,
        errorSummary: null,
      }
    );

    store.recordDiscoverySweep(
      [
        {
          source_listing_id: "90002",
          source_url: "https://bursaplacerilor.com/timis/lara/",
          title: "Lara Active",
          description: null,
          location: { city: "Timisoara", county: "Timis", raw: "Timisoara, Timis" },
          contact: { phone: "0729000002", normalized_phone: "0729000002" },
          published_at: null,
          updated_at: null,
          status: "active",
        },
      ],
      {
        runId: "run_seed_2",
        startedAt: "2026-11-08T10:00:00.000Z",
        finishedAt: "2026-11-08T10:01:00.000Z",
        pagesScanned: 1,
        sweepCompleted: true,
        failed: false,
        errorSummary: null,
      }
    );

    assert.equal(store.getListingById("90001")?.status, "inactive");
    const baselineUpdatedAt = store.getListingById("90001")!.last_updated_at;
    const baselineChangesTotal = store.queryChanges({ page: 1, per_page: 50 }).pagination.total;

    // Multi-page partial failure: page 1 returns a changed/reactivated 90001 + brand new 90003,
    // while page 2 fails with HTTP 500
    const page1Html = wrapPageHtml(
      makeCardHtml({
        href: "/cluj/ada/",
        title: "Ada Mutated On Partial Sweep",
        meta: "Cluj-Napoca, Cluj · Escorte",
        phone: "0729000001",
        imgSrc: "/uploads/cluj/90001_0.webp",
      }) +
        makeCardHtml({
          href: "/cluj/new-item/",
          title: "Brand New On Partial Sweep",
          meta: "Cluj-Napoca, Cluj · Escorte",
          phone: "0729000003",
          imgSrc: "/uploads/cluj/90003_0.webp",
        }),
      `<div class="pagination"><a href="/?pagina=2">2</a></div>`
    );

    const partialFailScraper = new BursaScraperService({
      store,
      sleep: async () => {},
      httpGet: async (url) => {
        if (url.endsWith("/robots.txt")) return { status: 404, data: "" };
        if (url.includes("pagina=2")) return { status: 500, data: "Upstream failure" };
        return { status: 200, data: page1Html };
      },
      config: { baseUrl: "https://bursaplacerilor.com", pageDelayMs: 0, maxRetries: 0 },
    });

    const partialRun = await partialFailScraper.runDiscoverySweep();
    assert.equal(partialRun.run?.outcome, "failed");
    assert.equal(partialRun.run?.sweep_completed, false);
    assert.equal(partialRun.run?.new_count, 0);
    assert.equal(partialRun.run?.changed_count, 0);

    // 90001 MUST remain inactive with original title, location, and timestamp; 90003 MUST NOT exist
    const afterPartial = store.getListingById("90001")!;
    assert.equal(afterPartial.status, "inactive");
    assert.equal(afterPartial.title, "Ada Original Title");
    assert.equal(afterPartial.location.city, "Arad");
    assert.equal(afterPartial.last_updated_at, baselineUpdatedAt);
    assert.equal(store.getListingById("90003"), null);
    assert.equal(store.queryChanges({ page: 1, per_page: 50 }).pagination.total, baselineChangesTotal);
  });
});


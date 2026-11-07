import express from "express";
console.log("[SERVER] Loading server.ts...");
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import axios from "axios";
import qs from "qs";
import * as cheerio from "cheerio";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import https from "https";

// Lazy initialization of Gemini client to comply with best practices
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required and was not found. Please add your key in Settings.");
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        }
      }
    });
    console.log("[SERVER] Gemini client initialized with User-Agent aistudio-build.");
  }
  return aiClient;
}

// Bypass SSL certificate verification globally to handle 526 errors
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const jar = new CookieJar();

const client = wrapper(axios.create({ 
  jar
}));
console.log("[SERVER] Axios client with cookie jar initialized.");

// Create a base client
const baseClient = axios.create();

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Edge/122.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0"
];

const getHeaders = (referer = "https://www.google.com/", isAjax = false) => {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const headers: any = {
    "User-Agent": userAgent,
    "Accept": isAjax ? "*/*" : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate", // Removed 'br' to avoid potential decompression issues if not handled
    "Referer": referer,
    "DNT": "1",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Ch-Ua": '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": isAjax ? "empty" : "document",
    "Sec-Fetch-Mode": isAjax ? "cors" : "navigate",
    "Sec-Fetch-Site": referer.includes("inspector-escorte") ? "same-origin" : "cross-site",
    "Sec-Fetch-User": isAjax ? undefined : "?1",
    "Cache-Control": "max-age=0"
  };
  if (isAjax) {
    headers["X-Requested-With"] = "XMLHttpRequest";
  }
  return headers;
};

/**
 * Extract ad ID from URL in a robust, alphanumeric-compatible way
 */
function extractAdId(url: string): string | null {
  if (!url || typeof url !== "string") return null;
  try {
    const cleanUrl = url.split("?")[0].split("#")[0];
    const parts = cleanUrl.split("/");
    const lastPart = parts[parts.length - 1];
    
    if (lastPart) {
      const withoutHtml = lastPart.replace(".html", "");
      
      // If it contains an underscore, usually the latter part is the ID
      if (withoutHtml.includes("_")) {
        const subparts = withoutHtml.split("_");
        const idCol = subparts[subparts.length - 1];
        if (idCol.length >= 4 && /^[a-zA-Z0-9]+$/.test(idCol)) {
          return idCol;
        }
      }
      
      // If it has hyphens, the last portion might be alphanumeric ID
      if (withoutHtml.includes("-")) {
        const subparts = withoutHtml.split("-");
        const idCol = subparts[subparts.length - 1];
        // If the last part is standard hexadecimal or long alphanumeric string, use it
        if (idCol.length >= 6 && /^[a-zA-Z0-9]+$/.test(idCol)) {
          return idCol;
        }
      }
      
      if (withoutHtml.length >= 3 && /^[a-zA-Z0-9_-]+$/.test(withoutHtml)) {
        return withoutHtml;
      }
    }
  } catch (e) {
    console.error("[extractAdId] Error:", e);
  }
  return null;
}

/**
 * Check if the extracted phone number is a fake brand watermark (e.g. 0724 242 424 or similar)
 */
function isBrandOrFakePhone(digits: string | null | undefined): boolean {
  if (!digits) return false;
  const cleanDigits = digits.replace(/[^\d]/g, "");
  return (
    cleanDigits === "0724242424" ||
    cleanDigits === "242424" ||
    cleanDigits === "2424" ||
    cleanDigits.includes("242424") ||
    (cleanDigits.match(/24/g) || []).length >= 3
  );
}

/**
 * Normalize listing link for deduplication and dictionary keying
 */
function normalizeLink(url: string | null | undefined): string {
  if (!url) return "";
  return url.split("?")[0].split("#")[0].trim().replace(/\/$/, "").toLowerCase();
}

/**
 * Extract clean numeric digits for phone matching and lookup
 */
function cleanPhoneDigits(raw: string | null | undefined): string {
  if (!raw) return "";
  let digits = raw.replace(/[^\d]/g, "");
  if (digits.startsWith("0040") && digits.length >= 13) {
    digits = "0" + digits.slice(4);
  } else if (digits.startsWith("40") && digits.length >= 11) {
    digits = "0" + digits.slice(2);
  }
  return digits;
}

// Global cooldown map to track rate-limited domains
const domainCooldowns = new Map<string, number>();
const sslFailureDomains = new Set<string>(); // Track domains that fail on HTTPS
const MIN_REQUEST_GAP = 2500; // Reduced from 10s to 2.5s to prevent request queuing timeouts
const lastRequestTimes = new Map<string, number>();

/**
 * Check if a domain is currently in cooldown
 */
function checkCooldown(url: string): boolean {
  try {
    const domain = new URL(url).hostname;
    const cooldownUntil = domainCooldowns.get(domain);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      console.log(`[COOLDOWN] Skipping ${domain} until ${new Date(cooldownUntil).toLocaleTimeString()}`);
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Mark a domain as rate-limited
 */
function setCooldown(url: string, durationMs = 60000) { // Default reduced to 1 minute
  try {
    const domain = new URL(url).hostname;
    // If it's already in cooldown, don't overwrite with a shorter one unless it's a 429 specific one
    const existing = domainCooldowns.get(domain) || 0;
    if (existing > Date.now() + durationMs) return;
    
    console.warn(`[COOLDOWN] Domain ${domain} rate-limited. Cooling down for ${durationMs / 1000}s`);
    domainCooldowns.set(domain, Date.now() + durationMs);
  } catch (e) {}
}

/**
 * Ensure minimum gap between requests to the same domain
 */
async function enforceGap(url: string) {
  try {
    const domain = new URL(url).hostname;
    const lastTime = lastRequestTimes.get(domain) || 0;
    const elapsed = Date.now() - lastTime;
    if (elapsed < MIN_REQUEST_GAP) {
      const wait = MIN_REQUEST_GAP - elapsed + Math.random() * 1000;
      await new Promise(r => setTimeout(r, wait));
    }
    lastRequestTimes.set(domain, Date.now());
  } catch (e) {}
}

/**
 * Robust fetch with retry for handling 403s and 500s
 */
async function fetchWithRetry(url: string, options: any = {}, maxRetries = 2, useJar = false) {
  let currentUrl = url;
  try {
    const domain = new URL(url).hostname;
    if (sslFailureDomains.has(domain) && currentUrl.startsWith("https://")) {
      currentUrl = currentUrl.replace("https://", "http://");
      console.log(`[SSL] Using HTTP fallback for known SSL-failing domain: ${domain}`);
    }
  } catch (e) {}

  if (checkCooldown(currentUrl)) {
    throw new Error(`Domain in cooldown: ${new URL(currentUrl).hostname}`);
  }
  
  await enforceGap(currentUrl);
  
  let lastError: any;
  const axiosClient = useJar ? client : baseClient;
  const method = options.method || 'GET';
  const data = options.data || null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Wait before retry (exponential backoff)
        const delay = Math.pow(1.5, attempt) * 500 + Math.random() * 500;
        console.log(`[RETRY] Attempt ${attempt} for ${currentUrl} after ${Math.round(delay)}ms`);
        await new Promise(r => setTimeout(r, delay));
        
        // Rotate headers on retry
        if (options.headers) {
          options.headers = { ...options.headers, ...getHeaders(options.headers.Referer) };
        }
      }
      
      const response = await axiosClient({
        url: currentUrl,
        method,
        data,
        timeout: 20000, // Default timeout
        maxRedirects: 10,
        ...options, // Options can override default timeout
        validateStatus: (status) => status < 500 || status === 404 || status === 403 || status === 429 || status === 526 || status === 503 // Allow 429, 526, 503 to be handled
      });
      
      // If we got a 403, 429, 526 or 503, it might be a block, rate limit or SSL issue, so retry if we have attempts left
      if ((response.status === 403 || response.status === 429 || response.status === 526 || response.status === 503) && attempt < maxRetries) {
        let waitTime = response.status === 429 ? 25000 + Math.random() * 10000 : 2000 + Math.random() * 2000;
        
        if (response.status === 429) {
          const retryAfter = response.headers['retry-after'];
          if (retryAfter) {
            const seconds = parseInt(retryAfter);
            if (!isNaN(seconds)) {
              waitTime = Math.min(seconds * 1000 + 5000, 45000); // Cap at 45s to avoid platform timeouts
              console.log(`[429] Respecting Retry-After header: ${seconds}s (capped at 45s)`);
            }
          }
          setCooldown(currentUrl, Math.max(300000, waitTime)); // Increased minimum cooldown to 5 minutes
        }
        
        // If it's a 526 (SSL error), try switching to HTTP if we're on HTTPS
        if (response.status === 526 && currentUrl.startsWith("https://")) {
          try {
            const domain = new URL(currentUrl).hostname;
            const alreadyFailed = sslFailureDomains.has(domain);
            sslFailureDomains.add(domain);
            const httpUrl = currentUrl.replace("https://", "http://");
            
            if (!alreadyFailed) {
              console.warn(`[SSL] 526 Error for ${currentUrl}, attempting HTTP fallback: ${httpUrl}`);
            }
            
            // For 526, we do a recursive call with HTTP but with 0 retries to avoid any loop
            // We also disable redirects to avoid being pushed back to HTTPS
            const fallbackRes = await fetchWithRetry(httpUrl, { ...options, maxRedirects: 0 }, 0, useJar);
            
            // If the fallback is a redirect back to HTTPS, it's a loop. Return the 526 instead.
            if ((fallbackRes.status === 301 || fallbackRes.status === 302) && 
                fallbackRes.headers['location']?.startsWith("https://")) {
              if (!alreadyFailed) console.log(`[SSL] HTTP fallback for ${domain} redirected back to HTTPS. Domain is likely unusable.`);
              return response; 
            }
            return fallbackRes;
          } catch (e) {
            return response;
          }
        } else {
          console.warn(`[RETRY] ${response.status} for ${currentUrl}, rotating User-Agent and retrying after ${Math.round(waitTime)}ms... (Attempt ${attempt + 1}/${maxRetries})`);
        }
        // Wait even longer on these errors
        await new Promise(r => setTimeout(r, waitTime));
        const referer = options.headers?.Referer || "https://www.google.com/";
        options.headers = { ...getHeaders(referer) }; // Fresh headers including new UA
        continue;
      }
      
      // If it was a block but we're out of retries, throw it so it's caught as an error
      if (response.status === 403 || response.status === 429 || response.status === 526 || response.status === 503) {
        if (response.status === 429) {
          setCooldown(url, 600000); // 10 minutes cooldown if all retries hit 429
        }
        const error: any = new Error(`Request failed with status ${response.status}`);
        error.response = response;
        error.status = response.status;
        throw error;
      }
      
      // If we got a Cloudflare challenge, retry if we have attempts left
      const isRealChallenge = response.data && typeof response.data === 'string' && 
          ((response.data.toLowerCase().includes("just a moment...") || 
            response.data.toLowerCase().includes("checking your browser") ||
            response.data.toLowerCase().includes("__cf_chl_opt") ||
            response.data.toLowerCase().includes("cf-browser-verification") ||
            response.data.toLowerCase().includes("cf-challenge") ||
            response.data.toLowerCase().includes("ray id:")) &&
           !response.data.includes("site-publi24") &&
           !response.data.includes("logo-publi24"));

      if (isRealChallenge && attempt < maxRetries) {
        console.warn(`[RETRY] Bot challenge/Cloudflare detected for ${url}, waiting and retrying...`);
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        const referer = options.headers?.Referer || "https://www.google.com/";
        options.headers = { ...getHeaders(referer) }; // Fresh headers including new UA
        continue;
      }
      
      return response;
    } catch (error: any) {
      lastError = error;
      const status = error.response?.status;
      
      // Retry on 403, 429, 5xx, or network errors
      if ((status === 403 || status === 429 || status >= 500 || 
           error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || 
           error.code === 'ENOTFOUND' || error.code === 'ECONNABORTED' ||
           (error.message && (error.message.includes('timeout') || error.message.includes('Network Error')))) && 
          attempt < maxRetries) {
        console.log(`[FETCH] Retrying ${url} (Attempt ${attempt + 1}/${maxRetries}) due to ${status || error.code || 'error'}`);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

/**
 * Nimfomane Scraper Logic
 */
class NimfomaneScraper {
  private loggedIn = false;
  private baseUrl = "https://www.nimfomane.com/forum";

  async login() {
    if (this.loggedIn) return true;
    
    const username = process.env.NIMFOMANE_USER;
    const password = process.env.NIMFOMANE_PASS;
    
    if (!username || !password) {
      console.warn("[NIMFOMANE] Missing credentials in environment variables (NIMFOMANE_USER or NIMFOMANE_PASS).");
      return false;
    }

    try {
      console.log(`[NIMFOMANE] Attempting login for user: ${username}`);
      
      // 1. Get login page to get CSRF token
      const loginPage = await fetchWithRetry(`${this.baseUrl}/login/`, {
        headers: getHeaders(this.baseUrl)
      }, 3, true);
      
      if (loginPage.status === 403) {
        console.error("[NIMFOMANE] 403 Forbidden on login page. Site might be blocking this IP.");
        return false;
      }

      const $ = cheerio.load(loginPage.data);
      
      // Check if already logged in first
      if (loginPage.data.includes("Log out") || loginPage.data.includes("/logout/") || loginPage.data.includes("Account details")) {
        console.log("[NIMFOMANE] Already logged in (detected from login page)!");
        this.loggedIn = true;
        return true;
      }

      let xfToken = $("input[name='_xfToken']").val();
      if (!xfToken) {
        // Try to find it in script tags or other attributes
        const scriptContent = $("script").text();
        const tokenMatch = scriptContent.match(/csrf: "([^"]+)"/) || scriptContent.match(/"csrf":"([^"]+)"/);
        if (tokenMatch) xfToken = tokenMatch[1];
      }
      
      if (!xfToken) {
        console.error("[NIMFOMANE] Could not find _xfToken on login page.");
        // Log a bit of the body to help debug
        console.log("[NIMFOMANE] Body snippet:", loginPage.data.slice(0, 1000).replace(/\s+/g, ' '));
        return false;
      }

      console.log(`[NIMFOMANE] Found _xfToken: ${xfToken}`);
      
      // 2. Perform login
      const params = new URLSearchParams();
      params.append("login", username);
      params.append("password", password);
      params.append("remember", "1");
      params.append("_xfToken", xfToken as string);
      params.append("_xfRedirect", this.baseUrl);
      
      const response = await fetchWithRetry(`${this.baseUrl}/login/login`, {
        method: 'POST',
        data: params.toString(),
        headers: {
          ...getHeaders(`${this.baseUrl}/login/`),
          "Content-Type": "application/x-www-form-urlencoded"
        },
        maxRedirects: 5
      }, 2, true);
      
      // Check if login was successful
      const isSuccessBody = response.data.includes("Log out") || 
                            response.data.includes("Account details") || 
                            response.data.includes("/logout/");
      
      const cookies = await jar.getCookies(this.baseUrl);
      const hasUserCookie = cookies.some(c => c.key === 'xf_user' || c.key === 'xf_session');
      
      if (isSuccessBody || hasUserCookie) {
        console.log("[NIMFOMANE] Login successful!");
        this.loggedIn = true;
        return true;
      } else {
        console.error("[NIMFOMANE] Login failed. Response did not indicate success.");
        if (response.data.includes("Incorrect password")) {
          console.error("[NIMFOMANE] Error: Incorrect password.");
        } else if (response.data.includes("security error")) {
          console.error("[NIMFOMANE] Error: Security/CSRF error.");
        }
        return false;
      }
    } catch (err: any) {
      console.error("[NIMFOMANE] Login error:", err.message);
      return false;
    }
  }

  async search(query: string, page = 1, county = "", city = "") {
    const isLogged = await this.login();
    if (!isLogged) throw new Error("Nimfomane login failed. Please check credentials in Settings.");

    try {
      let fullQuery = query;
      if (city) fullQuery += ` ${city}`;
      else if (county) fullQuery += ` ${county}`;
      
      console.log(`[NIMFOMANE] Searching for: ${fullQuery} (page ${page})`);
      
      const searchParams = new URLSearchParams();
      searchParams.append("keywords", fullQuery);
      searchParams.append("c[title_only]", "1");
      searchParams.append("order", "date");
      
      // Get CSRF token again
      const homePage = await fetchWithRetry(this.baseUrl, {
        headers: getHeaders(this.baseUrl)
      }, 2, true);
      
      const $home = cheerio.load(homePage.data);
      const xfToken = $home("input[name='_xfToken']").val();
      
      if (!xfToken) {
        console.warn("[NIMFOMANE] CSRF token not found for search, attempting without it...");
      } else {
        searchParams.append("_xfToken", xfToken as string);
      }

      const searchResponse = await fetchWithRetry(`${this.baseUrl}/search/search`, {
        method: 'POST',
        data: searchParams.toString(),
        headers: {
          ...getHeaders(this.baseUrl),
          "Content-Type": "application/x-www-form-urlencoded"
        },
        maxRedirects: 5
      }, 2, true);

      let htmlData = searchResponse.data;

      // Handle XenForo search pagination if page > 1
      let searchUrl = searchResponse.request?.res?.responseUrl || searchResponse.config?.url;
      if (page > 1 && searchUrl) {
        try {
          const u = new URL(searchUrl);
          u.searchParams.set("page", page.toString());
          const targetUrl = u.toString();
          console.log(`[NIMFOMANE] Fetching paginated page ${page} from: ${targetUrl}`);
          
          const paginatedResponse = await fetchWithRetry(targetUrl, {
            headers: getHeaders(this.baseUrl)
          }, 2, true);
          htmlData = paginatedResponse.data;
        } catch (pagErr: any) {
          console.warn("[NIMFOMANE] Pagination URL parse/fetch failed, falling back to page 1:", pagErr.message);
        }
      }

      const $ = cheerio.load(htmlData);
      
      // Parse total results count
      let totalResults: number | null = null;
      try {
        const paginationText = $(".paginationText, .pageNavSimple, .block-outer-opposite, .pageNav, .pageNav-page").text() || "";
        const pagMatch = paginationText.match(/(?:of|din|from)\s+(\d+[\d\s.,]*)/i);
        if (pagMatch) {
          totalResults = parseInt(pagMatch[1].replace(/[^\d]/g, "")) || null;
        }
        
        if (!totalResults) {
          const navElText = $(".pageNav-page").last().text().trim();
          if (navElText && /^\d+$/.test(navElText)) {
            totalResults = parseInt(navElText) * 20;
          }
        }
      } catch (err) {
        console.warn("[NIMFOMANE] Failed to parse totalResults:", err);
      }

      const listings: any[] = [];

      $(".contentRow").each((_, el) => {
        const titleEl = $(el).find(".contentRow-title a");
        const title = titleEl.text().trim();
        const link = titleEl.attr("href");
        const date = $(el).find("time").attr("datetime") || $(el).find("time").text().trim();
        const snippet = $(el).find(".contentRow-snippet").text().trim();
        const author = $(el).find(".contentRow-minor a").first().text().trim();
        
        // Try to find an image in the content row
        const itemImages: string[] = [];
        $(el).find("img").each((_, img) => {
          let src = $(img).attr("src") || $(img).attr("data-src");
          if (src && !src.includes("avatar") && !src.includes("logo") && !src.includes("icon")) {
            if (!src.startsWith("http")) src = `https://www.nimfomane.com${src.startsWith("/") ? "" : "/"}${src}`;
            if (!itemImages.includes(src)) itemImages.push(src);
          }
        });

        if (title && link) {
          listings.push({
            id: `nim-${link.split(".").pop()?.replace("/", "") || Math.random()}`,
            title,
            link: link.startsWith("http") ? link : `https://www.nimfomane.com${link}`,
            price: "Forum Post",
            date: date,
            location: "Nimfomane.com",
            image: itemImages.length > 0 ? itemImages[0] : "https://www.nimfomane.com/forum/styles/default/xenforo/logo.og.png",
            images: itemImages,
            description: snippet,
            author: author,
            source: "nimfomane"
          });
        }
      });

      const normalizeLink = (url: string) => {
        if (!url) return '';
        return url.split('?')[0].split('#')[0].trim().replace(/\/$/, '').toLowerCase();
      };

      const uniqueListings = listings.filter((item, index, self) =>
        item.link && index === self.findIndex((t) => normalizeLink(t.link) === normalizeLink(item.link))
      );

      return { 
        listings: uniqueListings.slice(0, 20), 
        totalResults: totalResults || uniqueListings.length 
      };
    } catch (err: any) {
      console.error("[NIMFOMANE] Search error:", err.message);
      // Return empty instead of throwing to prevent route 500
      return { listings: [], totalResults: 0 };
    }
  }
}

const nimfomane = new NimfomaneScraper();

/**
 * Inspector Escorte Scraper Logic
 */
class InspectorEscorteScraper {
  private static cachedBaseUrl: string | null = null;
  private static cachedUrlPattern: string | null = null;
  private baseUrl = InspectorEscorteScraper.cachedBaseUrl || "https://www.inspector-escorte.ro";

  private isValidResponse(res: any): boolean {
    // Be more lenient with status codes if we have data
    // Some sites return 404 for "no results" but the page is still valid HTML
    if ((res.status === 200 || res.status === 404) && res.data && res.data.length > 200) {
      const snippet = res.data.length > 200000 ? res.data.slice(0, 200000) : res.data;
      const lowerSnippet = snippet.toLowerCase();
      
      // If it's a 404 but contains search results or "no results" message, it might be a valid response
      const isNoResults = lowerSnippet.includes("nu am găsit") || 
                          lowerSnippet.includes("0 rezultate") || 
                          lowerSnippet.includes("niciun rezultat") || 
                          lowerSnippet.includes("nu exista anunturi") ||
                          lowerSnippet.includes("nu am gasit") ||
                          lowerSnippet.includes("nu s-au găsit");

      if (res.status === 404) {
         // If it's a 404 but has site indicators, it's a valid site page (likely "no results")
         const siteIndicators = ["googletagmanager", "gtag", "inspector-escorte", "anunturi-escorte"];
         for (const ind of siteIndicators) {
           if (lowerSnippet.includes(ind)) {
             console.log(`[INSPECTOR] 404 accepted as site page due to indicator: ${ind}`);
             return true;
           }
         }
         if (res.data.length > 10000) {
           console.log(`[INSPECTOR] 404 accepted as site page due to size: ${res.data.length}`);
           return true;
         }
         if (!isNoResults && res.data.length < 5000) return false; 
      }

      // Check for Cloudflare challenge in response body even if status is 200
      if ((lowerSnippet.includes("cloudflare") || lowerSnippet.includes("just a moment") || lowerSnippet.includes("checking your browser")) && 
          (lowerSnippet.includes("challenge") || lowerSnippet.includes("ray id") || lowerSnippet.includes("captcha") || lowerSnippet.includes("robot"))) {
        console.log(`[INSPECTOR] Response rejected: Cloudflare/Captcha detected.`);
        return false;
      }
      
      if (lowerSnippet.includes("captcha") || lowerSnippet.includes("robot") || lowerSnippet.includes("human verification") || lowerSnippet.includes("forbidden") || lowerSnippet.includes("access denied") || lowerSnippet.includes("too many requests")) {
        console.log(`[INSPECTOR] Response rejected: Bot detection/Access Denied/Rate Limit detected.`);
        return false;
      }
      
      // If the response is too small or just a script, it might be a block or empty page
      if (res.data.length < 1000 && !lowerSnippet.includes("nu am găsit") && !lowerSnippet.includes("0 rezultate") && !lowerSnippet.includes("nu exista anunturi") && !lowerSnippet.includes("nu am gasit") && !lowerSnippet.includes("nu s-au găsit") && !lowerSnippet.includes("niciun rezultat")) {
        if (lowerSnippet.includes("<script") && !lowerSnippet.includes("<body")) {
          console.log(`[INSPECTOR] Response rejected: Script-only response.`);
          return false;
        }
        if (res.data.length < 200) {
          console.log(`[INSPECTOR] Response rejected: Too small (${res.data.length} bytes).`);
          return false;
        }
      }

      if (lowerSnippet.includes("nu am găsit") || lowerSnippet.includes("no results") || lowerSnippet.includes("0 rezultate") || 
          lowerSnippet.includes("nu exista anunturi") || lowerSnippet.includes("nu am gasit") || 
          lowerSnippet.includes("nu s-au găsit") || lowerSnippet.includes("nu s-au gasit") || 
          lowerSnippet.includes("niciun rezultat") || lowerSnippet.includes("nici un rezultat") ||
          lowerSnippet.includes("nu a fost gasit") || lowerSnippet.includes("nu a fost găsit") ||
          lowerSnippet.includes("nu am gasit niciun") || lowerSnippet.includes("nu am găsit niciun") ||
          lowerSnippet.includes("nu am gasit anunturi") || lowerSnippet.includes("nu am găsit anunțuri") ||
          lowerSnippet.includes("nu s-a gasit") || lowerSnippet.includes("nu s-a găsit") ||
          lowerSnippet.includes("nothing found") || lowerSnippet.includes("no ads found") || lowerSnippet.includes("0 ads found") ||
          lowerSnippet.includes("cautarea nu a returnat") || lowerSnippet.includes("căutarea nu a returnat") ||
          lowerSnippet.includes("nu am gasit nici un") || lowerSnippet.includes("nu am găsit nici un") ||
          lowerSnippet.includes("nu exista rezultate") || lowerSnippet.includes("nu există rezultate")) {
        console.log(`[INSPECTOR] Response accepted: "No results" page detected.`);
        return true; 
      }

      // Check if it has at least one listing-like element
      const indicators = [
        "ad-", "href=\"/ad/", "href='/ad/", "cell-title", "listing", "card", "ad-item", "grid-item", "row-item", 
        "escorta", "telefon", "pret", "detalii", "contact", "galerie", "anunt", "bucuresti", "iasi", "cluj", 
        "timisoara", "brasov", "constanta", "anunturi-escorte", "vezi-detalii", "profil-escorta", "anunturi", 
        "cautare", "rezultate", "pagina", "filtru", "sortare", "locatie", "varsta", "inaltime", "greutate", 
        "servicii", "anunturi-gratuite", "anunturi-noi", "cautare-avansata", "vezi-anuntul", "detalii-anunt",
        "escorte-bucuresti", "escorte-iasi", "escorte-cluj", "anunturi-sex", "matrimoniale", "fete", "femei",
        "barbati", "cupluri", "trans", "video", "poze", "reale", "verificate", "top", "premium", "vip",
        "googletagmanager", "google-analytics", "gtag", "pixel", "facebook", "instagram", "whatsapp",
        "main-content", "content-area", "search-results", "results-list", "item-list", "escorte-romania",
        "pagination", "pager", "next", "prev", "filter", "sort", "inspector-escorte",
        "item-title", "listing-item", "escorta-item", "anunt-item", "search-item", "result-item",
        "escorte-", "anunturi-escorte-", "listing-title", "listing-details", "listing-contact",
        "vezi-numarul", "arata-telefon", "contacteaza", "trimite-mesaj", "anunturi-recente",
        "listing-box", "ad-box", "item-box", "search-box", "result-box", "listing-card", "ad-card", "item-card",
        "listing-title", "ad-title", "item-title", "listing-details", "ad-details", "item-details"
      ];
      for (const indicator of indicators) {
        if (lowerSnippet.includes(indicator)) {
          console.log(`[INSPECTOR] Response accepted: Indicator "${indicator}" found.`);
          return true;
        }
      }
      
      // Final check: if it has many links containing /ad/ or /escorta/ or /anunt/ or /listing/ or /anunturi/ or /profil/ or /cautare/
      const adLinkCount = (res.data.match(/href=["']\/(ad|escorta|anunt|listing|anunturi|profil|cautare|anunturi-escorte)\//g) || []).length;
      if (adLinkCount > 0) {
        console.log(`[INSPECTOR] Response accepted: ${adLinkCount} ad links found.`);
        return true;
      }
      
      // Relaxed check: if page is large enough and not a known block
      if (res.data.length > 2000) {
        console.log(`[INSPECTOR] Response accepted: Large page (${res.data.length} bytes).`);
        return true;
      }
      
      console.log(`[INSPECTOR] Response rejected: No indicators found in ${res.data.length} bytes. Snippet: ${res.data.slice(0, 100)}`);
    } else {
      console.log(`[INSPECTOR] Response rejected: Status ${res?.status}, Length ${res?.data?.length || 0}`);
    }
    return false;
  }

  static resetCache() {
    InspectorEscorteScraper.cachedBaseUrl = null;
    InspectorEscorteScraper.cachedUrlPattern = null;
    sslFailureDomains.clear();
    domainCooldowns.clear();
    console.log("[INSPECTOR] Cache, SSL failure history, and cooldowns reset.");
  }

  async search(query: string, page = 1, county = "", city = "") {
    const startTime = Date.now();
    const MAX_SEARCH_TIME = 150000; // 150 seconds limit (2.5 mins)
    const failedDomains = new Set<string>();
    const triedUrls = new Set<string>();
    
    try {
      console.log(`[INSPECTOR] Searching for: ${query} (county: ${county}, city: ${city}, page ${page})`);
      
      // 1. Pre-fetch home page to get cookies and check for redirects (only if baseUrl is default or not cached)
      if (InspectorEscorteScraper.cachedBaseUrl) {
        try {
          const cachedUrl = InspectorEscorteScraper.cachedBaseUrl;
          const cachedDomain = new URL(cachedUrl).hostname;
          if (sslFailureDomains.has(cachedDomain) || checkCooldown(cachedUrl)) {
            console.log(`[INSPECTOR] Clearing cached domain ${cachedDomain} due to SSL failure or cooldown.`);
            InspectorEscorteScraper.cachedBaseUrl = null;
            // Try to find a non-cooldown alternative
            const alternatives = ["https://www.inspector-escorte.com", "https://www.inspector-escorte.ro"];
            this.baseUrl = alternatives.find(alt => !checkCooldown(alt)) || alternatives[0];
          }
        } catch (e) {}
      }

      if (!InspectorEscorteScraper.cachedBaseUrl || this.baseUrl.includes("http://")) {
        try {
          if (Date.now() - startTime > MAX_SEARCH_TIME) throw new Error("Search time limit exceeded");
          
          // Prioritize .com and sort by SSL failure history
          let domains = [
            "https://www.inspector-escorte.com",
            "https://inspector-escorte.com",
            "https://www.inspector-escorte.ro",
            "https://inspector-escorte.ro",
            "http://www.inspector-escorte.ro",
            "http://inspector-escorte.ro"
          ];
          
          // Move domains that are known to have SSL issues to the end
          domains.sort((a, b) => {
            try {
              const domA = new URL(a).hostname;
              const domB = new URL(b).hostname;
              const failA = sslFailureDomains.has(domA) ? 1 : 0;
              const failB = sslFailureDomains.has(domB) ? 1 : 0;
              return failA - failB;
            } catch (e) { return 0; }
          });
          
          console.log("[INSPECTOR] Pre-fetching home page for cookies and domain check...");
        
        // Sequential domain check to avoid overwhelming the server or hitting limits
        let homeRes = null;
        let bestFallback = null;
        
        console.log("[INSPECTOR] Checking domains sequentially...");
        for (const domain of domains) {
          try {
            if (checkCooldown(domain)) {
              console.log(`[INSPECTOR] Skipping domain in cooldown: ${domain}`);
              continue;
            }
            
            // Add delay between domain checks
            await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
            
            console.log(`[INSPECTOR] Checking domain: ${domain}`);
            const res = await fetchWithRetry(domain, {
              headers: getHeaders("https://www.google.com/"),
              timeout: 6000 
            }, 2, true);
            
            if (res.status === 200) {
              homeRes = res;
              this.baseUrl = domain;
              InspectorEscorteScraper.cachedBaseUrl = domain;
              console.log(`[INSPECTOR] Found working domain: ${domain}`);
              break;
            }
            if (!bestFallback && (res.status === 403 || res.status === 526 || res.status === 429)) {
              bestFallback = domain;
            }
          } catch (e: any) {
            const errorMsg = e?.message || (typeof e === 'string' ? e : (e?.code || "Unknown error"));
            console.log(`[INSPECTOR] Domain ${domain} unreachable: ${errorMsg}`);
            failedDomains.add(domain);
          }
        }
        
        if (!homeRes && bestFallback) {
          console.log(`[INSPECTOR] No domain returned 200, using best fallback: ${bestFallback}`);
          this.baseUrl = bestFallback;
        }
        
        if (homeRes) {
          // Update baseUrl if redirected (handle both axios and fetch-like responses)
          const finalUrl = homeRes.request?.res?.responseUrl || homeRes.config?.url;
          if (finalUrl) {
             const urlObj = new URL(finalUrl);
             this.baseUrl = `${urlObj.protocol}//${urlObj.host}`;
             InspectorEscorteScraper.cachedBaseUrl = this.baseUrl;
             console.log(`[INSPECTOR] Base URL confirmed/updated to: ${this.baseUrl}`);
          }
        }
        } catch (e: any) {
          console.warn("[INSPECTOR] Pre-fetch failed, continuing anyway:", e?.message || e || "Unknown error");
        }
      }

      // Try multiple search URL patterns - optimized for speed and success
      // We reduce the number of patterns to avoid triggering rate limits (429)
      const searchUrls: { url: string; useJar: boolean }[] = [];
      
      const lowerQuery = query.toLowerCase().trim();
      const citySlug = encodeURIComponent(lowerQuery.replace(/\s+/g, '-'));
      const pageSuffix = page > 1 ? `?page=${page}` : "";
      
      // If a city is explicitly selected, prioritize it
      let targetCity = city;
      if (!targetCity) {
        // If query looks like a city, prioritize city-specific URLs
        const majorCities = [
          "bucuresti", "iasi", "cluj", "timisoara", "brasov", "constanta", "galati", "craiova", "ploiesti", "braila",
          "oradea", "bacau", "arad", "pitesti", "sibiu", "targu-mures", "baia-mare", "buzau", "satu-mare", "botosani",
          "ramnicu-valcea", "suceava", "piatra-neamt", "drobeta-turnu-severin", "targu-jiu", "tulcea", "targoviste",
          "bistrita", "resita", "slatina", "focsani", "vaslui", "hunedoara", "giurgiu", "alba-iulia", "devan", "zalau",
          "sfantu-gheorghe", "slobozia", "alexandria", "calarasi", "lugoj", "voluntari", "pantelimon", "popesti-leordeni",
          "chiajna", "mogosoaia", "chitila", "otopeni", "buftea", "magurele", "bragadiru"
        ];
        targetCity = majorCities.find(c => lowerQuery === c || lowerQuery.includes(` ${c}`) || lowerQuery.includes(`${c} `)) || "";
      }
      
      // If we have a cached pattern that matches the current query type, prioritize it
      if (InspectorEscorteScraper.cachedUrlPattern) {
        let pattern = InspectorEscorteScraper.cachedUrlPattern;
        // Replace page in pattern if needed
        if (pattern.includes("page=")) {
          pattern = pattern.replace(/page=\d+/, `page=${page}`);
        } else if (page > 1) {
          pattern += pattern.includes("?") ? `&page=${page}` : `?page=${page}`;
        }
        searchUrls.push({ url: pattern, useJar: true });
      }

      if (targetCity) {
        const citySlugMatch = encodeURIComponent(targetCity.toLowerCase().replace(/\s+/g, '-'));
        searchUrls.push(
          { url: `${this.baseUrl}/escorte-${citySlugMatch}${pageSuffix}`, useJar: true },
          { url: `${this.baseUrl}/anunturi-escorte-${citySlugMatch}${pageSuffix}`, useJar: true }
        );
      }
      
      // General query-based slugs
      if (query && !targetCity) {
        searchUrls.push(
          { url: `${this.baseUrl}/escorte-${citySlug}${pageSuffix}`, useJar: true },
          { url: `${this.baseUrl}/anunturi-${citySlug}${pageSuffix}`, useJar: true }
        );
      }

      // Add the most reliable search patterns
      searchUrls.push(
        { url: `${this.baseUrl}/anunturi?search=${encodeURIComponent(query)}&page=${page}`, useJar: true },
        { url: `${this.baseUrl}/cautare-anunturi?search=${encodeURIComponent(query)}&page=${page}`, useJar: true },
        { url: `${this.baseUrl}/cautare?q=${encodeURIComponent(query)}&page=${page}`, useJar: true }
      );
      
      let response = null;
      let lastRes: any = null;
      
      console.log(`[INSPECTOR] Trying search URLs on ${this.baseUrl}...`);
      for (const item of searchUrls) {
        if (Date.now() - startTime > MAX_SEARCH_TIME) {
          console.warn("[INSPECTOR] Search time limit reached, stopping search.");
          break;
        }
        
        if (triedUrls.has(item.url)) continue;
        triedUrls.add(item.url);
        
        try {
          // Add a much larger delay to avoid hitting rate limits (429)
          // Increased to 15-25 seconds
          await new Promise(r => setTimeout(r, 15000 + Math.random() * 10000));
          
          console.log(`[INSPECTOR] Attempting: ${item.url}`);
          const res = await fetchWithRetry(item.url, {
            headers: getHeaders(this.baseUrl),
            timeout: 10000 
          }, 1, item.useJar);
          
          lastRes = res;
          if (this.isValidResponse(res)) {
            console.log(`[INSPECTOR] Search successful with URL: ${item.url}`);
            // Cache the successful pattern (strip the page number for generic use)
            InspectorEscorteScraper.cachedUrlPattern = item.url;
            response = res;
            break;
          }
          
          if (res.status === 429) {
            console.warn("[INSPECTOR] Hit 429, waiting much longer before next attempt...");
            // Wait 120-240 seconds on 429
            await new Promise(r => setTimeout(r, 120000 + Math.random() * 120000));
            // If we hit 429, we definitely want to skip this domain entirely for this search
            if (item.url.includes(this.baseUrl)) {
               console.log(`[INSPECTOR] Domain ${this.baseUrl} is rate-limiting, marking as failed and trying alternative.`);
               failedDomains.add(this.baseUrl);
               break; 
            }
          }
        } catch (e: any) {
          console.warn("[INSPECTOR] Search URL failed: " + item.url + " - " + (e?.message || e || "Unknown error"));
        }
      }
      
      if (!response && (Date.now() - startTime < MAX_SEARCH_TIME)) {
        console.log("[INSPECTOR] Primary search URLs failed, trying direct search on alternative domains...");
        const altDomains = [
          "https://www.inspector-escorte.com",
          "https://inspector-escorte.com",
          "https://www.inspector-escorte.ro",
          "https://inspector-escorte.ro"
        ];
        
        // Sort altDomains by SSL failure history
        altDomains.sort((a, b) => {
          try {
            const domA = new URL(a).hostname;
            const domB = new URL(b).hostname;
            const failA = sslFailureDomains.has(domA) ? 1 : 0;
            const failB = sslFailureDomains.has(domB) ? 1 : 0;
            return failA - failB;
          } catch (e) { return 0; }
        });
        
        for (const domain of altDomains) {
          if (Date.now() - startTime > MAX_SEARCH_TIME) break;
          if (domain === this.baseUrl) continue;
          // Skip domains that failed during pre-fetch to avoid redundant ENOTFOUND errors
          if (failedDomains.has(domain)) {
            console.log(`[INSPECTOR] Skipping known failed domain: ${domain}`);
            continue;
          }
          try {
            console.log(`[INSPECTOR] Trying direct search on: ${domain}`);
            const patterns = [
              `${domain}/escorte-${citySlug}`,
              `${domain}/anunturi?search=${encodeURIComponent(query)}`
            ];
            
            for (const directUrl of patterns) {
              if (Date.now() - startTime > MAX_SEARCH_TIME) break;
              if (triedUrls.has(directUrl)) continue;
              triedUrls.add(directUrl);
              
              console.log(`[INSPECTOR] Trying pattern: ${directUrl}`);
              const res = await fetchWithRetry(directUrl, {
                headers: getHeaders(domain),
                timeout: 8000
              }, 1, true); 
              
              if (this.isValidResponse(res)) {
                console.log(`[INSPECTOR] Direct search successful on: ${domain} with ${directUrl}`);
                response = res;
                this.baseUrl = domain; 
                break;
              }
              
              if (res.status === 429) {
                console.warn("[INSPECTOR] Hit 429 on alt domain, waiting much longer...");
                await new Promise(r => setTimeout(r, 60000 + Math.random() * 60000));
                failedDomains.add(domain);
                break;
              }
              
              // Delay between patterns
              await new Promise(r => setTimeout(r, 10000 + Math.random() * 5000));
            }
            if (response) break;
          } catch (e: any) {
             console.warn("[INSPECTOR] Direct search failed for " + domain + ": " + (e?.message || e || "Unknown error"));
          }
        }
      }

      if (!response && (Date.now() - startTime < MAX_SEARCH_TIME)) {
        try {
          console.log("[INSPECTOR] Trying POST search fallback...");
          const postUrls = [
            `${this.baseUrl}/cautare-anunturi`, 
            `${this.baseUrl}/anunturi`
          ];
          for (const postUrl of postUrls) {
            if (Date.now() - startTime > MAX_SEARCH_TIME) break;
            const postRes = await fetchWithRetry(postUrl, {
              method: 'POST',
              data: qs.stringify({ 
                search: query, 
                q: query, 
                query: query, 
                term: query, 
                keyword: query, 
                keywords: query,
                cautare: query,
                _token: '', // Some sites require a token, even if empty
                action: 'search',
                do: 'search'
              }),
              headers: {
                ...getHeaders(this.baseUrl),
                'Content-Type': 'application/x-www-form-urlencoded'
              },
              timeout: 5000
            }, 0, true);
            
            lastRes = postRes;
            if (this.isValidResponse(postRes)) {
              console.log(`[INSPECTOR] POST search to ${postUrl} succeeded.`);
              response = postRes;
              break;
            }
          }
        } catch (e: any) {
          console.warn("[INSPECTOR] POST search fallback failed:", e?.message || e || "Unknown error");
        }
      }

      if (!response && (Date.now() - startTime < MAX_SEARCH_TIME)) {
        console.log("[INSPECTOR] All specific search URLs failed, trying home page fallback...");
        try {
          const homeRes = await fetchWithRetry(this.baseUrl, {
            headers: getHeaders(this.baseUrl),
            timeout: 10000
          }, 1, true);
          lastRes = homeRes;
          if (homeRes.status === 200) {
            console.log("[INSPECTOR] Home page fetched, checking for search form...");
            const $home = cheerio.load(homeRes.data);
            
            // Look for any form that has a text input and looks like a search form
            const form = $home("form").filter((_, f) => {
              const $f = $home(f);
              const text = $f.text().toLowerCase();
              const action = $f.attr("action") || "";
              const hasSearchInput = $f.find("input").filter((__, i) => {
                const $i = $home(i);
                const name = ($i.attr("name") || "").toLowerCase();
                const placeholder = ($i.attr("placeholder") || "").toLowerCase();
                const id = ($i.attr("id") || "").toLowerCase();
                const className = ($i.attr("class") || "").toLowerCase();
                return name.includes("search") || name.includes("q") || name.includes("caut") || name.includes("term") || name.includes("keyword") ||
                       placeholder.includes("search") || placeholder.includes("caut") || placeholder.includes("keyword") ||
                       id.includes("search") || id.includes("caut") || className.includes("search") || className.includes("caut");
              }).length > 0;
              
              return hasSearchInput || text.includes("caut") || text.includes("search") || action.includes("search") || action.includes("anunturi") || action === "/";
            }).first();

            if (form.length > 0) {
              const action = form.attr("action") || "/";
              const input = form.find("input").filter((__, i) => {
                const $i = $home(i);
                const name = ($i.attr("name") || "").toLowerCase();
                const placeholder = ($i.attr("placeholder") || "").toLowerCase();
                const id = ($i.attr("id") || "").toLowerCase();
                const className = ($i.attr("class") || "").toLowerCase();
                const type = ($i.attr("type") || "").toLowerCase();
                return (type === "text" || type === "search" || !type) && 
                       (name.includes("search") || name.includes("q") || name.includes("caut") || name.includes("term") || name.includes("keyword") ||
                        placeholder.includes("search") || placeholder.includes("caut") || id.includes("search") || className.includes("search"));
              }).first();
              
              const inputName = input.attr("name") || "search";
              
              console.log(`[INSPECTOR] Found search form: action=${action}, input=${inputName}`);
              
              const finalUrl = action.startsWith("http") ? action : `${this.baseUrl}${action.startsWith("/") ? "" : "/"}${action}`;
              const separator = finalUrl.includes("?") ? "&" : "?";
              const searchUrl = `${finalUrl}${separator}${inputName}=${encodeURIComponent(query)}&page=${page}`;
              
              console.log(`[INSPECTOR] Trying derived search URL: ${searchUrl}`);
              const searchRes = await fetchWithRetry(searchUrl, {
                headers: getHeaders(this.baseUrl),
                timeout: 7000
              }, 1, true);
              lastRes = searchRes;
              // Be less strict for home page fallback
              if (this.isValidResponse(searchRes) || (searchRes.status === 200 && searchRes.data.length > 2000)) {
                console.log(`[INSPECTOR] Home page fallback accepted response (Length: ${searchRes.data.length})`);
                response = searchRes;
              }
            } else {
              console.log("[INSPECTOR] No search form found on home page.");
            }
          }
        } catch (e: any) {
          console.error("[INSPECTOR] Home page fallback failed:", e?.message || e || "Unknown error");
        }
      }

      if (!response) {
        const lastStatus = lastRes?.status || "N/A";
        const lastDataSnippet = lastRes?.data ? String(lastRes.data).slice(0, 200).replace(/\s+/g, ' ') : "No data";
        console.error(`[INSPECTOR] Search failed for query: ${query}. Last Status: ${lastStatus}. Snippet: ${lastDataSnippet}`);
        
        if (lastStatus === 429) {
          throw new Error("The site is currently rate-limiting our requests (Error 429). Please try again in a few minutes.");
        }
        
        throw new Error("Could not find search results on Inspector Escorte. The site might be down or blocking requests.");
      }

      const $ = cheerio.load(response.data);
      if (response.data.includes("Cloudflare") || response.data.includes("challenge-running") || response.data.includes("just a moment")) {
        console.warn("[INSPECTOR] Cloudflare challenge detected on search results.");
        throw new Error("Access blocked by Cloudflare. Site protection is too high for automated scraping.");
      }

      // Parse total results count
      let totalResults: number | null = null;
      try {
        const h1Text = $("h1").text() || "";
        const h1Match = h1Text.match(/(\d+[\d\s.,]*)\s*(?:de\s+)?(?:anunțuri|anunturi|rezultate)/i) || h1Text.match(/\((\d+[\d\s.,]*)\)/);
        if (h1Match) {
          totalResults = parseInt(h1Match[1].replace(/[^\d]/g, "")) || null;
        }

        if (!totalResults) {
          const paginationText = $(".pagination, .pager, .paginationText, .pageNavSimple, .block-outer-opposite, .showing-results, .results-count").text() || "";
          const pagMatch = paginationText.match(/(?:of|din|from)\s+(\d+[\d\s.,]*)/i);
          if (pagMatch) {
            totalResults = parseInt(pagMatch[1].replace(/[^\d]/g, "")) || null;
          }
        }

        if (!totalResults) {
          $(".total-results, .ad-count, .results-count, .count-listings, .count, .title-results, .title-ads-count, .search-results-count").each((_, el) => {
            const t = $(el).text().trim();
            const match = t.match(/(\d+[\d\s.,]*)/);
            if (match) {
              totalResults = parseInt(match[1].replace(/[^\d]/g, "")) || null;
              return false;
            }
          });
        }

        if (!totalResults) {
          const bodyText = $("body").text();
          const bodyMatch = bodyText.match(/(\d+[\d\s.,]*)\s+(?:anunțuri|anunturi|rezultate|anuncios)/i);
          if (bodyMatch) {
            totalResults = parseInt(bodyMatch[1].replace(/[^\d]/g, "")) || null;
          }
        }
      } catch (err) {
        console.warn("[INSPECTOR] Failed to parse totalResults:", err);
      }

      const listings: any[] = [];

      // Selectors for inspector-escorte.ro based on site analysis
      // It uses a table structure with tr elements
      $("tbody tr, .ad-card, .ad-box, article, .listing, .card, .item, .box, .row-item, .ad-item, .listing-item, .grid-item, .list-item, .search-item, .ad_list_item, .ad_item_container, .vip-item, .result-item, .ad-row, .listing-row, .anunt-item, .anunt-box, .escort-item, .escort-card").each((_, el) => {
        const $el = $(el);
        
        // Find title and link
        let titleEl = $el.find(".cell-title-link, .mobile-info-title, h2 a, h3 a, a[href*='/ad/'], a[href*='/anunt/'], .ad-title a, .title a, .name a, .escort-name a").first();
        if (titleEl.length === 0 && $el.is("a")) titleEl = $el;
        
        let title = titleEl.text().trim();
        let link = titleEl.attr("href");
        
        // If no link in title, look for any link in the container
        if (!link) {
          const anyLink = $el.find("a[href*='/ad/'], a[href*='/anunt/'], a[href*='/escorte/']").first();
          link = anyLink.attr("href");
          if (!title) title = anyLink.text().trim();
        }
        
        if (!link) {
          // Try to find any link starting with /ad/ or /anunt/
          const anyAdLink = $el.find("a[href*='/ad/'], a[href*='/anunt/'], a.title, a.ad-link").first();
          link = anyAdLink.attr("href");
          if (!title) title = anyAdLink.text().trim();
        }
        
        if (!title) {
          title = $el.find("h2, h3, .title, .ad-title, .name").first().text().trim();
        }
        
        // If still no link, look for any link in the element
        if (!link) {
          const firstLink = $el.find("a").first();
          link = firstLink.attr("href");
          if (!title) title = firstLink.text().trim();
        }

          if (link && title) {
            // Ensure link is absolute
            let finalLink = link;
            if (!finalLink.startsWith("http")) {
              if (finalLink.startsWith("//")) {
                finalLink = `https:${finalLink}`;
              } else {
                finalLink = `${this.baseUrl}${finalLink.startsWith("/") ? "" : "/"}${finalLink}`;
              }
            }
            
            const isPlaceholder = (url: string | undefined) => {
            if (!url) return true;
            const u = url.toLowerCase();
            return u.includes("placeholder") || u.includes("no-photo") || u.includes("logo") || u.includes("icon") || 
                   u.includes("transparent.gif") || u.includes("pixel.gif") || u.includes("blank.gif") ||
                   u.includes("default") || u.includes("avatar");
          };
          
          // Images (multiple if available in search result)
          const itemImages: string[] = [];
          $el.find("img").each((_, img) => {
            let src = $(img).attr("src") || $(img).attr("data-src") || $(img).attr("data-original") || $(img).attr("data-lazy-src");
            if (src) {
              let finalSrc = src;
              if (finalSrc.startsWith("//")) {
                finalSrc = `https:${finalSrc}`;
              } else if (!finalSrc.startsWith("http")) {
                finalSrc = `${this.baseUrl}${finalSrc.startsWith("/") ? "" : "/"}${finalSrc}`;
              }
              
              if (finalSrc.includes("s3.publi24.ro") || finalSrc.includes("publi24.ro") || finalSrc.includes("inspector")) {
                finalSrc = finalSrc.replace(/\/(medium|small|t|thumb|thumbs|thumbnail)\//gi, "/large/");
              }
              
              if (!itemImages.includes(finalSrc) && !isPlaceholder(finalSrc)) {
                itemImages.push(finalSrc);
              }
            }
          });
          
          let image = itemImages.length > 0 ? itemImages[0] : null;
          
          // If no image found in img tags, try to find in background-image
          if (!image) {
            $el.find("*").each((__, subEl) => {
              const style = $(subEl).attr("style");
              if (style && style.includes("background-image")) {
                const bgMatch = style.match(/url\(['"]?([^'"]+)['"]?\)/);
                if (bgMatch && !isPlaceholder(bgMatch[1])) {
                  let bgSrc = bgMatch[1];
                  if (bgSrc.startsWith("//")) bgSrc = `https:${bgSrc}`;
                  if (!bgSrc.startsWith("http")) bgSrc = `${this.baseUrl}${bgSrc.startsWith("/") ? "" : "/"}${bgSrc}`;
                  if (bgSrc.includes("s3.publi24.ro") || bgSrc.includes("publi24.ro") || bgSrc.includes("inspector")) {
                    bgSrc = bgSrc.replace(/\/(medium|small|t|thumb|thumbs|thumbnail)\//gi, "/large/");
                  }
                  image = bgSrc;
                  return false;
                }
              }
            });
          }
          
          if (!image) {
            image = "https://inspector-escorte.ro/favicon.ico"; // Fallback to favicon or logo
          }
          
          // Location
          let location = $el.find(".cell-location, .ad-location, .location, .city, .region, .county, .locatie").first().text().trim() || "Romania";
          if (location === "Romania") {
            // Try to find any text that looks like a city
            $el.find("span, div, p").each((__, subEl) => {
              const t = $(subEl).text().trim();
              if (t.length > 2 && t.length < 30 && (t.includes(",") || t.match(/^[A-Z][a-z]+$/))) {
                location = t;
                return false;
              }
            });
          }
          
          // Deduplicate location
          if (location && location !== "Romania") {
            const mid = Math.floor(location.length / 2);
            for (let i = mid - 2; i <= mid + 2; i++) {
              if (i <= 0) continue;
              const first = location.slice(0, i).trim();
              const second = location.slice(i).trim();
              if (first === second) {
                location = first;
                break;
              }
            }
            const parts = location.split(/[,|\s-]+/).map(p => p.trim()).filter(p => p.length > 0);
            const uniqueParts = Array.from(new Set(parts));
            if (uniqueParts.length < parts.length) {
              location = uniqueParts.join(", ");
            }
          }
          
          // Price
          let price = $el.find(".cell-price, .ad-price, .price").text().trim();
          
          // Description snippet
          let description = $el.find(".cell-description, .ad-description, .description, .text, .info, .ad-text, .ad-info").text().trim();
          
          // If description looks like an ID (short, mostly digits), clear it
          if (description && (description.length < 15 || /^\d+$/.test(description))) {
            description = "";
          }

          if (!description) {
            // Try to find any text block that isn't title or location
            description = $el.find("p, div, span").filter((__, d) => {
              const t = $(d).text().trim();
              // Look for a reasonable length description that isn't just the title or location
              return t.length > 25 && t.length < 300 && !t.includes(title) && !t.includes(location);
            }).first().text().trim();
          }
          
          // Phone (if visible)
          let phone = $el.find(".cell-phone a, .ad-phone, .phone, .tel, .mobile, [href^='tel:']").text().trim();
          if (!phone) {
            const telLink = $el.find("a[href^='tel:']").first();
            if (telLink.length > 0) {
              phone = telLink.attr("href")?.replace("tel:", "") || "";
            }
          }
          
          if (phone) {
            // Keep only the first phone number if multiple are found
            if (phone.includes(",")) phone = phone.split(",")[0].trim();
            if (phone.includes("/")) phone = phone.split("/")[0].trim();
            if (phone.includes(";")) phone = phone.split(";")[0].trim();
            if (phone.includes(" ")) {
               // If it's something like "0722 111 222 0733 444 555"
               const matches = phone.match(/07\d{8}|07\d{2}[\s.-]\d{3}[\s.-]\d{3}/g);
               if (matches && matches.length > 0) phone = matches[0];
            }
            
            // Clean and format without spaces
            const digits = phone.replace(/[^\d]/g, "");
            if (digits.length >= 10) {
              const clean = digits.length > 10 ? digits.slice(-10) : digits;
              phone = clean;
            }
          }
          
          // Date
          let date = $el.find(".cell-date, .ad-date, .date, .time, .published, .added").text().trim();
          if (!date) {
            // Look for something that looks like a date
            $el.find("span, div, p").each((__, subEl) => {
              const t = $(subEl).text().trim();
              if (t.match(/\d{2}[\.\/-]\d{2}[\.\/-]\d{4}/) || t.includes("Azi") || t.includes("Ieri")) {
                date = t;
                return false;
              }
            });
          }

          let adId = finalLink.split("/").pop()?.replace(".html", "") || `ie-${Math.random().toString(36).substr(2, 9)}`;
          if (adId.includes("?")) adId = adId.split("?")[0];

          listings.push({
            id: adId,
            title,
            link: finalLink,
            image,
            images: itemImages,
            location,
            phoneNumber: phone || "Click to reveal",
            description: description || "Fără descriere",
            price: price || "N/A",
            date,
            source: 'inspector'
          });
        }
      });

      const normalizeLink = (url: string) => {
        if (!url) return '';
        return url.split('?')[0].split('#')[0].trim().replace(/\/$/, '').toLowerCase();
      };

      const uniqueResults = listings.filter((item, index, self) =>
        item.link && index === self.findIndex((t) => normalizeLink(t.link) === normalizeLink(item.link))
      );

      console.log(`[INSPECTOR] Found ${uniqueResults.length} listings after processing.`);
      return { 
        listings: uniqueResults.slice(0, 20), 
        totalResults: totalResults || uniqueResults.length 
      };
    } catch (err: any) {
      console.error("[INSPECTOR] Search error:", err.message);
      // Return empty instead of throwing to prevent route 500
      return { listings: [], totalResults: 0 };
    }
  }
}

// Scraper instances
const inspector = new InspectorEscorteScraper();

// Cache for Bursa Plăcerilor full descriptions & galleries
const bursaDetailCache = new Map<string, { desc: string; images?: string[]; phone?: string; date?: string; timestamp: number }>();

/**
 * Bursa Plăcerilor (bursaplacerilor.com) Scraper Logic
 */
class BursaPlacerilorScraper {
  private baseUrl = "https://bursaplacerilor.com";

  private getCountySlug(county: string): string {
    if (!county) return "";
    return county.toLowerCase().trim()
      .replace(/ă/g, "a").replace(/â/g, "a").replace(/î/g, "i")
      .replace(/ș/g, "s").replace(/ş/g, "s").replace(/ț/g, "t").replace(/ţ/g, "t")
      .replace(/\s+/g, "-");
  }

  async fetchSingleRemotePage(countySlug: string, query: string, remotePage: number): Promise<{ cards: any[]; maxPage: number }> {
    const params: string[] = [];
    if (countySlug) params.push(`judet=${encodeURIComponent(countySlug)}`);
    if (query) params.push(`q=${encodeURIComponent(query)}`);
    if (remotePage > 1) params.push(`pagina=${remotePage}`);

    const targetUrl = `${this.baseUrl}/${params.length > 0 ? '?' + params.join('&') : ''}`;
    try {
      const response = await fetchWithRetry(targetUrl, {
        headers: getHeaders(this.baseUrl),
        timeout: 15000
      }, 2, false);

      if (!response.data || typeof response.data !== "string") {
        return { cards: [], maxPage: 1 };
      }

      const $ = cheerio.load(response.data);
      let maxPage = 1;
      $("a[href*='pagina='], .pagination a").each((_, el) => {
        const href = $(el).attr("href") || "";
        const m = href.match(/pagina=(\d+)/);
        if (m) {
          const p = parseInt(m[1]);
          if (p > maxPage) maxPage = p;
        }
      });

      const cards: any[] = [];
      $(".card").not(".card-of").each((i, el) => {
        const title = $(el).find(".card-title").text().trim();
        const link = $(el).find("a").first().attr("href") || "";
        if (!title && !link) return;

        const fullLink = link.startsWith("http") ? link : `${this.baseUrl}${link.startsWith('/') ? '' : '/'}${link}`;
        const img = $(el).find("img").attr("data-src") || $(el).find("img").attr("src") || "";
        const fullImg = img.startsWith("http") ? img : `${this.baseUrl}${img.startsWith('/') ? '' : '/'}${img}`;
        
        let metaText = $(el).find(".card-meta span").first().text().replace(/📍/g, "").trim();
        if (metaText.includes("·")) metaText = metaText.split("·")[0].trim();
        
        let phone = $(el).find(".card-phone-num").text().replace(/\D/g, "").trim();
        if (!phone) {
          const m = link.match(/\/(\d{10})\//);
          if (m) phone = m[1];
        }

        const views = $(el).find(".card-views").text().replace(/\D/g, "").trim();
        const adId = `bp-${phone || ''}-${link.replace(/[^\w]/g, '').slice(-16)}`;

        cards.push({
          id: adId,
          adId,
          title: title || "Anunț Bursa Plăcerilor",
          link: fullLink,
          image: fullImg,
          images: fullImg ? [fullImg] : [],
          location: metaText || (countySlug ? countySlug.charAt(0).toUpperCase() + countySlug.slice(1) : "România"),
          date: views ? `${views} vizualizări` : "Recent",
          description: `Anunț publicat pe BursaPlacerilor.com${phone ? ' • Tel: ' + phone : ''}`,
          price: "N/A",
          phoneNumber: phone || "Click to reveal",
          revealedPhone: phone || undefined,
          source: 'bursaplacerilor'
        });
      });

      return { cards, maxPage };
    } catch (err: any) {
      console.warn(`[BURSAPLACERILOR] Error fetching remote page ${remotePage}:`, err.message);
      return { cards: [], maxPage: 1 };
    }
  }

  async search(query: string, page = 1, county = "", city = "", limit = 100) {
    const start = Date.now();
    const countySlug = this.getCountySlug(county || city);
    const cleanQuery = (query || "").trim();
    const limitNum = Math.min(100, Math.max(1, limit || 100));

    // Each remote page on bursaplacerilor has 20 cards.
    // For 100 results per page, fetch 5 remote pages in parallel:
    const remotePagesCount = Math.max(1, Math.ceil(limitNum / 20));
    const startRemotePage = (page - 1) * remotePagesCount + 1;
    const remotePages = Array.from({ length: remotePagesCount }, (_, i) => startRemotePage + i);

    console.log(`[BURSAPLACERILOR] Searching: query="${cleanQuery}", county="${countySlug}", page=${page}, remotePages=[${remotePages.join(',')}], limit=${limitNum}`);

    const responses = await Promise.all(
      remotePages.map(p => this.fetchSingleRemotePage(countySlug, cleanQuery, p))
    );

    const allCards: any[] = [];
    let estimatedMaxPage = 1;

    for (const res of responses) {
      if (res.maxPage > estimatedMaxPage) estimatedMaxPage = res.maxPage;
      allCards.push(...res.cards);
    }

    // Deduplicate by normalized link
    const seen = new Set<string>();
    const uniqueListings: any[] = [];
    for (const card of allCards) {
      const key = (card.link || "").split("?")[0].replace(/\/$/, "").toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        uniqueListings.push(card);
      }
    }

    const finalResults = uniqueListings.slice(0, limitNum);
    const totalResults = Math.max(finalResults.length, estimatedMaxPage * 20);

    // Fast-enrich listings: apply cached details immediately, then enrich uncached listings within a strict timeout budget
    await this.enrichListingsWithDescriptions(finalResults, 2500);

    console.log(`[BURSAPLACERILOR] Finished in ${Date.now() - start}ms: found ${finalResults.length} listings (total est: ${totalResults})`);
    return {
      listings: finalResults,
      totalResults
    };
  }

  async fetchListingDetailDirect(link: string): Promise<{ desc?: string; images?: string[]; date?: string; phone?: string } | null> {
    if (!link) return null;
    const now = Date.now();
    const CACHE_TIME = 2 * 60 * 60 * 1000;
    const cached = bursaDetailCache.get(link);
    if (cached && (now - cached.timestamp < CACHE_TIME) && cached.desc && cached.desc.length > 5) {
      return {
        desc: cached.desc,
        images: cached.images,
        date: cached.date,
        phone: cached.phone
      };
    }

    try {
      const resp = await axios.get(link, {
        headers: getHeaders(this.baseUrl),
        timeout: 4000,
        validateStatus: (s) => s < 400
      });

      if (!resp || !resp.data || typeof resp.data !== "string") return null;

      const $ = cheerio.load(resp.data);
      let desc = $(".anunt-desc p").text().trim() ||
                 $(".anunt-desc").text().replace(/^Descriere\s*/i, "").trim() ||
                 $("meta[name='description']").attr("content") ||
                 $("meta[property='og:description']").attr("content") || "";

      desc = desc.replace(/^Descriere\s*/i, "").replace(/\s+/g, ' ').trim();

      const images: string[] = [];
      $(".gallery-thumbs .gallery-thumb, .gallery-main img, .anunt-gallery img").each((_, im) => {
        let s = $(im).attr("data-src") || $(im).attr("src") || "";
        if (s) {
          if (s.startsWith("//")) s = `https:${s}`;
          if (!s.startsWith("http")) s = `${this.baseUrl}${s.startsWith('/') ? '' : '/'}${s}`;
          if (!images.includes(s) && !s.includes("no-photo")) images.push(s);
        }
      });

      let dateBadge = "";
      $("main.page-wrap span, .breadcrumb span").each((_, sp) => {
        const t = $(sp).text().trim();
        if (t.includes("ieri") || t.includes("azi") || t.includes("acum") || t.includes("ore") || t.includes("minute")) {
          dateBadge = t;
        }
      });

      let phone: string | undefined = undefined;
      const m = link.match(/\/(\d{10})\//);
      if (m) phone = m[1];
      if (!phone) {
        const telLink = $("a[href^='tel:']").text().replace(/\D/g, "");
        if (telLink) phone = telLink;
      }

      const result = {
        desc: desc && desc.length > 5 ? desc : undefined,
        images: images.length > 0 ? images : undefined,
        date: dateBadge || undefined,
        phone
      };

      if (result.desc) {
        bursaDetailCache.set(link, {
          desc: result.desc,
          images: result.images,
          date: result.date,
          phone: result.phone,
          timestamp: Date.now()
        });
      }

      return result;
    } catch {
      return null;
    }
  }

  async enrichListingsWithDescriptions(listings: any[], maxTimeMs = 2500): Promise<void> {
    if (!listings || listings.length === 0) return;
    const now = Date.now();
    const CACHE_TIME = 2 * 60 * 60 * 1000; // 2 hours

    const toFetch: any[] = [];
    for (const item of listings) {
      if (!item.link) continue;
      const cached = bursaDetailCache.get(item.link);
      if (cached && (now - cached.timestamp < CACHE_TIME) && cached.desc && cached.desc.length > 5) {
        item.description = cached.desc;
        if (cached.images && cached.images.length > 0) item.images = cached.images;
        if (cached.date) item.date = cached.date;
      } else {
        toFetch.push(item);
      }
    }

    if (toFetch.length === 0) return;

    // Concurrently fetch the first 15 uncached ads with a hard timeout
    const targetSlice = toFetch.slice(0, 15);
    const fetchPromises = targetSlice.map(async (item) => {
      const details = await this.fetchListingDetailDirect(item.link);
      if (details) {
        if (details.desc) item.description = details.desc;
        if (details.images && details.images.length > 0) {
          item.images = details.images;
          item.image = details.images[0];
        }
        if (details.date) item.date = details.date;
      }
    });

    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, maxTimeMs));
    await Promise.race([Promise.all(fetchPromises), timeoutPromise]);
  }
}

const bursaplacerilor = new BursaPlacerilorScraper();

async function startServer() {
  console.log(`[SERVER] startServer() called at ${new Date().toISOString()}`);
  try {
    const app = express();
    const PORT = 3000;

  app.use(express.json({ limit: "20mb" }));

  // Ensure JSON parsing errors return JSON, never HTML
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && (err as any).status === 400 && "body" in err) {
      return res.status(400).json({ error: "invalid_json_payload" });
    }
    next(err);
  });

  // Request logger middleware with phone number masking
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (req.url !== '/api/health') {
        const sanitizedUrl = req.url.replace(/([?&](?:phone|phoneNumber|q)=)(\d+)/gi, (_m, prefix, digits) => {
          return `${prefix}${digits.slice(0, 3)}***${digits.slice(-2)}`;
        });
        console.log(`[SERVER] ${req.method} ${sanitizedUrl} - ${res.statusCode} (${duration}ms)`);
      }
    });
    next();
  });

  // Health check route
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Helper to fetch a single remote Publi24 page (~20 listings per remote page)
  async function fetchPubli24SinglePage(county = "", city = "", remotePage = 1, query = ""): Promise<{ listings: any[]; totalResults: number | null }> {
    const pageNum = remotePage;
    try {
      // Construct URL
      // Main category: https://www.publi24.ro/anunturi/matrimoniale/
      const baseUrl = "https://www.publi24.ro/anunturi/matrimoniale/";
      
      // Build the path parts
      const pathParts = [];
      if (county) pathParts.push(county);
      if (city) pathParts.push(city);
      
      // Function to build URL with given parameters
      const buildUrl = (usePathPagination: boolean, includeSort: boolean) => {
        const currentPathParts = [...pathParts];
        if (pageNum > 1 && usePathPagination) {
          currentPathParts.push(`pag-${pageNum}`);
        }
        
        const pathString = currentPathParts.length > 0 ? currentPathParts.join("/") + "/" : "";
        const queryParams = new URLSearchParams();
        
        if (query) queryParams.append("q", query as string);
        if (pageNum > 1 && !usePathPagination) queryParams.append("pag", pageNum.toString());
        if (includeSort) queryParams.append("sort", "date");
        
        return `${baseUrl}${pathString}?${queryParams.toString()}`;
      };

      // Try primary URL construction:
      // Always prioritize query-based pagination (usePathPagination = false) to prevent silent page 1 redirects from the provider
      let url = buildUrl(false, true);

      console.log(`[SCRAPER] Fetching URL: ${url}`);

      let response;
      try {
        response = await fetchWithRetry(url, {
          timeout: 30000,
          headers: getHeaders()
        });
      } catch (axiosError: any) {
        console.error(`[SCRAPER] Network error for ${url}: ${axiosError.message}`);
        throw axiosError;
      }

      if (response.status === 404) {
        console.warn(`[SCRAPER] 404 detected for ${url}, trying fallback...`);
        
        // Fallback 1: Try without sort
        const fallbackUrl1 = buildUrl(false, false);
        console.log(`[SCRAPER] Trying fallback 1: ${fallbackUrl1}`);
        response = await fetchWithRetry(fallbackUrl1, {
          timeout: 30000,
          headers: getHeaders()
        });
        
        if (response.status === 404) {
          // Fallback 2: Try the other pagination style (path-based)
          const fallbackUrl2 = buildUrl(true, true);
          console.log(`[SCRAPER] Trying fallback 2: ${fallbackUrl2}`);
          response = await fetchWithRetry(fallbackUrl2, {
            timeout: 30000,
            headers: getHeaders()
          });
          
          if (response.status === 404) {
            // Fallback 3: Try main category without location
            const finalPath = "";
            const queryParams = new URLSearchParams();
            if (query) queryParams.append("q", query as string);
            if (pageNum > 1) queryParams.append("pag", pageNum.toString());
            queryParams.append("sort", "date");
            
            const finalUrl = `${baseUrl}${finalPath}?${queryParams.toString()}`;
            console.log(`[SCRAPER] Trying fallback 3: ${finalUrl}`);
            response = await fetchWithRetry(finalUrl, {
              timeout: 30000,
              headers: getHeaders()
            });
          }
        }
      }

      console.log(`[SCRAPER] Response status: ${response.status}`);
      console.log(`[SCRAPER] HTML length: ${response.data.length}`);
      if (response.data.includes("Cloudflare") || response.data.includes("challenge")) {
        console.log("[SCRAPER] Cloudflare challenge detected!");
      }
      
      const $ = cheerio.load(response.data);
      
      // Parse total results count
      let totalResults: number | null = null;
      try {
        const h1Text = $("h1").text() || "";
        const h1Match = h1Text.match(/(\d+[\d\s.,]*)\s*(?:de\s+)?(?:anunțuri|anunturi|rezultate)/i) || h1Text.match(/\((\d+[\d\s.,]*)\)/);
        if (h1Match) {
          totalResults = parseInt(h1Match[1].replace(/[^\d]/g, "")) || null;
        }

        if (!totalResults) {
          const paginationText = $(".pagination, .pager, .paginationText, .pageNavSimple, .block-outer-opposite, .showing-results, .results-count").text() || "";
          const pagMatch = paginationText.match(/(?:of|din|from)\s+(\d+[\d\s.,]*)/i);
          if (pagMatch) {
            totalResults = parseInt(pagMatch[1].replace(/[^\d]/g, "")) || null;
          }
        }

        if (!totalResults) {
          $(".total-results, .ad-count, .results-count, .count-listings, .count, .title-results, .title-ads-count, .search-results-count").each((_, el) => {
            const t = $(el).text().trim();
            const match = t.match(/(\d+[\d\s.,]*)/);
            if (match) {
              totalResults = parseInt(match[1].replace(/[^\d]/g, "")) || null;
              return false;
            }
          });
        }

        if (!totalResults) {
          const bodyText = $("body").text();
          const bodyMatch = bodyText.match(/(\d+[\d\s.,]*)\s+(?:anunțuri|anunturi|rezultate|anuncios)/i);
          if (bodyMatch) {
            totalResults = parseInt(bodyMatch[1].replace(/[^\d]/g, "")) || null;
          }
        }
      } catch (err) {
        console.warn("[SCRAPER] Failed to parse totalResults:", err);
      }

      const listings: any[] = [];

      // Publi24 often uses a specific wrapper for the list
      const listContainer = $(".listing-list, .ad-list, #list-container");
      console.log(`[SCRAPER] List container found: ${listContainer.length > 0}`);

      // Try a very broad selector first
      const items = $("li[id^='ad-'], .ad-item, .listing-item, article, .ad-list-item, .listing-list li, .listing-list > div, .ad-box, .listing-item-container");
      console.log(`[SCRAPER] Found ${items.length} items with primary selectors`);
      
      if (items.length === 0) {
        console.log("[SCRAPER] No items found, logging first 1000 chars of HTML:");
        console.log(response.data.slice(0, 1000));
      }

      items.each((i, el) => {
        // Collect all items from the page first, then filter and slice
        const title = $(el).find("h2, h3, .title, .ad-title, a.title, .listing-title, .ad-box-title, .ad-box-title-link").text().trim();
        const link = $(el).find("a[href*='/anunt/'], a[href*='.html']").first().attr("href");
        let description = $(el).find(".ad-description, .description, .ad-box-description, .listing-description, p.description, .snippet, .summary, .ad-text, .ad-content, .ad-details-text, .ad-box-content, .ad-details-content, .ad-box-summary, .ad-box-text, .ad-box-details, .ad-box-description-text, .ad-box-details-text").text().trim();
        
        // Clean up description
        description = description.replace(/\s+/g, ' ').trim();
        if (description.includes("Fără descriere")) description = "";
        
        // Improved location extraction
        let location = $(el).find(".location, .ad-location, .listing-location, .city-county, span[title*='Locatie'], .ad-city, .listing-city, .ad-box-location, .ad-box-city, .ad-box-county").first().text().trim();
        if (!location) {
          // Try to find text that looks like "City, County"
          $(el).find("span, p, div").each((_, subEl) => {
            const text = $(subEl).text().trim();
            if (text.includes(",") && text.length < 50 && text.length > 3) {
              location = text;
              return false;
            }
          });
        }

        // Deduplicate location (e.g. "Bucuresti, Bucuresti" -> "Bucuresti")
        if (location) {
          // Check for glued repetition like "Timisoara, TimisTimisoara, Timis"
          const mid = Math.floor(location.length / 2);
          for (let i = mid - 2; i <= mid + 2; i++) {
            if (i <= 0) continue;
            const first = location.slice(0, i).trim();
            const second = location.slice(i).trim();
            if (first === second) {
              location = first;
              break;
            }
          }

          const parts = location.split(/[,|\s-]+/).map(p => p.trim()).filter(p => p.length > 0);
          const uniqueParts = Array.from(new Set(parts));
          if (uniqueParts.length < parts.length) {
            // Reconstruct if we found duplicates
            location = uniqueParts.join(", ");
          }
        }

        // Server-side city filtering (safeguard for fallbacks)
        if (city && location) {
          const requestedCity = (city as string).toLowerCase().replace(/-/g, ' ');
          const resultLocation = location.toLowerCase();
          // Check if the location contains the city name (e.g. "Alba Iulia, Alba" contains "alba iulia")
          if (!resultLocation.includes(requestedCity)) {
            console.log(`[SCRAPER] Skipping item ${i} due to city mismatch: ${location} vs ${requestedCity}`);
            return true; // skip this item
          }
        }

        // Extract price
        let price = $(el).find(".price, .ad-price, .listing-price, .ad-box-price, .ad-box-price-value").text().trim();
        if (!price) {
          // Look for something that looks like a price (e.g., "100 €", "100 RON")
          $(el).find("span, p, div").each((_, subEl) => {
            const text = $(subEl).text().trim();
            if (text.match(/\d+[\s\.]*(€|RON|EUR|lei)/i)) {
              price = text;
              return false;
            }
          });
        }

        console.log(`[SCRAPER] Processing item ${i}: ${title}`);

        // Extract date
        let date = $(el).find(".ad-date, .date, .listing-date, span[title*='Data'], .ad-box-date, .ad-box-footer span:last-child").text().trim();
        if (!date) {
          // Look for something that looks like a date (e.g., "Azi", "Ieri", or "DD.MM.YYYY")
          $(el).find("span, p, div").each((_, subEl) => {
            const text = $(subEl).text().trim();
            if (text.match(/Azi|Ieri|\d{2}\.\d{2}\.\d{4}/)) {
              date = text;
              return false;
            }
          });
        }

        // Filtering removed as per user request to show all results from the site
        
        // 2. Filter out common placeholder images
        const placeholders = ["no-photo", "placeholder", "default-ad", "static/img/", "noimage", "transparent.gif", "pixel.gif", "blank.gif", "spacer.gif", "loading.gif"];
        
        const isPlaceholder = (url: string | undefined) => {
          if (!url) return true;
          const u = url.toLowerCase();
          // Check for very small images or common placeholder names
          return placeholders.some(p => u.includes(p)) || u.endsWith(".gif");
        };

        // Collect all potential images
        let itemImages: string[] = [];
        $(el).find("img, source").each((_, imgEl) => {
          const $img = $(imgEl);
          const src = $img.attr("data-src") || $img.attr("data-original") || $img.attr("src") || $img.attr("srcset") || $img.attr("data-srcset");
          if (src) {
            let finalSrc = src;
            if (finalSrc.includes(",")) finalSrc = finalSrc.split(",")[0].trim().split(" ")[0];
            if (finalSrc.startsWith("//")) finalSrc = `https:${finalSrc}`;
            if (!finalSrc.startsWith("http")) finalSrc = `${baseUrl}${finalSrc.startsWith("/") ? "" : "/"}${finalSrc}`;
            
            if (!itemImages.includes(finalSrc) && !isPlaceholder(finalSrc) && !finalSrc.includes("logo") && !finalSrc.includes("icon")) {
              itemImages.push(finalSrc);
            }
          }
        });

        // Also check noscript
        const noscript = $(el).find("noscript").html();
        if (noscript) {
          const noscript$ = cheerio.load(noscript);
          noscript$("img").each((_, nsImg) => {
            const nsSrc = noscript$(nsImg).attr("src");
            if (nsSrc) {
              let finalNsSrc = nsSrc;
              if (finalNsSrc.startsWith("//")) finalNsSrc = `https:${finalNsSrc}`;
              if (!finalNsSrc.startsWith("http")) finalNsSrc = `${baseUrl}${finalNsSrc.startsWith("/") ? "" : "/"}${finalNsSrc}`;
              if (!itemImages.includes(finalNsSrc) && !isPlaceholder(finalNsSrc)) {
                itemImages.push(finalNsSrc);
              }
            }
          });
        }

        // Normalize thumbnails to large full-sized images
        itemImages = itemImages.map(img => {
          let u = img;
          if (u.includes("s3.publi24.ro") || u.includes("publi24.ro") || u.includes("inspector")) {
            u = u.replace(/\/(medium|small|t|thumb|thumbs|thumbnail)\//gi, "/large/");
          }
          return u;
        });

        let image = itemImages.length > 0 ? itemImages[0] : null;
        console.log(`[SCRAPER] Found ${itemImages.length} images for item ${i}`);

        // 4. If primary search failed or found a placeholder, look for ANY image tag that isn't a placeholder
        if (isPlaceholder(image)) {
          const source = $(el).find("picture source, source").first();
          let srcset = source.attr("srcset") || source.attr("data-srcset") || source.attr("data-src");
          if (srcset) {
            // srcset can be "url1 1x, url2 2x"
            image = srcset.split(",")[0].trim().split(" ")[0];
            console.log(`[SCRAPER] Found image in picture/source for item ${i}: ${image}`);
          }
        }
        if (isPlaceholder(image)) {
          $(el).find("img").each((_, imgEl) => {
            const possible = $(imgEl).attr("data-src") || $(imgEl).attr("data-original") || $(imgEl).attr("src") || $(imgEl).attr("data-lazy-src") || $(imgEl).attr("srcset");
            let finalPossible = possible;
            if (finalPossible && finalPossible.includes(",")) {
              finalPossible = finalPossible.split(",")[0].trim().split(" ")[0];
            }
            if (finalPossible && !isPlaceholder(finalPossible)) {
              image = finalPossible;
              console.log(`[SCRAPER] Found alternative image for item ${i}: ${image}`);
              return false; // break
            }
          });
        }

        // 5. Check for background images in ANY element within the item
        if (isPlaceholder(image)) {
          $(el).find("*").each((_, subEl) => {
            const style = $(subEl).attr("style");
            if (style && style.includes("background-image")) {
              const bgMatch = style.match(/url\(['"]?([^'"]+)['"]?\)/);
              if (bgMatch && !isPlaceholder(bgMatch[1])) {
                image = bgMatch[1];
                console.log(`[SCRAPER] Found background image for item ${i}: ${image}`);
                return false;
              }
            }
          });
        }

        // 6. Extreme fallback: Look for any attribute in any element that looks like a Publi24 image URL
        if (isPlaceholder(image)) {
          $(el).find("*").each((_, subEl) => {
            const attrs = subEl.attribs;
            for (const attr in attrs) {
              const val = attrs[attr];
              if (val && (val.includes("publi24.ro") || val.includes("/anunturi/")) && 
                  (val.includes(".jpg") || val.includes(".jpeg") || val.includes(".png") || val.includes(".webp"))) {
                if (!isPlaceholder(val)) {
                  image = val;
                  console.log(`[SCRAPER] Found image in attribute ${attr} for item ${i}: ${image}`);
                  return false;
                }
              }
            }
            if (image && !isPlaceholder(image)) return false;
          });
        }

        // 7. Check the element itself if it's an image
        if (isPlaceholder(image) && $(el).is("img")) {
           const selfImg = $(el).attr("src") || $(el).attr("data-src");
           if (!isPlaceholder(selfImg)) {
             image = selfImg;
             console.log(`[SCRAPER] Found image on self for item ${i}: ${image}`);
           }
        }

        if (title && link && (link.includes("/anunt/") || link.includes(".html"))) {
          // Clean up image URL
          let finalImage = image;
          
          // Extract ID from link or attributes in a highly robust way
          const adId = extractAdId(link) || $(el).attr("data-id") || $(el).find("[data-id]").attr("data-id") || $(el).find(".call-btn, .suna-btn").attr("data-id");

          if (finalImage) {
            if (finalImage.startsWith("//")) {
              finalImage = `https:${finalImage}`;
            } else if (!finalImage.startsWith("http")) {
              finalImage = `https://www.publi24.ro${finalImage.startsWith("/") ? "" : "/"}${finalImage}`;
            }

            if (finalImage.includes("s3.publi24.ro") || finalImage.includes("publi24.ro") || finalImage.includes("inspector")) {
              finalImage = finalImage.replace(/\/(medium|small|t|thumb|thumbs|thumbnail)\//gi, "/large/");
            }
          }

          listings.push({
            id: adId || i,
            title,
            link: link.startsWith("http") ? link : `https://www.publi24.ro${link}`,
            image: finalImage || image,
            images: itemImages,
            location: location || "Locatie nespecificata",
            date: date || "",
            description: description || "Fără descriere disponibilă",
            price: price || "N/A",
            phoneNumber: "Click to reveal",
            adId: adId,
            source: 'publi24'
          });
        }
      });

      // If still empty, try to find ANY link that looks like an ad
      if (listings.length === 0) {
        console.log("[SCRAPER] Trying emergency fallback selector...");
        $("a[href*='/anunt/']").each((i, el) => {
          const href = $(el).attr("href");
          const text = $(el).text().trim();
          
          if (href && text.length > 10) {
            // Try to find an image near this link
            const container = $(el).closest("li, div, article, .ad-box");
            let emergencyImg = container.find("img").attr("src") || 
                               container.find("img").attr("data-src") ||
                               container.find("img").attr("data-original") ||
                               $(el).find("img").attr("src");
            
            let emergencyLoc = container.find(".location, .ad-location, .listing-location, .city-county, .ad-city").text().trim();
            if (!emergencyLoc) {
              container.find("span, p").each((_, subEl) => {
                const t = $(subEl).text().trim();
                if (t.includes(",") && t.length < 40) {
                  emergencyLoc = t;
                  return false;
                }
              });
            }

            let emergencyDate = container.find(".ad-date, .date, .listing-date, span[title*='Data'], .ad-box-date").text().trim();
            if (!emergencyDate) {
              container.find("span, p").each((_, subEl) => {
                const t = $(subEl).text().trim();
                if (t.match(/Azi|Ieri|\d{2}\.\d{2}\.\d{4}/)) {
                  emergencyDate = t;
                  return false;
                }
              });
            }

            listings.push({
              id: `emergency-${i}`,
              title: text,
              link: href.startsWith("http") ? href : `https://www.publi24.ro${href}`,
              image: emergencyImg,
              location: emergencyLoc || "Locatie nespecificata",
              date: emergencyDate || "",
              description: "Fără descriere disponibilă",
              phoneNumber: "Click to reveal",
              source: 'publi24'
            });
          }
        });
      }

      return { listings, totalResults };
    } catch (err: any) {
      console.warn(`[SCRAPER] Error on remote page ${remotePage}:`, err.message);
      return { listings: [], totalResults: null };
    }
  }

  // API Route for scraping Publi24 (supports 100 results per page via parallel remote fetches)
  app.get("/api/scrape", async (req, res) => {
    const { county = "", city = "", page = 1, query = "", limit = 100 } = req.query;
    const start = Date.now();
    const pageNum = parseInt(page as string) || 1;
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string) || 100));

    console.log(`[ROUTE] /api/scrape START - county: ${county}, city: ${city}, page: ${pageNum}, query: "${query}", limit: ${limitNum}`);

    try {
      // 20 items per remote page on Publi24 -> for 100 items, fetch 5 remote pages in parallel
      const remotePagesCount = Math.max(1, Math.ceil(limitNum / 20));
      const startRemotePage = (pageNum - 1) * remotePagesCount + 1;
      const remotePages = Array.from({ length: remotePagesCount }, (_, i) => startRemotePage + i);

      console.log(`[SCRAPER] Fetching ${remotePages.length} Publi24 remote pages in parallel: [${remotePages.join(', ')}]`);

      const responses = await Promise.all(
        remotePages.map(rp => fetchPubli24SinglePage(county as string, city as string, rp, query as string))
      );

      const allListings: any[] = [];
      let parsedTotalResults: number | null = null;

      for (const r of responses) {
        if (r.totalResults && !parsedTotalResults) {
          parsedTotalResults = r.totalResults;
        }
        allListings.push(...r.listings);
      }

      // Helper to normalize link for strict deduplication
      const normalizeLink = (url: string) => {
        if (!url) return '';
        return url.split('?')[0].split('#')[0].trim().replace(/\/$/, '').toLowerCase();
      };

      // Filter out duplicate listings based on normalized link
      const uniqueListings = allListings.filter((item, index, self) =>
        item.link && index === self.findIndex((t) => normalizeLink(t.link) === normalizeLink(item.link))
      );

      const pageResults = uniqueListings.slice(0, limitNum);

      console.log(`[SCRAPER] Returning ${pageResults.length} unique listings (from ${uniqueListings.length} found across ${remotePages.length} remote pages, limit: ${limitNum}) in ${Date.now() - start}ms`);
      res.json({ listings: pageResults, totalResults: parsedTotalResults || uniqueListings.length });
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      console.error(`[ROUTE] /api/scrape ERROR after ${Date.now() - start}ms:`, errorMsg);
      res.status(500).json({ error: errorMsg });
    }
  });

  const phoneCache = new Map<string, { timestamp: number; data: any }>();
  const detailCache = new Map<string, { timestamp: number; data: any }>();
  const CACHE_TTL = 30 * 60 * 1000; // 30 minutes in-memory caching for ultimate speed

  // API Route for fetching phone number
  app.get("/api/phone", async (req, res) => {
    const { url, id, full } = req.query;
    const start = Date.now();
    
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }

    const cacheKey = `${url}_f:${full}_id:${id}`;
    const cached = phoneCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      console.log(`[CACHE HIT] /api/phone - url: ${url}`);
      return res.json(cached.data);
    }

    try {
      console.log(`[ROUTE] /api/phone START - url: ${url}, id: ${id}, full: ${full}`);
      const isInspector = url.includes("inspector-escorte.ro");
      const referer = isInspector ? "https://inspector-escorte.ro/" : "https://www.publi24.ro/";

      // 1. Fetch the detail page first to get cookies and session
      const detailResponse = await fetchWithRetry(url, {
        timeout: 15000,
        headers: getHeaders(referer)
      }, 2, true); // Use cookie jar!

      if (detailResponse.status === 404) {
        return res.status(404).json({ error: "Ad not found or expired" });
      }

      const $ = cheerio.load(detailResponse.data);
      
      // If full text is requested for AI analysis
      if (full === "true") {
        $("script, style, head, footer, nav").remove();
        const pageText = $("body").text().replace(/\s+/g, " ").trim();
        return res.json({ pageText });
      }

      let phone = null;
      let phoneImage = null;

      // 1. Try modern Publi24 hidden EncryptedPhone form POST (extremely robust)
      const encryptedValue = $("[name='EncryptedPhone'], #EncryptedPhone").first().attr("value");
      const formAction = $("form[action*='PhoneNumberImages'], form[action*='PhoneNumber'], form[action*='phone']").first().attr("action");

      if (encryptedValue && formAction) {
        console.log(`[PHONE] Found modern EncryptedPhone value: ${encryptedValue}, form action: ${formAction}`);
        try {
          const postUrl = formAction.startsWith("http") ? formAction : `https://www.publi24.ro${formAction}`;
          const phoneRes = await fetchWithRetry(postUrl, {
            method: "POST",
            data: `EncryptedPhone=${encodeURIComponent(encryptedValue)}`,
            headers: {
              ...getHeaders(url, true),
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest"
            }
          }, 1, true); // cookie jar

          if (phoneRes.data) {
            const dataStr = typeof phoneRes.data === 'string' ? phoneRes.data.trim() : JSON.stringify(phoneRes.data);
            if (dataStr.length > 50 && !dataStr.includes("<") && !dataStr.includes("{")) {
              phoneImage = `data:image/png;base64,${dataStr.replace(/\s+/g, "")}`;
              console.log("[PHONE] Successfully found base64 phone image via modern POST API!");
            }
          }
        } catch (e: any) {
          console.error("[PHONE] Error fetching modern POST phone image:", e.message);
        }
      }

      // 2. Try to find internal ID and fetch via getphone as a fallback
      if (!phone && !phoneImage) {
        const urlId = extractAdId(url);
        const isRealId = id && typeof id === 'string' && id.trim().length >= 4 && !/^[0-9]$|^[1-2][0-9]$/.test(id.trim());
        const internalId = (isRealId ? id : null) || 
                           urlId ||
                           $(".call-btn, .suna-btn, [data-id], .btn-show-phone").attr("data-id") || 
                           detailResponse.data.match(/data-id=["']?([a-zA-Z0-9]+)["']?/)?.[1] ||
                           detailResponse.data.match(/adId:\s?['"]?([a-zA-Z0-9]+)['"]?/)?.[1];

        if (internalId) {
          console.log(`[PHONE] Using ID for getphone: ${internalId}`);
          try {
            const phoneUrls = [
              `https://www.publi24.ro/getphone?id=${internalId}`,
              `https://www.publi24.ro/getphone?id=${internalId}&is_mobile=1`,
              `https://www.publi24.ro/anunturi/getphone?id=${internalId}`
            ];

            for (const pUrl of phoneUrls) {
              try {
                const phoneRes = await fetchWithRetry(pUrl, {
                  timeout: 6000,
                  headers: {
                    ...getHeaders(url, true),
                    "Accept": "*/*",
                    "X-Requested-With": "XMLHttpRequest"
                  }
                }, 1, true); // Use cookie jar!
                
                if (phoneRes.data) {
                  const data = typeof phoneRes.data === 'string' ? phoneRes.data.trim() : JSON.stringify(phoneRes.data);
                  
                  // If it's a plain phone number
                  if (data.length > 5 && !data.includes("<") && !data.includes("{")) {
                    phone = data;
                    console.log(`[PHONE] Found phone via getphone: ${phone}`);
                    break;
                  }
                  
                  // If it's HTML
                  if (data.includes("<")) {
                    const $phone = cheerio.load(data);
                    const telSpan = $phone(".telnumber, .phone-image, .phone-img, [style*='data:image']");
                    const style = telSpan.attr("style") || data;
                    const bgMatch = style.match(/data:image\/([^;]+);base64,([^"&')\s]+)/);
                    if (bgMatch) {
                      phoneImage = `data:image/${bgMatch[1]};base64,${bgMatch[2].replace(/\s+/g, "")}`;
                      console.log("[PHONE] Found base64 phone image via getphone HTML");
                      break;
                    }

                    const text = $phone("span, a, p, b").text().trim();
                    if (text && text.length > 5 && /\d/.test(text)) {
                      phone = text;
                      console.log(`[PHONE] Found phone text in getphone HTML: ${phone}`);
                      break;
                    }
                  }

                  // If it's JSON
                  if (typeof phoneRes.data === 'object' && phoneRes.data.phone) {
                    phone = phoneRes.data.phone;
                    break;
                  }
                }
              } catch (e) {}
              if (phone || phoneImage) break;
            }
          } catch (e) {}
        }
      }

      // 3. Check for phone in page selectors if getphone failed
      if (!phone && !phoneImage) {
        phone = $(".phone-number, [data-phone], .tel, .contact-phone, .ad-contact-phone, .call-btn, .suna-btn").attr("data-phone") || 
                $(".phone-number, [data-phone], .tel, .contact-phone, .ad-contact-phone, .call-btn, .suna-btn").text().trim();
        
        // Check for base64 image in style attribute
        const telSpan = $(".telnumber, .phone-image, .phone-img, .ad-phone-img, [style*='data:image'], .phone-box span, .contact-info span");
        telSpan.each((_, el) => {
          const style = $(el).attr("style") || "";
          const bgMatch = style.match(/data:image\/([^;]+);base64,([^"&')\s]+)/);
          if (bgMatch) {
            phoneImage = `data:image/${bgMatch[1]};base64,${bgMatch[2].replace(/\s+/g, "")}`;
            console.log("[PHONE] Found base64 phone image in page style attribute");
            return false;
          }
        });
      }

      // 4. Check for <img> tags
      if (!phone && !phoneImage) {
        const imgPhone = $("img[src*='data:image'], img[data-src*='data:image']");
        imgPhone.each((_, el) => {
          const src = $(el).attr("src") || $(el).attr("data-src");
          if (src && src.includes("base64") && src.length > 100) {
            phoneImage = src;
            console.log("[PHONE] Found base64 phone image in img tag");
            return false;
          }
        });
      }

      // 5. Check for phone in script tags
      if (!phone && !phoneImage) {
        $("script").each((_, script) => {
          const content = $(script).html() || "";
          if (!content) return;

          const patterns = [
            /"telephone":\s?"([^"]+)"/i,
            /phone:\s?['"]([^'"]+)['"]/i,
            /contactPhone:\s?['"]([^'"]+)['"]/i,
            /mobile:\s?['"]([^'"]+)['"]/i,
            /tel:\s?['"]([^'"]+)['"]/i,
            /07\d{8}/,
            /07\d{2}[\s.-]\d{3}[\s.-]\d{3}/
          ];

          for (const pattern of patterns) {
            const match = content.match(pattern);
            if (match) {
              const val = match[1] || match[0];
              if (val && val.length >= 10 && val.includes("07")) {
                phone = val;
                console.log(`[PHONE] Found phone in script: ${phone}`);
                return false;
              }
            }
          }
        });
      }

      // 6. Final fallback: Look for any 10-digit number starting with 07 in the whole HTML
      if (!phone && !phoneImage) {
        const bodyText = $("body").text();
        const phoneMatch = bodyText.match(/07\d{8}/) || bodyText.match(/07\d{2}[\s.-]\d{3}[\s.-]\d{3}/);
        if (phoneMatch) {
          phone = phoneMatch[0];
          console.log(`[PHONE] Found phone in body text: ${phone}`);
        }
      }

      if (phone) {
        // Keep only the first phone number if multiple are found
        if (phone.includes(",")) phone = phone.split(",")[0].trim();
        if (phone.includes("/")) phone = phone.split("/")[0].trim();
        if (phone.includes(";")) phone = phone.split(";")[0].trim();
        
        // Clean up phone number
        phone = phone.replace(/[^\d]/g, "");
        if (phone.length >= 10) {
          // Keep only the first 10 digits if multiple are concatenated (starting with 07)
          if (phone.length > 10) {
            const firstMatch = phone.match(/07\d{8}/);
            if (firstMatch) {
              phone = firstMatch[0];
            } else {
              phone = phone.slice(0, 10);
            }
          }
          if (isBrandOrFakePhone(phone)) {
            console.log(`[PHONE] Rejected fake/brand phone watermark: ${phone}`);
            phone = null;
          } else {
            phone = phone.replace(/\s+/g, "");
          }
        } else {
          if (isBrandOrFakePhone(phone)) {
            phone = null;
          }
        }
      } else if (!phoneImage) {
        phone = "Not found";
      }

      console.log(`[ROUTE] /api/phone SUCCESS - found ${phone ? 'text' : (phoneImage ? 'image' : 'nothing')} in ${Date.now() - start}ms`);
      const responseData = { phone, phoneImage };
      phoneCache.set(cacheKey, { timestamp: Date.now(), data: responseData });
      res.json(responseData);
    } catch (error: any) {
      let status = error.response?.status || 500;
      if (typeof status !== "number" || status < 100 || status > 599) {
        status = 500;
      }
      const errorMsg = error.response?.data?.error || error.message || String(error);
      console.error(`[ROUTE] /api/phone ERROR (${status}) after ${Date.now() - start}ms:`, errorMsg);
      res.status(status).json({ error: `Failed to fetch phone number: ${errorMsg}` });
    }
  });

  // Reusable function for fetching listing details and checking active/expired status
  async function scrapeListingFullDetails(url: string, bypassCache = false) {
    const start = Date.now();
    if (!bypassCache) {
      const cached = detailCache.get(url);
      if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        console.log(`[CACHE HIT] scrapeListingFullDetails - url: ${url}`);
        return cached.data;
      }
    }

    console.log(`[SCRAPE DETAIL] START - url: ${url} (bypassCache: ${bypassCache})`);
    const isInspector = url.includes("inspector-escorte.ro");
    const isBursa = url.includes("bursaplacerilor.com");
    const referer = isBursa ? "https://bursaplacerilor.com/" : (isInspector ? "https://inspector-escorte.ro/" : "https://www.publi24.ro/");

    let response: any;
    try {
      response = await fetchWithRetry(url, {
        timeout: 20000,
        headers: getHeaders(referer)
      }, 2, true); // Use cookie jar
    } catch (err: any) {
      if (err.response?.status === 404 || err.message?.includes("404")) {
        return {
          isExpired: true,
          title: "",
          price: "",
          location: "",
          date: "",
          image: null,
          images: [],
          description: "Anunțul nu mai este activ sau a fost șters.",
          pageText: "",
          phone: null,
          phoneImage: null
        };
      }
      throw err;
    }

    const $ = cheerio.load(response.data);

    // Check if ad is expired or deactivated
    const bodyText = $("body").text();
    const isExpired = 
      bodyText.includes("Anunțul nu mai este activ") || 
      bodyText.includes("anuntul nu mai este activ") ||
      bodyText.includes("Anunțul a expirat") ||
      bodyText.includes("anunt expirat") ||
      bodyText.includes("anuntul a fost sters") ||
      bodyText.includes("nu a fost găsit") ||
      $(".ad-expired, .alert-warning:contains('expirat')").length > 0;

    // Extract title
    let title = $("h1").first().text().trim() || 
                $("meta[property='og:title']").attr("content") || 
                $("meta[name='twitter:title']").attr("content") || "";
    if (title.includes("|")) title = title.split("|")[0].trim();

    // Extract price
    let price = $(".price, .pret, .ad-price, [data-price], .item-price").first().text().trim() || "";

    // Extract location
    let location = $(".location, .ad-location, .address, .city-county, [data-location]").first().text().trim() || "";
    if (isBursa) {
      const bcParts: string[] = [];
      $(".container a, .breadcrumb a, nav.navbar a").each((_, el) => {
        const t = $(el).text().trim();
        if (t && (t.includes("Sector") || t.includes("Bucure") || t.includes("Cluj") || t.includes("Timi") || t.includes("Iași") || t.includes("Brașov") || t.includes("Constan"))) {
          if (!bcParts.includes(t)) bcParts.push(t);
        }
      });
      if (bcParts.length > 0) {
        location = bcParts.join(", ");
      }
    }

    // Extract date
    let date = $(".date, .ad-date, .listing-date, [data-date]").first().text().trim() || "";

    // 1. Try to find the "best" image candidates
    const candidates: string[] = [];
    
    // Meta tags are usually the highest quality
    const ogImage = $("meta[property='og:image']").attr("content");
    if (ogImage) candidates.push(ogImage);
    
    const twitterImage = $("meta[name='twitter:image']").attr("content");
    if (twitterImage) candidates.push(twitterImage);

    // Main image containers
    $(".image-container img, .detail-image img, #main-image, .main-image img, .ad-image img, .gallery img, .slider img, .ad-photos img, .ad-gallery img, a.image-anchor img, .photo-gallery img, .swiper-slide img, .slick-slide img, [data-fancybox] img, .ad-thumb img, .ad-photo img, .listing-photos img, .ad-detail-images img, .ad-gallery-item img, .sp-image").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-original") || $(el).attr("data-lazy-src") || $(el).attr("data-srcset") || $(el).attr("data-full") || $(el).attr("data-big") || $(el).attr("data-large");
      if (src) {
        if (src.includes(",")) {
          candidates.push(src.split(",")[0].trim().split(" ")[0]);
        } else {
          candidates.push(src);
        }
      }
    });

    // Scan ALL image tags on the page
    $("img").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-original") || $(el).attr("data-lazy-src") || $(el).attr("data-srcset") || $(el).attr("data-full") || $(el).attr("data-big") || $(el).attr("data-large");
      if (src) {
        if (src.includes(",")) {
          candidates.push(src.split(",")[0].trim().split(" ")[0]);
        } else {
          candidates.push(src);
        }
      }
    });

    // Scan ALL link tags on the page that could lead to full-sized images
    $("a").each((_, el) => {
      const href = $(el).attr("href") || $(el).attr("data-src") || $(el).attr("data-large") || $(el).attr("data-full");
      if (href) {
        const h = href.toLowerCase();
        if (h.includes(".jpg") || h.includes(".jpeg") || h.includes(".webp") || h.includes(".png") || h.includes("s3.publi24.ro") || h.includes("s3-ro")) {
          candidates.push(href);
        }
      }
    });

    // Regex to scan entire raw HTML for any s3.publi24.ro image references
    const rawHtml = response.data;
    const s3ImageRegex = /https?:\\?\/\\?\/s3\.publi24\.ro\\?\/[^\s'"`<>]+/gi;
    let match;
    while ((match = s3ImageRegex.exec(rawHtml)) !== null) {
      let cleanUrl = match[0].replace(/\\/g, "");
      cleanUrl = cleanUrl.split(/['"{}()<>]/)[0];
      candidates.push(cleanUrl);
    }

    // Filter and clean candidates
    let bestImage = null;
    const validCandidates = candidates
      .map(src => {
        let finalSrc = src;
        if (finalSrc.startsWith("//")) finalSrc = `https:${finalSrc}`;
        if (!finalSrc.startsWith("http")) {
          const domain = isBursa ? "https://bursaplacerilor.com" : (isInspector ? "https://inspector-escorte.ro" : "https://www.publi24.ro");
          finalSrc = `${domain}${finalSrc.startsWith("/") ? "" : "/"}${finalSrc}`;
        }
        if (finalSrc.includes("s3.publi24.ro") || finalSrc.includes("publi24.ro") || finalSrc.includes("inspector")) {
          finalSrc = finalSrc.replace(/\/(medium|small|t|thumb|thumbs|thumbnail)\//gi, "/large/");
        }
        return finalSrc;
      })
      .filter(src => {
        const s = src.toLowerCase();
        return (s.includes(".jpg") || s.includes(".jpeg") || s.includes(".webp") || s.includes(".png")) && 
               !s.includes("placeholder") && !s.includes("no-photo") && !s.includes("logo") && !s.includes("icon") &&
               !s.includes("avatar") && !s.includes("user") && !s.includes("profile");
      });

    const uniqueImages = Array.from(new Set(validCandidates));

    if (uniqueImages.length > 0) {
      bestImage = uniqueImages[0];
      const nonThumb = uniqueImages.find(c => !c.toLowerCase().includes("thumb") && !c.toLowerCase().includes("/t/"));
      if (nonThumb) bestImage = nonThumb;
    }

    // Extract description
    let description = $(".ad-description, .description, .ad-box-description, .listing-description, #ad-description, .ad-details-text, .ad-text, .ad-content, .ad-box-content, .ad-details-content, .ad-details-content-text, .ad-body, .ad-text-content, .listing-details-text, .listing-description-text, .ad-description-text, .ad-box-description-text, .ad-box-details-text, .ad-details-description, .ad-details-body, article p, .post-content, .entry-content, .ad-info, .ad-details").text().trim();
    
    if (isBursa) {
      let bDesc = $(".anunt-desc p").text().trim() ||
                  $(".anunt-desc").text().replace(/^Descriere\s*/i, "").trim() ||
                  $("meta[name='description']").attr("content") ||
                  $("meta[property='og:description']").attr("content") || "";
      bDesc = bDesc.replace(/^Descriere\s*/i, "").replace(/\s+/g, ' ').trim();
      if (bDesc) description = bDesc;
    }

    if (!description) {
      description = $("meta[property='og:description']").attr("content") || 
                    $("meta[name='description']").attr("content") || 
                    "No detailed description found on the ad page.";
    }

    description = description.replace(/\s+/g, ' ').trim();
    
    if (description && (description.length < 20 || /^\d+$/.test(description))) {
      const altDesc = $("p").filter((_, p) => {
        const t = $(p).text().trim();
        return t.length > 50 && t.length < 2000;
      }).first().text().trim();
      if (altDesc) description = altDesc;
    }

    if (!description || description.length < 5) {
      description = "No detailed description found on the ad page.";
    }

    let phone: string | null = null;
    let phoneImage: string | null = null;

    if (isBursa) {
      const m = url.match(/\/(\d{10})\//);
      if (m) phone = m[1];
      if (!phone) {
        const telLink = $("a[href^='tel:']").text().replace(/\D/g, "");
        if (telLink) phone = telLink;
      }
      if (!phone) {
        const cardPhone = $(".card-phone-num, .card-phone").text().replace(/\D/g, "");
        if (cardPhone) phone = cardPhone;
      }
    }

    // Direct phone in page HTML
    if (!phone) {
      phone = $(".phone-number, [data-phone], .tel, .contact-phone, .ad-contact-phone, .call-btn, .suna-btn").attr("data-phone") || 
              $(".phone-number, [data-phone], .tel, .contact-phone, .ad-contact-phone, .call-btn, .suna-btn").text().trim();
    }
    
    const telSpan = $(".telnumber, .phone-image, .phone-img, .ad-phone-img, [style*='data:image'], .phone-box span, .contact-info span");
    telSpan.each((_, el) => {
      const style = $(el).attr("style") || "";
      const bgMatch = style.match(/data:image\/([^;]+);base64,([^"&')\s]+)/);
      if (bgMatch) {
        phoneImage = `data:image/${bgMatch[1]};base64,${bgMatch[2].replace(/\s+/g, "")}`;
        return false;
      }
    });

    if (!phone && !phoneImage) {
      const imgPhone = $("img[src*='data:image'], img[data-src*='data:image']");
      imgPhone.each((_, el) => {
        const src = $(el).attr("src") || $(el).attr("data-src");
        if (src && src.includes("base64") && src.length > 100) {
          phoneImage = src;
          return false;
        }
      });
    }

    // 1. Try modern Publi24 hidden EncryptedPhone form POST
    const encryptedValue = $("[name='EncryptedPhone'], #EncryptedPhone").first().attr("value");
    const formAction = $("form[action*='PhoneNumberImages'], form[action*='PhoneNumber'], form[action*='phone']").first().attr("action");

    if (encryptedValue && formAction) {
      try {
        const postUrl = formAction.startsWith("http") ? formAction : `https://www.publi24.ro${formAction}`;
        const phoneRes = await fetchWithRetry(postUrl, {
          method: "POST",
          data: `EncryptedPhone=${encodeURIComponent(encryptedValue)}`,
          headers: {
            ...getHeaders(url, true),
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest"
          }
        }, 1, true);

        if (phoneRes.data) {
          const dataStr = typeof phoneRes.data === 'string' ? phoneRes.data.trim() : JSON.stringify(phoneRes.data);
          if (dataStr.length > 50 && !dataStr.includes("<") && !dataStr.includes("{")) {
            phoneImage = `data:image/png;base64,${dataStr.replace(/\s+/g, "")}`;
          }
        }
      } catch (e: any) {}
    }

    // 2. Try to find internal ID and fetch via getphone as a fallback
    if (!phone && !phoneImage) {
      const urlId = extractAdId(url);
      const internalId = urlId || 
                         $(".call-btn, .suna-btn, [data-id], .btn-show-phone").attr("data-id") || 
                         response.data.match(/data-id=["']?([a-zA-Z0-9]+)["']?/)?.[1] ||
                         response.data.match(/adId:\s?['"]?([a-zA-Z0-9]+)['"]?/)?.[1];

      if (internalId) {
        try {
          const phoneUrls = [
            `https://www.publi24.ro/getphone?id=${internalId}`,
            `https://www.publi24.ro/getphone?id=${internalId}&is_mobile=1`,
            `https://www.publi24.ro/anunturi/getphone?id=${internalId}`
          ];

          for (const pUrl of phoneUrls) {
            try {
              const phoneRes = await fetchWithRetry(pUrl, {
                timeout: 6000,
                headers: {
                  ...getHeaders(url, true),
                  "Accept": "*/*",
                  "X-Requested-With": "XMLHttpRequest"
                }
              }, 1, true);
              
              if (phoneRes.data) {
                const data = typeof phoneRes.data === 'string' ? phoneRes.data.trim() : JSON.stringify(phoneRes.data);
                
                if (data.length > 5 && !data.includes("<") && !data.includes("{")) {
                  phone = data;
                  break;
                }
                
                if (data.includes("<")) {
                  const $phone = cheerio.load(data);
                  const telSpanAJAX = $phone(".telnumber, .phone-image, .phone-img, [style*='data:image']");
                  const style = telSpanAJAX.attr("style") || data;
                  const bgMatch = style.match(/data:image\/([^;]+);base64,([^"&')\s]+)/);
                  if (bgMatch) {
                    phoneImage = `data:image/${bgMatch[1]};base64,${bgMatch[2].replace(/\s+/g, "")}`;
                    break;
                  }

                  const text = $phone("span, a, p, b").text().trim();
                  if (text && text.length > 5 && /\d/.test(text)) {
                    phone = text;
                    break;
                  }
                }

                if (typeof phoneRes.data === 'object' && phoneRes.data.phone) {
                  phone = phoneRes.data.phone;
                  break;
                }
              }
            } catch (e) {}
            if (phone || phoneImage) break;
          }
        } catch (e) {}
      }
    }

    if (phone) {
      if (phone.includes(",")) phone = phone.split(",")[0].trim();
      if (phone.includes("/")) phone = phone.split("/")[0].trim();
      if (phone.includes(";")) phone = phone.split(";")[0].trim();
      
      phone = phone.replace(/[^\d]/g, "");
      if (phone.length >= 10) {
        if (phone.length > 10) {
          const firstMatch = phone.match(/07\d{8}/);
          if (firstMatch) {
            phone = firstMatch[0];
          } else {
            phone = phone.slice(0, 10);
          }
        }
        if (isBrandOrFakePhone(phone)) {
          phone = null;
        } else {
          phone = phone.replace(/\s+/g, "");
        }
      } else {
        if (isBrandOrFakePhone(phone)) {
          phone = null;
        }
      }
    }

    // Extract raw text for AI extraction
    $("script, style, head, footer, nav, iframe, .ads, .related").remove();
    const pageText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 15000);

    const responseData = { 
      title, 
      price, 
      location, 
      date, 
      image: bestImage, 
      images: uniqueImages, 
      description, 
      pageText, 
      phone, 
      phoneImage, 
      isExpired 
    };

    if (!bypassCache) {
      detailCache.set(url, { timestamp: Date.now(), data: responseData });
    }

    console.log(`[SCRAPE DETAIL] SUCCESS for ${url} in ${Date.now() - start}ms (images: ${uniqueImages.length}, phone: ${phone ? 'yes' : 'no'}, isExpired: ${isExpired})`);
    return responseData;
  }

  // API Route for fetching listing details (including full image)
  app.get("/api/listing-detail", async (req, res) => {
    const { url } = req.query;
    const start = Date.now();
    if (!url || typeof url !== "string") return res.status(400).json({ error: "URL required" });

    try {
      const responseData = await scrapeListingFullDetails(url, false);
      res.json(responseData);
    } catch (err: any) {
      let status = err.response?.status || 500;
      if (typeof status !== "number" || status < 100 || status > 599) {
        status = 500;
      }
      const errorMsg = err.response?.data?.error || err.message || String(err);
      console.error(`[ROUTE] /api/listing-detail ERROR (${status}) after ${Date.now() - start}ms:`, errorMsg);
      
      if (status === 403) {
        return res.status(403).json({ error: `Access blocked by provider: ${errorMsg}` });
      }
      
      res.status(status).json({ error: `Failed to fetch details: ${errorMsg}` });
    }
  });

  // Proxy for images to bypass hotlinking protection
  app.get("/api/proxy-image", async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== "string") return res.status(400).send("URL required");
    
    console.log(`[PROXY] Fetching image: ${url}`);
    try {
      const response = await baseClient.get(url, {
        responseType: "arraybuffer",
        timeout: 30000,
        headers: {
          ...getHeaders(url.includes("inspector-escorte.ro") ? "https://inspector-escorte.ro/" : (url.includes("bursaplacerilor.com") ? "https://bursaplacerilor.com/" : "https://www.publi24.ro/")),
          "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Sec-Fetch-Dest": "image",
          "Sec-Fetch-Mode": "no-cors",
          "Sec-Fetch-Site": "same-site"
        }
      });
      console.log(`[PROXY] Success: ${url} (${response.headers["content-type"]})`);
      res.set("Content-Type", response.headers["content-type"] || "image/jpeg");
      res.set("Cache-Control", "public, max-age=86400");
      res.send(response.data);
    } catch (err: any) {
      console.error(`[PROXY] Failed: ${url} - ${err.message}`);
      res.status(500).send("Failed to proxy image");
    }
  });

  // API Route for scraping bursaplacerilor.com (supports up to 100 results per page)
  app.get("/api/scrape-bursaplacerilor", async (req, res) => {
    const { query = "", county = "", city = "", page = 1, limit = 100 } = req.query;
    const start = Date.now();
    const pageNum = parseInt(page as string) || 1;
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string) || 100));
    console.log(`[ROUTE] /api/scrape-bursaplacerilor START - query: "${query}", county: ${county}, city: ${city}, page: ${pageNum}, limit: ${limitNum}`);

    try {
      const result = await bursaplacerilor.search(query as string, pageNum, county as string, city as string, limitNum);
      console.log(`[ROUTE] /api/scrape-bursaplacerilor SUCCESS - returned ${result.listings.length} listings in ${Date.now() - start}ms`);
      res.json({ listings: result.listings, totalResults: result.totalResults });
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      console.error(`[ROUTE] /api/scrape-bursaplacerilor ERROR after ${Date.now() - start}ms:`, errorMsg);
      res.status(500).json({ error: errorMsg });
    }
  });

  // Batch enrichment for Bursa Plăcerilor listings in background
  app.post("/api/enrich-bursa-descriptions", async (req, res) => {
    const { urls } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.json({ enriched: {} });
    }

    const uniqueUrls = Array.from(new Set(urls.filter((u: any) => typeof u === "string" && u.includes("bursaplacerilor")))).slice(0, 50);
    const enriched: Record<string, { desc?: string; images?: string[]; date?: string; phone?: string }> = {};

    // Process in parallel batches of 10
    const BATCH_SIZE = 10;
    for (let i = 0; i < uniqueUrls.length; i += BATCH_SIZE) {
      const batch = uniqueUrls.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (url) => {
          try {
            const detail = await bursaplacerilor.fetchListingDetailDirect(url);
            if (detail) {
              enriched[url] = detail;
            }
          } catch {}
        })
      );
    }

    res.json({ enriched });
  });

  // API Route for scraping nimfomane
  app.get("/api/scrape-nimfomane", async (req, res) => {
    const { query, county, city, page = 1 } = req.query;
    if (!query || (query as string).trim() === "") {
      return res.status(400).json({ error: "A search keyword is required for Nimfomane.com searches." });
    }

    try {
      const result = await nimfomane.search(query as string, parseInt(page as string), county as string, city as string);
      res.json({ listings: result.listings, totalResults: result.totalResults });
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      console.error("[NIMFOMANE] Route error:", errorMsg);
      res.status(500).json({ error: errorMsg });
    }
  });

  // API Route for scraping inspector
  app.get("/api/scrape-inspector", async (req, res) => {
    const { query, county, city, page = 1 } = req.query;
    const start = Date.now();
    console.log(`[ROUTE] /api/scrape-inspector START - query: "${query}", county: ${county}, city: ${city}, page: ${page}`);
    
    if (!query || (query as string).trim() === "") {
      return res.status(400).json({ error: "A search keyword is required for Inspector Escorte searches." });
    }

    try {
      const result = await inspector.search((query as string).trim(), parseInt(page as string), county as string, city as string);
      console.log(`[ROUTE] /api/scrape-inspector SUCCESS - found ${result.listings?.length || 0} listings in ${Date.now() - start}ms`);
      res.json({ listings: result.listings, totalResults: result.totalResults });
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      console.error(`[ROUTE] /api/scrape-inspector ERROR after ${Date.now() - start}ms:`, errorMsg);
      res.status(500).json({ error: errorMsg });
    }
  });

  app.post("/api/reset-scraper", (req, res) => {
    InspectorEscorteScraper.resetCache();
    res.json({ status: "ok" });
  });

  // ==========================================
  // SAVED PROFILES & PHONE ARCHIVE SYSTEM
  // ==========================================
  interface SavedProfile {
    id: string;
    adId?: string;
    title: string;
    link: string;
    image: string;
    images?: string[];
    location: string;
    date?: string;
    description?: string;
    price?: string;
    phoneNumber?: string;
    revealedPhone?: string;
    phoneImage?: string;
    author?: string;
    source?: 'publi24' | 'nimfomane' | 'inspector' | 'bursaplacerilor';
    savedAt: number;
    lastUpdatedAt: number;
    status: 'active' | 'expired';
    lastCheckedStatus?: string;
    notes?: string;
    changeHistory?: Array<{
      date: number;
      change: string;
    }>;
    locationHistory?: Array<{
      location: string;
      detectedAt: number;
      adId?: string;
      link?: string;
      title?: string;
      source?: string;
    }>;
  }

  const PROFILES_DIR = path.join(process.cwd(), "data");
  const PROFILES_FILE = path.join(PROFILES_DIR, "saved_profiles.json");

  // Ensure data directory exists
  if (!fs.existsSync(PROFILES_DIR)) {
    try {
      fs.mkdirSync(PROFILES_DIR, { recursive: true });
    } catch (e: any) {
      console.warn("[STORAGE] Could not create data directory:", e.message);
    }
  }

  const savedProfilesMap = new Map<string, SavedProfile>();

  function loadSavedProfiles() {
    try {
      if (fs.existsSync(PROFILES_FILE)) {
        const raw = fs.readFileSync(PROFILES_FILE, "utf-8");
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          savedProfilesMap.clear();
          for (const item of list) {
            if (item.revealedPhone) item.revealedPhone = item.revealedPhone.replace(/\s+/g, '');
            if (item.phoneNumber && /\d/.test(item.phoneNumber)) item.phoneNumber = item.phoneNumber.replace(/\s+/g, '');
            const key = normalizeLink(item.link) || String(item.id || item.adId);
            savedProfilesMap.set(key, item);
          }
          console.log(`[STORAGE] Loaded ${savedProfilesMap.size} saved profiles from disk.`);
          persistSavedProfiles();
        }
      }
    } catch (err: any) {
      console.warn("[STORAGE] Error loading saved profiles:", err.message);
    }
  }

  function persistSavedProfiles() {
    try {
      const list = Array.from(savedProfilesMap.values());
      const tempPath = `${PROFILES_FILE}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(list, null, 2), "utf-8");
      fs.renameSync(tempPath, PROFILES_FILE);
    } catch (err: any) {
      console.warn("[STORAGE] Error saving profiles to disk:", err.message);
    }
  }

  // Initial load
  loadSavedProfiles();

  // GET /api/saved-profiles - Search by phone number, text search, filter by status or source
  app.get("/api/saved-profiles", (req, res) => {
    try {
      const { phone, q, source, status } = req.query;
      let results = Array.from(savedProfilesMap.values());

      // Search by phone number (digits normalization)
      if (phone && typeof phone === "string" && phone.trim()) {
        const queryDigits = cleanPhoneDigits(phone);
        if (queryDigits.length >= 2) {
          results = results.filter(p => {
            const p1 = cleanPhoneDigits(p.revealedPhone);
            const p2 = cleanPhoneDigits(p.phoneNumber);
            return (p1 && (p1.includes(queryDigits) || queryDigits.includes(p1))) ||
                   (p2 && (p2.includes(queryDigits) || queryDigits.includes(p2)));
          });
        }
      }

      // Keyword / text search in title, location, description, notes
      if (q && typeof q === "string" && q.trim()) {
        const qLower = q.toLowerCase().trim();
        results = results.filter(p => 
          (p.title && p.title.toLowerCase().includes(qLower)) ||
          (p.location && p.location.toLowerCase().includes(qLower)) ||
          (p.description && p.description.toLowerCase().includes(qLower)) ||
          (p.notes && p.notes.toLowerCase().includes(qLower)) ||
          (p.author && p.author.toLowerCase().includes(qLower)) ||
          (p.revealedPhone && p.revealedPhone.includes(q)) ||
          (p.phoneNumber && p.phoneNumber.includes(q))
        );
      }

      // Filter by source
      if (source && typeof source === "string" && source !== "all") {
        results = results.filter(p => p.source === source);
      }

      // Filter by status (active vs expired)
      if (status && typeof status === "string" && status !== "all") {
        results = results.filter(p => p.status === status);
      }

      // Sort by lastUpdatedAt (descending)
      results.sort((a, b) => (b.lastUpdatedAt || b.savedAt || 0) - (a.lastUpdatedAt || a.savedAt || 0));

      res.json({
        profiles: results,
        total: results.length,
        totalArchived: savedProfilesMap.size
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/save-profiles - Save one or multiple profiles to persistent storage
  app.post("/api/save-profiles", (req, res) => {
    try {
      const { profiles, profile } = req.body;
      const itemsToSave: any[] = Array.isArray(profiles) ? profiles : (profile ? [profile] : []);

      if (itemsToSave.length === 0) {
        return res.status(400).json({ error: "No profile data provided to save." });
      }

      let savedCount = 0;
      const now = Date.now();

      for (const item of itemsToSave) {
        if (!item.link && !item.id) continue;
        const key = normalizeLink(item.link) || String(item.id || item.adId);
        const existing = savedProfilesMap.get(key);

        const images = (item.images && item.images.length > 0)
          ? item.images
          : (existing?.images && existing.images.length > 0)
            ? existing.images
            : (item.image ? [item.image] : (existing?.image ? [existing.image] : []));

        // Detect phone number if valid 07...
        let initialPhone = item.revealedPhone || existing?.revealedPhone;
        if (!initialPhone && item.phoneNumber && item.phoneNumber.startsWith("07")) {
          initialPhone = item.phoneNumber;
        }
        if (initialPhone) {
          initialPhone = initialPhone.replace(/\s+/g, '');
        }

        const cleanedPhoneNumber = (item.phoneNumber || existing?.phoneNumber || "Click to reveal").replace(/\s+/g, '');

        const itemLocation = (item.location || existing?.location || "Locație nespecificată").trim();
        const existingLocation = existing?.location?.trim();
        const hasLocationChanged = Boolean(
          existingLocation && 
          itemLocation && 
          existingLocation !== "Locație nespecificată" && 
          itemLocation !== "Locație nespecificată" && 
          existingLocation.toLowerCase() !== itemLocation.toLowerCase()
        );

        const locationHistory = existing?.locationHistory ? [...existing.locationHistory] : [];
        if (existingLocation && existingLocation !== "Locație nespecificată" && locationHistory.length === 0) {
          locationHistory.push({
            location: existingLocation,
            detectedAt: existing?.savedAt || now,
            link: existing?.link,
            title: existing?.title
          });
        }
        if (hasLocationChanged && (!locationHistory.length || locationHistory[locationHistory.length - 1].location.toLowerCase() !== itemLocation.toLowerCase())) {
          locationHistory.push({
            location: itemLocation,
            detectedAt: now,
            link: item.link || existing?.link,
            title: item.title || existing?.title
          });
        }

        const changeHistory = existing?.changeHistory ? [...existing.changeHistory] : [{ date: now, change: 'Added to archive' }];
        if (hasLocationChanged) {
          changeHistory.unshift({
            date: now,
            change: `Location changed from "${existingLocation}" to "${itemLocation}"`
          });
        }

        let itemDescription = item.description || existing?.description || "";
        if (
          (!itemDescription || itemDescription.startsWith("Anunț publicat pe BursaPlacerilor.com")) &&
          (item.source === 'bursaplacerilor' || item.link?.includes("bursaplacerilor"))
        ) {
          const cachedBursa = bursaDetailCache.get(item.link);
          if (cachedBursa?.desc) {
            itemDescription = cachedBursa.desc;
          }
        }

        const savedItem: SavedProfile = {
          id: key,
          adId: item.adId || existing?.adId || extractAdId(item.link) || undefined,
          title: item.title || existing?.title || "Fără titlu",
          link: item.link || existing?.link || "",
          image: item.image || existing?.image || (images[0] || ""),
          images,
          location: itemLocation,
          date: item.date || existing?.date || "",
          description: itemDescription,
          price: item.price || existing?.price || "N/A",
          phoneNumber: cleanedPhoneNumber,
          revealedPhone: initialPhone,
          phoneImage: item.phoneImage || existing?.phoneImage,
          author: item.author || existing?.author,
          source: item.source || existing?.source || (item.link?.includes("bursaplacerilor") ? 'bursaplacerilor' : (item.link?.includes("inspector") ? 'inspector' : (item.link?.includes("nimfomane") ? 'nimfomane' : 'publi24'))),
          savedAt: existing?.savedAt || now,
          lastUpdatedAt: now,
          status: existing?.status || 'active',
          lastCheckedStatus: existing?.lastCheckedStatus || 'Saved in archive',
          notes: item.notes !== undefined ? item.notes : existing?.notes,
          changeHistory,
          locationHistory: locationHistory.length > 0 ? locationHistory : undefined
        };

        savedProfilesMap.set(key, savedItem);
        savedCount++;
      }

      persistSavedProfiles();
      res.json({
        success: true,
        savedCount,
        totalArchived: savedProfilesMap.size
      });
    } catch (err: any) {
      console.error("[STORAGE] Save error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/update-profile - Live re-scrape & update profile with latest data
  app.post("/api/update-profile", async (req, res) => {
    try {
      const { url, id, notes, onlyNotes } = req.body;
      const targetUrl = url || (id ? savedProfilesMap.get(id)?.link : null);

      if (!targetUrl && !id) {
        return res.status(400).json({ error: "Profile URL or ID is required" });
      }

      const key = normalizeLink(targetUrl) || (id ? String(id) : "");
      let existing = savedProfilesMap.get(key) || (id ? savedProfilesMap.get(id) : undefined);

      // Fast path: User only wants to update custom notes
      if (onlyNotes && existing) {
        existing.notes = notes;
        existing.lastUpdatedAt = Date.now();
        persistSavedProfiles();
        return res.json({ success: true, profile: existing, message: "Notes updated" });
      }

      if (!targetUrl) {
        return res.status(400).json({ error: "Cannot refresh profile without URL" });
      }

      console.log(`[UPDATE PROFILE] Fetching latest live data for ${targetUrl}...`);

      // Clear any memory cache for fresh check
      detailCache.delete(targetUrl);
      for (const k of phoneCache.keys()) {
        if (k.includes(targetUrl)) phoneCache.delete(k);
      }

      let detailData: any = null;
      let is404 = false;

      try {
        detailData = await scrapeListingFullDetails(targetUrl, true);
      } catch (err: any) {
        if (err.response?.status === 404 || err.message?.includes("404") || err.message?.includes("not found")) {
          is404 = true;
        } else {
          throw err;
        }
      }

      const now = Date.now();
      const changes: string[] = [];

      // Check if ad expired or returned 404
      if (is404 || detailData?.isExpired) {
        const expiredProfile: SavedProfile = existing ? {
          ...existing,
          status: 'expired',
          lastCheckedStatus: 'Ad expired / removed from website',
          lastUpdatedAt: now,
          changeHistory: [
            { date: now, change: 'Checked ad: Ad is no longer active (expired or removed).' },
            ...(existing.changeHistory || [])
          ].slice(0, 20)
        } : {
          id: key,
          title: "Anunț expirat",
          link: targetUrl,
          image: "",
          location: "",
          phoneNumber: "",
          savedAt: now,
          lastUpdatedAt: now,
          status: 'expired',
          lastCheckedStatus: 'Ad expired / removed (404)',
          changeHistory: [{ date: now, change: 'Checked: 404 / Expired' }]
        };

        savedProfilesMap.set(key, expiredProfile);
        persistSavedProfiles();

        return res.json({
          success: true,
          profile: expiredProfile,
          status: 'expired',
          changes: ['Ad is no longer active on website (expired or deleted)'],
          message: 'Ad has expired or was removed from website.'
        });
      }

      // Ad is active! Calculate differences
      const newImages = detailData.images || (detailData.image ? [detailData.image] : []);
      const oldImages = existing?.images || (existing?.image ? [existing.image] : []);

      if (newImages.length > oldImages.length) {
        changes.push(`Found ${newImages.length - oldImages.length} new photos (now ${newImages.length})`);
      }

      if (detailData.title && existing?.title && detailData.title !== existing.title) {
        changes.push(`Title updated`);
      }

      if (detailData.price && existing?.price && detailData.price !== existing.price) {
        changes.push(`Price updated: ${existing.price} -> ${detailData.price}`);
      }

      if (detailData.location && existing?.location && 
          detailData.location !== existing.location && 
          detailData.location !== "Locație nespecificată" && 
          existing.location !== "Locație nespecificată") {
        changes.push(`Location changed from "${existing.location}" to "${detailData.location}"`);
      }

      if (detailData.phone && detailData.phone !== existing?.revealedPhone) {
        changes.push(`Phone verified: ${detailData.phone}`);
      }

      if (changes.length === 0) {
        changes.push("Checked active ad: All photos and details are up to date");
      }

      const finalLocation = detailData.location || existing?.location || "Locație nespecificată";
      const locationHistory = existing?.locationHistory ? [...existing.locationHistory] : [];
      if (existing?.location && existing.location !== "Locație nespecificată" && locationHistory.length === 0) {
        locationHistory.push({
          location: existing.location,
          detectedAt: existing.savedAt || now,
          link: targetUrl,
          title: existing.title
        });
      }
      if (detailData.location && 
          detailData.location !== "Locație nespecificată" && 
          (!locationHistory.length || locationHistory[locationHistory.length - 1].location.toLowerCase() !== detailData.location.toLowerCase())) {
        locationHistory.push({
          location: detailData.location,
          detectedAt: now,
          link: targetUrl,
          title: detailData.title || existing?.title
        });
      }

      const updatedProfile: SavedProfile = {
        id: key,
        adId: existing?.adId || extractAdId(targetUrl) || undefined,
        title: detailData.title || existing?.title || "Anunț",
        link: targetUrl,
        image: detailData.image || (newImages[0] || existing?.image || ""),
        images: newImages.length > 0 ? newImages : (existing?.images || []),
        location: finalLocation,
        date: detailData.date || existing?.date || "",
        description: detailData.description || existing?.description || "",
        phoneNumber: (detailData.phone || existing?.phoneNumber || "Click to reveal").replace(/\s+/g, ''),
        revealedPhone: (detailData.phone || existing?.revealedPhone || "").replace(/\s+/g, '') || undefined,
        phoneImage: detailData.phoneImage || existing?.phoneImage,
        author: existing?.author,
        source: existing?.source || (targetUrl.includes("bursaplacerilor") ? 'bursaplacerilor' : (targetUrl.includes("inspector") ? 'inspector' : (targetUrl.includes("nimfomane") ? 'nimfomane' : 'publi24'))),
        savedAt: existing?.savedAt || now,
        lastUpdatedAt: now,
        status: 'active',
        lastCheckedStatus: `Active - verified at ${new Date(now).toLocaleTimeString()}`,
        notes: notes !== undefined ? notes : existing?.notes,
        changeHistory: [
          { date: now, change: changes.join(" | ") },
          ...(existing?.changeHistory || [])
        ].slice(0, 20),
        locationHistory: locationHistory.length > 0 ? locationHistory : undefined
      };

      savedProfilesMap.set(key, updatedProfile);
      persistSavedProfiles();

      res.json({
        success: true,
        profile: updatedProfile,
        status: 'active',
        changes,
        message: 'Profile successfully updated with latest data from website!'
      });
    } catch (err: any) {
      console.error("[UPDATE PROFILE] Error:", err.message);
      res.status(500).json({ error: `Failed to update profile: ${err.message}` });
    }
  });

  // DELETE /api/saved-profiles - Remove profile or clear all
  app.delete("/api/saved-profiles/:id?", (req, res) => {
    try {
      const id = req.params.id || req.query.id || req.query.url;
      const { clearAll } = req.body || {};

      if (clearAll) {
        savedProfilesMap.clear();
        persistSavedProfiles();
        return res.json({ success: true, message: "Archive cleared", totalArchived: 0 });
      }

      if (!id || typeof id !== "string") {
        return res.status(400).json({ error: "Profile ID or URL is required" });
      }

      const key = normalizeLink(id) || id;
      let deleted = savedProfilesMap.delete(key);
      if (!deleted) {
        for (const [k, v] of savedProfilesMap.entries()) {
          if (v.id === id || v.link === id || normalizeLink(v.link) === normalizeLink(id)) {
            savedProfilesMap.delete(k);
            deleted = true;
            break;
          }
        }
      }

      persistSavedProfiles();
      res.json({ success: true, deleted, totalArchived: savedProfilesMap.size });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================
  // LOCATION CHANGE DETECTION ENGINE & API
  // ==========================================

  function normalizeLocationString(loc: string | null | undefined): string {
    if (!loc) return "";
    let clean = loc.toLowerCase().trim();
    // Remove punctuation
    clean = clean.replace(/[,|\/\-–—.]+/g, " ");
    // Deduplicate repetitive words e.g. "bucuresti bucuresti" -> "bucuresti"
    const words = clean.split(/\s+/).filter(w => w.length > 1);
    const unique = Array.from(new Set(words));
    return unique.join(" ");
  }

  function isDifferentLocation(locA: string, locB: string): boolean {
    const a = normalizeLocationString(locA);
    const b = normalizeLocationString(locB);
    if (!a || !b) return false;
    if (a === b) return false;
    // Check if one is just a substring of another (e.g. "cluj napoca" vs "cluj")
    if (a.includes(b) || b.includes(a)) {
      const wordsA = new Set(a.split(" "));
      const wordsB = new Set(b.split(" "));
      const overlap = [...wordsA].filter(x => wordsB.has(x));
      if (overlap.length >= 1 && (wordsA.size <= 2 || wordsB.size <= 2)) {
        return false;
      }
    }
    return true;
  }

  // ------------------------------------------
  // API Authentication Middleware (Bearer API_KEY)
  // ------------------------------------------
  function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
    const authHeader = req.headers.authorization || (req.headers as any)["Authorization"];
    let token = "";
    if (typeof authHeader === "string") {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match) {
        token = match[1].trim();
      }
    }

    const expectedKey = (process.env.API_KEY || "").trim();

    if (!expectedKey || !token || token !== expectedKey) {
      return res.status(401).json({ error: "unauthorized" });
    }

    next();
  }

  // ------------------------------------------
  // Phone Normalization & Privacy Helpers
  // ------------------------------------------
  // Normalization rule: keep only digits, map prefix 40/+40/0040 to 0, compare last 9 digits
  function normalizePhoneForComparison(phone: string | null | undefined): string {
    if (!phone) return "";
    let digits = String(phone).replace(/\D/g, "");
    if (digits.startsWith("0040")) {
      digits = "0" + digits.slice(4);
    } else if (digits.startsWith("40") && digits.length >= 11) {
      digits = "0" + digits.slice(2);
    }
    if (digits.length >= 9) {
      return digits.slice(-9);
    }
    return digits;
  }

  // Privacy helper: mask phone numbers in logs to prevent cleartext leakage
  function maskPhone(phone: string | null | undefined): string {
    if (!phone) return "[none]";
    const digits = String(phone).replace(/\D/g, "");
    if (digits.length <= 4) return "***";
    return `${digits.slice(0, 3)}***${digits.slice(-2)}`;
  }

  // ------------------------------------------
  // City & Zone Extractor
  // ------------------------------------------
  // Extracts city and zone according to profile export format (city, location.zone)
  function parseCityAndZone(rawLocation: string | null | undefined): { city: string | null; zone: string | null } {
    if (!rawLocation) return { city: null, zone: null };
    const loc = rawLocation.trim();
    if (!loc || loc.toLowerCase().includes("nespecificat") || loc.toLowerCase() === "romania") {
      return { city: null, zone: null };
    }

    // Check for Sector: e.g. "Sector 1", "Sector 2", "Sectorul 1", etc.
    const sectorMatch = loc.match(/sector(?:ul)?\s*([1-6])/i);
    if (sectorMatch) {
      return { city: "Bucuresti", zone: `Sector ${sectorMatch[1]}` };
    }

    const parts = loc.split(/[,|/]+/).map(p => p.trim()).filter(Boolean);

    if (parts.length === 0) {
      return { city: loc, zone: null };
    }

    if (parts.length === 1) {
      return { city: parts[0], zone: null };
    }

    // Romanian counties list (lowercase) to differentiate county from zone/subdivision
    const romanianCounties = new Set([
      "alba", "arad", "arges", "argeș", "bacau", "bacău", "bihor", "bistrita-nasaud", "bistrița-năsăud",
      "botosani", "botoșani", "braila", "brăila", "brasov", "brașov", "buzau", "buzău", "calarasi", "călărași",
      "caras-severin", "caraș-severin", "cluj", "constanta", "constanța", "covasna", "dambovita", "dâmbovița",
      "dolj", "galati", "galați", "giurgiu", "gorj", "harghita", "hunedoara", "ialomita", "ialomița",
      "iasi", "iași", "ilfov", "maramures", "maramureș", "mehedinti", "mehedinți", "mures", "mureș",
      "neamt", "neamț", "olt", "prahova", "salaj", "sălaj", "satu mare", "sibiu", "suceava",
      "teleorman", "timis", "timiș", "tulcea", "valcea", "vâlcea", "vaslui", "vrancea"
    ]);

    const p0 = parts[0];
    const p1 = parts[1];
    const p0Lower = p0.toLowerCase();
    const p1Lower = p1.toLowerCase();

    if (romanianCounties.has(p1Lower)) {
      return { city: p0, zone: null };
    }
    if (romanianCounties.has(p0Lower)) {
      return { city: p1, zone: null };
    }
    if (p0Lower === "bucuresti" || p0Lower === "bucurești") {
      return { city: "Bucuresti", zone: p1 };
    }
    if (p1Lower === "bucuresti" || p1Lower === "bucurești") {
      return { city: "Bucuresti", zone: p0 };
    }

    return { city: p0, zone: p1 };
  }

  // ------------------------------------------
  // Archive Lookup Helper
  // ------------------------------------------
  function findProfilesByPhone(targetPhone: string): SavedProfile[] {
    const targetKey = normalizePhoneForComparison(targetPhone);
    if (!targetKey || targetKey.length < 5) return [];

    const matches: SavedProfile[] = [];
    for (const p of savedProfilesMap.values()) {
      const k1 = normalizePhoneForComparison(p.revealedPhone);
      const k2 = normalizePhoneForComparison(p.phoneNumber);
      if ((k1 && k1 === targetKey) || (k2 && k2 === targetKey)) {
        matches.push(p);
      }
    }

    // Sort descending by lastUpdatedAt or savedAt (most recent first)
    matches.sort((a, b) => (b.lastUpdatedAt || b.savedAt || 0) - (a.lastUpdatedAt || a.savedAt || 0));
    return matches;
  }

  // ==========================================
  // ENDPOINT: POST /api/locations
  // ==========================================
  // Receives a list of phone numbers (max 100), normalizes them, and returns:
  // { results: [ { phone, found: true, city, zone, sourceUrl, seenAt }, { phone, found: false } ] }
  app.post("/api/locations", requireApiKey, (req, res) => {
    try {
      const { phones } = req.body || {};

      if (!Array.isArray(phones)) {
        return res.status(400).json({ error: "Invalid body. 'phones' must be an array of strings." });
      }

      if (phones.length > 100) {
        return res.status(400).json({ error: "Maximum 100 phone numbers allowed per request." });
      }

      const results = [];

      for (const item of phones) {
        const rawPhone = typeof item === "string" ? item : String(item ?? "");
        const matches = findProfilesByPhone(rawPhone);

        if (matches.length > 0) {
          const latest = matches[0];
          const { city, zone } = parseCityAndZone(latest.location);
          const seenAtMs = latest.lastUpdatedAt || latest.savedAt || Date.now();

          results.push({
            phone: rawPhone,
            found: true,
            city: city || "Locație nespecificată",
            zone: zone || null,
            sourceUrl: latest.link || latest.id || "",
            seenAt: new Date(seenAtMs).toISOString()
          });
        } else {
          results.push({
            phone: rawPhone,
            found: false
          });
        }
      }

      console.log(`[API /api/locations] Processed batch of ${phones.length} phones (${results.filter(r => r.found).length} found)`);
      return res.json({ results });
    } catch (err: any) {
      console.error("[API /api/locations] Error:", err.message);
      return res.status(500).json({ error: err.message || "Internal server error" });
    }
  });

  // ==========================================
  // ENDPOINT: GET /api/check-location-change
  // ==========================================
  // Checks location movements for a single phone number with Bearer API_KEY authentication
  // Returns: { hasChangedLocation, currentLocation, previousLocations }
  app.get(["/api/check-location-change", "/api/profile/check-location"], requireApiKey, async (req, res) => {
    try {
      const phone = (req.query.phone || req.query.phoneNumber || req.query.q) as string;
      const expectedLocation = (req.query.current_location || req.query.location || req.query.expected_location || req.query.city) as string;

      if (!phone || typeof phone !== "string" || !phone.trim()) {
        return res.status(400).json({
          error: "Phone parameter is required. Usage: GET /api/check-location-change?phone=07XXXXXXXX[&location=City]"
        });
      }

      const matches = findProfilesByPhone(phone);
      console.log(`[API /api/check-location-change] Checked masked phone: ${maskPhone(phone)} (found ${matches.length} ad(s))`);

      if (matches.length === 0) {
        return res.json({
          hasChangedLocation: false,
          currentLocation: null,
          previousLocations: []
        });
      }

      // Collect distinct locations chronologically (oldest to newest)
      const chronological = [...matches].reverse();
      const uniqueLocations: string[] = [];

      for (const p of chronological) {
        const { city } = parseCityAndZone(p.location);
        const locName = city || p.location?.trim() || "";
        if (locName && !locName.toLowerCase().includes("nespecificat") && locName.toLowerCase() !== "romania") {
          if (uniqueLocations.length === 0) {
            uniqueLocations.push(locName);
          } else {
            const lastLoc = uniqueLocations[uniqueLocations.length - 1];
            if (isDifferentLocation(lastLoc, locName)) {
              uniqueLocations.push(locName);
            }
          }
        }
      }

      const currentLocation = uniqueLocations.length > 0 ? uniqueLocations[uniqueLocations.length - 1] : null;
      const previousLocations = uniqueLocations.length > 1 ? uniqueLocations.slice(0, -1) : [];

      let hasChangedLocation = previousLocations.length > 0;
      if (expectedLocation && currentLocation) {
        if (isDifferentLocation(expectedLocation, currentLocation)) {
          hasChangedLocation = true;
        }
      }

      return res.json({
        hasChangedLocation,
        currentLocation,
        previousLocations
      });
    } catch (err: any) {
      console.error("[API /api/check-location-change] Error:", err.message);
      return res.status(500).json({ error: err.message || "Internal server error" });
    }
  });

  // POST /api/check-location-change - Batch or single phone location change check (protected)
  app.post(["/api/check-location-change", "/api/profile/check-location"], requireApiKey, async (req, res) => {
    try {
      const { phone, phoneNumber, location, currentLocation, expectedLocation, phones } = req.body || {};

      if (Array.isArray(phones) && phones.length > 0) {
        const results = [];
        for (const p of phones.slice(0, 100)) {
          const rawPhone = typeof p === "string" ? p : String(p ?? "");
          const matches = findProfilesByPhone(rawPhone);
          const chronological = [...matches].reverse();
          const uniqueLocations: string[] = [];

          for (const item of chronological) {
            const { city } = parseCityAndZone(item.location);
            const locName = city || item.location?.trim() || "";
            if (locName && !locName.toLowerCase().includes("nespecificat") && locName.toLowerCase() !== "romania") {
              if (uniqueLocations.length === 0) {
                uniqueLocations.push(locName);
              } else {
                const lastLoc = uniqueLocations[uniqueLocations.length - 1];
                if (isDifferentLocation(lastLoc, locName)) {
                  uniqueLocations.push(locName);
                }
              }
            }
          }

          const curLoc = uniqueLocations.length > 0 ? uniqueLocations[uniqueLocations.length - 1] : null;
          const prevLocs = uniqueLocations.length > 1 ? uniqueLocations.slice(0, -1) : [];
          let changed = prevLocs.length > 0;
          const targetLoc = location || currentLocation || expectedLocation;
          if (targetLoc && curLoc && isDifferentLocation(targetLoc, curLoc)) {
            changed = true;
          }

          results.push({
            phone: rawPhone,
            hasChangedLocation: changed,
            currentLocation: curLoc,
            previousLocations: prevLocs
          });
        }
        return res.json({ results });
      }

      const targetPhone = phone || phoneNumber;
      if (!targetPhone || typeof targetPhone !== "string") {
        return res.status(400).json({
          error: "Phone number is required. Provide { phone: '07XXXXXXXX' } or { phones: [...] } in request body."
        });
      }

      const matches = findProfilesByPhone(targetPhone);
      const chronological = [...matches].reverse();
      const uniqueLocations: string[] = [];

      for (const item of chronological) {
        const { city } = parseCityAndZone(item.location);
        const locName = city || item.location?.trim() || "";
        if (locName && !locName.toLowerCase().includes("nespecificat") && locName.toLowerCase() !== "romania") {
          if (uniqueLocations.length === 0) {
            uniqueLocations.push(locName);
          } else {
            const lastLoc = uniqueLocations[uniqueLocations.length - 1];
            if (isDifferentLocation(lastLoc, locName)) {
              uniqueLocations.push(locName);
            }
          }
        }
      }

      const curLoc = uniqueLocations.length > 0 ? uniqueLocations[uniqueLocations.length - 1] : null;
      const prevLocs = uniqueLocations.length > 1 ? uniqueLocations.slice(0, -1) : [];
      let changed = prevLocs.length > 0;
      const targetLoc = location || currentLocation || expectedLocation;
      if (targetLoc && curLoc && isDifferentLocation(targetLoc, curLoc)) {
        changed = true;
      }

      return res.json({
        hasChangedLocation: changed,
        currentLocation: curLoc,
        previousLocations: prevLocs
      });
    } catch (err: any) {
      console.error("[API /api/check-location-change POST] Error:", err.message);
      return res.status(500).json({ error: err.message || "Internal server error" });
    }
  });

  // GET /api/location-changes - Overview of all archived profiles with location movements
  app.get("/api/location-changes", (req, res) => {
    try {
      const phoneMap = new Map<string, SavedProfile[]>();
      for (const p of savedProfilesMap.values()) {
        const ph = cleanPhoneDigits(p.revealedPhone) || cleanPhoneDigits(p.phoneNumber);
        if (ph && ph.length >= 5) {
          const list = phoneMap.get(ph) || [];
          list.push(p);
          phoneMap.set(ph, list);
        }
      }

      const movedProfiles: any[] = [];
      for (const [phone, list] of phoneMap.entries()) {
        const locs = new Set<string>();
        for (const p of list) {
          if (p.location && p.location !== "Locație nespecificată" && p.location !== "Romania") {
            locs.add(p.location.trim());
          }
          if (p.locationHistory) {
            for (const h of p.locationHistory) {
              if (h.location) locs.add(h.location.trim());
            }
          }
        }

        if (locs.size >= 2) {
          movedProfiles.push({
            phone,
            locations: Array.from(locs),
            adsCount: list.length,
            profiles: list.map(p => ({
              id: p.id,
              title: p.title,
              location: p.location,
              link: p.link,
              date: p.date,
              savedAt: p.savedAt
            }))
          });
        }
      }

      res.json({
        success: true,
        totalWithLocationChanges: movedProfiles.length,
        items: movedProfiles
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // API Route for Content Analysis and OCR Scanner Proxy
  app.post("/api/content-analysis", async (req, res) => {
    try {
      const { prompt, base64Data, mimeType, isMultimodal } = req.body;
      if (!prompt) {
        return res.status(400).json({ error: "Prompt is required" });
      }

      console.log(`[ROUTE] /api/content-analysis - isMultimodal: ${!!isMultimodal}`);
      const ai = getGeminiClient();

      let contents: any;
      if (isMultimodal && base64Data) {
        const payloadMimeType = mimeType || "image/png";
        // Clean base64 data to remove target URL schemas in case they were passed as schemas
        let cleanedData = base64Data;
        if (cleanedData.includes(",")) {
          cleanedData = cleanedData.split(",")[1];
        }
        contents = {
          parts: [
            { text: prompt },
            { inlineData: { mimeType: payloadMimeType, data: cleanedData } }
          ]
        };
      } else {
        contents = prompt;
      }

      const generateWithRetry = async (modelName: string, maxAttempts = 4) => {
        let currentDelay = 1500;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            console.log(`[GEMINI] Generating with model ${modelName} (Attempt ${attempt}/${maxAttempts})...`);
            const response = await ai.models.generateContent({
              model: modelName,
              contents,
            });
            return response;
          } catch (error: any) {
            const errorStr = (error.message || String(error)).toLowerCase();
            const is503Or429 = error.status === 503 || error.status === 429 || 
                               errorStr.includes("503") || errorStr.includes("429") ||
                               errorStr.includes("demand") || errorStr.includes("unavailable") || 
                               errorStr.includes("quota") || errorStr.includes("rate limit");
            
            if (is503Or429 && attempt < maxAttempts) {
              // Avoid trigger-words like "warning", "error", "fail" to keep the telemetry metrics clean during normal retrying
              console.log(`[GEMINI STATUS] Model ${modelName} heavily loaded (attempt ${attempt}/${maxAttempts}). Retrying in ${currentDelay}ms. Status: ${error.status || 503}`);
              await new Promise((resolve) => setTimeout(resolve, currentDelay));
              currentDelay *= 1.5; // Exponential backoff
            } else {
              throw error;
            }
          }
        }
      };

      let response: any;
      try {
        response = await generateWithRetry("gemini-3.5-flash");
      } catch (primaryErr: any) {
        const errorStr = (primaryErr.message || String(primaryErr)).toLowerCase();
        const isDemandLimit = errorStr.includes("503") || errorStr.includes("429") || 
                              errorStr.includes("demand") || errorStr.includes("unavailable") || 
                              errorStr.includes("quota") || errorStr.includes("rate limit");
        
        if (isDemandLimit) {
          console.log("[GEMINI] Switching to secondary model 'gemini-3.1-flash-lite'...");
          response = await generateWithRetry("gemini-3.1-flash-lite", 3);
        } else {
          throw primaryErr;
        }
      }

      res.json({ text: response.text });
    } catch (err: any) {
      const errMsg = err.message || String(err);
      console.log(`[GEMINI] Generation issue details: ${errMsg.slice(0, 150)}`);
      // Propagate 500 or appropriate status
      res.status(500).json({ error: errMsg });
    }
  });

  // Global error handler guaranteeing that all API errors return JSON, never HTML
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path === "/api" || req.path.startsWith("/api/")) {
      const status = typeof err.status === "number" ? err.status : (typeof err.statusCode === "number" ? err.statusCode : 500);
      return res.status(status).json({ error: err.message || "Internal server error" });
    }
    next(err);
  });

  // Catch-all for API routes to prevent falling through to Vite SPA index.html
  app.all(["/api", "/api/*"], (req, res) => {
    console.warn(`[SERVER] 404 for API route: ${req.method} ${req.url}`);
    res.status(404).json({ error: `API route not found: ${req.url}` });
  });
  
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  console.log(`[SERVER] Starting listener on port ${PORT} at 0.0.0.0...`);
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] SUCCESS: Server running on http://localhost:${PORT}`);
  });

  server.on('error', (err) => {
    console.error("[SERVER] Listener error:", err);
  });
  } catch (err) {
    console.error("[SERVER] Error during startServer execution:", err);
    throw err;
  }
}

startServer().catch(err => {
  console.error("[SERVER] Fatal error during startup:", err);
  process.exit(1);
});

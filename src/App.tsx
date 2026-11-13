import React, { useState, useEffect } from 'react';
import { 
  Search, MapPin, Phone, ExternalLink, Loader2, ChevronRight, ChevronLeft, 
  Camera, Download, Copy, Check, RefreshCcw, Bookmark, BookmarkCheck, Database, 
  Trash2, ArrowUpRight, Sparkles, Filter, ShieldCheck, AlertCircle, Clock, 
  Calendar, Eye, FileText, ArrowLeft, PhoneCall, Activity, Play, Pause, 
  Terminal, CheckCircle2, Zap
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { SavedProfilesView } from './SavedProfilesView';
import { BursaCrawlerView } from './BursaCrawlerView';

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

/**
 * Gets the best available Gemini API key.
 * Prioritizes the user-selected key from the dialog.
 */
const getApiKey = () => {
  // Prioritize the platform-injected API_KEY which is set after user selection
  const key = (window as any).process?.env?.API_KEY || process.env.API_KEY || process.env.GEMINI_API_KEY || "";
  if (!key) {
    console.warn("[GEMINI] No API key found in environment.");
  }
  return key;
};

const GEMINI_MODEL = "gemini-3-flash-preview";

/**
 * Utility to draw a base64 image onto a canvas with a solid white background.
 * This resolves the issue where transparent PNG images render with black/no backgrounds,
 * making black text unreadable/invisible to the Gemini model.
 */
const ensureWhiteBackgroundForBase64 = (base64Url: string): Promise<string> => {
  return new Promise((resolve) => {
    if (!base64Url || !base64Url.startsWith("data:image/")) {
      resolve(base64Url);
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          // Fill solid white background
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          // Draw the image
          ctx.drawImage(img, 0, 0);
          // Export as high quality JPEG (JPEG has no transparency channel)
          resolve(canvas.toDataURL("image/jpeg", 0.95));
          return;
        }
      } catch (e) {
        console.warn("Canvas white background conversion failed:", e);
      }
      resolve(base64Url);
    };
    img.onerror = () => {
      resolve(base64Url);
    };
    img.src = base64Url;
  });
};

/**
 * Clean and validate phone numbers to ensure correctness and prevent watermark/brand elements (like '242424')
 * @param rawPhone raw extracted string/digits of the phone number.
 * @param rawText optional full raw source text to analyze for brands context.
 * @returns Clean formatted phone number or "Not found" if it represents a watermark/brand.
 */
const cleanAndValidatePhone = (rawPhone: string | null | undefined, rawText: string = ""): string => {
  if (!rawPhone) return "Not found";
  
  // Strip non-digits
  let digits = rawPhone.replace(/[^\d]/g, "");
  
  const textLower = (rawText || "").toLowerCase();
  
  // Check for common Publi24 brand name / watermark representations:
  // - 0724 242 424 is "0724242424"
  // - 24 24 24 is "242424"
  // - Or any number sequence containing '242424' or similar repeating "24"s
  const isFakeRepetitiveBrand = 
    digits === "0724242424" ||
    digits === "242424" ||
    digits === "2424" ||
    digits.includes("242424") ||
    (digits.match(/24/g) || []).length >= 3 ||
    textLower.includes("publi24") && digits.endsWith("242424");

  if (isFakeRepetitiveBrand) {
    console.warn("[Validation] Filtered out Publi24 brand/watermark phone number pattern:", digits);
    return "Not found";
  }

  // Mobile Romanian numbers should be 10 digits starting with 07, or landlines with 02 or 03.
  if (digits.length > 10) {
    const firstMatch = digits.match(/07\d{8}/);
    if (firstMatch) {
      digits = firstMatch[0];
    } else {
      digits = digits.slice(0, 10);
    }
  }

  // Re-verify after trimming down to 10 digits
  if (
    digits === "0724242424" ||
    digits.includes("242424") ||
    (digits.match(/24/g) || []).length >= 3
  ) {
    console.warn("[Validation] Filtered out Publi24 brand/watermark phone after extraction:", digits);
    return "Not found";
  }

  // Return the continuous digits without spaces if valid
  if (digits.length === 10 && (digits.startsWith("07") || digits.startsWith("02") || digits.startsWith("03"))) {
    return digits;
  }

  // If it's 9 digits starting with 7, prepend 0
  if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("2") || digits.startsWith("3"))) {
    const prefixed = "0" + digits;
    if (prefixed !== "0724242424") {
      return prefixed;
    }
  }

  if (digits.length < 9) {
    return "Not found";
  }

  return digits;
};

/**
 * Standalone utility to extract only digits from a base64 image using OCR.
 * @param base64Url The base64 data URL of the image.
 * @returns A string containing only the extracted digits.
 */
const extractDigitsFromBase64Image = async (base64Url: string): Promise<string> => {
  try {
    const cleanBase64 = await ensureWhiteBackgroundForBase64(base64Url);
    const mimeTypeMatch = cleanBase64.match(/^data:([^;]+);base64,/);
    const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : 'image/jpeg';
    const rawBase64Data = cleanBase64.includes(',') ? cleanBase64.split(',')[1] : cleanBase64;
    
    // Pass raw base64 data directly to bypass slow image enhancement as per user request
    const base64Data = rawBase64Data;
    
    const prompt = "Extract the phone number from this image. Return ONLY the 10 digits. No spaces, no letters, no other characters. CRITICAL: Ignore watermarks like 'Publi24' and do not return website brand name components like '242424' or '0724 242 424' as the phone number.";
    
    const response = await fetchWithTimeout("/api/content-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        base64Data,
        mimeType,
        isMultimodal: true
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Failed to perform OCR (Status: ${response.status})`);
    }

    const data = await response.json();
    const text = data.text?.trim() || "";
    const validated = cleanAndValidatePhone(text, text);
    return validated === "Not found" ? "None" : validated;
  } catch (err: any) {
    console.warn("extractDigitsFromBase64Image Error:", err);
    throw err;
  }
};

/**
 * Preprocesses an image to improve OCR accuracy.
 * Upscales small images and applies a simple contrast boost.
 */
const enhanceImageForOCR = async (base64Data: string, mimeType: string): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(base64Data);
        return;
      }

      // Target a minimum width for better OCR
      let width = img.width;
      let height = img.height;
      if (width < 400) {
        const ratio = 400 / width;
        width = 400;
        height = height * ratio;
      }

      canvas.width = width;
      canvas.height = height;

      // Draw image with high quality scaling
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);

      // Apply a simple contrast enhancement
      try {
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        // Simple contrast factor
        const factor = (259 * (128 + 255)) / (255 * (259 - 128));
        
        for (let i = 0; i < data.length; i += 4) {
          // Grayscale first
          const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
          // Apply contrast to the grayscale value
          const v = factor * (avg - 128) + 128;
          data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, v));
        }
        ctx.putImageData(imageData, 0, 0);
      } catch (e) {
        console.warn("Could not apply pixel-level enhancement:", e);
      }

      resolve(canvas.toDataURL(mimeType).split(',')[1]);
    };
    img.onerror = () => resolve(base64Data);
    img.src = `data:${mimeType};base64,${base64Data}`;
  });
};

interface Listing {
  id: number | string;
  adId?: string;
  title: string;
  link: string;
  image: string;
  images?: string[];
  currentImageIndex?: number;
  location: string;
  date?: string;
  description?: string;
  phoneNumber: string;
  revealedPhone?: string;
  phoneImage?: string;
  isRevealing?: boolean;
  isScanningImage?: boolean;
  isDeepScanning?: boolean;
  isDescriptionFetched?: boolean;
  author?: string;
  source?: 'publi24' | 'bursaplacerilor' | 'nimfomane' | 'inspector';
}

export interface SavedProfile {
  id: string;
  adId?: string;
  title: string;
  link: string;
  image: string;
  images?: string[];
  currentImageIndex?: number;
  location: string;
  date?: string;
  description?: string;
  price?: string;
  phoneNumber?: string;
  revealedPhone?: string;
  phoneImage?: string;
  author?: string;
  source?: 'publi24' | 'bursaplacerilor' | 'nimfomane' | 'inspector';
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

const COUNTIES = [
  { id: '', name: 'Toată România' },
  { id: 'alba', name: 'Alba' },
  { id: 'arad', name: 'Arad' },
  { id: 'arges', name: 'Argeș' },
  { id: 'bacau', name: 'Bacău' },
  { id: 'bihor', name: 'Bihor' },
  { id: 'bistrita-nasaud', name: 'Bistrița-Năsăud' },
  { id: 'botosani', name: 'Botoșani' },
  { id: 'braila', name: 'Brăila' },
  { id: 'brasov', name: 'Brașov' },
  { id: 'bucuresti', name: 'București' },
  { id: 'buzau', name: 'Buzău' },
  { id: 'calarasi', name: 'Călărași' },
  { id: 'caras-severin', name: 'Caraș-Severin' },
  { id: 'cluj', name: 'Cluj' },
  { id: 'constanta', name: 'Constanța' },
  { id: 'covasna', name: 'Covasna' },
  { id: 'dambovita', name: 'Dâmbovița' },
  { id: 'dolj', name: 'Dolj' },
  { id: 'galati', name: 'Galați' },
  { id: 'giurgiu', name: 'Giurgiu' },
  { id: 'gorj', name: 'Gorj' },
  { id: 'harghita', name: 'Harghita' },
  { id: 'hunedoara', name: 'Hunedoara' },
  { id: 'ialomita', name: 'Ialomița' },
  { id: 'iasi', name: 'Iași' },
  { id: 'ilfov', name: 'Ilfov' },
  { id: 'maramures', name: 'Maramureș' },
  { id: 'mehedinti', name: 'Mehedinți' },
  { id: 'mures', name: 'Mureș' },
  { id: 'neamt', name: 'Neamț' },
  { id: 'olt', name: 'Olt' },
  { id: 'prahova', name: 'Prahova' },
  { id: 'salaj', name: 'Sălaj' },
  { id: 'satu-mare', name: 'Satu Mare' },
  { id: 'sibiu', name: 'Sibiu' },
  { id: 'suceava', name: 'Suceava' },
  { id: 'teleorman', name: 'Teleorman' },
  { id: 'timis', name: 'Timiș' },
  { id: 'tulcea', name: 'Tulcea' },
  { id: 'valcea', name: 'Vâlcea' },
  { id: 'vaslui', name: 'Vaslui' },
  { id: 'vrancea', name: 'Vrancea' },
];

const CITIES_BY_COUNTY: Record<string, { id: string, name: string }[]> = {
  'alba': [{ id: 'alba-iulia', name: 'Alba Iulia' }, { id: 'sebes', name: 'Sebeș' }, { id: 'aiud', name: 'Aiud' }, { id: 'cugir', name: 'Cugir' }, { id: 'blaj', name: 'Blaj' }, { id: 'ocna-mures', name: 'Ocna Mureș' }],
  'arad': [{ id: 'arad', name: 'Arad' }, { id: 'pecica', name: 'Pecica' }, { id: 'santana', name: 'Sântana' }, { id: 'lipova', name: 'Lipova' }, { id: 'ineu', name: 'Ineu' }, { id: 'chiisineu-cris', name: 'Chișineu-Criș' }],
  'arges': [{ id: 'pitesti', name: 'Pitești' }, { id: 'mioveni', name: 'Mioveni' }, { id: 'campulung', name: 'Câmpulung' }, { id: 'curtea-de-arges', name: 'Curtea de Argeș' }, { id: 'stefanesti', name: 'Ștefănești' }, { id: 'costesti', name: 'Costești' }],
  'bacau': [{ id: 'bacau', name: 'Bacău' }, { id: 'onesti', name: 'Onești' }, { id: 'moinesti', name: 'Moinești' }, { id: 'comanesti', name: 'Comănești' }, { id: 'buhusi', name: 'Buhuși' }, { id: 'darmanesti', name: 'Dărmănești' }],
  'bihor': [{ id: 'oradea', name: 'Oradea' }, { id: 'salonta', name: 'Salonta' }, { id: 'marghita', name: 'Marghita' }, { id: 'beius', name: 'Beiuș' }, { id: 'sacueni', name: 'Săcueni' }, { id: 'stei', name: 'Ștei' }],
  'bistrita-nasaud': [{ id: 'bistrita', name: 'Bistrița' }, { id: 'beclean', name: 'Beclean' }, { id: 'nasaud', name: 'Năsăud' }, { id: 'sangeorz-bai', name: 'Sângeorz-Băi' }],
  'botosani': [{ id: 'botosani', name: 'Botoșani' }, { id: 'dorohoi', name: 'Dorohoi' }, { id: 'darabani', name: 'Darabani' }, { id: 'saveni', name: 'Săveni' }, { id: 'flamanzi', name: 'Flămânzi' }],
  'braila': [{ id: 'braila', name: 'Brăila' }, { id: 'ianca', name: 'Ianca' }, { id: 'insuratei', name: 'Însurăței' }, { id: 'faurei', name: 'Făurei' }],
  'brasov': [{ id: 'brasov', name: 'Brașov' }, { id: 'fagaras', name: 'Făgăraș' }, { id: 'sacele', name: 'Săcele' }, { id: 'zarnesti', name: 'Zărnești' }, { id: 'codlea', name: 'Codlea' }, { id: 'rasnov', name: 'Râșnov' }, { id: 'victoria', name: 'Victoria' }, { id: 'rupea', name: 'Rupea' }, { id: 'ghimbav', name: 'Ghimbav' }, { id: 'predeal', name: 'Predeal' }],
  'bucuresti': [{ id: 'sector-1', name: 'Sector 1' }, { id: 'sector-2', name: 'Sector 2' }, { id: 'sector-3', name: 'Sector 3' }, { id: 'sector-4', name: 'Sector 4' }, { id: 'sector-5', name: 'Sector 5' }, { id: 'sector-6', name: 'Sector 6' }],
  'buzau': [{ id: 'buzau', name: 'Buzău' }, { id: 'ramnicu-sarat', name: 'Râmnicu Sărat' }, { id: 'nehoiu', name: 'Nehoiu' }, { id: 'patarlagele', name: 'Pătârlagele' }, { id: 'pogoanele', name: 'Pogoanele' }],
  'calarasi': [{ id: 'calarasi', name: 'Călărași' }, { id: 'oltenita', name: 'Oltenița' }, { id: 'budesti', name: 'Budești' }, { id: 'fundulea', name: 'Fundulea' }, { id: 'lehliu-gara', name: 'Lehliu Gară' }],
  'caras-severin': [{ id: 'resita', name: 'Reșița' }, { id: 'caransebes', name: 'Caransebeș' }, { id: 'bocsa', name: 'Bocșa' }, { id: 'moldova-noua', name: 'Moldova Nouă' }, { id: 'otelu-rosu', name: 'Oțelu Roșu' }, { id: 'anina', name: 'Anina' }, { id: 'herculane', name: 'Băile Herculane' }],
  'cluj': [{ id: 'cluj-napoca', name: 'Cluj-Napoca' }, { id: 'turda', name: 'Turda' }, { id: 'dej', name: 'Dej' }, { id: 'campia-turzii', name: 'Câmpia Turzii' }, { id: 'gherla', name: 'Gherla' }, { id: 'huedin', name: 'Huedin' }],
  'constanta': [{ id: 'constanta', name: 'Constanța' }, { id: 'mamaia', name: 'Mamaia' }, { id: 'vama-veche', name: 'Vama Veche' }, { id: 'mangalia', name: 'Mangalia' }, { id: 'medgidia', name: 'Medgidia' }, { id: 'navodari', name: 'Năvodari' }, { id: 'cernavoda', name: 'Cernavodă' }, { id: 'ovidiu', name: 'Ovidiu' }, { id: 'murfatlar', name: 'Murfatlar' }, { id: 'harsova', name: 'Hârșova' }, { id: 'eforie', name: 'Eforie' }, { id: 'techirghiol', name: 'Techirghiol' }, { id: 'costinesti', name: 'Costinești' }, { id: 'neptun', name: 'Neptun' }],
  'covasna': [{ id: 'sfantu-gheorghe', name: 'Sfântu Gheorghe' }, { id: 'targu-secuiesc', name: 'Târgu Secuiesc' }, { id: 'covasna', name: 'Covasna' }, { id: 'baraolt', name: 'Baraolt' }, { id: 'intorsura-buzaului', name: 'Întorsura Buzăului' }],
  'dambovita': [{ id: 'targoviste', name: 'Târgoviște' }, { id: 'moreni', name: 'Moreni' }, { id: 'pucioasa', name: 'Pucioasa' }, { id: 'gaesti', name: 'Găești' }, { id: 'titu', name: 'Titu' }, { id: 'fieni', name: 'Fieni' }],
  'dolj': [{ id: 'craiova', name: 'Craiova' }, { id: 'bailesti', name: 'Băilești' }, { id: 'calafat', name: 'Calafat' }, { id: 'filiasi', name: 'Filiași' }, { id: 'dabuleni', name: 'Dăbuleni' }, { id: 'segarcea', name: 'Segarcea' }, { id: 'bechet', name: 'Bechet' }],
  'galati': [{ id: 'galati', name: 'Galați' }, { id: 'tecuci', name: 'Tecuci' }, { id: 'targu-bujor', name: 'Târgu Bujor' }, { id: 'beresti', name: 'Berești' }],
  'giurgiu': [{ id: 'giurgiu', name: 'Giurgiu' }, { id: 'bolintin-vale', name: 'Bolintin-Vale' }, { id: 'mihailesti', name: 'Mihăilești' }],
  'gorj': [{ id: 'targu-jiu', name: 'Târgu Jiu' }, { id: 'motru', name: 'Motru' }, { id: 'rovinari', name: 'Rovinari' }, { id: 'bumbesti-jiu', name: 'Bumbești-Jiu' }, { id: 'targu-carbunesti', name: 'Târgu Cărbunești' }, { id: 'turceni', name: 'Turceni' }, { id: 'tismana', name: 'Tismana' }, { id: 'novaci', name: 'Novaci' }, { id: 'ticleni', name: 'Țicleni' }],
  'harghita': [{ id: 'miercurea-ciuc', name: 'Miercurea Ciuc' }, { id: 'odorheiu-secuiesc', name: 'Odorheiu Secuiesc' }, { id: 'gheorgheni', name: 'Gheorgheni' }, { id: 'toplita', name: 'Toplița' }, { id: 'cristuru-secuiesc', name: 'Cristuru Secuiesc' }, { id: 'balan', name: 'Bălan' }, { id: 'vlahita', name: 'Vlăhița' }, { id: 'borsec', name: 'Borsec' }, { id: 'tusnad', name: 'Băile Tușnad' }],
  'hunedoara': [{ id: 'deva', name: 'Deva' }, { id: 'hunedoara', name: 'Hunedoara' }, { id: 'petrosani', name: 'Petroșani' }, { id: 'vulcan', name: 'Vulcan' }, { id: 'lupeni', name: 'Lupeni' }, { id: 'petrila', name: 'Petrila' }, { id: 'orastie', name: 'Orăștie' }, { id: 'brad', name: 'Brad' }, { id: 'simeria', name: 'Simeria' }, { id: 'calan', name: 'Călan' }, { id: 'hateg', name: 'Hațeg' }, { id: 'uricani', name: 'Uricani' }, { id: 'geoagiu', name: 'Geoagiu' }, { id: 'aninoasa', name: 'Aninoasa' }],
  'ialomita': [{ id: 'slobozia', name: 'Slobozia' }, { id: 'fetesti', name: 'Fetești' }, { id: 'urziceni', name: 'Urziceni' }, { id: 'tandarei', name: 'Țăndărei' }, { id: 'amara', name: 'Amara' }, { id: 'fierbinti-targ', name: 'Fierbinți-Târg' }, { id: 'cazanesti', name: 'Căzănești' }],
  'iasi': [{ id: 'iasi', name: 'Iași' }, { id: 'pascani', name: 'Pașcani' }, { id: 'harlau', name: 'Hârlău' }, { id: 'targu-frumos', name: 'Târgu Frumos' }, { id: 'podu-iloaiei', name: 'Podu Iloaiei' }],
  'ilfov': [{ id: 'voluntari', name: 'Voluntari' }, { id: 'pantelimon', name: 'Pantelimon' }, { id: 'buftea', name: 'Buftea' }, { id: 'popesti-leordeni', name: 'Popești-Leordeni' }, { id: 'bragadiru', name: 'Bragadiru' }, { id: 'chitila', name: 'Chitila' }, { id: 'magurele', name: 'Măgurele' }, { id: 'otopeni', name: 'Otopeni' }],
  'maramures': [{ id: 'baia-mare', name: 'Baia Mare' }, { id: 'sighetu-marmatiei', name: 'Sighetu Marmației' }, { id: 'baia-sprie', name: 'Baia Sprie' }, { id: 'viseu-de-sus', name: 'Vișeu de Sus' }, { id: 'borsa', name: 'Borșa' }, { id: 'cavnic', name: 'Cavnic' }, { id: 'seini', name: 'Seini' }, { id: 'targu-lapus', name: 'Târgu Lăpuș' }],
  'mehedinti': [{ id: 'drobeta-turnu-severin', name: 'Drobeta-Turnu Severin' }, { id: 'orsova', name: 'Orșova' }, { id: 'streaia', name: 'Strehaia' }, { id: 'vanju-mare', name: 'Vânju Mare' }, { id: 'baia-de-arama', name: 'Baia de Aramă' }],
  'mures': [{ id: 'targu-mures', name: 'Târgu Mureș' }, { id: 'sighisoara', name: 'Sighișoara' }, { id: 'reghin', name: 'Reghin' }, { id: 'tarnaveni', name: 'Târnăveni' }, { id: 'ludus', name: 'Luduș' }, { id: 'sovata', name: 'Sovata' }, { id: 'iernut', name: 'Iernut' }, { id: 'sarmaşu', name: 'Sărmașu' }, { id: 'ungheni', name: 'Ungheni' }, { id: 'miercurea-nirajului', name: 'Miercurea Nirajului' }, { id: 'sangiorgiu-de-padure', name: 'Sângeorgiu de Pădure' }],
  'neamt': [{ id: 'piatra-neamt', name: 'Piatra Neamț' }, { id: 'roman', name: 'Roman' }, { id: 'targu-neamt', name: 'Târgu Neamț' }, { id: 'bicaz', name: 'Bicaz' }, { id: 'roznov', name: 'Roznov' }],
  'olt': [{ id: 'slatina', name: 'Slatina' }, { id: 'caracal', name: 'Caracal' }, { id: 'balsh', name: 'Balș' }, { id: 'corabia', name: 'Corabia' }, { id: 'scornicesti', name: 'Scornicești' }, { id: 'draganesti-olt', name: 'Drăgănești-Olt' }, { id: 'piatra-olt', name: 'Piatra-Olt' }, { id: 'potcoava', name: 'Potcoava' }],
  'prahova': [{ id: 'ploiesti', name: 'Ploiești' }, { id: 'campina', name: 'Câmpina' }, { id: 'baicoi', name: 'Băicoi' }, { id: 'breaza', name: 'Breaza' }, { id: 'mizil', name: 'Mizil' }, { id: 'comarnic', name: 'Comarnic' }, { id: 'valenii-de-munte', name: 'Vălenii de Munte' }, { id: 'boldesti-scaieni', name: 'Boldești-Scăeni' }, { id: 'urlati', name: 'Urlați' }, { id: 'sinaia', name: 'Sinaia' }, { id: 'busteni', name: 'Bușteni' }, { id: 'plopeni', name: 'Plopeni' }, { id: 'slanic', name: 'Slănic' }, { id: 'azuga', name: 'Azuga' }],
  'salaj': [{ id: 'zalau', name: 'Zalău' }, { id: 'shimleu-silvaniei', name: 'Șimleu Silvaniei' }, { id: 'jibou', name: 'Jibou' }, { id: 'ceuahu-silvaniei', name: 'Cehu Silvaniei' }],
  'satu-mare': [{ id: 'satu-mare', name: 'Satu Mare' }, { id: 'carei', name: 'Carei' }, { id: 'negresti-oas', name: 'Negrești-Oaș' }, { id: 'tasnad', name: 'Tășnad' }, { id: 'livada', name: 'Livada' }, { id: 'ardud', name: 'Ardud' }],
  'sibiu': [{ id: 'sibiu', name: 'Sibiu' }, { id: 'medias', name: 'Mediaș' }, { id: 'cisnadie', name: 'Cisnădie' }, { id: 'avrig', name: 'Avrig' }, { id: 'agnita', name: 'Agnita' }, { id: 'dumbraveni', name: 'Dumbrăveni' }, { id: 'talmaciu', name: 'Tălmaciu' }, { id: 'copsha-mica', name: 'Copșa Mică' }, { id: 'saliste', name: 'Săliște' }, { id: 'miercurea-sibiului', name: 'Miercurea Sibiului' }, { id: 'ocna-sibiului', name: 'Ocna Sibiului' }],
  'suceava': [{ id: 'suceava', name: 'Suceava' }, { id: 'falticeni', name: 'Fălticeni' }, { id: 'radauti', name: 'Rădăuți' }, { id: 'campulung-moldovenesc', name: 'Câmpulung Moldovenesc' }, { id: 'vatra-dornei', name: 'Vatra Dornei' }, { id: 'gura-humorului', name: 'Gura Humorului' }, { id: 'vicovu-de-sus', name: 'Vicovu de Sus' }, { id: 'brosteni', name: 'Broșteni' }, { id: 'cajvana', name: 'Cajvana' }, { id: 'dolhasca', name: 'Dolhasca' }, { id: 'frasin', name: 'Frasin' }, { id: 'liteni', name: 'Liteni' }, { id: 'milisauti', name: 'Milișăuți' }, { id: 'salcea', name: 'Salcea' }, { id: 'siret', name: 'Siret' }, { id: 'solca', name: 'Solca' }],
  'teleorman': [{ id: 'alexandria', name: 'Alexandria' }, { id: 'rosiorii-de-vede', name: 'Roșiorii de Vede' }, { id: 'turnu-magurele', name: 'Turnu Măgurele' }, { id: 'zimnicea', name: 'Zimnicea' }, { id: 'videle', name: 'Videle' }],
  'timis': [{ id: 'timisoara', name: 'Timișoara' }, { id: 'lugoj', name: 'Lugoj' }, { id: 'sannicolau-mare', name: 'Sânnicolau Mare' }, { id: 'jimbolia', name: 'Jimbolia' }, { id: 'recaş', name: 'Recaș' }, { id: 'buziaş', name: 'Buziaș' }, { id: 'faget', name: 'Făget' }, { id: 'deta', name: 'Deta' }, { id: 'ciavoda', name: 'Ciacova' }, { id: 'gataja', name: 'Gătaia' }],
  'tulcea': [{ id: 'tulcea', name: 'Tulcea' }, { id: 'babadag', name: 'Babadag' }, { id: 'macin', name: 'Măcin' }, { id: 'isaccea', name: 'Isaccea' }, { id: 'sulina', name: 'Sulina' }],
  'valcea': [{ id: 'ramnicu-valcea', name: 'Râmnicu Vâlcea' }, { id: 'dragasani', name: 'Drăgășani' }, { id: 'babeni', name: 'Băbeni' }, { id: 'calimanesti', name: 'Călimănești' }, { id: 'horezu', name: 'Horezu' }, { id: 'brezoi', name: 'Brezoi' }, { id: 'balceşti', name: 'Bălcești' }, { id: 'berbeşti', name: 'Berbești' }, { id: 'baile-olaneşti', name: 'Băile Olănești' }, { id: 'ocnele-mari', name: 'Ocnele Mari' }, { id: 'baile-govora', name: 'Băile Govora' }],
  'vaslui': [{ id: 'vaslui', name: 'Vaslui' }, { id: 'barlad', name: 'Bârlad' }, { id: 'husi', name: 'Huși' }, { id: 'negrasti', name: 'Negrești' }, { id: 'murgeni', name: 'Murgeni' }],
  'vrancea': [{ id: 'focsani', name: 'Focșani' }, { id: 'adjud', name: 'Adjud' }, { id: 'marasheshti', name: 'Mărășești' }, { id: 'panciu', name: 'Panciu' }, { id: 'odobeshti', name: 'Odobești' }],
};

/**
 * Canonical 9-digit phone extractor (e.g. 7xxxxxxxx) for strict deduplication
 */
export function getNormalizedPhone(item: { revealedPhone?: string; phoneNumber?: string; link?: string }): string {
  if (!item) return '';
  let raw = item.revealedPhone || '';
  if (!raw && item.phoneNumber && !item.phoneNumber.toLowerCase().includes('click') && !item.phoneNumber.toLowerCase().includes('reveal')) {
    raw = item.phoneNumber;
  }
  if (!raw && item.link) {
    const m = item.link.match(/\/(\d{10})\//);
    if (m) raw = m[1];
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 9) {
    return digits.slice(-9);
  }
  return '';
}

/**
 * Filter out transexual, ts, trans, trasexuala, pentru femei / doamne, gay/lesbi
 */
export function isExcludedListing(item: { title?: string; description?: string; link?: string; location?: string; category?: string }): boolean {
  if (!item) return false;
  const rawText = `${item.title || ''} ${item.description || ''} ${item.link || ''} ${item.location || ''} ${item.category || ''}`.toLowerCase();
  
  // Normalize diacritics
  const text = rawText
    .replace(/ă/g, "a").replace(/â/g, "a").replace(/î/g, "i")
    .replace(/ș/g, "s").replace(/ş/g, "s").replace(/ț/g, "t").replace(/ţ/g, "t");

  // 1. Direct URL path checks
  if (/\/gay-lesbi\//i.test(text) || /\/transex\w*\//i.test(text) || /\/ts\//i.test(text)) return true;

  // 2. Direct category & badge text checks
  if (text.includes("transexuale") || text.includes("gay-lesbi") || text.includes("travesti")) return true;

  // 3. Regex patterns for trans / transexual / trasexuala / ts
  const transPatterns = [
    /\btrans\b/i,
    /\btrans[_-]/i,
    /\btransex\w*/i,
    /\btranssex\w*/i,
    /\btrasex\w*/i,
    /\btranx\w*/i,
    /\btransx\w*/i,
    /\btravesti\w*/i,
    /\bshe-?male\b/i,
    /\blady-?boy\b/i,
    /\bcrossdress\w*/i,
    /\bfemboy\b/i,
    /\bfemboi\b/i,
    /\bgay-?lesbi\b/i,
    /\bfata\s+trans\b/i,
    /\btrans\s+(reala|draguta|superba|noua|activa|pasiva|versatila|sexy|fata|model|fem)\b/i,
    /\bts\b/i,
    /\bts\s+/i,
    /\bts\d/i,
    /\bts[_-]/i,
    /\bbby\s+ts\b/i,
    /\bmasaj\s+yoni\b/i
  ];

  for (const pat of transPatterns) {
    if (pat.test(text)) return true;
  }

  // 4. Regex patterns for "pentru femei", "pt femei", "pt doamne", "pentru doamne", "domnisoare si doamne"
  const pentruFemeiPatterns = [
    /\b(pentru|pt\.?)\s+(femei|doamne|domnisoare)/i,
    /\bdoamne\s+si\s+domnisoare\b/i,
    /\bdomnisoare\s+si\s+doamne\b/i,
    /\bdoamnelor\s+si\s+domnisoarelor\b/i,
    /\bdomnisoarelor\s+si\s+doamnelor\b/i,
    /\b(pentru|pt\.?)\s+.*?\bdoamne\b/i,
    /\bdoamne\s+si\s+cupluri\b/i,
    /\bcupluri\s+si\s+doamne\b/i,
    /\b(domni|barbati)\s*,\s*doamne\b/i,
    /\b(domni|barbati)\s+si\s+doamne\b/i,
    /\b(dedicat|adresat)\s+(doamnelor|femeilor)/i,
    /\bdoar\s+(pentru|pt\.?)\s+(doamne|femei)/i,
    /\bmaseur\s+(domn|barbat)\b/i,
    /\bbarbat\s+(pentru|pt\.?)\s+(doamne|femei)/i,
    /\bdomn\s+(pentru|pt\.?)\s+(doamne|femei)/i,
    /\bservicii\s+(pentru|pt\.?)\s+(doamne|femei)/i
  ];

  for (const pat of pentruFemeiPatterns) {
    if (pat.test(text)) return true;
  }

  return false;
}

/**
 * Robust fetch with timeout and better error reporting
 */
async function fetchWithTimeout(resource: string, options: any = {}) {
  const { timeout = 300000 } = options;
  
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(resource, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);

    // Monkey-patch json method to provide highly descriptive errors and automatic retry if an HTML proxy warmup/fallback is returned
    const originalJson = response.json.bind(response);
    response.json = async () => {
      const contentType = response.headers.get("content-type") || "";
      let isHtml = false;
      if (contentType && !contentType.includes("application/json")) {
        try {
          const clonedRes = response.clone();
          const text = await clonedRes.text();
          const snippet = text.slice(0, 150).trim().toLowerCase();
          if (snippet.includes("<!doctype html") || snippet.includes("<html") || snippet.includes("<body")) {
            isHtml = true;
          }
        } catch {}
      }

      if (isHtml) {
        // If an HTML fallback page occurred on an API call, retry once if allowed
        if (!options._isRetry && resource.startsWith("/api")) {
          console.warn(`[FETCH RETRY] HTML fallback received for ${resource}. Retrying in 1.5s...`);
          await new Promise(r => setTimeout(r, 1500));
          const retryRes = await fetchWithTimeout(resource, { ...options, _isRetry: true });
          return await retryRes.json();
        }
        throw new Error(`Serverul a returnat o pagină temporară HTML în loc de date JSON. Te rugăm să reîncerci căutarea.`);
      }

      try {
        return await originalJson();
      } catch (err: any) {
        try {
          const clonedRes = response.clone();
          const text = await clonedRes.text();
          const snippet = text.trim().toLowerCase();
          if (snippet.startsWith("<!doctype") || snippet.startsWith("<html") || snippet.startsWith("<body")) {
            if (!options._isRetry && resource.startsWith("/api")) {
              console.warn(`[FETCH RETRY] HTML page received in JSON parse for ${resource}. Retrying in 1.5s...`);
              await new Promise(r => setTimeout(r, 1500));
              const retryRes = await fetchWithTimeout(resource, { ...options, _isRetry: true });
              return await retryRes.json();
            }
            throw new Error(`Serverul a returnat o pagină HTML în loc de JSON (Status ${response.status}).`);
          }
          throw new Error(`Eroare parsare JSON (Status ${response.status}): ${err.message || String(err)}`);
        } catch (cloneErr: any) {
          if (cloneErr.message?.includes("HTML") || cloneErr.message?.includes("JSON")) throw cloneErr;
          throw new Error(`Eroare procesare răspuns (Status ${response.status}): ${err.message || String(err)}`);
        }
      }
    };

    return response;
  } catch (error: any) {
    clearTimeout(id);
    
    // Check if it's an abort error
    if (error.name === 'AbortError' || 
        (error instanceof DOMException && error.name === 'AbortError') ||
        error.message?.includes('aborted') ||
        error.message?.includes('AbortError')) {
      console.warn(`[FETCH TIMEOUT/ABORT] ${resource} aborted after ${timeout}ms. Error: ${error.message}`);
      throw new Error('Cererea a expirat. Serverul sau site-ul sursă răspunde lent.');
    }
    
    console.warn(`[FETCH ERROR] ${resource}:`, error.message || error);
    
    // Retry once for "Failed to fetch" which is often a transient connection issue
    if (error.message === 'Failed to fetch' && !options._isRetry) {
      console.log(`[FETCH RETRY] Retrying ${resource} once...`);
      await new Promise(r => setTimeout(r, 2000));
      return fetchWithTimeout(resource, { ...options, _isRetry: true });
    }

    if (error.message === 'Failed to fetch') {
      const isCritical = resource.includes('/api/health') || resource.includes('/api/scrape');
      if (isCritical) {
        throw new Error('Nu s-a putut realiza conexiunea cu serverul. Te rugăm să verifici conexiunea.');
      } else {
        throw new Error(`Problemă temporară de conexiune pe resursă secundară: ${resource}`);
      }
    }
    throw error;
  }
}

export default function App() {
  const [county, setCounty] = useState('');
  const [city, setCity] = useState('');
  const [citySearch, setCitySearch] = useState('');
  const [isCityDropdownOpen, setIsCityDropdownOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [listings, setListings] = useState<Listing[]>([]);
  const [pagesMap, setPagesMap] = useState<Record<number, Listing[]>>({});
  const [loading, setLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('');
  const [page, setPage] = useState(1);
  const [totalResults, setTotalResults] = useState<number | null>(null);

  const normalizeLink = (url: string) => {
    if (!url) return '';
    return url.split('?')[0].split('#')[0].trim().replace(/\/$/, '').toLowerCase();
  };
  const [error, setError] = useState<string | null>(null);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [source, setSource] = useState<'publi24' | 'bursaplacerilor' | 'nimfomane' | 'inspector'>('publi24');
  const [pageSize, setPageSize] = useState<number>(100);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyingJsonId, setCopyingJsonId] = useState<string | number | null>(null);
  const verifiedCopyDetailsRef = React.useRef<Map<string, any>>(new Map());
  const [excludeOras, setExcludeOras] = useState(false);

  // View Navigation: 'crawler' | 'scraper' | 'saved'
  const [activeTab, setActiveTab] = useState<'scraper' | 'saved' | 'crawler'>(() => {
    try {
      const s = localStorage.getItem('publi24_active_tab');
      if (s === 'crawler' || s === 'saved' || s === 'scraper') return s;
    } catch {}
    return 'crawler';
  });

  const handleSetActiveTab = (tab: 'scraper' | 'saved' | 'crawler') => {
    setActiveTab(tab);
    try {
      localStorage.setItem('publi24_active_tab', tab);
    } catch {}
  };

  // Crawler State & Actions in App
  const [crawlerState, setCrawlerState] = useState<any>(null);
  const [crawlerActionLoading, setCrawlerActionLoading] = useState<boolean>(false);

  const fetchCrawlerStatus = React.useCallback(async () => {
    try {
      const res = await fetch("/api/crawler/status");
      if (res.ok) {
        const data = await res.json();
        setCrawlerState(data);
      }
    } catch (e) {
      console.warn("Failed to fetch crawler status", e);
    }
  }, []);

  useEffect(() => {
    fetchCrawlerStatus();
    const interval = setInterval(() => {
      fetchCrawlerStatus();
    }, crawlerState?.status === 'running' ? 2500 : 10000);
    return () => clearInterval(interval);
  }, [fetchCrawlerStatus, crawlerState?.status]);

  const handleStartCrawler = async () => {
    setCrawlerActionLoading(true);
    try {
      const res = await fetch("/api/crawler/start", { method: "POST" });
      const data = await res.json();
      if (data.state) setCrawlerState(data.state);
      fetchSavedProfiles();
    } catch (e) {
      console.warn("Crawler start error", e);
    } finally {
      setCrawlerActionLoading(false);
    }
  };

  const handlePauseCrawler = async () => {
    setCrawlerActionLoading(true);
    try {
      const res = await fetch("/api/crawler/pause", { method: "POST" });
      const data = await res.json();
      if (data.state) setCrawlerState(data.state);
    } catch (e) {
      console.warn("Crawler pause error", e);
    } finally {
      setCrawlerActionLoading(false);
    }
  };

  const handleResumeCrawler = async () => {
    setCrawlerActionLoading(true);
    try {
      const res = await fetch("/api/crawler/resume", { method: "POST" });
      const data = await res.json();
      if (data.state) setCrawlerState(data.state);
    } catch (e) {
      console.warn("Crawler resume error", e);
    } finally {
      setCrawlerActionLoading(false);
    }
  };

  const handleToggleCrawler = async () => {
    setCrawlerActionLoading(true);
    try {
      const res = await fetch("/api/crawler/toggle", { method: "POST" });
      const data = await res.json();
      if (data.state) setCrawlerState(data.state);
    } catch (e) {
      console.warn("Crawler toggle error", e);
    } finally {
      setCrawlerActionLoading(false);
    }
  };

  const handleClearCrawlerLogs = async () => {
    try {
      const res = await fetch("/api/crawler/clear-logs", { method: "POST" });
      const data = await res.json();
      if (data.state) setCrawlerState(data.state);
    } catch (e) {
      console.warn("Crawler clear logs error", e);
    }
  };

  // Saved Profiles Archive & Phone Search state
  const [savedProfiles, setSavedProfiles] = useState<SavedProfile[]>([]);
  const [savedCount, setSavedCount] = useState<number>(0);
  const [loadingSaved, setLoadingSaved] = useState<boolean>(false);
  const [phoneSearchQuery, setPhoneSearchQuery] = useState<string>('');
  const [savedTextQuery, setSavedTextQuery] = useState<string>('');
  const [savedStatusFilter, setSavedStatusFilter] = useState<'all' | 'active' | 'expired'>('all');
  const [savedSourceFilter, setSavedSourceFilter] = useState<'all' | 'publi24' | 'bursaplacerilor' | 'nimfomane' | 'inspector'>('all');
  const [autoSaveEnabled, setAutoSaveEnabled] = useState<boolean>(() => {
    try {
      const s = localStorage.getItem('publi24_autosave');
      return s !== null ? JSON.parse(s) : true;
    } catch {
      return true;
    }
  });

  const [updatingProfileId, setUpdatingProfileId] = useState<string | null>(null);
  const [updateFeedback, setUpdateFeedback] = useState<{ id: string; message: string; type: 'success' | 'warning' } | null>(null);
  const [savedLinksSet, setSavedLinksSet] = useState<Set<string>>(new Set());

  const [isServerOnline, setIsServerOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    const checkHealth = async (isRetry = false, attempt = 1): Promise<boolean> => {
      try {
        const res = await fetch('/api/health');
        if (res.ok) {
          if (active) {
            setIsServerOnline(true);
          }
          return true;
        } else {
          console.warn("[HEALTH] Server returned non-OK status");
          if (active) {
            setIsServerOnline(false);
          }
          return false;
        }
      } catch (e) {
        // Log cleanly to avoid false-positives during hot-restarts
        console.log("[HEALTH] Host status: offline");
        if (active) {
          setIsServerOnline(false);
        }
        if (isRetry && attempt < 5) {
          const delay = attempt * 2000;
          console.log(`[HEALTH RETRY] Checking health again in ${delay}ms... (attempt ${attempt}/5)`);
          await new Promise(r => setTimeout(r, delay));
          return checkHealth(true, attempt + 1);
        }
        return false;
      }
    };
    
    // Initial active retrying check
    checkHealth(true, 1);
    
    // Regular polling
    const interval = setInterval(() => {
      checkHealth(false);
    }, 45000);
    
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const copyToClipboard = async (text: string, id: string) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
        return;
      }
    } catch (err) {
      console.warn('navigator.clipboard failed, trying fallback:', err);
    }

    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.setAttribute('aria-hidden', 'true');
      textarea.className = 'fixed -left-[9999px] top-0 opacity-0 pointer-events-none';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (ok) {
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
      }
    } catch (fallbackErr) {
      console.warn('Fallback copy failed:', fallbackErr);
    }
  };

  const downloadImage = async (url: string, filename: string) => {
    try {
      const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(url)}`;
      const response = await fetchWithTimeout(proxyUrl);
      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.warn('Download failed:', err);
    }
  };

  const downloadAllImages = async (listing: Listing) => {
    if (!listing.images || listing.images.length === 0) return;
    for (let i = 0; i < listing.images.length; i++) {
      await downloadImage(listing.images[i], `${listing.title.slice(0, 20)}-${i + 1}.jpg`);
      // Small delay to avoid browser blocking multiple downloads
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  };

  const nextImage = (idx: number) => {
    const newListings = [...listings];
    const item = newListings[idx];
    if (item.images && item.images.length > 1) {
      const nextIdx = ((item.currentImageIndex || 0) + 1) % item.images.length;
      newListings[idx] = { ...item, currentImageIndex: nextIdx };
      setListings(newListings);
    }
  };

  const prevImage = (idx: number) => {
    const newListings = [...listings];
    const item = newListings[idx];
    if (item.images && item.images.length > 1) {
      const prevIdx = ((item.currentImageIndex || 0) - 1 + item.images.length) % item.images.length;
      newListings[idx] = { ...item, currentImageIndex: prevIdx };
      setListings(newListings);
    }
  };

  const fetchSavedProfiles = async (phoneFilter?: string, textFilter?: string) => {
    setLoadingSaved(true);
    try {
      const p = phoneFilter !== undefined ? phoneFilter : phoneSearchQuery;
      const q = textFilter !== undefined ? textFilter : savedTextQuery;
      let url = `/api/saved-profiles?source=${savedSourceFilter}&status=${savedStatusFilter}`;
      if (p && p.trim()) url += `&phone=${encodeURIComponent(p.trim())}`;
      if (q && q.trim()) url += `&q=${encodeURIComponent(q.trim())}`;

      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const rawProfiles: SavedProfile[] = (data.profiles || []).map((p: any) => ({
          ...p,
          currentImageIndex: 0
        }));
        
        // Strict exclusion and phone deduplication
        const seenPhones = new Set<string>();
        const profiles: SavedProfile[] = [];
        for (const p of rawProfiles) {
          if (isExcludedListing(p)) continue;
          const cleanPhone = getNormalizedPhone(p);
          if (cleanPhone && seenPhones.has(cleanPhone)) continue;
          if (cleanPhone) seenPhones.add(cleanPhone);
          profiles.push(p);
        }

        setSavedProfiles(profiles);
        setSavedCount(profiles.length);

        const links = new Set<string>();
        profiles.forEach(p => {
          if (p.link) links.add(normalizeLink(p.link));
        });
        setSavedLinksSet(links);
      }
    } catch (e) {
      console.warn("Failed to fetch saved profiles:", e);
    } finally {
      setLoadingSaved(false);
    }
  };

  useEffect(() => {
    fetchSavedProfiles();
  }, [savedStatusFilter, savedSourceFilter]);

  // Save autoSave preference
  useEffect(() => {
    try {
      localStorage.setItem('publi24_autosave', JSON.stringify(autoSaveEnabled));
    } catch {}
  }, [autoSaveEnabled]);

  const handleSaveListing = async (listing: Listing, customMessage?: string) => {
    try {
      const res = await fetch('/api/save-profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: listing })
      });
      if (res.ok) {
        const norm = normalizeLink(listing.link);
        const wasAlreadySaved = savedLinksSet.has(norm);
        setSavedLinksSet(prev => new Set([...prev, norm]));
        if (!wasAlreadySaved) {
          setSavedCount(prev => prev + 1);
        }
        setUpdateFeedback({
          id: listing.link,
          message: customMessage || 'Saved to archive!',
          type: 'success'
        });
        setTimeout(() => setUpdateFeedback(null), 3000);
        fetchSavedProfiles();
      }
    } catch (e) {
      console.warn("Failed to save listing:", e);
    }
  };

  const isProfileCompleteWithImageAndPhone = (item: Listing): boolean => {
    if (!item) return false;
    const hasImage = Boolean(
      (item.image && item.image.trim().length > 0) || 
      (item.images && item.images.length > 0)
    );
    const hasPhone = Boolean(
      (item.revealedPhone && /\d{4}/.test(item.revealedPhone) && !item.revealedPhone.includes("Not found") && !item.revealedPhone.includes("Error")) ||
      (item.phoneNumber && (item.phoneNumber.startsWith("07") || item.phoneNumber.startsWith("+40") || /0[237]\d{8}/.test(item.phoneNumber.replace(/\s/g, '')))) ||
      (item.phoneImage && item.phoneImage.length > 20)
    );
    return hasImage && hasPhone;
  };

  const autoSaveIfHasImageAndPhone = async (item: Listing) => {
    if (!item || !isProfileCompleteWithImageAndPhone(item)) return;
    try {
      const res = await fetch('/api/save-profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: item })
      });
      if (res.ok) {
        const norm = normalizeLink(item.link);
        setSavedLinksSet(prev => {
          if (prev.has(norm)) return prev;
          const next = new Set(prev);
          next.add(norm);
          return next;
        });
        const data = await res.json().catch(() => ({}));
        if (data.totalArchived) {
          setSavedCount(data.totalArchived);
        }
      }
    } catch (e) {
      console.warn("[AUTOSAVE] Error auto-saving item with image and phone:", e);
    }
  };

  const handleSaveAllListings = async () => {
    if (listings.length === 0) return;
    try {
      const res = await fetch('/api/save-profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profiles: listings })
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.totalArchived === 'number') {
          setSavedCount(data.totalArchived);
        }
        const newSet = new Set(savedLinksSet);
        listings.forEach(l => {
          if (l.link) newSet.add(normalizeLink(l.link));
        });
        setSavedLinksSet(newSet);
        setUpdateFeedback({
          id: 'all',
          message: `Saved all ${listings.length} listings to archive!`,
          type: 'success'
        });
        setTimeout(() => setUpdateFeedback(null), 3500);
        fetchSavedProfiles();
      }
    } catch (e) {
      console.warn("Failed to save all listings:", e);
    }
  };

  const handleUpdateProfileToLatest = async (profile: SavedProfile) => {
    setUpdatingProfileId(profile.id);
    try {
      const res = await fetch('/api/update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: profile.link, id: profile.id })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Update failed (Status ${res.status})`);
      }

      const data = await res.json();
      const updated: SavedProfile = {
        ...data.profile,
        currentImageIndex: 0
      };

      setSavedProfiles(prev => prev.map(p => (p.id === profile.id || normalizeLink(p.link) === normalizeLink(profile.link)) ? updated : p));

      const changesSummary = data.changes && data.changes.length > 0 
        ? data.changes.join(" • ") 
        : data.status === 'expired' 
          ? 'Ad is no longer active (expired)' 
          : 'Verified latest ad: All details are up to date';

      setUpdateFeedback({
        id: profile.id,
        message: changesSummary,
        type: data.status === 'expired' ? 'warning' : 'success'
      });
      setTimeout(() => setUpdateFeedback(null), 6000);
    } catch (err: any) {
      setUpdateFeedback({
        id: profile.id,
        message: `Error updating: ${err.message || 'Check connection'}`,
        type: 'warning'
      });
      setTimeout(() => setUpdateFeedback(null), 5000);
    } finally {
      setUpdatingProfileId(null);
    }
  };

  const handleDeleteSavedProfile = async (id: string) => {
    try {
      const res = await fetch(`/api/saved-profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok) {
        setSavedProfiles(prev => prev.filter(p => p.id !== id && normalizeLink(p.link) !== normalizeLink(id)));
        setSavedCount(prev => Math.max(0, prev - 1));
        const newSet = new Set(savedLinksSet);
        newSet.delete(normalizeLink(id));
        setSavedLinksSet(newSet);
      }
    } catch (e) {
      console.warn("Failed to delete saved profile:", e);
    }
  };

  const handleSaveProfileNote = async (id: string, notes: string) => {
    try {
      const res = await fetch('/api/update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, notes, onlyNotes: true })
      });
      if (res.ok) {
        setSavedProfiles(prev => prev.map(p => p.id === id ? { ...p, notes } : p));
      }
    } catch (e) {
      console.warn("Failed to save note:", e);
    }
  };

  const handleClearArchive = async () => {
    try {
      const res = await fetch('/api/saved-profiles', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearAll: true })
      });
      if (res.ok) {
        setSavedProfiles([]);
        setSavedCount(0);
        setSavedLinksSet(new Set());
      }
    } catch (e) {
      console.warn("Failed to clear archive:", e);
    }
  };

  const handleSearchPhoneLive = (phone: string) => {
    setActiveTab('scraper');
    setQuery(phone);
    setTimeout(() => {
      fetchListings(1);
    }, 100);
  };

  const handleNextSavedImage = (profileId: string) => {
    setSavedProfiles(prev => prev.map(p => {
      if (p.id === profileId && p.images && p.images.length > 1) {
        const next = ((p.currentImageIndex || 0) + 1) % p.images.length;
        return { ...p, currentImageIndex: next };
      }
      return p;
    }));
  };

  const handlePrevSavedImage = (profileId: string) => {
    setSavedProfiles(prev => prev.map(p => {
      if (p.id === profileId && p.images && p.images.length > 1) {
        const prevIdx = ((p.currentImageIndex || 0) - 1 + p.images.length) % p.images.length;
        return { ...p, currentImageIndex: prevIdx };
      }
      return p;
    }));
  };

  const fetchListings = async (pageNum: number) => {
    setIsEnhancing(false);
    setError(null);

    // If starting a fresh page 1 search, clear page cache
    if (pageNum === 1) {
      setPagesMap({});
    }

    // Check if pageNum is already cached in pagesMap (e.g. going back)
    if (pageNum > 1 && pagesMap[pageNum] && pagesMap[pageNum].length > 0) {
      setListings(pagesMap[pageNum]);
      setPage(pageNum);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    setLoading(true);
    setLoadingStatus('Initializing search...');

    try {
      let apiUrl = "";
      if (source === 'publi24') {
        setLoadingStatus(`Searching on Publi24 (${pageSize} results/page)...`);
        apiUrl = `/api/scrape?county=${county}&city=${encodeURIComponent(city.toLowerCase().replace(/\s+/g, '-'))}&page=${pageNum}&query=${encodeURIComponent(query)}&limit=${pageSize}`;
      } else if (source === 'bursaplacerilor') {
        setLoadingStatus(`Searching on Bursa Plăcerilor (${pageSize} results/page)...`);
        const sectorParam = (county === 'bucuresti' || city.toLowerCase().includes('sector')) ? `&sector=${encodeURIComponent(city.toLowerCase().replace(/\s+/g, '-'))}` : '';
        apiUrl = `/api/scrape-bursaplacerilor?county=${county}&city=${encodeURIComponent(city)}&page=${pageNum}&query=${encodeURIComponent(query)}&limit=${pageSize}${sectorParam}`;
      } else if (source === 'nimfomane') {
        setLoadingStatus('Searching on Nimfomane (this may take a moment)...');
        apiUrl = `/api/scrape-nimfomane?query=${encodeURIComponent(query)}&county=${county}&city=${city}&page=${pageNum}&limit=${pageSize}`;
      } else {
        setLoadingStatus('Searching on Inspector Escorte (bypassing rate limits)...');
        apiUrl = `/api/scrape-inspector?query=${encodeURIComponent(query)}&county=${county}&city=${city}&page=${pageNum}&limit=${pageSize}`;
      }

      const statusInterval = setInterval(() => {
        if (source === 'inspector') {
          setLoadingStatus(prev => {
            if (prev.includes('bypassing rate limits')) return 'Still searching... rotating domains...';
            if (prev.includes('rotating domains')) return 'Almost there... verifying results...';
            return prev;
          });
        }
      }, 15000);

      const response = await fetchWithTimeout(`${apiUrl}${apiUrl.includes('?') ? '&' : '?'}t=${Date.now()}`);
      if (!response.ok) {
        let errorMsg = `Failed to fetch listings (Status: ${response.status})`;
        try {
          const errorData = await response.json();
          errorMsg = errorData.error || errorMsg;
        } catch (e) {
          try {
            const text = await response.text();
            if (text) errorMsg = text.slice(0, 100);
          } catch (e2) {}
        }
        throw new Error(errorMsg);
      }
      const data = await response.json();
      console.log("[FRONTEND] Data received:", data.listings);
      
      const processedListings = (data.listings || []).map((l: any) => ({
        ...l,
        images: l.images && l.images.length > 0 ? l.images : (l.image ? [l.image] : []),
        currentImageIndex: 0,
        isDescriptionFetched: l.description && l.description.trim().length > 0 && !l.description.includes("Fără descriere")
      }));
      
      // Calculate all links and phones seen on ALL previous pages (1 .. pageNum - 1)
      const previousSeenLinks = new Set<string>();
      const previousSeenPhones = new Set<string>();
      if (pageNum > 1) {
        Object.keys(pagesMap).forEach(pKey => {
          const pNum = parseInt(pKey, 10);
          if (pNum < pageNum && pagesMap[pNum]) {
            pagesMap[pNum].forEach(item => {
              if (item.link) previousSeenLinks.add(normalizeLink(item.link));
              const phone = getNormalizedPhone(item);
              if (phone) previousSeenPhones.add(phone);
            });
          }
        });
      }

      // Strict Deduplication & Exclusion:
      // 1. Must NOT match any link or phone seen on previous pages
      // 2. Must be unique by link and phone within current page response
      // 3. Must not be an excluded category/profile (transexual, ts, trans, trasexuala, pentru femei / doamne)
      const currentSeenLinks = new Set<string>();
      const currentSeenPhones = new Set<string>();
      const uniqueListings: any[] = [];

      for (const item of processedListings) {
        if (!item || !item.link) continue;
        if (isExcludedListing(item)) continue;

        const norm = normalizeLink(item.link);
        const normPhone = getNormalizedPhone(item);

        if (previousSeenLinks.has(norm)) continue;
        if (normPhone && previousSeenPhones.has(normPhone)) continue;

        if (currentSeenLinks.has(norm)) continue;
        if (normPhone && currentSeenPhones.has(normPhone)) continue;

        currentSeenLinks.add(norm);
        if (normPhone) currentSeenPhones.add(normPhone);

        uniqueListings.push(item);
      }

      setPagesMap(prev => ({
        ...prev,
        [pageNum]: uniqueListings
      }));
      
      setListings(uniqueListings);
      setPage(pageNum);
      setTotalResults(typeof data.totalResults === 'number' ? data.totalResults : null);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      
      // If source is bursaplacerilor, trigger fast background batch enrichment for any listings missing full descriptions
      if (source === 'bursaplacerilor' && uniqueListings.length > 0) {
        const needDescriptions = uniqueListings
          .filter(l => !l.description || l.description.startsWith("Anunț publicat pe BursaPlacerilor.com"))
          .map(l => l.link)
          .filter(Boolean);

        if (needDescriptions.length > 0) {
          fetch('/api/enrich-bursa-descriptions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: needDescriptions })
          }).then(r => r.json()).then(res => {
            if (res.enriched && Object.keys(res.enriched).length > 0) {
              setListings(prev => prev.map(item => {
                const enr = res.enriched[item.link];
                if (enr) {
                  return {
                    ...item,
                    title: (enr.title && (!item.title || item.title.endsWith("...") || item.title.endsWith("…") || enr.title.length > item.title.length)) ? enr.title : item.title,
                    description: enr.desc || item.description,
                    images: enr.images && enr.images.length > 0 ? enr.images : item.images,
                    image: enr.images && enr.images.length > 0 ? enr.images[0] : item.image,
                    date: enr.date || item.date,
                    location: enr.location || item.location,
                    isDescriptionFetched: !!enr.desc
                  };
                }
                return item;
              }).filter(item => !isExcludedListing(item)));
            }
          }).catch(() => {});
        }
      }

      // Automatically enhance on the first scrape to get HD images, full descriptions, and phone numbers!
      if (uniqueListings.length > 0) {
        // Save profiles that have both an image and phone, or all if auto-save is enabled
        const completeListings = uniqueListings.filter(isProfileCompleteWithImageAndPhone);
        const toSave = autoSaveEnabled ? uniqueListings : completeListings;
        if (toSave.length > 0) {
          fetch('/api/save-profiles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profiles: toSave })
          }).then(r => r.json()).then(res => {
            if (res.totalArchived) setSavedCount(res.totalArchived);
            const newSet = new Set(savedLinksSet);
            toSave.forEach((l: any) => {
              if (l.link) newSet.add(normalizeLink(l.link));
            });
            setSavedLinksSet(newSet);
          }).catch(() => {});
        }
        setTimeout(() => {
          handleEnhanceListings();
        }, 300);
      }
    } catch (err: any) {
      setError(err.message || 'Could not connect to the scraper. Make sure the server is running.');
      console.warn("[FRONTEND] Error fetching listings:", err);
    } finally {
      setLoading(false);
      // @ts-ignore - statusInterval might not be defined in all paths but that's okay
      if (typeof statusInterval !== 'undefined') clearInterval(statusInterval);
    }
  };

  const handleEnhanceListings = async () => {
    setIsEnhancing(true);
    
    // Use the latest listings from state at the moment of start
    let currentListings: Listing[] = [];
    setListings(prev => {
      currentListings = [...prev];
      return prev;
    });

    // Wait a tick to ensure currentListings is populated if state update is weird
    if (currentListings.length === 0) {
      await new Promise(r => setTimeout(r, 100));
      setListings(prev => {
        currentListings = [...prev];
        return prev;
      });
    }

    const updatedListings = [...currentListings];
    
    // Process sequentially to avoid rate limiting and platform timeouts
    const batchSize = 1; 
    for (let i = 0; i < updatedListings.length; i += batchSize) {
      const batch = updatedListings.slice(i, i + batchSize);
      
      // Add a delay between requests to match server-side gaps
      if (i > 0) await new Promise(r => setTimeout(r, 2700));
      
      await Promise.all(batch.map(async (item, idx) => {
        const globalIdx = i + idx;
        
        // Double check if item still exists in active listings to handle page changes gracefully
        let stillExists = false;
        setListings(prev => {
          stillExists = prev.some(l => l.link === item.link);
          return prev;
        });
        if (!stillExists) return;

        // Always enhance if we don't have multiple images yet or if description is missing
        if (!item.images || item.images.length <= 1 || !item.isDescriptionFetched) {
          try {
            let res = await fetchWithTimeout(`/api/listing-detail?url=${encodeURIComponent(item.link)}`);
            
            // Simple retry logic for 403/500 errors
            if (!res.ok && (res.status === 403 || res.status === 500 || res.status === 503)) {
              await new Promise(r => setTimeout(r, 2000));
              res = await fetchWithTimeout(`/api/listing-detail?url=${encodeURIComponent(item.link)}`);
            }

            if (res.ok) {
              let data: any = null;
              try {
                data = await res.json();
              } catch (jsonErr: any) {
                console.warn(`[BACKGROUND ENHANCE] JSON parse failed for detail ${item.link}:`, jsonErr.message || jsonErr);
                return;
              }

              if (!data) return;
              const images = data.images || [data.image || item.image];
              
              // Set default image to 2nd (index 1) if available
              let defaultIdx = 0;
              if (images.length >= 2) defaultIdx = 1;

              // Also fetch phone number automatically
              let phone = data.phone || item.revealedPhone;
              let phoneImage = data.phoneImage || item.phoneImage;
              
              if (!phone && !phoneImage) {
                try {
                  let phoneRes = await fetchWithTimeout(`/api/phone?url=${encodeURIComponent(item.link)}&id=${item.adId || ''}`);
                  
                  // Simple retry logic for 403/500 errors
                  if (!phoneRes.ok && (phoneRes.status === 403 || phoneRes.status === 500 || phoneRes.status === 503)) {
                    await new Promise(r => setTimeout(r, 2000));
                    phoneRes = await fetchWithTimeout(`/api/phone?url=${encodeURIComponent(item.link)}&id=${item.adId || ''}`);
                  }

                  if (phoneRes.ok) {
                    try {
                      const phoneData = await phoneRes.json();
                      if (phoneData) {
                        phone = phoneData.phone;
                        phoneImage = phoneData.phoneImage;
                      }
                    } catch (pJsonErr: any) {
                      console.warn(`[BACKGROUND ENHANCE] JSON parse failed for phoneRes:`, pJsonErr.message);
                    }
                  }
                } catch (e: any) {
                  console.warn("[BACKGROUND ENHANCE] Auto-reveal phone fallback issue:", e.message || e);
                }
              }

              // If we got an image, try to OCR it immediately for "first try" retrieval
              if (phoneImage && (!phone || phone === "Not found" || phone === "Image found")) {
                const ocrResult = await performOCR(phoneImage);
                if (ocrResult && !ocrResult.includes("Error") && ocrResult !== "None") {
                  phone = ocrResult;
                }
              }

              // Update state using functional update to avoid missing intermediate changes
              setListings(prev => {
                const newListings = [...prev];
                // Find current index of this item because the list might have changed shifted
                const currentIdx = newListings.findIndex(l => l.link === item.link);
                if (currentIdx !== -1) {
                  const enhancedListing = { 
                    ...newListings[currentIdx], 
                    title: (data.title && data.title !== "Anunț" && !data.title.includes("Anunț expirat") && (!item.title || item.title === "Anunț" || data.title.length >= item.title.replace(/(\.\.\.|…)$/, "").trim().length)) ? data.title : item.title,
                    image: data.image || item.image,
                    images: images,
                    currentImageIndex: defaultIdx,
                    description: data.description || item.description,
                    isDescriptionFetched: true,
                    revealedPhone: phone,
                    phoneImage: phoneImage
                  };
                  newListings[currentIdx] = enhancedListing;
                  autoSaveIfHasImageAndPhone(enhancedListing);
                }
                return newListings;
              });
            }
          } catch (e: any) {
            console.warn("[BACKGROUND ENHANCE] Skip enhancement for item:", e.message || e);
          }
        }
      }));
    }
    setIsEnhancing(false);
  };

  const handleSearch = () => {
    if ((source === 'nimfomane' || source === 'inspector') && !query.trim()) {
      setError(`Please enter at least one keyword to search on ${source === 'nimfomane' ? 'Nimfomane.com' : 'Inspector-Escorte.com'}`);
      return;
    }
    fetchListings(1);
  };

  const handleResetScraper = async () => {
    try {
      setLoading(true);
      setLoadingStatus('Resetting scraper cache...');
      await fetch('/api/reset-scraper', { method: 'POST' });
      setLoadingStatus('Cache cleared! Ready to search.');
      setTimeout(() => setLoading(false), 1000);
    } catch (e) {
      console.warn("Failed to reset scraper", e);
      setLoading(false);
    }
  };

  const handleNextPage = () => {
    fetchListings(page + 1);
  };

  const handlePrevPage = () => {
    if (page > 1) fetchListings(page - 1);
  };

  const handleFetchDetails = async (listing: Listing, index: number) => {
    const newListings = [...listings];
    newListings[index] = { ...listing, isRevealing: true };
    setListings(newListings);

    try {
      let response = await fetchWithTimeout(`/api/listing-detail?url=${encodeURIComponent(listing.link)}`);
      
      // Simple retry logic for 403/500 errors
      if (!response.ok && (response.status === 403 || response.status === 500 || response.status === 503)) {
        console.log("[FRONTEND] Detail fetch failed, retrying in 2s...");
        await new Promise(r => setTimeout(r, 2000));
        response = await fetchWithTimeout(`/api/listing-detail?url=${encodeURIComponent(listing.link)}`);
      }

      if (!response.ok) {
        let errorMsg = `Failed to fetch details (Status: ${response.status})`;
        try {
          const errorData = await response.json();
          errorMsg = errorData.error || errorMsg;
        } catch (e) {}
        throw new Error(errorMsg);
      }
      
      const data = await response.json();
      
      newListings[index] = { 
        ...listing, 
        image: data.image || listing.image, 
        images: data.images || [data.image || listing.image],
        currentImageIndex: (data.images && data.images.length >= 2) ? 1 : 0,
        description: data.description || listing.description,
        isRevealing: false,
        isDescriptionFetched: true
      };
      setListings(newListings);
    } catch (err) {
      console.warn("[FRONTEND] Error fetching details:", err);
      newListings[index] = { ...listing, isRevealing: false };
      setListings(newListings);
    }
  };

  const handleGeminiError = async (err: any) => {
    const errorMsg = typeof err === 'string' ? err : (err.message || JSON.stringify(err));
    console.warn("Gemini API Proxy Issue (non-fatal):", errorMsg);
    return false;
  };

  const handleDeepScan = async (listing: Listing, index: number) => {
    const newListings = [...listings];
    newListings[newListings.findIndex(l => l.id === listing.id)] = { ...listing, isRevealing: true, isDeepScanning: true };
    setListings(newListings);

    try {
      // Use listing-detail to get full images and description along with pageText
      let response = await fetchWithTimeout(`/api/listing-detail?url=${encodeURIComponent(listing.link)}`);
      
      if (!response.ok && (response.status === 403 || response.status === 500 || response.status === 503)) {
        console.log("[FRONTEND] Deep scan fetch failed, retrying in 2s...");
        await new Promise(r => setTimeout(r, 2000));
        response = await fetchWithTimeout(`/api/listing-detail?url=${encodeURIComponent(listing.link)}`);
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to fetch page content (Status: ${response.status})`);
      }
      
      const data = await response.json();
      const pageText = data.pageText;
      const fullImages = data.images || [data.image || listing.image];
      const fullDescription = data.description || listing.description;

      if (!pageText) throw new Error('No text content found');

      // 1. Try local regex first (fast and free)
      const romanianPhoneRegex = /(?:(?:\+|00)40|0)7\d{2}[\s.-]?\d{3}[\s.-]?\d{3}/g;
      const matches = pageText.match(romanianPhoneRegex);
      if (matches && matches.length > 0) {
        const validatedPhone = cleanAndValidatePhone(matches[0], pageText);
        if (validatedPhone && validatedPhone !== "Not found") {
          console.log("[FRONTEND] Found phone via local regex in deep scan:", validatedPhone);
          
          const updatedListings = [...listings];
          const lIdx = updatedListings.findIndex(l => l.id === listing.id);
          updatedListings[lIdx] = { 
            ...listing, 
            revealedPhone: validatedPhone, 
            description: fullDescription,
            images: fullImages,
            currentImageIndex: (fullImages.length > 1) ? 1 : 0,
            isRevealing: false,
            isDeepScanning: false,
            isDescriptionFetched: true
          };
          setListings(updatedListings);
          return;
        }
      }

      // 2. Fallback to Gemini for complex cases
      const prompt = `Extract the following information from this Romanian classified ad text:
1. Phone number (digits only, e.g. 0722123456). Return 'None' if not found.
2. A clean description of the ad (remove HTML, keep original Romanian text).

Return the result as a JSON object:
{
  "phone": "digits or None",
  "description": "clean text"
}

TEXT:
${pageText.slice(0, 5000)}`;
      
      const responseG = await fetchWithTimeout("/api/content-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt })
      });

      if (!responseG.ok) {
        const errData = await responseG.json().catch(() => ({}));
        throw new Error(errData.error || `Failed to analyze page text (Status: ${responseG.status})`);
      }

      const dataG = await responseG.json();
      const text = dataG.text?.trim() || "";
      let extractedData = { phone: "None", description: "" };
      try {
        // Try to parse JSON if Gemini returned it
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          extractedData = JSON.parse(jsonMatch[0]);
        } else {
          // Fallback if not JSON
          extractedData.phone = text;
        }
      } catch (e) {
        console.warn("Failed to parse Gemini JSON, using raw text");
        extractedData.phone = text;
      }

      let phone = cleanAndValidatePhone(extractedData.phone, text);

      if (phone === "Not found" && listing.image) {
        console.log("[FRONTEND] Deep Scan found no phone in text, trying image scan...");
        await handleScanImage(listing, index);
        return;
      }

      setListings(prev => {
        const newListings = [...prev];
        const lIdx = newListings.findIndex(l => l.link === listing.link);
        if (lIdx !== -1) {
          const updatedItem = { 
            ...newListings[lIdx], 
            revealedPhone: phone || "Not found", 
            description: extractedData.description || fullDescription,
            images: fullImages,
            currentImageIndex: (fullImages.length > 1) ? 1 : 0,
            isRevealing: false,
            isDeepScanning: false,
            isDescriptionFetched: true
          };
          newListings[lIdx] = updatedItem;
          autoSaveIfHasImageAndPhone(updatedItem);
        }
        return newListings;
      });
    } catch (err: any) {
      console.warn("Deep Scan issue:", err);
      const handled = await handleGeminiError(err);
      setListings(prev => {
        const newListings = [...prev];
        const lIdx = newListings.findIndex(l => l.link === listing.link);
        if (lIdx !== -1) {
          newListings[lIdx] = { 
            ...newListings[lIdx], 
            isRevealing: false, 
            isDeepScanning: false,
            revealedPhone: handled ? "API key error. Please try again." : `Error: ${err.message || 'Deep scan failed'}`
          };
        }
        return newListings;
      });
    }
  };

  const handleCopyJson = async (item: Listing) => {
    let enrichedItem: Listing = { ...item };

    const currentTitle = (item.title || "").trim();
    const currentDesc = (item.description || "").trim();
    const applyDetailToItem = (detail: any) => {
      const detailTitle = (detail.title || "").trim();
      const detailDesc = (detail.description || "").trim();

      const cleanBaseCurrentTitle = currentTitle.replace(/(\.\.\.|…)$/, "").trim();
      if (
        detailTitle &&
        detailTitle !== "Anunț" &&
        !detailTitle.includes("Anunț expirat") &&
        (!currentTitle || currentTitle === "Anunț" || detailTitle.length >= cleanBaseCurrentTitle.length)
      ) {
        enrichedItem.title = detailTitle;
      }

      if (
        detailDesc &&
        !detailDesc.includes("No detailed description found") &&
        !detailDesc.includes("Anunțul nu mai este activ") &&
        (!currentDesc ||
          currentDesc.endsWith("...") ||
          currentDesc.endsWith("…") ||
          currentDesc.includes("publicat pe BursaPlacerilor") ||
          currentDesc.includes("No detailed description found") ||
          detailDesc.length >= currentDesc.replace(/(\.\.\.|…)$/, "").length)
      ) {
        enrichedItem.description = detailDesc;
      }

      if (detail.images && Array.isArray(detail.images) && detail.images.length > (enrichedItem.images?.length || 0)) {
        enrichedItem.images = detail.images;
        if (!enrichedItem.image) enrichedItem.image = detail.image || detail.images[0];
      }
      if (detail.location && (!enrichedItem.location || enrichedItem.location === "România" || enrichedItem.location === "Locație nespecificată")) {
        enrichedItem.location = detail.location;
      }
      if (detail.date && !enrichedItem.date) {
        enrichedItem.date = detail.date;
      }
      if (detail.phone && (!enrichedItem.revealedPhone || enrichedItem.revealedPhone === "Not found")) {
        enrichedItem.revealedPhone = String(detail.phone).replace(/\s+/g, '');
      }
      enrichedItem.isDescriptionFetched = true;
    };

    if (item.link) {
      const cachedDetail = verifiedCopyDetailsRef.current.get(item.link);
      if (cachedDetail) {
        applyDetailToItem(cachedDetail);
        setListings(prev => prev.map(l => (l.link === item.link ? { ...l, ...enrichedItem } : l)));
      } else {
        setCopyingJsonId(item.id);
        try {
          const res = await fetchWithTimeout(`/api/listing-detail?url=${encodeURIComponent(item.link)}`, { timeout: 20000 });
          if (res.ok) {
            const detail = await res.json();
            verifiedCopyDetailsRef.current.set(item.link, detail);
            applyDetailToItem(detail);
            // Update card in current listings state so UI matches copied JSON
            setListings(prev => prev.map(l => (l.link === item.link ? { ...l, ...enrichedItem } : l)));
          }
        } catch (err) {
          console.warn("Failed to fetch full listing details before copying JSON:", err);
        } finally {
          setCopyingJsonId(null);
        }
      }
    }

    // Deduplicate location just in case it's still doubled in state
    let cleanLocation = enrichedItem.location;
    if (cleanLocation) {
      // Check for glued repetition like "Timisoara, TimisTimisoara, Timis"
      const mid = Math.floor(cleanLocation.length / 2);
      for (let i = mid - 2; i <= mid + 2; i++) {
        if (i <= 0) continue;
        const first = cleanLocation.slice(0, i).trim();
        const second = cleanLocation.slice(i).trim();
        if (first === second) {
          cleanLocation = first;
          break;
        }
      }

      const parts = cleanLocation.split(/[,|\s-]+/).map(p => p.trim()).filter(p => p.length > 0);
      const uniqueParts = Array.from(new Set(parts));
      if (uniqueParts.length < parts.length) {
        cleanLocation = uniqueParts.join(", ");
      }
    }

    // Combine all unique images with absolute deduplication and size normalization
    const normalizeImgUrl = (url: string) => {
      if (!url) return "";
      let u = url.trim().replace(/\\/g, "");
      if (u.startsWith("//")) u = "https:" + u;
      if (u.startsWith("http://")) u = u.replace("http://", "https://");
      // Normalize Publi24 / inspector thumbnails to large full-sized images
      if (u.includes("publi24.ro") || u.includes("inspector")) {
        u = u.replace(/\/(medium|small|t)\//gi, "/large/");
      }
      return u;
    };

    const cleanMainImage = enrichedItem.image ? normalizeImgUrl(enrichedItem.image) : "";
    const uniqueImagesMap = new Map<string, string>();
    const allRawImages = [
      ...(enrichedItem.image ? [enrichedItem.image] : []),
      ...(enrichedItem.images || [])
    ].filter(Boolean);

    allRawImages.forEach(img => {
      const norm = normalizeImgUrl(img);
      if (norm && !uniqueImagesMap.has(norm)) {
        uniqueImagesMap.set(norm, norm);
      }
    });
    const allImages = Array.from(uniqueImagesMap.keys());

    // Absolute proxy URL generator
    const getAbsoluteProxyUrl = (url: string) => {
      if (!url) return "";
      if (url.startsWith("data:")) return url; // Don't proxy base64 data
      return `${window.location.origin}/api/proxy-image?url=${encodeURIComponent(url)}`;
    };

    const dataToCopy = {
      title: enrichedItem.title,
      description: enrichedItem.description || "",
      image: cleanMainImage,
      images: allImages,
      proxy_image: cleanMainImage ? getAbsoluteProxyUrl(cleanMainImage) : "",
      proxy_images: allImages.map(img => getAbsoluteProxyUrl(img)),
      location: cleanLocation,
      phone: (enrichedItem.revealedPhone || enrichedItem.phoneNumber || "").replace(/\s+/g, '') || null,
      phoneImage: enrichedItem.phoneImage || null,
      source: enrichedItem.source,
      link: enrichedItem.link,
      author: enrichedItem.author || enrichedItem.title, // Use title as author if null
      date: enrichedItem.date || null,
      extractedAt: new Date().toISOString()
    };
    await copyToClipboard(JSON.stringify(dataToCopy, null, 2), `json-${enrichedItem.id}`);
    
    // Auto-save to persistent archive whenever user copies JSON
    handleSaveListing(enrichedItem, 'Copied JSON & Saved to Archive!');
  };

  const handleShowPhone = async (listing: Listing, index: number) => {
    // Allow if no phone yet, or if it's just an image/error/not found
    const hasNumber = listing.revealedPhone && /\d/.test(listing.revealedPhone) && !listing.revealedPhone.includes("Error");
    if (hasNumber && !listing.phoneImage) return; 
    // If we have an image but no number yet, we want to allow scanning
    if (hasNumber && listing.phoneImage && !listing.isScanningImage) return;

    const newListings = [...listings];
    newListings[index] = { ...listing, isRevealing: true, revealedPhone: undefined };
    setListings(newListings);

    // 1. Try local regex on existing description first (fast and free)
    if (listing.description) {
      const romanianPhoneRegex = /(?:(?:\+|00)40|0)7\d{2}[\s.-]?\d{3}[\s.-]?\d{3}/g;
      const matches = listing.description.match(romanianPhoneRegex);
      if (matches && matches.length > 0) {
        const validatedPhone = cleanAndValidatePhone(matches[0], listing.description);
        if (validatedPhone && validatedPhone !== "Not found") {
          console.log("[FRONTEND] Found phone via local regex in existing description:", validatedPhone);
          const updatedListings = [...listings];
          const updatedItem = { 
            ...listing, 
            revealedPhone: validatedPhone, 
            isRevealing: false 
          };
          updatedListings[index] = updatedItem;
          setListings(updatedListings);
          autoSaveIfHasImageAndPhone(updatedItem);
          return;
        }
      }
    }

    if (listing.phoneImage) {
      console.log("[FRONTEND] Phone image already present, scanning...");
      await handleScanBase64Image(listing.phoneImage, listing, index);
      return;
    }

    try {
      console.log(`[FRONTEND] Revealing phone for: ${listing.link} (adId: ${listing.adId})`);
      
      let response = await fetchWithTimeout(`/api/phone?url=${encodeURIComponent(listing.link)}&id=${listing.adId || ''}`);
      
      // Simple retry logic for 403/500 errors
      if (!response.ok && (response.status === 403 || response.status === 500 || response.status === 503)) {
        console.log("[FRONTEND] Phone fetch failed, retrying in 2s...");
        await new Promise(r => setTimeout(r, 2000));
        response = await fetchWithTimeout(`/api/phone?url=${encodeURIComponent(listing.link)}&id=${listing.adId || ''}`);
      }

      if (!response.ok) {
        let errorMsg = `Failed to fetch phone (Status: ${response.status})`;
        try {
          const errorData = await response.json();
          errorMsg = errorData.error || errorMsg;
        } catch (e) {}
        throw new Error(errorMsg);
      }
      
      const data = await response.json();
      
      let phone = data.phone ? cleanAndValidatePhone(data.phone).replace(/\s+/g, '') : "Not found";
      const phoneImage = data.phoneImage;

      // If we got a base64 image for the phone, scan it
      if (phoneImage) {
        console.log("[FRONTEND] Found phone image, scanning...");
        // Update state with the image first so it's visible while scanning
        const intermediateListings = [...listings];
        intermediateListings[index] = { ...listing, phoneImage, isRevealing: true, isScanningImage: true };
        setListings(intermediateListings);
        await handleScanBase64Image(phoneImage, listing, index);
        return;
      }

      // If phone is not found or protected, try to scan the main listing image if it exists
      if ((phone === "Not found" || phone.includes("Protected") || phone.includes("Image found")) && listing.image) {
        console.log("[FRONTEND] Phone not found in text/direct image, trying deep scan...");
        await handleDeepScan(listing, index);
        return;
      }

      const updatedListings = [...listings];
      const updatedItem = { 
        ...listing, 
        revealedPhone: phone, 
        phoneImage: phoneImage,
        isRevealing: false 
      };
      updatedListings[index] = updatedItem;
      setListings(updatedListings);
      autoSaveIfHasImageAndPhone(updatedItem);
    } catch (err: any) {
      console.warn("[FRONTEND] Show Phone issue:", err);
      const updatedListings = [...listings];
      updatedListings[index] = { 
        ...listing, 
        isRevealing: false, 
        revealedPhone: `Error: ${err.message || 'Failed fetching'}`
      };
      setListings(updatedListings);
    }
  };

  const performOCR = async (base64Url: string): Promise<string> => {
    try {
      const cleanBase64 = await ensureWhiteBackgroundForBase64(base64Url);
      // Extract mime type and raw data
      const mimeTypeMatch = cleanBase64.match(/^data:([^;]+);base64,/);
      const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : 'image/jpeg';
      const rawBase64Data = cleanBase64.includes(',') ? cleanBase64.split(',')[1] : cleanBase64;
      
      // Pass raw base64 data directly to bypass slow image enhancement as per user request
      const base64Data = rawBase64Data;

      const prompt = `This image contains a phone number from a Romanian classified ad on the website Publi24. 
The number is usually in a format like 07xx xxx xxx. 
Carefully extract the digits. 
Sometimes the background is noisy, or there is a watermark of the website logo 'Publi24'.
CRITICAL: Do NOT extract 'Publi24' or parts of the brand name as the phone number. Do not return repetitive placeholder digits like '24 24 24' or '242424' or numbers starting with '0724 242 424' unless it is unmistakably the actual unique ad phone number printed in the image.
If you see characters that look like digits but are letters (e.g., 'O' for '0', 'l' for '1', 'S' for '5', 'G' for '6', 'B' for '8'), interpret them as the most likely digit. 
Return ONLY the 10 digits of the phone number. 
If you are absolutely sure there is no phone number, return 'None'.`;
      
      const response = await fetchWithTimeout("/api/content-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          base64Data,
          mimeType,
          isMultimodal: true
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Failed to perform OCR (Status: ${response.status})`);
      }

      const data = await response.json();
      const text = data.text?.trim() || "";
      return cleanAndValidatePhone(text, text).replace(/\s+/g, '');
    } catch (err: any) {
      console.warn("OCR issue:", err);
      const handled = await handleGeminiError(err);
      return handled ? "Retry with new key" : `Error: ${err.message || 'Scan failed'}`;
    }
  };

  const handleScanBase64Image = async (base64Url: string, listing: Listing, index: number) => {
    const newListings = [...listings];
    newListings[index] = { ...listing, isScanningImage: true, isRevealing: true };
    setListings(newListings);

    try {
      const phone = await performOCR(base64Url);
      const updatedListings = [...listings];
      const updatedItem = { 
        ...listing, 
        revealedPhone: phone, 
        phoneImage: base64Url,
        isRevealing: false,
        isScanningImage: false 
      };
      updatedListings[index] = updatedItem;
      setListings(updatedListings);
      autoSaveIfHasImageAndPhone(updatedItem);
    } catch (err: any) {
      const updatedListings = [...listings];
      updatedListings[index] = { 
        ...listing, 
        revealedPhone: `Error: ${err.message || 'Scan failed'}`, 
        phoneImage: base64Url,
        isRevealing: false,
        isScanningImage: false 
      };
      setListings(updatedListings);
    }
  };

  const handleScanImage = async (listing: Listing, index: number) => {
    const currentImage = listing.images && listing.images.length > 0 
      ? listing.images[listing.currentImageIndex || 0] 
      : listing.image;
    if (!currentImage) return;

    const newListings = [...listings];
    newListings[index] = { ...listing, isScanningImage: true, isRevealing: true };
    setListings(newListings);

    try {
      // Fetch the image and convert to base64 via proxy
      const imgRes = await fetchWithTimeout(`/api/proxy-image?url=${encodeURIComponent(currentImage)}`);
      const blob = await imgRes.blob();
      const reader = new FileReader();
      
      const base64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => {
          const base64 = reader.result as string;
          resolve(base64.split(',')[1]);
        };
      });
      reader.readAsDataURL(blob);
      const rawBase64Data = await base64Promise;
      
      // Pass raw base64 data directly to bypass slow image enhancement as per user request
      const base64Data = rawBase64Data;

      const prompt = `This is an image from a Romanian classified ad. 
Extract any phone number visible in this image (often watermarked, written in large text, or hidden in the background). 
Look for Romanian formats (starting with 07, 02, 03, or +40). 
If you find multiple, return the most prominent one. 
Return ONLY the digits (e.g. 0722123456). 
If none found, return 'None'.`;
      
      const responseG = await fetchWithTimeout("/api/content-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          base64Data,
          mimeType: blob.type,
          isMultimodal: true
        })
      });

      if (!responseG.ok) {
        const errData = await responseG.json().catch(() => ({}));
        throw new Error(errData.error || `Failed to perform OCR on listing image (Status: ${responseG.status})`);
      }

      const dataG = await responseG.json();
      const text = dataG.text?.trim() || "None";
      const phone = cleanAndValidatePhone(text, text).replace(/\s+/g, '');

      const updatedListings = [...listings];
      const updatedItem = { 
        ...listing, 
        revealedPhone: phone, 
        isRevealing: false,
        isScanningImage: false 
      };
      updatedListings[index] = updatedItem;
      setListings(updatedListings);
      autoSaveIfHasImageAndPhone(updatedItem);
    } catch (err: any) {
      console.warn("OCR issue:", err);
      await handleGeminiError(err);
      const updatedListings = [...listings];
      updatedListings[index] = { 
        ...listing, 
        revealedPhone: `Error: ${err.message || 'Scan failed'}`, 
        isRevealing: false,
        isScanningImage: false 
      };
      setListings(updatedListings);
    }
  };

  const [manualOcrImage, setManualOcrImage] = useState<string | null>(null);
  const [manualOcrResult, setManualOcrResult] = useState<string | null>(null);
  const [isManualScanning, setIsManualScanning] = useState(false);

  const handleManualImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setManualOcrImage(reader.result as string);
        setManualOcrResult(null);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleManualScan = async () => {
    if (!manualOcrImage) return;
    setIsManualScanning(true);
    try {
      const digits = await extractDigitsFromBase64Image(manualOcrImage);
      setManualOcrResult(digits);
    } catch (err: any) {
      setManualOcrResult(`Error: ${err.message}`);
    } finally {
      setIsManualScanning(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-emerald-500/30">
      {isServerOnline === false && (
        <div className="relative z-50 bg-amber-500/10 border-b border-amber-500/20 py-3 px-4 text-center text-sm text-amber-300 flex items-center justify-center gap-2 font-medium backdrop-blur-md">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
          </span>
          <span>Scraper runner service is temporarily starting or offline. Retrying...</span>
        </div>
      )}
      {/* Hero Section */}
      <header className="relative h-[40vh] flex flex-col items-center justify-center overflow-hidden border-b border-white/10">
        <div className="absolute inset-0 z-0">
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[#0a0a0a] z-10" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-emerald-500/10 via-transparent to-transparent opacity-60" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--tw-gradient-stops))] from-cyan-500/5 via-[#0a0a0a] to-[#0a0a0a] opacity-80" />
        </div>
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative z-20 text-center px-4"
        >
          <h1 className="text-5xl md:text-7xl font-bold tracking-tighter mb-4 bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 to-cyan-400">
            PUBLI24 SCRAPER
          </h1>
          <p className="text-white/60 text-lg md:text-xl max-w-2xl mx-auto font-light">
            Real-time extraction of listings with <span className="text-emerald-400 font-medium">advanced</span> filtering.
          </p>

          {/* Mode Switcher Tabs */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={() => handleSetActiveTab('crawler')}
              className={`flex items-center gap-2.5 px-6 py-3.5 rounded-2xl font-black text-xs sm:text-sm tracking-wide transition-all cursor-pointer relative ${
                activeTab === 'crawler'
                  ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-500/30 scale-105 border-2 border-emerald-400'
                  : 'bg-emerald-950/40 hover:bg-emerald-900/50 text-emerald-300 border border-emerald-500/30'
              }`}
            >
              <Activity className={`w-4 h-4 ${crawlerState?.status === 'running' ? 'animate-pulse' : ''}`} />
              <span>WEEKLY AUTO-CRAWLER</span>
              {crawlerState?.status === 'running' ? (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-black bg-black text-emerald-400 animate-pulse">
                  PAG. {crawlerState?.currentPage || 1}
                </span>
              ) : (
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-black ${
                  activeTab === 'crawler' ? 'bg-black/30 text-black' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                }`}>
                  7 ZILE
                </span>
              )}
            </button>

            <button
              onClick={() => handleSetActiveTab('scraper')}
              className={`flex items-center gap-2.5 px-6 py-3.5 rounded-2xl font-black text-xs sm:text-sm tracking-wide transition-all cursor-pointer ${
                activeTab === 'scraper'
                  ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-500/25 scale-105'
                  : 'bg-white/5 hover:bg-white/10 text-white/70 hover:text-white border border-white/10'
              }`}
            >
              <Search className="w-4 h-4" />
              <span>LIVE SCRAPER</span>
            </button>

            <button
              onClick={() => {
                handleSetActiveTab('saved');
                fetchSavedProfiles();
              }}
              className={`flex items-center gap-2.5 px-6 py-3.5 rounded-2xl font-black text-xs sm:text-sm tracking-wide transition-all cursor-pointer relative ${
                activeTab === 'saved'
                  ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-500/25 scale-105'
                  : 'bg-white/5 hover:bg-white/10 text-white/70 hover:text-white border border-white/10'
              }`}
            >
              <Database className="w-4 h-4" />
              <span>BAZĂ DE DATE & SALVATE</span>
              <span className={`text-xs px-2.5 py-0.5 rounded-full font-black ${
                activeTab === 'saved' ? 'bg-black/30 text-black' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
              }`}>
                {savedCount} / 5.000
              </span>
            </button>
          </div>
        </motion.div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-12 -mt-16 relative z-30">
        {activeTab === 'crawler' ? (
          <BursaCrawlerView
            crawlerState={crawlerState}
            crawlerActionLoading={crawlerActionLoading}
            onStartCrawler={handleStartCrawler}
            onPauseCrawler={handlePauseCrawler}
            onResumeCrawler={handleResumeCrawler}
            onToggleCrawler={handleToggleCrawler}
            onClearLogs={handleClearCrawlerLogs}
            onRefresh={() => {
              fetchCrawlerStatus();
              fetchSavedProfiles();
            }}
            onGoToDatabase={() => {
              handleSetActiveTab('saved');
              fetchSavedProfiles();
            }}
            savedCount={savedCount}
          />
        ) : activeTab === 'saved' ? (
          <SavedProfilesView
            savedProfiles={savedProfiles}
            savedCount={savedCount}
            loadingSaved={loadingSaved}
            phoneSearchQuery={phoneSearchQuery}
            setPhoneSearchQuery={(q) => {
              setPhoneSearchQuery(q);
              fetchSavedProfiles(q, savedTextQuery);
            }}
            savedTextQuery={savedTextQuery}
            setSavedTextQuery={(q) => {
              setSavedTextQuery(q);
              fetchSavedProfiles(phoneSearchQuery, q);
            }}
            savedStatusFilter={savedStatusFilter}
            setSavedStatusFilter={setSavedStatusFilter}
            savedSourceFilter={savedSourceFilter}
            setSavedSourceFilter={setSavedSourceFilter}
            updatingProfileId={updatingProfileId}
            updateFeedback={updateFeedback}
            onRefresh={() => fetchSavedProfiles()}
            onUpdateProfile={handleUpdateProfileToLatest}
            onDeleteProfile={handleDeleteSavedProfile}
            onSaveNote={handleSaveProfileNote}
            onSearchPhoneLive={handleSearchPhoneLive}
            onClearArchive={handleClearArchive}
            onNextImage={handleNextSavedImage}
            onPrevImage={handlePrevSavedImage}
            onDownloadImage={downloadImage}
          />
        ) : (
          <>
            {/* Quick Auto-Crawler Status Pill Banner on Scraper View */}
            <div className="mb-6 p-4 rounded-2xl bg-emerald-950/40 border border-emerald-500/30 backdrop-blur-md flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-lg">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-emerald-500/20 text-emerald-400">
                  <Activity className={`w-4 h-4 ${crawlerState?.status === 'running' ? 'animate-pulse' : ''}`} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-black text-white">Auto-Crawler Săptămânal Bursa:</span>
                    {crawlerState?.status === 'running' ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-400 text-black animate-pulse">
                        Scanare în curs (Pag. {crawlerState?.currentPage || 1})
                      </span>
                    ) : crawlerState?.enabled ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                        Programat la 7 Zile
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-white/10 text-white/50">
                        Dezactivat
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-white/50">
                    Bază de date: <strong className="text-white">{savedCount}</strong> / 5.000 anunțuri • 1 telefon unic per profil • 0 trans/ts
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 self-stretch sm:self-auto justify-end">
                <button
                  onClick={() => handleSetActiveTab('crawler')}
                  className="px-3.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs transition-all cursor-pointer shadow-md shadow-emerald-500/20"
                >
                  Deschide Opțiuni Săptămânale
                </button>
              </div>
            </div>

            {/* Controls */}
            <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-6 mb-12 shadow-2xl space-y-6">
              {/* Source Switcher & Results per page bar */}
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-white/10">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] uppercase tracking-widest text-white/40 font-bold mr-1">SURSA:</span>
                  
                  {/* Publi24 */}
                  <button
                    onClick={() => setSource('publi24')}
                    className={`px-3.5 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-1.5 cursor-pointer ${
                      source === 'publi24'
                        ? 'bg-[#f36f21] text-white shadow-lg shadow-orange-500/30 scale-105 border border-amber-300/40'
                        : 'bg-white/5 hover:bg-white/10 text-white/70 border border-white/10'
                    }`}
                  >
                    <span>⚡ PUBLI24</span>
                  </button>

                  {/* Bursa Plăcerilor */}
                  <button
                    onClick={() => setSource('bursaplacerilor')}
                    className={`px-3.5 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-1.5 cursor-pointer ${
                      source === 'bursaplacerilor'
                        ? 'bg-[#e8302a] text-white shadow-lg shadow-red-600/40 scale-105 border border-red-300/40'
                        : 'bg-white/5 hover:bg-white/10 text-white/70 border border-white/10'
                    }`}
                  >
                    <span>🔥 BURSA PLĂCERILOR</span>
                  </button>

                  {/* Inspector Escorte */}
                  <button
                    onClick={() => setSource('inspector')}
                    className={`px-3.5 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-1.5 cursor-pointer ${
                      source === 'inspector'
                        ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/30 scale-105 border border-purple-300/40'
                        : 'bg-white/5 hover:bg-white/10 text-white/70 border border-white/10'
                    }`}
                  >
                    <span>🔍 INSPECTOR</span>
                  </button>

                  {/* Nimfomane */}
                  <button
                    onClick={() => setSource('nimfomane')}
                    className={`px-3.5 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-1.5 cursor-pointer ${
                      source === 'nimfomane'
                        ? 'bg-pink-600 text-white shadow-lg shadow-pink-600/30 scale-105 border border-pink-300/40'
                        : 'bg-white/5 hover:bg-white/10 text-white/70 border border-white/10'
                    }`}
                  >
                    <span>💬 NIMFOMANE</span>
                  </button>
                </div>

                {/* Results per page selector */}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-widest text-white/40 font-bold">REZULTATE:</span>
                  <div className="flex items-center bg-black/40 border border-white/10 rounded-xl p-1 gap-1">
                    {[20, 50, 100].map(sz => (
                      <button
                        key={sz}
                        onClick={() => setPageSize(sz)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                          pageSize === sz
                            ? 'bg-emerald-500 text-black shadow-md shadow-emerald-500/30 font-black'
                            : 'text-white/60 hover:text-white'
                        }`}
                      >
                        {sz}/pag
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-6 items-end">
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-widest text-white/40 font-semibold ml-1">Select County</label>
              <div className="relative">
                <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-emerald-400" />
                <select 
                  value={county}
                  onChange={(e) => {
                    setCounty(e.target.value);
                    setCity(''); // Reset city when county changes
                  }}
                  className="w-full bg-black/40 border border-white/10 rounded-2xl py-4 pl-12 pr-4 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all appearance-none cursor-pointer"
                >
                  {COUNTIES.map(c => (
                    <option key={c.id} value={c.id} className="bg-[#1a1a1a]">{c.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs uppercase tracking-widest text-white/40 font-semibold ml-1">Select Locality</label>
              <div className="relative">
                <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-emerald-400 opacity-50" />
                <div className="relative">
                  <input 
                    type="text"
                    value={isCityDropdownOpen ? citySearch : (CITIES_BY_COUNTY[county]?.find(c => c.id === city)?.name || 'Toate localitățile')}
                    onChange={(e) => {
                      setCitySearch(e.target.value);
                      setIsCityDropdownOpen(true);
                    }}
                    onFocus={() => {
                      setCitySearch('');
                      setIsCityDropdownOpen(true);
                    }}
                    disabled={!county}
                    placeholder={county ? "Search city..." : "Select county first"}
                    className="w-full bg-black/40 border border-white/10 rounded-2xl py-4 pl-12 pr-4 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  />
                  {isCityDropdownOpen && county && (
                    <div className="absolute z-50 left-0 right-0 mt-2 bg-[#1a1a1a] border border-white/10 rounded-2xl shadow-2xl max-h-60 overflow-y-auto backdrop-blur-xl">
                      <div 
                        onClick={() => {
                          setCity('');
                          setCitySearch('');
                          setIsCityDropdownOpen(false);
                        }}
                        className="px-4 py-3 hover:bg-white/5 cursor-pointer text-sm text-white/60 border-b border-white/5"
                      >
                        Toate localitățile
                      </div>
                      {CITIES_BY_COUNTY[county]
                        ?.filter(c => c.name.toLowerCase().includes(citySearch.toLowerCase()))
                        .map(c => (
                        <div 
                          key={c.id} 
                          onClick={() => {
                            setCity(c.id);
                            setCitySearch(c.name);
                            setIsCityDropdownOpen(false);
                          }}
                          className="px-4 py-3 hover:bg-white/5 cursor-pointer text-sm text-white/90"
                        >
                          {c.name}
                        </div>
                      ))}
                    </div>
                  )}
                  {isCityDropdownOpen && (
                    <div 
                      className="fixed inset-0 z-40" 
                      onClick={() => setIsCityDropdownOpen(false)}
                    />
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs uppercase tracking-widest text-white/40 font-semibold ml-1">Keyword Filter</label>
              <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-emerald-400" />
                <input 
                  type="text" 
                  value={query} 
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="e.g. apartament, auto, masaj"
                  className="w-full bg-black/20 border border-white/5 rounded-2xl py-4 pl-12 pr-4 text-white focus:outline-none focus:border-emerald-500/50 transition-all"
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <button 
                onClick={handleSearch}
                disabled={loading}
                className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-bold py-4 px-8 rounded-2xl transition-all flex items-center justify-center gap-2 group shadow-lg shadow-emerald-500/20"
              >
                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5 group-hover:scale-110 transition-transform" />}
                START SCRAPING
              </button>
              
              {loading && (
                <motion.div 
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3 flex items-center gap-3"
                >
                  <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
                  <span className="text-xs text-emerald-400 font-medium">{loadingStatus}</span>
                </motion.div>
              )}
              
              <div className="flex flex-col gap-2">
                {listings.length > 0 && (
                  <button 
                    onClick={handleEnhanceListings}
                    disabled={loading || isEnhancing}
                    className={`w-full bg-white/5 hover:bg-white/10 disabled:opacity-50 text-white py-3 rounded-2xl border border-white/10 transition-all flex items-center justify-center gap-2 group`}
                  >
                    {isEnhancing ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
                        <span className="text-xs uppercase tracking-widest font-bold">Enhancing All Listings...</span>
                      </>
                    ) : (
                      <>
                        <Camera className="w-4 h-4 text-emerald-400 group-hover:scale-110 transition-transform" />
                        <span className="text-xs uppercase tracking-widest font-bold">Enhance All (HD Images & Descriptions)</span>
                      </>
                    )}
                  </button>
                )}

                {/* Manual OCR Tool */}
                <div className="mt-4 p-4 bg-white/5 rounded-2xl border border-white/10 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-widest font-bold text-white/40">Manual OCR Scanner</span>
                    <Camera className="w-3 h-3 text-emerald-400" />
                  </div>
                  <div className="flex gap-2">
                    <input 
                      type="file" 
                      accept="image/*" 
                      onChange={handleManualImageUpload}
                      className="hidden" 
                      id="manual-ocr-upload"
                    />
                    <label 
                      htmlFor="manual-ocr-upload"
                      className="flex-1 bg-white/10 hover:bg-white/20 text-white/60 text-[10px] font-bold py-2 px-3 rounded-xl cursor-pointer transition-all text-center border border-white/5"
                    >
                      {manualOcrImage ? 'Change Image' : 'Upload Image'}
                    </label>
                    {manualOcrImage && (
                      <button 
                        onClick={handleManualScan}
                        disabled={isManualScanning}
                        className="flex-1 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 text-[10px] font-bold py-2 px-3 rounded-xl transition-all border border-emerald-500/20 disabled:opacity-50"
                      >
                        {isManualScanning ? 'Scanning...' : 'Scan Digits'}
                      </button>
                    )}
                  </div>
                  {manualOcrResult && (
                    <div className="p-2 bg-black/40 rounded-xl border border-white/5 text-center">
                      <span className="text-xs font-mono text-emerald-400 select-all">{manualOcrResult}</span>
                    </div>
                  )}
                </div>
                
                <div 
                  onClick={() => setExcludeOras(!excludeOras)}
                  className="flex items-center justify-between gap-3 px-4 py-3 bg-white/5 rounded-2xl border border-white/10 hover:bg-white/10 transition-all cursor-pointer group"
                >
                  <span className="text-[10px] uppercase tracking-widest font-bold text-white/40 group-hover:text-white/60 transition-colors">Exclude "Oras/Zile"</span>
                  <div className={`w-8 h-4 rounded-full p-0.5 transition-colors duration-200 ${excludeOras ? 'bg-emerald-500' : 'bg-white/10'}`}>
                    <div className={`w-3 h-3 bg-white rounded-full transition-transform duration-200 ${excludeOras ? 'translate-x-4' : 'translate-x-0'}`} />
                  </div>
                </div>

                <button 
                  onClick={handleResetScraper}
                  disabled={loading}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-red-500/5 hover:bg-red-500/10 rounded-2xl border border-red-500/10 transition-all group disabled:opacity-50"
                >
                  <span className="text-[10px] uppercase tracking-widest font-bold text-red-400/60 group-hover:text-red-400 transition-colors">Reset Scraper Cache</span>
                  <RefreshCcw className={`w-3 h-3 text-red-400/60 group-hover:text-red-400 transition-all ${loading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Error State */}
        {error && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-2xl mb-8 text-center"
          >
            {error}
          </motion.div>
        )}

        {/* Top Pagination */}
        {listings.length > 0 && (
          <div className="mb-8 flex items-center justify-between bg-white/5 p-4 rounded-3xl border border-white/10 backdrop-blur-xl">
            <div className="flex items-center gap-4">
              <button 
                onClick={handlePrevPage}
                disabled={page === 1 || loading}
                className="p-3 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-20 transition-all"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <span className="text-white/40 font-mono text-sm uppercase tracking-widest">Page {page}</span>
              <button 
                onClick={handleNextPage}
                disabled={loading}
                className="p-3 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-20 transition-all"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs font-semibold text-white/70 bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-2 rounded-xl cursor-pointer transition-colors">
                <input
                  type="checkbox"
                  checked={autoSaveEnabled}
                  onChange={(e) => setAutoSaveEnabled(e.target.checked)}
                  className="accent-emerald-500 rounded cursor-pointer"
                />
                <span className="hidden sm:inline">Auto-Save Archive</span>
                <span className="sm:hidden">Auto-Save</span>
              </label>

              <button
                onClick={handleSaveAllListings}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs transition-all shadow-md shadow-emerald-500/20 cursor-pointer"
                title="Save all current listings to archive"
              >
                <Bookmark className="w-3.5 h-3.5" />
                <span>Save All ({listings.length})</span>
              </button>

              <div className="hidden md:flex items-center gap-2 text-white/30 text-[10px] uppercase tracking-widest font-bold ml-2">
                <Search className="w-3 h-3" />
                <span>{totalResults !== null ? `${totalResults} Total` : `${listings.length} Results`}</span>
              </div>
            </div>
          </div>
        )}

        {/* Results Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
          <AnimatePresence mode="popLayout">
            {(() => {
              const seenRenderPhones = new Set<string>();
              return listings
                .filter(item => {
                  if (isExcludedListing(item)) return false;
                  if (excludeOras) {
                    const searchStr = `${item.title} ${item.description || ''}`.toLowerCase();
                    if (searchStr.includes('oras') || searchStr.includes('orasul') || searchStr.includes('zile')) return false;
                  }
                  const phone = getNormalizedPhone(item);
                  if (phone && seenRenderPhones.has(phone)) return false;
                  if (phone) seenRenderPhones.add(phone);
                  return true;
                });
            })()
              .map((item, idx) => (
                <motion.div
                  key={item.link ? `listing-${item.link}-${idx}` : `idx-${idx}`}
                layout
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ delay: idx * 0.05 }}
                className="group bg-white/5 border border-white/10 rounded-3xl overflow-hidden hover:border-emerald-500/50 transition-all hover:shadow-2xl hover:shadow-emerald-500/10"
              >
                <div className="aspect-[3/4] overflow-hidden relative bg-white/5 flex items-center justify-center">
                  {item.image ? (
                    <>
                      <img 
                        src={`/api/proxy-image?url=${encodeURIComponent(item.images && item.images.length > 0 ? item.images[item.currentImageIndex || 0] : item.image)}`} 
                        alt={item.title}
                        loading="lazy"
                        className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
                        referrerPolicy="no-referrer"
                        onError={(e) => {
                          console.warn("Image load issue (non-fatal):", item.image);
                          (e.target as HTMLImageElement).src = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600" fill="none"><rect width="100%" height="100%" fill="%231a1a1a"/><circle cx="200" cy="270" r="32" stroke="%23333333" stroke-width="3" fill="none"/><path d="M190 270 a10 10 0 0 1 20 0" stroke="%23333333" stroke-width="3" fill="none"/><rect x="180" y="320" width="40" height="6" rx="3" fill="%23333333"/><text x="200" y="360" fill="%23555555" font-family="system-ui, sans-serif" font-size="12" font-weight="600" text-anchor="middle" letter-spacing="1">FĂRĂ IMAGINE / NO IMAGE</text></svg>`;
                        }}
                      />
                      
                      {/* Image Navigation */}
                      {item.images && item.images.length > 1 && (
                        <div className="absolute inset-0 flex items-center justify-between px-2 opacity-20 group-hover:opacity-100 transition-opacity pointer-events-none">
                          <button 
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); prevImage(idx); }}
                            className="p-2 rounded-full bg-black/50 text-white hover:bg-black/80 transition-colors pointer-events-auto"
                          >
                            <ChevronLeft className="w-5 h-5" />
                          </button>
                          <button 
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); nextImage(idx); }}
                            className="p-2 rounded-full bg-black/50 text-white hover:bg-black/80 transition-colors pointer-events-auto"
                          >
                            <ChevronRight className="w-5 h-5" />
                          </button>
                        </div>
                      )}

                      {/* Image Indicators */}
                      {/* Image Indicators */}
                      {item.images && item.images.length > 1 && (
                        <div className="absolute top-3 left-3 flex gap-1 z-10">
                          {item.images.map((_, i) => (
                            <div 
                              key={i}
                              className={`h-1 rounded-full transition-all ${i === (item.currentImageIndex || 0) ? 'w-4 bg-emerald-500' : 'w-1 bg-white/30'}`}
                            />
                          ))}
                        </div>
                      )}

                      {/* Color-Coded Badges (Source & Status) */}
                      <div className="absolute top-5 left-3 z-20 flex flex-col items-start gap-1.5 pointer-events-none">
                        {/* Source Brand Badge */}
                        {(item.source === 'bursaplacerilor' || (!item.source && source === 'bursaplacerilor')) && (
                          <span className="bg-[#e8302a] text-white text-[10px] font-black px-2.5 py-1 rounded-md shadow-lg shadow-red-600/40 border border-red-300/40 flex items-center gap-1 uppercase tracking-wider">
                            🔥 BURSA PLĂCERILOR
                          </span>
                        )}
                        {(item.source === 'publi24' || (!item.source && source === 'publi24')) && (
                          <span className="bg-[#f36f21] text-white text-[10px] font-black px-2.5 py-1 rounded-md shadow-lg shadow-orange-500/40 border border-amber-300/40 flex items-center gap-1 uppercase tracking-wider">
                            ⚡ PUBLI24
                          </span>
                        )}
                        {item.source === 'inspector' && (
                          <span className="bg-purple-600 text-white text-[10px] font-black px-2.5 py-1 rounded-md shadow-lg shadow-purple-600/40 border border-purple-300/40 flex items-center gap-1 uppercase tracking-wider">
                            🔍 INSPECTOR
                          </span>
                        )}
                        {item.source === 'nimfomane' && (
                          <span className="bg-pink-600 text-white text-[10px] font-black px-2.5 py-1 rounded-md shadow-lg shadow-pink-600/40 border border-pink-300/40 flex items-center gap-1 uppercase tracking-wider">
                            💬 NIMFOMANE
                          </span>
                        )}

                        {/* Status Badge */}
                        {item.date && (item.date.includes('Azi') || item.date.includes('Ieri')) ? (
                          <span className="bg-emerald-500 text-black text-[10px] font-black px-2.5 py-0.5 rounded-md shadow-lg shadow-emerald-500/50 flex items-center gap-1 animate-pulse">
                            NEW
                          </span>
                        ) : (
                          <span className="bg-black/70 backdrop-blur-md text-emerald-400 border border-emerald-500/30 text-[10px] font-bold px-2 py-0.5 rounded-md flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            ACTIVE
                          </span>
                        )}

                        {item.revealedPhone && /\d{4}/.test(item.revealedPhone) && !item.revealedPhone.includes("Error") && !item.revealedPhone.includes("Not found") && (
                          <span className="bg-cyan-500/20 backdrop-blur-md text-cyan-300 border border-cyan-500/40 text-[9px] font-bold px-2 py-0.5 rounded-md flex items-center gap-1 font-mono">
                            📞 TEL OK
                          </span>
                        )}
                      </div>

                      {/* Download & Save Buttons */}
                      <div className="absolute top-4 right-4 flex flex-col gap-2 opacity-80 group-hover:opacity-100 transition-opacity z-10">
                        <button 
                          onClick={(e) => { 
                            e.preventDefault(); 
                            e.stopPropagation(); 
                            handleSaveListing(item);
                          }}
                          title={savedLinksSet.has(normalizeLink(item.link)) ? "Saved in Archive" : "Save to Archive"}
                          className={`p-2 rounded-xl backdrop-blur-md border text-[10px] font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                            savedLinksSet.has(normalizeLink(item.link))
                              ? 'bg-emerald-500 text-black border-emerald-400 font-black shadow-md shadow-emerald-500/30'
                              : 'bg-black/60 hover:bg-emerald-500 hover:text-black text-white border-white/10'
                          }`}
                        >
                          {savedLinksSet.has(normalizeLink(item.link)) ? (
                            <>
                              <BookmarkCheck className="w-4 h-4" />
                              <span className="text-[10px] font-bold">SAVED</span>
                            </>
                          ) : (
                            <>
                              <Bookmark className="w-4 h-4" />
                              <span className="text-[10px] font-bold">ARCHIVE</span>
                            </>
                          )}
                        </button>
                        <button 
                          onClick={(e) => { 
                            e.preventDefault(); 
                            e.stopPropagation(); 
                            downloadImage(item.images && item.images.length > 0 ? item.images[item.currentImageIndex || 0] : item.image, `${item.title.slice(0, 20)}.jpg`); 
                          }}
                          title="Download current photo"
                          className="p-2 rounded-xl bg-black/50 text-white hover:bg-emerald-500 transition-colors backdrop-blur-md border border-white/10 flex items-center gap-2"
                        >
                          <Download className="w-4 h-4" />
                          <span className="text-[10px] font-bold">SAVE</span>
                        </button>
                        {item.images && item.images.length > 1 && (
                          <button 
                            onClick={(e) => { 
                              e.preventDefault(); 
                              e.stopPropagation(); 
                              downloadAllImages(item); 
                            }}
                            title="Download all photos"
                            className="p-2 rounded-xl bg-black/50 text-white hover:bg-emerald-500 transition-colors backdrop-blur-md border border-white/10 text-[10px] font-bold flex items-center gap-2"
                          >
                            <Download className="w-4 h-4" />
                            <span>ALL</span>
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-4 text-white/10">
                      <Search className="w-12 h-12" />
                      <div className="flex flex-col items-center gap-2">
                        <span className="text-[10px] uppercase tracking-widest">No Image Found</span>
                        <button 
                          onClick={() => handleFetchDetails(item, idx)}
                          disabled={item.isRevealing}
                          className="text-[10px] uppercase tracking-tighter bg-white/5 hover:bg-white/10 text-white/60 px-3 py-1.5 rounded-lg border border-white/10 transition-all disabled:opacity-50"
                        >
                          {item.isRevealing ? 'Fetching...' : 'Fetch from Detail'}
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                  <div className="absolute bottom-4 left-4 right-4 translate-y-4 group-hover:translate-y-0 transition-transform">
                    <a 
                      href={item.link} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="w-full bg-white text-black py-3 rounded-xl font-bold flex items-center justify-center gap-2 text-sm"
                    >
                      VIEW DETAILS <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>
                </div>
                
                <div className="p-6 space-y-4">
                  <h3 className="font-semibold text-lg line-clamp-2 min-h-[3.5rem] group-hover:text-emerald-400 transition-colors">
                    {item.title}
                  </h3>
                  
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 text-white/40 text-xs uppercase tracking-widest font-medium">
                      <MapPin className="w-3 h-3 text-emerald-500/50" />
                      <span>{item.location}</span>
                    </div>
                    {item.author && (
                      <div className="flex items-center gap-2 text-emerald-400/60 text-[10px] uppercase tracking-widest font-bold ml-5">
                        <span>By: {item.author}</span>
                      </div>
                    )}
                    {item.date && (
                      <div className="flex items-center gap-2 text-white/20 text-[10px] uppercase tracking-widest font-bold ml-5">
                        <span>{item.date}</span>
                      </div>
                    )}
                  </div>

                  {item.description && item.description.trim().length > 0 && !item.description.includes("Fără descriere") && !item.description.startsWith("Anunț publicat pe BursaPlacerilor.com") ? (
                    <div 
                      onClick={() => copyToClipboard(item.description || "", `desc-${idx}`)}
                      className="relative group/desc cursor-pointer"
                    >
                      <p className="text-white/40 text-xs line-clamp-3 font-light leading-relaxed italic pr-6">
                        {item.description}
                      </p>
                      <div className="absolute top-0 right-0 opacity-0 group-hover/desc:opacity-100 transition-opacity">
                        {copiedId === `desc-${idx}` ? (
                          <Check className="w-3 h-3 text-emerald-500" />
                        ) : (
                          <Copy className="w-3 h-3 text-white/20 hover:text-white/60" />
                        )}
                      </div>
                    </div>
                  ) : (
                    <button 
                      onClick={() => handleFetchDetails(item, idx)}
                      disabled={item.isRevealing}
                      className="text-[10px] uppercase tracking-widest text-emerald-400/80 hover:text-emerald-300 flex items-center gap-1.5 transition-colors disabled:opacity-50 font-medium py-1"
                    >
                      {item.isRevealing ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin text-emerald-400" />
                          <span>Se încarcă descrierea completă...</span>
                        </>
                      ) : (
                        <>
                          <Search className="w-3 h-3" />
                          <span>Încarcă descrierea completă</span>
                        </>
                      )}
                    </button>
                  )}
                  
                  <div className="flex flex-col gap-3">
                    <div 
                      onClick={() => {
                        if (item.revealedPhone) {
                          copyToClipboard(item.revealedPhone.replace(/\s/g, ''), `phone-${idx}`);
                        }
                      }}
                      className={`flex items-center justify-between gap-3 text-white/60 bg-white/5 p-3 rounded-2xl border border-white/5 transition-all ${item.revealedPhone ? 'cursor-pointer hover:bg-white/10 hover:border-emerald-500/30' : ''}`}
                    >
                      <div className="flex items-center gap-2">
                        <Phone className="w-4 h-4 text-emerald-400" />
                        {item.revealedPhone && !item.revealedPhone.includes("Not found") && !item.revealedPhone.includes("Error") && !item.revealedPhone.includes("Scanning") && /\d/.test(item.revealedPhone) ? (
                          <span className="text-sm font-mono font-bold text-emerald-400 tracking-wider">
                            {item.revealedPhone.replace(/\s+/g, '')}
                          </span>
                        ) : item.phoneImage ? (
                          <img 
                            src={item.phoneImage} 
                            alt="phone" 
                            className="h-5 object-contain invert brightness-200"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <span className="text-sm font-mono tracking-wider text-white/50">
                            {(item.revealedPhone || item.phoneNumber || "Not revealed").replace(/\s+/g, '')}
                          </span>
                        )}
                      </div>
                      {item.revealedPhone && !item.revealedPhone.includes("Not found") && !item.revealedPhone.includes("Error") ? (
                        <div className="text-emerald-500/50">
                          {copiedId === `phone-${idx}` ? (
                            <Check className="w-4 h-4" />
                          ) : (
                            <Copy className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                          )}
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <button 
                            onClick={(e) => { e.stopPropagation(); handleShowPhone(item, idx); }}
                            disabled={item.isRevealing}
                            className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-400 px-3 py-1.5 rounded-xl border border-emerald-500/30 transition-all disabled:opacity-50 font-bold"
                          >
                            {item.isDeepScanning ? 'Deep Scanning...' : (item.isScanningImage ? 'Scanning...' : (item.isRevealing ? '...' : (item.phoneImage && (!item.revealedPhone || item.revealedPhone === "Image found") ? 'SCAN' : (item.revealedPhone ? 'RETRY' : 'SUNA'))))}
                          </button>
                          <button 
                            onClick={(e) => { e.stopPropagation(); handleScanImage(item, idx); }}
                            disabled={item.isRevealing || item.isDeepScanning || !item.image}
                            title="Scan Image (AI)"
                            className="text-[10px] uppercase tracking-tighter bg-white/5 hover:bg-white/10 text-white/40 px-2.5 py-1.5 rounded-xl border border-white/10 transition-all disabled:opacity-50"
                          >
                            <Camera className="w-3.5 h-3.5" />
                          </button>
                          <button 
                            onClick={(e) => { e.stopPropagation(); handleDeepScan(item, idx); }}
                            disabled={item.isRevealing || item.isDeepScanning}
                            title="Deep Scan (AI)"
                            className="text-[10px] uppercase tracking-tighter bg-white/5 hover:bg-white/10 text-white/40 px-2.5 py-1.5 rounded-xl border border-white/10 transition-all disabled:opacity-50"
                          >
                            <Search className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                    
                    {/* Copy JSON Button */}
                    <button 
                      onClick={(e) => { e.stopPropagation(); handleCopyJson(item); }}
                      disabled={copyingJsonId === item.id}
                      title="Copy Listing Info as JSON (with full title & description) and Save to Archive"
                      className={`w-full text-[10px] uppercase tracking-widest py-3 rounded-2xl border transition-all flex items-center justify-center gap-2 font-bold cursor-pointer disabled:opacity-60 ${
                        copiedId === `json-${item.id}`
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40 shadow-sm'
                          : 'bg-white/5 hover:bg-white/10 text-white/60 hover:text-white border-white/10'
                      }`}
                    >
                      {copyingJsonId === item.id ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
                          <span className="text-emerald-400">FETCHING FULL DETAILS...</span>
                        </>
                      ) : copiedId === `json-${item.id}` ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span>COPIED & SAVED TO ARCHIVE</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5 text-emerald-400/70" />
                          <span>COPY JSON & SAVE</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Empty State */}
        {!loading && listings.length === 0 && !error && (
          <div className="text-center py-16 bg-white/5 border border-white/10 rounded-3xl p-8 my-8 max-w-xl mx-auto">
            <Search className="w-16 h-16 mx-auto mb-4 text-emerald-400/40" />
            {page > 1 ? (
              <>
                <h3 className="text-lg font-bold text-white mb-2">No New Unique Listings on Page {page}</h3>
                <p className="text-sm text-white/60 mb-6">
                  All listings on this page were already shown on previous pages, or no additional results exist for this search.
                </p>
                <button 
                  onClick={handlePrevPage}
                  className="bg-emerald-500 hover:bg-emerald-400 text-black font-bold py-3 px-6 rounded-2xl transition-all cursor-pointer"
                >
                  Back to Page {page - 1}
                </button>
              </>
            ) : (
              <p className="text-xl font-light italic text-white/40">No listings found. Select a county and start scraping.</p>
            )}
          </div>
        )}

        {/* Pagination */}
        {(listings.length > 0 || page > 1) && (
          <div className="mt-16 flex flex-col items-center gap-4">
            <div className="flex items-center justify-center gap-8">
              <button 
                onClick={handlePrevPage}
                disabled={page === 1 || loading}
                className="p-4 rounded-2xl bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-20 transition-all cursor-pointer disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-6 h-6" />
              </button>
              <span className="text-white/40 font-mono text-lg">PAGE {page}</span>
              <button 
                onClick={handleNextPage}
                disabled={loading}
                className="p-4 rounded-2xl bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-20 transition-all cursor-pointer disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-6 h-6" />
              </button>
            </div>
            {totalResults !== null && (
              <span className="text-white/20 font-mono text-xs uppercase tracking-widest">
                {totalResults} Total Results Found
              </span>
            )}
          </div>
        )}
          </>
        )}
      </main>

      <footer className="max-w-7xl mx-auto px-4 py-12 border-t border-white/5 text-center text-white/20 text-sm tracking-widest uppercase">
        &copy; 2026 Publi24 Scraper Engine &bull; Educational Research Tool
      </footer>
    </div>
  );
}

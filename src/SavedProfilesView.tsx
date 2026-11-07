import React, { useState } from 'react';
import { 
  Phone, Search, RefreshCcw, ExternalLink, Trash2, Download, 
  Copy, Check, MapPin, Calendar, Clock, ChevronRight, ChevronLeft, 
  FileText, ShieldCheck, AlertCircle, Sparkles, PhoneCall, ArrowUpRight,
  Database, Tag, Navigation, Code2, Terminal, ArrowRight, CheckCircle2, XCircle, Compass
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { SavedProfile } from './App';

interface SavedProfilesViewProps {
  savedProfiles: SavedProfile[];
  savedCount: number;
  loadingSaved: boolean;
  phoneSearchQuery: string;
  setPhoneSearchQuery: (v: string) => void;
  savedTextQuery: string;
  setSavedTextQuery: (v: string) => void;
  savedStatusFilter: 'all' | 'active' | 'expired';
  setSavedStatusFilter: (v: 'all' | 'active' | 'expired') => void;
  savedSourceFilter: 'all' | 'publi24' | 'bursaplacerilor' | 'nimfomane' | 'inspector';
  setSavedSourceFilter: (v: 'all' | 'publi24' | 'bursaplacerilor' | 'nimfomane' | 'inspector') => void;
  updatingProfileId: string | null;
  updateFeedback: { id: string; message: string; type: 'success' | 'warning' } | null;
  onRefresh: () => void;
  onUpdateProfile: (profile: SavedProfile) => void;
  onDeleteProfile: (id: string) => void;
  onSaveNote: (id: string, note: string) => void;
  onSearchPhoneLive: (phone: string) => void;
  onClearArchive: () => void;
  onNextImage: (id: string) => void;
  onPrevImage: (id: string) => void;
  onDownloadImage: (url: string, name: string) => void;
}

export const SavedProfilesView: React.FC<SavedProfilesViewProps> = ({
  savedProfiles,
  savedCount,
  loadingSaved,
  phoneSearchQuery,
  setPhoneSearchQuery,
  savedTextQuery,
  setSavedTextQuery,
  savedStatusFilter,
  setSavedStatusFilter,
  savedSourceFilter,
  setSavedSourceFilter,
  updatingProfileId,
  updateFeedback,
  onRefresh,
  onUpdateProfile,
  onDeleteProfile,
  onSaveNote,
  onSearchPhoneLive,
  onClearArchive,
  onNextImage,
  onPrevImage,
  onDownloadImage,
}) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<string>('');
  const [expandedDescId, setExpandedDescId] = useState<string | null>(null);
  const [showLocationChecker, setShowLocationChecker] = useState<boolean>(false);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const pageSize = 100;
  const totalPages = Math.ceil(savedProfiles.length / pageSize) || 1;
  const safePage = Math.min(currentPage, totalPages);
  const paginatedProfiles = savedProfiles.slice((safePage - 1) * pageSize, safePage * pageSize);

  React.useEffect(() => {
    setCurrentPage(1);
  }, [phoneSearchQuery, savedTextQuery, savedStatusFilter, savedSourceFilter]);

  const isFilterActive = Boolean(
    (savedSourceFilter && savedSourceFilter !== 'all') ||
    (savedStatusFilter && savedStatusFilter !== 'all') ||
    (phoneSearchQuery && phoneSearchQuery.trim() !== '') ||
    (savedTextQuery && savedTextQuery.trim() !== '')
  );

  const [apiEndpointMode, setApiEndpointMode] = useState<'locations' | 'check_change'>('locations');
  const [locationCheckPhone, setLocationCheckPhone] = useState<string>('0720938966');
  const [locationCheckExpectedCity, setLocationCheckExpectedCity] = useState<string>('');
  const [batchPhonesInput, setBatchPhonesInput] = useState<string>('0720938966\n0722123456');
  const [apiKeyValue, setApiKeyValue] = useState<string>(() => {
    try {
      return localStorage.getItem("external_api_key") || "";
    } catch {
      return "";
    }
  });
  const [isCheckingLocation, setIsCheckingLocation] = useState<boolean>(false);
  const [locationCheckResult, setLocationCheckResult] = useState<any>(null);
  const [activeCodeTab, setActiveCodeTab] = useState<'curl' | 'js' | 'python'>('curl');

  const handleRunLocationCheck = async (overridePhone?: string) => {
    setIsCheckingLocation(true);
    setLocationCheckResult(null);

    const mode = overridePhone ? 'check_change' : apiEndpointMode;
    if (overridePhone) {
      setApiEndpointMode('check_change');
      setLocationCheckPhone(overridePhone);
    }

    try {
      if (apiKeyValue) {
        try {
          localStorage.setItem("external_api_key", apiKeyValue);
        } catch {}
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };
      if (apiKeyValue.trim()) {
        headers["Authorization"] = `Bearer ${apiKeyValue.trim()}`;
      }

      if (mode === 'locations') {
        const rawPhones = batchPhonesInput
          .split(/[\n,;\s]+/)
          .map(p => p.trim())
          .filter(Boolean);

        const res = await fetch("/api/locations", {
          method: "POST",
          headers,
          body: JSON.stringify({ phones: rawPhones.slice(0, 100) })
        });
        const data = await res.json();
        setLocationCheckResult(data);
      } else {
        const cleanDigits = (overridePhone || locationCheckPhone || '').trim();
        const queryParams = new URLSearchParams({
          phone: cleanDigits,
          ...(locationCheckExpectedCity.trim() ? { location: locationCheckExpectedCity.trim() } : {})
        });
        const res = await fetch(`/api/check-location-change?${queryParams.toString()}`, {
          method: "GET",
          headers
        });
        const data = await res.json();
        setLocationCheckResult(data);
      }
    } catch (err: any) {
      console.warn("API check failed:", err);
      setLocationCheckResult({
        error: err.message || "Failed to reach API endpoint"
      });
    } finally {
      setIsCheckingLocation(false);
    }
  };

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (e) {
      console.warn("Copy failed:", e);
    }
  };

  const handleCopySavedJson = (p: SavedProfile) => {
    const dataToCopy = {
      id: p.id,
      title: p.title,
      image: p.image,
      images: p.images || [],
      location: p.location,
      price: p.price,
      date: p.date,
      description: p.description,
      phone: (p.revealedPhone || p.phoneNumber || "").replace(/\s+/g, '') || null,
      phoneImage: p.phoneImage || null,
      source: p.source,
      link: p.link,
      status: p.status,
      lastCheckedStatus: p.lastCheckedStatus,
      savedAt: p.savedAt ? new Date(p.savedAt).toISOString() : null,
      lastUpdatedAt: p.lastUpdatedAt ? new Date(p.lastUpdatedAt).toISOString() : null,
      notes: p.notes || null,
      changeHistory: p.changeHistory || []
    };
    copyToClipboard(JSON.stringify(dataToCopy, null, 2), `saved-json-${p.id}`);
  };

  const formatTimestamp = (ts?: number) => {
    if (!ts) return '';
    const date = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString('ro-RO', { day: '2-digit', month: 'short' });
  };

  // Metrics
  const activeCount = savedProfiles.filter(p => p.status === 'active').length;
  const withPhoneCount = savedProfiles.filter(p => p.revealedPhone && /\d{4}/.test(p.revealedPhone)).length;
  const expiredCount = savedProfiles.filter(p => p.status === 'expired').length;

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Search Header Banner */}
      <div className="relative overflow-hidden bg-gradient-to-r from-emerald-950/40 via-[#141414] to-cyan-950/40 border border-emerald-500/20 rounded-3xl p-6 sm:p-8 shadow-2xl backdrop-blur-xl">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2 text-emerald-400 text-xs font-bold uppercase tracking-widest mb-1.5">
              <PhoneCall className="w-4 h-4 animate-pulse" />
              <span>Dedicated Phone Database & Scraped Archive</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
              Search by Phone & Live Update
            </h2>
            <p className="text-white/60 text-sm mt-1 max-w-xl">
              Quickly find any previously scraped profile by phone number, check active status, and click <span className="text-emerald-400 font-bold">Update to Latest</span> to fetch new photos, description & prices.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 self-stretch md:self-auto justify-end">
            <button
              onClick={() => setShowLocationChecker(!showLocationChecker)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs font-bold transition-all cursor-pointer border ${
                showLocationChecker 
                  ? 'bg-cyan-500 text-black border-cyan-400 font-black shadow-lg shadow-cyan-500/30' 
                  : 'bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border-cyan-500/30'
              }`}
            >
              <Navigation className="w-3.5 h-3.5" />
              <span>Location Tracker API</span>
              <span className="px-1.5 py-0.5 rounded text-[9px] bg-cyan-400/20 text-cyan-200 uppercase font-mono font-bold">
                API
              </span>
            </button>
            <button
              onClick={onRefresh}
              disabled={loadingSaved}
              className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-white/5 hover:bg-white/10 text-white/80 hover:text-white border border-white/10 text-xs font-bold transition-all cursor-pointer disabled:opacity-50"
            >
              <RefreshCcw className={`w-3.5 h-3.5 ${loadingSaved ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
            {savedProfiles.length > 0 && (
              <button
                onClick={() => {
                  if (window.confirm("Are you sure you want to clear all archived profiles?")) {
                    onClearArchive();
                  }
                }}
                className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-2xl bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 text-xs font-bold transition-all cursor-pointer"
                title="Clear archive"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>
            )}
          </div>
        </div>

        {/* Primary Search by Phone Bar */}
        <div className="relative mb-5">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 flex items-center gap-2 pointer-events-none">
            <div className="p-2 rounded-xl bg-emerald-500/20 text-emerald-400">
              <Phone className="w-5 h-5" />
            </div>
          </div>
          <input
            type="text"
            value={phoneSearchQuery}
            onChange={(e) => setPhoneSearchQuery(e.target.value)}
            placeholder="Search by phone (e.g. 0722 123 456, +407..., or last digits)..."
            className="w-full bg-black/60 border-2 border-emerald-500/40 focus:border-emerald-400 rounded-2xl py-4 pl-16 pr-12 text-lg sm:text-xl text-white font-mono placeholder:font-sans placeholder:text-white/30 focus:outline-none transition-all shadow-inner focus:ring-4 focus:ring-emerald-500/10"
          />
          {phoneSearchQuery && (
            <button
              onClick={() => setPhoneSearchQuery('')}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-xl text-white/40 hover:text-white hover:bg-white/10 transition-all cursor-pointer"
            >
              ✕
            </button>
          )}
        </div>

        {/* Secondary Filters */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-white/10">
          <div className="flex flex-wrap items-center gap-3">
            {/* Keyword / Text filter */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
              <input
                type="text"
                value={savedTextQuery}
                onChange={(e) => setSavedTextQuery(e.target.value)}
                placeholder="Filter by title / city / note..."
                className="bg-black/50 border border-white/10 rounded-xl py-2 pl-9 pr-3 text-xs sm:text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-emerald-500/60 w-44 sm:w-56"
              />
              {savedTextQuery && (
                <button
                  onClick={() => setSavedTextQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/40 hover:text-white text-xs"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Status Filter */}
            <select
              value={savedStatusFilter}
              onChange={(e) => setSavedStatusFilter(e.target.value as any)}
              className="bg-black/50 border border-white/10 rounded-xl py-2 px-3 text-xs sm:text-sm text-white focus:outline-none cursor-pointer"
            >
              <option value="all">All Statuses ({savedProfiles.length})</option>
              <option value="active">Active Only ({activeCount})</option>
              <option value="expired">Expired Only ({expiredCount})</option>
            </select>

            {/* Source Filter */}
            <select
              value={savedSourceFilter}
              onChange={(e) => setSavedSourceFilter(e.target.value as any)}
              className="bg-black/50 border border-white/10 rounded-xl py-2 px-3 text-xs sm:text-sm text-white focus:outline-none cursor-pointer"
            >
              <option value="all">All Sources</option>
              <option value="publi24">Publi24</option>
              <option value="bursaplacerilor">Bursa Plăcerilor</option>
              <option value="inspector">Inspector Escorte</option>
              <option value="nimfomane">Nimfomane</option>
            </select>
          </div>

          {/* Quick Metrics Badges */}
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
            <span className="px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-white/70">
              Total în arhivă: <strong className="text-white">{savedCount}</strong>
            </span>
            {isFilterActive && (
              <span className="px-3 py-1.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-300">
                Filtrate afișate: <strong className="text-white">{savedProfiles.length}</strong>
              </span>
            )}
            <span className="px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
              Cu Telefon: <strong>{withPhoneCount}</strong>
            </span>
            {expiredCount > 0 && (
              <span className="px-3 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
                Expirate: <strong>{expiredCount}</strong>
              </span>
            )}
          </div>
        </div>

        {/* Active Filter Notice */}
        {isFilterActive && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-2xl bg-cyan-950/30 border border-cyan-500/30 text-xs text-cyan-200">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-cyan-400">🔍 Filtrare activă:</span>
              {savedSourceFilter !== 'all' && (
                <span className="px-2 py-0.5 rounded-md bg-cyan-500/20 border border-cyan-500/40 font-mono uppercase text-white font-bold">
                  Sursă: {savedSourceFilter}
                </span>
              )}
              {savedStatusFilter !== 'all' && (
                <span className="px-2 py-0.5 rounded-md bg-cyan-500/20 border border-cyan-500/40 font-mono uppercase text-white font-bold">
                  Status: {savedStatusFilter}
                </span>
              )}
              {phoneSearchQuery && (
                <span className="px-2 py-0.5 rounded-md bg-cyan-500/20 border border-cyan-500/40 text-white">
                  Tel: {phoneSearchQuery}
                </span>
              )}
              {savedTextQuery && (
                <span className="px-2 py-0.5 rounded-md bg-cyan-500/20 border border-cyan-500/40 text-white">
                  Text: "{savedTextQuery}"
                </span>
              )}
              <span className="text-white/60">
                (Sunt afișate <strong>{savedProfiles.length}</strong> din <strong>{savedCount}</strong> profiluri salvate în total)
              </span>
            </div>

            <button
              onClick={() => {
                setPhoneSearchQuery('');
                setSavedTextQuery('');
                setSavedStatusFilter('all');
                setSavedSourceFilter('all');
              }}
              className="px-3 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-black text-xs transition-all cursor-pointer shadow-md shadow-cyan-500/20"
            >
              Resetează filtrele (Arată toate {savedCount})
            </button>
          </div>
        )}

        {/* Location Change Checker & API Explorer Panel */}
        {showLocationChecker && (
          <div className="mt-6 pt-6 border-t border-cyan-500/30 space-y-6 animate-fadeIn">
            <div className="p-5 sm:p-8 rounded-3xl bg-cyan-950/20 border border-cyan-500/30 backdrop-blur-xl">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-6">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-2xl bg-cyan-500/20 text-cyan-400">
                    <Compass className="w-6 h-6 animate-spin-slow" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-white flex items-center gap-2">
                      <span>External Server API Explorer</span>
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                        BEARER AUTH
                      </span>
                    </h3>
                    <p className="text-xs text-white/60 mt-0.5">
                      Production API endpoints for external servers (Vercel, Node, Python) with secret API_KEY authentication.
                    </p>
                  </div>
                </div>

                {/* API Key Configuration */}
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-black/60 border border-white/10 text-xs">
                    <span className="text-white/40 font-mono text-[11px]">API_KEY:</span>
                    <input
                      type="password"
                      value={apiKeyValue}
                      onChange={(e) => {
                        setApiKeyValue(e.target.value);
                        try { localStorage.setItem("external_api_key", e.target.value); } catch {}
                      }}
                      placeholder="Enter Bearer key..."
                      className="bg-transparent text-white font-mono text-xs focus:outline-none w-32 sm:w-40 placeholder:text-white/20"
                    />
                  </div>
                </div>
              </div>

              {/* Endpoint Selector Tabs */}
              <div className="flex items-center gap-2 mb-4 p-1 rounded-2xl bg-black/40 border border-white/10 w-fit">
                <button
                  onClick={() => {
                    setApiEndpointMode('locations');
                    setLocationCheckResult(null);
                  }}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                    apiEndpointMode === 'locations'
                      ? 'bg-cyan-500 text-black shadow-md'
                      : 'text-white/70 hover:text-white'
                  }`}
                >
                  POST /api/locations (Batch Up to 100)
                </button>
                <button
                  onClick={() => {
                    setApiEndpointMode('check_change');
                    setLocationCheckResult(null);
                  }}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                    apiEndpointMode === 'check_change'
                      ? 'bg-cyan-500 text-black shadow-md'
                      : 'text-white/70 hover:text-white'
                  }`}
                >
                  GET /api/check-location-change
                </button>
              </div>

              {/* Form Inputs based on selected endpoint */}
              {apiEndpointMode === 'locations' ? (
                <div className="space-y-3 mb-4">
                  <label className="text-xs text-white/70 block">
                    Phone numbers list (one per line, comma or space separated — max 100):
                  </label>
                  <textarea
                    rows={3}
                    value={batchPhonesInput}
                    onChange={(e) => setBatchPhonesInput(e.target.value)}
                    placeholder="0720938966&#10;0722123456"
                    className="w-full bg-black/60 border border-cyan-500/40 rounded-xl p-3 text-sm text-white font-mono placeholder:text-white/30 focus:outline-none focus:border-cyan-400"
                  />
                  <div className="flex justify-between items-center pt-1">
                    <span className="text-[11px] text-white/40">
                      Normalizes phone: digits only, 40/+40 -&gt; 0, compares last 9 digits.
                    </span>
                    <button
                      onClick={() => handleRunLocationCheck()}
                      disabled={isCheckingLocation || !batchPhonesInput.trim()}
                      className="py-2.5 px-5 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-black font-black text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-lg shadow-cyan-500/20"
                    >
                      {isCheckingLocation ? <RefreshCcw className="w-3.5 h-3.5 animate-spin" /> : <Navigation className="w-3.5 h-3.5" />}
                      <span>{isCheckingLocation ? "Calling API..." : "Send POST /api/locations"}</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 mb-4">
                  <div className="sm:col-span-5 relative">
                    <Phone className="w-4 h-4 text-cyan-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={locationCheckPhone}
                      onChange={(e) => setLocationCheckPhone(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleRunLocationCheck()}
                      placeholder="Phone (e.g. 0720938966)..."
                      className="w-full bg-black/60 border border-cyan-500/40 rounded-xl py-2.5 pl-10 pr-3 text-sm text-white font-mono placeholder:text-white/30 focus:outline-none focus:border-cyan-400"
                    />
                  </div>

                  <div className="sm:col-span-4 relative">
                    <MapPin className="w-4 h-4 text-white/40 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={locationCheckExpectedCity}
                      onChange={(e) => setLocationCheckExpectedCity(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleRunLocationCheck()}
                      placeholder="Optional: Expected city..."
                      className="w-full bg-black/60 border border-white/10 rounded-xl py-2.5 pl-10 pr-3 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-cyan-400"
                    />
                  </div>

                  <div className="sm:col-span-3 flex items-center gap-2">
                    <button
                      onClick={() => handleRunLocationCheck()}
                      disabled={isCheckingLocation || !locationCheckPhone.trim()}
                      className="w-full py-2.5 px-4 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-black font-black text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-lg shadow-cyan-500/20"
                    >
                      {isCheckingLocation ? (
                        <RefreshCcw className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Navigation className="w-3.5 h-3.5" />
                      )}
                      <span>{isCheckingLocation ? "Checking..." : "Call GET API"}</span>
                    </button>
                  </div>
                </div>
              )}

              {/* API Response JSON View */}
              {locationCheckResult && (
                <div className="p-4 rounded-2xl bg-black/80 border border-white/10 space-y-3 animate-fadeIn">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white/70 uppercase tracking-wider font-mono">
                      JSON Response:
                    </span>
                    <button
                      onClick={() => copyToClipboard(JSON.stringify(locationCheckResult, null, 2), 'res-json')}
                      className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-mono flex items-center gap-1"
                    >
                      {copiedId === 'res-json' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      <span>Copy JSON</span>
                    </button>
                  </div>
                  <pre className="text-xs font-mono text-cyan-300 bg-black/50 p-3 rounded-xl border border-white/5 overflow-x-auto max-h-64 leading-relaxed">
                    {JSON.stringify(locationCheckResult, null, 2)}
                  </pre>
                </div>
              )}

              {/* Site API Integration Guide */}
              <div className="mt-6 pt-6 border-t border-white/10 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-cyan-300 flex items-center gap-1.5">
                    <Code2 className="w-4 h-4" />
                    External Server Integration (Vercel / Node / Python):
                  </span>
                  <div className="flex items-center gap-1 text-[11px]">
                    <button
                      onClick={() => setActiveCodeTab('curl')}
                      className={`px-3 py-1.5 rounded-lg font-mono transition-all ${activeCodeTab === 'curl' ? 'bg-cyan-500 text-black font-bold' : 'text-white/60 hover:text-white'}`}
                    >
                      cURL
                    </button>
                    <button
                      onClick={() => setActiveCodeTab('js')}
                      className={`px-3 py-1.5 rounded-lg font-mono transition-all ${activeCodeTab === 'js' ? 'bg-cyan-500 text-black font-bold' : 'text-white/60 hover:text-white'}`}
                    >
                      Vercel / Node.js
                    </button>
                    <button
                      onClick={() => setActiveCodeTab('python')}
                      className={`px-3 py-1.5 rounded-lg font-mono transition-all ${activeCodeTab === 'python' ? 'bg-cyan-500 text-black font-bold' : 'text-white/60 hover:text-white'}`}
                    >
                      Python
                    </button>
                  </div>
                </div>

                <div className="relative rounded-2xl bg-black/90 border border-white/10 p-4 font-mono text-xs text-white/80 overflow-x-auto">
                  <button
                    onClick={() => {
                      const snippet = apiEndpointMode === 'locations'
                        ? (activeCodeTab === 'curl'
                            ? `curl -X POST "${window.location.origin}/api/locations" \\\n  -H "Authorization: Bearer ${apiKeyValue || 'YOUR_API_KEY'}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"phones": ["0720938966", "0722123456"]}'`
                            : activeCodeTab === 'js'
                              ? `// Vercel / Node.js call to POST /api/locations\nconst response = await fetch("${window.location.origin}/api/locations", {\n  method: "POST",\n  headers: {\n    "Authorization": "Bearer " + process.env.API_KEY,\n    "Content-Type": "application/json"\n  },\n  body: JSON.stringify({\n    phones: ["0720938966", "0722123456"]\n  })\n});\n\nconst data = await response.json();\nconsole.log(data.results);`
                              : `import requests, os\n\nresponse = requests.post(\n    "${window.location.origin}/api/locations",\n    headers={\n        "Authorization": f"Bearer {os.getenv('API_KEY', '${apiKeyValue || 'YOUR_API_KEY'}')}",\n        "Content-Type": "application/json"\n    },\n    json={"phones": ["0720938966", "0722123456"]}\n)\nprint(response.json())`)
                        : (activeCodeTab === 'curl'
                            ? `curl -X GET "${window.location.origin}/api/check-location-change?phone=${(locationCheckPhone || '0720938966').replace(/\s+/g, '')}${locationCheckExpectedCity ? `&location=${encodeURIComponent(locationCheckExpectedCity)}` : ''}" \\\n  -H "Authorization: Bearer ${apiKeyValue || 'YOUR_API_KEY'}"`
                            : activeCodeTab === 'js'
                              ? `// Vercel / Node.js call to GET /api/check-location-change\nconst phone = "0720938966";\nconst res = await fetch(\`${window.location.origin}/api/check-location-change?phone=\${phone}&location=Bucuresti\`, {\n  headers: {\n    "Authorization": "Bearer " + process.env.API_KEY\n  }\n});\nconst { hasChangedLocation, currentLocation, previousLocations } = await res.json();\nconsole.log({ hasChangedLocation, currentLocation, previousLocations });`
                              : `import requests, os\n\nresponse = requests.get(\n    "${window.location.origin}/api/check-location-change",\n    headers={"Authorization": f"Bearer {os.getenv('API_KEY', '${apiKeyValue || 'YOUR_API_KEY'}')}"},\n    params={"phone": "0720938966", "location": "Bucuresti"}\n)\nprint(response.json())`);

                      copyToClipboard(snippet, `code-${activeCodeTab}`);
                    }}
                    className="absolute top-3 right-3 p-2 rounded-xl bg-white/10 hover:bg-cyan-500 hover:text-black text-white/80 transition-all cursor-pointer"
                    title="Copy code"
                  >
                    {copiedId === `code-${activeCodeTab}` ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>

                  <pre className="text-[11px] leading-relaxed">
                    {apiEndpointMode === 'locations' ? (
                      activeCodeTab === 'curl' ? (
                        `curl -X POST "${window.location.origin}/api/locations" \\\n  -H "Authorization: Bearer ${apiKeyValue || '$API_KEY'}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"phones": ["0720938966", "0722123456"]}'`
                      ) : activeCodeTab === 'js' ? (
                        `// External server request (Vercel Serverless Function)\nconst response = await fetch("${window.location.origin}/api/locations", {\n  method: "POST",\n  headers: {\n    "Authorization": \`Bearer \${process.env.API_KEY}\`,\n    "Content-Type": "application/json"\n  },\n  body: JSON.stringify({\n    phones: ["0720938966", "0722123456"] // max 100 per request\n  })\n});\n\nconst data = await response.json();\n// Returns: { results: [ { phone, found, city, zone, sourceUrl, seenAt } ] }`
                      ) : (
                        `import requests, os\n\nres = requests.post(\n    "${window.location.origin}/api/locations",\n    headers={\n        "Authorization": f"Bearer {os.getenv('API_KEY')}",\n        "Content-Type": "application/json"\n    },\n    json={"phones": ["0720938966", "0722123456"]}\n)\nresults = res.json().get("results", [])`
                      )
                    ) : (
                      activeCodeTab === 'curl' ? (
                        `curl -X GET "${window.location.origin}/api/check-location-change?phone=0720938966&location=Bucuresti" \\\n  -H "Authorization: Bearer ${apiKeyValue || '$API_KEY'}"`
                      ) : activeCodeTab === 'js' ? (
                        `// External server request (Vercel)\nconst response = await fetch("${window.location.origin}/api/check-location-change?phone=0720938966&location=Bucuresti", {\n  headers: {\n    "Authorization": \`Bearer \${process.env.API_KEY}\`\n  }\n});\nconst { hasChangedLocation, currentLocation, previousLocations } = await response.json();`
                      ) : (
                        `import requests, os\n\nres = requests.get(\n    "${window.location.origin}/api/check-location-change",\n    headers={"Authorization": f"Bearer {os.getenv('API_KEY')}"},\n    params={"phone": "0720938966", "location": "Bucuresti"}\n)\ndata = res.json()\n# Returns: {"hasChangedLocation": True, "currentLocation": "Bucuresti", "previousLocations": ["Pitesti"]}`
                      )
                    )}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Loading state */}
      {loadingSaved && (
        <div className="py-20 text-center flex flex-col items-center justify-center gap-3">
          <div className="w-10 h-10 border-4 border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin"></div>
          <p className="text-sm text-white/50">Loading archived profiles...</p>
        </div>
      )}

      {/* Empty State: No profiles in Archive */}
      {!loadingSaved && savedProfiles.length === 0 && !phoneSearchQuery && !savedTextQuery && (
        <div className="bg-white/5 border border-white/10 rounded-3xl p-12 text-center max-w-xl mx-auto my-8">
          <Database className="w-16 h-16 mx-auto mb-4 text-emerald-400/40" />
          <h3 className="text-xl font-bold text-white mb-2">Archive is Currently Empty</h3>
          <p className="text-white/60 text-sm mb-6">
            Scrape listings on the Live Scraper and click &quot;Save to Archive&quot;, or keep Auto-Save active to automatically store all listings you browse.
          </p>
        </div>
      )}

      {/* Empty State: Phone search found 0 results */}
      {!loadingSaved && savedProfiles.length === 0 && (phoneSearchQuery || savedTextQuery) && (
        <div className="bg-gradient-to-b from-white/5 to-black/40 border border-white/10 rounded-3xl p-8 sm:p-10 text-center max-w-xl mx-auto my-6">
          <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-4 text-amber-400">
            <Phone className="w-7 h-7" />
          </div>
          <h3 className="text-lg sm:text-xl font-bold text-white mb-2">
            No Saved Profile Matches &quot;{phoneSearchQuery || savedTextQuery}&quot;
          </h3>
          <p className="text-white/60 text-sm mb-6">
            This phone number or keyword was not found in your local archive. You can immediately search across live websites (Publi24, Inspector Escorte) for this exact number.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            {phoneSearchQuery && (
              <button
                onClick={() => onSearchPhoneLive(phoneSearchQuery)}
                className="w-full sm:w-auto px-6 py-3 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-black font-black text-sm flex items-center justify-center gap-2 transition-all cursor-pointer shadow-lg shadow-emerald-500/20"
              >
                <Search className="w-4 h-4" />
                <span>Search {phoneSearchQuery} on Live Scrapers</span>
              </button>
            )}
            <button
              onClick={() => {
                setPhoneSearchQuery('');
                setSavedTextQuery('');
              }}
              className="w-full sm:w-auto px-5 py-3 rounded-2xl bg-white/10 hover:bg-white/15 text-white text-sm font-semibold transition-all cursor-pointer"
            >
              Clear Filters
            </button>
          </div>
        </div>
      )}

      {/* Top Pagination & Stats Bar */}
      {!loadingSaved && savedProfiles.length > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-white/5 border border-white/10 rounded-2xl px-6 py-4 backdrop-blur-md mb-6">
          <div className="flex items-center gap-3">
            <span className="text-sm text-white/70">
              Afișare <strong className="text-white">{(safePage - 1) * pageSize + 1}</strong> - <strong className="text-white">{Math.min(safePage * pageSize, savedProfiles.length)}</strong> din <strong className="text-emerald-400">{savedProfiles.length}</strong> {isFilterActive ? `rezultate filtrate (din ${savedCount} total în arhivă)` : 'profiluri salvate'}
            </span>
            <span className="text-xs px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold">
              100 pe pagină
            </span>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={safePage <= 1}
                className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold text-white transition-all cursor-pointer flex items-center gap-1"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Înapoi
              </button>
              <span className="text-xs font-mono px-3 py-1.5 rounded-xl bg-black/40 border border-white/10 text-white/80">
                Pagina {safePage} din {totalPages}
              </span>
              <button
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                disabled={safePage >= totalPages}
                className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold text-white transition-all cursor-pointer flex items-center gap-1"
              >
                Înainte
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Results Grid */}
      {!loadingSaved && savedProfiles.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {paginatedProfiles.map((profile) => {
            const isUpdating = updatingProfileId === profile.id;
            const currentImg = profile.images && profile.images.length > 0 
              ? profile.images[profile.currentImageIndex || 0] 
              : profile.image;
            const isEditingNote = editingNoteId === profile.id;
            const feedback = updateFeedback?.id === profile.id ? updateFeedback : null;
            const isExpired = profile.status === 'expired';
            const hasMoved = Boolean(
              (profile.locationHistory && profile.locationHistory.length >= 2) ||
              profile.changeHistory?.some(c => c.change.toLowerCase().includes("location changed"))
            );

            return (
              <div 
                key={profile.id}
                className={`group bg-white/5 border rounded-3xl overflow-hidden backdrop-blur-md transition-all duration-300 flex flex-col justify-between hover:shadow-2xl hover:shadow-emerald-500/10 ${
                  isExpired 
                    ? 'border-red-500/20 hover:border-red-500/40 opacity-90' 
                    : 'border-white/10 hover:border-emerald-500/40'
                }`}
              >
                <div>
                  {/* Top Image Preview & Carousel */}
                  <div className="relative aspect-[4/3] bg-black/40 overflow-hidden">
                    {currentImg ? (
                      <>
                        <img 
                          src={currentImg.startsWith('http') ? `/api/proxy-image?url=${encodeURIComponent(currentImg)}` : currentImg}
                          alt={profile.title}
                          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                          loading="lazy"
                        />

                        {/* Image Carousel Controls */}
                        {profile.images && profile.images.length > 1 && (
                          <>
                            <button
                              onClick={(e) => { e.stopPropagation(); onPrevImage(profile.id); }}
                              className="absolute left-2.5 top-1/2 -translate-y-1/2 p-2 rounded-xl bg-black/60 text-white/80 hover:text-white hover:bg-black/90 backdrop-blur-md transition-all cursor-pointer opacity-0 group-hover:opacity-100 z-10"
                            >
                              <ChevronLeft className="w-4 h-4" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); onNextImage(profile.id); }}
                              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-2 rounded-xl bg-black/60 text-white/80 hover:text-white hover:bg-black/90 backdrop-blur-md transition-all cursor-pointer opacity-0 group-hover:opacity-100 z-10"
                            >
                              <ChevronRight className="w-4 h-4" />
                            </button>
                            <div className="absolute bottom-3 right-3 bg-black/70 backdrop-blur-md px-2.5 py-1 rounded-lg text-[10px] font-mono text-white/80 border border-white/10 z-10">
                              {(profile.currentImageIndex || 0) + 1} / {profile.images.length}
                            </div>
                          </>
                        )}

                        {/* Top Badges */}
                        <div className="absolute top-3 left-3 flex flex-wrap items-center gap-1.5 z-10">
                          {/* Source Brand Badge */}
                          {profile.source === 'bursaplacerilor' ? (
                            <span className="bg-[#e8302a] text-white text-[10px] font-black px-2 py-1 rounded-md shadow-md shadow-[#e8302a]/30 tracking-wider flex items-center gap-1">
                              <span>🔥</span> BURSA PLĂCERILOR
                            </span>
                          ) : profile.source === 'publi24' ? (
                            <span className="bg-[#f36f21] text-white text-[10px] font-black px-2 py-1 rounded-md shadow-md shadow-[#f36f21]/30 tracking-wider flex items-center gap-1">
                              <span>⚡</span> PUBLI24
                            </span>
                          ) : profile.source === 'inspector' ? (
                            <span className="bg-purple-600 text-white text-[10px] font-black px-2 py-1 rounded-md shadow-md shadow-purple-600/30 tracking-wider flex items-center gap-1">
                              <span>🔍</span> INSPECTOR
                            </span>
                          ) : profile.source === 'nimfomane' ? (
                            <span className="bg-pink-600 text-white text-[10px] font-black px-2 py-1 rounded-md shadow-md shadow-pink-600/30 tracking-wider flex items-center gap-1">
                              <span>💬</span> NIMFOMANE
                            </span>
                          ) : profile.source ? (
                            <span className="bg-black/70 backdrop-blur-md border border-white/10 text-white/80 text-[10px] font-bold px-2 py-1 rounded-md uppercase">
                              {profile.source}
                            </span>
                          ) : null}

                          {/* Status Badge */}
                          {isExpired ? (
                            <span className="bg-red-500 text-white text-[10px] font-black px-2.5 py-1 rounded-md shadow-lg shadow-red-500/40 flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" />
                              EXPIRED
                            </span>
                          ) : hasMoved ? (
                            <span className="bg-cyan-500 text-black text-[10px] font-black px-2.5 py-1 rounded-md shadow-lg shadow-cyan-500/40 flex items-center gap-1">
                              <Navigation className="w-3 h-3" />
                              MOVED
                            </span>
                          ) : (
                            <span className="bg-emerald-500 text-black text-[10px] font-black px-2.5 py-1 rounded-md shadow-lg shadow-emerald-500/40 flex items-center gap-1">
                              <ShieldCheck className="w-3 h-3" />
                              ACTIVE
                            </span>
                          )}
                        </div>

                        {/* Top Action Buttons (Download, Delete) */}
                        <div className="absolute top-3 right-3 flex items-center gap-1.5 z-10 opacity-90 group-hover:opacity-100 transition-opacity">
                          {currentImg && (
                            <button
                              onClick={() => onDownloadImage(currentImg, `${profile.title.slice(0, 20)}.jpg`)}
                              className="p-2 rounded-xl bg-black/60 hover:bg-emerald-500 text-white transition-all backdrop-blur-md border border-white/10 cursor-pointer"
                              title="Download photo"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            onClick={() => {
                              if (window.confirm("Remove this profile from saved archive?")) {
                                onDeleteProfile(profile.id);
                              }
                            }}
                            className="p-2 rounded-xl bg-black/60 hover:bg-red-500 text-white transition-all backdrop-blur-md border border-white/10 cursor-pointer"
                            title="Remove from archive"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full text-white/20">
                        <Search className="w-10 h-10 mb-2" />
                        <span className="text-[10px] uppercase font-mono tracking-widest">No Photos</span>
                      </div>
                    )}
                  </div>

                  {/* Card Content */}
                  <div className="p-5 space-y-4">
                    {/* Title & External Link */}
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-bold text-base sm:text-lg text-white group-hover:text-emerald-400 transition-colors line-clamp-2 leading-snug">
                          {profile.title}
                        </h3>
                        {profile.link && (
                          <a
                            href={profile.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 rounded-lg text-white/40 hover:text-emerald-400 hover:bg-white/5 transition-all shrink-0 mt-0.5"
                            title="Open original website ad"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        )}
                      </div>

                      {/* Location, Price & Date */}
                      <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
                        {profile.location && (
                          <span className="flex items-center gap-1 text-white/60">
                            <MapPin className="w-3 h-3 text-emerald-400" />
                            <span>{profile.location}</span>
                          </span>
                        )}
                        {profile.price && profile.price !== "N/A" && (
                          <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-bold">
                            {profile.price}
                          </span>
                        )}
                        {profile.date && (
                          <span className="text-white/40 text-[11px]">
                            {profile.date}
                          </span>
                        )}
                      </div>

                      {/* Location Change Movement Badge if detected */}
                      {hasMoved && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[11px] font-bold mt-2">
                          <Compass className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          <span className="truncate">
                            Location Changed: {profile.locationHistory && profile.locationHistory.length >= 2
                              ? profile.locationHistory.map(h => h.location).join(" ➔ ")
                              : profile.changeHistory?.find(c => c.change.toLowerCase().includes("location changed"))?.change || "Moved city"}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Prominent Phone Box */}
                    <div className="p-3.5 rounded-2xl bg-black/40 border border-white/10 space-y-2.5">
                      <div className="flex items-center justify-between text-xs text-white/50">
                        <span className="uppercase tracking-wider font-semibold flex items-center gap-1.5 text-[10px]">
                          <Phone className="w-3 h-3 text-emerald-400" />
                          Phone Number
                        </span>
                        {profile.revealedPhone && /\d{4}/.test(profile.revealedPhone) && (
                          <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                            Verified
                          </span>
                        )}
                      </div>

                      {profile.revealedPhone && /\d{4}/.test(profile.revealedPhone) ? (
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-lg font-black text-emerald-400 tracking-wider">
                            {profile.revealedPhone?.replace(/\s+/g, '')}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => copyToClipboard((profile.revealedPhone || '').replace(/\s+/g, ''), `phone-${profile.id}`)}
                              className="p-2 rounded-xl bg-white/5 hover:bg-emerald-500 hover:text-black text-white/80 transition-all cursor-pointer"
                              title="Copy phone"
                            >
                              {copiedId === `phone-${profile.id}` ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                            </button>
                            <a
                              href={`tel:${profile.revealedPhone.replace(/\s+/g, '')}`}
                              className="p-2 rounded-xl bg-emerald-500/20 hover:bg-emerald-500 text-emerald-300 hover:text-black transition-all"
                              title="Call"
                            >
                              <PhoneCall className="w-4 h-4" />
                            </a>
                          </div>
                        </div>
                      ) : profile.phoneImage ? (
                        <div className="flex items-center justify-between gap-2">
                          <img 
                            src={profile.phoneImage} 
                            alt="Phone number" 
                            className="h-7 object-contain bg-white rounded px-2"
                          />
                          <span className="text-[10px] text-white/40 italic">Image format</span>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between text-white/40 text-xs">
                          <span>{(profile.phoneNumber || 'Not revealed').replace(/\s+/g, '')}</span>
                        </div>
                      )}

                      {/* Location change check shortcut */}
                      {(profile.revealedPhone || profile.phoneNumber) && (
                        <div className="pt-2 border-t border-white/5 flex items-center justify-between">
                          <button
                            onClick={() => {
                              const ph = (profile.revealedPhone || profile.phoneNumber || "").replace(/\s+/g, '');
                              if (ph) {
                                setLocationCheckPhone(ph);
                                if (profile.location && profile.location !== "Locație nespecificată") {
                                  setLocationCheckExpectedCity(profile.location);
                                }
                                setShowLocationChecker(true);
                                handleRunLocationCheck(ph);
                                window.scrollTo({ top: 0, behavior: 'smooth' });
                              }
                            }}
                            className="text-[10px] font-bold text-cyan-400 hover:text-cyan-300 flex items-center gap-1 cursor-pointer hover:underline"
                            title="Verify if this phone has moved locations across ads"
                          >
                            <Navigation className="w-3 h-3" />
                            <span>Check Location History & API</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Description preview */}
                    {profile.description && (
                      <div className="text-xs text-white/60 leading-relaxed">
                        <p className={expandedDescId === profile.id ? '' : 'line-clamp-2'}>
                          {profile.description}
                        </p>
                        {profile.description.length > 90 && (
                          <button
                            onClick={() => setExpandedDescId(expandedDescId === profile.id ? null : profile.id)}
                            className="text-[10px] text-emerald-400/80 hover:text-emerald-300 font-semibold mt-1 cursor-pointer"
                          >
                            {expandedDescId === profile.id ? 'Show less' : 'Show full description'}
                          </button>
                        )}
                      </div>
                    )}

                    {/* Notes field */}
                    <div className="pt-2 border-t border-white/5">
                      {isEditingNote ? (
                        <div className="space-y-2">
                          <textarea
                            value={noteDraft}
                            onChange={(e) => setNoteDraft(e.target.value)}
                            placeholder="Add private note (e.g. called, verified, status)..."
                            className="w-full bg-black/60 border border-emerald-500/40 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-emerald-400 resize-none h-16"
                          />
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => setEditingNoteId(null)}
                              className="px-2.5 py-1 rounded-lg text-xs text-white/50 hover:text-white"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => onSaveNote(profile.id, noteDraft)}
                              className="px-3 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-xs cursor-pointer"
                            >
                              Save Note
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div 
                          onClick={() => {
                            setNoteDraft(profile.notes || '');
                            setEditingNoteId(profile.id);
                          }}
                          className="flex items-start justify-between gap-2 p-2 rounded-xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/5 cursor-pointer text-xs transition-colors"
                        >
                          <div className="flex items-center gap-1.5 text-white/50">
                            <FileText className="w-3.5 h-3.5 text-emerald-400/60 shrink-0" />
                            <span className={profile.notes ? 'text-white/80 italic line-clamp-1' : 'text-white/30 italic'}>
                              {profile.notes || 'Click to add personal note...'}
                            </span>
                          </div>
                          <span className="text-[10px] text-emerald-400/60 font-semibold shrink-0">Edit</span>
                        </div>
                      )}
                    </div>

                    {/* Copy JSON Button */}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleCopySavedJson(profile); }}
                      title="Copy Archived Profile as JSON"
                      className="w-full mt-3 text-[10px] uppercase tracking-widest py-2.5 rounded-xl border bg-white/5 hover:bg-white/10 text-white/50 hover:text-white border-white/10 transition-all flex items-center justify-center gap-1.5 font-bold cursor-pointer"
                    >
                      {copiedId === `saved-json-${profile.id}` ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-emerald-400">COPIED ARCHIVE JSON</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>COPY JSON</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Footer Action: UPDATE TO LATEST BUTTON */}
                <div className="p-5 pt-0 mt-2">
                  {feedback && (
                    <div className={`mb-3 p-2.5 rounded-xl text-xs font-semibold flex items-center gap-2 animate-fadeIn ${
                      feedback.type === 'warning' 
                        ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20' 
                        : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                    }`}>
                      <Sparkles className="w-3.5 h-3.5 shrink-0" />
                      <span className="line-clamp-2">{feedback.message}</span>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-3 text-xs text-white/40 mb-3 px-1">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Updated: {formatTimestamp(profile.lastUpdatedAt)}
                    </span>
                    {profile.lastCheckedStatus && (
                      <span className="text-[10px] truncate max-w-[140px]" title={profile.lastCheckedStatus}>
                        {profile.lastCheckedStatus}
                      </span>
                    )}
                  </div>

                  <button
                    onClick={() => onUpdateProfile(profile)}
                    disabled={isUpdating}
                    className="w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-black font-black text-sm tracking-wide shadow-lg shadow-emerald-500/20 hover:shadow-emerald-500/35 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                  >
                    <RefreshCcw className={`w-4 h-4 ${isUpdating ? 'animate-spin' : ''}`} />
                    <span>{isUpdating ? 'Checking live ad on website...' : 'Update to Latest'}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Bottom Pagination Controls */}
      {!loadingSaved && savedProfiles.length > 0 && totalPages > 1 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-white/5 border border-white/10 rounded-2xl px-6 py-4 backdrop-blur-md mt-8">
          <span className="text-xs text-white/60">
            Pagina <strong className="text-white font-mono">{safePage}</strong> din <strong className="text-white font-mono">{totalPages}</strong> ({savedProfiles.length} anunțuri afișate {isFilterActive ? `din ${savedCount} total în arhivă` : 'în arhivă'})
          </span>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setCurrentPage(prev => Math.max(1, prev - 1));
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              disabled={safePage <= 1}
              className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold text-white transition-all cursor-pointer flex items-center gap-1.5"
            >
              <ChevronLeft className="w-4 h-4" />
              Pagina Anterioară
            </button>

            <button
              onClick={() => {
                setCurrentPage(prev => Math.min(totalPages, prev + 1));
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              disabled={safePage >= totalPages}
              className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold text-white transition-all cursor-pointer flex items-center gap-1.5"
            >
              Pagina Următoare
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

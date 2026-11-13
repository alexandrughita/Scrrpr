import React from 'react';
import { 
  Activity, Play, Pause, Clock, Database, Calendar, ShieldCheck, 
  CheckCircle2, RefreshCcw, Terminal, ChevronDown, ChevronUp, Zap, Sparkles, ExternalLink
} from 'lucide-react';

interface BursaCrawlerViewProps {
  crawlerState: any;
  crawlerActionLoading: boolean;
  onStartCrawler: () => void;
  onPauseCrawler: () => void;
  onResumeCrawler: () => void;
  onToggleCrawler: () => void;
  onClearLogs: () => void;
  onRefresh: () => void;
  onGoToDatabase: () => void;
  savedCount: number;
}

export const BursaCrawlerView: React.FC<BursaCrawlerViewProps> = ({
  crawlerState,
  crawlerActionLoading,
  onStartCrawler,
  onPauseCrawler,
  onResumeCrawler,
  onToggleCrawler,
  onClearLogs,
  onRefresh,
  onGoToDatabase,
  savedCount
}) => {
  const [showLogs, setShowLogs] = React.useState<boolean>(true);

  const formatCountdown = (targetTs?: number) => {
    if (!targetTs) return 'În curând...';
    const diff = targetTs - Date.now();
    if (diff <= 0) return 'Scanează în curând...';
    const days = Math.floor(diff / (24 * 3600 * 1000));
    const hours = Math.floor((diff % (24 * 3600 * 1000)) / (3600 * 1000));
    const mins = Math.floor((diff % (3600 * 1000)) / (60 * 1000));
    if (days > 0) return `peste ${days}z ${hours}h`;
    if (hours > 0) return `peste ${hours}h ${mins}m`;
    return `peste ${mins}m`;
  };

  const isRunning = crawlerState?.status === 'running';
  const isPaused = crawlerState?.status === 'paused';
  const isEnabled = crawlerState?.enabled ?? true;
  const currentCount = crawlerState?.databaseCapacity?.current ?? savedCount;
  const maxCapacity = crawlerState?.databaseCapacity?.max ?? 5000;
  const capacityPercent = crawlerState?.databaseCapacity?.percent ?? Math.min(100, Number(((currentCount / maxCapacity) * 100).toFixed(1)));

  return (
    <div className="space-y-8 animate-fadeIn max-w-7xl mx-auto">
      {/* Hero Banner Card */}
      <div className="relative overflow-hidden bg-gradient-to-r from-emerald-950/70 via-[#101413] to-cyan-950/70 border-2 border-emerald-500/30 rounded-3xl p-6 sm:p-10 shadow-2xl backdrop-blur-xl">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6 pb-8 border-b border-emerald-500/20">
          <div className="flex items-start sm:items-center gap-4">
            <div className="p-4 rounded-3xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shadow-xl shadow-emerald-500/10">
              <Activity className={`w-8 h-8 ${isRunning ? 'animate-pulse text-emerald-300' : ''}`} />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2.5 mb-1.5">
                <h2 className="text-2xl sm:text-4xl font-black text-white tracking-tight">
                  Auto-Crawler Săptămânal Bursa Plăcerilor
                </h2>
                {/* Status Badges */}
                {isRunning ? (
                  <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-black bg-emerald-400 text-black shadow-lg shadow-emerald-500/30 animate-pulse">
                    <span className="w-2.5 h-2.5 rounded-full bg-black"></span>
                    SCANARE ÎN CURS (PAG. {crawlerState?.currentPage || 1}/{crawlerState?.maxPages || 400})
                  </span>
                ) : isPaused ? (
                  <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                    <Pause className="w-3.5 h-3.5" />
                    ÎN PAUZĂ
                  </span>
                ) : isEnabled ? (
                  <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    <Clock className="w-3.5 h-3.5" />
                    PROGRAMAT LA 7 ZILE
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-bold bg-white/10 text-white/50 border border-white/10">
                    DEZACTIVAT
                  </span>
                )}
              </div>
              <p className="text-white/70 text-sm sm:text-base max-w-2xl leading-relaxed">
                Scanare ciclică la fiecare 7 zile • 1 singur număr de telefon per profil • 0 anunțuri trans/ts • Până la 5.000 anunțuri unice • Protecție anti-blocare (2.2s – 3.5s).
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-3 self-stretch lg:self-auto justify-end">
            {isRunning ? (
              <button
                onClick={onPauseCrawler}
                disabled={crawlerActionLoading}
                className="flex items-center gap-2.5 px-6 py-3.5 rounded-2xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs sm:text-sm font-black transition-all cursor-pointer shadow-lg disabled:opacity-50"
              >
                <Pause className="w-4 h-4" />
                <span>Pauză Scanare</span>
              </button>
            ) : isPaused ? (
              <button
                onClick={onResumeCrawler}
                disabled={crawlerActionLoading}
                className="flex items-center gap-2.5 px-6 py-3.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-black text-xs sm:text-sm font-black transition-all cursor-pointer shadow-lg shadow-emerald-500/25 disabled:opacity-50 scale-105"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>Reia Scanarea</span>
              </button>
            ) : (
              <button
                onClick={onStartCrawler}
                disabled={crawlerActionLoading}
                className="flex items-center gap-2.5 px-6 py-3.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-black text-xs sm:text-sm font-black transition-all cursor-pointer shadow-lg shadow-emerald-500/25 disabled:opacity-50 scale-105"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>Pornește Scanarea Acum</span>
              </button>
            )}

            {/* Weekly Auto-Schedule Switch */}
            <button
              onClick={onToggleCrawler}
              disabled={crawlerActionLoading}
              className={`flex items-center gap-2.5 px-5 py-3.5 rounded-2xl text-xs sm:text-sm font-bold transition-all cursor-pointer border ${
                isEnabled 
                  ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/20' 
                  : 'bg-white/5 text-white/50 border-white/10 hover:bg-white/10'
              }`}
            >
              <Clock className="w-4 h-4 text-emerald-400" />
              <span>Auto-Scan la 7 Zile:</span>
              <span className={`px-2 py-0.5 rounded-lg text-xs font-mono font-black ${
                isEnabled ? 'bg-emerald-400 text-black' : 'bg-white/20 text-white/70'
              }`}>
                {isEnabled ? 'ACTIVAT' : 'OPRIT'}
              </span>
            </button>

            {/* Go to Saved Database */}
            <button
              onClick={onGoToDatabase}
              className="flex items-center gap-2 px-5 py-3.5 rounded-2xl bg-white/5 hover:bg-white/10 text-white/80 hover:text-white border border-white/10 text-xs sm:text-sm font-bold transition-all cursor-pointer"
            >
              <Database className="w-4 h-4 text-emerald-400" />
              <span>Bază de Date ({currentCount})</span>
            </button>
          </div>
        </div>

        {/* 3 Metric Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-8">
          {/* 5,000 Ads Database Capacity Card */}
          <div className="p-6 rounded-3xl bg-black/50 border border-emerald-500/20 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-black text-emerald-400 uppercase tracking-wider flex items-center gap-2">
                  <Database className="w-4 h-4" />
                  Capacitate Bază de Date
                </span>
                <span className="text-xs font-mono font-black text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/20">
                  {capacityPercent}%
                </span>
              </div>
              <div className="flex items-baseline gap-2 mb-3">
                <span className="text-3xl sm:text-4xl font-black text-white font-mono">
                  {currentCount.toLocaleString()}
                </span>
                <span className="text-sm font-bold text-white/40">
                  / {maxCapacity.toLocaleString()} anunțuri max
                </span>
              </div>
              <div className="w-full bg-white/10 rounded-full h-3 overflow-hidden p-0.5 border border-white/5">
                <div 
                  className="bg-gradient-to-r from-emerald-500 via-teal-400 to-cyan-400 h-full rounded-full transition-all duration-500 shadow-md shadow-emerald-500/30"
                  style={{ width: `${Math.min(100, Math.max(2, capacityPercent))}%` }}
                />
              </div>
            </div>
            <p className="text-xs text-white/50 mt-4 leading-relaxed">
              Baza este limitată strict la cele mai proaspete 5.000 de anunțuri unice. Dacă se depășește limita, anunțurile vechi sunt curățate automat.
            </p>
          </div>

          {/* Schedule & Timing Card */}
          <div className="p-6 rounded-3xl bg-black/50 border border-emerald-500/20 flex flex-col justify-between">
            <div>
              <span className="text-xs font-black text-cyan-400 uppercase tracking-wider flex items-center gap-2 mb-3">
                <Calendar className="w-4 h-4" />
                Program Săptămânal (7 Zile)
              </span>
              <div className="space-y-2 text-xs sm:text-sm">
                <div className="flex items-center justify-between py-1 border-b border-white/5">
                  <span className="text-white/50">Următoarea scanare:</span>
                  <span className="font-mono font-bold text-white">
                    {isRunning 
                      ? 'Scanare activă acum' 
                      : crawlerState?.nextRunScheduled 
                        ? `${new Date(crawlerState.nextRunScheduled).toLocaleDateString('ro-RO')} (${formatCountdown(crawlerState.nextRunScheduled)})` 
                        : 'În curând'}
                  </span>
                </div>
                <div className="flex items-center justify-between py-1 border-b border-white/5">
                  <span className="text-white/50">Ultima rulare finalizată:</span>
                  <span className="font-mono text-white/80">
                    {crawlerState?.lastRunFinished 
                      ? new Date(crawlerState.lastRunFinished).toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) 
                      : 'Prima rulare'}
                  </span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-white/50">Frecvență scanare:</span>
                  <span className="font-mono font-bold text-emerald-400">La fiecare 7 zile</span>
                </div>
              </div>
            </div>
            <p className="text-xs text-white/50 mt-4 leading-relaxed">
              Cron-ul rulează în fundal pe server și sincronizează automat Bursa Plăcerilor fără a necesita pagina deschisă.
            </p>
          </div>

          {/* Strict Anti-Block & Compliance Card */}
          <div className="p-6 rounded-3xl bg-black/50 border border-emerald-500/20 flex flex-col justify-between">
            <div>
              <span className="text-xs font-black text-emerald-400 uppercase tracking-wider flex items-center gap-2 mb-3">
                <ShieldCheck className="w-4 h-4" />
                Reguli Active de Filtrare
              </span>
              <div className="space-y-2 text-xs sm:text-sm">
                <div className="flex items-center gap-2.5 text-white/90">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span><strong>1 Număr per Profil:</strong> Fără telefoane duplicate</span>
                </div>
                <div className="flex items-center gap-2.5 text-white/90">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span><strong>0 Trans / TS:</strong> Filtrare 100% trans/femei</span>
                </div>
                <div className="flex items-center gap-2.5 text-white/90">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span><strong>Anti-Block:</strong> 2.2s – 3.5s pauză per cerere</span>
                </div>
              </div>
            </div>
            <p className="text-xs text-white/50 mt-4 leading-relaxed">
              Fiecare cerere folosește antete de browser desktop reale pentru a preveni blocarea sau limitarea de către Cloudflare.
            </p>
          </div>
        </div>

        {/* Live Running Status Banner */}
        {isRunning && (
          <div className="mt-6 p-5 sm:p-6 rounded-3xl bg-emerald-950/60 border-2 border-emerald-500/50 shadow-xl shadow-emerald-500/10">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-3">
              <div className="flex items-center gap-3">
                <RefreshCcw className="w-5 h-5 text-emerald-400 animate-spin" />
                <span className="text-sm font-black text-emerald-300">
                  {crawlerState?.currentStatusMessage || 'Scanare în desfășurare...'}
                </span>
              </div>
              <div className="flex items-center gap-4 text-xs font-mono font-bold">
                <span className="px-2.5 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  +{crawlerState?.stats?.adsAdded || 0} noi
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                  {crawlerState?.stats?.adsUpdated || 0} actualizate
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  {crawlerState?.stats?.adsExcluded || 0} excluse
                </span>
              </div>
            </div>
            <div className="w-full bg-black/60 rounded-full h-2.5 overflow-hidden border border-white/5">
              <div 
                className="bg-emerald-400 h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.min(100, Math.max(3, ((crawlerState?.currentPage || 1) / (crawlerState?.maxPages || 400)) * 100))}%` }}
              />
            </div>
          </div>
        )}

        {/* Terminal Logs View */}
        <div className="mt-8 pt-6 border-t border-emerald-500/20">
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => setShowLogs(!showLogs)}
              className="flex items-center gap-2 text-xs sm:text-sm font-mono font-bold text-emerald-400 hover:text-emerald-300 cursor-pointer"
            >
              <Terminal className="w-4 h-4" />
              <span>Jurnal Live de Scanare Bursa Plăcerilor ({crawlerState?.logs?.length || 0} evenimente)</span>
              {showLogs ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            <div className="flex items-center gap-3">
              <button
                onClick={onRefresh}
                className="text-xs text-white/60 hover:text-white flex items-center gap-1 cursor-pointer"
              >
                <RefreshCcw className="w-3 h-3" />
                <span>Reîmprospătează</span>
              </button>
              <button
                onClick={onClearLogs}
                className="text-xs text-white/40 hover:text-red-400 underline cursor-pointer"
              >
                Curăță Jurnalul
              </button>
            </div>
          </div>

          {showLogs && (
            <div className="bg-black/90 border border-white/10 rounded-2xl p-4 font-mono text-xs max-h-72 overflow-y-auto space-y-2 scrollbar-thin scrollbar-thumb-white/20">
              {crawlerState?.logs && crawlerState.logs.length > 0 ? (
                crawlerState.logs.map((log: any, idx: number) => (
                  <div key={idx} className="flex items-start gap-2.5 leading-relaxed">
                    <span className="text-white/40 shrink-0">
                      [{new Date(log.timestamp).toLocaleTimeString('ro-RO')}]
                    </span>
                    <span className={`shrink-0 uppercase font-black text-[10px] px-1.5 py-0.5 rounded ${
                      log.type === 'error' ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                      log.type === 'warn' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' :
                      log.type === 'success' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
                      'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                    }`}>
                      {log.type}
                    </span>
                    <span className={`break-words ${
                      log.type === 'error' ? 'text-red-300' :
                      log.type === 'warn' ? 'text-amber-200' :
                      log.type === 'success' ? 'text-emerald-200' :
                      'text-white/80'
                    }`}>
                      {log.message}
                    </span>
                  </div>
                ))
              ) : (
                <div className="text-white/40 text-center py-6">Nu există înregistrări recente în jurnal.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

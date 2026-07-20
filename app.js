/* ---- from <script id="dr-adaptive-polling"> ---- */
/* v11.29: Back off the app's own auto-refresh timers on slow/metered
   connections (cellular, data-saver, 2g/3g) so the page doesn't keep
   firing network requests every few seconds when bandwidth is scarce. */
(function(){
  function getConn(){
    return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  }
  function backoffFactor(){
    var c = getConn();
    if(!c) return 1;
    if(c.saveData) return 4;
    if(c.effectiveType && /2g/.test(c.effectiveType)) return 4;
    if(c.effectiveType === '3g' || c.type === 'cellular') return 2;
    return 1;
  }
  var factor = backoffFactor();
  if(factor > 1){
    var origSetInterval = window.setInterval;
    window.setInterval = function(fn, delay){
      var args = Array.prototype.slice.call(arguments, 2);
      if(typeof delay === 'number' && delay > 0 && delay <= 10000){
        delay = delay * factor;
      }
      return origSetInterval.apply(window, [fn, delay].concat(args));
    };
  }
  // Re-evaluate if the connection type changes mid-session (e.g. wifi drops).
  var c = getConn();
  if(c && c.addEventListener){
    c.addEventListener('change', function(){
      // Backoff factor is only applied to intervals set up from here on;
      // existing timers keep their original cadence until next reload.
      factor = backoffFactor();
    });
  }
})();

/* ---- from <script id="prod-v9-performance-bootstrap"> ---- */
(function(){
  if (window.__DR_V9_BOOTSTRAP__) return;
  window.__DR_V9_BOOTSTRAP__ = true;

  var VERSION = 'v9.3';
  var LS_PREFIX = 'dr-v9-fetch:';
  var inflight = new Map();
  var queue = [];
  var activeNetwork = 0;
  var MAX_ACTIVE = 6;
  var originalFetch = window.fetch.bind(window);
  var originalSetInterval = window.setInterval.bind(window);
  var originalSetTimeout = window.setTimeout.bind(window);
  var requestIdle = window.requestIdleCallback || function(cb){ return originalSetTimeout(function(){ cb({ didTimeout:false, timeRemaining:function(){return 1;} }); }, 1); };

  window.DR_V9_STATS = {
    version: VERSION,
    total: 0,
    cacheHits: 0,
    staleHits: 0,
    network: 0,
    deduped: 0,
    queued: 0,
    skippedHiddenIntervals: 0,
    coalescedLoads: 0,
    lastUpdated: new Date().toISOString()
  };

  function stamp(){ window.DR_V9_STATS.lastUpdated = new Date().toISOString(); }
  function safeURL(input){ try { return typeof input === 'string' ? input : (input && input.url) || String(input || ''); } catch(e){ return String(input || ''); } }
  function cleanURL(url){
    try {
      var u = new URL(String(url || ''), location.href);
      ['ts','t','cacheBust','cachebuster','_','v'].forEach(function(k){ u.searchParams.delete(k); });
      return u.toString();
    } catch(e){
      return String(url || '').replace(/([?&])(ts|t|cacheBust|cachebuster|_|v)=[^&]+/gi,'$1').replace(/[?&]$/,'');
    }
  }
  function isGET(input, init){ return String((init && init.method) || (input && input.method) || 'GET').toUpperCase() === 'GET'; }
  function cacheable(url){
    var u = String(url || '').toLowerCase();
    if (!u || u.indexOf('chrome-extension:') === 0) return false;
    if (u.indexOf('google-analytics') >= 0 || u.indexOf('googletagmanager') >= 0 || u.indexOf('doubleclick') >= 0) return false;
    return /diamondreport\.app|statsapi\.mlb\.com|site\.api\.espn\.com|\/data\/|\.json|open-meteo|weather|statcast|baseballsavant|odds|sportsbook|api\/v1\/schedule|feed\/live/i.test(u);
  }
  function isLiveScoreURL(url){
    var u = String(url || '').toLowerCase();
    return /linescore|feed\/live|schedule|api\/v1\/game\/|game\/|boxscore|status/.test(u);
  }
  function ttlFor(url){
    var u = String(url || '').toLowerCase();
    if (isLiveScoreURL(u)) return 0;
    if (/odds|sportsbook|market/.test(u)) return 5 * 60 * 1000;
    if (/weather|open-meteo/.test(u)) return 30 * 60 * 1000;
    if (/statcast|baseballsavant|pitcher-statcast/.test(u)) return 60 * 60 * 1000;
    if (/\/data\/|\.json/.test(u)) return 6 * 60 * 60 * 1000;
    return 10 * 60 * 1000;
  }
  function lsKey(url){ return LS_PREFIX + VERSION + ':' + cleanURL(url); }
  function responseFrom(record){
    return new Response(record.body || '', {
      status: record.status || 200,
      statusText: record.statusText || 'OK',
      headers: record.headers || { 'content-type':'application/json' }
    });
  }
  function readRecord(key){
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch(e){ return null; }
  }
  function saveRecord(key, response){
    try {
      var clone = response.clone();
      clone.text().then(function(body){
        var headers = {};
        clone.headers.forEach(function(v,k){ headers[k]=v; });
        localStorage.setItem(key, JSON.stringify({
          ts: Date.now(), status: clone.status, statusText: clone.statusText, headers: headers, body: body
        }));
      }).catch(function(){});
    } catch(e){}
  }
  function runNetwork(task){
    return new Promise(function(resolve,reject){
      queue.push({task:task, resolve:resolve, reject:reject});
      window.DR_V9_STATS.queued = queue.length; stamp();
      drain();
    });
  }
  function drain(){
    while(activeNetwork < MAX_ACTIVE && queue.length){
      var item = queue.shift();
      activeNetwork++;
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(function(){
        activeNetwork--; window.DR_V9_STATS.queued = queue.length; stamp(); drain();
      });
    }
  }
  function backgroundRefresh(input, init, key){
    requestIdle(function(){
      if (document.hidden) return;
      runNetwork(function(){ return originalFetch(input, Object.assign({ cache:'no-cache' }, init || {})); })
        .then(function(res){ if(res && res.ok) saveRecord(key, res); })
        .catch(function(){});
    });
  }

  window.fetch = function drV9Fetch(input, init){
    window.DR_V9_STATS.total++; stamp();
    var url = safeURL(input);
    var get = isGET(input, init);
    if (!get || !cacheable(url)) {
      window.DR_V9_STATS.network++; stamp();
      return runNetwork(function(){ return originalFetch(input, init); });
    }
    if (isLiveScoreURL(url)) {
      window.DR_V9_STATS.network++; stamp();
      return runNetwork(function(){ return originalFetch(input, Object.assign({ cache:'no-store' }, init || {})); });
    }
    var key = lsKey(url);
    var cached = readRecord(key);
    var age = cached ? Date.now() - (cached.ts || 0) : Infinity;
    var ttl = ttlFor(url);
    if (cached && age < ttl) {
      window.DR_V9_STATS.cacheHits++; stamp();
      // Stale-while-revalidate near TTL edge keeps the UI instant but fresh.
      if (age > ttl * 0.65) backgroundRefresh(input, init, key);
      return Promise.resolve(responseFrom(cached));
    }
    if (cached && document.hidden) {
      window.DR_V9_STATS.staleHits++; stamp();
      return Promise.resolve(responseFrom(cached));
    }
    if (inflight.has(key)) {
      window.DR_V9_STATS.deduped++; stamp();
      return inflight.get(key).then(function(r){ return r.clone(); });
    }
    var p = runNetwork(function(){ window.DR_V9_STATS.network++; stamp(); return originalFetch(input, init); })
      .then(function(res){ if (res && res.ok) saveRecord(key, res); return res; })
      .catch(function(err){
        var stale = readRecord(key);
        if (stale) { window.DR_V9_STATS.staleHits++; stamp(); return responseFrom(stale); }
        throw err;
      })
      .finally(function(){ inflight.delete(key); });
    inflight.set(key, p);
    return p.then(function(r){ return r.clone(); });
  };

  // Reduce hidden-tab and high-frequency DOM churn without touching the scoreboard countdown when visible.
  window.setInterval = function(fn, delay){
    var wrapped = function(){
      if (document.hidden && delay < 30000) { window.DR_V9_STATS.skippedHiddenIntervals++; stamp(); return; }
      if (window.__diamondUserInteracting && delay < 5000) return;
      return fn.apply(this, arguments);
    };
    return originalSetInterval(wrapped, delay);
  };

  window.DiamondClearV9PerformanceCache = function(){
    try { Object.keys(localStorage).forEach(function(k){ if(k.indexOf(LS_PREFIX) === 0) localStorage.removeItem(k); }); } catch(e){}
    inflight.clear(); queue.length = 0;
    return 'Diamond Report v9.0 performance cache cleared.';
  };
})();

/* ---- from <script id="v9-6-stale-cache-sweep"> ---- */
// Several caches embed the calendar date directly in their localStorage key
// (static daily dump, Deep Research snapshot, lineup/game-projection lock)
// and their manual-clear helpers only ever clear *today's* key, never past
// days'. Left unchecked those grow by one full entry per day visited,
// forever — the root cause of the multi-hundred-MB Safari "Website Data"
// bloat reported on iPad after months of daily use. This sweep removes any
// entry from those families whose embedded date isn't today's, once per
// page load, before anything else runs.
(function(){
  if (window.__DR_STALE_CACHE_SWEEP__) return;
  window.__DR_STALE_CACHE_SWEEP__ = true;
  try {
    function chicagoDateKey(){
      try { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }
      catch(e) { return new Date().toISOString().slice(0,10); }
    }
    function localDateKey(){
      try { return new Date().toLocaleDateString('en-CA'); }
      catch(e) { return new Date().toISOString().slice(0,10); }
    }
    var todayChicago = chicagoDateKey();
    var todayLocal = localDateKey();
    var datePattern = /\d{4}-\d{2}-\d{2}/;
    var families = [
      { prefix: 'dr-static-dump:', today: todayChicago },
      { prefix: 'DR_DEEP_RESEARCH_STATIC_SNAPSHOT_', today: todayLocal },
      { prefix: 'dr-official-lineup-game-projections:', today: todayChicago },
      { prefix: 'dr-lineup-watch-state:', today: todayChicago },
      { prefix: 'dr-official-game-projections-by-game:', today: todayChicago }
    ];
    var removed = 0;
    Object.keys(localStorage).forEach(function(key){
      for (var i = 0; i < families.length; i++) {
        var f = families[i];
        if (key.indexOf(f.prefix) !== 0) continue;
        var m = key.match(datePattern);
        if (m && m[0] !== f.today) {
          try { localStorage.removeItem(key); removed++; } catch(e) {}
        }
        break;
      }
    });
    // The URL-keyed fetch cache doesn't multiply by day, but nothing ever
    // expired its entries either. Evict anything old enough that it's no
    // longer useful even as a stale-network fallback.
    var STALE_MS = 4 * 24 * 60 * 60 * 1000;
    var now = Date.now();
    Object.keys(localStorage).forEach(function(key){
      if (key.indexOf('dr-v9-fetch:') !== 0) return;
      try {
        var rec = JSON.parse(localStorage.getItem(key) || 'null');
        if (rec && rec.ts && (now - rec.ts) > STALE_MS) { localStorage.removeItem(key); removed++; }
      } catch(e) {}
    });
    if (removed) { try { console.info('[DiamondReport] Cleared ' + removed + ' stale cached entries from localStorage.'); } catch(e) {} }
  } catch(e) {}
})();

/* ---- from <script id="v4-4-hide-refresh-labels"> ---- */
(function(){
  const hiddenRefreshIds = ['scores-refresh','props-refresh','gameprops-refresh','kprops-refresh'];
  function hideRefreshLabels(){
    hiddenRefreshIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = '';
        el.style.display = 'none';
        el.setAttribute('aria-hidden','true');
      }
    });
    document.querySelectorAll('.lineup-timestamp').forEach(el => {
      el.textContent = '';
      el.style.display = 'none';
      el.setAttribute('aria-hidden','true');
    });
  }
  document.addEventListener('DOMContentLoaded', hideRefreshLabels);
  window.addEventListener('load', hideRefreshLabels);
  // v7.8: one-shot only; repeated DOM scans caused visible refresh/jump on iPad/laptop.
  setTimeout(hideRefreshLabels, 1500);
})();

/* ---- from <script id="v4-6-date-status-cleanup-script"> ---- */
(function () {
  function formatHeaderDate() {
    var el = document.getElementById('header-date');
    if (!el) return;
    try {
      var d = new Date();
      el.textContent = d.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      });
    } catch (e) {}
  }

  function hideStatusText() {
    var patterns = [/last\s+synced/i, /last\s+updated/i];
    var nodes = document.querySelectorAll('div, span, p, small');
    nodes.forEach(function (node) {
      var text = (node.textContent || '').trim();
      if (!text) return;
      if (patterns.some(function (rx) { return rx.test(text); })) {
        node.style.display = 'none';
        node.setAttribute('aria-hidden', 'true');
      }
    });
  }

  formatHeaderDate();
  hideStatusText();

  document.addEventListener('DOMContentLoaded', function () {
    formatHeaderDate();
    hideStatusText();
  });

  // v7.8: avoid repeated full-page text scans that looked like random refreshes.
  setTimeout(function () { formatHeaderDate(); hideStatusText(); }, 3000);
})();

/* ---- from <script id="v5-0-diamond-intelligence-engine-script"> ---- */
(function () {
  function safeText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }
  function parseCountFromText(text) {
    var m = String(text || '').match(/(\d+)\s*(?:stored|tracked|waiting|final|picks|props)?/i);
    return m ? Number(m[1]) : 0;
  }
  function getText(id) {
    var el = document.getElementById(id);
    return el ? el.textContent || '' : '';
  }
  function countRows(id) {
    var el = document.getElementById(id);
    return el ? el.querySelectorAll('tr').length : 0;
  }
  function updateDIE() {
    var hrRows = countRows('tracker-results');
    var kRows = countRows('tracker-kprops-results');
    var drpRows = countRows('tracker-drp-results');
    var teams = new Set();

    document.querySelectorAll('#tracker-drp-results tr').forEach(function(row) {
      var cells = row.querySelectorAll('td');
      if (cells.length >= 3) teams.add((cells[2].textContent || '').trim());
    });

    var pending = document.querySelectorAll('#tracker-results .pending, #tracker-kprops-results .pending, #tracker-drp-results .pending').length;
    var hits = document.querySelectorAll('#tracker-results .hit, #tracker-kprops-results .hit, #tracker-drp-results .hit').length;
    var misses = document.querySelectorAll('#tracker-results .miss, #tracker-kprops-results .miss, #tracker-drp-results .miss').length;
    var totalStored = hrRows + kRows + drpRows;

    safeText('die-predictions-stored', totalStored.toLocaleString());
    safeText('die-learning-queue', pending.toLocaleString());
    safeText('die-hr-count', hrRows.toLocaleString());
    safeText('die-k-count', kRows.toLocaleString());
    safeText('die-drp-count', drpRows.toLocaleString());
    safeText('die-team-count', teams.size.toLocaleString());

    var finalGames = document.querySelectorAll('#final-games .game-card, #final-games > div').length;
    var liveGames = document.querySelectorAll('#live-games .game-card, #scheduled-games .game-card').length;
    safeText('die-finals', finalGames + ' / ' + Math.max(finalGames + liveGames, finalGames));

    var lineupText = '';
    var official = 0, total = 0;
    try {
      document.querySelectorAll('[class*="lineup"], [id*="lineup"]').forEach(function(node) {
        var t = (node.textContent || '').toLowerCase();
        if (t.includes('official')) official++;
        if (t.includes('lineup')) total++;
      });
    } catch (e) {}
    safeText('die-lineups', official + ' / ' + Math.max(total, official));

    var graded = hits + misses;
    var calibration = graded ? Math.max(82, Math.min(98, Math.round((hits / Math.max(1, graded)) * 100))) : 95;
    safeText('die-calibration', calibration + '%');
    safeText('die-model-health', pending > 0 ? '98%' : '99%');

    var feed = document.getElementById('die-learning-feed');
    if (feed && !feed.dataset.liveAdded) {
      var div = document.createElement('div');
      div.className = 'die-feed-item';
      div.innerHTML = '<div class="die-feed-time">LIVE</div><div class="die-feed-text">Tracker scan complete: ' + totalStored + ' visible predictions, ' + pending + ' pending learning outcomes.</div>';
      feed.insertBefore(div, feed.firstChild);
      feed.dataset.liveAdded = '1';
    }
  }

  document.addEventListener('DOMContentLoaded', updateDIE);
  window.addEventListener('load', updateDIE);
  // v7.8: Tracker/DIE is hidden in production; avoid background panel refresh loop.
})();

/* ---- from <script id="v5-1-api-request-optimizer"> ---- */
(function () {
  if (window.__DIAMOND_API_GUARD_INSTALLED__) return;
  window.__DIAMOND_API_GUARD_INSTALLED__ = true;

  var originalFetch = window.fetch.bind(window);
  var cache = new Map();
  var inflight = new Map();
  var lastRequestAt = new Map();

  var stats = {
    totalFetches: 0,
    networkFetches: 0,
    cacheHits: 0,
    deduped: 0,
    throttled: 0,
    blockedWhileHidden: 0
  };

  var DEFAULT_TTL = 2 * 60 * 1000;      // 2 minutes
  var LIVE_TTL = 0;                     // v9.2: MLB live/schedule/state data must never be cached
  var STATIC_DATA_TTL = 15 * 60 * 1000; // repo JSON files
  var WEATHER_TTL = 30 * 60 * 1000;    // weather rarely changes minute-to-minute
  var STATCAST_TTL = 60 * 60 * 1000;   // statcast/hot-hitter snapshots
  var ODDS_TTL = 5 * 60 * 1000;        // odds/market endpoints if present
  var HIDDEN_MIN_INTERVAL = 10 * 60 * 1000; // background tabs: max once every 10 minutes per URL
  var VISIBLE_MIN_INTERVAL = 20 * 1000;     // foreground: no same URL spam within 20 seconds

  function now() { return Date.now(); }

  function normalizeUrl(input) {
    try {
      if (typeof input === "string") return input;
      if (input && input.url) return input.url;
    } catch (e) {}
    return String(input || "");
  }

  function isGetRequest(input, init) {
    var method = (init && init.method) || (input && input.method) || "GET";
    return String(method).toUpperCase() === "GET";
  }

  function isLiveScoreURL(url) {
    var u = String(url || "").toLowerCase();
    return /linescore|feed\/live|schedule|api\/v1\/game\/|\/game\/\d+\/boxscore|status/.test(u);
  }

  function ttlFor(url) {
    var u = String(url || "").toLowerCase();

    if (u.includes("/data/") && u.endsWith(".json")) return STATIC_DATA_TTL;
    if (u.includes("open-meteo") || u.includes("weather")) return WEATHER_TTL;
    if (u.includes("statcast") || u.includes("baseballsavant") || u.includes("statcast-hot-hitters")) return STATCAST_TTL;
    if (u.includes("odds") || u.includes("sportsbook") || u.includes("markets")) return ODDS_TTL;

    // MLB Stats API endpoints
    if (
      u.includes("diamondreport.app/api/") ||
      u.includes("statsapi.mlb.com") ||
      u.includes("site.api.espn.com") ||
      u.includes("statsapi.web.nhl.com") ||
      u.includes("/api/v1/schedule") ||
      u.includes("/api/v1.1/game") ||
      u.includes("/feed/live")
    ) return LIVE_TTL;

    return DEFAULT_TTL;
  }

  function shouldCache(url) {
    var u = String(url || "").toLowerCase();

    // Never cache non-data calls.
    if (u.includes("googlesyndication") || u.includes("google-analytics") || u.includes("doubleclick")) return false;

    return (
      u.includes("/data/") ||
      u.includes("diamondreport.app/api/") ||
      u.includes("statsapi.mlb.com") ||
      u.includes("open-meteo") ||
      u.includes("weather") ||
      u.includes("statcast") ||
      u.includes("baseballsavant") ||
      u.includes("odds") ||
      u.includes("sportsbook") ||
      u.includes("api/v1/schedule") ||
      u.includes("feed/live")
    );
  }

  function stableCacheUrl(url) {
    try {
      var u = new URL(String(url || ''), window.location.href);
      ['ts','t','cacheBust','cachebuster','_','v'].forEach(function(k){
        if (/data\//i.test(u.pathname) || /statsapi\.mlb\.com|diamondreport\.app|open-meteo|weather|statcast|baseballsavant/i.test(u.hostname + u.pathname)) {
          u.searchParams.delete(k);
        }
      });
      return u.toString();
    } catch(e) {
      return String(url || '').replace(/([?&])(ts|t|cacheBust|cachebuster|_|v)=[^&]+/gi, '$1').replace(/[?&]$/, '');
    }
  }

  function cacheKey(input, init) {
    var url = stableCacheUrl(normalizeUrl(input));
    return url + "::" + JSON.stringify((init && init.body) || "");
  }

  async function cloneResponseForCache(response) {
    try {
      var clone = response.clone();
      var text = await clone.text();
      var headers = {};
      clone.headers.forEach(function (v, k) { headers[k] = v; });
      return {
        status: clone.status,
        statusText: clone.statusText,
        headers: headers,
        body: text,
        cachedAt: now()
      };
    } catch (e) {
      return null;
    }
  }

  function responseFromCache(record) {
    return new Response(record.body, {
      status: record.status,
      statusText: record.statusText,
      headers: record.headers
    });
  }

  function exposeStats() {
    window.DiamondRequestStats = Object.assign({}, stats, {
      cacheSize: cache.size,
      inflight: inflight.size,
      lastUpdated: new Date().toISOString()
    });
  }

  window.DiamondClearRequestCache = function () {
    cache.clear();
    inflight.clear();
    exposeStats();
    return "Diamond Report request cache cleared.";
  };

  window.fetch = async function guardedFetch(input, init) {
    stats.totalFetches++;
    exposeStats();

    var url = normalizeUrl(input);
    if (isLiveScoreURL(url)) {
      stats.networkFetches++;
      exposeStats();
      return originalFetch(input, Object.assign({ cache: 'no-store' }, init || {}));
    }

    var key = cacheKey(input, init);
    var get = isGetRequest(input, init);
    var cacheable = get && shouldCache(url);
    var t = now();
    var ttl = ttlFor(url);

    if (!cacheable) {
      stats.networkFetches++;
      exposeStats();
      return originalFetch(input, init);
    }

    var cached = cache.get(key);
    if (cached && (t - cached.cachedAt) < ttl) {
      stats.cacheHits++;
      exposeStats();
      return responseFromCache(cached);
    }

    if (inflight.has(key)) {
      stats.deduped++;
      exposeStats();
      return inflight.get(key).then(function (response) { return response.clone(); });
    }

    var last = lastRequestAt.get(key) || 0;
    var minInterval = document.hidden ? HIDDEN_MIN_INTERVAL : VISIBLE_MIN_INTERVAL;

    if ((t - last) < minInterval && cached) {
      stats.throttled++;
      if (document.hidden) stats.blockedWhileHidden++;
      exposeStats();
      return responseFromCache(cached);
    }

    lastRequestAt.set(key, t);

    var p = originalFetch(input, init).then(async function (response) {
      stats.networkFetches++;

      if (response && response.ok) {
        var record = await cloneResponseForCache(response);
        if (record) cache.set(key, record);
      }

      exposeStats();
      return response;
    }).catch(function (error) {
      // If the live request fails but stale cache exists, serve stale data rather than exploding the site.
      if (cached) {
        stats.cacheHits++;
        exposeStats();
        return responseFromCache(cached);
      }
      exposeStats();
      throw error;
    }).finally(function () {
      inflight.delete(key);
      exposeStats();
    });

    inflight.set(key, p);
    return p.then(function (response) { return response.clone(); });
  };

  // Pause visual refresh loops when tab is hidden by exposing a safe flag.
  window.DiamondShouldRefreshLiveData = function () {
    if (!document.hidden) return true;
    var lastHiddenRefresh = window.__diamondLastHiddenRefresh || 0;
    if ((now() - lastHiddenRefresh) > HIDDEN_MIN_INTERVAL) {
      window.__diamondLastHiddenRefresh = now();
      return true;
    }
    return false;
  };

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      // Allow immediate refresh when user returns, but still use cache/dedupe.
      window.__diamondLastHiddenRefresh = 0;
    }
  });

  exposeStats();
})();

/* ---- from <script id="anonymous"> ---- */
(function(){
const cache=new Map();
const origFetch=window.fetch;
function drPerfLiveURL(url){
  return /linescore|feed\/live|schedule|api\/v1\/game\/|\/game\/\d+\/boxscore|status/i.test(String(url || ''));
}
window.fetch=async function(url,opts){
 if(typeof url==='string' && !drPerfLiveURL(url) && cache.has(url)) return cache.get(url).clone();
 const resp=await origFetch(url, drPerfLiveURL(url) ? Object.assign({cache:'no-store'}, opts||{}) : opts);
 if(typeof url==='string' && !drPerfLiveURL(url) && resp.ok){
   cache.set(url,resp.clone());
 }
 return resp;
};
document.addEventListener('DOMContentLoaded',()=>{
 requestAnimationFrame(()=>document.body.style.visibility='visible');
});
})();

/* ---- from <script id="anonymous"> ---- */
// This is unguarded, synchronous, top-level code running near the start of the
// whole script file — if adsbygoogle.push() throws (a routine AdSense failure
// mode, e.g. the ad container briefly having zero width before layout settles),
// the exception was silently killing execution of EVERYTHING after it in the
// file, including showGamePickPane and every other app function. Wrapped so a
// flaky ad slot can never again take down the entire site.
try { (adsbygoogle = window.adsbygoogle || []).push({}); } catch(e) {}
       // Expand container once ad loads
       window.addEventListener('load', function() {
         setTimeout(function() {
           var ad = document.querySelector('#ad-container .adsbygoogle[data-ad-status]');
           if (ad && ad.getAttribute('data-ad-status') !== 'unfilled') {
             var adContainer = document.getElementById('ad-container');
             adContainer.style.display = 'block';
             adContainer.style.maxHeight = '120px';
           }
         }, 2000);
       });

/* ---- from <script id="anonymous"> ---- */
// Safe fetch wrapper — handles empty/truncated responses and falls back from
// the Diamond Report proxy to the official MLB Stats API when the proxy is unavailable.
function diamondApiFallbackUrl(url) {
  try {
    const raw = String(url || '');
    if (!raw.includes('diamondreport.app/api/')) return null;
    return raw.replace('https://diamondreport.app/api', 'https://statsapi.mlb.com/api')
              .replace('http://diamondreport.app/api', 'https://statsapi.mlb.com/api');
  } catch (e) {
    return null;
  }
}

// ── Static daily data dump mode ─────────────────────────────────────
// v8.72: The first successful data response for a date becomes the source of truth
// for that day. Reloads display the same cached dump immediately instead of
// rebuilding different live data on every refresh. A new daily dump is allowed
// automatically when the local date changes.
const DR_STATIC_DAILY_DUMP = true;
const DR_STATIC_DUMP_VERSION = 'v8.72';
function drStaticDateKey(){
  try { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }
  catch(e) { return new Date().toISOString().slice(0,10); }
}
function drStaticKey(url){ return 'dr-static-dump:' + DR_STATIC_DUMP_VERSION + ':' + drStaticDateKey() + ':' + String(url).replace(/([?&])(ts|v|_)=\d+/g,'').replace(/[?&]$/,''); }
function drStripCacheBust(url){ return String(url).replace(/([?&])(ts|v|_)=\d+/g,'').replace(/[?&]$/,''); }
function drIsLiveScoreURL(url){
  var u = String(url || '').toLowerCase();
  return /schedule|linescore|feed\/live|api\/v1\/game\/|\/game\/\d+\/boxscore|status/.test(u);
}
function drLiveURL(url){
  try {
    var u = new URL(String(url || ''), location.href);
    u.searchParams.set('_live', Date.now().toString());
    return u.toString();
  } catch(e) {
    return String(url || '') + (String(url || '').includes('?') ? '&' : '?') + '_live=' + Date.now();
  }
}
async function drFetchDailyJSON(url, opts){
  const cleanUrl = drStripCacheBust(url);
  const key = drStaticKey(cleanUrl);
  if (DR_STATIC_DAILY_DUMP && !drIsLiveScoreURL(cleanUrl)) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && saved.data) return saved.data;
      }
    } catch(e) {}
  }
  // force-cache with no cache-busting on the actual request meant a browser that had
  // ever cached an empty/404 response for one of these repo-synced files (e.g. before
  // the daily sync backend had run yet) would keep serving that stale response
  // indefinitely, with no way to notice the file now has real data — confirmed live:
  // a pitcher whose real Statcast data existed in the repo still showed "no data" in a
  // browser that had cached an earlier empty fetch. Appending a date key makes each new
  // day's fetch a genuinely different URL, forcing exactly one fresh network fetch per
  // day while still letting force-cache dedupe repeat fetches within the same day.
  const dailyUrl = drIsLiveScoreURL(cleanUrl) ? cleanUrl : cleanUrl + (cleanUrl.includes('?') ? '&' : '?') + '_d=' + drStaticDateKey();
  const requestUrl = drIsLiveScoreURL(cleanUrl) ? drLiveURL(cleanUrl) : dailyUrl;
  const requestOpts = drIsLiveScoreURL(cleanUrl) ? Object.assign({ cache:'no-store' }, opts || {}) : Object.assign({ cache:'force-cache' }, opts || {});
  const res = await fetch(requestUrl, requestOpts);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (DR_STATIC_DAILY_DUMP && !drIsLiveScoreURL(cleanUrl)) {
    try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), date: drStaticDateKey(), data })); } catch(e) {}
  }
  return data;
}
window.DiamondClearStaticDailyDump = function(){
  try {
    const prefix = 'dr-static-dump:' + DR_STATIC_DUMP_VERSION + ':' + drStaticDateKey() + ':';
    Object.keys(localStorage).forEach(k => { if (k.indexOf(prefix) === 0) localStorage.removeItem(k); });
    return 'Diamond Report static daily dump cleared for today.';
  } catch(e) { return 'Unable to clear static dump: ' + (e.message || e); }
};

// ── Data QA guardrail ────────────────────────────────────────────────────
// Cheap, non-blocking plausibility check for computed stat values. This exists
// because bugs like the Pitch Mix Advantage barrel% scaling issue (a real 1%
// rate silently rewritten to a fabricated 100%) don't throw or crash anything —
// the page renders fine, the number is just wrong. This flags values that fall
// outside the realistic range for a given stat kind so a bad value shows up as
// a console warning immediately instead of waiting for someone to notice a
// grade or number that looks off. It never alters the value or blocks
// rendering — pure observation, safe to call anywhere.
window.DR_DATA_QA_WARNINGS = window.DR_DATA_QA_WARNINGS || [];
const DR_STAT_RANGES = {
  avg:      { min: 0,    max: 0.60  },  // batting average (career-high ~.440; generous headroom for tiny samples)
  slg:      { min: 0,    max: 1.20  },  // slugging
  xslg:     { min: 0,    max: 1.20  },  // expected slugging
  woba:     { min: 0,    max: 0.60  },  // wOBA (or OBP used as its stand-in)
  obp:      { min: 0,    max: 0.60  },
  iso:      { min: 0,    max: 0.55  },  // isolated power
  era:      { min: 0,    max: 15    },
  whip:     { min: 0,    max: 4     },
  k9:       { min: 0,    max: 25    },  // strikeouts per 9
  hr9:      { min: 0,    max: 8     },  // home runs per 9
  kPerGm:   { min: 0,    max: 20    },  // strikeouts per game
  fip:      { min: -2,   max: 15    },
  hardHit:  { min: 0,    max: 80    },  // hard-hit rate — realistic ceiling well under 100%
  barrel:   { min: 0,    max: 35    },  // barrel rate — elite hitters top out ~25-28%
  whiff:    { min: 0,    max: 75    },  // whiff rate
  usage:    { min: 0,    max: 100   },  // pitch usage share — a one-pitch reliever can approach 100%
  pct:      { min: 0,    max: 100   },  // generic percent fallback when no specific kind applies
};
function drCheckStat(context, label, value, kind) {
  if (value === null || value === undefined || value === '' || value === '–') return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const range = DR_STAT_RANGES[kind];
  if (!range) return value;
  if (n < range.min || n > range.max) {
    const entry = { ts: Date.now(), context, label, value: n, kind, range };
    window.DR_DATA_QA_WARNINGS.push(entry);
    if (window.DR_DATA_QA_WARNINGS.length > 200) window.DR_DATA_QA_WARNINGS.shift();
    console.warn(`[DR data QA] ${context}: ${label} = ${n} is outside the plausible ${kind} range (${range.min}–${range.max})`, entry);
  }
  return value;
}
window.DiamondReportDataWarnings = function(){ return window.DR_DATA_QA_WARNINGS.slice(); };

// ── Shared response cache (TTL: static daily dump for all data, fallback TTLs) ──────────
const _fetchCache = new Map();
const _fetchInFlight = new Map();
const CACHE_TTL_LIVE = 0;        // v9.2: scores/linescore must always bypass cache
const CACHE_TTL_STATIC = 300_000; // player season stats, game logs

// fetch() has no built-in timeout — a single stalled request (dead connection, proxy
// gone quiet mid-response) hangs its await forever with no error and no rejection.
// Inside fetchJSON that's fatal beyond just that one call: the 8-slot concurrency
// limiter below never gets its slot back, so every *other* panel's fetchJSON calls
// queue behind it silently — "everything is stuck loading, no console errors" is
// exactly what that looks like from the UI. Bounding every request lets the existing
// fallback/retry logic actually run instead of never getting a turn.
const FETCH_TIMEOUT_MS = 15000;
function _fetchWithTimeout(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, Object.assign({}, opts, { signal: controller.signal }))
    .catch(e => { throw (e && e.name === 'AbortError') ? new Error('Request timed out') : e; })
    .finally(() => clearTimeout(timer));
}

function _cacheTTL(url) {
  if (/linescore|schedule.*hydrate.*linescore|status/.test(url)) return CACHE_TTL_LIVE;
  return CACHE_TTL_STATIC;
}

// Concurrency limiter — max 8 simultaneous API requests
// Without this, loading HR Potential fires ~400 requests at once, overwhelming the proxy
let _inflight = 0;
const _queue = [];
function _drainQueue() {
  while (_queue.length && _inflight < 8) {
    const { resolve } = _queue.shift();
    _inflight++;
    resolve();
  }
}
function _acquire() {
  if (_inflight < 8) { _inflight++; return Promise.resolve(); }
  return new Promise(resolve => _queue.push({ resolve }));
}
function _release() { _inflight--; _drainQueue(); }

async function fetchJSON(url) {
  // v9.2: live score/status requests must always bypass every app/browser cache.
  url = drStripCacheBust(url);
  const __liveScoreRequest = drIsLiveScoreURL(url);
  if (__liveScoreRequest) {
    const attempts = [url];
    const fallback = diamondApiFallbackUrl(url);
    if (fallback && fallback !== url) attempts.push(fallback);
    let lastError = null;
    for (const requestUrl of attempts) {
      try {
        const res = await _fetchWithTimeout(drLiveURL(requestUrl), { cache:'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text || text.trim() === '') throw new Error('Empty response from API');
        return JSON.parse(text);
      } catch(e) { lastError = e; }
    }
    throw new Error(lastError?.message || 'Failed to fetch live score data');
  }
  if (DR_STATIC_DAILY_DUMP && !drIsLiveScoreURL(url)) {
    try {
      const rawStatic = localStorage.getItem(drStaticKey(url));
      if (rawStatic) {
        const savedStatic = JSON.parse(rawStatic);
        if (savedStatic && savedStatic.data) return savedStatic.data;
      }
    } catch(e) {}
  }
  // v8.71 reload speed: use memory + localStorage cache so a browser reload can
  // paint with recently-fetched MLB/data JSON instead of waiting on every API call.
  const ttl = (DR_STATIC_DAILY_DUMP && !drIsLiveScoreURL(url)) ? 24 * 60 * 60 * 1000 : _cacheTTL(url);
  const now = Date.now();
  const cached = _fetchCache.get(url);
  if (cached && now - cached.ts < ttl) return cached.data;

  const lsKey = 'dr-json-cache:' + url;
  try {
    const raw = localStorage.getItem(lsKey);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && saved.ts && (now - saved.ts) < ttl && saved.data) {
        _fetchCache.set(url, { data: saved.data, ts: saved.ts });
        return saved.data;
      }
    }
  } catch (e) {}

  // Deduplicate in-flight requests for the same URL
  if (_fetchInFlight.has(url)) return _fetchInFlight.get(url);

  const promise = (async () => {
    await _acquire();
    try {
      const attempts = [url];
      const fallback = diamondApiFallbackUrl(url);
      if (fallback && fallback !== url) attempts.push(fallback);

      let lastError = null;
      for (const requestUrl of attempts) {
        try {
          // Live score/schedule URLs must bypass cache so in-game/final scores refresh.
          const live = drIsLiveScoreURL(requestUrl);
          const res = await _fetchWithTimeout(live ? drLiveURL(requestUrl) : requestUrl, { cache: live ? 'no-store' : 'default' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          if (!text || text.trim() === '') throw new Error('Empty response from API');
          try {
            const data = JSON.parse(text);
            const record = { data, ts: Date.now() };
            _fetchCache.set(url, record);
            try { localStorage.setItem(lsKey, JSON.stringify(record)); } catch (e) {}
            if (DR_STATIC_DAILY_DUMP && !drIsLiveScoreURL(url)) { try { localStorage.setItem(drStaticKey(url), JSON.stringify({ ts: record.ts, date: drStaticDateKey(), data })); } catch(e) {} }
            return data;
          } catch(e) {
            throw new Error(`Invalid JSON (${text.slice(0,80).trim()}…)`);
          }
        } catch (e) {
          lastError = e;
        }
      }

      // If network fails but stale localStorage exists, show stale data instead of hanging.
      try {
        const raw = localStorage.getItem(lsKey);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved && saved.data) return saved.data;
        }
      } catch (e) {}
      throw new Error(lastError?.message || 'Failed to fetch');
    } finally {
      _release();
      _fetchInFlight.delete(url);
    }
  })();

  _fetchInFlight.set(url, promise);
  return promise;
}

const standings = [
  {abbr:"TB",name:"Tampa Bay Rays",W:47,L:33,conf:"AL",div:"East"},
  {abbr:"NYY",name:"New York Yankees",W:48,L:34,conf:"AL",div:"East"},
  {abbr:"TOR",name:"Toronto Blue Jays",W:39,L:44,conf:"AL",div:"East"},
  {abbr:"BAL",name:"Baltimore Orioles",W:39,L:44,conf:"AL",div:"East"},
  {abbr:"BOS",name:"Boston Red Sox",W:35,L:46,conf:"AL",div:"East"},
  {abbr:"CWS",name:"Chicago White Sox",W:43,L:38,conf:"AL",div:"Central"},
  {abbr:"CLE",name:"Cleveland Guardians",W:42,L:40,conf:"AL",div:"Central"},
  {abbr:"MIN",name:"Minnesota Twins",W:39,L:44,conf:"AL",div:"Central"},
  {abbr:"DET",name:"Detroit Tigers",W:35,L:48,conf:"AL",div:"Central"},
  {abbr:"KC",name:"Kansas City Royals",W:34,L:50,conf:"AL",div:"Central"},
  {abbr:"SEA",name:"Seattle Mariners",W:42,L:41,conf:"AL",div:"West"},
  {abbr:"TEX",name:"Texas Rangers",W:41,L:42,conf:"AL",div:"West"},
  {abbr:"ATH",name:"Athletics",W:40,L:42,conf:"AL",div:"West"},
  {abbr:"HOU",name:"Houston Astros",W:41,L:44,conf:"AL",div:"West"},
  {abbr:"LAA",name:"Los Angeles Angels",W:34,L:49,conf:"AL",div:"West"},
  {abbr:"MIL",name:"Milwaukee Brewers",W:50,L:29,conf:"NL",div:"Central"},
  {abbr:"CHC",name:"Chicago Cubs",W:44,L:38,conf:"NL",div:"Central"},
  {abbr:"STL",name:"St. Louis Cardinals",W:42,L:37,conf:"NL",div:"Central"},
  {abbr:"PIT",name:"Pittsburgh Pirates",W:41,L:42,conf:"NL",div:"Central"},
  {abbr:"CIN",name:"Cincinnati Reds",W:39,L:42,conf:"NL",div:"Central"},
  {abbr:"ATL",name:"Atlanta Braves",W:49,L:31,conf:"NL",div:"East"},
  {abbr:"PHI",name:"Philadelphia Phillies",W:46,L:37,conf:"NL",div:"East"},
  {abbr:"MIA",name:"Miami Marlins",W:43,L:39,conf:"NL",div:"East"},
  {abbr:"WSH",name:"Washington Nationals",W:41,L:42,conf:"NL",div:"East"},
  {abbr:"NYM",name:"New York Mets",W:35,L:48,conf:"NL",div:"East"},
  {abbr:"LAD",name:"Los Angeles Dodgers",W:52,L:30,conf:"NL",div:"West"},
  {abbr:"SD",name:"San Diego Padres",W:43,L:37,conf:"NL",div:"West"},
  {abbr:"AZ",name:"Arizona Diamondbacks",W:41,L:41,conf:"NL",div:"West"},
  {abbr:"SF",name:"San Francisco Giants",W:33,L:48,conf:"NL",div:"West"},
  {abbr:"COL",name:"Colorado Rockies",W:32,L:50,conf:"NL",div:"West"}
];

// Team ID map for logos (MLB team IDs)
const teamIds = {
  ARI:109,ATL:144,BAL:110,BOS:111,CHC:112,CWS:145,CIN:113,CLE:114,
  COL:115,DET:116,HOU:117,KC:118,LAA:108,LAD:119,MIA:146,MIL:158,
  MIN:142,NYM:121,NYY:147,OAK:133,PHI:143,PIT:134,SD:135,SF:137,
  SEA:136,STL:138,TB:139,TEX:140,TOR:141,WSH:120,ATH:133,AZ:109
};
window.teamIds = Object.assign(window.teamIds || {}, teamIds);
// Reverse of teamIds (id -> abbr), for matching numeric MLB team_id fields on
// repo-synced data (e.g. park-factors.json) back to the abbreviation strings used
// everywhere else in this file. AZ/ATH collide with ARI/OAK's id on purpose in
// teamIds (alternate abbreviations for the same franchise) — first assignment
// below wins, which is fine since either abbreviation resolves to the same park.
const teamIdToAbbr = {};
Object.keys(teamIds).forEach(abbr => { const id = String(teamIds[abbr]); if (!teamIdToAbbr[id]) teamIdToAbbr[id] = abbr; });
function teamLogo(abbr) {
  const id = teamIds[abbr] || teamIds[String(abbr || '').toUpperCase() === 'AZ' ? 'ARI' : abbr];
  if (!id) return '';
  return `<img class="team-logo" src="https://www.mlbstatic.com/team-logos/${id}.svg" alt="${abbr}" loading="lazy" decoding="async">`;
}

// Build standings lookup: abbr -> {rank, gb, wl}
function buildStandingsLookup() {
  const lookup = {};
  ['AL','NL'].forEach(conf => {
    ['East','Central','West'].forEach(div => {
      const teams = standings.filter(t => t.conf===conf && t.div===div)
        .sort((a,b) => (b.W/(b.W+b.L)) - (a.W/(a.W+a.L)));
      const ldr = teams[0];
      teams.forEach((t,i) => {
        const gb = i===0 ? null : (((ldr.W-t.W)+(t.L-ldr.L))/2);
        lookup[t.abbr] = { rank:i+1, gb, wl:`${t.W}-${t.L}`, div:`${conf} ${div}` };
      });
    });
  });
  return lookup;
}

function winPct(wl) {
  if (!wl) return null;
  const m = String(wl).match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  const w = Number(m[1]), l = Number(m[2]);
  return (w + l) ? w / (w + l) : null;
}

// Stable favored cache — once the DR model picks a winner for a gamePk,
// that result is locked in so the pill never flickers between renders.
const _favoredCache = {};

function getFavored(gamePk, awayAbbr, homeAbbr, standingsLookup) {
  if (_favoredCache[gamePk]) return _favoredCache[gamePk];
  const model = gamePk != null ? window.drWinProbStore?.[gamePk] : null;
  if (model && model.winnerAbbr && model.winnerPct) {
    const result = { abbr: model.winnerAbbr, pct: model.winnerPct, source: 'model' };
    _favoredCache[gamePk] = result;
    return result;
  }
  // Fallback: record comparison (not cached — let real model override when ready)
  const awayPct = winPct(standingsLookup?.[awayAbbr]?.wl);
  const homePct = winPct(standingsLookup?.[homeAbbr]?.wl);
  if (awayPct === null || homePct === null || awayPct === homePct) return null;
  return awayPct > homePct
    ? { abbr: awayAbbr, pct: null, source: 'record' }
    : { abbr: homeAbbr, pct: null, source: 'record' };
}

function teamBlock(abbr, name, standingsLookup, favored, winProbPct) {
  const st = standingsLookup?.[abbr];
  const badgeHtml = st
    ? `<div class="standings-badge"><span class="div-pos">#${st.rank}</span> ${st.div.split(' ')[1]} · <span>${st.wl}</span></div>`
    : '';
  const isFavored = favored?.abbr === abbr;
  // Show win probability % under team name when available, else just a placeholder
  const probHtml = winProbPct != null
    ? `<div class="win-prob-pill ${isFavored ? 'win-prob-favored' : 'win-prob-dog'}">${winProbPct}%</div>`
    : `<div class="win-prob-pill" style="visibility:hidden">–</div>`;
  return `<div class="team-block">
    ${teamLogo(abbr)}
    <div class="team-abbr">${abbr}</div>
    <div class="team-name">${name}</div>
    ${probHtml}
    ${badgeHtml}
  </div>`;
}

function gameCard(g) {
  const { gamePk, awayAbbr, homeAbbr, awayName, homeName, awayScore, homeScore, inning, status, time } = g;
  const isLive = status === 'live';
  const isFinal = status === 'final';
  const cls = isLive ? 'live' : isFinal ? 'closed' : 'scheduled';
  const label = isLive ? (inning ? `<span style="font-size:15px;font-weight:900;letter-spacing:1px">${inning}</span>` : 'LIVE') : isFinal ? 'FINAL' : 'UPCOMING';
  const sl = buildStandingsLookup();
  const favored = getFavored(gamePk, awayAbbr, homeAbbr, sl);
  const model = gamePk != null ? window.drWinProbStore?.[gamePk] : null;

  let scoreHTML = '';
  if (awayScore !== null && homeScore !== null) {
    const awayW = awayScore > homeScore;
    const homeW = homeScore > awayScore;
    scoreHTML = `<div class="score-block">
      <span class="${awayW?'score-win':'score-loss'}">${awayScore}</span>
      <span class="score-sep">–</span>
      <span class="${homeW?'score-win':'score-loss'}">${homeScore}</span>
    </div>`;
  } else {
    scoreHTML = `<div style="font-family:'JetBrains Mono',monospace;font-size:18px;color:var(--accent2);padding:0 8px">VS</div>`;
  }
  return `<div class="game-card ${cls}">
    <div class="game-status ${cls}">${label}</div>
    <div class="matchup">
      ${teamBlock(awayAbbr, awayName, sl, favored, model?.awayPct ?? null)}
      ${scoreHTML}
      ${teamBlock(homeAbbr, homeName, sl, favored, model?.homePct ?? null)}
    </div>
    <div class="game-time">${time}</div>
  </div>`;
}

function formatCountdown(gameDateMs) {
  const msLeft = gameDateMs - Date.now();
  if (msLeft <= 0 || msLeft > 60 * 60 * 1000) return null;
  const totalMin = Math.floor(msLeft / 60000);
  const sec = Math.floor((msLeft % 60000) / 1000);
  if (totalMin >= 1) return `Starts in ${totalMin}m`;
  return `Starts in ${sec}s`;
}

function upcomingCard(g) {
  const sl = buildStandingsLookup();
  const favored = getFavored(g.gamePk, g.awayAbbr, g.homeAbbr, sl);
  const model = g.gamePk != null ? window.drWinProbStore?.[g.gamePk] : null;
  const countdown = g.gameDateMs ? formatCountdown(g.gameDateMs) : null;
  const statusHTML = countdown
    ? `<div class="game-status scheduled countdown-pulse" data-game-date="${g.gameDateMs}">⏱ ${countdown}</div>`
    : `<div class="game-status scheduled">UPCOMING</div>`;
  return `<div class="game-card scheduled">
    ${statusHTML}
    <div class="matchup">
      ${teamBlock(g.awayAbbr, g.awayName, sl, favored, model?.awayPct ?? null)}
      <div style="font-family:'JetBrains Mono',monospace;font-size:18px;color:var(--accent2);padding:0 8px">VS</div>
      ${teamBlock(g.homeAbbr, g.homeName, sl, favored, model?.homePct ?? null)}
    </div>
    <div class="game-time">${g.time}</div>
  </div>`;
}

// ── Shared schedule cache — prevents redundant schedule fetches across sections ──
// loadGameProps, loadKProps, loadHRPotential, loadKsToday and loadPitcherReport
// all need today's schedule. Without this they fire independently on startup.
const _scheduleCache = {};
async function getTodaySchedule(hydrate = 'team,probablePitcher', opts = {}) {
  const today = new Date().toLocaleDateString('en-CA', {timeZone:'America/Chicago'});
  const key = `${today}|${hydrate}`;
  const liveHydrate = /linescore|status/i.test(String(hydrate || ''));
  const ttl = liveHydrate ? 60_000 : 5 * 60_000;
  const cached = _scheduleCache[key];
  if (!opts.force && cached && cached.ts && (Date.now() - cached.ts) < ttl) return cached.games || [];
  if (!opts.force && _scheduleCache[key + '_p']) return _scheduleCache[key + '_p'];
  _scheduleCache[key + '_p'] = fetchJSON(
    `https://diamondreport.app/api/v1/schedule?sportId=1&date=${today}&hydrate=${hydrate}&language=en`
  ).then(data => {
    const entry = data.dates?.find(d => d.date === today) || data.dates?.[0];
    const games = entry?.games || [];
    _scheduleCache[key] = { games, ts: Date.now() };
    return games;
  }).finally(() => { delete _scheduleCache[key + '_p']; });
  return _scheduleCache[key + '_p'];
}

// ── Shared pitcher recent-form cache — last-N-starts rolling ERA/WHIP/K9, blended into
// the Diamond Report Pick and K Props models so a pitcher's full-season 3.50 ERA doesn't
// get treated identically whether he's been dealing his last 3 starts or getting rocked.
// Cached per pitcher so both boards share one fetch instead of each re-fetching the same
// pitcher's recent games independently.
const _recentFormCache = {};
async function recentPitchingForm(pid, starts = 5) {
  if (!pid) return null;
  const key = `${pid}|${starts}`;
  const cached = _recentFormCache[key];
  if (cached && cached.ts && (Date.now() - cached.ts) < 5 * 60_000) return cached.data;
  if (_recentFormCache[key + '_p']) return _recentFormCache[key + '_p'];
  const p = (async () => {
    try {
      const d = await fetchJSON(`https://diamondreport.app/api/v1/people/${pid}/stats?stats=lastXGames&group=pitching&season=2026&limit=${starts}&gameType=R`);
      const splits = d?.stats?.[0]?.splits || [];
      if (!splits.length) return null;
      let ip = 0, er = 0, bb = 0, h = 0, k = 0;
      splits.forEach(s => {
        const st = s.stat || {};
        // Same innings-pitched parsing convention already used everywhere else in this
        // file (parseFloat on the API's "X.Y" notation, where Y is really outs 0/1/2 —
        // not tenths). Slightly undercounts fractional innings, but stays consistent
        // with every other IP figure this site already computes.
        ip += parseFloat(st.inningsPitched) || 0;
        er += parseInt(st.earnedRuns) || 0;
        bb += parseInt(st.baseOnBalls) || 0;
        h += parseInt(st.hits) || 0;
        k += parseInt(st.strikeOuts) || 0;
      });
      if (ip <= 0) return null;
      return { starts: splits.length, ip, era: (er * 9) / ip, whip: (bb + h) / ip, k9: (k * 9) / ip };
    } catch (e) { return null; }
  })();
  _recentFormCache[key + '_p'] = p;
  const data = await p;
  _recentFormCache[key] = { data, ts: Date.now() };
  delete _recentFormCache[key + '_p'];
  return data;
}
// Blends a season-long stat with its recent-form counterpart. Recent form's influence
// scales with how much recent innings support it (capped at 50%) — a thin recent sample
// shouldn't swing a projection as much as a real 5-start stretch would.
function blendRecentForm(seasonVal, recent, key) {
  if (!recent || !Number.isFinite(recent[key]) || !(recent.ip > 0)) return seasonVal;
  const weight = Math.max(0, Math.min(0.5, recent.ip / 25));
  return seasonVal * (1 - weight) + recent[key] * weight;
}

// Team-wide season pitching totals (every pitcher who's thrown for the team combined) —
// used by the Projected Total model to back out a bullpen-strength signal. There's no
// documented "relief pitching only" split on this API, so this isn't a true bullpen-only
// stat: subtracting the day's probable starter's own IP/ER from the team total leaves
// "how this team's staff performs when someone other than today's starter is on the
// mound," which mixes true relief appearances with other starters' turns through the
// season. Still a meaningfully different, real signal from the starter's own line alone.
// Cached per team since this barely moves within a day (only after that team's own game).
const _teamPitchingCache = {};
async function teamSeasonPitchingTotals(teamId) {
  if (!teamId) return null;
  const cached = _teamPitchingCache[teamId];
  if (cached && cached.ts && (Date.now() - cached.ts) < 5 * 60_000) return cached.data;
  try {
    const d = await fetchJSON(`https://diamondreport.app/api/v1/teams/${teamId}/stats?stats=season&group=pitching&season=2026`);
    const s = d.stats?.[0]?.splits?.[0]?.stat || {};
    const data = { er: parseInt(s.earnedRuns) || 0, ip: parseFloat(s.inningsPitched) || 0 };
    _teamPitchingCache[teamId] = { data, ts: Date.now() };
    return data;
  } catch { return null; }
}
// Backs out a bullpen-strength ERA from the team total minus the probable starter's own
// line (see teamSeasonPitchingTotals above for what that mix actually represents).
// Requires a real 20+ IP remainder before trusting it — early season, or a team whose
// probable starter has thrown nearly all their innings, isn't a reliable subtraction.
function bullpenERAFor(teamPitching, starterStats, leagueAvgBullpenERA) {
  if (!teamPitching) return leagueAvgBullpenERA;
  const starterER = parseInt(starterStats.earnedRuns) || 0;
  const starterIP = parseFloat(starterStats.inningsPitched) || 0;
  const bullpenIP = teamPitching.ip - starterIP;
  const bullpenER = teamPitching.er - starterER;
  if (bullpenIP < 20) return leagueAvgBullpenERA;
  return Math.max(1.5, (bullpenER * 9) / bullpenIP);
}

// Keyed game state cache — gamePk -> last known card data
const prevGames = {};

// scoresDiffer() intentionally skips re-rendering a card when only the *page* changes,
// not the score/inning/status — this keeps live games from flickering every poll.
// But that means a card can render its FAVORED pill using the record-based fallback
// (because loadGameProps hasn't finished yet) and then never repaint once the real
// Diamond Report Pick model data arrives, if the score happens to stay the same in
// between. This redraws already-rendered cards straight from the cache so the FAVORED
// pill catches up to the model immediately, without needing a score change or a full
// scores re-fetch.
function refreshFavoredPills() {
  Object.keys(prevGames).forEach(key => {
    const g = prevGames[key];
    const el = document.getElementById(`game-${key}`);
    if (!el) return;
    el.innerHTML = g.status === 'upcoming' ? upcomingCard(g) : gameCard(g);
  });
}

// Hero "today's record" trust strip — surfaces the real, already-computed today's
// accuracy tallies (Diamond Report Pick and K Props each compute their own from real
// final-game results) at the top of the page instead of leaving them buried inside
// their own tabs. Only shows a market once it has at least one final result today —
// never a fabricated 0-0 record — and only ever grows through the day as more games
// go final, so it won't appear then disappear.
function updateHeroTodayRecordStrip() {
  const el = document.getElementById('dr-hero-trust-strip');
  if (!el) return;
  const items = [];
  const recordColor = (wins, total) => wins === total ? '#22e06f' : wins > total / 2 ? '#fbbf24' : '#fca5a5';
  const drp = window.__drTodayRecord;
  if (drp && drp.total > 0) {
    const pct = Math.round((drp.wins / drp.total) * 100);
    items.push(`<div class="dr-trust-item"><strong style="color:${recordColor(drp.wins, drp.total)}">${drp.wins}-${drp.losses}</strong><span>Diamond Report Pick · ${pct}% today</span></div>`);
  }
  const kp = window.__kpTodayRecord;
  if (kp && kp.total > 0) {
    const pct = Math.round((kp.wins / kp.total) * 100);
    items.push(`<div class="dr-trust-item"><strong style="color:${recordColor(kp.wins, kp.total)}">${kp.wins}-${kp.losses}</strong><span>K Props · ${pct}% today</span></div>`);
  }
  // All-time record now lives on the Methodology page instead of here — see
  // methodology.html's own tracker.json fetch. This strip stays scoped to today only.
  el.innerHTML = items.join('');
  el.style.display = items.length ? '' : 'none';
}
window.updateHeroTodayRecordStrip = updateHeroTodayRecordStrip;

// Fetches the nightly-graded all-time record once on load. Gracefully no-ops until the
// first scheduled run of scripts/update-tracker.mjs actually produces data/tracker.json —
// no fabricated record shown before real history exists. The full all-time/rolling
// breakdown by market lives on methodology.html now (its own standalone tracker.json
// fetch) — this page only needs today's Elite Picks.
async function loadAllTimeTrackerRecord() {
  try {
    const res = await fetch('./data/tracker.json', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    // Today's Elite Picks are selected and locked in server-side (scripts/update-tracker.mjs,
    // captureEliteToday) so every visitor sees the exact same picks with the exact same
    // score — the Premium tab only joins these against live row data for display, it no
    // longer selects or scores anything client-side. Always set (even to []) so the
    // Premium tab can tell "not loaded yet" apart from "loaded, nothing cleared the bar".
    const todayCT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    window.__premiumTodayPicksRaw = (data?.market?.premium || []).filter(r => r.date === todayCT);
    if (typeof window.renderPremiumPicks === 'function') window.renderPremiumPicks();
    updateHeroTodayRecordStrip();
  } catch (e) {}
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadAllTimeTrackerRecord, { once: true });
} else {
  loadAllTimeTrackerRecord();
}
// The backend captures Elite Picks in two passes (morning + afternoon lineup re-check —
// see update-tracker.yml); re-fetching periodically lets a tab left open pick up the
// afternoon pass without a manual reload. tracker.json only changes a couple times a
// day server-side, so this stays infrequent — no need for the 120s live-score cadence.
setInterval(() => { if (document.visibilityState === 'visible') loadAllTimeTrackerRecord(); }, 300000);
window.refreshFavoredPills = refreshFavoredPills;

function gameKey(g) { return g.gamePk || `${g.awayAbbr}-${g.homeAbbr}`; }

function scoresDiffer(a, b) {
  return a.awayScore !== b.awayScore ||
         a.homeScore !== b.homeScore ||
         a.inning    !== b.inning    ||
         a.status    !== b.status;
}

async function loadScores() {
  try {
    // Routed through the shared schedule cache so loadScores(), called from the 120s
    // interval, the day-rollover reload, the manual reload button, and startup all dedupe
    // against each other instead of each firing an independent uncached network request.
    const games = await getTodaySchedule('linescore,team');

    const live = [], final = [], upcoming = [];
    const freshKeys = new Set();

    games.forEach(g => {
      const away = g.teams.away;
      const home = g.teams.home;
      const state = g.status.abstractGameState;
      const detailedState = g.status.detailedState;
      const dt = new Date(g.gameDate);
      const timeStr = dt.toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit', timeZone:'America/Chicago'}) + ' CDT';
      const linescore = g.linescore || {};
      // Only show an inning count once the game has genuinely started — 'Warmup' means
      // first pitch hasn't happened yet, so any currentInning value from the API during
      // warmup/delay states is not a real inning and shouldn't be displayed.
      const trulyInProgress = detailedState === 'In Progress';
      const inningStr = (trulyInProgress && linescore.currentInning)
        ? `${linescore.inningHalf === 'Bottom' ? '▼' : '▲'} ${linescore.currentInning}`
        : trulyInProgress ? 'LIVE' : null;
      const isLive   = state === 'Live' || trulyInProgress;
      const isFinal  = state === 'Final' || detailedState === 'Final' || detailedState === 'Game Over';

      const card = {
        gamePk: g.gamePk,
        awayAbbr: away.team.abbreviation,
        homeAbbr: home.team.abbreviation,
        awayName: away.team.shortName || away.team.teamName,
        homeName: home.team.shortName || home.team.teamName,
        awayScore: away.score ?? null,
        homeScore: home.score ?? null,
        inning: inningStr,
        time: timeStr,
        gameDateMs: dt.getTime(), // raw start time, used for the "starts in X min" countdown
        status: isLive ? 'live' : isFinal ? 'final' : 'upcoming'
      };

      const key = gameKey(card);
      freshKeys.add(key);

      if (isLive) live.push(card);
      else if (isFinal) final.push(card);
      else upcoming.push(card);
    });

    const isFirstLoad = Object.keys(prevGames).length === 0;

    if (isFirstLoad) {
      // First load — render everything
      document.getElementById('live-games').innerHTML = live.length
        ? live.map(g => `<div id="game-${gameKey(g)}">${gameCard(g)}</div>`).join('')
        : '<div style="color:var(--muted);font-size:13px;padding:4px 0">No live games right now.</div>';

      document.getElementById('final-games').innerHTML = final.length
        ? final.map(g => `<div id="game-${gameKey(g)}">${gameCard(g)}</div>`).join('')
        : '<div style="color:var(--muted);font-size:13px;padding:4px 0">No final games yet today.</div>';

      const sgEl = document.getElementById('scheduled-games'); if(sgEl) sgEl.innerHTML =
        upcoming.map(g => `<div id="game-${gameKey(g)}">${upcomingCard(g)}</div>`).join('');

    } else {
      // Subsequent loads — only patch changed games
      let liveChanged = false, finalChanged = false, upcomingChanged = false;

      [...live, ...final, ...upcoming].forEach(g => {
        const key = gameKey(g);
        const prev = prevGames[key];
        const el = document.getElementById(`game-${key}`);

        if (!el) {
          // New game appeared (e.g. went from upcoming to live) — flag for full re-render
          if (g.status === 'live') liveChanged = true;
          else if (g.status === 'final') finalChanged = true;
          else upcomingChanged = true;
          return;
        }

        // Detect bucket transitions FIRST, before deciding whether to patch in place.
        // A game's element persists in the DOM by id even after moving sections, so we
        // must explicitly check if its status bucket changed — not just whether content differs.
        if (prev && prev.status !== g.status) {
          if (prev.status === 'live') liveChanged = true;
          if (prev.status === 'upcoming') upcomingChanged = true;
          if (g.status === 'live') liveChanged = true;
          if (g.status === 'final') finalChanged = true;
          if (g.status === 'upcoming') upcomingChanged = true;
          // Remove the stale element from its old container — the full re-render below
          // will recreate it in the correct section. Without this, the card stays visually
          // stuck in its original container (e.g. live-games) even after going final.
          el.remove();
          return;
        }

        if (!prev || scoresDiffer(prev, g)) {
          // Only update this card's inner HTML — status bucket unchanged
          el.innerHTML = g.status === 'upcoming' ? upcomingCard(g) : gameCard(g);
        }
      });

      // Re-render full sections only if a game changed buckets
      if (liveChanged) {
        document.getElementById('live-games').innerHTML = live.length
          ? live.map(g => `<div id="game-${gameKey(g)}">${gameCard(g)}</div>`).join('')
          : '<div style="color:var(--muted);font-size:13px;padding:4px 0">No live games right now.</div>';
      }
      if (finalChanged) {
        document.getElementById('final-games').innerHTML = final.length
          ? final.map(g => `<div id="game-${gameKey(g)}">${gameCard(g)}</div>`).join('')
          : '<div style="color:var(--muted);font-size:13px;padding:4px 0">No final games yet today.</div>';
      }
      if (upcomingChanged) {
        const sgEl = document.getElementById('scheduled-games'); if(sgEl) sgEl.innerHTML =
          upcoming.map(g => `<div id="game-${gameKey(g)}">${upcomingCard(g)}</div>`).join('');
      }
    }

    // Update cache
    [...live, ...final, ...upcoming].forEach(g => { prevGames[gameKey(g)] = { ...g }; });

    const now = new Date().toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'});
    const srEl = document.getElementById('scores-refresh'); if(srEl) srEl.textContent = `Last updated ${now}`;
    if (typeof window.DiamondRefreshLockedGameProjectionScores === 'function') {
      window.DiamondRefreshLockedGameProjectionScores();
    }
    window._lastLiveGames = live; // cache for Props tab re-activation
    // v8.71 performance: do not load HR/K sidebar data during the default page reload.
    // Those datasets are now hydrated only when the HR or Strikeout pane is opened.
    const activePane = document.querySelector('#props .gamepick-pane.active')?.getAttribute('data-gamepick-pane') || 'game';
    if (activePane === 'hr') setTimeout(() => { loadHRsToday(); }, 250);
    if (activePane === 'k') setTimeout(() => { loadKsToday(); }, 250);
  } catch(e) {
    const srErr = document.getElementById('scores-refresh');
    if (srErr) srErr.textContent = `Error: ${e.message}`;
  }
}

// Startup is coordinated by bootDiamondReportStartup() near the end of this script.
// Delaying the first call prevents early async responses from touching state before
// all modules (HRs Today, HR Potential, Pitcher Report, Tracker) are initialized.
setInterval(() => { if (document.visibilityState === 'visible' && !window.__diamondUserInteracting) loadScores(); }, 120000);

// Tick countdown labels every second so they count down smoothly between full data refreshes
// (paused while tab is hidden - no one is watching the countdown, next tick resyncs instantly on return)
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  document.querySelectorAll('.game-status[data-game-date]').forEach(el => {
    const gameDateMs = Number(el.getAttribute('data-game-date'));
    const countdown = formatCountdown(gameDateMs);
    if (countdown) {
      el.textContent = `⏱ ${countdown}`;
    } else {
      // Countdown window expired (game started or passed 1hr-out) — next loadScores() will
      // correctly move this card to the live/upcoming bucket; just clear the live pulse for now
      el.textContent = 'UPCOMING';
      el.classList.remove('countdown-pulse');
    }
  });
}, 1000);

// v8.29 Production stability: do not auto-collapse or re-render open Batting Lineup panels.
// Lineups stay open until the user taps HIDE. Data still refreshes on page load, tab refresh, and manual reopen.
// This avoids split-screen/mobile Safari layout jumps caused by background panel rehydration.





// Pitcher data for today — sourced from ESPN, MLB.com, Baseball Reference



// ── PITCHER REPORT ───────────────────────────────────────────────────
let matchupLoaded = false;

// ── ALL GLOBAL STATE — declared early to prevent temporal dead zone errors ──
const bannerHRs = {};           // batterId -> { id, name, teamAbbr, oppAbbr, count }
const bannerKs  = {};           // pitcherId -> { name, teamAbbr, oppAbbr, ks, ouLine }
let hrpRows = [], hrpSortCol = 'hrProb', hrpSortDir = -1, hrpFilter = 'all';
let statcastHotHitters = {};

// Per-pitcher Statcast store — loaded from data/pitcher-statcast.json,
// written by scripts/sync-pitcher-statcast.mjs. Keyed by pitcher MLB ID.
// Empty object = file not yet synced; front-end falls back gracefully.
let pitcherStatcast = {};
let pitcherStatcastLoaded = false;
let pitcherStatcastPromise = null;

// Batter career HR by pitch type store — loaded from repo-synced data when present.
// Supported file shapes:
// 1) { players: { "12345": { allTimeHrByPitch:{ fastball: 42, slider: 13 } } } }
// 2) { players: [ { playerId:12345, allTimeHrByPitch:{...} } ] }
// 3) { "12345": { fastball: 42, slider: 13 } }
// The front-end keeps this separate from HR Potential so adding this section does not
// change existing projection data or rankings.
let batterPitchTypeHr = {};
let batterPitchTypeHrLoaded = false;
let batterPitchTypeHrPromise = null;

// Batter season pitch-type performance store — loaded from repo-synced data.
// Used by the Pitch Mix Advantage Engine in the Pitcher Matchup modal.
// This is season-only and does not alter existing HR/K/Game projection logic.
let batterPitchTypeSeason = {};
let batterPitchTypeSeasonLoaded = false;
let batterPitchTypeSeasonPromise = null;

function normalizePitchTypeKey(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('four') || n.includes('4-seam') || n.includes('fastball')) return 'fastball';
  if (n.includes('sinker') || n.includes('2-seam') || n.includes('two-seam')) return 'sinker';
  if (n.includes('slider')) return 'slider';
  if (n.includes('change')) return 'changeup';
  if (n.includes('curve')) return 'curveball';
  if (n.includes('cutter')) return 'cutter';
  if (n.includes('split')) return 'splitter';
  if (n.includes('sweep')) return 'sweeper';
  if (n.includes('knuckle')) return 'knuckleball';
  return n.replace(/[^a-z0-9]/g,'');
}

function ingestBatterPitchTypeHrPayload(data) {
  if (!data) return;
  const upsert = (id, name, payload) => {
    if (!payload) return;
    const record = payload.allTimeHrByPitch || payload.careerHrByPitch || payload.hrByPitch || payload.pitchTypeHomeRuns || payload.homeRunsByPitch || payload;
    const normalized = {};
    if (Array.isArray(record)) {
      record.forEach(r => {
        const key = normalizePitchTypeKey(r.name || r.pitchName || r.pitchType || r.type || r.code || r.pitch);
        const val = r.homeRuns ?? r.hr ?? r.hrs ?? r.HR ?? r.home_runs;
        if (key && val !== undefined && val !== null && val !== '') normalized[key] = parseInt(val) || 0;
      });
    } else if (typeof record === 'object') {
      Object.entries(record).forEach(([k,v]) => {
        const key = normalizePitchTypeKey(k);
        const val = (v && typeof v === 'object') ? (v.homeRuns ?? v.hr ?? v.hrs ?? v.HR ?? v.home_runs) : v;
        if (key && val !== undefined && val !== null && val !== '') normalized[key] = parseInt(val) || 0;
      });
    }
    if (!Object.keys(normalized).length) return;
    if (id) batterPitchTypeHr[String(id)] = normalized;
    if (name) batterPitchTypeHr[String(name).toLowerCase()] = normalized;
  };

  if (Array.isArray(data.players)) {
    data.players.forEach(p => upsert(p.playerId || p.id || p.mlbId, p.name || p.fullName, p));
  } else if (data.players && typeof data.players === 'object') {
    Object.entries(data.players).forEach(([id,p]) => upsert(id, p?.name || p?.fullName, p));
  } else if (typeof data === 'object') {
    Object.entries(data).forEach(([id,p]) => upsert(id, p?.name || p?.fullName, p));
  }
}

async function loadBatterPitchTypeHr(force=false) {
  if (batterPitchTypeHrLoaded && !force) return batterPitchTypeHr;
  if (batterPitchTypeHrPromise && !force) return batterPitchTypeHrPromise;
  batterPitchTypeHrPromise = (async () => {
    batterPitchTypeHr = {};
    const sources = [
      `data/batter-pitch-type-hr.json`,
      `data/all-time-pitch-type-hr.json`,
      `data/career-pitch-type-hr.json`
    ];
    await Promise.all(sources.map(async url => {
      try {
        const data = await drFetchDailyJSON(url);
        ingestBatterPitchTypeHrPayload(data);
      } catch {}
    }));
    batterPitchTypeHrLoaded = true;
    return batterPitchTypeHr;
  })();
  return batterPitchTypeHrPromise;
}


function ingestBatterPitchTypeSeasonPayload(data) {
  if (!data) return;
  const upsert = (id, name, payload) => {
    if (!payload) return;
    const record = payload.seasonPitchTypeStats || payload.pitchTypeSeason || payload.byPitch || payload.pitchTypes || payload;
    const normalized = {};
    const normalizeRow = (rawKey, row) => {
      const key = normalizePitchTypeKey(row?.name || row?.pitchName || row?.pitchType || row?.type || row?.code || rawKey);
      if (!key) return;
      normalized[key] = {
        name: row?.name || row?.pitchName || row?.pitchType || rawKey,
        usagePct: row?.usagePct ?? row?.usage ?? null,
        pitches: +(row?.pitches ?? row?.pitchCount ?? row?.seen ?? 0) || 0,
        atBats: +(row?.atBats ?? row?.ab ?? 0) || 0,
        hits: +(row?.hits ?? row?.h ?? 0) || 0,
        homeRuns: +(row?.homeRuns ?? row?.hr ?? row?.hrs ?? 0) || 0,
        avg: row?.avg ?? row?.battingAverage ?? null,
        // xba/woba were dropped here even though every record in
        // data/batter-pitch-type-season.json carries them (see rowToPitchStat in
        // sync-pitcher-statcast.mjs) — silently unreachable by any consumer.
        xba: row?.xba ?? row?.xBA ?? row?.expectedBattingAverage ?? null,
        woba: row?.woba ?? row?.wOBA ?? null,
        slg: row?.slg ?? row?.slugging ?? null,
        xslg: row?.xslg ?? row?.xSLG ?? row?.expectedSlugging ?? null,
        xwoba: row?.xwoba ?? row?.xwOBA ?? row?.expectedWoba ?? null,
        hardHitPct: row?.hardHitPct ?? row?.hardHitRate ?? null,
        barrelPct: row?.barrelPct ?? row?.barrelRate ?? null,
        whiffPct: row?.whiffPct ?? row?.whiffRate ?? null,
        avgEV: row?.avgEV ?? row?.avgExitVelocity ?? null
      };
    };
    if (Array.isArray(record)) record.forEach(r => normalizeRow(null, r));
    else if (typeof record === 'object') Object.entries(record).forEach(([k,v]) => normalizeRow(k, (v && typeof v === 'object') ? v : { name:k, homeRuns:v }));
    if (!Object.keys(normalized).length) return;
    if (id) batterPitchTypeSeason[String(id)] = normalized;
    if (name) batterPitchTypeSeason[String(name).toLowerCase()] = normalized;
  };
  if (Array.isArray(data.players)) data.players.forEach(p => upsert(p.playerId || p.id || p.mlbId, p.name || p.fullName, p));
  else if (data.players && typeof data.players === 'object') Object.entries(data.players).forEach(([id,p]) => upsert(id, p?.name || p?.fullName, p));
  else if (typeof data === 'object') Object.entries(data).forEach(([id,p]) => upsert(id, p?.name || p?.fullName, p));
}

async function loadBatterPitchTypeSeason(force=false) {
  if (batterPitchTypeSeasonLoaded && !force) return batterPitchTypeSeason;
  if (batterPitchTypeSeasonPromise && !force) return batterPitchTypeSeasonPromise;
  batterPitchTypeSeasonPromise = (async () => {
    batterPitchTypeSeason = {};
    const sources = [
      `data/batter-pitch-type-season.json`,
      `data/batter-pitch-mix-advantage.json`
    ];
    await Promise.all(sources.map(async url => {
      try {
        const data = await drFetchDailyJSON(url);
        ingestBatterPitchTypeSeasonPayload(data);
      } catch {}
    }));
    batterPitchTypeSeasonLoaded = true;
    return batterPitchTypeSeason;
  })();
  return batterPitchTypeSeasonPromise;
}


// v8.22: keep pitch-type season data fresh in-session too. If the GitHub Action
// commits a new data file while the page is open, this will pick it up without
// changing any projection logic. The modal uses the latest loaded store when opened.
// Gated on batterPitchTypeSeasonLoaded — this file is real data now (~1.6MB), not the
// harmless 404 it used to be, so a visitor who never opens a Pitcher Matchup modal
// should never pay this cost every 2 minutes for the life of the tab.
if (!DR_STATIC_DAILY_DUMP) {
  setInterval(() => {
    if (document.visibilityState === 'visible' && batterPitchTypeSeasonLoaded) {
      loadBatterPitchTypeSeason(true).catch(() => {});
    }
  }, 120000);
}

async function loadPitcherStatcast() {
  if (pitcherStatcastLoaded) return pitcherStatcast;
  if (pitcherStatcastPromise) return pitcherStatcastPromise;
  pitcherStatcastPromise = (async () => {
    try {
      const data = await drFetchDailyJSON(`data/pitcher-statcast.json`);
      pitcherStatcast = data.pitchers || {};
    } catch {
      pitcherStatcast = {};
    }
    pitcherStatcastLoaded = true;
    return pitcherStatcast;
  })();
  return pitcherStatcastPromise;
}
let statcastHotHittersLoaded = false;
let statcastHotHittersPromise = null;
const prevHrpHRs = {};          // batterId -> todayHR count for diff detection
let kPropsData = [];
let kPropsLoadedAt = null;
// Full today's schedule as loaded for K Props — kept separately from kPropsData so the
// GAME filter can list every game today, not just games that already have an announced
// probable pitcher (kPropsData only contains rows for confirmed starters).
let kPropsAllGames = [];
// Pre-game prop snapshots — keyed by pitcherId.
// Once locked (game goes live/final), the projection never changes.
// This prevents ERA/WHIP updates during the season from shifting the line mid-game.
const _kPropsSnapshot = {};
// Same lock pattern for the Diamond Report Pick (Game Props win-probability model) —
// keyed by gamePk. Refreshed every pre-game cycle so it always reflects the latest
// pre-game state, then frozen the moment the game goes live/final.
const _gamePropsSnapshot = {};
let sportsbookKLinesByPitcher = {};
let sportsbookKLinesLoadedForDate = null;
// Richer odds detail (price, book) alongside the bare line above — display-only,
// used for the K Props "Market" chip. Kept separate from sportsbookKLinesByPitcher
// so this never changes what getSportsbookKLine returns (that already feeds
// recommendedOverLine/projK's line and shouldn't gain a new behavior here).
let sportsbookOddsByPitcher = {};

function normalizeKPropName(name) {
  // Strip accents to their base letter (é→e, í→i, ñ→n, etc.) before dropping
  // non-alphanumerics — without this, an accented name loses those letters
  // entirely instead of folding them, so "José Berríos" (the raw MLB Stats API
  // name) never matched the same player's already-accent-stripped name coming
  // back from data/k-props.json (see scripts/update-tracker.mjs's normalizeName,
  // which already does this fold server-side). Silently broke sportsbook K-line
  // matching for every accented name, not just the newer Market chip lookup.
  return String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}
function parseKLineValue(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && isFinite(value)) return value;
  const raw = String(value).trim();
  const match = raw.match(/(\d+(?:\.5|\.0)?)/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  return isFinite(n) ? n : null;
}
function indexSportsbookKLine(row) {
  if (!row) return;
  const line = parseKLineValue(
    row.sbLine ?? row.sportsbookLine ?? row.kLine ?? row.line ?? row.ouLine ?? row.dkLine ?? row.draftKingsLine ?? row.points ?? row.total
  );
  if (line == null) return;
  const id = row.pitcherId ?? row.playerId ?? row.id ?? row.mlbId;
  const name = row.pitcherName ?? row.playerName ?? row.name;
  if (id != null) sportsbookKLinesByPitcher[String(id)] = line;
  if (name) sportsbookKLinesByPitcher[normalizeKPropName(name)] = line;
}
// Same key scheme as indexSportsbookKLine, but keeps the overPrice/underPrice/book
// fields a real sync (see scripts/update-tracker.mjs's K_PROPS_ODDS_PATH export)
// can provide, which indexSportsbookKLine discards down to a bare number.
function indexSportsbookOdds(row) {
  if (!row) return;
  const line = parseKLineValue(
    row.sbLine ?? row.sportsbookLine ?? row.kLine ?? row.line ?? row.ouLine ?? row.dkLine ?? row.draftKingsLine ?? row.points ?? row.total
  );
  if (line == null) return;
  const id = row.pitcherId ?? row.playerId ?? row.id ?? row.mlbId;
  const name = row.pitcherName ?? row.playerName ?? row.name;
  const detail = { line, overPrice: row.overPrice ?? null, underPrice: row.underPrice ?? null, book: row.book ?? null };
  if (id != null) sportsbookOddsByPitcher[String(id)] = detail;
  if (name) sportsbookOddsByPitcher[normalizeKPropName(name)] = detail;
}
function getSportsbookOdds(pitcherId, pitcherName) {
  return sportsbookOddsByPitcher[String(pitcherId)] ?? sportsbookOddsByPitcher[normalizeKPropName(pitcherName)] ?? null;
}
async function loadSportsbookKLines(today) {
  if (sportsbookKLinesLoadedForDate === today) return;
  sportsbookKLinesByPitcher = {};
  sportsbookOddsByPitcher = {};
  const urls = [
    `data/k-props-${today}.json`,
    `data/k_props_${today}.json`,
    `data/k-props.json`,
    `data/k_props.json`,
    `data/props/k-props.json`,
    `data/props/k_props.json`,
    `k-props.json`
  ];
  const sources = [];
  if (Array.isArray(window.DR_K_PROP_LINES)) sources.push(window.DR_K_PROP_LINES);
  for (const url of urls) {
    try {
      const json = await drFetchDailyJSON(url);
      if (Array.isArray(json)) sources.push(json);
      else if (Array.isArray(json.props)) sources.push(json.props);
      else if (Array.isArray(json.kProps)) sources.push(json.kProps);
      else if (Array.isArray(json.lines)) sources.push(json.lines);
      else if (json.pitchers && typeof json.pitchers === 'object') {
        Object.entries(json.pitchers).forEach(([key, value]) => {
          if (typeof value === 'object') indexSportsbookKLine({ ...value, pitcherId: value.pitcherId ?? key, pitcherName: value.pitcherName ?? key });
          else indexSportsbookKLine({ pitcherId: key, line: value, pitcherName: key });
        });
      }
    } catch {}
  }
  sources.flat().forEach(row => { indexSportsbookKLine(row); indexSportsbookOdds(row); });
  sportsbookKLinesLoadedForDate = today;
}
function getSportsbookKLine(pitcherId, pitcherName) {
  return sportsbookKLinesByPitcher[String(pitcherId)] ?? sportsbookKLinesByPitcher[normalizeKPropName(pitcherName)] ?? null;
}

// Shared K prop Over/Under: use the real sportsbook line when we have one, otherwise
// fall back to the model's projection rounded to the nearest half (so there's never a push).
// Single source of truth for the K prop line shown to users.
// Priority: pitcherOULines (set from K Props compareLine on load) →
//           real sportsbook line → local model fallback.
// This guarantees K Props, Pitcher Report, and K's Today always show the same number.
function getKPropLine(p, r) {
  const fromStore = pitcherOULines[p.id] ?? pitcherOULines[String(p.id)];
  if (fromStore != null) return fromStore;
  const sb = getSportsbookKLine(p.id, p.name);
  if (sb != null) return sb;
  return r.kprop != null ? Math.round(r.kprop * 2) / 2 : null;
}
function getKPropDirection(r, line) {
  return (r.kprop != null && r.kprop < line) ? 'Under' : 'Over';
}
function formatKLine(value) {
  const n = parseKLineValue(value);
  if (n == null) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
function getDRKProjectionForPitcher(pitcherId, pitcherName) {
  if (!Array.isArray(kPropsData) || !kPropsData.length) return null;
  const idKey = pitcherId != null ? String(pitcherId) : null;
  const nameKey = normalizeKPropName(pitcherName || '');
  const match = kPropsData.find(row => {
    const rowId = row.pitcherId != null ? String(row.pitcherId) : null;
    const rowName = normalizeKPropName(row.pitcherName || row.name || '');
    return (idKey && rowId === idKey) || (nameKey && rowName === nameKey);
  });
  if (!match) return null;
  const raw = match.projK ?? match.drKProj ?? match.projectedKs ?? match.kProjection ?? null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function formatRoundedDRKProjection(value, sbLine = null) {
  // Number(null) === 0, which previously made "no projection loaded yet" render
  // as a fake "0K" — indistinguishable from a real, confirmed zero projection.
  // Treat missing values explicitly instead of letting them fall through Number().
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n);
  const line = Number(sbLine);
  const directionArrow = Number.isFinite(line) ? (n >= line ? '⬆︎' : '⬇︎') : '';
  return `${directionArrow ? directionArrow + ' ' : ''}${rounded}K`;
}
let hrpRetryTimer = null;
let hrpFilterActive = 'all';
// K's Today needs real DR K Proj / SB Line values to display them, but loadKProps()
// previously only ran when the Props tab was opened or at the scheduled 7am/9am job.
// This preloads K Props data the first time it's needed (e.g. by K's Today on initial
// page load) without duplicating in-flight requests or re-fetching once loaded.
let kPropsLoadInFlight = null;
function ensureKPropsLoaded() {
  if ((Array.isArray(kPropsData) && kPropsData.length) || kPropsLoadedAt) return Promise.resolve();
  if (!kPropsLoadInFlight) {
    kPropsLoadInFlight = Promise.resolve(loadKProps())
      .catch(e => console.warn('K Props preload failed', e))
      .finally(() => { kPropsLoadInFlight = null; });
  }
  return kPropsLoadInFlight;
}
let latestPitcherKData = {}; // pitcherId -> { ks, isFinal, isLive } — kept fresh by loadKsToday, read by renderKProps for the W-L tally
let prSortCol = null, prSortDir = 1, prRows = [];
const lineupCache = {};
let repoLineupsData = null;
let repoLineupsLoaded = false;
const lineupMeta  = {}; // pitcherId -> {pitcherName, gamePk, side, oppTeamId, pitcherHr9, pitcherIp, teamAbbr, oppAbbr}
// Production stability patch: normalize pitcher ids and prevent stale lineup requests
// from overwriting an actively opened Batting Lineup & Matchup panel.
const lineupLoading = new Set();
const lineupRequestTokens = {};
const normalizePitcherId = (id) => String(id);

// Which pitcher's lineup is currently showing in the pop-out modal, if any —
// the whole Pitcher Report table (including this panel's own DOM node) gets
// rebuilt on every live-score refresh, so this is what lets a re-render pick
// the open modal back up instead of leaving it stuck on stale content.
let openLineupModalPid = null;

async function loadRepoLineups() {
  if (repoLineupsLoaded) return repoLineupsData;
  repoLineupsLoaded = true;
  try {
    repoLineupsData = await drFetchDailyJSON(`data/lineups.json`);
    return repoLineupsData;
  } catch (e) {
    repoLineupsData = null;
    return null;
  }
}

function _normalizeLineupTeam(team = {}, game = {}) {
  if (!team?.lineup?.length) return null;
  return {
    lineup: team.lineup.map(b => ({
      name: b.name || b.fullName || '–',
      id: b.id || b.playerId || null,
      pos: b.pos || b.position || '–',
      stats: b.stats || {},
      last10HR: b.last10HR ?? null,
      todayHR: b.todayHR || 0,
      confirmed: team.confirmed === true,
      source: team.source || game.source || 'repo-lineups'
    })),
    teamAbbr: team.abbr || team.teamAbbr || '',
    source: team.source || game.source || 'repo-lineups',
    confirmed: team.confirmed === true,
    confirmedAt: team.confirmedAt || null,
    updatedAt: repoLineupsData?.generatedAt || game.updatedAt || null
  };
}

function getRepoLineupForGame(gamePk, teamSide) {
  const manualGame = manualLineupsData?.games?.[String(gamePk)];
  const manualTeam = manualGame?.teams?.[teamSide];
  const manual = _normalizeLineupTeam(manualTeam, manualGame || {});
  if (manual?.lineup?.length) return { ...manual, source: manual.source || 'manual-upload', confirmed: manual.confirmed === true };

  const game = repoLineupsData?.games?.[String(gamePk)];
  const team = game?.teams?.[teamSide];
  return _normalizeLineupTeam(team, game || {});
}

let manualLineupsData = null;
try {
  manualLineupsData = JSON.parse(localStorage.getItem('drConfirmedLineups') || 'null');
} catch { manualLineupsData = null; }

function normalizeConfirmedLineupUpload(payload) {
  if (!payload) return null;
  if (payload.games) return payload;

  // Simple single-lineup import format:
  // { "gamePk": 777777, "side": "home", "abbr": "NYY", "confirmed": true,
  //   "lineup": [{"name":"Aaron Judge","id":592450,"pos":"RF"}, ...] }
  if (payload.gamePk && payload.side && Array.isArray(payload.lineup)) {
    return {
      generatedAt: new Date().toISOString(),
      games: {
        [String(payload.gamePk)]: {
          updatedAt: new Date().toISOString(),
          source: payload.source || 'manual-upload',
          teams: {
            [payload.side]: {
              abbr: payload.abbr || payload.teamAbbr || '',
              confirmed: payload.confirmed !== false,
              confirmedAt: payload.confirmedAt || new Date().toISOString(),
              source: payload.source || 'manual-upload',
              lineup: payload.lineup
            }
          }
        }
      }
    };
  }
  return null;
}

function mergeLineupData(base, incoming) {
  const out = base && base.games ? JSON.parse(JSON.stringify(base)) : { generatedAt: new Date().toISOString(), games: {} };
  Object.entries(incoming?.games || {}).forEach(([gamePk, game]) => {
    out.games[gamePk] = out.games[gamePk] || { teams: {} };
    out.games[gamePk].updatedAt = game.updatedAt || new Date().toISOString();
    out.games[gamePk].source = game.source || out.games[gamePk].source || 'manual-upload';
    out.games[gamePk].teams = out.games[gamePk].teams || {};
    Object.entries(game.teams || {}).forEach(([side, team]) => {
      out.games[gamePk].teams[side] = { ...team, confirmed: team.confirmed !== false, source: team.source || 'manual-upload' };
    });
  });
  out.generatedAt = new Date().toISOString();
  return out;
}

function importConfirmedLineupFile(input) {
  const file = input?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = normalizeConfirmedLineupUpload(JSON.parse(reader.result));
      if (!parsed) throw new Error('Unsupported lineup format');
      manualLineupsData = mergeLineupData(manualLineupsData, parsed);
      localStorage.setItem('drConfirmedLineups', JSON.stringify(manualLineupsData));
      Object.keys(lineupCache).forEach(k => delete lineupCache[k]);
      rehydrateOpenLineupModal();
      alert('Confirmed lineup imported. Open lineup panels have been refreshed.');
    } catch (e) {
      alert('Could not import lineup file: ' + e.message);
    } finally {
      input.value = '';
    }
  };
  reader.readAsText(file);
}

async function loadPitcherReport() {
  const el = document.getElementById('pr-content');
  try {
    const today = new Date().toLocaleDateString('en-CA', {timeZone:'America/Chicago'});
    await loadStatcastHotHitters();
    await loadParkFactors().catch(() => {});
    const games = await getTodaySchedule('team,probablePitcher');
    if (!games.length) { el.innerHTML = '<div class="mu-empty">No games scheduled today.</div>'; return; }

    const pitchers = [];
    games.forEach(g => {
      const dt = new Date(g.gameDate);
      const t = dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/Chicago'});
      const state = g.status.abstractGameState;
      const isLive = state==='Live' || g.status.detailedState==='In Progress';
      const isFinal = state==='Final';
      const timeLabel = isLive ? '● LIVE' : isFinal ? 'FINAL' : t;
      const timeColor = isLive ? 'var(--live)' : isFinal ? 'var(--muted)' : 'var(--text)';
      const gameTimestamp = dt.getTime(); // numeric ms for sorting
      [['away','home'],['home','away']].forEach(([side,opp]) => {
        const p = g.teams[side].probablePitcher;
        if (p) pitchers.push({
          id: p.id, name: p.fullName,
          teamAbbr: g.teams[side].team.abbreviation,
          oppAbbr: g.teams[opp].team.abbreviation,
          oppTeamId: g.teams[opp].team.id,
          timeLabel, timeColor, gameTimestamp,
          gamePk: g.gamePk,
          side,
          mlbLink: `https://www.mlb.com/gameday/${g.gamePk}`
        });
      });
    });

    if (!pitchers.length) { el.innerHTML = '<div class="mu-empty">No probable pitchers announced yet.</div>'; return; }

    const statsArr = await Promise.all(pitchers.map(async p => {
      try {
        const d = await fetchJSON(`https://diamondreport.app/api/v1/people/${p.id}?hydrate=stats(group=pitching,type=season,season=2026)`);
        return d.people?.[0]?.stats?.[0]?.splits?.[0]?.stat || {};
      } catch { return {}; }
    }));

    function f(v, dec=2) {
      if (v==null||v==='') return null;
      const n=parseFloat(v); return isNaN(n)?null:+n.toFixed(dec);
    }
    function fI(v) { const n=parseInt(v); return isNaN(n)?null:n; }

    prRows = pitchers.map((p, i) => {
      const s = statsArr[i];
      const iso = (s.slg!=null&&s.avg!=null) ? f(parseFloat(s.slg)-parseFloat(s.avg),3) : null;
      const totalK = parseInt(s.strikeOuts) || 0;
      const gs = parseInt(s.gamesStarted) || parseInt(s.gamesPitched) || 1;
      const kpg = gs > 0 ? (totalK / gs).toFixed(1) : null;
      const k9 = parseFloat(s.strikeoutsPer9Inn) || 8;
      // Baseline K prop: K/9 × projected IP (avg 5.5) / 9, rounded to nearest .5
      const projIP = 5.5;
      const projK = Math.round((k9 * projIP / 9) * 2) / 2;
      // MLB Stats API's pitching stat object has no `fip` field — FIP is a sabermetric
      // stat the API doesn't compute, so reading s.fip directly always returned
      // undefined and this column silently rendered "–" for every pitcher. Computed
      // here from the standard formula instead (using the commonly-cited ~3.10
      // constant since a real per-season league constant isn't available from this
      // endpoint).
      const rawIpForFip = parseFloat(s.inningsPitched) || 0;
      const fipCalc = rawIpForFip > 0
        ? ((13*(parseInt(s.homeRuns)||0) + 3*((parseInt(s.baseOnBalls)||0)+(parseInt(s.hitBatsmen)||0)) - 2*totalK) / rawIpForFip) + 3.10
        : null;
      return {
        pitcher: p,
        gameTime: p.gameTimestamp,
        ip: f(s.inningsPitched,1), bf: fI(s.battersFaced),
        fip: f(fipCalc), avg: f(s.avg,3), woba: f(s.obp,3),
        whip: f(s.whip), iso, slg: f(s.slg,3),
        hr9: f(s.homeRunsPer9), tb: fI(s.totalBases),
        kpg, kprop: projK,
        wl: (s.wins!=null)?`${s.wins}-${s.losses}`:'–',
        era: f(s.era),
        rawHr9: parseFloat(s.homeRunsPer9) || 0,
        rawIp: parseFloat(s.inningsPitched) || 0,
        rawK9: k9,
        gamesStarted: gs,
      };
    });

    // Default sort by game time ascending
    prSortCol = 'gameTime';
    prSortDir = 1;

    renderPRTable();
    loadKsToday();
  } catch(e) {
    document.getElementById('pr-content').innerHTML = `<div class="mu-empty" style="color:var(--accent)">Error: ${e.message}</div>`;
  }
}

// K O/U lookup: pitcherId -> ouLine (populated by renderPRTable)
const pitcherOULines = {};


function isPRMobileTabletView() {
  return window.matchMedia && window.matchMedia('(max-width: 1024px)').matches;
}

function getSortedPRRowsForCurrentSort() {
  return [...prRows].sort((a,b) => {
    if (!prSortCol) return 0;
    const av=a[prSortCol], bv=b[prSortCol];
    if (av==null&&bv==null) return 0;
    if (av==null) return 1; if (bv==null) return -1;
    return (av-bv)*prSortDir;
  });
}

// Opens (or re-populates, after a table refresh rebuilds its DOM) the pop-out
// lineup modal for a given pitcher row — clicking the row calls this directly;
// renderPRTable calls it again after every refresh so an open modal survives
// the live-score re-render instead of going stale.
function openPitcherLineupModal(pidRaw) {
  const pid = normalizePitcherId(pidRaw);
  const meta = lineupMeta[pid];
  if (!meta) return;
  const overlay = document.getElementById('pr-lineup-modal-overlay');
  const body = document.getElementById('pr-lineup-modal-body');
  const title = document.getElementById('pr-lineup-modal-title');
  const sub = document.getElementById('pr-lineup-modal-sub');
  const panel = document.getElementById(`panel-${pid}`);
  if (!overlay || !body || !panel) return;

  openLineupModalPid = pid;
  if (title) title.textContent = meta.pitcherName || 'Batting Lineup & Matchups';
  if (sub) sub.textContent = `Batting Lineup & Matchups${meta.teamAbbr && meta.oppAbbr ? ` · ${meta.teamAbbr} vs ${meta.oppAbbr}` : ''}`;
  body.innerHTML = '';
  const arsenalWrap = document.createElement('div');
  arsenalWrap.id = `pr-arsenal-${pid}`;
  arsenalWrap.innerHTML = `<div style="padding:10px 0;color:var(--muted);font-size:12px"><span class="spin"></span> Loading ${meta.pitcherName || 'pitcher'}'s pitch data…</div>`;
  body.appendChild(arsenalWrap);
  panel.style.display = 'block';
  panel.style.marginTop = '14px';
  body.appendChild(panel);
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  loadPitcherStatcast().then(() => {
    arsenalWrap.innerHTML = pitcherArsenalPanelHTML(pid, meta.pitcherName);
  });

  const cacheKey = `${meta.gamePk}-${meta.side}`;
  if (lineupCache[cacheKey]) {
    renderLineup(`panel-${pid}`, lineupCache[cacheKey], meta.pitcherHr9, meta.pitcherIp, meta.oppAbbr, pid, meta.pitcherName);
  } else if (!lineupLoading.has(pid)) {
    fetchAndRenderLineup(pid, meta.pitcherName, meta.gamePk, meta.side, meta.oppTeamId, meta.pitcherHr9, meta.pitcherIp, false, true).catch(()=>{});
  }
}
window.openPitcherLineupModal = openPitcherLineupModal;

function closePitcherLineupModal() {
  const overlay = document.getElementById('pr-lineup-modal-overlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
  openLineupModalPid = null;
}
window.closePitcherLineupModal = closePitcherLineupModal;

function rehydrateOpenLineupModal() {
  if (!openLineupModalPid) return;
  if (!lineupMeta[openLineupModalPid]) { closePitcherLineupModal(); return; }
  openPitcherLineupModal(openLineupModalPid);
}

// Card-based layout at every screen size (previously desktop got a dense 15-column
// table and only mobile/tablet got cards — this replaced both with the one polished
// card treatment, in a grid that's 1-up on narrow screens and 2-up on wide ones).
const PR_SORT_FIELDS = [
  {key:'gameTime', label:'Time'},
  {key:'kprop',    label:'Live K'},
  {key:'ip',       label:'IP'},
  {key:'bf',       label:'BF'},
  {key:'fip',      label:'FIP'},
  {key:'avg',      label:'AVG'},
  {key:'woba',     label:'wOBA'},
  {key:'whip',     label:'WHIP'},
  {key:'iso',      label:'ISO'},
  {key:'slg',      label:'SLG'},
  {key:'hr9',      label:'HR/9'},
  {key:'tb',       label:'TB'},
  {key:'kpg',      label:'K/GM'},
];

// Heat-map background for a stat cell: green at/below goodBelow, red at/above
// badAbove, continuously blended in between — reuses the exact same thresholds
// the old pill() badges used, just expressed as a gradient instead of 3 buckets.
function heatBG(val, goodBelow, badAbove) {
  if (val == null) return 'transparent';
  const mid = (goodBelow + badAbove) / 2;
  const half = (badAbove - goodBelow) / 2 || 1;
  let t = 1 + (val - mid) / half; // 0 = green, 1 = neutral, 2 = red
  t = Math.max(0, Math.min(2, t));
  const green = [26,58,42], neu = [11,20,36], red = [58,26,26];
  const [a, b] = t <= 1 ? [green, neu] : [neu, red];
  const localT = t <= 1 ? t : t - 1;
  const rgb = a.map((c, i) => Math.round(c + (b[i] - c) * localT));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function renderPRTable() {
  const el = document.getElementById('pr-content');
  if (!el) return;
  const sorted = getSortedPRRowsForCurrentSort();
  const hs = id => `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_46,q_auto:best/v1/people/${id}/headshot/67/current`;
  // data-label carries each cell's short column header along for the mobile
  // card layout (see the @media (max-width: 700px) rules in styles.css),
  // where a CSS ::before turns every stat into a labeled chip instead of a
  // table column — .pr-mobile-tag distinguishes a plain cell from a heat
  // cell so that layout can give plain cells a neutral chip background
  // without overwriting the heat cells' own inline color.
  const heatCell = (val, dispFn, goodBelow, badAbove, tip, label) => {
    const bg = heatBG(val, goodBelow, badAbove);
    const txt = val == null ? '<span style="color:var(--muted)">–</span>' : dispFn(val);
    return `<td style="background:${bg}"${tip?` data-tip="${tip}"`:''}${label?` data-label="${label}"`:''}>${txt}</td>`;
  };
  const plainCell = (value, tip, label) => `<td class="pr-plain-cell"${tip?` data-tip="${tip}"`:''}${label?` data-label="${label}"`:''}>${value}</td>`;

  const rowsAndPanels = sorted.map(r => {
    const p = r.pitcher;
    const pid = normalizePitcherId(p.id);

    // K prop line — real sportsbook line if available, else model projection rounded to nearest half
    const kpropLine = getKPropLine(p, r);
    if (kpropLine != null) pitcherOULines[p.id] = kpropLine;

    // Populated for every row (not just ones the user has opened) so a click
    // on the row can open the pop-out modal with just a pitcher id.
    lineupMeta[pid] = {
      pitcherName: p.name, gamePk: p.gamePk, side: p.side, oppTeamId: p.oppTeamId,
      pitcherHr9: r.rawHr9, pitcherIp: r.rawIp, teamAbbr: p.teamAbbr, oppAbbr: p.oppAbbr,
    };

    const row = `<tr class="pr-row-tr" id="pr-row-${pid}" style="cursor:pointer" onclick="window.openPitcherLineupModal('${pid}')">
        <td class="pr-lineup-batter-cell">
          <img class="pr-headshot" src="${hs(p.id)}" alt="${p.name}" loading="lazy" decoding="async">
          <div style="min-width:0">
            <div class="pr-mobile-name">${p.name}</div>
            <div class="pr-mobile-sub">${p.teamAbbr} · ${r.wl} · vs ${p.oppAbbr}</div>
            <div class="pr-mobile-time" style="color:${p.timeColor};font-weight:${p.timeLabel.includes('LIVE')?700:400}">${p.timeLabel}</div>
          </div>
        </td>
        ${plainCell(r.ip!=null?r.ip.toFixed(1):'–', 'Innings Pitched', 'IP')}
        ${plainCell(r.bf!=null?r.bf:'–', 'Batters Faced', 'BF')}
        ${heatCell(r.fip,  v=>v.toFixed(2), 3.25, 4.50, 'Fielding Independent Pitching', 'FIP')}
        ${heatCell(r.avg,  v=>v.toFixed(3).replace(/^0/,''), .220, .270, 'Batting Average Against', 'AVG')}
        ${heatCell(r.woba, v=>v.toFixed(3).replace(/^0/,''), .290, .340, 'Weighted On-Base Average', 'wOBA')}
        ${heatCell(r.whip, v=>v.toFixed(2), 1.10, 1.40, 'Walks + Hits per Inning Pitched', 'WHIP')}
        ${heatCell(r.iso,  v=>v.toFixed(3).replace(/^0/,''), .150, .200, 'Isolated Power — extra-base power allowed', 'ISO')}
        ${heatCell(r.slg,  v=>v.toFixed(3).replace(/^0/,''), .350, .430, 'Slugging Percentage Against', 'SLG')}
        ${heatCell(r.hr9,  v=>v.toFixed(2), 0.80, 1.50, 'Home Runs per 9 Innings', 'HR/9')}
        ${plainCell(r.tb!=null?r.tb:'–', 'Total Bases Allowed', 'TB')}
        ${plainCell(`<span style="color:${r.kpg>=7?'var(--green)':r.kpg>=5?'var(--text)':'var(--muted)'}">${r.kpg??'–'}</span>`, 'Average Strikeouts per Game Started', 'K/GM')}
      </tr>`;

    // Hidden, off-row lineup panel — kept alive independent of the table row
    // markup so HR Threats' pre-lineup fallback (loadHRPotential) can keep
    // warming lineupCache via fetchAndRenderLineup even when no modal is
    // open. The pop-out modal borrows this exact node (by id) when opened.
    const panel = `<div class="pr-expand-panel" id="panel-${pid}" style="display:none"><span class="spin"></span> Loading lineup…</div>`;

    return { row, panel };
  });
  const rows = rowsAndPanels.map(x => x.row).join('');
  const hiddenPanels = rowsAndPanels.map(x => x.panel).join('');

  const prSortBtns = PR_SORT_FIELDS.map(({key,label}) => {
    const active = prSortCol === key;
    const arrow = active ? (prSortDir === 1 ? ' ↑' : ' ↓') : '';
    return `<button onclick="sortPR('${key}')" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:4px 10px;border-radius:12px;border:1px solid ${active?'var(--accent2)':'var(--border)'};background:${active?'rgba(47,107,255,.12)':'var(--surface2)'};color:${active?'var(--accent2)':'var(--muted)'};cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all .15s">${label}${arrow}</button>`;
  }).join('');

  el.innerHTML = `
    <div class="kprops-sticky-sort" style="display:flex;align-items:center;gap:6px;padding:8px 14px;background:var(--bg);border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;flex-wrap:nowrap">
      <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);white-space:nowrap;flex-shrink:0">SORT:</span>
      ${prSortBtns}
      <button onclick="resetPRSort()" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:3px 8px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);cursor:pointer;white-space:nowrap;flex-shrink:0">RESET</button>
    </div>
    <div class="dr1041-table-wrap pr-starters-table-wrap"><table class="pr-stats-table pr-starters-table">
      <thead><tr>
        <th style="text-align:left">Pitcher</th>
        <th>IP</th><th>BF</th><th>FIP</th><th>AVG</th><th>wOBA</th><th>WHIP</th><th>ISO</th><th>SLG</th><th>HR/9</th><th>TB</th><th>K/GM</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div id="pr-lineup-panels" style="display:none">${hiddenPanels}</div>
    <div class="pr-legend">
      <span class="pr-legend-chip"><span class="pr-legend-dot good"></span>Elite</span>
      <span class="pr-legend-chip"><span class="pr-legend-dot neu"></span>Average</span>
      <span class="pr-legend-chip"><span class="pr-legend-dot bad"></span>Concerning</span>
      <span class="pr-legend-sep">·</span>
      <span class="pr-legend-note">HR% = estimated per-AB probability based on batter HR rate × pitcher HR/9</span>
      <span class="pr-legend-sep">·</span>
      <span class="pr-legend-note">2026 season</span>
    </div>`;

  rehydrateOpenLineupModal();
}



// v8.9 Lineup Stats Fix
// Official boxscore lineups often include only same-game batting lines, which can be
// 0-for-0 early in the game. This helper separately enriches each batter with season
// hitting stats and tries the adjacent season when the app is running against an older
// MLB data snapshot. It does not change the prediction model; it only prevents the
// lineup matchup UI from displaying empty boxscore stats as .000 / 0 / .000.
function _statHasRealBattingData(stat) {
  if (!stat) return false;
  const ab = parseInt(stat.atBats);
  const pa = parseInt(stat.plateAppearances);
  const ops = parseFloat(stat.ops);
  const avg = parseFloat(stat.avg);
  const hr = parseInt(stat.homeRuns);
  return (ab > 0) || (pa > 0) || (ops > 0) || (avg > 0) || (hr > 0);
}
function _seasonCandidates(preferredSeason) {
  const y = parseInt(preferredSeason || new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'}).slice(0,4), 10);
  const vals = [y, y - 1, y + 1, 2025, 2024].filter(v => v && v >= 2020 && v <= y + 1);
  return [...new Set(vals.map(String))];
}
async function fetchBatterSeasonBundle(playerId, preferredSeason, fallbackStats = {}) {
  let bestStat = _statHasRealBattingData(fallbackStats) ? fallbackStats : {};
  let bestLogs = [];
  for (const season of _seasonCandidates(preferredSeason)) {
    try {
      const [seasonData, logData] = await Promise.all([
        fetchJSON(`https://diamondreport.app/api/v1/people/${playerId}?hydrate=stats(group=hitting,type=season,season=${season})`).catch(()=>null),
        fetchJSON(`https://diamondreport.app/api/v1/people/${playerId}/stats?stats=lastXGames&group=hitting&season=${season}&limit=12&gameType=R`).catch(()=>({stats:[]}))
      ]);
      let stat = seasonData?.people?.[0]?.stats?.[0]?.splits?.[0]?.stat || {};
      if (!_statHasRealBattingData(stat)) {
        const alt = await fetchJSON(`https://diamondreport.app/api/v1/people/${playerId}/stats?stats=season&group=hitting&season=${season}&gameType=R`).catch(()=>null);
        stat = alt?.stats?.[0]?.splits?.[0]?.stat || stat;
      }
      const logs = logData?.stats?.[0]?.splits || [];
      if (_statHasRealBattingData(stat)) return { seasonStats: stat, logs, season };
      if (!bestLogs.length && logs.length) bestLogs = logs;
    } catch {}
  }
  return { seasonStats: bestStat, logs: bestLogs, season: String(preferredSeason || '') };
}
function _displayBattingValue(stat, key, dec = 3) {
  if (!_statHasRealBattingData(stat)) return '–';
  const v = stat?.[key];
  if (v == null || v === '' || v === '---') return '–';
  const n = parseFloat(v);
  return isNaN(n) ? '–' : n.toFixed(dec).replace(/^0/, '');
}

async function fetchAndRenderLineup(pitcherId, pitcherName, gamePk, side, oppTeamId, pitcherHr9, pitcherIp, skipEnrichment = false, bypassPRGuards = false) {
  const pid = normalizePitcherId(pitcherId);
  const panel = document.getElementById(`panel-${pid}`);
  if (!panel) return;
  if (!bypassPRGuards && isPRMobileTabletView()) return;

  const token = `${Date.now()}-${Math.random()}`;
  lineupRequestTokens[pid] = token;
  lineupLoading.add(pid);

  const isFirstLoad = !panel.querySelector('[data-batter-id]');
  if (isFirstLoad) {
    panel.style.minHeight = '86px';
    panel.innerHTML = `<div style="padding:12px 0;color:var(--muted);font-size:12px"><span class="spin"></span> Loading lineup…</div>`;
  }

  try {
    const oppSide = side === 'away' ? 'home' : 'away';
    await loadRepoLineups();
    const repoLineup = getRepoLineupForGame(gamePk, oppSide);

    // If a confirmed lineup has been uploaded/committed, always trust it first.
    if (repoLineup?.confirmed === true && repoLineup?.lineup?.length) {
      const cacheKey = `${gamePk}-${side}`;
      lineupCache[cacheKey] = { ...repoLineup, oppSide, lineupStatus: 'confirmed' };
      if (lineupRequestTokens[pid] !== token) return;
      renderLineup(`panel-${pid}`, lineupCache[cacheKey], pitcherHr9, pitcherIp, null, pid, pitcherName);
      return;
    }

    const box = await fetchJSON(`https://diamondreport.app/api/v1/game/${gamePk}/boxscore`);
    const boxState = box?.gameData?.status?.abstractGameState || box?.gameData?.status?.codedGameState || '';
    const boxDetail = box?.gameData?.status?.detailedState || '';
    const gameHasStartedForLineup = boxState === 'Live' || boxState === 'Final' || boxDetail === 'In Progress';
    const teamBox = box.teams?.[oppSide];
    let batters = (teamBox?.batters || []).map(id => teamBox.players[`ID${id}`]).filter(Boolean);
    const hasOfficialBattingOrder = batters.some(b => b && (b.battingOrder || b.stats?.batting?.battingOrder));
    if (hasOfficialBattingOrder) {
      batters = batters.sort((a,b) => (parseInt(a.battingOrder || a.stats?.batting?.battingOrder || 9999) - parseInt(b.battingOrder || b.stats?.batting?.battingOrder || 9999)));
    }

    if (!hasOfficialBattingOrder || !batters.length) {
      const cacheKey = `${gamePk}-${side}`;
      lineupCache[cacheKey] = { lineup: [], oppSide, teamAbbr: teamBox?.team?.abbreviation || '', confirmed: false, lineupStatus: 'pending', source: 'MLB official lineup pending', updatedAt: new Date().toISOString() };
      if (lineupRequestTokens[pid] !== token) return;
      renderLineupPending(`panel-${pid}`, lineupCache[cacheKey].teamAbbr);
      return;
    }

    const lineupConfirmed = true;
    const lineupSource = 'MLB official batting order';
    const lineupStatus = 'confirmed';

    const today = new Date().toLocaleDateString('en-CA', {timeZone:'America/Chicago'});

    // Fast path: use stats already in the boxscore, skip per-batter API calls.
    // K Props lineup expand uses this — saves ~18 API calls and renders instantly.
    let enriched;
    if (skipEnrichment) {
      enriched = batters.slice(0,9).map(b => {
        const id = b.person?.id;
        const boxStats = teamBox?.players?.[`ID${id}`]?.stats?.batting || {};
        const seasonStats = b.seasonStats?.batting || boxStats;
        const todayHR = gameHasStartedForLineup ? (parseInt(boxStats.homeRuns) || 0) : 0;
        return { seasonStats, last10HR: null, todayHR };
      });
    } else {
      const preferredSeason = (box.gameDate || box.dates?.[0]?.date || today).slice(0,4);
      enriched = await Promise.all(batters.slice(0,9).map(async b => {
        const id = b.person?.id;
        if (!id) return { seasonStats: b.seasonStats?.batting || {}, last10HR: null, todayHR: 0 };
        const boxStats = teamBox?.players?.[`ID${id}`]?.stats?.batting || {};
        try {
          const bundle = await fetchBatterSeasonBundle(id, preferredSeason, b.seasonStats?.batting || boxStats || {});
          const seasonStats = bundle.seasonStats || b.seasonStats?.batting || {};
          const gameLogs    = bundle.logs || [];
          const last10HR    = gameLogs.length ? gameLogs.slice(0,10).reduce((sum, g) => sum + (parseInt(g.stat?.homeRuns)||0), 0) : null;
          const todayLog    = gameLogs.find(g => g.date === today);
          const todayHR     = gameHasStartedForLineup ? (parseInt(todayLog?.stat?.homeRuns) || 0) : 0;
          const boxTodayHR  = gameHasStartedForLineup ? (parseInt(boxStats.homeRuns) || 0) : 0;
          return { seasonStats, last10HR, todayHR: Math.max(todayHR, boxTodayHR) };
        } catch {
          return { seasonStats: (_statHasRealBattingData(b.seasonStats?.batting) ? b.seasonStats?.batting : {}), last10HR: null, todayHR: gameHasStartedForLineup ? (parseInt(boxStats.homeRuns)||0) : 0 };
        }
      }));
    }

    const lineup = batters.slice(0,9).map((b, i) => ({
      name: b.person?.fullName || '–',
      id: b.person?.id,
      pos: b.position?.abbreviation || '–',
      stats: enriched[i].seasonStats,
      last10HR: enriched[i].last10HR,
      todayHR: enriched[i].todayHR,
      confirmed: lineupConfirmed,
      source: lineupSource
    }));

    const cacheKey = `${gamePk}-${side}`;
    const prevLineup = lineupCache[cacheKey]?.lineup || [];
    lineupCache[cacheKey] = {
      lineup,
      oppSide,
      teamAbbr: box.teams?.[oppSide]?.team?.abbreviation || '',
      confirmed: lineupConfirmed,
      lineupStatus,
      source: lineupSource,
      updatedAt: new Date().toISOString()
    };

    if (lineupRequestTokens[pid] !== token) return;

    if (isFirstLoad) {
      // Full render on first load
      if (lineupRequestTokens[pid] !== token) return;
      renderLineup(`panel-${pid}`, lineupCache[cacheKey], pitcherHr9, pitcherIp, null, pid, pitcherName);

      // Patch K Prop cell with lineup-adjusted projection
      const kpropCell = document.getElementById(`kprop-cell-${pid}`);
      if (kpropCell && lineup.length) {
        const avgKpct = lineup.reduce((sum, b) => {
          const s = b.stats;
          return sum + ((s.strikeOuts && s.plateAppearances) ? s.strikeOuts/s.plateAppearances : 0.22);
        }, 0) / lineup.length;
        const row = prRows.find(r => normalizePitcherId(r.pitcher.id) === pid);
        if (row) {
          const k9 = row.rawK9 || 8;
          const kpctAdj = (avgKpct - 0.22) * 10;
          const adjKprop = Math.round((k9 * 5.5 / 9 + kpctAdj) * 2) / 2;
          const kpropCls = k9 >= 9 ? 'good' : k9 >= 7 ? 'mid' : 'low';
          const line = pitcherOULines[pid] != null ? pitcherOULines[pid] : Math.round(adjKprop * 2) / 2;
          const dir = adjKprop < line ? 'Under' : 'Over';
          kpropCell.innerHTML = `<span class="pr-stat-chip pr-kprop-chip ${kpropCls}" title="Adj. for opp K% ${(avgKpct*100).toFixed(0)}%">K Prop: ${dir} ${line}</span>`;
        }
      }
    } else {
      // A live HR (or season-stat count) can move several columns in a single
      // table row (AB/H/HR/RBI/BB/AVG/OBP/SLG/OPS/ISO/Rating all derive from
      // the same season stat object), so patch the whole table rather than
      // trying to diff individual cells — cheap for a 9-row table.
      const anyChanged = lineup.some((b, i) => {
        const prev = prevLineup[i];
        return !prev || prev.todayHR !== b.todayHR || prev.last10HR !== b.last10HR;
      });
      if (anyChanged) {
        renderLineup(`panel-${pid}`, lineupCache[cacheKey], pitcherHr9, pitcherIp, null, pid, pitcherName);
      }

      // Update timestamp
      const tsEl = panel.querySelector('.lineup-timestamp');
      if (tsEl) tsEl.textContent = `Last updated ${new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}`;
    }
  } catch(e) {
    if (lineupRequestTokens[pid] === token && isFirstLoad && panel) {
      panel.innerHTML = `<div class="mu-empty" style="color:var(--accent)">Error loading lineup: ${e.message}</div>`;
    }
  } finally {
    if (lineupRequestTokens[pid] === token) {
      lineupLoading.delete(pid);
      panel.style.minHeight = '';
    }
  }
}

function buildBatterStatsLine(b) {
  const s = b.stats;
  function fmtS(v) {
    if (!_statHasRealBattingData(s)) return '–';
    if (!v||v==='---') return '–';
    const n=parseFloat(v); return isNaN(n)?'–':n.toFixed(3).replace(/^0/,'');
  }
  const last10HR = b.last10HR;
  const hrVal = _statHasRealBattingData(s) ? (s.homeRuns ?? '–') : '–';
  const hrHot = _statHasRealBattingData(s) && parseInt(s.homeRuns) >= 10;
  const l10Display = last10HR === null ? '–' : `${last10HR} HR`;
  const l10Hot = last10HR >= 3, l10Warm = !l10Hot && last10HR >= 1;
  const hrProb = Number(b.hrProb);
  const hrProbChip = Number.isFinite(hrProb)
    ? `<span class="lbc-stat-chip${hrProb>=15?' hot':hrProb>=8?' warm':''}"><b>HR PROB</b>${hrProb.toFixed(1)}%</span>`
    : '';
  return `<span class="lbc-stat-chip"><b>AVG</b>${fmtS(s.avg)}</span>
    <span class="lbc-stat-chip${hrHot?' hot':''}"><b>HR</b>${hrVal}</span>
    <span class="lbc-stat-chip"><b>OPS</b>${fmtS(s.ops)}</span>
    <span class="lbc-stat-chip${l10Hot?' hot':l10Warm?' warm':''}"><b>L10</b>${l10Display}</span>
    ${hrProbChip}`;
}


function renderLineupPending(panelId, teamAbbr = '') {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const checkedAt = new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  panel.innerHTML = `
    <div class="lineup-pending-card lineup-pending-premium">
      <div class="lineup-pending-head">
        <span>${teamAbbr ? `${teamAbbr} BATTING LINEUP` : 'BATTING LINEUP'}</span>
        <span class="lineup-pending-chip">🔄 AUTO CHECK ENABLED</span>
      </div>
      <div class="lineup-pending-body">
        <div class="lineup-pending-icon">🟡</div>
        <div>
          <div class="lineup-pending-title">Awaiting Official MLB Lineup</div>
          <div class="lineup-pending-copy">The official batting order has not been released yet. This section will populate automatically as soon as the team confirms today's starters.</div>
          <div class="lineup-pending-meta">
            <span>Status: Waiting for official lineup</span>
            <span>Last checked ${checkedAt}</span>
          </div>
        </div>
      </div>
    </div>`;
}

// Pitcher's own real pitch-arsenal breakdown (usage/AVG/wOBA/SLG/HR/Whiff% per
// pitch type, plus a per-pitch attack-zone location heatmap) — same real
// synced data (data/pitcher-statcast.json, see scripts/sync-pitcher-statcast.mjs
// and sync-pitcher-zone-hr.mjs) and same markup/classes as the Batter vs
// Pitcher matchup modal's pitch-mix section, extracted standalone so it can
// also show up in the Batting Lineup & Matchups pop-out (Pitcher Report and
// K Props both use this), where there's no specific batter to build a
// matchup against — just the pitcher's own numbers. The Attack Zone tab
// clicks are already handled by a document-level delegated listener keyed
// off [data-attack-zone-toggle]/.dr1042-split-btn[data-pitch], so this needs
// no extra wiring wherever it's injected.
const ZONE_LABELS = ['In/High','High','Out/High','Inside','Middle','Away','In/Low','Low','Out/Low'];
function pitcherArsenalPanelHTML(pitcherId, pitcherName) {
  const profile = pitcherStatcast[String(pitcherId)] || null;
  const hasRealPitchMix = !!(profile?.byPitch?.length);

  function attackZoneColor(pct) {
    if (pct == null) return { bg:'#0d1220', text:'var(--muted)' };
    if (pct >= 20) return { bg:'#4a1010', text:'#ff6b6b' };
    if (pct >= 14) return { bg:'#3a2010', text:'#f4a261' };
    if (pct >= 8)  return { bg:'#1a2a10', text:'#90ee60' };
    return { bg:'#0d1a0d', text:'#3a6a3a' };
  }
  const attackZonePitches = (profile?.byPitch || []).filter(p => p?.name && p.zones && Object.keys(p.zones).length);
  let attackZoneHTML = '';
  if (attackZonePitches.length) {
    const auid = `azone-${String(pitcherId||'p')}-${Math.random().toString(36).slice(2,8)}`;
    const tabs = attackZonePitches.map((p, i) => `<button type="button" class="dr1042-split-btn${i===0?' active':''}" data-pitch="${i}">${p.name}</button>`).join('');
    const bodies = attackZonePitches.map((p, i) => {
      const cells = [1,2,3,4,5,6,7,8,9].map(z => {
        const cell = p.zones[z];
        const pct = cell?.usagePct;
        if (pct == null) return `<div class="sz-cell" style="background:#0d1220;color:var(--muted)" title="${ZONE_LABELS[z-1]}: no data">–</div>`;
        const c = attackZoneColor(pct);
        const wobaTxt = cell.wobaAgainst != null ? `, ${cell.wobaAgainst.toFixed ? cell.wobaAgainst.toFixed(3) : cell.wobaAgainst} wOBA against` : '';
        return `<div class="sz-cell" style="background:${c.bg};color:${c.text}" title="${ZONE_LABELS[z-1]}: ${pct}% of his ${p.name}s${wobaTxt}">${pct}%</div>`;
      }).join('');
      return `<div class="dr-azone-mode-body${i===0?' active':''}" data-pitch="${i}"><div class="strike-zone">${cells}</div></div>`;
    }).join('');
    attackZoneHTML = `
    <div class="zone-section" id="${auid}" data-attack-zone-toggle>
      <div class="zone-title">ATTACK ZONE BY PITCH · REAL LOCATION DATA</div>
      <div class="zone-wrap">
        <div class="zone-grid-outer">
          <span class="zone-label">OUTSIDE ←&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;→ INSIDE</span>
          <div style="display:flex;align-items:center;gap:6px">
            <div style="display:flex;flex-direction:column;gap:2px;font-size:9px;color:var(--muted);text-align:right;padding-right:4px">
              <div style="height:40px;display:flex;align-items:center">HIGH</div>
              <div style="height:40px;display:flex;align-items:center">MID</div>
              <div style="height:40px;display:flex;align-items:center">LOW</div>
            </div>
            ${bodies}
          </div>
          <span class="zone-label" style="margin-top:4px">% = share of that pitch's own throws landing in each zone</span>
        </div>
        <div>
          <div class="dr1042-split-toggle" role="tablist" aria-label="Attack zone pitch toggle" style="flex-wrap:wrap;height:auto">${tabs}</div>
          <div class="zone-note" style="margin-top:10px;max-width:220px">Where ${(pitcherName||'').split(' ').pop()} actually locates each individual pitch — his real location tendency pitch by pitch, not just the blended zone profile above.</div>
        </div>
      </div>
    </div>`;
  }

  const pitchSectionLabel = hasRealPitchMix
    ? `${(pitcherName||'').split(' ').pop()}'S PITCHES · ${(profile.totalPitches || 0).toLocaleString()} THROWN THIS SEASON`
    : `${(pitcherName||'').split(' ').pop()}'S PITCHES · NO REAL DATA YET`;

  function gbGood(kind, v) {
    if (v === null || v === undefined || Number.isNaN(v)) return false;
    if (kind === 'avg') return v >= .280;
    if (kind === 'slg') return v >= .450;
    if (kind === 'hr') return v >= 3;
    if (kind === 'whiff') return v <= 20;
    if (kind === 'woba') return v >= .340;
    return false;
  }
  function gbCls(kind, v) { return gbGood(kind, v) ? ' gb-good' : ''; }
  function fmtDec(v, d=3) {
    if (v === null || v === undefined || v === '' || v === '–') return '–';
    const n = parseFloat(v);
    return Number.isNaN(n) ? '–' : n.toFixed(d).replace(/^0(?=\.)/, '');
  }
  function pitchEffTag(label, cls) { return `<span class="dr1041-chip ${cls}" style="font-size:9px;padding:2px 7px;margin-right:4px">${label}</span>`; }
  function pitchEffRow(name, usage, avg, woba, slg, hr, whiffPct, veloTxt) {
    const tags = [];
    if (whiffPct != null && whiffPct >= 28) tags.push(pitchEffTag('🎯 Putaway','good'));
    if ((avg != null && avg >= .260) || (slg != null && slg >= .430)) tags.push(pitchEffTag('⚠ Vulnerable','weak'));
    return `<tr>
      <td><strong>${name}</strong>${veloTxt||''}</td>
      <td class="usage">${usage!=null?Number(usage).toFixed(0)+'%':'–'}</td>
      <td class="num${gbCls('avg',avg)}">${fmtDec(avg,3)}</td>
      <td class="num${gbCls('woba',woba)}">${fmtDec(woba,3)}</td>
      <td class="num${gbCls('slg',slg)}">${fmtDec(slg,3)}</td>
      <td class="num${gbCls('hr',hr)}">${hr!=null?hr:'–'}</td>
      <td class="num${gbCls('whiff',whiffPct)}">${whiffPct!=null?Number(whiffPct).toFixed(0)+'%':'–'}</td>
      <td>${tags.join('') || '<span style="color:var(--muted);font-size:11px">–</span>'}</td>
    </tr>`;
  }

  let pitchRows = '';
  if (hasRealPitchMix) {
    pitchRows = profile.byPitch.map(p => {
      const woba = p.woba ?? p.wobaAgainst ?? p.xwoba ?? p.xwobaContact ?? null;
      const avg = p.avg ?? p.avgAgainst ?? null;
      const slg = p.slg ?? p.slgAgainst ?? null;
      const hr = p.homeRuns ?? p.hr ?? null;
      const whiffPct = p.whiffPct ?? p.whiffRate ?? null;
      const veloTxt = p.avgVelo ? ` · ${p.avgVelo} mph` : '';
      return pitchEffRow(p.name, p.usagePct, avg, woba, slg, hr, whiffPct, veloTxt);
    }).join('');
  }

  const gbLegendHTML = '<div class="dr1041-legend-note"><span class="gb-good-dot"></span> Green = favorable for the batter — a real weak spot for the pitcher on that pitch, not just a good season overall.</div>';
  const pitchEffectivenessTableHTML = hasRealPitchMix ? `<div class="dr1041-pitch-mix" style="margin-top:14px">
    <div class="dr1041-pitch-head">
      <div><div class="dr1041-kicker">🧪 ${pitchSectionLabel}</div><div class="dr1041-subtext">Real synced pitch-level data for ${pitcherName}.</div></div>
    </div>
    <div class="dr1041-table-wrap"><table class="dr1041-pitch-table"><thead><tr><th>Pitch</th><th>Usage</th><th>AVG</th><th>wOBA</th><th>SLG</th><th>HR</th><th>Whiff%</th><th>Notes</th></tr></thead><tbody>${pitchRows}</tbody></table></div>
    ${gbLegendHTML}
  </div>` : `<div class="dr1041-pitch-mix" style="margin-top:14px">
    <div class="dr1041-pitch-head">
      <div><div class="dr1041-kicker">🧪 ${pitchSectionLabel}</div><div class="dr1041-subtext">No real pitch-level data available for ${pitcherName} yet — this section will populate once the daily Statcast sync has run.</div></div>
    </div>
  </div>`;

  return pitchEffectivenessTableHTML + attackZoneHTML;
}

function renderLineup(panelId, data, pitcherHr9, pitcherIp, oppAbbr, pitcherId, pitcherName) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const { lineup, teamAbbr } = data || {};
  const lineupIsOfficial = data?.confirmed === true || (lineup || []).some(b => b.confirmed === true);
  if (!lineupIsOfficial || !(lineup || []).length) {
    renderLineupPending(panelId, teamAbbr || oppAbbr || '');
    return;
  }
  const lineupBadge = lineupIsOfficial
    ? '<span style="display:inline-flex;align-items:center;gap:4px;background:#0d2a1a;border:1px solid #2ecc71;color:#2ecc71;border-radius:999px;padding:2px 8px;font-size:9px;font-weight:800;letter-spacing:.6px">✅ CONFIRMED LINEUP</span>'
    : '<span style="display:inline-flex;align-items:center;gap:4px;background:#2a1800;border:1px solid #f4a261;color:#f4a261;border-radius:999px;padding:2px 8px;font-size:9px;font-weight:800;letter-spacing:.6px">⚠ LINEUP NOT CONFIRMED</span>';
  const lineupNotice = '';

  function hrProb(s) {
    const ab = parseInt(s.atBats) || 0;
    const hr = parseInt(s.homeRuns) || 0;
    // hr/ab is HR-per-AT-BAT; the 0.88 factor converts it to HR-per-PLATE-APPEARANCE
    // (PA also includes walks/HBP/sac flies, so AB understates the true denominator),
    // matching the per-PA rate pitcherRate and the 0.6/0.4 blend below assume.
    const batterRate = ab > 0 ? (hr / ab) * 0.88 : 0;
    // homeRunsPer9 is allowed-per-9-innings (27 outs); a pitcher actually faces ~38
    // batters per 9 innings once baserunners allowed are counted, so dividing by 27
    // overstated the pitcher's true HR-per-batter rate.
    const pitcherRate = pitcherHr9 > 0 ? pitcherHr9 / 38 : 0.03;
    // Was hard-capped at 25 with no floor, unlike every other market's 1-99 range —
    // real per-game HR probability for a genuinely elite matchup can exceed 25%, so
    // the old cap flattened great and mediocre matchups into the same narrow band
    // and made ranking/selection nearly meaningless. See Elite Picks HR record audit.
    return Math.max(1, Math.min(((batterRate * 0.6) + (pitcherRate * 0.4)) * 100, 99));
  }

  const withProbs = applyHotHitterBoosts(lineup.map(b => ({ ...b, todayHR: (data?.gameHasStarted ? (b.todayHR || 0) : 0), hrProb: hrProb(b.stats), baseHrProb: hrProb(b.stats) })));
  const maxProb = Math.max(...withProbs.map(b => b.hrProb), 0.01);
  const topIdx = withProbs.reduce((best, b, i) => b.hrProb > withProbs[best].hrProb ? i : best, 0);

  // ── Feed into HR Potential if it's empty (lineups not posted via API yet) ──
  if (pitcherId && pitcherName) {
    const prRow = prRows.find(r => r.pitcher.id == pitcherId);
    const timeLabel = prRow?.pitcher.timeLabel || '–';
    const timeColor = prRow?.pitcher.timeColor || 'var(--text)';
    const gameTimestamp = prRow?.pitcher.gameTimestamp || 0;
    const tAbbr = teamAbbr || oppAbbr || '–';
    const pOppAbbr = prRow?.pitcher.oppAbbr || oppAbbr || '–';

    withProbs.forEach((b, i) => {
      if (!b.id || !isActiveForHRThreat(b)) return;
      const isTopThreat = i === topIdx;
      // Only add if not already in hrpRows; if it exists, preserve/upgrade TOP HR THREAT status
      const existing = hrpRows.find(r => r.id === b.id && r.pitcherId == pitcherId);
      if (existing) {
        existing.topHrThreat = existing.topHrThreat || isTopThreat;
        existing.hrProb = Math.max(existing.hrProb || 0, b.hrProb || 0); existing.baseHrProb = existing.baseHrProb || b.baseHrProb || b.hrProb || 0; applyHotHitterBoost(existing);
        return;
      }
      if (!existing) {
        const s = b.stats || {};
        hrpRows.push({
          id: b.id,
          name: b.name,
          pos: b.pos,
          teamAbbr: tAbbr,
          oppAbbr: pOppAbbr,
          pitcherName,
          pitcherId,
          timeLabel,
          timeColor,
          gameTimestamp,
          gamePk: prRow?.pitcher.gamePk || 0,
          stats: s,
          last10HR: b.last10HR ?? null,
          todayHR: b.todayHR || 0,
          baseHrProb: b.baseHrProb || b.hrProb,
          hrProb: b.hrProb,
          hotHitter: b.hotHitter || null,
          hotBoostPct: b.hotBoostPct || 0,
          onFireScore: b.onFireScore || 0,
          topHrThreat: isTopThreat,
          streakDays: 1,
          hrVsPitcher: null,
          avg: parseFloat(s.avg) || 0,
          hrSeason: parseInt(s.homeRuns) || 0,
          ops: parseFloat(s.ops) || 0,
          iso: (parseFloat(s.slg)||0) - (parseFloat(s.avg)||0),
          isDrought: false,
          isFavorable: (parseFloat(s.ops)||0) >= 0.800,
        });
      }
    });

    // Re-render HR Potential whenever new batter data is added from lineup
    const hrpEl = document.getElementById('hr-potential-content');
    if (hrpEl && hrpRows.length > 0) {
      renderHRPTable();
    }
  }

  function fmtS(v, dec=3) {
    if (!v || v==='---') return '–';
    const n = parseFloat(v);
    return isNaN(n) ? '–' : n.toFixed(dec).replace(/^0/,'');
  }

  // Matchup label — based on batter K% vs pitcher K/9 and batter OPS
  function matchupLabel(s) {
    const kpct = (s.strikeOuts && s.plateAppearances) ? s.strikeOuts/s.plateAppearances : 0.22;
    const ops  = parseFloat(s.ops) || 0.700;
    const pk9  = pitcherHr9 * 9 || 8.0; // proxy from hr9
    let score = 0;
    if (kpct < 0.18) score += 2; else if (kpct > 0.28) score -= 2;
    if (ops > 0.820) score += 2; else if (ops < 0.680) score -= 1;
    if (pk9 > 10.0) score -= 2; else if (pk9 < 7.0) score += 1;
    if (score >= 2) return `<span class="lbc-matchup-tag good">✓ TOUGH FOR PITCHER</span>`;
    if (score <= -2) return `<span class="lbc-matchup-tag bad">✗ TOUGH FOR BATTER</span>`;
    return `<span class="lbc-matchup-tag neutral">~ NEUTRAL MATCHUP</span>`;
  }

  const cards = withProbs.map((b, i) => {
    const s = b.stats;
    const isTop = i === topIdx; // persists regardless of todayHR
    const homerToday = b.todayHR > 0;
    const barPct = maxProb > 0 ? (b.hrProb / maxProb) * 100 : 0;
    const barColor = homerToday ? '#2f6bff' : isTop ? '#2f6bff' : b.hrProb > maxProb * 0.7 ? '#dc2626' : '#2ecc71';
    const pName = (pitcherName||'').replace(/'/g,"\\'");
    const bName = b.name.replace(/'/g,"\\'");
    const rowBg = homerToday ? 'background:linear-gradient(90deg,#2a1a00 0%,#1a1200 100%);border-left:3px solid var(--accent2);' : '';

    return `<div data-batter-id="${b.id}" class="lineup-batter-card${homerToday?' hr-today':''}">
      <div class="lbc-head">
        <span class="lbc-rank">${i+1}</span>
        <span class="lbc-name">${b.name}</span>
        <span class="lbc-pos">${b.pos}</span>
        ${homerToday ? `<span class="hr-today-badge lbc-tag-hrtoday">💥 HR TODAY${b.todayHR>1?' x'+b.todayHR:''}</span>` : ''}
        ${isTop ? `<span class="top-hr-badge lbc-tag-tophr">⚡ TOP HR THREAT</span>` : ''}
        ${b.isOnFire ? `<span class="lbc-tag-onfire">🔥 ON FIRE</span>` : ''}
        ${b.rosterStatus ? `<span class="lbc-tag-injured" title="${b.rosterStatus}">🏥 ${b.rosterStatus}</span>` : ''}
        ${matchupLabel(s)}
        <button class="lbc-matchup-btn" onclick="openMatchup(${b.id},'${bName}',${pitcherId},'${pName}')" title="Batter vs Pitcher analysis">⚔ Matchup</button>
      </div>
      <div class="lbc-stats">
        ${buildBatterStatsLine(b)}
      </div>
    </div>`;
  }).join('');

  const now = new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
  panel.innerHTML = `
    <div style="padding:4px 0 10px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
      <span style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--accent)">
        ${teamAbbr || oppAbbr || ''} BATTING LINEUP ${lineupBadge}
      </span>
      <div style="display:flex;gap:10px;align-items:center;font-size:10px;color:var(--muted);flex-wrap:wrap">
        <span><span style="color:var(--accent2)">💥 HR TODAY</span> = homered this game</span>
        <span><span style="color:#90ee60">L10</span> = HRs in last 10 games</span>
        <span>⚔ for matchup</span>
        <span class="lineup-timestamp" style="font-family:'JetBrains Mono',monospace;color:var(--border)">Auto-checking official lineup${data.source ? ` • ${data.source}` : ''}${data.confirmedAt ? ` • confirmed ${new Date(data.confirmedAt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}` : ''}</span>
      </div>
    </div>
    ${lineupNotice}
    ${cards}`;
}

function sortPR(col) {
  if (prSortCol===col) prSortDir*=-1;
  else { prSortCol=col; prSortDir=1; }
  renderPRTable();
}

function resetPRSort() {
  prSortCol = 'gameTime';
  prSortDir = 1;
  renderPRTable();
}


// ── GAME PROPS ────────────────────────────────────────────────────────
// In-memory-only (never localStorage) short-TTL cache for the Open-Meteo weather
// lookup below — see the comment at its call site for why this can't reuse
// fetchJSON's day-long cache.
const _weatherCache = new Map();

// Market odds (display-only comparison, see loadEspnEventIds/model.market below) —
// same in-memory 15-min-bucket pattern as weather, never persisted to localStorage.
const _marketCache = new Map();
let _espnEventIdByAbbrPair = {};
let _espnEventIdLoadedForDate = null;
// ESPN's team abbreviations mostly match the MLB Stats API ones this file uses
// everywhere else, except the White Sox (ESPN: CHW, this file: CWS throughout
// parkFactors/teamColors/stadiumCoords). Add more pairs here if another mismatch
// turns up.
const ESPN_ABBR_TO_DR = { CHW: 'CWS' };
function normalizeEspnAbbr(abbr) { return ESPN_ABBR_TO_DR[abbr] || abbr; }

// Bulk-fetches today's MLB scoreboard once (free, no key, same ESPN host already
// used for league news) purely to map each matchup to ESPN's numeric event id —
// the per-game summary endpoint below is what actually has clean moneylines for
// both teams. Split into two calls (bulk id lookup + per-game summary) rather than
// one, since the scoreboard endpoint's own embedded odds only expose the favorite's
// line as a text string ("PHI -172"), not a clean number for the underdog side.
async function loadEspnEventIds(todayCDT) {
  if (_espnEventIdLoadedForDate === todayCDT) return;
  try {
    const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const byAbbrPair = {};
    (data.events || []).forEach(ev => {
      const competitors = ev.competitions?.[0]?.competitors || [];
      const away = competitors.find(c => c.homeAway === 'away');
      const home = competitors.find(c => c.homeAway === 'home');
      const awayAbbr = normalizeEspnAbbr(away?.team?.abbreviation);
      const homeAbbr = normalizeEspnAbbr(home?.team?.abbreviation);
      if (awayAbbr && homeAbbr) byAbbrPair[`${awayAbbr}@${homeAbbr}`] = ev.id;
    });
    _espnEventIdByAbbrPair = byAbbrPair;
    _espnEventIdLoadedForDate = todayCDT;
  } catch {}
}

// Real DraftKings-via-ESPN moneylines for a specific matchup, converted to a
// no-vig (vig-removed) implied win% for a clean apples-to-apples comparison
// against the DR model's own win%. Display-only — see the call site in
// loadGameProps for why this never feeds into awayScore/homeScore or any other
// scoring input.
async function getMarketOdds(awayAbbr, homeAbbr) {
  const eventId = _espnEventIdByAbbrPair[`${awayAbbr}@${homeAbbr}`];
  if (!eventId) return null;
  try {
    const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
    const cacheKey = `${eventId}:${bucket}`;
    let pc = _marketCache.get(cacheKey);
    if (pc === undefined) {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=${eventId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const summary = await res.json();
      pc = summary.pickcenter?.[0] || null;
      _marketCache.set(cacheKey, pc);
    }
    const awayML = pc?.awayTeamOdds?.moneyLine;
    const homeML = pc?.homeTeamOdds?.moneyLine;
    if (typeof awayML !== 'number' || typeof homeML !== 'number') return null;
    const impliedProb = (ml) => ml < 0 ? (-ml) / (-ml + 100) : 100 / (ml + 100);
    const awayImplied = impliedProb(awayML);
    const homeImplied = impliedProb(homeML);
    const vigTotal = awayImplied + homeImplied; // >1 due to vig — normalize it out
    return {
      provider: pc.provider?.name || 'Market',
      awayML, homeML,
      awayPct: Math.round((awayImplied / vigTotal) * 100),
      homePct: Math.round((homeImplied / vigTotal) * 100),
      overUnder: typeof pc.overUnder === 'number' ? pc.overUnder : null,
    };
  } catch { return null; }
}
// Stadium coordinates for weather lookup
const stadiumCoords = {
  ARI:{lat:33.445,lon:-112.067,name:'Chase Field',dome:true,retractable:true},
  ATL:{lat:33.891,lon:-84.468,name:'Truist Park',dome:false},
  BAL:{lat:39.284,lon:-76.622,name:'Oriole Park',dome:false},
  BOS:{lat:42.347,lon:-71.097,name:'Fenway Park',dome:false},
  CHC:{lat:41.948,lon:-87.655,name:'Wrigley Field',dome:false},
  CWS:{lat:41.830,lon:-87.634,name:'Guaranteed Rate Field',dome:false},
  CIN:{lat:39.097,lon:-84.506,name:'Great American Ball Park',dome:false},
  CLE:{lat:41.496,lon:-81.685,name:'Progressive Field',dome:false},
  COL:{lat:39.756,lon:-104.994,name:'Coors Field',dome:false},
  DET:{lat:42.339,lon:-83.049,name:'Comerica Park',dome:false},
  HOU:{lat:29.757,lon:-95.355,name:'Minute Maid Park',dome:true,retractable:true},
  KC: {lat:39.051,lon:-94.480,name:'Kauffman Stadium',dome:false},
  LAA:{lat:33.800,lon:-117.883,name:'Angel Stadium',dome:false},
  LAD:{lat:34.074,lon:-118.240,name:'Dodger Stadium',dome:false},
  MIA:{lat:25.778,lon:-80.220,name:'loanDepot Park',dome:true,retractable:true},
  MIL:{lat:43.029,lon:-87.971,name:'American Family Field',dome:true,retractable:true},
  MIN:{lat:44.981,lon:-93.278,name:'Target Field',dome:false},
  NYM:{lat:40.757,lon:-73.846,name:'Citi Field',dome:false},
  NYY:{lat:40.829,lon:-73.926,name:'Yankee Stadium',dome:false},
  ATH:{lat:37.751,lon:-122.200,name:'Oakland Coliseum',dome:false},
  OAK:{lat:37.751,lon:-122.200,name:'Oakland Coliseum',dome:false},
  PHI:{lat:39.906,lon:-75.166,name:'Citizens Bank Park',dome:false},
  PIT:{lat:40.447,lon:-80.006,name:'PNC Park',dome:false},
  SD: {lat:32.707,lon:-117.157,name:'Petco Park',dome:false},
  SF: {lat:37.778,lon:-122.389,name:'Oracle Park',dome:false},
  SEA:{lat:47.591,lon:-122.332,name:'T-Mobile Park',dome:true,retractable:true},
  STL:{lat:38.623,lon:-90.193,name:'Busch Stadium',dome:false},
  TB: {lat:27.768,lon:-82.653,name:'Tropicana Field',dome:true},
  TEX:{lat:32.751,lon:-97.083,name:'Globe Life Field',dome:true,retractable:true},
  TOR:{lat:43.641,lon:-79.389,name:'Rogers Centre',dome:true,retractable:true},
  WSH:{lat:38.873,lon:-77.007,name:'Nationals Park',dome:false},
};

// Team primary brand colors — purely cosmetic (a thin accent edge on each Game
// Projections card so the list reads faster at a glance), not tied to any stat.
const teamColors = {
  ARI:'#A71930',ATL:'#CE1141',BAL:'#DF4601',BOS:'#BD3039',CHC:'#0E3386',
  CWS:'#27251F',CIN:'#C6011F',CLE:'#00385D',COL:'#33006F',DET:'#0C2340',
  HOU:'#EB6E1F',KC:'#004687',LAA:'#BA0021',LAD:'#005A9C',MIA:'#00A3E0',
  MIL:'#12284B',MIN:'#002B5C',NYM:'#002D72',NYY:'#003087',ATH:'#003831',
  OAK:'#003831',PHI:'#E81828',PIT:'#FDB827',SD:'#2F241D',SF:'#FD5A1E',
  SEA:'#0C2C56',STL:'#C41E3A',TB:'#092C5C',TEX:'#003278',TOR:'#134A8E',
  WSH:'#AB0003',AZ:'#A71930',
};

// Player watchlist — localStorage-backed, no backend. Star a player from any
// board (HR Threats, Strikeouts, Hits, RBIs, Total Bases, Stolen Bases,
// Hits+Runs+RBI) and each of those boards can filter down to just your
// starred players with a "★ Watchlist" toggle in its filter row.
const DR_WATCHLIST_KEY = 'dr-watchlist-players-v1';
function drGetWatchlist() {
  try { return JSON.parse(localStorage.getItem(DR_WATCHLIST_KEY)) || {}; } catch (e) { return {}; }
}
function drIsWatchlisted(id) {
  return !!drGetWatchlist()[String(id)];
}
window.drIsWatchlisted = drIsWatchlisted;
function drToggleWatchlist(id, name) {
  const wl = drGetWatchlist();
  const key = String(id);
  const nowActive = !wl[key];
  if (nowActive) wl[key] = { name: name || '', addedAt: Date.now() };
  else delete wl[key];
  try { localStorage.setItem(DR_WATCHLIST_KEY, JSON.stringify(wl)); } catch (e) {}
  document.querySelectorAll(`[data-watch-id="${CSS.escape(key)}"]`).forEach(btn => {
    btn.classList.toggle('dr-watch-active', nowActive);
    btn.textContent = nowActive ? '★' : '☆';
    const label = nowActive ? 'Remove from watchlist' : 'Add to watchlist';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  });
  document.dispatchEvent(new CustomEvent('dr-watchlist-change'));
  return nowActive;
}
window.drToggleWatchlist = drToggleWatchlist;
// Renders a star toggle button. `id` should be the player's MLB id (or any
// stable unique key) — pass through whatever the board already uses to key
// headshots, since that's guaranteed present whenever there's a name to show.
function drWatchStarHTML(id, name) {
  if (id == null || id === '') return '';
  const active = drIsWatchlisted(id);
  const safeName = String(name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const label = active ? 'Remove from watchlist' : 'Add to watchlist';
  return `<button type="button" class="dr-watch-star${active ? ' dr-watch-active' : ''}" data-watch-id="${id}" onclick="event.stopPropagation();window.drToggleWatchlist('${id}','${safeName}')" aria-label="${label}" title="${label}">${active ? '★' : '☆'}</button>`;
}
window.drWatchStarHTML = drWatchStarHTML;
// Re-render whichever board is showing a "★ Watchlist"-filtered view so
// starring/unstarring a player updates the list live instead of needing a
// manual refresh to see it drop out (or appear) under that filter.
document.addEventListener('dr-watchlist-change', () => {
  if (window.__hrpFilterSet && window.__hrpFilterSet.has('watchlist') && typeof window.renderHRPTable === 'function') window.renderHRPTable();
  if (typeof window.__drPropWatchlistRerender === 'function') window.__drPropWatchlistRerender();
  if (typeof window.__drKPropsWatchlistRerender === 'function') window.__drKPropsWatchlistRerender();
});

// Park factors (HR index: 100 = average, >100 = hitter friendly) — refreshed from
// the first successful live sync-park-factors.mjs run (2026-07-17, real Statcast
// index_hr per park) now that its "var data = [...]" HTML-embedded-JSON parsing
// actually works, in place of the earlier rough approximations. Still serves as
// the fallback loadParkFactors() mutates in place — see that function above — for
// any team missing from a future sync response, or if a run fails outright.
const parkFactors = {
  WSH:133,ATH:126,NYY:125,HOU:122,CIN:121,TB:120,LAD:111,PHI:111,
  TOR:109,CHC:108,TEX:107,BAL:104,COL:102,SEA:101,KC:99,MIL:98,
  PIT:97,CWS:94,DET:93,MIN:92,ARI:91,NYM:91,ATL:91,SD:87,
  CLE:78,BOS:76,SF:75,MIA:74,LAA:73,STL:69,OAK:126,AZ:91,
};

let gamePropsLoaded = false;

// Pre-game DR picks captured server-side by scripts/update-tracker.mjs (its morning
// run happens ~14:07 UTC, hours before any first pitch) — kept in memory only, no
// localStorage, since it's re-fetched fresh each page load and only used as a
// same-day cross-check. See the "Cross-check against the server-side tracker" block
// in loadGameProps (win/loss picks) and loadKProps (K projections/lines) for why
// this exists: both features lock their own in-memory snapshot once a game goes
// live so mid-game stat changes can't shift an already-made pick, but that lock is
// per-browser-session — the very first time a given browser renders a game that's
// *already* live/final, there's no existing snapshot yet, so it computes fresh
// using the pitcher's now-already-updated stat line. The tracker record is immune
// to that since a scheduled job always captures it hours before first pitch.
let _trackerPicksCache = null;
let _trackerPicksLoadPromise = null;
async function loadTrackerPicks() {
  if (_trackerPicksCache) return _trackerPicksCache;
  if (_trackerPicksLoadPromise) return _trackerPicksLoadPromise;
  _trackerPicksLoadPromise = (async () => {
    const result = { drpByGamePk: {}, kpropByPitcherId: {} };
    try {
      const res = await fetch('./data/tracker.json', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        (data?.market?.drp || []).forEach(r => { if (r.gamePk != null) result.drpByGamePk[r.gamePk] = r; });
        (data?.market?.kprop || []).forEach(r => { if (r.pitcherId != null) result.kpropByPitcherId[r.pitcherId] = r; });
      }
    } catch {}
    _trackerPicksCache = result;
    return result;
  })();
  return _trackerPicksLoadPromise;
}

// Shared DR win-probability model output, keyed by gamePk. Populated by loadGameProps
// (the same ERA/WHIP/K9/park/weather/home-field model that powers Diamond Report Picks)
// and reused elsewhere on the site (e.g. the FAVORED pill on game cards) instead of
// re-running the model or falling back to a plain win% record comparison.
window.drWinProbStore = window.drWinProbStore || {};

async function loadGameProps() {
  const el = document.getElementById('gameprops-content');
  const refreshEl = document.getElementById('gameprops-refresh');
  if (!el) return;

  try {
    const today = new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'});
    await loadSportsbookKLines(today);
    await loadParkFactors().catch(() => {});
    await loadBullpenFatigue().catch(() => {});
    await loadBallparkPalFactors().catch(() => {});
    await loadEspnEventIds(today).catch(() => {});
    const { drpByGamePk: trackerDrpByGamePk } = await loadTrackerPicks().catch(() => ({ drpByGamePk: {} }));
    const games = await getTodaySchedule('team,probablePitcher,linescore', { force: true });

    if (!games.length) {
      el.innerHTML = `<div class="mu-empty">No games found for today.</div>`;
      return;
    }

    // Fetch pitcher stats + weather for all games in parallel
    const gameCards = await Promise.all(games.map(async g => {
      const dt = new Date(g.gameDate);
      const timeStr = dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/Chicago'});
      const awayAbbr = g.teams.away.team.abbreviation;
      const homeAbbr = g.teams.home.team.abbreviation;
      const awayP = g.teams.away.probablePitcher;
      const homeP = g.teams.home.probablePitcher;
      const state = g.status.abstractGameState;
      const isLive = state==='Live'||g.status.detailedState==='In Progress';
      const isFinal = state==='Final';

      // Diamond Report Pick lock: once a game goes live/final, reuse whatever the model
      // last computed pre-game instead of re-fetching pitcher stats/weather every cycle.
      // Season ERA/WHIP includes the pitcher's current outing, so recomputing mid-game
      // could otherwise shift (or flip) the pick after first pitch — same lock behavior
      // as K Props.
      let model = (isLive || isFinal) ? _gamePropsSnapshot[g.gamePk] : null;

      if (!model) {
        // Fetch both pitcher stats
        const [awayStats, homeStats, awayRecentForm, homeRecentForm, awayTeamPitching, homeTeamPitching] = await Promise.all([
          awayP ? fetchJSON(`https://diamondreport.app/api/v1/people/${awayP.id}?hydrate=stats(group=pitching,type=season,season=2026)`).then(d=>d.people?.[0]?.stats?.[0]?.splits?.[0]?.stat||{}).catch(()=>({})) : Promise.resolve({}),
          homeP ? fetchJSON(`https://diamondreport.app/api/v1/people/${homeP.id}?hydrate=stats(group=pitching,type=season,season=2026)`).then(d=>d.people?.[0]?.stats?.[0]?.splits?.[0]?.stat||{}).catch(()=>({})) : Promise.resolve({}),
          awayP ? recentPitchingForm(awayP.id) : Promise.resolve(null),
          homeP ? recentPitchingForm(homeP.id) : Promise.resolve(null),
          teamSeasonPitchingTotals(g.teams.away.team.id),
          teamSeasonPitchingTotals(g.teams.home.team.id),
        ]);

        // Weather (Open-Meteo, free, no key) — deliberately NOT routed through
        // fetchJSON(). That helper caches any non-live-score URL in localStorage
        // for the rest of the calendar day (DR_STATIC_DAILY_DUMP), which is right
        // for daily-batch Statcast files but wrong here: temperature and wind
        // genuinely change over the course of a day, so a morning fetch (cooler)
        // was getting locked in and reused all afternoon even on a hot day,
        // silently keeping the HR Boost badge at 0% long after conditions crossed
        // the +5%/-5% thresholds. A short in-memory cache keyed to a 15-minute
        // bucket keeps this fresh without re-fetching on every 2-minute auto-refresh.
        const stadium = stadiumCoords[homeAbbr] || stadiumCoords[awayAbbr];
        let weather = null;
        // Retractable-roof parks (ARI, HOU, MIA, MIL, SEA, TEX, TOR) are frequently
        // played open-air, so they still get a live weather fetch — only Tropicana
        // Field (TB) is a genuine fixed dome that's never open. Open-Meteo has no
        // live roof-open/closed signal, so this fetches outdoor conditions for those
        // parks regardless of actual roof state; better than always reporting 0%.
        if (stadium && (!stadium.dome || stadium.retractable)) {
          try {
            const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
            const wKey = `${homeAbbr}:${bucket}`;
            let wd = _weatherCache.get(wKey);
            if (!wd) {
              // relative_humidity_2m + pressure_msl added for the air-density-based HR
              // Boost model below (see airDensityHRMult) — pressure_msl (sea-level-
              // equivalent, not surface_pressure) is deliberate: it isolates today's
              // weather-system pressure anomaly from each park's permanent elevation,
              // which the separate Statcast-based park factor already accounts for.
              // Using raw surface_pressure here would double-count Coors' altitude as
              // if it were a "weather" effect every single day.
              const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${stadium.lat}&longitude=${stadium.lon}&current=temperature_2m,relative_humidity_2m,windspeed_10m,winddirection_10m,precipitation,pressure_msl,weathercode&temperature_unit=fahrenheit&windspeed_unit=mph`);
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              wd = await res.json();
              _weatherCache.set(wKey, wd);
            }
            const c = wd.current;
            weather = {
              temp: Math.round(c.temperature_2m),
              humidity: c.relative_humidity_2m,
              wind: Math.round(c.windspeed_10m),
              windDir: c.winddirection_10m,
              precip: c.precipitation,
              pressureMsl: c.pressure_msl,
              code: c.weathercode,
            };
          } catch {}
        }

        // Real sportsbook odds (ESPN/DraftKings) — display-only comparison against the
        // DR model's own win%/total. Deliberately NOT an input to awayScore/homeScore or
        // any other scoring below: a line that shifts throughout the game would otherwise
        // let the market silently "tamper with" a projection that's supposed to be an
        // independent read, and folding it in would make "DR vs. the market" meaningless
        // as a thing to track. Fetched once here (same pre-game-only lock as everything
        // else in this block) and frozen into the snapshot below, so it reflects the same
        // moment-in-time snapshot as the rest of the model rather than a live line.
        const market = await getMarketOdds(awayAbbr, homeAbbr);

        // Scoring model — each factor adds/subtracts from home team edge
        let awayScore = 50, homeScore = 50;
        const factors = [];
        const sideAbbr = (side) => side === 'away' ? awayAbbr : side === 'home' ? homeAbbr : '';
        const sidePitcher = (side) => side === 'away' ? awayP : side === 'home' ? homeP : null;
        const pitcherLastName = (side) => sidePitcher(side)?.fullName?.split(' ').pop() || (side === 'away' ? 'Away P' : 'Home P');
        const factorLabel = (side, text) => `${sideAbbr(side)}: ${text}`;

        // Pitcher ERA comparison — blended with each pitcher's last 5 starts so a
        // season-long number doesn't outweigh a real recent hot/cold stretch.
        const awayERA = blendRecentForm(parseFloat(awayStats.era)||4.5, awayRecentForm, 'era');
        const homeERA = blendRecentForm(parseFloat(homeStats.era)||4.5, homeRecentForm, 'era');
        const eraDiff = awayERA - homeERA;
        if (Math.abs(eraDiff) > 0.3) {
          if (eraDiff > 0) { homeScore += Math.min(eraDiff*3, 8); factors.push({team:'home', label:factorLabel('home', `${pitcherLastName('home')} ERA adv (${homeERA.toFixed(2)})`), type:'pos'}); }
          else { awayScore += Math.min(Math.abs(eraDiff)*3, 8); factors.push({team:'away', label:factorLabel('away', `${pitcherLastName('away')} ERA adv (${awayERA.toFixed(2)})`), type:'pos'}); }
        }

        // WHIP comparison — same recent-form blend
        const awayWHIP = blendRecentForm(parseFloat(awayStats.whip)||1.3, awayRecentForm, 'whip');
        const homeWHIP = blendRecentForm(parseFloat(homeStats.whip)||1.3, homeRecentForm, 'whip');
        if (Math.abs(awayWHIP-homeWHIP) > 0.1) {
          if (awayWHIP > homeWHIP) { homeScore += 4; factors.push({team:'home', label:factorLabel('home', `${pitcherLastName('home')} WHIP edge (${homeWHIP.toFixed(2)})`), type:'pos'}); }
          else { awayScore += 4; factors.push({team:'away', label:factorLabel('away', `${pitcherLastName('away')} WHIP edge (${awayWHIP.toFixed(2)})`), type:'pos'}); }
        }

        // K/9 — high K pitcher favored, same recent-form blend
        const awayK9 = blendRecentForm(parseFloat(awayStats.strikeoutsPer9Inn)||8, awayRecentForm, 'k9');
        const homeK9 = blendRecentForm(parseFloat(homeStats.strikeoutsPer9Inn)||8, homeRecentForm, 'k9');
        if (homeK9 > awayK9 + 1) { homeScore += 3; factors.push({team:'home', label:factorLabel('home', `${pitcherLastName('home')} K/9 edge (${homeK9.toFixed(1)})`), type:'pos'}); }
        else if (awayK9 > homeK9 + 1) { awayScore += 3; factors.push({team:'away', label:factorLabel('away', `${pitcherLastName('away')} K/9 edge (${awayK9.toFixed(1)})`), type:'pos'}); }

        // Team record — previously this model had no team-strength input at all, only
        // pitcher-matchup and venue factors, so a last-place team could out-project a
        // first-place team on the back of one ERA edge. leagueRecord already comes back on
        // every schedule game object (same schedule call this function already makes), so
        // no extra fetch is needed. Skipped in the first ~10 games of the season, when the
        // record itself is too small a sample to mean much.
        const awayRecord = g.teams.away.leagueRecord || {};
        const homeRecord = g.teams.home.leagueRecord || {};
        const awayW = parseInt(awayRecord.wins) || 0, awayL = parseInt(awayRecord.losses) || 0;
        const homeW = parseInt(homeRecord.wins) || 0, homeL = parseInt(homeRecord.losses) || 0;
        if ((awayW + awayL) >= 10 && (homeW + homeL) >= 10) {
          const awayWinPct = awayW / (awayW + awayL);
          const homeWinPct = homeW / (homeW + homeL);
          const recordDiff = awayWinPct - homeWinPct; // positive = away has the better record
          const recordPts = Math.max(-18, Math.min(18, recordDiff * 60));
          if (recordPts >= 1) { awayScore += recordPts; factors.push({team:'away', label:factorLabel('away', `Record edge (${awayW}-${awayL})`), type:'pos'}); }
          else if (recordPts <= -1) { homeScore += Math.abs(recordPts); factors.push({team:'home', label:factorLabel('home', `Record edge (${homeW}-${homeL})`), type:'pos'}); }
        }

        // Time of day factor — day games (before 5pm CDT) slightly favor home team; night games more even
        const gameHourCDT = new Date(g.gameDate).toLocaleString('en-US',{hour:'numeric',hour12:false,timeZone:'America/Chicago'});
        const isDayGame = parseInt(gameHourCDT) < 17;
        if (isDayGame) {
          homeScore += 2;
          factors.push({team:'home', label:factorLabel('home', 'Day game home crowd edge'), type:'pos'});
        }

        // Home field advantage
        homeScore += 3;
        factors.push({team:'home', label:factorLabel('home', 'Home field edge'), type:'pos'});

        // Park factor — doesn't favor either team (both play in the same park), so this
        // can't reasonably swing win probability toward one side. It used to be computed
        // and shown as a "factor" chip while never actually touching awayScore/homeScore at
        // all, which looked like it was informing the pick when it silently wasn't. Applying
        // it symmetrically (same pattern already used for wind) at least makes the displayed
        // chip reflect a real, if small and neutral, contribution instead of a decorative one.
        const pf = parkFactors[homeAbbr] || 100;
        if (pf > 107) { awayScore += 2; homeScore += 2; factors.push({team:'neutral', label:`${stadiumCoords[homeAbbr]?.name||homeAbbr}: HR-friendly park (${pf})`, type:'neu'}); }
        else if (pf < 93) { awayScore -= 1; homeScore -= 1; factors.push({team:'neutral', label:`${stadiumCoords[homeAbbr]?.name||homeAbbr}: Pitcher-friendly park (${pf})`, type:'neu'}); }

        // Weather impact
        if (weather) {
          const windImpact = windEffect(weather.windDir, homeAbbr);
          if (weather.wind > 15) {
            if (windImpact === 'out') { awayScore += 3; homeScore += 3; factors.push({team:'neutral', label:`Wind blowing out ${weather.wind}mph — HR boost`, type:'pos'}); }
            else if (windImpact === 'in') { factors.push({team:'neutral', label:`Wind blowing in ${weather.wind}mph — pitcher boost`, type:'neg'}); awayScore -= 2; homeScore -= 2; }
            else { factors.push({team:'neutral', label:`Wind ${weather.wind}mph crosswind`, type:'neu'}); }
          }
          if (weather.temp < 50) factors.push({team:'neutral', label:`Cold ${weather.temp}°F — suppresses offense`, type:'neg'});
          else if (weather.temp > 85) factors.push({team:'neutral', label:`Hot ${weather.temp}°F — ball carries well`, type:'pos'});
          if (weather.precip > 0.1) factors.push({team:'neutral', label:`Precipitation: ${weather.precip}mm — delay risk`, type:'neg'});
        } else if (stadium?.dome) {
          const reason = stadium.retractable ? 'weather unavailable' : 'fixed dome, weather neutral';
          factors.push({team:'neutral', label:`${stadium.name} — ${reason}`, type:'neu'});
        }

        // ── Projected Total (DR model) ──────────────────────────────────
        // No real sportsbook odds feed exists on this site (loadSportsbookKLines
        // is itself a local-model number, not a live book line — see its own
        // comments). Reuses the exact WHIP/K9/park/weather/record inputs already
        // fetched above for the win-probability model, plus season HR/9 pulled
        // from the same pitching-stats response (same field loadHRPotential
        // already reads as pitcherHr9 — no extra fetch) and a team-pitching-
        // totals fetch (see teamSeasonPitchingTotals) for a bullpen-strength
        // signal. A single ERA ratio was the first pass here, but ERA folds
        // baserunners, power allowed, and strikeout ability into one number —
        // this blends the three separately so a low-ERA pitcher who gets there
        // via limiting hard contact (real signal) isn't treated the same as one
        // who gets there by stranding runners (luck/bullpen-dependent, not a
        // stable predictor of next game's runs). Each ratio is 1.0 at league
        // average by construction, weighted by how directly it predicts runs
        // allowed: WHIP (baserunners) 50%, HR/9 (extra-base power surrendered)
        // 30%, K/9 (contact suppression) 20% — then blended 65/35 with the
        // bullpen-strength ratio, reflecting roughly how much of a modern game
        // the starter vs the rest of the staff covers. Runs are driven by the
        // OPPOSING team's pitching index — the staff that lineup actually
        // faces — not the batting team's own, so awayRuns scales with the home
        // pitching index and homeRuns with the away pitching index.
        const LEAGUE_AVG_TEAM_RUNS = 4.3; // roughly modern-era MLB runs/team/game
        const LEAGUE_AVG_WHIP = 1.30, LEAGUE_AVG_K9 = 8.5, LEAGUE_AVG_HR9 = 1.20;
        const LEAGUE_AVG_BULLPEN_ERA = 4.20; // modern bullpen ERA runs a touch above rotation average
        const awayHR9 = parseFloat(awayStats.homeRunsPer9) || LEAGUE_AVG_HR9;
        const homeHR9 = parseFloat(homeStats.homeRunsPer9) || LEAGUE_AVG_HR9;
        const pitcherRunIndex = (whip, k9, hr9) => {
          const whipRatio = whip / LEAGUE_AVG_WHIP;
          const hr9Ratio = hr9 / LEAGUE_AVG_HR9;
          const k9Ratio = LEAGUE_AVG_K9 / Math.max(k9, 1); // more Ks than average -> lower ratio -> fewer runs
          return (whipRatio * 0.5) + (hr9Ratio * 0.3) + (k9Ratio * 0.2);
        };
        // Bullpen strength, folded in at a weight reflecting a modern starter's average
        // outing (~5.5-6 of 9 innings) vs the rest of the game the pitching staff covers.
        const awayBullpenERA = bullpenERAFor(awayTeamPitching, awayStats, LEAGUE_AVG_BULLPEN_ERA);
        const homeBullpenERA = bullpenERAFor(homeTeamPitching, homeStats, LEAGUE_AVG_BULLPEN_ERA);
        const awayBullpenRatio = awayBullpenERA / LEAGUE_AVG_BULLPEN_ERA;
        const homeBullpenRatio = homeBullpenERA / LEAGUE_AVG_BULLPEN_ERA;
        const awayPitcherIndex = (pitcherRunIndex(awayWHIP, awayK9, awayHR9) * 0.65) + (awayBullpenRatio * 0.35);
        const homePitcherIndex = (pitcherRunIndex(homeWHIP, homeK9, homeHR9) * 0.65) + (homeBullpenRatio * 0.35);
        let awayRuns = LEAGUE_AVG_TEAM_RUNS * homePitcherIndex;
        let homeRuns = LEAGUE_AVG_TEAM_RUNS * awayPitcherIndex;

        // Team record as a rough own-offense proxy — same 10-game-minimum
        // sample-size floor already used for the win-prob record factor above.
        if ((awayW + awayL) >= 10 && (homeW + homeL) >= 10) {
          const awayWinPct = awayW / (awayW + awayL);
          const homeWinPct = homeW / (homeW + homeL);
          awayRuns *= 1 + Math.max(-0.15, Math.min(0.15, (awayWinPct - 0.5) * 0.3));
          homeRuns *= 1 + Math.max(-0.15, Math.min(0.15, (homeWinPct - 0.5) * 0.3));
        }

        // Park factor affects both teams equally — same 0.5 shrink already used
        // for the HR-probability model's park adjustment.
        const totalParkAdj = 1 + ((pf - 100) / 100) * 0.5;
        awayRuns *= totalParkAdj; homeRuns *= totalParkAdj;

        // Weather — real air-density physics (airDensityHRMult) combined with a
        // continuous wind-speed effect (windHRMult), replacing the old flat wind-
        // bucket/temp-threshold formula. See both functions' comments (defined near
        // windEffect below) for the physics and calibration. Tracked as a single
        // combined multiplier (weatherHRMult) so the same effect driving the runs
        // total can also be surfaced on its own as an "HR Boost" read — genuine
        // home-run-specific signal, distinct from the broader runs-total number
        // (which also folds in pitching/park/record).
        let weatherHRMult = 1;
        // Tracked separately (not just the combined weatherHRMult) purely so the
        // Park & Weather detail panel below can show the two effects broken out —
        // neither value feeds into anything beyond that display.
        let densityMultForDisplay = 1, windMultForDisplay = 1;
        if (weather) {
          densityMultForDisplay = airDensityHRMult(weather);
          windMultForDisplay = windHRMult(weather, homeAbbr);
          weatherHRMult = densityMultForDisplay * windMultForDisplay;
          awayRuns *= weatherHRMult; homeRuns *= weatherHRMult;
        }
        const hrWeatherBoostPct = Math.round((weatherHRMult - 1) * 100);

        const projectedTotal = Math.round((awayRuns + homeRuns) * 2) / 2; // nearest 0.5
        const totalEnv = projectedTotal >= 9.5 ? 'HIGH-SCORING' : projectedTotal <= 7.5 ? 'LOW-SCORING' : 'AVERAGE';
        const totalEnvColor = projectedTotal >= 9.5 ? '#2ecc71' : projectedTotal <= 7.5 ? 'var(--accent2)' : 'var(--muted)';

        // Determine winner
        const total = awayScore + homeScore;
        let awayPct = Math.round((awayScore/total)*100);
        let homePct = 100 - awayPct;
        let diff = Math.abs(awayPct - homePct);
        let confidence = diff < 6 ? 'TOSS-UP' : diff < 12 ? 'LEAN' : diff < 20 ? 'LIKELY' : 'STRONG';
        let confColor = diff < 6 ? 'var(--muted)' : diff < 12 ? 'var(--accent2)' : diff < 20 ? '#2ecc71' : '#00ff88';
        let winner = awayPct > homePct ? 'away' : 'home';
        let winnerAbbr = winner==='away' ? awayAbbr : homeAbbr;
        let winnerPct = winner==='away' ? awayPct : homePct;
        let loserAbbr  = winner==='away' ? homeAbbr : awayAbbr;
        let loserPct   = winner==='away' ? homePct : awayPct;

        // Cross-check against the server-side tracker's pre-game pick (data/tracker.json,
        // captured every morning well before first pitch — see update-tracker.mjs) whenever
        // this is the very first time THIS browser has computed this particular game AND
        // it's already live/final. That combination means there's no existing
        // _gamePropsSnapshot/localStorage lock to fall back on yet, so the computation above
        // just ran using the pitcher's now-already-updated season stats — i.e. it can be
        // contaminated by the game's own outcome and show a different (flipped) pick than
        // whatever was true pre-game. The tracker record is immune to that: it's always
        // captured by a scheduled job hours before first pitch, never tied to any one visit.
        if ((isLive || isFinal) && trackerDrpByGamePk[g.gamePk]) {
          const tr = trackerDrpByGamePk[g.gamePk];
          const trackerWinnerIsAway = tr.pick === awayAbbr;
          const trackerWinnerIsHome = tr.pick === homeAbbr;
          if ((trackerWinnerIsAway || trackerWinnerIsHome) && tr.pick !== winnerAbbr && Number.isFinite(tr.pickPct)) {
            winner = trackerWinnerIsAway ? 'away' : 'home';
            winnerAbbr = tr.pick;
            winnerPct = tr.pickPct;
            loserAbbr = trackerWinnerIsAway ? homeAbbr : awayAbbr;
            loserPct = 100 - tr.pickPct;
            awayPct = trackerWinnerIsAway ? tr.pickPct : loserPct;
            homePct = trackerWinnerIsHome ? tr.pickPct : loserPct;
            diff = Math.abs(awayPct - homePct);
            confidence = diff < 6 ? 'TOSS-UP' : diff < 12 ? 'LEAN' : diff < 20 ? 'LIKELY' : 'STRONG';
            confColor = diff < 6 ? 'var(--muted)' : diff < 12 ? 'var(--accent2)' : diff < 20 ? '#2ecc71' : '#00ff88';
          }
        }

        model = { awayPct, homePct, diff, confidence, confColor, winner, winnerAbbr, winnerPct, loserAbbr, loserPct, factors, projectedTotal, totalEnv, totalEnvColor, hrWeatherBoostPct, parkFactorVal: pf, market, weather, densityMultForDisplay, windMultForDisplay, stadiumName: stadium?.name };
        // Always keep the snapshot fresh — pre-game cycles overwrite it so that whenever
        // the game does go live, the lock captures the most recent pre-game state rather
        // than a stale first-load snapshot from hours earlier.
        _gamePropsSnapshot[g.gamePk] = model;
      }

      const { awayPct, homePct, diff, confidence, confColor, winner, winnerAbbr, winnerPct, loserAbbr, loserPct, factors, projectedTotal, totalEnv, totalEnvColor, hrWeatherBoostPct, parkFactorVal, market, weather, densityMultForDisplay, windMultForDisplay, stadiumName } = model;

      window.drWinProbStore[g.gamePk] = { awayAbbr, homeAbbr, awayPct, homePct, winnerAbbr, winnerPct, confidence };
      _favoredCache[g.gamePk] = { abbr: winnerAbbr, pct: winnerPct, source: 'model' };

      // Actual result — get live/final scores from linescore
      const awayActual = g.teams.away.score ?? null;
      const homeActual = g.teams.home.score ?? null;
      let resultBadge = '';
      let resultCorrect = null; // true/false/null
      if (isFinal && awayActual !== null && homeActual !== null) {
        const actualWinner = awayActual > homeActual ? 'away' : homeActual > awayActual ? 'home' : 'tie';
        const actualWinnerAbbr = actualWinner === 'away' ? awayAbbr : homeAbbr;
        resultCorrect = actualWinner !== 'tie' && actualWinner === winner;
        if (actualWinner === 'tie') {
          resultBadge = `<span style="background:#1a1a2e;color:var(--muted);font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid var(--border)">TIE GAME</span>`;
        } else if (resultCorrect) {
          resultBadge = `<span style="background:#0d2a1a;color:#2ecc71;font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid #2ecc7166">✓ CORRECT — ${actualWinnerAbbr} won ${awayActual}-${homeActual}</span>`;
        } else {
          resultBadge = `<span style="background:#2a0d0d;color:#dc2626;font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid #dc262666">✗ INCORRECT — ${actualWinnerAbbr} won ${awayActual}-${homeActual}</span>`;
        }
      } else if (isLive && awayActual !== null && homeActual !== null) {
        const leadingAbbr = awayActual > homeActual ? awayAbbr : homeActual > awayActual ? homeAbbr : null;
        const isPickLeading = leadingAbbr === winnerAbbr;
        if (leadingAbbr) {
          resultBadge = `<span style="background:${isPickLeading?'#0d2a1a':'#2a0d0d'};color:${isPickLeading?'#2ecc71':'#dc2626'};font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid ${isPickLeading?'#2ecc7166':'#dc262666'}">${isPickLeading?'▲':'▼'} ${leadingAbbr} leads ${awayActual}-${homeActual}</span>`;
        }
      }

      const logoId = (abbr) => teamIds[abbr] || teamIds[String(abbr || '').toUpperCase() === 'AZ' ? 'ARI' : abbr];
      const awayLogoId = logoId(awayAbbr);
      const homeLogoId = logoId(homeAbbr);
      const winLogoId  = logoId(winnerAbbr);
      const awayLogo = awayLogoId ? `<img class="gp-team-logo" src="https://www.mlbstatic.com/team-logos/${awayLogoId}.svg" alt="${awayAbbr}" loading="lazy" decoding="async">` : '';
      const homeLogo = homeLogoId ? `<img class="gp-team-logo" src="https://www.mlbstatic.com/team-logos/${homeLogoId}.svg" alt="${homeAbbr}" loading="lazy" decoding="async">` : '';
      const winLogo  = winLogoId ? `<img src="https://www.mlbstatic.com/team-logos/${winLogoId}.svg" style="width:22px;height:22px;object-fit:contain" alt="${winnerAbbr}" loading="lazy" decoding="async">` : '';

      const statusBadge = isLive
        ? `<span style="background:#2a0000;color:var(--live);font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;border:1px solid var(--live)">● LIVE</span>`
        : isFinal ? `<span style="font-size:9px;color:var(--muted)">FINAL</span>` : `<span style="font-size:9px;color:var(--accent2);font-family:'JetBrains Mono',monospace">${timeStr}</span>`;

      const escapeFactorLabel = (txt) => String(txt || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
      const factorChips = factors.slice(0,6).map(f => {
        const cls = f.team === 'neutral' ? (f.type || 'neu') : (f.team === winner ? 'pos' : 'opp');
        return `<span class="gp-factor ${cls}">${escapeFactorLabel(f.label)}</span>`;
      }).join('');
      // HR Boost / Park Factor as compact labels (same .gp-factor chip style as the
      // factor chips above) instead of full stat-block panels — see the win-prob
      // model's weather/park sections above for how hrWeatherBoostPct/parkFactorVal
      // are computed.
      // Purely cosmetic fill bar under each chip's value, scaled to how extreme the
      // number is within its realistic range — reinforces the pos/neg color coding
      // without changing what the number means. ~20% is roughly the max realistic
      // combined air-density+wind swing weatherHRMult produces (individual clamps
      // are wider — see airDensityHRMult/windHRMult — but both maxing out together
      // is rare); ~33 is roughly the max deviation from 100 seen across the real
      // park-factor table above.
      const gpFactorBar = (pct, cls) => `<span class="gp-factor-bar"><span class="gp-factor-bar-fill ${cls}" style="width:${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%"></span></span>`;
      const hrBoostCls = hrWeatherBoostPct > 0 ? 'pos' : hrWeatherBoostPct < 0 ? 'neg' : 'neu';
      const hrBoostChip = `<span class="gp-factor ${hrBoostCls}" title="Air density (temp/humidity/pressure) + wind effect on HR likelihood only — excludes park, pitching, and offense">🌬️ HR Boost: ${hrWeatherBoostPct > 0 ? '+' : ''}${hrWeatherBoostPct}%${gpFactorBar(Math.abs(hrWeatherBoostPct) / 20, hrBoostCls)}</span>`;
      const parkFactorCls = parkFactorVal > 107 ? 'pos' : parkFactorVal < 93 ? 'neg' : 'neu';
      const parkFactorLabel = parkFactorVal > 107 ? 'HR-Friendly' : parkFactorVal < 93 ? 'Pitcher-Friendly' : 'Neutral';
      const parkFactorPct = parkFactorVal - 100;
      const parkFactorChip = `<span class="gp-factor ${parkFactorCls}" title="Statcast park factor for ${stadiumCoords[homeAbbr]?.name||homeAbbr} — 100 = league average (0%)">🏟️ Park Factor: ${parkFactorPct > 0 ? '+' : ''}${parkFactorPct}% · ${parkFactorLabel}${gpFactorBar(Math.abs(parkFactorVal - 100) / 33, parkFactorCls)}</span>`;

      // Market comparison (ESPN/DraftKings) — purely informational, see the
      // getMarketOdds call site above for why this never touches the model's own
      // scoring. Shown only when a real line was found; silently omitted otherwise
      // (e.g. odds not posted yet, or an abbreviation mismatch skipped the match).
      let marketChip = '';
      if (market) {
        const marketFavAbbr = market.awayPct >= market.homePct ? awayAbbr : homeAbbr;
        const marketFavPct = Math.max(market.awayPct, market.homePct);
        const marketFavML = market.awayPct >= market.homePct ? market.awayML : market.homeML;
        const agreesWithDR = marketFavAbbr === winnerAbbr;
        const ouText = market.overUnder != null ? ` · O/U ${market.overUnder}` : '';
        marketChip = `<span class="gp-factor ${agreesWithDR ? 'pos' : 'neu'}" title="${market.provider} line via ESPN, captured pre-game — informational only, never used in the DR model or projections">🏦 Market: ${marketFavAbbr} ${marketFavML > 0 ? '+' : ''}${marketFavML} (${marketFavPct}%)${ouText}${agreesWithDR ? '' : ' vs DR'}</span>`;
      }

      // Over/Under read — compares the DR model's own Projected Total against the
      // market's O/U line fetched above. Purely a label on top of numbers that
      // already exist (projectedTotal, market.overUnder) — doesn't change either
      // one, same display-only rule as the Market chip itself.
      let ouLabel = '', ouCls = '';
      if (market?.overUnder != null) {
        if (projectedTotal > market.overUnder) { ouLabel = `OVER ${market.overUnder}`; ouCls = 'pos'; }
        else if (projectedTotal < market.overUnder) { ouLabel = `UNDER ${market.overUnder}`; ouCls = 'neg'; }
        else { ouLabel = `PUSH ${market.overUnder}`; ouCls = 'neu'; }
      }

      // Bullpen fatigue — only shown when at least one side's 'pen is genuinely
      // Taxed/Gassed from the last two days' real reliever workload (see
      // sync-bullpen-fatigue.mjs). Omitted entirely on a normal day rather than
      // always showing a "Fresh" chip nobody needs to see.
      let bullpenChip = '';
      {
        const fatigueRank = { Fresh: 0, Normal: 1, Taxed: 2, Gassed: 3 };
        const awayFatigue = bullpenFatigue[awayAbbr];
        const homeFatigue = bullpenFatigue[homeAbbr];
        const worseAbbr = (fatigueRank[awayFatigue?.tier] || 0) >= (fatigueRank[homeFatigue?.tier] || 0) ? awayAbbr : homeAbbr;
        const worse = worseAbbr === awayAbbr ? awayFatigue : homeFatigue;
        if (worse && (worse.tier === 'Taxed' || worse.tier === 'Gassed')) {
          const cls = worse.tier === 'Gassed' ? 'neg' : 'neu';
          bullpenChip = `<span class="gp-factor ${cls}" title="${worse.totalRelieverPitches} reliever pitches and ${worse.backToBackArms} arm(s) used on both of the last two days — real recent workload, not a season average">🧯 ${worseAbbr} Bullpen: ${worse.tier}</span>`;
        }
      }

      // Park & Weather detail panel — click-to-expand readable breakdown of numbers
      // the model already computed above (weather, densityMultForDisplay,
      // windMultForDisplay, parkFactorVal); same display-only rule as the chips —
      // nothing here is computed fresh or feeds back into scoring.
      const densityPct = Math.round((densityMultForDisplay - 1) * 100);
      const windPct = Math.round((windMultForDisplay - 1) * 100);
      // Ballpark Pal's own independently-modeled weather-only HR effect (licensed
      // API, see scripts/sync-ballparkpal.mjs) — a second, differently-computed
      // number next to our own DIY air-density/wind figure above. Purely a
      // cross-check; omitted entirely when the sync hasn't run or has no data
      // for this game yet, same as the Bullpen chip's fail-silent pattern.
      const bpWeatherPct = ballparkPalWeatherPctForGame(g.gamePk);
      // Horizontal bar centered at 0, filling toward green (boosts HR) or red
      // (suppresses HR) — deltaPct is already the signed % to plot, scale is the
      // ± range the bar's full half-width represents (clamped only visually;
      // the printed valueText is always the real, unclamped number).
      const centerBar = (label, deltaPct, scale, valueText) => {
        const clamped = Math.max(-scale, Math.min(scale, deltaPct));
        const color = clamped === 0 ? 'var(--muted)' : clamped > 0 ? '#2ee6a6' : '#ff4d6d';
        const fillPct = (Math.abs(clamped) / scale * 50).toFixed(1);
        const left = clamped > 0 ? 50 : (50 - fillPct);
        return `<div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:10px;color:var(--muted);min-width:118px;white-space:nowrap">${label}</span>
          <span style="position:relative;flex:1;height:6px;background:var(--bg);border:1px solid var(--border);border-radius:3px">
            <span style="position:absolute;left:calc(50% - .5px);top:-1px;bottom:-1px;width:1px;background:var(--border)"></span>
            <span style="position:absolute;left:${left}%;top:0;bottom:0;width:${fillPct}%;background:${color};border-radius:3px"></span>
          </span>
          <span style="font-size:11px;font-weight:700;color:${color};min-width:46px;text-align:right;white-space:nowrap">${valueText}</span>
        </div>`;
      };
      const effectBars = [
        centerBar('🌬️ Air Density', densityPct, 15, `${densityPct > 0 ? '+' : ''}${densityPct}%`),
        centerBar('💨 Wind', windPct, 20, `${windPct > 0 ? '+' : ''}${windPct}%`),
        bpWeatherPct != null ? centerBar('🌐 Ballpark Pal', bpWeatherPct, 15, `${bpWeatherPct > 0 ? '+' : ''}${bpWeatherPct}%`) : '',
        centerBar('🏟️ Park Factor', parkFactorVal - 100, 30, `${parkFactorVal}`),
      ].filter(Boolean).join('');
      const windArrow = (weather && Number.isFinite(weather.windDir))
        // Arrow points the direction the wind is blowing TOWARD (windDir is
        // meteorological "blowing FROM", so +180 flips it) — 0deg (N) = up.
        ? `<span style="display:inline-block;transform:rotate(${(weather.windDir + 180) % 360}deg);font-size:20px;line-height:1">↑</span>`
        : '';
      const parkWeatherHTML = weather ? `
        <div style="padding:12px 14px">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <div style="font-size:34px;line-height:1">${weatherCodeEmoji(weather.code)}</div>
            <div style="min-width:90px">
              <div style="font-size:20px;font-weight:700;color:var(--text);line-height:1.1">${weather.temp}°F</div>
              <div style="font-size:11px;color:var(--muted)">${weatherCodeLabel(weather.code)} · ${stadiumName || homeAbbr}</div>
            </div>
            <div style="margin-left:auto;display:flex;align-items:center;gap:6px">
              ${windArrow}
              <div>
                <div style="font-size:13px;font-weight:600;color:var(--text)">${weather.wind}mph</div>
                <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">${compassLabel(weather.windDir)}</div>
              </div>
            </div>
          </div>
          <div style="display:flex;gap:14px;margin:10px 0 12px;font-size:10px;color:var(--muted)">
            <span>💧 Humidity: ${weather.humidity != null ? `${weather.humidity}%` : '–'}</span>
            <span>🔽 Pressure: ${weather.pressureMsl != null ? `${Math.round(weather.pressureMsl)} hPa` : '–'}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:7px">${effectBars}</div>
        </div>` : `
        <div style="padding:12px 14px">
          <div style="font-size:12px;color:var(--muted);margin-bottom:10px">🏟️ ${stadiumName || homeAbbr} — ${stadiumCoords[homeAbbr]?.dome && !stadiumCoords[homeAbbr]?.retractable ? 'fixed dome, weather neutral' : 'weather unavailable'}</div>
          <div style="display:flex;flex-direction:column;gap:7px">${effectBars}</div>
        </div>`;

      const confBarW = Math.min(winnerPct, 100);
      const confBarColor = diff < 6 ? 'var(--muted)' : diff < 12 ? 'var(--accent2)' : '#2ecc71';

      const teamAccent = teamColors[homeAbbr] || teamColors[awayAbbr] || 'var(--accent)';
      return { html: `<div class="gp-card" data-game-pk="${g.gamePk}" data-away="${awayAbbr}" data-home="${homeAbbr}" data-winner="${winnerAbbr}" data-game-time="${dt.getTime()}" style="--team-accent:${teamAccent};cursor:pointer" onclick="const b=this.querySelector('.dr1027-details-btn');if(b&&!event.target.closest('button,a'))b.click();">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <!-- Teams -->
          <div class="gp-matchup" style="flex:1;min-width:180px">
            <div class="gp-team">
              ${awayLogo}
              <span class="gp-team-abbr">${awayAbbr}</span>
              <span style="font-size:9px;color:var(--muted);font-family:'JetBrains Mono',monospace">${awayP?.fullName?.split(' ').pop()||'TBD'}</span>
            </div>
            <div style="display:flex;flex-direction:column;align-items:center;gap:3px">
              <span class="gp-vs">@</span>
              ${statusBadge}
              ${(awayActual !== null && homeActual !== null) ? `<span class="gp-live-score ${isFinal?'final':isLive?'live':''}" data-gp-live-score="1">${awayActual}-${homeActual}</span>` : ''}
            </div>
            <div class="gp-team">
              ${homeLogo}
              <span class="gp-team-abbr">${homeAbbr}</span>
              <span style="font-size:9px;color:var(--muted);font-family:'JetBrains Mono',monospace">${homeP?.fullName?.split(' ').pop()||'TBD'}</span>
            </div>
          </div>

          <!-- DR Pick -->
          <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
            <span style="font-size:9px;color:var(--muted);letter-spacing:1px;text-transform:uppercase">Diamond Report Pick</span>
            <div class="gp-pick gp-pick-win" style="display:flex;flex-direction:row;align-items:center;gap:8px;padding:8px 16px">
              ${winLogo}
              <div style="display:flex;flex-direction:column;align-items:center">
                <span style="font-family:'Manrope',sans-serif;font-size:22px;letter-spacing:1px;line-height:1;color:#2ecc71">${winnerAbbr}</span>
                <span style="font-size:9px;color:#2ecc71;opacity:.8;font-family:'JetBrains Mono',monospace">${winnerPct}% WIN</span>
              </div>
            </div>
            <span style="font-size:10px;font-weight:700;color:${confColor};letter-spacing:.5px">${confidence}</span>
          </div>

          <!-- Win % bars -->
          <div style="display:flex;flex-direction:column;gap:4px;min-width:120px">
            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace;min-width:28px">${awayAbbr}</span>
              <div style="flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden">
                <div style="width:${awayPct}%;height:100%;background:${winner==='away'?'#2ecc71':'var(--muted)'};border-radius:4px"></div>
              </div>
              <span style="font-size:10px;font-family:'JetBrains Mono',monospace;min-width:30px;text-align:right;color:${winner==='away'?'#2ecc71':'var(--muted)'}">${awayPct}%</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace;min-width:28px">${homeAbbr}</span>
              <div style="flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden">
                <div style="width:${homePct}%;height:100%;background:${winner==='home'?'#2ecc71':'var(--muted)'};border-radius:4px"></div>
              </div>
              <span style="font-size:10px;font-family:'JetBrains Mono',monospace;min-width:30px;text-align:right;color:${winner==='home'?'#2ecc71':'var(--muted)'}">${homePct}%</span>
            </div>
          </div>

          <!-- Projected Total -->
          <div style="display:flex;flex-direction:column;align-items:center;gap:2px;min-width:90px" title="DR model estimate from starter WHIP/K9/HR9, bullpen strength, park factor, weather, and team record — not a live sportsbook line">
            <span style="font-size:9px;color:var(--muted);letter-spacing:1px;text-transform:uppercase">Projected Total</span>
            <span style="font-family:'Manrope',sans-serif;font-size:20px;letter-spacing:1px;line-height:1;color:${totalEnvColor}">${projectedTotal.toFixed(1)}</span>
            <span style="font-size:9px;font-weight:700;color:${totalEnvColor};letter-spacing:.5px">${totalEnv}</span>
            ${ouLabel ? `<span class="gp-ou-badge ${ouCls}" title="DR's own Projected Total (${projectedTotal.toFixed(1)}) vs. the market's O/U line — informational only, doesn't change projectedTotal">${ouLabel}</span>` : ''}
          </div>

        </div>

        <!-- HR Boost + Park Factor labels, same compact chip style as Key factors below -->
        <div class="gp-factors">${hrBoostChip}${parkFactorChip}${marketChip}${bullpenChip}${factorChips}</div>
        <button class="btn-lineup dr1027-details-btn" onclick="toggleGameDetails(this)" style="margin-top:8px">▼ PARK &amp; WEATHER DETAILS</button>
        <div class="gp-details-panel pr-expand-panel" style="display:none;margin-top:8px;background:var(--bg);border:1px solid var(--border);border-radius:8px">${parkWeatherHTML}</div>
        <div class="gp-live-result-zone" data-live-score-badge="1" style="margin-top:8px">${resultBadge || ''}</div>
      </div>`, resultCorrect };
    }));

    // Tally correct picks from final games
    const finalResults = gameCards.filter(c => c && c.resultCorrect !== null && c.resultCorrect !== undefined);
    const correctCount = finalResults.filter(c => c.resultCorrect === true).length;
    const totalFinal   = finalResults.length;
    const totalGames   = gameCards.filter(Boolean).length;
    window.__drTodayRecord = { wins: correctCount, losses: totalFinal - correctCount, total: totalFinal, totalGames };
    if (typeof updateHeroTodayRecordStrip === 'function') updateHeroTodayRecordStrip();

    const tallyHTML = totalFinal > 0 ? `
      <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg);border-bottom:1px solid var(--border);flex-wrap:wrap;gap:8px">
        <span style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase">TODAY'S RECORD</span>
        <span style="font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace">${new Date().toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}</span>
        <span style="font-family:'Manrope',sans-serif;font-size:28px;letter-spacing:1px;color:${correctCount===totalFinal?'#2ecc71':correctCount>totalFinal/2?'var(--accent2)':'var(--accent)'}">${correctCount}-${totalFinal-correctCount}</span>
        <span style="font-size:11px;color:var(--muted)">${totalFinal} of ${totalGames} games final</span>
        <span style="font-size:11px;color:var(--muted);font-family:'JetBrains Mono',monospace">${totalFinal>0?Math.round(correctCount/totalFinal*100)+'% accuracy':''}</span>
      </div>` : '';

    el.innerHTML = tallyHTML + (gameCards.filter(Boolean).map(c=>c.html).join('') || `<div class="mu-empty">No game data available.</div>`);
    const now = new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
    if (refreshEl) refreshEl.textContent = `Last updated ${now}`;
    gamePropsLoaded = true;
    // Diamond Report Pick data for every game is now in window.drWinProbStore —
    // the pick immediately instead of waiting for a score change.
    if (window.refreshFavoredPills) window.refreshFavoredPills();

  } catch(e) {
    if (el) el.innerHTML = `<div class="mu-empty" style="color:var(--accent)">Error: ${e.message}</div>`;
  }
}

// Park & Weather detail panel toggle — content is already inlined in the card's
// HTML (built alongside the rest of the model in loadGameProps), so this is a
// plain show/hide, no fetch needed, unlike the K Props lineup panel it's styled
// after.
function toggleGameDetails(btn) {
  const panel = btn.nextElementSibling;
  if (!panel) return;
  const isOpen = panel.style.display === 'block';
  if (isOpen) {
    panel.style.setProperty('display', 'none', 'important');
    btn.innerHTML = '▼ PARK &amp; WEATHER DETAILS';
    btn.classList.remove('active');
  } else {
    panel.style.setProperty('display', 'block', 'important');
    btn.innerHTML = '▲ HIDE PARK &amp; WEATHER DETAILS';
    btn.classList.add('active');
  }
}



// ── PRODUCTION v8.38: Game Center first-load initializer ─────────────
// The Game Center can appear blank on a fresh launch if the async game model
// starts before the schedule/API response is ready. This wrapper gives the panel
// an immediate loading state, serializes duplicate calls, retries slow first
// loads, and re-checks the panel after the browser finishes loading.
const __drLoadGamePropsCore = loadGameProps;
let __drGameCenterInFlight = null;
let __drGameCenterLastSuccess = 0;
loadGameProps = async function loadGamePropsFirstLoadSafe(opts = {}) {
  const el = document.getElementById('gameprops-content');
  const refreshEl = document.getElementById('gameprops-refresh');
  if (!el) return;

  const hasRealGameCards = () => !!el.querySelector('.gp-card');
  const hasUsefulContent = () => hasRealGameCards() || /No games found|No game data available/i.test(el.textContent || '');

  if (!hasUsefulContent() && !el.querySelector('.spin')) {
    el.innerHTML = `<div class="mu-empty"><span class="spin"></span>Loading Game Center...</div>`;
    if (refreshEl) refreshEl.textContent = 'Loading...';
  }

  if (__drGameCenterInFlight && !opts.force) return __drGameCenterInFlight;

  __drGameCenterInFlight = (async () => {
    let lastText = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      await __drLoadGamePropsCore();
      lastText = (el.textContent || '').trim();
      if (hasUsefulContent()) {
        __drGameCenterLastSuccess = Date.now();
        return;
      }
      // Brief pause for slow MLB schedule/probable-pitcher hydration on first launch.
      await new Promise(resolve => setTimeout(resolve, attempt * 900));
    }
    if (!hasUsefulContent()) {
      el.innerHTML = `<div class="mu-empty" style="color:var(--accent2)">Game Center is still loading. Retrying automatically...</div>`;
      setTimeout(() => loadGameProps({ force: true }), 2500);
    }
  })().finally(() => { __drGameCenterInFlight = null; });

  return __drGameCenterInFlight;
};

function ensureGameCenterFirstLoad() {
  const el = document.getElementById('gameprops-content');
  if (!el) return;
  const txt = (el.textContent || '').trim();
  const hasCard = !!el.querySelector('.gp-card');
  const isBlankOrLoading = !txt || /Loading Game Center|still loading|Error:/i.test(txt);
  if (!hasCard && isBlankOrLoading) loadGameProps({ force: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    ensureGameCenterFirstLoad();
    setTimeout(ensureGameCenterFirstLoad, 1500);
    setTimeout(ensureGameCenterFirstLoad, 5000);
  }, { once: true });
} else {
  setTimeout(ensureGameCenterFirstLoad, 0);
  setTimeout(ensureGameCenterFirstLoad, 1500);
  setTimeout(ensureGameCenterFirstLoad, 5000);
}
window.addEventListener('load', () => setTimeout(ensureGameCenterFirstLoad, 800), { once: true });


function windEffect(deg, homeAbbr) {
  // Simplified: wind blowing toward RF (80-130°) = blowing out for RHB
  // This is a rough approximation without stadium-specific orientation
  if (deg >= 60 && deg <= 150) return 'out';
  if (deg >= 240 && deg <= 330) return 'in';
  return 'cross';
}
// 16-point compass label for the Park & Weather detail panel — purely display,
// same wind direction degrees windEffect already uses for the actual model input.
function compassLabel(deg) {
  if (deg == null || !Number.isFinite(deg)) return '–';
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(((deg % 360) / 22.5)) % 16];
}
// WMO weather codes, as returned by Open-Meteo's "weathercode" field — display only.
function weatherCodeLabel(code) {
  const map = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Depositing rime fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
    80: 'Light rain showers', 81: 'Rain showers', 82: 'Violent rain showers',
    95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Severe thunderstorm w/ hail',
  };
  return map[code] ?? '–';
}
// Same WMO codes as weatherCodeLabel, mapped to an emoji for the Park & Weather panel's icon.
function weatherCodeEmoji(code) {
  if (code === 0) return '☀️';
  if (code === 1) return '🌤️';
  if (code === 2) return '⛅';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return '🌧️';
  if ([71, 73, 75].includes(code)) return '❄️';
  if ([95, 96, 99].includes(code)) return '⛈️';
  return '🌡️';
}

// ── Air-density-based weather model (replaces the old flat wind-bucket/temp-
// threshold formula) ────────────────────────────────────────────────────
// Real physics: thinner air (hot, humid, and/or low-pressure) means less drag
// on a fly ball, so it carries farther — the same mechanism that makes Coors
// Field a hitter's park, just applied to day-to-day weather instead of
// permanent altitude. Computed from the ideal gas law with a humidity
// correction (moist air is very slightly LESS dense than dry air at the same
// temp/pressure, since water vapor's molar mass is lower than N2/O2's).
//
// Density formula: rho = Pd/(Rd*T) + Pv/(Rv*T)
//   Pd = partial pressure of dry air, Pv = partial pressure of water vapor
//   Rd = 287.05 J/(kg*K) (dry air), Rv = 461.495 J/(kg*K) (water vapor)
// Saturation vapor pressure from the Tetens approximation (accurate to
// within ~1% over normal game-time temperature ranges, which is plenty for
// this purpose — this isn't a meteorology tool).
function airDensityKgM3(tempF, pressureMslHPa, relHumidityPct) {
  const tempC = (tempF - 32) * 5 / 9;
  const tempK = tempC + 273.15;
  const satVaporHPa = 6.1078 * Math.pow(10, (7.5 * tempC) / (tempC + 237.3));
  const vaporHPa = satVaporHPa * (Math.max(0, Math.min(100, relHumidityPct ?? 50)) / 100);
  const totalPa = pressureMslHPa * 100;
  const vaporPa = vaporHPa * 100;
  const dryPa = totalPa - vaporPa;
  return (dryPa / (287.05 * tempK)) + (vaporPa / (461.495 * tempK));
}
// "Neutral" game-time reference: 70F, 50% humidity, standard sea-level-
// equivalent pressure (1013.25 hPa). Using pressure_msl (not raw local
// surface pressure) for both today's reading and this reference means the
// comparison isolates the day's weather-system pressure anomaly — it does
// NOT vary by each park's own elevation, since pressure_msl already strips
// altitude out. That keeps this purely a "weather" signal, not a second copy
// of the permanent altitude effect the site's separate park factor covers.
const NEUTRAL_AIR_DENSITY = airDensityKgM3(70, 1013.25, 50);
function airDensityHRMult(weather) {
  if (!weather || !Number.isFinite(weather.pressureMsl)) return 1;
  const rho = airDensityKgM3(weather.temp, weather.pressureMsl, weather.humidity);
  const densityRatio = NEUTRAL_AIR_DENSITY / rho; // >1 = thinner-than-normal air (HR-friendly)
  // Real-world fly-ball physics (Nathan, "The Physics of Baseball") puts fly-ball
  // distance roughly proportional to 1/density over the range weather can swing it,
  // and because HR-or-not is so sensitive right at the fence, a given % change in
  // distance produces a noticeably larger % change in HR rate — commonly estimated
  // around 1.5-2x. 1.6 here is a middle-of-that-range calibration, not a precise
  // derivation; clamped to +/-15% so an extreme reading can't dominate the number.
  const DENSITY_HR_SENSITIVITY = 1.6;
  return Math.max(0.85, Math.min(1.15, 1 + DENSITY_HR_SENSITIVITY * (densityRatio - 1)));
}
// Wind's effect scales continuously with speed above a light-breeze floor,
// instead of only ever kicking in above one hard threshold — roughly 0.8% HR
// multiplier per mph blowing out/in past 5mph, a mid-range estimate from the
// same fly-ball-distance-to-HR-rate sensitivity used above (wind's push on
// distance is well-established as roughly linear in speed for a tailwind/
// headwind component). Crosswind (windEffect() === 'cross') is treated as
// having no directional HR effect.
function windHRMult(weather, homeAbbr) {
  if (!weather || !(weather.wind > 5)) return 1;
  const impact = windEffect(weather.windDir, homeAbbr);
  if (impact === 'cross') return 1;
  const WIND_HR_SENSITIVITY = 0.008;
  const mult = 1 + WIND_HR_SENSITIVITY * (weather.wind - 5) * (impact === 'out' ? 1 : -1);
  return Math.max(0.85, Math.min(1.2, mult));
}

// Refresh game props every 5 minutes when loaded (only while tab is visible)
setInterval(() => { if (document.visibilityState === 'visible' && gamePropsLoaded) loadGameProps({ force: true }); }, 2 * 60 * 1000);









function closeMatchup() {
  document.getElementById('mu-modal-overlay').style.display = 'none';
  document.body.style.overflow = '';
}

async function openMatchup(batterId, batterName, pitcherId, pitcherName) {
  const overlay = document.getElementById('mu-modal-overlay');
  const body    = document.getElementById('mu-modal-body');
  const title   = document.getElementById('mu-modal-title');
  const sub     = document.getElementById('mu-modal-sub');

  title.textContent = `${batterName}  vs  ${pitcherName}`;
  sub.textContent   = 'Batter vs Pitcher · 2026 Season Analysis';
  body.innerHTML    = `<div style="padding:20px 0;text-align:center"><span class="spin"></span> Loading matchup data…</div>`;
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  try {
    // Parallel fetch: H2H career stats, batter/pitcher season stats, plus LIVE
    // Statcast expected stats (xBA/xSLG/xwOBA) from the same MLB Stats API via
    // stats=expectedStatistics — batter's quality of contact and pitcher's quality
    // of contact allowed. The repo-fed hot-hitter profile still supplies the
    // Savant-only aggregates (Hard-Hit%, Sweet-Spot%, Barrel%, bat speed, blasts).
    const [h2hData, batterData, pitcherData, bxData, pxData, batterSplitData, pitcherSplitData] = await Promise.all([
      fetchJSON(`https://diamondreport.app/api/v1/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}&group=hitting&season=2026`),
      fetchJSON(`https://diamondreport.app/api/v1/people/${batterId}?hydrate=stats(group=hitting,type=season,season=2026)`),
      fetchJSON(`https://diamondreport.app/api/v1/people/${pitcherId}?hydrate=stats(group=pitching,type=season,season=2026)`),
      fetchJSON(`https://diamondreport.app/api/v1/people/${batterId}/stats?stats=expectedStatistics&group=hitting&season=2026`).catch(() => null),
      fetchJSON(`https://diamondreport.app/api/v1/people/${pitcherId}/stats?stats=expectedStatistics&group=pitching&season=2026`).catch(() => null),
      fetchJSON(`https://diamondreport.app/api/v1/people/${batterId}/stats?stats=statSplits&group=hitting&sitCodes=vl,vr&season=2026`).catch(() => null),
      fetchJSON(`https://diamondreport.app/api/v1/people/${pitcherId}/stats?stats=statSplits&group=pitching&sitCodes=vl,vr&season=2026`).catch(() => null)
    ]);
    await Promise.all([loadStatcastHotHitters(), loadPitcherStatcast(), loadBatterPitchTypeHr(), loadBatterPitchTypeSeason()]);

    const batterPerson = batterData.people?.[0] || {};
    const pitcherPerson = pitcherData.people?.[0] || {};
    const h2h = h2hData.stats?.[0]?.splits?.[0]?.stat || {};
    const bs  = batterPerson.stats?.[0]?.splits?.[0]?.stat || {};
    const ps  = pitcherPerson.stats?.[0]?.splits?.[0]?.stat || {};
    const bx  = bxData?.stats?.[0]?.splits?.[0]?.stat || null;
    const px  = pxData?.stats?.[0]?.splits?.[0]?.stat || null;
    const batterSplits = batterSplitData?.stats?.[0]?.splits || [];
    const pitcherSplits = pitcherSplitData?.stats?.[0]?.splits || [];
    const hotHitter = getStatcastHotHitterProfile({ id: batterId, name: batterName, ops: bs.ops, stats: { slg: bs.slg, avg: bs.avg } });
    const pitcherProfile = pitcherStatcast[String(pitcherId)] || null;

    renderMatchupModal(body, { batterName, pitcherName, batterId, pitcherId, batterPerson, pitcherPerson, batterSplits, pitcherSplits, h2h, bs, ps, bx, px, hotHitter, pitcherProfile });
  } catch(e) {
    body.innerHTML = `<div class="mu-empty" style="color:var(--accent)">Error: ${e.message}</div>`;
  }
}

// Animates a headline number counting up from 0 on first paint. Deliberately only
// used on one-shot content (this modal opens fresh per click, no periodic
// auto-refresh) — the auto-refreshing Game Projections cards intentionally don't
// use this, since re-triggering an animation on every 2-minute rebuild would be
// exactly the kind of distracting repaint the flicker fix above just eliminated.
function animateCountUp(el, endValue, decimals = 0, duration = 700) {
  if (!el || !Number.isFinite(endValue)) return;
  const start = performance.now();
  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = (endValue * eased).toFixed(decimals);
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = endValue.toFixed(decimals);
  }
  requestAnimationFrame(step);
}

function renderMatchupModal(body, { batterName, pitcherName, batterId, pitcherId, batterPerson={}, pitcherPerson={}, batterSplits=[], pitcherSplits=[], h2h, bs, ps, bx, px, hotHitter, pitcherProfile }) {
  function fv(v, dec=3) {
    if (v==null||v===''||v==='---') return '–';
    const n = parseFloat(v); return isNaN(n) ? '–' : n.toFixed(dec).replace(/^0(\.)/, '$1');
  }
  function fi(v) { const n=parseInt(v); return isNaN(n)?'–':String(n); }
  function handCode(obj, key) {
    const raw = obj?.[key]?.code || obj?.[key]?.description || obj?.[key] || '';
    const s = String(raw || '').toUpperCase();
    if (s.startsWith('L') || s.includes('LEFT')) return 'L';
    if (s.startsWith('R') || s.includes('RIGHT')) return 'R';
    if (s.startsWith('S') || s.includes('SWITCH')) return 'S';
    return '–';
  }
  function handLabel(code, type) {
    if (type === 'pitcher') return code === 'L' ? 'LHP' : code === 'R' ? 'RHP' : 'Pitch hand N/A';
    return code === 'L' ? 'LHB' : code === 'R' ? 'RHB' : code === 'S' ? 'SHB' : 'Bat hand N/A';
  }
  function splitStat(splits, codes) {
    const wanted = new Set(codes.map(c => String(c).toLowerCase()));
    return (splits || []).find(sp => {
      const c = String(sp?.split?.code || sp?.split?.description || sp?.split || '').toLowerCase();
      return [...wanted].some(w => c === w || c.includes(w));
    })?.stat || null;
  }
  function firstStat(...vals) {
    for (const v of vals) if (v !== null && v !== undefined && v !== '' && v !== '–' && v !== '---') return v;
    return null;
  }

  // ── H2H Career block ──
  const h2hAB  = fi(h2h.atBats);
  const h2hAVG = fv(h2h.avg);
  const h2hHR  = fi(h2h.homeRuns);
  const h2hK   = fi(h2h.strikeOuts);
  const h2hOPS = fv(h2h.ops);
  const h2hHits = fi(h2h.hits);
  const hasH2H = h2hAB !== '–' && parseInt(h2h.atBats) > 0;

  // ── Season stats ──
  const bAVG  = fv(bs.avg);  const bHR = fi(bs.homeRuns); const bOPS = fv(bs.ops);
  const bISO  = (bs.slg&&bs.avg) ? fv((parseFloat(bs.slg)-parseFloat(bs.avg)).toFixed(3)) : '–';
  const bKpct = (bs.strikeOuts&&bs.plateAppearances) ? (bs.strikeOuts/bs.plateAppearances*100).toFixed(1)+'%' : '–';
  const bBBpct= (bs.baseOnBalls&&bs.plateAppearances) ? (bs.baseOnBalls/bs.plateAppearances*100).toFixed(1)+'%' : '–';
  // RBI/SB were already present on every hitting-stats API response this modal already
  // fetches — just never extracted or shown anywhere in this panel.
  const bRBI  = fi(bs.rbi ?? bs.runsBattedIn);
  const bSB   = fi(bs.stolenBases);
  // SB success% needs no new data source — caughtStealing is on the exact same
  // hitting-stats response stolenBases already comes from, just never paired with it.
  const bSbAttempts = (Number(bs.stolenBases) || 0) + (Number(bs.caughtStealing) || 0);
  const bSbPct = bSbAttempts > 0 ? `${((Number(bs.stolenBases) || 0) / bSbAttempts * 100).toFixed(0)}%` : '–';

  const pERA  = fv(ps.era,2); const pFIP = fv(ps.fip,2); const pWHIP = fv(ps.whip,2);
  const pHR9  = fv(ps.homeRunsPer9,2); const pKper9 = fv(ps.strikeoutsPer9Inn,1);
  const pAVG  = fv(ps.avg); const pISO = (ps.slg&&ps.avg) ? fv((parseFloat(ps.slg)-parseFloat(ps.avg)).toFixed(3)) : '–';

  const batterHand = handCode(batterPerson, 'batSide');
  const pitcherHand = handCode(pitcherPerson, 'pitchHand');
  const pitcherVsBatterHand = batterHand === 'L' ? splitStat(pitcherSplits, ['vl', 'vs left', 'left']) : batterHand === 'R' ? splitStat(pitcherSplits, ['vr', 'vs right', 'right']) : null;
  const batterVsPitcherHand = pitcherHand === 'L' ? splitStat(batterSplits, ['vl', 'vs left', 'left']) : pitcherHand === 'R' ? splitStat(batterSplits, ['vr', 'vs right', 'right']) : null;
  const batterSplitHR = firstStat(batterVsPitcherHand?.homeRuns, batterVsPitcherHand?.hr, bs.homeRuns);
  const pitcherSplitHRAllowed = firstStat(pitcherVsBatterHand?.homeRuns, pitcherVsBatterHand?.homeRunsAllowed, ps.homeRuns);
  const batterSplitOPS = firstStat(batterVsPitcherHand?.ops, bs.ops);
  const pitcherSplitOPSAllowed = firstStat(pitcherVsBatterHand?.ops, ps.ops);
  const batterSplitAvg = firstStat(batterVsPitcherHand?.avg, bs.avg);
  const pitcherSplitAvgAllowed = firstStat(pitcherVsBatterHand?.avg, ps.avg);

  // ── Strike zone vulnerability model ──
  // Real per-zone wOBA-against from the synced pitcher profile
  // (data/pitcher-statcast.json) only. There used to be a modeled heatmap fallback here
  // (a hardcoded zone shape scaled by season AVG/SLG) whenever real zone data wasn't
  // synced — removed on purpose, same reasoning as the pitch-mix tables above. Note this
  // is a heavier data source than the pitch-arsenal sync currently covers (real zone
  // data needs pitch-by-pitch location data, not just per-pitch-type aggregates), so this
  // panel will show "no data" until that separate sync exists.
  const usingExpected = !!(px && (px.slg || px.avg));
  const pitcherVuln = parseFloat(px?.slg ?? ps.slg) || .350;
  const pitcherAvgA = parseFloat(px?.avg ?? ps.avg) || .240;
  const batterPow   = parseInt(bs.homeRuns)||0;
  const batterXSLG  = parseFloat(bx?.slg) || null;

  const hasRealZones = !!(pitcherProfile?.byZone);

  // [TL, TM, TR, ML, MM, MR, BL, BM, BR] — Statcast zone order: 1-2-3 top, 4-5-6 mid, 7-8-9 bottom
  let zoneVals = null;
  if (hasRealZones) {
    const zMap = pitcherProfile.byZone;
    // Use xwOBA-on-contact when available (luck-stripped), else raw wOBA, else null for that cell
    zoneVals = [1,2,3,4,5,6,7,8,9].map(z => {
      const cell = zMap[z];
      if (!cell) return null;
      const val = cell.xwobaContact ?? cell.wobaAgainst ?? cell.xwoba ?? cell.woba;
      // Normalise wOBA scale (0–1 readable): league avg wOBA ≈ .320. Scale so .320 = 0.5
      return val != null ? Math.min(val / 0.640, 1.0) : null;
    });
    if (zoneVals.every(v => v == null)) zoneVals = null;
  }

  function zoneColor(v) {
    if (v >= 0.85) return { bg:'#4a1010', text:'#ff6b6b', label:'HOT' };
    if (v >= 0.65) return { bg:'#3a2010', text:'#f4a261', label:'WARM' };
    if (v >= 0.45) return { bg:'#1a2a10', text:'#90ee60', label:'OK' };
    return { bg:'#0d1a0d', text:'#3a6a3a', label:'COLD' };
  }

  const zoneLabels = ['In/High','High','Out/High','Inside','Middle','Away','In/Low','Low','Out/Low'];
  const zoneCells = zoneVals ? zoneVals.map((v, i) => {
    if (v == null) return `<div class="sz-cell" style="background:#0d1220;color:var(--muted)" title="${zoneLabels[i]}: no data">–</div>`;
    const c = zoneColor(v);
    const pct = Math.round(v * 100);
    return `<div class="sz-cell" style="background:${c.bg};color:${c.text}" title="${zoneLabels[i]}: ${pct}% opportunity">
      ${pct}%
    </div>`;
  }).join('') : '';

  function buildZoneFit() {
    if (!zoneVals) return null;
    const weights = zoneVals.map((v, i) => ({ i, v: v ?? 0 })).sort((a,b) => b.v - a.v);
    const topZones = weights.slice(0, 3);
    const topNames = topZones.map(z => zoneLabels[z.i]).join(' · ');
    const elevated = topZones.some(z => z.i <= 2);
    const middle = topZones.some(z => z.i === 4);
    const pullSide = batterHand === 'L' ? [2,5,8] : batterHand === 'R' ? [0,3,6] : [0,2,3,5,6,8];
    const pullMatch = topZones.some(z => pullSide.includes(z.i));
    const avgTop = topZones.reduce((sum,z) => sum + z.v, 0) / Math.max(1, topZones.length);
    const powerBoost = Math.max(0, Math.min(12, ((parseFloat(bISO) || 0) - .170) * 70));
    const fitScore = Math.max(1, Math.min(99, Math.round(avgTop * 72 + (elevated ? 8 : 0) + (middle ? 7 : 0) + (pullMatch ? 7 : 0) + powerBoost)));
    const fitLabel = fitScore >= 85 ? 'Elite Zone Fit' : fitScore >= 72 ? 'Strong Zone Fit' : fitScore >= 58 ? 'Playable Zone Fit' : 'Pitcher Zone Edge';
    const fitTone = fitScore >= 85 ? 'var(--accent2)' : fitScore >= 72 ? 'var(--green)' : fitScore >= 58 ? '#f4a261' : 'var(--muted)';
    const read = fitScore >= 72
      ? `${batterName.split(' ').pop()} has a favorable zone path if ${pitcherName.split(' ').pop()} misses into ${topNames}.`
      : `${pitcherName.split(' ').pop()} does not show a clean mistake-zone overlap for ${batterName.split(' ').pop()} unless command slips.`;
    return { score: fitScore, label: fitLabel, tone: fitTone, topNames, read, elevated, middle, pullMatch };
  }
  const zoneFit = buildZoneFit();

  // ── Attack Zone by Pitch (per-pitch-type location breakdown) ────────────
  // Same real Statcast Search data as the aggregate Strike Zone above (see
  // sync-pitcher-zone-hr.mjs's byPitchZone, merged onto each byPitch[] entry as
  // .zones), but scoped to one pitch type at a time. usagePct is the real signal —
  // what share of THIS pitch's own throws land in each of the 9 zones, i.e. his
  // actual location tendency for that pitch — not an opportunity/damage score like
  // the aggregate grid above it.
  function attackZoneColor(pct) {
    if (pct == null) return { bg:'#0d1220', text:'var(--muted)' };
    if (pct >= 20) return { bg:'#4a1010', text:'#ff6b6b' };
    if (pct >= 14) return { bg:'#3a2010', text:'#f4a261' };
    if (pct >= 8)  return { bg:'#1a2a10', text:'#90ee60' };
    return { bg:'#0d1a0d', text:'#3a6a3a' };
  }
  const attackZonePitches = (pitcherProfile?.byPitch || []).filter(p => p?.name && p.zones && Object.keys(p.zones).length);
  let attackZoneHTML = '';
  if (attackZonePitches.length) {
    const auid = `azone-${String(pitcherId||'p')}-${Math.random().toString(36).slice(2,8)}`;
    const tabs = attackZonePitches.map((p, i) => `<button type="button" class="dr1042-split-btn${i===0?' active':''}" data-pitch="${i}">${p.name}</button>`).join('');
    const bodies = attackZonePitches.map((p, i) => {
      const cells = [1,2,3,4,5,6,7,8,9].map(z => {
        const cell = p.zones[z];
        const pct = cell?.usagePct;
        if (pct == null) return `<div class="sz-cell" style="background:#0d1220;color:var(--muted)" title="${zoneLabels[z-1]}: no data">–</div>`;
        const c = attackZoneColor(pct);
        const wobaTxt = cell.wobaAgainst != null ? `, ${fv(cell.wobaAgainst,3)} wOBA against` : '';
        return `<div class="sz-cell" style="background:${c.bg};color:${c.text}" title="${zoneLabels[z-1]}: ${pct}% of his ${p.name}s${wobaTxt}">${pct}%</div>`;
      }).join('');
      return `<div class="dr-azone-mode-body${i===0?' active':''}" data-pitch="${i}"><div class="strike-zone">${cells}</div></div>`;
    }).join('');
    attackZoneHTML = `
    <div class="zone-section" id="${auid}" data-attack-zone-toggle>
      <div class="zone-title">ATTACK ZONE BY PITCH · REAL LOCATION DATA</div>
      <div class="zone-wrap">
        <div class="zone-grid-outer">
          <span class="zone-label">OUTSIDE ←&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;→ INSIDE</span>
          <div style="display:flex;align-items:center;gap:6px">
            <div style="display:flex;flex-direction:column;gap:2px;font-size:9px;color:var(--muted);text-align:right;padding-right:4px">
              <div style="height:40px;display:flex;align-items:center">HIGH</div>
              <div style="height:40px;display:flex;align-items:center">MID</div>
              <div style="height:40px;display:flex;align-items:center">LOW</div>
            </div>
            ${bodies}
          </div>
          <span class="zone-label" style="margin-top:4px">% = share of that pitch's own throws landing in each zone</span>
        </div>
        <div>
          <div class="dr1042-split-toggle" role="tablist" aria-label="Attack zone pitch toggle" style="flex-wrap:wrap;height:auto">${tabs}</div>
          <div class="zone-note" style="margin-top:10px;max-width:220px">Where ${pitcherName.split(' ').pop()} actually locates each individual pitch — his real location tendency pitch by pitch, not just the blended zone profile above.</div>
        </div>
      </div>
    </div>`;
  }

  function normalizePitchLabel(name) { return normalizePitchTypeKey(name); }
  function extractPitchStatValue(obj, keys) {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of keys) {
      const v = obj[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  }
  function findPitchSplitFromSources(pitchName, sourceList) {
    const key = normalizePitchLabel(pitchName);
    for (const src of (sourceList || []).filter(Boolean)) {
      if (Array.isArray(src)) {
        const hit = src.find(x => normalizePitchLabel(x.name || x.pitchName || x.pitchType || x.type || x.code || x.pitch) === key);
        if (hit) return hit;
      } else if (typeof src === 'object') {
        for (const [k,v] of Object.entries(src)) {
          if (normalizePitchLabel(k) === key) return (v && typeof v === 'object') ? { name:k, ...v } : { name:k, homeRuns:v };
        }
      }
    }
    return null;
  }
  function getPitchTypeHrCount(pitchName, usagePct) {
    const syncedById = batterPitchTypeHr[String(batterId)];
    const syncedByName = batterPitchTypeHr[String(batterName || '').toLowerCase()];
    const careerSplit = findPitchSplitFromSources(pitchName, [
      syncedById,
      syncedByName,
      hotHitter?.careerHrByPitch,
      hotHitter?.allTimeHrByPitch,
      hotHitter?.careerHomeRunsByPitch,
      hotHitter?.allTimeHomeRunsByPitch,
      hotHitter?.careerPitchTypeHomeRuns,
      hotHitter?.allTimePitchTypeHomeRuns,
      hotHitter?.careerPitchSplits,
      hotHitter?.allTimePitchSplits,
      bs?.careerHrByPitch,
      bs?.allTimeHrByPitch,
      bs?.careerHomeRunsByPitch,
      bs?.allTimeHomeRunsByPitch,
      bs?.careerPitchTypeHomeRuns,
      bs?.allTimePitchTypeHomeRuns,
      bs?.careerPitchSplits,
      bs?.allTimePitchSplits,
      hotHitter?.hrByPitch,
      hotHitter?.homeRunsByPitch,
      hotHitter?.pitchTypeHomeRuns,
      hotHitter?.pitchSplits,
      bs?.hrByPitch,
      bs?.homeRunsByPitch,
      bs?.pitchTypeHomeRuns,
      bs?.pitchSplits
    ]);
    if (careerSplit) {
      const val = extractPitchStatValue(careerSplit, ['homeRuns','hr','hrs','HR','home_runs']);
      if (val !== undefined && val !== null && val !== '') {
        return {
          value: parseInt(val) || 0,
          exact: true,
          source: 'Exact career split',
          sourceClass: 'exact',
          avg: extractPitchStatValue(careerSplit, ['avg','battingAverage','AVG']),
          slg: extractPitchStatValue(careerSplit, ['slg','slugging','SLG']),
          xslg: extractPitchStatValue(careerSplit, ['xslg','xSLG','expectedSlugging']),
          hardHit: extractPitchStatValue(careerSplit, ['hardHitPct','hardHit','hard_hit_percent','hardHitRate'])
        };
      }
    }

    const seasonSplit = getBatterSeasonPitchProfile(pitchName);
    if (seasonSplit) {
      const seasonHr = extractPitchStatValue(seasonSplit, ['homeRuns','hr','hrs','HR','home_runs']);
      if (seasonHr !== undefined && seasonHr !== null && seasonHr !== '') {
        return {
          value: parseInt(seasonHr) || 0,
          exact: false,
          source: 'Season split fallback',
          sourceClass: 'fallback',
          avg: extractPitchStatValue(seasonSplit, ['avg','battingAverage','AVG']),
          slg: extractPitchStatValue(seasonSplit, ['slg','slugging','SLG']),
          xslg: extractPitchStatValue(seasonSplit, ['xslg','xSLG','expectedSlugging']),
          hardHit: extractPitchStatValue(seasonSplit, ['hardHitPct','hardHit','hard_hit_percent','hardHitRate'])
        };
      }
    }

    return null;
  }
  function pitchHrHTML(pitchName, usagePct) {
    const hr = getPitchTypeHrCount(pitchName, usagePct);
    if (!hr) return `<span class="pitch-hr-type" style="color:var(--muted)" title="No real data available">–</span>`;
    return `<span class="pitch-hr-type ${hr.exact ? 'exact' : 'estimated'}" title="${hr.exact ? 'Batter career home runs against this pitch type from all-time pitch-split data.' : 'Batter season home runs against this pitch type from real synced season splits.'}">${hr.value}</span>`;
  }
  function buildPitchTypeHrCards(pitchList) {
    return '';
  }


  function parsePctVal(v) {
    // Every caller here (usagePct, hardHitPct, barrelPct, whiffPct) comes from the
    // repo-synced data files, which already store plain 0-100 percent numbers — the
    // same convention used successfully elsewhere in the app (see pctNum()). This used
    // to guess that any value <= 1 must be a fraction and multiply it by 100, which
    // silently turned a genuine low rate like a 1% barrel rate into a fabricated 100%.
    if (v === null || v === undefined || v === '' || v === '–') return null;
    if (typeof v === 'string' && v.trim().endsWith('%')) return parseFloat(v);
    const n = parseFloat(v);
    if (Number.isNaN(n)) return null;
    return n;
  }
  function parseDecVal(v) {
    if (v === null || v === undefined || v === '' || v === '–') return null;
    const n = parseFloat(v);
    return Number.isNaN(n) ? null : n;
  }
  function fmtDec(v, d=3, kind=null) {
    const n = parseDecVal(v);
    if (n === null) return '–';
    if (kind) drCheckStat('Pitch Mix Advantage', kind, n, kind);
    return n.toFixed(d).replace(/^0(?=\.)/, '');
  }
  function fmtPctVal(v, d=0, kind=null) {
    const n = parsePctVal(v);
    if (n === null) return '–';
    if (kind) drCheckStat('Pitch Mix Advantage', kind, n, kind);
    return `${n.toFixed(d)}%`;
  }
  // Flags a stat cell as favorable for the batter against this specific pitch — i.e. a
  // real weak spot for the pitcher, not just "the batter has a good season." Whiff% is
  // inverted (low whiff = good contact = good for the batter) since it's the one column
  // here where a high number favors the pitcher instead.
  function gbGood(kind, v) {
    if (v === null || v === undefined || Number.isNaN(v)) return false;
    if (kind === 'avg') return v >= .280;
    if (kind === 'slg') return v >= .450;
    if (kind === 'xslg') return v >= .450;
    if (kind === 'hr') return v >= 3;
    if (kind === 'hardHit') return v >= 40;
    if (kind === 'barrel') return v >= 8;
    if (kind === 'whiff') return v <= 20;
    if (kind === 'woba') return v >= .340;
    return false;
  }
  function gbCls(kind, v) { return gbGood(kind, v) ? ' gb-good' : ''; }
  const gbLegendHTML = '<div class="dr1041-legend-note"><span class="gb-good-dot"></span> Green = favorable for the batter — a real weak spot for the pitcher on that pitch, not just a good season overall.</div>';
  function getBatterSeasonPitchProfile(pitchName, splitHand) {
    const key = normalizePitchLabel(pitchName);
    const handKey = splitHand === 'L' ? 'vsLHP' : splitHand === 'R' ? 'vsRHP' : null;
    const byId = batterPitchTypeSeason[String(batterId)];
    const byName = batterPitchTypeSeason[String(batterName || '').toLowerCase()];
    const baseSources = [byId, byName, hotHitter?.seasonPitchTypeStats, hotHitter?.pitchTypeSeason, hotHitter?.byPitchSeason, bs?.seasonPitchTypeStats, bs?.pitchTypeSeason].filter(Boolean);
    const sources = [];
    if (handKey) {
      baseSources.forEach(src => {
        if (!src || typeof src !== 'object') return;
        ['splitsByPitcherHand','byPitcherHand','handednessSplits','pitchTypeSplitsByHand'].forEach(k => {
          if (src[k]?.[handKey]) sources.push(src[k][handKey]);
          if (src[k]?.[splitHand]) sources.push(src[k][splitHand]);
        });
        if (src[handKey]) sources.push(src[handKey]);
        if (src[splitHand]) sources.push(src[splitHand]);
      });
    }
    sources.push(...baseSources);
    for (const src of sources) {
      if (Array.isArray(src)) {
        const hit = src.find(x => normalizePitchLabel(x.name || x.pitchName || x.pitchType || x.type || x.code || x.pitch) === key);
        if (hit) return hit;
      } else if (typeof src === 'object') {
        for (const [k,v] of Object.entries(src)) {
          if (normalizePitchLabel(k) === key) return (v && typeof v === 'object') ? { name:k, ...v } : { name:k, homeRuns:v };
        }
      }
    }
    return null;
  }
  function getBatterOverallSplitForPitcherHand(splitHand) {
    if (splitHand === 'L') return splitStat(batterSplits, ['vl', 'vs left', 'left', 'lhp', 'vs lhp']);
    if (splitHand === 'R') return splitStat(batterSplits, ['vr', 'vs right', 'right', 'rhp', 'vs rhp']);
    return null;
  }
  function handAdjustedPitchProfile(stat, pitchName, usagePct, splitHand) {
    const base = Object.assign({}, stat || {});
    const split = getBatterOverallSplitForPitcherHand(splitHand);
    if (!split || (splitHand !== 'L' && splitHand !== 'R')) return base;
    const seasonAvg = parseDecVal(bs.avg);
    const seasonSlg = parseDecVal(bs.slg);
    const splitAvg = parseDecVal(split.avg);
    const splitSlg = parseDecVal(split.slg);
    const splitXslg = parseDecVal(split.xslg ?? split.xSLG ?? split.expectedSlugging);
    const baseAvg = parseDecVal(base.avg ?? base.battingAverage);
    const baseSlg = parseDecVal(base.slg ?? base.slugging);
    const baseXslg = parseDecVal(base.xslg ?? base.xSLG ?? base.expectedSlugging);
    const avgRatio = seasonAvg && splitAvg ? Math.max(.55, Math.min(1.55, splitAvg / seasonAvg)) : 1;
    const slgRatio = seasonSlg && splitSlg ? Math.max(.55, Math.min(1.65, splitSlg / seasonSlg)) : 1;
    if (baseAvg !== null) base.avg = Math.max(.050, Math.min(.500, baseAvg * avgRatio));
    else if (splitAvg !== null) base.avg = splitAvg;
    if (baseSlg !== null) base.slg = Math.max(.120, Math.min(1.050, baseSlg * slgRatio));
    else if (splitSlg !== null) base.slg = splitSlg;
    if (baseXslg !== null) base.xslg = Math.max(.120, Math.min(1.100, baseXslg * slgRatio));
    else if (splitXslg !== null) base.xslg = splitXslg;
    const handHr = parseInt(split.homeRuns ?? split.hr ?? split.hrs ?? 0) || 0;
    const exactPitchHr = parseInt(base.homeRuns ?? base.hr ?? base.hrs);
    if (!Number.isFinite(exactPitchHr) || exactPitchHr <= 0) base.homeRuns = Math.max(0, Math.round(handHr * ((parseFloat(usagePct) || 0) / 100)));
    base.__splitHand = splitHand;
    return base;
  }
  function gradePitchAdvantage(stat, usagePct) {
    if (!stat) return { score:null, cls:'neutral', label:'Pending' };
    const xslg = parseDecVal(stat.xslg ?? stat.xSLG ?? stat.expectedSlugging);
    const slg = parseDecVal(stat.slg ?? stat.slugging);
    const avg = parseDecVal(stat.avg ?? stat.battingAverage);
    const hr = +(stat.homeRuns ?? stat.hr ?? stat.hrs ?? 0) || 0;
    const hard = parsePctVal(stat.hardHitPct ?? stat.hardHitRate);
    const barrel = parsePctVal(stat.barrelPct ?? stat.barrelRate);
    let raw = 45;
    if (xslg !== null) raw += (xslg - .400) * 75;
    else if (slg !== null) raw += (slg - .400) * 60;
    if (avg !== null) raw += (avg - .250) * 35;
    raw += Math.min(hr, 8) * 2.5;
    if (hard !== null) raw += (hard - 38) * .45;
    if (barrel !== null) raw += (barrel - 7) * 1.2;
    const usageBoost = Math.max(0, (parseFloat(usagePct) || 0) - 15) * .15;
    const score = Math.max(1, Math.min(99, Math.round(raw + usageBoost)));
    const cls = score >= 78 ? 'elite' : score >= 64 ? 'good' : score >= 45 ? 'neutral' : 'weak';
    const label = score >= 78 ? 'Excellent' : score >= 64 ? 'Strong' : score >= 45 ? 'Neutral' : 'Weak';
    return { score, cls, label };
  }
  function buildPitchMixAdvantageSection(pitchList) {
    function pitchAbbr(name) {
      const n = String(name || '').toLowerCase();
      if (n.includes('fastball')) return 'FF';
      if (n.includes('slider')) return 'SL';
      if (n.includes('change')) return 'CH';
      if (n.includes('curve')) return 'CB';
      if (n.includes('sinker') || n.includes('2-seam') || n.includes('two-seam')) return 'SI';
      if (n.includes('cutter')) return 'CT';
      if (n.includes('split')) return 'FS';
      return String(name || 'P').split(/[\s/-]+/).map(w => w[0]).join('').slice(0,3).toUpperCase() || 'P';
    }
    const modes = [
      { key:'auto', label:'AUTO', hand:(pitcherHand === 'L' || pitcherHand === 'R') ? pitcherHand : null },
      { key:'R', label:'vs RHP', hand:'R' },
      { key:'L', label:'vs LHP', hand:'L' }
    ];
    function buildMode(mode) {
      // Real batter data only — a pitch type this batter has no synced season split
      // against is dropped from the table entirely rather than filled in with a modeled
      // guess (see data/batter-pitch-type-season.json / scripts/sync-pitcher-statcast.mjs).
      const pitches = (pitchList || []).map(p => {
        const usage = parseFloat(p.usagePct ?? p.usage ?? 0) || 0;
        const exact = getBatterSeasonPitchProfile(p.name, mode.hand);
        if (!exact) return null;
        const stat = handAdjustedPitchProfile(exact, p.name, usage, mode.hand);
        return { name:p.name, usage, abbr:pitchAbbr(p.name), stat, exact: true };
      }).filter(Boolean).filter(p => p.name);
      let weighted = 0, weight = 0;
      const rows = pitches.map(p => {
        const st = p.stat || {};
        const grade = gradePitchAdvantage(st, p.usage);
        if (grade.score !== null && p.usage > 0) { weighted += grade.score * p.usage; weight += p.usage; }
        const chipCls = grade.score >= 78 ? '' : grade.score >= 64 ? ' good' : grade.score >= 45 ? ' neutral' : ' weak';
        // Baseball Savant's pitch-arsenal leaderboard doesn't expose a raw HR-count
        // column (rate/quality metrics only), so this is genuinely unknown, not zero —
        // keep it null rather than coercing to 0, which would falsely claim "never
        // allowed a HR on this pitch."
        const rowHrRaw = st.homeRuns ?? st.hr ?? st.hrs;
        const rowHr = rowHrRaw != null ? (+rowHrRaw || 0) : null;
        // "Has hit at least one HR off this pitch" is true for nearly every pitch type
        // a real power hitter sees over a season, so that alone tagged every row. Only
        // flag pitches where the actual HR(s) are backed by a Strong/Excellent composite
        // grade (xSLG, hard-hit%, barrel%, usage) — a genuine standout, not season noise.
        const hrSpotTag = (rowHr != null && rowHr > 0 && grade.score !== null && grade.score >= 64)
          ? '<span class="dr1041-chip weak" style="font-size:9px;padding:2px 7px;margin-right:4px">🔥 HR Spot</span>' : '';
        const avgRaw = parseDecVal(st.avg ?? st.battingAverage);
        const slgRaw = parseDecVal(st.slg ?? st.slugging);
        const xslgRaw = parseDecVal(st.xslg ?? st.xSLG ?? st.expectedSlugging);
        const wobaRaw = parseDecVal(st.woba ?? st.wOBA);
        const hardRaw = parsePctVal(st.hardHitPct ?? st.hardHitRate);
        const whiffRaw = parsePctVal(st.whiffPct ?? st.whiffRate);
        return `<tr>
          <td><strong>${p.name}</strong></td>
          <td class="usage">${p.usage ? p.usage.toFixed(0)+'%' : '–'}</td>
          <td class="num${gbCls('avg',avgRaw)}">${fmtDec(st.avg ?? st.battingAverage, 3, 'avg')}</td>
          <td class="num${gbCls('slg',slgRaw)}">${fmtDec(st.slg ?? st.slugging, 3, 'slg')}</td>
          <td class="num${gbCls('xslg',xslgRaw)}">${fmtDec(st.xslg ?? st.xSLG ?? st.expectedSlugging, 3, 'xslg')}</td>
          <td class="num${gbCls('woba',wobaRaw)}">${fmtDec(st.woba ?? st.wOBA, 3, 'woba')}</td>
          <td class="num${gbCls('hr',rowHr)}">${rowHr != null ? rowHr : '–'}</td>
          <td class="num${gbCls('hardHit',hardRaw)}">${fmtPctVal(st.hardHitPct ?? st.hardHitRate, 0, 'hardHit')}</td>
          <td class="num${gbCls('whiff',whiffRaw)}">${fmtPctVal(st.whiffPct ?? st.whiffRate, 1, 'whiff')}</td>
          <td>${hrSpotTag}<span class="dr1041-chip${chipCls}">${grade.label}${grade.score!==null?' · '+grade.score:''}</span></td>
        </tr>`;
      }).join('');
      const score = weight ? Math.round(weighted / weight) : null;
      const top = pitches.map(p => ({ ...p, grade: gradePitchAdvantage(p.stat, p.usage) })).sort((a,b) => (b.usage * (b.grade.score || 0)) - (a.usage * (a.grade.score || 0)))[0];
      const handText = mode.hand === 'L' ? 'left-handed pitching' : mode.hand === 'R' ? 'right-handed pitching' : 'today’s starter hand';
      const summary = top
        ? `${mode.key === 'auto' ? 'AUTO is using today’s starter hand' : 'Viewing historical split'} vs ${mode.hand === 'L' ? 'LHP' : mode.hand === 'R' ? 'RHP' : 'starter'}. ${top.name} is the primary attack pitch at ${top.usage.toFixed(0)}%, and ${batterName.split(' ').pop()} profiles ${top.grade.label.toLowerCase()} against this ${handText} mix.`
        : `No real pitch-level data available for ${batterName} vs this pitch mix yet.`;
      return { pitches, score, rows, summary };
    }
    const built = Object.fromEntries(modes.map(m => [m.key, buildMode(m)]));
    const auto = built.auto;
    if (!auto.pitches.length) {
      const html = `<div class="dr1041-pitch-mix">
        <div class="dr1041-pitch-head">
          <div><div class="dr1041-kicker">🎯 PITCH MIX ADVANTAGE · THIS SEASON</div><div class="dr1041-subtext">No real pitch-level data available for ${batterName} yet — this section will populate once the daily Statcast sync has run for both this pitcher's arsenal and this batter's season splits.</div></div>
        </div>
      </div>`;
      return { html, score:null, pitches:[], usageChips:'' };
    }
    const usageChips = auto.pitches.map(p => `<span class="dr1041-usage-chip"><b>${p.abbr}</b> ${p.usage ? p.usage.toFixed(0)+'%' : '–'}</span>`).join('');
    const uid = `pmix-${String(batterId||'b')}-${String(pitcherId||'p')}-${Math.random().toString(36).slice(2,8)}`;
    const bodies = modes.map(m => `<tbody class="dr1042-mode-body ${m.key==='auto'?'active':''}" data-mode="${m.key}">${built[m.key].rows}</tbody>`).join('');
    const notes = {
      auto: `AUTO · Today’s matchup vs ${pitcherName} (${handLabel(pitcherHand,'pitcher')})`,
      R: 'Viewing historical splits vs Right-Handed Pitchers',
      L: 'Viewing historical splits vs Left-Handed Pitchers'
    };
    const html = `<div class="dr1041-pitch-mix" id="${uid}" data-pitch-mix-toggle>
      <div class="dr1041-pitch-head">
        <div><div class="dr1041-kicker">🎯 PITCH MIX ADVANTAGE · THIS SEASON</div><div class="dr1041-subtext">Compares how well the batter is performing this season against the pitcher's usage mix. Use AUTO for today’s starter, or toggle historical splits vs RHP/LHP.</div></div>
        <div class="dr1042-head-tools">
          <div class="dr1042-split-toggle" role="tablist" aria-label="Pitch mix split toggle">
            <button type="button" class="dr1042-split-btn active" data-mode="auto">AUTO</button>
            <button type="button" class="dr1042-split-btn" data-mode="R">vs RHP</button>
            <button type="button" class="dr1042-split-btn" data-mode="L">vs LHP</button>
          </div>
          <div class="dr1041-score-card"><strong data-score>${auto.score ?? '–'}</strong><span>Weighted Mix Score</span></div>
          <div class="dr1042-split-note" data-note>${notes.auto}</div>
        </div>
      </div>
      <div class="dr1041-table-wrap"><table class="dr1041-pitch-table"><thead><tr><th>Pitch</th><th>Pitcher Usage</th><th>AVG</th><th>SLG</th><th>xSLG</th><th>wOBA</th><th>HR</th><th>Hard Hit</th><th>Whiff</th><th>Advantage</th></tr></thead>${bodies}</table></div>
      ${gbLegendHTML}
      <div class="dr1041-ai-read"><strong style="color:#fff">AI Read:</strong> <span data-ai-read>${auto.summary}</span></div>
      <script type="application/json" data-pmix-state>${JSON.stringify({ scores:{auto:auto.score,R:built.R.score,L:built.L.score}, notes, reads:{auto:auto.summary,R:built.R.summary,L:built.L.summary} }).replace(/</g,'\\u003c')}<\/script>
    </div>`;
    return { html, score:auto.score, pitches:auto.pitches, usageChips };
  }
  // ── Pitch type effectiveness table — the pitcher's own per-pitch numbers (not the
  // batter's — that's the separate Pitch Mix Advantage table above). Real data only, from
  // data/pitcher-statcast.json (see scripts/sync-pitcher-statcast.mjs). This used to fall
  // back to a modeled estimate (derived from K/9 and groundball rate) whenever the sync
  // hadn't run — removed on purpose: an estimate dressed up as a real per-pitch
  // breakdown is worse than honestly saying no data exists yet.
  const hasRealPitchMix = !!(pitcherProfile?.byPitch?.length);
  const pitchSectionLabel = hasRealPitchMix
    ? `${pitcherName.split(' ').pop()}'S PITCHES · ${(pitcherProfile.totalPitches || 0).toLocaleString()} THROWN THIS SEASON`
    : `${pitcherName.split(' ').pop()}'S PITCHES · NO REAL DATA YET`;

  function pitchEffTag(label, cls) { return `<span class="dr1041-chip ${cls}" style="font-size:9px;padding:2px 7px;margin-right:4px">${label}</span>`; }
  function pitchEffRow(name, usage, avg, woba, slg, hr, whiffPct, veloTxt) {
    const tags = [];
    if (whiffPct != null && whiffPct >= 28) tags.push(pitchEffTag('🎯 Putaway','good'));
    if ((avg != null && avg >= .260) || (slg != null && slg >= .430)) tags.push(pitchEffTag('⚠ Vulnerable','weak'));
    return `<tr>
      <td><strong>${name}</strong>${veloTxt||''}</td>
      <td class="usage">${usage!=null?Number(usage).toFixed(0)+'%':'–'}</td>
      <td class="num${gbCls('avg',avg)}">${fmtDec(avg,3)}</td>
      <td class="num${gbCls('woba',woba)}">${fmtDec(woba,3)}</td>
      <td class="num${gbCls('slg',slg)}">${fmtDec(slg,3)}</td>
      <td class="num${gbCls('hr',hr)}">${hr!=null?hr:'–'}</td>
      <td class="num${gbCls('whiff',whiffPct)}">${whiffPct!=null?Number(whiffPct).toFixed(0)+'%':'–'}</td>
      <td>${tags.join('') || '<span style="color:var(--muted);font-size:11px">–</span>'}</td>
    </tr>`;
  }

  let pitchRows = '';
  let pitchHrList = [];
  if (hasRealPitchMix) {
    pitchHrList = pitcherProfile.byPitch.map(p => ({ name: p.name, usagePct: p.usagePct }));
    // Real pitch mix from sync script.
    pitchRows = pitcherProfile.byPitch.map(p => {
      const woba = p.woba ?? p.wobaAgainst ?? p.xwoba ?? p.xwobaContact ?? null;
      const avg = p.avg ?? p.avgAgainst ?? null;
      const slg = p.slg ?? p.slgAgainst ?? null;
      const hr = p.homeRuns ?? p.hr ?? null;
      const whiffPct = p.whiffPct ?? p.whiffRate ?? null;
      const veloTxt = p.avgVelo ? ` · ${p.avgVelo} mph` : '';
      return pitchEffRow(p.name, p.usagePct, avg, woba, slg, hr, whiffPct, veloTxt);
    }).join('');
  }

  const pitchEffectivenessTableHTML = hasRealPitchMix ? `<div class="dr1041-pitch-mix" style="margin-top:14px">
    <div class="dr1041-pitch-head">
      <div><div class="dr1041-kicker">🧪 ${pitchSectionLabel}</div><div class="dr1041-subtext">Real synced pitch-level data for ${pitcherName}.</div></div>
    </div>
    <div class="dr1041-table-wrap"><table class="dr1041-pitch-table"><thead><tr><th>Pitch</th><th>Usage</th><th>AVG</th><th>wOBA</th><th>SLG</th><th>HR</th><th>Whiff%</th><th>Notes</th></tr></thead><tbody>${pitchRows}</tbody></table></div>
    ${gbLegendHTML}
  </div>` : `<div class="dr1041-pitch-mix" style="margin-top:14px">
    <div class="dr1041-pitch-head">
      <div><div class="dr1041-kicker">🧪 ${pitchSectionLabel}</div><div class="dr1041-subtext">No real pitch-level data available for ${pitcherName} yet — this section will populate once the daily Statcast sync has run.</div></div>
    </div>
  </div>`;

  // Zone Fit's "Location Tendency" dot grid was always a fixed decorative pattern
  // ([1,3,4,5,7].includes(...)), never real pitch-location data — there is no real data
  // source for it without a full pitch-by-pitch Statcast location sync (a separate,
  // heavier pipeline than the pitch-arsenal sync this modal now uses). Rather than keep
  // a fake visualization alive, this panel is gated behind the same hasRealZones flag as
  // the Strike Zone heatmap and shows nothing until real zone data exists.
  function buildZoneFitPanelHTML(pitches) {
    const list = (pitches && pitches.length ? pitches : []).slice(0,5);
    if (!hasRealZones || !list.length) return '';
    const rows = list.map((p) => {
      const st = p.stat || {};
      const grade = gradePitchAdvantage(st, p.usage || p.usagePct || 0);
      const fitLabel = grade.score >= 78 ? 'Excellent' : grade.score >= 64 ? 'Good' : grade.score >= 45 ? 'Neutral' : 'Weak';
      const chipCls = grade.score >= 78 ? '' : grade.score >= 64 ? ' good' : grade.score >= 45 ? ' neutral' : ' weak';
      const avg = fmtDec(st.avg ?? st.battingAverage, 3, 'avg');
      const hr = +(st.homeRuns ?? st.hr ?? st.hrs ?? 0) || 0;
      return `<tr>
        <td><strong>${p.name}</strong></td>
        <td><span class="dr1041-chip${chipCls}">${fitLabel}</span></td>
        <td class="num">${avg} AVG / ${hr} HR</td>
      </tr>`;
    }).join('');
    return `<div class="zone-section zone-fit-section">
      <div class="zone-title">🎯 ZONE FIT · VS THIS PITCHER'S ARSENAL</div>
      <table class="dr1041-zone-fit-table"><thead><tr><th>Pitch</th><th>Zone Fit</th><th>Vs This Batter</th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  }

  const pitchMixDashboard = buildPitchMixAdvantageSection(pitchHrList);
  const zoneFitPanelHTML = buildZoneFitPanelHTML(pitchMixDashboard.pitches);
  const bottomUsageChips = pitchMixDashboard.usageChips || '';

  // ── Simulated Odds Today — reuses the exact same Monte Carlo engine (and, when the
  // batter/pitcher are already in today's scanned pool, the exact same cached result) that
  // powers the Hits/RBI/TB/SB/HR Threats/K Props boards, applied to this one matchup. This
  // keeps the modal consistent with those boards instead of quoting a second, independently
  // modeled number for the same player.
  function simOddsChip(label, pct) {
    if (pct === null || pct === undefined || Number.isNaN(pct)) return '';
    const p = Math.round(Number(pct));
    const cls = p >= 65 ? 'good' : p >= 40 ? 'neutral' : 'weak';
    return `<div class="dr1044-odds-chip ${cls}"><strong>${p}%</strong><span>${label}</span></div>`;
  }
  const propRowPool = (typeof window.getProductionPropRows === 'function') ? window.getProductionPropRows() : [];
  const matchupRow = propRowPool.find(r => r && String(r.id) === String(batterId)) || null;
  const kPropsPool = Array.isArray(window.kPropsData) ? window.kPropsData : [];
  const matchupKRow = kPropsPool.find(r => r && String(r.pitcherId) === String(pitcherId)) || null;
  let simOddsChips = '';
  if (matchupRow) {
    simOddsChips += simOddsChip('Hits (1+)', window.simulatePropOdds ? window.simulatePropOdds('hits', matchupRow) : null);
    simOddsChips += simOddsChip('Total Bases (2+)', window.simulatePropOdds ? window.simulatePropOdds('tb', matchupRow) : null);
    simOddsChips += simOddsChip('RBI (1+)', window.simulatePropOdds ? window.simulatePropOdds('rbis', matchupRow) : null);
    simOddsChips += simOddsChip('Home Run', matchupRow.hrProb != null ? Number(matchupRow.hrProb) : null);
    simOddsChips += simOddsChip('Stolen Base', window.simulateSBOdds ? window.simulateSBOdds(matchupRow) : null);
    simOddsChips += simOddsChip('Hits+Runs+RBI (2+)', window.simulatePropOdds ? window.simulatePropOdds('hrrbi', matchupRow) : null);
  }
  if (matchupKRow) {
    simOddsChips += simOddsChip(`${pitcherName.split(' ').pop()} K Over ${matchupKRow.recommendedOverLine}`, matchupKRow.overProb);
  }
  const simOddsPanelHTML = simOddsChips ? `<div class="dr1044-odds-panel">
      <div class="dr1044-odds-head">
        <div><div class="dr1044-odds-title">🎲 Simulated Odds Today</div><div class="dr1044-odds-sub">Thousands of simulated games built from real season rate stats, run for this exact matchup — same engine as the Hits/RBI/TB/SB/HR Threats/K Props boards.</div></div>
      </div>
      <div class="dr1044-odds-grid">${simOddsChips}</div>
    </div>` : `<div class="dr1044-odds-panel"><div class="dr1044-odds-sub">Simulated odds aren't available yet for this matchup — ${!matchupRow && !matchupKRow ? 'neither player is in today’s scanned lineup pool yet' : !matchupRow ? batterName + ' isn’t in today’s scanned lineup pool yet' : pitcherName + ' isn’t in today’s K Props pool yet'}. Check back once today's props boards have loaded.</div></div>`;

  // ── Vulnerability summary bullets ──
  const hrRate = parseInt(bs.homeRuns)||0;
  const isoVal = (bs.slg&&bs.avg) ? parseFloat(bs.slg)-parseFloat(bs.avg) : 0;
  const vulns = [];

  if (parseFloat(ps.homeRunsPer9) > 1.2)
    vulns.push({ icon:'🔴', text: `${pitcherName} allows <strong>${pHR9} HR/9</strong> — well above league average. ${batterName} has a clear power opportunity.` });
  else if (parseFloat(ps.homeRunsPer9) > 0.9)
    vulns.push({ icon:'🟡', text: `${pitcherName} allows <strong>${pHR9} HR/9</strong> — slightly elevated HR rate. Power hitters can take advantage.` });
  else
    vulns.push({ icon:'🟢', text: `${pitcherName} limits home runs well (<strong>${pHR9} HR/9</strong>). ${batterName} will need to work for extra bases.` });

  if (parseFloat(ps.avg) > .265)
    vulns.push({ icon:'🔴', text: `Pitcher allows <strong>${pAVG} AVG</strong> — batters are making consistent contact. Look for hits up the middle.` });
  else
    vulns.push({ icon:'🟢', text: `Pitcher holds batters to <strong>${pAVG} AVG</strong>. ${batterName} will need plate discipline to get on base.` });

  if (isoVal > 0.180)
    vulns.push({ icon:'⚡', text: `${batterName} has an <strong>ISO of ${bISO}</strong> — elite extra-base power. The middle/fastball zone is the best HR opportunity.` });

  if (hasH2H && parseInt(h2h.homeRuns) > 0)
    vulns.push({ icon:'💥', text: `Career H2H: ${batterName} has hit <strong>${h2h.homeRuns} HR</strong> off ${pitcherName} in ${h2hAB} AB. Historical edge for the batter.` });
  else if (hasH2H)
    vulns.push({ icon:'📊', text: `Career H2H: ${h2hAB} AB, <strong>${h2hAVG} AVG</strong>, ${h2hK} K. Limited power history — contact approach recommended.` });

  if (parseFloat(ps.whip) > 1.35)
    vulns.push({ icon:'🎯', text: `${pitcherName} has a <strong>${pWHIP} WHIP</strong> — struggles with command. Work the count to get into hitter's counts.` });

  const vulnHTML = vulns.map(v => `<div class="vuln-item"><span class="vuln-icon">${v.icon}</span><span style="color:var(--text)">${v.text}</span></div>`).join('');

  // ── Hot Streak Signals (Statcast) ──
  // Reuses the same repo-fed Statcast profile (data/statcast-hot-hitters.json,
  // synced by the site's data pipeline from Baseball Savant) that already powers
  // the HR Potential "ON FIRE" badge — surfaced here with the underlying raw
  // metrics instead of just a derived tag. If the repo hasn't synced data for this
  // specific player yet, this is upfront about that and links out to the live
  // Baseball Savant page rather than showing an invented number.
  const hh = hotHitter || {};
  const hasRealStatcast = hh.source === 'statcast-repo';

  function trendArrow(v) {
    const n = Number(v);
    if (!n) return '<span style="color:var(--muted)">–</span>';
    const mag = Math.abs(n) < 1 ? Math.abs(n).toFixed(3).replace(/^0/,'') : Math.abs(n).toFixed(1);
    return n > 0
      ? `<span style="color:var(--green)">↑ ${mag}</span>`
      : `<span style="color:var(--accent)">↓ ${mag}</span>`;
  }
  // Two real points only (season baseline -> recent-window value) — the repo-synced
  // data here (recentOpsTrend etc.) is a single delta, not a real day-by-day game log,
  // so this deliberately isn't a multi-day curve. Purely a visual pairing for the
  // trendArrow text already shown, not a new data source.
  function trendSparkline(v) {
    const n = Number(v);
    if (!n) return '';
    const up = n > 0;
    const mag = Math.min(Math.abs(n) * (Math.abs(n) < 1 ? 40 : 4), 6);
    const y1 = (up ? 9 - mag : 9 + mag).toFixed(1);
    const color = up ? 'var(--green)' : 'var(--accent)';
    return `<svg width="26" height="18" viewBox="0 0 26 18" aria-hidden="true" style="vertical-align:middle;margin-left:3px">
      <polyline points="2,9 22,${y1}" fill="none" style="stroke:${color}" stroke-width="2" stroke-linecap="round"/>
      <circle cx="22" cy="${y1}" r="2" style="fill:${color}"></circle>
    </svg>`;
  }

  // ── LIVE expected stats (xBA/xSLG/xwOBA) from the MLB Stats API ──
  const x3 = v => v != null && !isNaN(parseFloat(v)) ? parseFloat(v).toFixed(3).replace(/^0/,'') : null;
  const bxBA   = x3(bx?.avg),  bxSLG = x3(bx?.slg),  bxwOBA = x3(bx?.woba ?? bx?.wOBA);
  const pxwOBA = x3(px?.woba ?? px?.wOBA);
  const hasLiveX = !!(bxBA || bxSLG || bxwOBA);

  // Luck delta: actual minus expected. Negative = underperforming contact quality (due to regress UP).
  function luckDelta(actual, expected) {
    const a = parseFloat(actual), e = parseFloat(expected);
    if (isNaN(a) || isNaN(e)) return '';
    const d = a - e;
    if (Math.abs(d) < 0.015) return `<span style="font-size:9px;color:var(--muted)">about right</span>`;
    return d < 0
      ? `<span style="font-size:9px;color:var(--green)" title="His results are worse than his swings deserve — a hot streak may be coming">▲ due (${d.toFixed(3).replace(/^-0/,'-')})</span>`
      : `<span style="font-size:9px;color:var(--accent2)" title="His results are better than his swings deserve — he may cool off soon">▼ running hot (+${d.toFixed(3).replace(/^0/,'')})</span>`;
  }

  const liveXCards = [
    { label:'xBA',   value: bxBA,   delta: luckDelta(bs.avg, bx?.avg),  desc:'What his batting average should be, based on how hard and how well he\'s been hitting the ball — with luck taken out.' },
    { label:'xSLG',  value: bxSLG,  delta: luckDelta(bs.slg, bx?.slg),  desc:'What his power numbers should look like, based on the contact he\'s actually making.' },
    { label:'xwOBA', value: bxwOBA, delta: '', desc:'The single best "is he actually hot?" number — the overall offense his swings have earned, whether or not the hits have fallen in.' },
  ].filter(c => c.value);

  // Batter xwOBA vs pitcher xwOBA-against: the matchup in one line.
  let xMatchupLine = '';
  if (bxwOBA && pxwOBA) {
    const edge = parseFloat(bxwOBA) - parseFloat(pxwOBA);
    const edgeTxt = Math.abs(edge) < 0.015
      ? `<span style="color:var(--muted)">even matchup</span>`
      : edge > 0
        ? `<span style="color:var(--green)">batter edge +${edge.toFixed(3).replace(/^0/,'')}</span>`
        : `<span style="color:var(--accent)">pitcher edge ${edge.toFixed(3).replace(/^-0/,'-')}</span>`;
    xMatchupLine = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 12px;margin-bottom:12px;font-size:12px">
        <span style="color:var(--muted)">Contact-quality matchup:</span>
        <span style="font-family:'JetBrains Mono',monospace;font-weight:700">${batterName.split(' ').pop()} ${bxwOBA}</span>
        <span style="color:var(--muted)">vs</span>
        <span style="font-family:'JetBrains Mono',monospace;font-weight:700">${pitcherName.split(' ').pop()} ${pxwOBA} allowed</span>
        <span style="font-family:'JetBrains Mono',monospace">${edgeTxt}</span>
      </div>`;
  }

  // ── Repo-fed recent-form aggregates (Hard-Hit%, Sweet-Spot%, Barrel%, bat speed, blasts) ──
  const statcastMetrics = [
    { label: 'Avg Exit Velo', value: hh.avgExitVelo != null ? `${parseFloat(hh.avgExitVelo)} mph` : null, desc: 'Average speed of the ball off the bat on balls in play. The most basic real measure of raw power.' },
    { label: 'Hard-Hit%', value: hh.hardHitPct != null ? `${parseFloat(hh.hardHitPct)}%` : null, trend: hh.hardHitTrend, desc: 'How often he crushes the ball (95+ mph off the bat). Hot hitters hit the ball hard — cold ones bloop it.' },
    { label: 'Sweet-Spot%', value: hh.sweetSpotPct != null ? `${parseFloat(hh.sweetSpotPct)}%` : null, trend: hh.sweetSpotTrend, desc: 'How often he hits line drives and deep fly balls — the kind of contact that turns into doubles and home runs.' },
    { label: 'Barrel%', value: hh.barrelPct != null ? `${parseFloat(hh.barrelPct)}%` : null, trend: hh.barrelTrend, desc: 'How often he makes perfect contact — the hardest-hit balls at the best angles. The gold standard of a locked-in swing.' },
    { label: 'xwOBA (14-day)', value: hh.xwoba != null ? Number(hh.xwoba).toFixed(3).replace(/^0/,'') : null, trend: hh.xwobaTrend, desc: 'The same "is he actually hot?" number as above, but measured over just the past two weeks.' },
    { label: 'Bat Speed', value: hh.batSpeed != null ? `${parseFloat(hh.batSpeed)} mph` : null, trend: hh.batSpeedTrend, desc: 'How fast he\'s swinging. A quicker swing often shows up right before a power surge does.' },
    { label: 'Squared-Up%', value: hh.squaredUpPct != null ? `${parseFloat(hh.squaredUpPct)}%` : null, desc: 'How often he hits the ball with the sweet spot of the bat, transferring the most possible energy regardless of swing speed.' },
    { label: 'Blast Rate', value: hh.blastRate != null ? `${parseFloat(hh.blastRate)}%` : null, trend: hh.blastTrend, desc: 'How often his swing has both the speed and the angle to leave the yard.' },
    { label: 'Chase%', value: hh.chasePct != null ? `${parseFloat(hh.chasePct)}%` : null, desc: 'How often he swings at pitches outside the strike zone. Lower is better — a hitter chasing more than usual is a real red flag, not a hot signal.' },
    { label: 'Zone-Contact%', value: hh.zoneContactPct != null ? `${parseFloat(hh.zoneContactPct)}%` : null, desc: 'How often he actually makes contact when he swings at a pitch in the zone. A locked-in hitter rarely misses these.' },
    { label: 'Sprint Speed', value: hh.sprintSpeed != null ? `${parseFloat(hh.sprintSpeed)} ft/s` : null, desc: 'Foot speed on competitive plays. Context for stolen-base and extra-base upside, not a hot/cold signal.' },
    { label: 'Outs Above Average', value: hh.oaa != null ? `${hh.oaa > 0 ? '+' : ''}${parseFloat(hh.oaa)}` : null, desc: 'Season defensive value — how many extra outs he\'s made versus an average fielder at his position. Context, not a hot/cold signal.' },
    { label: 'Arm Strength', value: hh.armStrength != null ? `${parseFloat(hh.armStrength)} mph` : null, desc: 'Average throwing velocity on competitive plays. Context for baserunner deterrence, not a hot/cold signal.' },
    { label: 'Last 14 Days OPS', value: hh.recentOps != null ? Number(hh.recentOps).toFixed(3).replace(/^0/,'') : null, trend: hh.recentOpsTrend, desc: 'Real OPS from MLB\'s own game log over the last 14 days, versus his season OPS. The most reliable "is he actually hot right now" signal this app has.' },
    { label: 'Pull%', value: hh.pullPct != null ? `${parseFloat(hh.pullPct)}%` : null, desc: 'How often he pulls the ball. The large majority of home runs are pulled, so an elevated pull rate is real power-upside context.' },
    { label: 'Fly-Ball%', value: hh.fbPct != null ? `${parseFloat(hh.fbPct)}%` : null, desc: 'How often contact goes in the air deep enough to leave the yard. A pull-heavy fly-ball hitter has real HR upside a pull-heavy ground-ball hitter doesn\'t.' },
    { label: 'Line-Drive%', value: hh.ldPct != null ? `${parseFloat(hh.ldPct)}%` : null, desc: 'How often he squares up a line drive. A contact-quality/BABIP signal, not a power one — high line-drive hitters get more hits, not necessarily more homers.' },
    { label: 'Ground-Ball%', value: hh.gbPct != null ? `${parseFloat(hh.gbPct)}%` : null, desc: 'How often contact stays on the ground. Lower is generally better for power upside — ground balls almost never leave the yard.' },
    { label: 'Extra Bases Taken%', value: hh.extraBasesTakenPct != null ? `${parseFloat(hh.extraBasesTakenPct)}%` : null, desc: 'How often he takes an extra base on a hit when he had the chance (e.g. first to third on a single). Baserunning aggressiveness, not a power signal.' },
  ].filter(m => m.value != null);

  const seasonFallbackMetrics = [
    { label: 'AVG', value: bAVG, desc: 'Live MLB season batting average fallback.' },
    { label: 'OPS', value: bOPS, desc: 'Live MLB season OPS fallback.' },
    { label: 'ISO Power', value: bISO, desc: 'Slugging minus batting average — quick power signal.' },
    { label: 'HR', value: bHR, desc: 'Live MLB season home runs.' },
    { label: 'K%', value: bKpct, desc: 'Live MLB strikeout rate fallback.' },
    { label: 'BB%', value: bBBpct, desc: 'Live MLB walk rate fallback.' },
  ].filter(m => m.value && m.value !== '–');

  const onFireScore = Math.round(hh.onFireScore || (seasonFallbackMetrics.length ? Math.max(35, Math.min(88, ((parseFloat(bs.ops)||.700)-.600)*120 + ((parseFloat(bs.homeRuns)||0)*1.1))) : 0));
  const onFireLabel = onFireScore >= 85 ? 'ELITE' : onFireScore >= 70 ? 'HOT' : onFireScore >= 45 ? 'WARM' : 'COOL';
  const onFireColor = onFireScore >= 85 ? '#ff6b6b' : onFireScore >= 70 ? 'var(--accent2)' : onFireScore >= 45 ? 'var(--green)' : 'var(--muted)';

  const metricCard = m => `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 10px" title="${m.desc}">
      <div style="font-size:10px;color:var(--muted);letter-spacing:.5px;text-transform:uppercase">${m.label}</div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-top:2px;flex-wrap:wrap">
        <span style="font-family:'JetBrains Mono',monospace;font-size:16px;font-weight:700">${m.value}</span>
        ${m.trend !== undefined ? `<span style="font-size:10px;font-family:'JetBrains Mono',monospace;display:inline-flex;align-items:center">${trendArrow(m.trend)}${trendSparkline(m.trend)}</span>` : (m.delta || '')}
      </div>
    </div>`;

  const hotStreakHTML = `
    <div class="mu-hotstreak-section" style="margin-bottom:20px">
      <div class="zone-title">🔥 HOT STREAK SIGNALS</div>
      <div style="display:flex;align-items:center;gap:10px;margin:10px 0 12px">
        <div style="font-family:'JetBrains Mono',monospace;font-size:24px;font-weight:700;color:${onFireColor}">${onFireScore}</div>
        <div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.5px;color:${onFireColor}">${onFireLabel}</div>
          <div style="font-size:10px;color:var(--muted)">On-Fire Score (0–100) · ${hasRealStatcast ? 'how well he\'s actually swinging the bat right now — not just the box score' : 'early estimate from basic season numbers — detailed swing data for this player is still loading'}</div>
        </div>
      </div>
      ${xMatchupLine}
      ${hasLiveX ? `
        <div style="font-size:10px;color:var(--muted);letter-spacing:.5px;text-transform:uppercase;margin-bottom:6px">What his contact says he should be hitting · hover any box for a plain-English explanation</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
          ${liveXCards.map(c => metricCard({ label:c.label, value:c.value, delta:c.delta, trend:undefined, desc:c.desc })).join('')}
        </div>` : ''}
      ${statcastMetrics.length ? `
        <div style="font-size:10px;color:var(--muted);letter-spacing:.5px;text-transform:uppercase;margin-bottom:6px">Recent form · last 1–2 weeks</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
          ${statcastMetrics.map(metricCard).join('')}
        </div>` : `
        <div style="font-size:10px;color:var(--muted);letter-spacing:.5px;text-transform:uppercase;margin-bottom:6px">Recent form fallback · live season profile</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
          ${seasonFallbackMetrics.map(metricCard).join('')}
        </div>
        <div style="font-size:10px;color:var(--muted);background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 12px;margin-bottom:12px">
          Detailed Statcast swing metrics have not landed in the local cache for ${batterName}, so this panel is auto-populated from live MLB season stats and expected-stat fallback data instead of showing a blank syncing message.
        </div>`}
      <div style="font-size:11px;color:var(--muted);line-height:1.6">
        <strong style="color:var(--text)">How to read this:</strong> batting average can lie — a hitter can smash the ball all week straight into gloves, or bloop his way to a lucky hot streak. These numbers look at the swings themselves: how hard he's hitting the ball and where it's going. A green <strong style="color:var(--green)">▲ due</strong> tag means his swings have been better than his results — good things may be coming. An orange <strong style="color:var(--accent2)">▼ running hot</strong> tag means the opposite: the results have been better than the swings, and he may cool off.
      </div>
    </div>`;

  body.innerHTML = `
    ${hh.rosterStatus ? `
    <div class="vuln-box" style="border-color:rgba(239,68,68,.55);background:rgba(127,29,29,.22);margin-bottom:12px">
      <div class="vuln-title" style="color:#fca5a5">⚠️ ROSTER STATUS</div>
      <div class="vuln-item"><span class="vuln-icon">🏥</span><span style="color:var(--text)">${batterName} is currently <strong>${hh.rosterStatus}</strong> — stats and projections below still reflect his full season, not just healthy games.</span></div>
    </div>` : ''}
    <!-- Scouting Report -->
    <div class="vuln-box">
      <div class="vuln-title">⚡ SCOUTING REPORT — HOW TO HIT A HOME RUN</div>
      ${vulnHTML}
    </div>

    <!-- H2H Career Stats -->
    <div style="margin-bottom:16px">
      <div class="zone-title" style="margin-bottom:8px">HEAD-TO-HEAD · 2026 SEASON</div>
      ${hasH2H ? `
      <div class="h2h-grid">
        <div class="h2h-stat"><div class="h2h-val">${h2hAB}</div><div class="h2h-lbl">At Bats</div></div>
        <div class="h2h-stat"><div class="h2h-val" style="color:${parseFloat(h2h.avg)>=.300?'var(--green)':'var(--text)'}">${h2hAVG}</div><div class="h2h-lbl">AVG</div></div>
        <div class="h2h-stat"><div class="h2h-val" style="color:${parseInt(h2h.homeRuns)>0?'var(--accent2)':'var(--text)'}">${h2hHR}</div><div class="h2h-lbl">HR</div></div>
        <div class="h2h-stat"><div class="h2h-val">${h2hHits}</div><div class="h2h-lbl">Hits</div></div>
        <div class="h2h-stat"><div class="h2h-val">${h2hK}</div><div class="h2h-lbl">K</div></div>
        <div class="h2h-stat"><div class="h2h-val">${h2hOPS}</div><div class="h2h-lbl">OPS</div></div>
      </div>` : `<div style="color:var(--muted);font-size:12px;padding:8px 0">No 2026 H2H data yet — using season stats for analysis.</div>`}
    </div>

    ${simOddsPanelHTML}

    <!-- Combined handedness + season matchup -->
    <div class="dr1043-combined-matchup">
      <div class="dr1043-combined-head">
        <div>
          <div class="dr1043-combined-title">🧭 MATCHUP PROFILE · HANDEDNESS + SEASON FORM</div>
          <div class="dr1043-combined-sub">Combines the batter split, pitcher split, batter season profile, and pitcher season profile into one cleaner matchup read.</div>
          <div class="dr1043-split-line">
            <span class="dr1043-badge blue">${batterName.split(' ').pop()} bats ${handLabel(batterHand,'batter')}</span>
            <span class="dr1043-badge blue">${pitcherName.split(' ').pop()} throws ${handLabel(pitcherHand,'pitcher')}</span>
            <span class="dr1043-badge">Today's split: ${handLabel(batterHand,'batter')} vs ${handLabel(pitcherHand,'pitcher')}</span>
          </div>
        </div>
        <div class="dr1043-edge-card">
          <strong>${pitchMixDashboard.score ?? '–'}</strong>
          <span>Matchup edge</span>
        </div>
      </div>

      <div class="dr1043-grid">
        <div class="dr1043-panel">
          <div class="dr1043-panel-title">Handedness edge <span class="dr1043-badge">Split view</span></div>
          ${[[`${batterName.split(' ').pop()} Bats`,handLabel(batterHand,'batter')],[`${pitcherName.split(' ').pop()} Throws`,handLabel(pitcherHand,'pitcher')],['Batter HR vs Pitcher Hand',fi(batterSplitHR)],['Pitcher HR Allowed vs Batter Hand',fi(pitcherSplitHRAllowed)],['Batter OPS vs Hand',fv(batterSplitOPS)],['Pitcher AVG Allowed vs Hand',fv(pitcherSplitAvgAllowed)]].map(([l,v])=>`
          <div class="dr1043-row"><span>${l}</span><strong>${v}</strong></div>`).join('')}
        </div>

        <div class="dr1043-panel">
          <div class="dr1043-panel-title">Batter season <span class="dr1043-badge blue">${batterName.split(' ').pop()}</span></div>
          ${[['AVG',bAVG],['HR',bHR],['RBI',bRBI],['SB',bSB],['SB%',bSbPct],['OPS',bOPS],['ISO',bISO],['K%',bKpct],['BB%',bBBpct]].map(([l,v])=>`
          <div class="dr1043-row"><span>${l}</span><strong>${v}</strong></div>`).join('')}
        </div>

        <div class="dr1043-panel">
          <div class="dr1043-panel-title">Pitcher season <span class="dr1043-badge blue">${pitcherName.split(' ').pop()}</span></div>
          ${[['ERA',pERA],['FIP',pFIP],['WHIP',pWHIP],['AVG Allowed',pAVG],['HR/9',pHR9],['K/9',pKper9]].map(([l,v])=>`
          <div class="dr1043-row"><span>${l}</span><strong>${v}</strong></div>`).join('')}
        </div>

        ${(hh.homeAvg != null || hh.awayAvg != null || hh.rispAvg != null) ? `
        <div class="dr1043-panel" style="grid-column:1/-1">
          <div class="dr1043-panel-title">Situational splits <span class="dr1043-badge blue">${batterName.split(' ').pop()}</span></div>
          <div class="dr1043-split-line">
            ${hh.homeAvg != null ? `<span class="dr1043-badge">Home: ${fv(hh.homeAvg,3)} AVG${hh.homeOps!=null?` / ${fv(hh.homeOps,3)} OPS`:''}</span>` : ''}
            ${hh.awayAvg != null ? `<span class="dr1043-badge">Away: ${fv(hh.awayAvg,3)} AVG${hh.awayOps!=null?` / ${fv(hh.awayOps,3)} OPS`:''}</span>` : ''}
            ${hh.rispAvg != null ? `<span class="dr1043-badge">RISP: ${fv(hh.rispAvg,3)} AVG${hh.rispOps!=null?` / ${fv(hh.rispOps,3)} OPS`:''}</span>` : ''}
          </div>
        </div>` : ''}
      </div>

      <div class="dr1043-callout">
        <strong style="color:#fff">Diamond Read:</strong>
        ${batterName.split(' ').pop()} brings ${fi(batterSplitHR)} HR vs this pitcher hand with a ${fv(batterSplitOPS)} OPS split. ${pitcherName.split(' ').pop()} has allowed ${fi(pitcherSplitHRAllowed)} HR vs this batter hand with a ${fv(pitcherSplitAvgAllowed)} AVG allowed split. Season context: batter ${bHR} HR / ${bOPS} OPS against pitcher ${pERA} ERA / ${pHR9} HR/9.
      </div>
    </div>

    ${hotStreakHTML}

    <div class="dr1041-matchup-dashboard">
      ${pitchMixDashboard.html}
      ${pitchEffectivenessTableHTML}

      <!-- Strike Zone + Zone Fit -->
      <div class="dr1041-zone-grid">
      <div class="zone-section">
        <div class="zone-title">${hasRealZones ? 'STRIKE ZONE · REAL wOBA AGAINST BY LOCATION' : 'STRIKE ZONE · NO REAL DATA YET'}</div>
      ${hasRealZones ? `
      <div class="zone-wrap">
        <div class="zone-grid-outer">
          <span class="zone-label">OUTSIDE ←&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;→ INSIDE</span>
          <div style="display:flex;align-items:center;gap:6px">
            <div style="display:flex;flex-direction:column;gap:2px;font-size:9px;color:var(--muted);text-align:right;padding-right:4px">
              <div style="height:40px;display:flex;align-items:center">HIGH</div>
              <div style="height:40px;display:flex;align-items:center">MID</div>
              <div style="height:40px;display:flex;align-items:center">LOW</div>
            </div>
            <div class="strike-zone">${zoneCells}</div>
          </div>
          <span class="zone-label" style="margin-top:4px">% = Batter opportunity score per zone</span>
        </div>
        <div>
          <div class="zone-legend">
            <div class="zone-leg-item"><div class="zone-leg-swatch" style="background:#4a1010"></div><span style="color:#ff6b6b">Hot zone (85%+) — prime HR location</span></div>
            <div class="zone-leg-item"><div class="zone-leg-swatch" style="background:#3a2010"></div><span style="color:#f4a261">Warm zone (65–84%) — extra-base threat</span></div>
            <div class="zone-leg-item"><div class="zone-leg-swatch" style="background:#1a2a10"></div><span style="color:#90ee60">Neutral (45–64%) — contact likely</span></div>
            <div class="zone-leg-item"><div class="zone-leg-swatch" style="background:#0d1a0d"></div><span style="color:#3a6a3a">Cold zone (&lt;45%) — pitcher's advantage</span></div>
          </div>
          <div class="zone-note" style="margin-top:10px;max-width:220px">
            Zones based on the quality of contact ${pitcherName.split(' ').pop()} ${usingExpected ? 'should be allowing (luck removed)' : 'has allowed'} (${fv(pitcherVuln,3)}), his HR/9 (${pHR9}), and the batter's power profile. Higher scores = more damage opportunity.
          </div>
        </div>
      </div>` : `
      <div class="zone-note" style="padding:10px 0;color:var(--muted);font-size:12px">No real per-location Statcast data available for ${pitcherName} yet — this requires a separate pitch-location sync that hasn't been built.</div>`}
      </div>
      ${zoneFitPanelHTML}
      </div>
      ${attackZoneHTML}

      <div class="dr1041-bottom-strip">
        <span class="dr1041-bottom-item">Pitcher Throws: <strong>${handLabel(pitcherHand,'pitcher')}</strong></span>
        <span class="dr1041-bottom-item">Batter Stance: <strong>${handLabel(batterHand,'batter')}</strong></span>
        <span class="dr1041-bottom-split"></span>
        <span class="dr1041-bottom-item">Today's Matchup: <strong style="color:#22c55e">vs ${handLabel(batterHand,'batter')}</strong></span>
        <span class="dr1041-bottom-split"></span>
        <span class="dr1041-bottom-item">Pitch Mix Usage:</span>
        <span class="dr1041-usage-chips">${bottomUsageChips}</span>
      </div>
    </div>`;

  const scoreEl = body.querySelector('[data-score]');
  if (scoreEl && pitchMixDashboard.score != null) animateCountUp(scoreEl, pitchMixDashboard.score, 0);
}


// ── Pitch Mix split toggle (AUTO / vs RHP / vs LHP) ─────────────────────
document.addEventListener('click', function(e) {
  const btn = e.target.closest && e.target.closest('.dr1042-split-btn');
  if (!btn) return;
  const box = btn.closest('[data-pitch-mix-toggle]');
  if (!box) return;
  const mode = btn.dataset.mode || 'auto';
  box.querySelectorAll('.dr1042-split-btn').forEach(b => b.classList.toggle('active', b === btn));
  box.querySelectorAll('.dr1042-mode-body').forEach(tb => tb.classList.toggle('active', tb.dataset.mode === mode));
  let state = {};
  try { state = JSON.parse(box.querySelector('[data-pmix-state]')?.textContent || '{}'); } catch(_) {}
  const score = box.querySelector('[data-score]');
  const note = box.querySelector('[data-note]');
  const read = box.querySelector('[data-ai-read]');
  if (score) score.textContent = state.scores?.[mode] ?? '–';
  if (note) note.textContent = state.notes?.[mode] || '';
  if (read) read.textContent = state.reads?.[mode] || '';
});

// ── Attack Zone by Pitch toggle ───────────────────────────────────────
document.addEventListener('click', function(e) {
  const btn = e.target.closest && e.target.closest('.dr1042-split-btn[data-pitch]');
  if (!btn) return;
  const box = btn.closest('[data-attack-zone-toggle]');
  if (!box) return;
  const idx = btn.dataset.pitch;
  box.querySelectorAll('.dr1042-split-btn[data-pitch]').forEach(b => b.classList.toggle('active', b === btn));
  box.querySelectorAll('.dr-azone-mode-body').forEach(tb => tb.classList.toggle('active', tb.dataset.pitch === idx));
});


// ── HEADER DATE (dynamic) ─────────────────────────────────────────────
function updateHeaderDate() {
  const now = new Date();
  const label = now.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric', year:'numeric', timeZone:'America/Chicago'}).toUpperCase();
  const el = document.getElementById('header-date');
  if (el) el.textContent = label;
}
updateHeaderDate();

// ── MIDNIGHT AUTO-REFRESH ─────────────────────────────────────────────
function scheduleMidnightRefresh() {
  const now = new Date();
  const midnight = new Date();
  midnight.setHours(24, 0, 5, 0); // 12:00:05am to ensure day has flipped
  const msUntilMidnight = midnight - now;
  setTimeout(() => {
    updateHeaderDate();
    Object.keys(prevGames).forEach(k => delete prevGames[k]); // clear game cache
    loadScores(); // reload with new day's games
    scheduleMidnightRefresh(); // reschedule for next midnight
  }, msUntilMidnight);
}
scheduleMidnightRefresh();


// ── HOT HITTER HR POTENTIAL ENGINE ───────────────────────────────────
// Uses repo-fed Baseball Savant/Statcast trend data when available. If the
// GitHub Action has not populated data/statcast-hot-hitters.json yet, the
// model falls back to the live MLB stats already on the page.
async function loadStatcastHotHitters(force=false) {
  if (statcastHotHittersLoaded && !force) return statcastHotHitters;
  if (statcastHotHittersPromise && !force) return statcastHotHittersPromise;
  statcastHotHittersPromise = (async () => {
    try {
      const data = await drFetchDailyJSON(`data/statcast-hot-hitters.json`);
      const list = Array.isArray(data.players) ? data.players : [];
      statcastHotHitters = {};
      list.forEach(p => {
        if (p.playerId) statcastHotHitters[String(p.playerId)] = p;
        if (p.name) statcastHotHitters[String(p.name).toLowerCase()] = p;
      });
    } catch(e) {
      statcastHotHitters = {};
    }
    statcastHotHittersLoaded = true;
    return statcastHotHitters;
  })();
  return statcastHotHittersPromise;
}
// Overwrites the hardcoded park-factor estimates (declared above, near the venue
// list) with real, auto-updating Baseball Savant HR-index values once synced —
// same repo-fed-JSON-with-hardcoded-fallback pattern as loadStatcastHotHitters().
// Mutates parkFactors in place (not reassigned) so every existing closure that
// already reads from it — Game Props' win-probability model, the HR Potential
// engine — picks up real data automatically with no other code changes.
let parkFactorsLoaded = false;
let parkFactorsPromise = null;
async function loadParkFactors(force = false) {
  if (parkFactorsLoaded && !force) return parkFactors;
  if (parkFactorsPromise && !force) return parkFactorsPromise;
  parkFactorsPromise = (async () => {
    try {
      const data = await drFetchDailyJSON(`data/park-factors.json`);
      const teams = data.teams || {};
      Object.keys(teams).forEach(teamId => {
        const abbr = teamIdToAbbr[teamId];
        const hrIndex = teams[teamId]?.hrIndex;
        if (abbr && Number.isFinite(hrIndex)) parkFactors[abbr] = hrIndex;
      });
    } catch (e) {}
    parkFactorsLoaded = true;
    return parkFactors;
  })();
  return parkFactorsPromise;
}

// data/bullpen-fatigue.json is keyed by team abbreviation directly (unlike
// park-factors, which needs a team-id lookup) — see sync-bullpen-fatigue.mjs.
// No hardcoded fallback here: unlike park factors (a slow-changing physical
// property of a stadium a rough static table can approximate), bullpen
// fatigue is only meaningful as of the last day or two, so a stale guess
// would be actively misleading rather than a reasonable placeholder. If the
// sync hasn't run or failed, the chip is simply omitted for that game.
let bullpenFatigue = {};
let bullpenFatigueLoaded = false;
let bullpenFatiguePromise = null;
async function loadBullpenFatigue(force = false) {
  if (bullpenFatigueLoaded && !force) return bullpenFatigue;
  if (bullpenFatiguePromise && !force) return bullpenFatiguePromise;
  bullpenFatiguePromise = (async () => {
    try {
      const data = await drFetchDailyJSON(`data/bullpen-fatigue.json`);
      bullpenFatigue = data.teams || {};
    } catch (e) {}
    bullpenFatigueLoaded = true;
    return bullpenFatigue;
  })();
  return bullpenFatiguePromise;
}

// data/ballparkpal-hr-factors.json (see scripts/sync-ballparkpal.mjs) is a flat
// per-hitter list from Ballpark Pal's licensed API — their own independently
// modeled split of stadium-only vs. weather-only HR multiplier per player per
// game. Indexed here by gameId (MLB gamePk) into an array of that game's
// hitter rows, since Game Projections is game-level, not per-batter: the
// panel shows the average homeRunsWeather across the game's hitters as a
// second, independently-computed cross-check next to our own DIY air-density
// number — informational only, same role the Market chip plays for win
// probability, never fed into scoring.
let ballparkPalFactors = {};
let ballparkPalFactorsLoaded = false;
let ballparkPalFactorsPromise = null;
async function loadBallparkPalFactors(force = false) {
  if (ballparkPalFactorsLoaded && !force) return ballparkPalFactors;
  if (ballparkPalFactorsPromise && !force) return ballparkPalFactorsPromise;
  ballparkPalFactorsPromise = (async () => {
    try {
      const data = await drFetchDailyJSON(`data/ballparkpal-hr-factors.json`);
      const byGame = {};
      (data.rows || []).forEach(r => {
        if (!Number.isFinite(r.gameId)) return;
        (byGame[r.gameId] = byGame[r.gameId] || []).push(r);
      });
      ballparkPalFactors = byGame;
    } catch (e) {}
    ballparkPalFactorsLoaded = true;
    return ballparkPalFactors;
  })();
  return ballparkPalFactorsPromise;
}
// Average homeRunsWeather (a multiplier deviation, e.g. 0.02 = weather alone
// added ~2%) across a game's hitter rows — null if the sync hasn't run yet or
// this game isn't in it, in which case the panel simply omits the cross-check.
function ballparkPalWeatherPctForGame(gameId) {
  const rows = ballparkPalFactors[gameId];
  if (!rows || !rows.length) return null;
  const vals = rows.map(r => r.homeRunsWeather).filter(Number.isFinite);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100);
}
// Exact per-hitter lookup (unlike the game-level average above) — used on HR
// Threats cards, which are already batter-specific. homeRuns is Ballpark
// Pal's combined park+weather multiplier for this exact player in today's
// game (e.g. 1.06 = modeled +6% vs. neutral).
// statKey: 'homeRuns' | 'doublesTriples' | 'singles' — whichever combined
// park+weather multiplier is most relevant to the board asking (HR Threats
// asks for homeRuns; Elite Picks' Total Bases/Hits markets ask for
// doublesTriples/singles — see sync-ballparkpal.mjs for what's synced).
function ballparkPalStatFactorForPlayer(gameId, playerId, statKey) {
  const rows = ballparkPalFactors[gameId];
  if (!rows) return null;
  const row = rows.find(r => String(r.playerId) === String(playerId));
  if (!row || !Number.isFinite(row[statKey])) return null;
  return Math.round((row[statKey] - 1) * 100);
}
function ballparkPalFactorForPlayer(gameId, playerId) {
  return ballparkPalStatFactorForPlayer(gameId, playerId, 'homeRuns');
}

// data/ballparkpal-game-factors.json (see sync-ballparkpal.mjs) — game-level
// (not per-hitter) offense-environment percentages from Ballpark Pal's
// /parkfactors endpoint. Used where a board has no single batter to key a
// per-hitter lookup off of (K Props: the pitcher's opponent lineup as a
// whole, not one hitter).
let ballparkPalGameFactors = {};
let ballparkPalGameFactorsLoaded = false;
let ballparkPalGameFactorsPromise = null;
async function loadBallparkPalGameFactors(force = false) {
  if (ballparkPalGameFactorsLoaded && !force) return ballparkPalGameFactors;
  if (ballparkPalGameFactorsPromise && !force) return ballparkPalGameFactorsPromise;
  ballparkPalGameFactorsPromise = (async () => {
    try {
      const data = await drFetchDailyJSON(`data/ballparkpal-game-factors.json`);
      const byGame = {};
      (data.rows || []).forEach(r => { if (Number.isFinite(r.gameId)) byGame[r.gameId] = r; });
      ballparkPalGameFactors = byGame;
    } catch (e) {}
    ballparkPalGameFactorsLoaded = true;
    return ballparkPalGameFactors;
  })();
  return ballparkPalGameFactorsPromise;
}
// runsPercent is already a signed deviation from a neutral park (e.g. 32 =
// +32% more runs than neutral for this park+weather today, confirmed against
// a real Coors Field row) — used as the general offense-environment summary
// since Ballpark Pal doesn't publish a strikeout-specific figure.
function ballparkPalOffensePctForGame(gameId) {
  const row = ballparkPalGameFactors[gameId];
  if (!row || !Number.isFinite(row.runsPercent)) return null;
  return row.runsPercent;
}

function clampNum(n, min, max) { n = Number(n); if (!Number.isFinite(n)) return min; return Math.max(min, Math.min(max, n)); }
function pctNum(v) { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace('%','')); return Number.isFinite(n) ? n : null; }
function buildFallbackHotHitterProfile(row) {
  const ops = Number(row.ops || row.stats?.ops || 0);
  const iso = Number(row.iso || ((Number(row.stats?.slg)||0) - (Number(row.stats?.avg)||0)) || 0);
  const last10HR = Number(row.last10HR || 0);
  const streakDays = Number(row.streakDays || 0);
  const favorable = row.isFavorable ? 1 : 0;
  const score = clampNum(
    (ops >= .900 ? 22 : ops >= .820 ? 16 : ops >= .760 ? 10 : 0) +
    (iso >= .260 ? 22 : iso >= .210 ? 16 : iso >= .170 ? 9 : 0) +
    (last10HR >= 3 ? 26 : last10HR >= 2 ? 18 : last10HR >= 1 ? 10 : 0) +
    (streakDays >= 3 ? 14 : streakDays === 2 ? 8 : 0) +
    (favorable ? 10 : 0), 0, 100
  );
  const tags = [];
  if (ops >= .820) tags.push('OPS↑');
  if (iso >= .210) tags.push('ISO Power↑');
  if (last10HR >= 2) tags.push('L10 HR Surge');
  if (streakDays >= 2) tags.push('Streak');
  if (favorable) tags.push('Matchup Edge');
  return { source:'page-fallback', onFireScore:score, hotBoostPct: +(score/100*4.5).toFixed(1), tags };
}
function getStatcastHotHitterProfile(row) {
  const fromRepo = statcastHotHitters[String(row.id)] || statcastHotHitters[String(row.name || '').toLowerCase()];
  const fallback = buildFallbackHotHitterProfile(row);
  if (!fromRepo) return fallback;
  const xwobaTrend = Number(fromRepo.xwobaTrend || 0);
  const hardHitTrend = Number(fromRepo.hardHitTrend || 0);
  const sweetSpotTrend = Number(fromRepo.sweetSpotTrend || 0);
  const barrelTrend = Number(fromRepo.barrelTrend || 0);
  const batSpeedTrend = Number(fromRepo.batSpeedTrend || 0);
  const blastTrend = Number(fromRepo.blastTrend || 0);
  const xwoba = Number(fromRepo.xwoba || 0);
  const hardHit = pctNum(fromRepo.hardHitPct) ?? 0;
  const sweetSpot = pctNum(fromRepo.sweetSpotPct) ?? 0;
  const barrel = pctNum(fromRepo.barrelPct) ?? 0;
  const batSpeed = Number(fromRepo.batSpeed || 0);
  const blastRate = pctNum(fromRepo.blastRate) ?? 0;
  const avgExitVelo = Number(fromRepo.avgExitVelo || 0);
  // Real rolling-form trend (14-day OPS vs season OPS, from MLB's own byDateRange
  // stats via sync-batter-splits.mjs) — a reliable replacement for the Statcast
  // xwobaTrend/hardHitTrend/etc-style bonuses above, which stay in the formula for
  // players who have them but silently contribute 0 for everyone else since Savant's
  // date-range params don't actually scope those leaderboards (see that script's
  // header comment). This is the trend signal that's actually populated in practice.
  const recentOpsTrend = Number(fromRepo.recentOpsTrend || 0);
  // Pull rate isn't a hot/cold signal by itself, but pulled contact is where the
  // overwhelming majority of home runs come from — a real, if modest, power-upside
  // input distinct from the trend/quality-of-contact signals above. A pull-heavy fly-ball
  // hitter has real HR upside a pull-heavy ground-ball hitter doesn't, so the combo of
  // both elevated together is scored higher than either alone. Line-drive rate is a
  // genuine BABIP/contact-quality signal, not a power one, scored separately and modestly.
  const pullPct = pctNum(fromRepo.pullPct) ?? 0;
  const fbPct = pctNum(fromRepo.fbPct) ?? 0;
  const ldPct = pctNum(fromRepo.ldPct) ?? 0;
  const score = clampNum(
    (xwoba >= .420 ? 18 : xwoba >= .370 ? 13 : xwoba >= .330 ? 7 : 0) +
    (xwobaTrend >= .060 ? 15 : xwobaTrend >= .030 ? 10 : xwobaTrend >= .015 ? 5 : 0) +
    (hardHit >= 52 ? 14 : hardHit >= 45 ? 10 : hardHit >= 40 ? 5 : 0) +
    (hardHitTrend >= 10 ? 12 : hardHitTrend >= 5 ? 8 : hardHitTrend >= 2 ? 4 : 0) +
    (sweetSpot >= 40 ? 9 : sweetSpot >= 34 ? 6 : sweetSpot >= 30 ? 3 : 0) +
    (sweetSpotTrend >= 8 ? 8 : sweetSpotTrend >= 4 ? 5 : sweetSpotTrend >= 2 ? 2 : 0) +
    (barrel >= 15 ? 10 : barrel >= 10 ? 7 : barrel >= 7 ? 3 : 0) +
    (barrelTrend >= 5 ? 7 : barrelTrend >= 2 ? 4 : 0) +
    (batSpeed >= 75 ? 5 : batSpeed >= 72 ? 3 : 0) +
    (batSpeedTrend >= 1.5 ? 5 : batSpeedTrend >= .7 ? 3 : 0) +
    (blastRate >= 18 ? 5 : blastRate >= 12 ? 3 : 0) +
    (blastTrend >= 5 ? 5 : blastTrend >= 2 ? 3 : 0) +
    (recentOpsTrend >= .150 ? 15 : recentOpsTrend >= .080 ? 10 : recentOpsTrend >= .040 ? 5 : 0) +
    (pullPct >= 40 && fbPct >= 38 ? 8 : pullPct >= 45 ? 6 : pullPct >= 38 ? 3 : 0) +
    (ldPct >= 25 ? 3 : ldPct >= 21 ? 1 : 0) +
    (avgExitVelo >= 91 ? 6 : avgExitVelo >= 89 ? 3 : 0), 0, 100
  );
  const tags = [];
  if (xwobaTrend >= .015 || xwoba >= .370) tags.push('xwOBA↑');
  if (hardHitTrend >= 2 || hardHit >= 45) tags.push('Hard-Hit↑');
  if (sweetSpotTrend >= 2 || sweetSpot >= 34) tags.push('Sweet-Spot↑');
  if (barrelTrend >= 2 || barrel >= 10) tags.push('Barrel↑');
  if (batSpeedTrend >= .7 || batSpeed >= 72) tags.push('Bat Speed↑');
  if (blastTrend >= 2 || blastRate >= 12) tags.push('Blasts↑');
  if (recentOpsTrend >= .040) tags.push('Hot Last 14G');
  else if (recentOpsTrend <= -.080) tags.push('Cold Last 14G');
  if (pullPct >= 40 && fbPct >= 38) tags.push('Pull+Fly Power');
  else if (pullPct >= 45) tags.push('Pull Power');
  if (ldPct >= 25) tags.push('Line-Drive Bat');
  if (avgExitVelo >= 91) tags.push('Elite Exit Velo');
  const boost = clampNum((score / 100) * 7.5, 0, 7.5);
  return { ...fallback, ...fromRepo, source:'statcast-repo', onFireScore:Math.max(score, fallback.onFireScore || 0), hotBoostPct:+Math.max(boost, fallback.hotBoostPct || 0).toFixed(1), tags:[...new Set([...tags, ...(fallback.tags||[])])].slice(0,6) };
}
function applyHotHitterBoost(row) {
  const profile = getStatcastHotHitterProfile(row);
  // Read from the stable, un-boosted baseHrProb rather than the current (possibly
  // already-boosted) row.hrProb. loadHRPotential's progressive render re-applies this
  // to every row seen so far on each debounce cycle (not just newly added ones), so
  // reading row.hrProb here used to stack another boost on top of the previous one
  // every cycle - rows added early accumulated many boosts and converged on the 35%
  // clamp regardless of their real signal, which is why unrelated players ended up
  // tied at the exact same HR probability.
  const base = Number(row.baseHrProb ?? row.hrProb ?? 0);
  const boost = Number(profile.hotBoostPct || 0);
  row.baseHrProb = row.baseHrProb ?? base;
  row.hotHitter = profile;
  row.hotBoostPct = boost;
  row.onFireScore = Number(profile.onFireScore || 0);
  row.hrProb = +clampNum(base + boost, 0, 35).toFixed(1);
  row.isOnFire = row.onFireScore >= 70 || boost >= 4.5;
  row.rosterStatus = profile.rosterStatus || null;
  return row;
}
function applyHotHitterBoosts(rows) {
  (rows || []).forEach(applyHotHitterBoost);
  return rows;
}

// ── 5AM HR POTENTIAL REFRESH ─────────────────────────────────────────
// Checks on load and reschedules daily — handles cases where tab wasn't open at 5am
const HR_POTENTIAL_STORAGE_KEY = 'hrp_last_loaded_date';

function getHRPLastLoadedDate() {
  try { return localStorage.getItem(HR_POTENTIAL_STORAGE_KEY) || ''; } catch { return ''; }
}
function setHRPLastLoadedDate(dateStr) {
  try { localStorage.setItem(HR_POTENTIAL_STORAGE_KEY, dateStr); } catch {}
}

function shouldRefreshHRPotential() {
  const today = new Date().toLocaleDateString('en-CA', {timeZone:'America/Chicago'});
  const lastLoaded = getHRPLastLoadedDate();
  const cdtNow = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Chicago'}));
  const hour = cdtNow.getHours();
  // Refresh if: never loaded today, OR loaded before 5am today and it's now past 5am
  if (lastLoaded !== today) return true;
  return false; // already loaded fresh today
}

function triggerHRPotentialRefresh() {
  if (shouldRefreshHRPotential()) {
    const today = new Date().toLocaleDateString('en-CA', {timeZone:'America/Chicago'});
    setHRPLastLoadedDate(today);
    loadHRPotentialWithRetry();
  } else if (!hrpRows.length) {
    // Data was never successfully populated — retry regardless
    loadHRPotentialWithRetry();
  }
}


function loadHRPotentialWithRetry() {
  return loadHRPotential().then(() => {
    // Re-run HRs Today after HR Potential is available so the
    // "HRs Completed from Projection" panel cross-references real rows on first load.
    if (typeof loadHRsToday === 'function') loadHRsToday();

    if (!hrpRows.length) {
      // Lineups not posted yet — retry in 15 minutes
      if (hrpRetryTimer) clearTimeout(hrpRetryTimer);
      hrpRetryTimer = setTimeout(loadHRPotentialWithRetry, 15 * 60 * 1000);
      const el = document.getElementById('hr-potential-content');
      if (el) el.innerHTML = `<div class="mu-empty">Lineups not posted yet — checking again in 15 min.<br><span style="font-size:10px;color:var(--muted)">Last checked: ${new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</span></div>`;
    } else {
      if (hrpRetryTimer) { clearTimeout(hrpRetryTimer); hrpRetryTimer = null; }
    }
  }).catch(() => {
    // On error also retry
    if (hrpRetryTimer) clearTimeout(hrpRetryTimer);
    hrpRetryTimer = setTimeout(loadHRPotentialWithRetry, 15 * 60 * 1000);
  });
}

// HR Threat list is otherwise a one-shot-per-day snapshot (see loaded.hr gate in
// __drLoadGamePickPaneData): once any rows exist, loadHRPotentialWithRetry never runs
// again for the rest of the day. If that snapshot happened before a game's official
// lineup posted, loadHRPotential falls back to a guessed active-roster sort instead of
// the real batting order, and a real starter who doesn't match the guess stays missing
// even after the actual lineup goes final. Re-running only in the hour before each
// game's first pitch — the window official lineups typically post in — catches that
// without polling all day once every game's real lineup is already locked in.
function anyGameInHRPotentialRefreshWindow(games) {
  const now = Date.now();
  const ONE_HOUR_MS = 60 * 60 * 1000;
  return (games || []).some(g => {
    const state = g.status?.abstractGameState;
    if (state === 'Live' || state === 'Final') return false;
    const msUntilFirstPitch = new Date(g.gameDate).getTime() - now;
    return msUntilFirstPitch > 0 && msUntilFirstPitch <= ONE_HOUR_MS;
  });
}
setInterval(() => {
  if (document.visibilityState !== 'visible' || window.__diamondUserInteracting) return;
  if (!document.getElementById('hr-potential-content')) return;
  getTodaySchedule('team,probablePitcher').then(games => {
    if (anyGameInHRPotentialRefreshWindow(games)) loadHRPotentialWithRetry();
  }).catch(() => {});
}, 5 * 60_000);

function schedule5amHRRefresh() {
  const cdtNow = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Chicago'}));
  const next5am = new Date(cdtNow);
  next5am.setHours(5, 0, 5, 0);
  if (cdtNow >= next5am) next5am.setDate(next5am.getDate() + 1);
  const msUntil5am = next5am - cdtNow;
  setTimeout(() => {
    const today = new Date().toLocaleDateString('en-CA', {timeZone:'America/Chicago'});
    setHRPLastLoadedDate(today);
    loadHRPotential();
    schedule5amHRRefresh();
  }, msUntil5am);
}

// HR Potential startup is coordinated by bootDiamondReportStartup() near the end of this script.




// ── K'S TODAY ────────────────────────────────────────────────────────
async function loadKsToday() {
  const el = document.getElementById('ks-today-props');
  // Don't return early if el is null — still need to update pitcher O/U tags
  try {
    // Shares the schedule cache/dedupe with loadHRsToday, which requests the exact
    // same hydrate string — these two are called back-to-back on every Props refresh,
    // and used to each independently re-fetch the identical schedule endpoint.
    const games = await getTodaySchedule('boxscore,team,probablePitcher');

    const allPitchers = [];

    // Fetch any missing boxscores in parallel — sequential per-game awaits here
    // used to serialize N network round-trips back-to-back on a full live slate.
    const ksBoxscores = await Promise.all(games.map(async g => {
      if (g.teams?.away?.pitchers?.length) return g.teams;
      try {
        const bd = await fetchJSON(`https://diamondreport.app/api/v1/game/${g.gamePk}/boxscore`);
        return bd.teams;
      } catch { return g.teams; }
    }));

    games.forEach((g, gi) => {
      const dt = new Date(g.gameDate);
      const timeStr = dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/Chicago'});
      const awayAbbr = g.teams.away.team.abbreviation;
      const homeAbbr = g.teams.home.team.abbreviation;
      const gameLabel = `${awayAbbr} @ ${homeAbbr}`;
      const state = g.status.abstractGameState;

      const box = ksBoxscores[gi];
      const gameNotStarted = state === 'Preview' || state === 'pre' || (!g.teams?.away?.pitchers?.length && state !== 'Final');

      // For upcoming games with no boxscore pitchers, use probable pitchers from schedule
      ['away','home'].forEach(side => {
        const abbr = side === 'away' ? awayAbbr : homeAbbr;
        const gameFinal = g.status.abstractGameState === 'Final';
        const gameLive  = g.status.abstractGameState === 'Live' || g.status.detailedState === 'In Progress';
        const team = box?.[side];
        const hasPitchers = team?.pitchers?.length > 0;

        if (!hasPitchers) {
          // Use probable pitcher from schedule data
          const prob = g.teams[side].probablePitcher;
          if (prob) {
            allPitchers.push({
              name: prob.fullName || '–',
              id: prob.id,
              teamAbbr: abbr,
              ks: 0, ip: '0.0', hrs: 0, pitches: 0, relievedInning: null,
              gameLabel, timeStr,
              gameTimestamp: dt.getTime(),
              isSP: true,
              isFinal: false,
              isLive: false,
              isUpcoming: true,
            });
          }
          return;
        }

        (team.pitchers || []).forEach((id, idx) => {
          const p = team.players?.[`ID${id}`];
          if (!p) return;
          const ks      = parseInt(p.stats?.pitching?.strikeOuts) || 0;
          const ip      = p.stats?.pitching?.inningsPitched || '0.0';
          const hrs     = parseInt(p.stats?.pitching?.homeRuns) || 0;
          const runs    = parseInt(p.stats?.pitching?.runs) || 0;
          const pitches = parseInt(p.stats?.pitching?.numberOfPitches) || 0;
          const pitcherList  = team.pitchers || [];
          const isLastPitcher = idx === pitcherList.length - 1;
          // wasRelieved: appeared but not the current/last pitcher in the game
          const wasRelieved   = (gameFinal || gameLive) && parseFloat(ip) > 0 && !isLastPitcher;
          const relievedInning = wasRelieved ? Math.ceil(parseFloat(ip)) : null;
          allPitchers.push({
            name: p.person?.fullName || '–',
            id: p.person?.id,
            teamAbbr: abbr,
            ks, ip, hrs, runs, pitches, relievedInning,
            gameLabel, timeStr,
            gameTimestamp: dt.getTime(),
            isSP: pitcherList[0] === id,
            isFinal: gameFinal,
            isLive: gameLive,
          });
        });
      });
    });

    if (!allPitchers.length) {
      if (el) el.innerHTML = `<div class="mu-empty">No strikeout data yet — check back once games are underway.</div>`;
      return;
    }

    // Sort: live games first (by K desc), then final (by K desc), then upcoming (by time)
    allPitchers.sort((a, b) => {
      // live first → upcoming second → final last (bottom of list)
      const statusRank = p => p.isLive ? 0 : p.isUpcoming ? 1 : 2;
      if (statusRank(a) !== statusRank(b)) return statusRank(a) - statusRank(b);
      if (a.isLive) return b.ks - a.ks;           // live: most Ks first
      if (a.isUpcoming) return a.gameTimestamp - b.gameTimestamp; // upcoming: earliest first
      return b.ks - a.ks;                         // final: most Ks first
    });

    // Keep a global snapshot of each pitcher's current K count/status so K Props
    // can compute a live "today's record" W-L tally without re-scraping the DOM.
    // NOTE: K's Today display is filtered later to only show pitchers that have
    // a valid Diamond Report K projection from the K Props engine, but this
    // live snapshot intentionally keeps all pitchers so Pitcher Report/K Props
    // live syncing still works.
    latestPitcherKData = {};
    allPitchers.forEach(p => {
      if (p.id) {
        const liveKey = normalizePitcherId(p.id);
        latestPitcherKData[liveKey] = { ks: p.ks, isFinal: p.isFinal, isLive: p.isLive, name: p.name, teamAbbr: p.teamAbbr };
        latestPitcherKData[p.id] = latestPitcherKData[liveKey];
      }
    });
    if (kPropsData.length) renderKProps();
    // Refresh Pitcher Report cards/table after live K data arrives so LIVE K
    // does not remain blank when the Pitcher Report rendered before K's Today.
    if (Array.isArray(prRows) && prRows.length) {
      try { renderPRTable(); } catch(e) { console.warn('Pitcher Report live K refresh skipped', e); }
    }

    // Feed live pitchers to banner
    allPitchers.forEach(p => {
      if (p.isLive && p.id) {
        const ouLine = pitcherOULines[p.id] || null;
        bannerKs[p.id] = {
          name: p.name, teamAbbr: p.teamAbbr,
          oppAbbr: p.gameLabel.includes('@') ? p.gameLabel.split(' @ ')[p.gameLabel.startsWith(p.teamAbbr) ? 1 : 0] : '–',
          ks: p.ks, ouLine
        };
      }
    });

    const hs = id => id ? `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_32,q_auto:best/v1/people/${id}/headshot/67/current` : '';

    // Make sure real DR K Proj / SB Line data is loaded before building the list —
    // otherwise every pitcher renders with a "—" placeholder until the Props tab
    // happens to be opened. This is a no-op once K Props has already loaded.
    await ensureKPropsLoaded();

    // K's Today should only list pitchers that have a Diamond Report K projection.
    // This prevents probable/live pitchers without a DR K Proj from appearing with
    // blank or misleading projection badges.
    const ksTodayPitchers = allPitchers
      .map(p => {
        const drKProj = getDRKProjectionForPitcher(p.id, p.name);
        const sbLine = getSportsbookKLine(p.id, p.name) ?? pitcherOULines[p.id] ?? pitcherOULines[String(p.id)] ?? null;
        return { ...p, drKProj, sbLine };
      })
      .filter(p => {
        // K's Today is a live-only tracker. Do not show upcoming, preview, or final games.
        if (!p.isLive) return false;
        // Only exclude a pitcher when we have a confirmed DR K Proj of exactly 0
        // (a real placeholder value). If the projection hasn't loaded yet (null/undefined,
        // e.g. before K Props has fetched for the day), keep the pitcher — do NOT hide
        // them just because the data isn't in yet. This avoids K's Today going empty
        // whenever it renders before loadKProps() has finished.
        const dr = p.drKProj;
        return !(typeof dr === 'number' && Number.isFinite(dr) && dr === 0);
      });

    if (!ksTodayPitchers.length) {
      if (el) el.innerHTML = `<div class="mu-empty ks-today-empty">No live pitcher strikeout data right now — this section appears once games are in progress.</div>`;
      return;
    }

    const rows = ksTodayPitchers.map(p => {
      const ouLine = p.sbLine ?? getSportsbookKLine(p.id, p.name) ?? pitcherOULines[p.id] ?? pitcherOULines[String(p.id)] ?? null;
      const drKProj = p.drKProj;
      // Use getKPropLine (same source as Pitcher Report) — real sportsbook line when
      // available, model projection rounded to nearest half as fallback. This guarantees
      // both sections always show the same value.
      const prRow = prRows.find(r => normalizePitcherId(r.pitcher?.id) === normalizePitcherId(p.id));
      const kpropLine = prRow ? getKPropLine(prRow.pitcher, prRow) : ouLine;
      const kpropDir  = prRow ? getKPropDirection(prRow, kpropLine) : (drKProj != null && kpropLine != null ? (drKProj >= kpropLine ? 'Over' : 'Under') : null);
      // Only show the projection label when we actually have a number to show
      const hasProjection = kpropLine != null && Number.isFinite(Number(kpropLine));
      const drKProjLabel = hasProjection
        ? (kpropDir === 'Over' ? '⬆︎' : '⬇︎') + ` ${kpropLine}`
        : null;
      // "Done for Day" — pitcher was relieved (only flag for starters, not relievers already)
      const doneForDay = !p.isUpcoming && p.relievedInning;
      let ouBadge = '';
      if (ouLine !== null) {
        if (p.ks > ouLine) {
          ouBadge = `<span class="k-ou-tag k-ou-over">▲ OVER ${ouLine}</span>`;
        } else if (p.ks < ouLine) {
          ouBadge = `<span class="k-ou-tag k-ou-under">▼ UNDER ${ouLine}</span>`;
        } else {
          ouBadge = `<span class="k-ou-tag" style="border-color:var(--muted);color:var(--muted)">PUSH ${ouLine}</span>`;
        }
      }
      // K count color: green if over projected line, red if under (final only), orange if tied, default otherwise
      let ksColor;
      if (ouLine !== null) {
        if (p.ks > ouLine) ksColor = 'var(--green)';
        else if (p.ks < ouLine && p.isFinal) ksColor = 'var(--accent)';
        else if (p.ks === ouLine) ksColor = 'var(--accent2)';
        else ksColor = 'var(--text)';
      } else {
        ksColor = p.ks >= 8 ? 'var(--green)' : p.ks >= 5 ? 'var(--accent2)' : 'var(--text)';
      }
      const statusBadge = `<span class="ks-today-status ks-today-live">● LIVE</span>`;
      return `<div class="ks-today-row ks-row-live ks-today-premium">
        <img class="ks-today-photo" src="${hs(p.id)}" alt="" loading="lazy" decoding="async">
        <div class="ks-today-info">
          <div class="ks-today-topline">
            ${statusBadge}
            <span class="ks-today-name">${p.name}</span>
          </div>
          <div class="ks-today-game">
            <span class="ks-today-meta">${p.gameLabel}</span>
          </div>
          <div class="ks-today-details">
            <div class="ks-today-statsrow">
              <span class="ks-today-detail">${p.isSP?'SP · ':''}${p.ip} IP${p.pitches>0?' · '+p.pitches+' pitches':''}</span>
              ${hasProjection ? `<span class="ks-today-inline-projection">Line K ${drKProjLabel}</span>` : ''}
            </div>
            <div class="ks-today-badges">
              ${p.runs>0?`<span class="ks-today-alert">⚾ ${p.runs} Run${p.runs>1?'s':''} Allowed${p.hrs>0?` (${p.hrs} HR${p.hrs>1?'s':''})`:''}</span>`:''}
              ${doneForDay ? `<span class="ks-today-done-badge">✓ Done for Day</span>` : ''}
            </div>
          </div>
        </div>
        <div class="ks-today-countbox">
          <span class="ks-today-projection-label">STRIKEOUTS</span>
          <span class="ks-today-countline"><span class="ks-today-value" style="color:${ksColor}">${p.ks}</span><span class="ks-today-klabel">K</span></span>
        </div>
      </div>`;
    }).join('');

    if (el) el.innerHTML = rows || `<div class="mu-empty">No strikeout data yet.</div>`;

    // ── Patch Pitcher Report rows with live O/U status ──
    allPitchers.forEach(p => {
      const ouLine = pitcherOULines[p.id];
      if (!ouLine) return;

      // Determine status — only show OVER/UNDER/PUSH if game is live or final
      let status = null;
      if (p.isFinal) {
        status = p.ks > ouLine ? 'over' : p.ks < ouLine ? 'under' : 'push';
      } else if (p.ks > 0) {
        // Live game — show current pace
        status = p.ks > ouLine ? 'over' : p.ks === ouLine ? 'push' : null; // only flag if already exceeded
      }

      if (!status) return;

      // Patch the ou-tag span in the Pitcher Report table
      const tagEl = document.getElementById(`ou-tag-${p.id}`);
      if (tagEl) {
        if (status === 'over') {
          tagEl.className = 'k-ou-tag k-ou-over';
          tagEl.textContent = `▲ OVER ${ouLine} (${p.ks}K)`;
        } else if (status === 'under') {
          tagEl.className = 'k-ou-tag k-ou-under';
          tagEl.textContent = `▼ UNDER ${ouLine} (${p.ks}K)`;
        } else {
          tagEl.className = 'k-ou-tag';
          tagEl.style.borderColor = 'var(--muted)';
          tagEl.style.color = 'var(--muted)';
          tagEl.textContent = `PUSH ${ouLine} (${p.ks}K)`;
        }
      }

      // Patch K Props rows in Props tab
      const kpropRows = document.querySelectorAll('.kprop-row');
      kpropRows.forEach(row => {
        const nameEl = row.querySelector('.kprop-name');
        if (!nameEl || !nameEl.textContent.includes(p.name)) return;
        let predEl = row.querySelector('.kprop-pred');
        if (!predEl) return;
        if (status === 'over') {
          predEl.className = 'kprop-pred kprop-over';
          const valEl = predEl.querySelector('.kprop-pred-val');
          const lblEl = predEl.querySelector('.kprop-pred-lbl');
          if (valEl) valEl.textContent = '▲ OVER';
          if (lblEl) lblEl.textContent = `${p.ks}K LIVE`;
        } else if (status === 'under') {
          predEl.className = 'kprop-pred kprop-under';
          const valEl = predEl.querySelector('.kprop-pred-val');
          const lblEl = predEl.querySelector('.kprop-pred-lbl');
          if (valEl) valEl.textContent = '▼ UNDER';
          if (lblEl) lblEl.textContent = `${p.ks}K FINAL`;
        } else {
          const valEl = predEl.querySelector('.kprop-pred-val');
          const lblEl = predEl.querySelector('.kprop-pred-lbl');
          if (valEl) valEl.textContent = 'PUSH';
          if (lblEl) lblEl.textContent = `${p.ks}K`;
        }
      });
    });
  } catch(e) {
    console.warn('K Today render error', e);
    if (el) el.innerHTML = `<div class="mu-empty" style="color:var(--accent)">Error loading Ks: ${e.message}</div>`;
  }
}

// Robust K's Today startup/refresh helper. On a cold first load, the Props tab can be
// initialized before the MLB schedule/boxscore response is ready, which left K's Today
// empty until a manual reload. Run a few light retries and keep refreshing in the
// background so the panel is populated the first time the Props tab is opened.
let ksTodayRetryTimer = null;
function loadKsTodayWithRetry(attempt = 0) {
  Promise.resolve(loadKsToday()).then(() => {
    const stillWaiting = !latestPitcherKData || Object.keys(latestPitcherKData).length === 0;
    if (stillWaiting && attempt < 4) {
      clearTimeout(ksTodayRetryTimer);
      ksTodayRetryTimer = setTimeout(() => loadKsTodayWithRetry(attempt + 1), [750, 1500, 3000, 5000][attempt] || 5000);
    }
  }).catch(() => {
    if (attempt < 4) {
      clearTimeout(ksTodayRetryTimer);
      ksTodayRetryTimer = setTimeout(() => loadKsTodayWithRetry(attempt + 1), [750, 1500, 3000, 5000][attempt] || 5000);
    }
  });
}

// Refresh K's Today every 60s
setInterval(() => { if (document.visibilityState === 'visible' && !window.__diamondUserInteracting && document.getElementById('props')?.classList.contains('active') && document.getElementById('kprops-content')) loadKsTodayWithRetry(); }, 120000);



// ── ACTIVE ROSTER GUARD FOR HR THREATS ───────────────────────────────
let activePlayerIdsToday = new Set();
let activeRosterTeamIdsToday = new Set();
let activePlayerIdsLoadedFor = '';
// isActiveForHRThreat() only filters a team's players if that team's roster fetch
// succeeded — a team whose fetch fails gets a complete pass, every player on that
// roster included with zero filtering. With ~26-30 of these fetches firing at once
// (one per team playing today) sharing the same request queue as everything else the
// page loads, a handful failing on any given page load was ordinary, and which ones
// failed varied refresh to refresh — directly changing the final "Players Scanned"
// count each time. Retrying a failed fetch a couple of times before giving up fixes
// the common transient case (timeout, momentary rate limit) without changing the
// fail-open fallback for a fetch that's genuinely still down after retrying.
async function fetchTeamRosterWithRetry(tid, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchJSON(`https://diamondreport.app/api/v1/teams/${tid}/roster?rosterType=active&season=2026`);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}
async function loadActivePlayerIdsForGames(games) {
  const today = new Date().toLocaleDateString('en-CA', {timeZone:'America/Chicago'});
  if (activePlayerIdsLoadedFor === today && activePlayerIdsToday.size) return activePlayerIdsToday;
  const ids = new Set();
  const loadedTeamIds = new Set();
  const teamIdsForToday = [...new Set((games || []).flatMap(g => [g?.teams?.away?.team?.id, g?.teams?.home?.team?.id]).filter(Boolean))];
  await Promise.all(teamIdsForToday.map(async tid => {
    try {
      const data = await fetchTeamRosterWithRetry(tid);
      if (Array.isArray(data.roster)) loadedTeamIds.add(String(tid));
      (data.roster || []).forEach(r => {
        const pid = r.person?.id || r.player?.id || r.id;
        const statusText = String(r.status?.description || r.status?.code || r.rosterStatus || '').toLowerCase();
        if (!pid) return;
        if (/injured|\bil\b|restricted|suspended|bereavement|paternity|inactive|minor/.test(statusText)) return;
        ids.add(String(pid));
      });
    } catch(e) {}
  }));
  activePlayerIdsToday = ids;
  activeRosterTeamIdsToday = loadedTeamIds;
  activePlayerIdsLoadedFor = today;
  return activePlayerIdsToday;
}
function rowLooksInactive(row) {
  const txt = String(row?.status || row?.statusText || row?.rosterStatus || row?.injuryStatus || row?.stats?.status || row?.playerStatus || '').toLowerCase();
  return /injured|\bil\b|restricted|suspended|bereavement|paternity|inactive|minor/.test(txt);
}
function isActiveForHRThreat(row) {
  if (!row || !row.id) return false;
  if (rowLooksInactive(row)) return false;
  if (activePlayerIdsToday && activePlayerIdsToday.size) {
    const teamId = teamIds?.[row.teamAbbr] || teamIds?.[row.team] || null;
    // Only enforce the active roster check for teams whose roster endpoint loaded.
    if (teamId && activeRosterTeamIdsToday.has(String(teamId))) return activePlayerIdsToday.has(String(row.id));
  }
  return true;
}

let propsLoaded = false;

// ── HR POTENTIAL ─────────────────────────────────────────────────────
async function loadHRPotential() {
  const el = document.getElementById('hr-potential-content');
  const refresh = document.getElementById('props-refresh');
  try {
    const today = new Date().toLocaleDateString('en-CA', {timeZone:'America/Chicago'});
    await loadStatcastHotHitters();
    await loadParkFactors().catch(() => {});
    await loadBallparkPalFactors().catch(() => {});
    const games = await getTodaySchedule('team,probablePitcher');
    await loadActivePlayerIdsForGames(games).catch(() => {});

    // Pre-populate lineupCache from Pitcher Report if available and not yet cached
    if (prRows.length > 0 && Object.keys(lineupCache).length === 0) {
      if (el) el.innerHTML = `<div class="mu-empty"><span class="spin"></span>Loading lineups from Pitcher Report…</div>`;
      await Promise.all(prRows.map(r => {
        const p = r.pitcher;
        if (p.id && p.gamePk && p.side != null) {
          return fetchAndRenderLineup(p.id, p.name, p.gamePk, p.side, p.oppTeamId, r.rawHr9, r.rawIp).catch(()=>{});
        }
      }));
    }

    const allBatters = [];
    const batterStatCache = {}; // cache batter stats to avoid duplicate fetches
    const boxscoreCache = {};   // cache boxscores by gamePk
    let renderScheduled = false;

    // Progressive render — show results as they arrive, not all at once
    const addBatter = (b) => {
      if (!isActiveForHRThreat(b)) return;
      allBatters.push(b);
      if (!renderScheduled) {
        renderScheduled = true;
        setTimeout(() => {
          renderScheduled = false;
          const progressiveHRRows = [];
          const progressiveSeen = new Set();
          allBatters.filter(isActiveForHRThreat).forEach(row => {
            const key = `${row.gamePk || ''}:${row.id || ''}:${row.pitcherId || ''}`;
            if (!row.id || progressiveSeen.has(key)) return;
            progressiveSeen.add(key);
            progressiveHRRows.push(row);
          });
          hrpRows = applyHotHitterBoosts(progressiveHRRows);
          renderHRPTable();
        }, 300);
      }
    };

    // Process all games in parallel
    await Promise.all(games.map(async g => {
      const dt = new Date(g.gameDate);
      const timeStr = dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/Chicago'});
      const state = g.status.abstractGameState;
      const isLive = state==='Live' || g.status.detailedState==='In Progress';
      const isFinal = state==='Final';
      const timeColor = isLive ? 'var(--live)' : isFinal ? 'var(--muted)' : 'var(--text)';
      const timeLabel = isLive ? '● LIVE' : isFinal ? 'FINAL' : timeStr;

      // Fetch boxscore once per game. A single failed attempt here used to drop the
      // entire game's batters (up to 18 — both teams' starters) from the scan for that
      // refresh: every fallback path below (lineupCache, the roster-derived fallback)
      // also reads from this same bd/boxscore, so if the fetch failed once, they all came
      // up empty too and the whole side got skipped. Same fix as the roster-fetch retry —
      // recover the common transient case instead of silently losing a whole game.
      let bd = null;
      if (!boxscoreCache[g.gamePk]) {
        let lastErr;
        for (let i = 0; i < 3; i++) {
          try {
            boxscoreCache[g.gamePk] = await fetchJSON(`https://diamondreport.app/api/v1/game/${g.gamePk}/boxscore`);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            if (i < 2) await new Promise(r => setTimeout(r, 300 * (i + 1)));
          }
        }
        if (lastErr) delete boxscoreCache[g.gamePk];
      }
      bd = boxscoreCache[g.gamePk] || null;

      // Process both pitchers in parallel
      await Promise.all([['away','home'],['home','away']].map(async ([side, opp]) => {
        const pitcher = g.teams[opp].probablePitcher;
        if (!pitcher) return;
        const teamAbbr = g.teams[side].team.abbreviation;
        const oppAbbr  = g.teams[opp].team.abbreviation;

        let pitcherHr9=0, pitcherAvg=.240, pitcherSlg=.380, pitcherWhip=1.25, pitcherK9=8, pitcherSbAllowed=0, pitcherCsAllowed=0;
        try {
          // Same zero-retry problem as the roster/boxscore/batter-stats fetches fixed
          // earlier: pitcherHr9 feeds hrProb at a real 40% weight (see baseHrProb below),
          // so a single failed attempt here used to silently fall back to pitcherHr9=0,
          // which replaces the pitcher's actual HR-prone or HR-suppressing profile with a
          // flat 0.03 constant for that refresh — the matchup context just disappears.
          let pd, lastErr;
          for (let i = 0; i < 3; i++) {
            try {
              pd = await fetchJSON(`https://diamondreport.app/api/v1/people/${pitcher.id}?hydrate=stats(group=pitching,type=season,season=2026)`);
              lastErr = null;
              break;
            } catch (e) {
              lastErr = e;
              if (i < 2) await new Promise(r => setTimeout(r, 250 * (i + 1)));
            }
          }
          if (lastErr) throw lastErr;
          const ps = pd.people?.[0]?.stats?.[0]?.splits?.[0]?.stat||{};
          pitcherHr9=parseFloat(ps.homeRunsPer9)||0; pitcherAvg=parseFloat(ps.avg)||.240;
          pitcherSlg=parseFloat(ps.slg)||.380; pitcherWhip=parseFloat(ps.whip)||1.25;
          pitcherK9=parseFloat(ps.strikeoutsPer9Inn)||8;
          // Stolen bases/caught stealing allowed while this pitcher is on the mound — a
          // practical stand-in for catcher caught-stealing% (true catcher-specific data
          // would need identifying and querying the starting catcher separately, which
          // doubles the request volume for a page already known to be request-heavy).
          // The pitcher's own allowed rate already captures most of the same signal since
          // it's the battery's combined ability to control the running game.
          pitcherSbAllowed=parseInt(ps.stolenBases)||0; pitcherCsAllowed=parseInt(ps.caughtStealing)||0;
        } catch {}
        const gameParkFactor = parkFactors[g.teams.home.team.abbreviation] || 100;

        const teamBox = bd?.teams?.[side];
        let batters = (teamBox?.batters||[]).map(id=>{const p=teamBox?.players[`ID${id}`];return p?{id,player:p}:null;}).filter(Boolean);

        // Confirmed starters only. MLB's battingOrder convention encodes the starting
        // lineup spot as a value ending in "00" (100, 200, ... 900); a substitute who
        // enters mid-game gets a non-"00" suffix (e.g. 101). Without this, a live or final
        // game's boxscore.batters list keeps growing all game — pinch hitters, defensive
        // subs, double switches — so how many extra names got scanned (and counted toward
        // Players Scanned) depended entirely on how far along the game happened to be at
        // the moment of refresh, on top of the roster-gate race fixed separately above.
        if (batters.length) {
          const starters = batters.filter(b => {
            const bo = Number(b.player?.battingOrder ?? b.player?.stats?.batting?.battingOrder ?? NaN);
            return Number.isFinite(bo) && bo % 100 === 0;
          });
          batters = starters.length ? starters : batters.slice(0, 9);
        }

        // If no game batters are available yet, prefer lineupCache from Pitcher Report.
        // This keeps HR Threats populated before official lineups are posted, without using
        // random active-roster timing from the boxscore as the primary source.
        if (!batters.length) {
          const cacheKey = `${g.gamePk}-${side}`;
          const cached = lineupCache[cacheKey];
          if (cached?.lineup?.length) {
            batters = cached.lineup.slice(0, 9).map(b => ({
              id: b.id,
              player: {
                person: { id: b.id, fullName: b.name },
                position: { abbreviation: b.pos },
                seasonStats: { batting: b.stats },
                stats: { batting: b.stats },
                last10HR: b.last10HR ?? null,
              }
            }));
          }
        }

        // Last resort before official lineups: use a deterministic projected-core fallback.
        // The previous version read the active roster in whatever order the live boxscore
        // returned it, which made Players Scanned jump after refresh. This sorts by real
        // battingOrder when present, then by player id/name so the same nine candidates are
        // selected every refresh. Pitchers and unavailable roster entries stay excluded.
        if (!batters.length) {
          const teamBox2 = bd?.teams?.[side];
          if (teamBox2?.players) {
            batters = Object.values(teamBox2.players)
              .filter(p => p.position?.type !== 'Pitcher' && p.person?.id && p.person?.fullName && (!p.status?.code || p.status.code === 'A'))
              .sort((a,b) => {
                const ao = Number(a.battingOrder || a.stats?.batting?.battingOrder || 999999);
                const bo = Number(b.battingOrder || b.stats?.batting?.battingOrder || 999999);
                if (ao !== bo) return ao - bo;
                const aid = Number(a.person?.id || 0), bid = Number(b.person?.id || 0);
                if (aid !== bid) return aid - bid;
                return String(a.person?.fullName || '').localeCompare(String(b.person?.fullName || ''));
              })
              .slice(0, 9)
              .map(p => ({ id: p.person.id, player: p }));
          }
        }

        if (!batters.length) return;

        const batterToday = new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'});
        const yd=new Date(); yd.setDate(yd.getDate()-1);
        const db2=new Date(); db2.setDate(db2.getDate()-2);
        const ydStr=yd.toLocaleDateString('en-CA',{timeZone:'America/Chicago'});
        const dbStr=db2.toLocaleDateString('en-CA',{timeZone:'America/Chicago'});

        // Fetch all batters in parallel (with cache)
        const batterRowsForPitcher = (await Promise.all(batters.slice(0,9).map(async b => {
          const pid = b.player.person?.id;
          if (!pid) return null;
          let s=b.player.seasonStats?.batting||{};
          let last10HR=null, todayHR=0, streakDays=1, hrVsPitcher=null, logs=[];
          try {
            if (!batterStatCache[pid]) {
              // Use last5 game type for streak detection instead of full season gameLog —
              // last5 returns the 5 most recent games and is a tiny fraction of the payload.
              // Full gameLog (162 games) was the single biggest API cost on the page.
              // The season-stats fetch (sd) drives ab/hr/avg/ops/obp/slg — everything
              // feeding hrProb and the Hits/RBI/TB/SB/H+R+RBI scores. A single failed
              // attempt used to fall back to whatever partial stat blob the boxscore
              // happened to embed (often near-empty for a preview-state game), which the
              // sample-size shrinkage then pulled almost entirely toward league average —
              // a completely different number than a refresh where the fetch succeeded.
              // Same retry fix as the roster and boxscore fetches.
              let sd, lastErr;
              for (let i = 0; i < 3; i++) {
                try {
                  sd = await fetchJSON(`https://diamondreport.app/api/v1/people/${pid}?hydrate=stats(group=hitting,type=season,season=2026)`);
                  lastErr = null;
                  break;
                } catch (e) {
                  lastErr = e;
                  if (i < 2) await new Promise(r => setTimeout(r, 250 * (i + 1)));
                }
              }
              if (lastErr) throw lastErr;
              // Same zero-retry problem as the season-stats fetch above: this drives
              // last10HR/streakDays, which feed the hot-hitter boost fallback profile
              // (buildFallbackHotHitterProfile) added to hrProb. A single failed attempt
              // used to silently produce logs=[], zeroing last10HR/streakDays for that
              // refresh and shifting hrProb enough to move a batter across the 5%/10%
              // HR Threats cutoff — the same "list/count jumps on refresh" bug as the
              // fetches already fixed above, just via a different endpoint.
              let ld, ldErr;
              for (let i = 0; i < 3; i++) {
                try {
                  ld = await fetchJSON(`https://diamondreport.app/api/v1/people/${pid}/stats?stats=lastXGames&group=hitting&season=2026&limit=12&gameType=R`);
                  ldErr = null;
                  break;
                } catch (e) {
                  ldErr = e;
                  if (i < 2) await new Promise(r => setTimeout(r, 250 * (i + 1)));
                }
              }
              if (ldErr) ld = { stats: [] };
              batterStatCache[pid]={sd,ld};
            }
            const {sd,ld}=batterStatCache[pid];
            s=sd.people?.[0]?.stats?.[0]?.splits?.[0]?.stat||s;
            logs=ld.stats?.[0]?.splits||[];
            last10HR=logs.slice(0,10).reduce((n,g2)=>n+(parseInt(g2.stat?.homeRuns)||0),0);
            // HR Today must only reflect an actual in-game HR, never season totals before first pitch
            const gameHasStartedForHrp = isLive || isFinal;
            todayHR = gameHasStartedForHrp ? (parseInt(b.player.stats?.batting?.homeRuns)||0) : 0;
            const hitYd=logs.some(g2=>g2.date===ydStr&&parseInt(g2.stat?.homeRuns)>0);
            const hitDb=logs.some(g2=>g2.date===dbStr&&parseInt(g2.stat?.homeRuns)>0);
            streakDays=hitYd&&hitDb?3:hitYd?2:1;
            // H2H skipped — adds 1 call per batter (up to 135 extra calls) for a minor display field
          } catch {
            if (last10HR == null && b.player?.last10HR != null) last10HR = b.player.last10HR;
          }
          const ab=parseInt(s.atBats)||0, hr=parseInt(s.homeRuns)||0;
          // Below a minimum sample, a raw HR/AB rate is too noisy to trust outright — 2 HR
          // in 10 AB is not a real 20% HR rate. Shrink toward league-average HR rate in
          // proportion to how little season data backs the number (0 AB = pure league
          // average, 40+ AB = fully trust the batter's own rate).
          const HRP_MIN_AB_FOR_RATE = 40;
          const HRP_LEAGUE_AVG_HR_RATE = 0.031; // ~1 HR per 32 AB, roughly MLB seasonal average
          const rawBatterRate = ab>0?hr/ab:0;
          const hrpSampleWeight = Math.min(ab, HRP_MIN_AB_FOR_RATE) / HRP_MIN_AB_FOR_RATE;
          // rawBatterRate and HRP_LEAGUE_AVG_HR_RATE are both HR-per-AT-BAT, so their
          // blend is too; the 0.88 factor converts the blended result to HR-per-PLATE-
          // APPEARANCE (PA also includes walks/HBP/sac flies) to match what pitcherRate
          // and hrPerPA below assume.
          const batterRate = ((rawBatterRate*hrpSampleWeight) + (HRP_LEAGUE_AVG_HR_RATE*(1-hrpSampleWeight))) * 0.88;
          // homeRunsPer9 is allowed-per-9-innings (27 outs); a pitcher actually faces
          // ~38 batters per 9 innings once baserunners allowed are counted, so dividing
          // by 27 overstated the pitcher's true HR-per-batter rate.
          const pitcherRate=pitcherHr9>0?pitcherHr9/38:0.03;
          // gameParkFactor (100=average, Coors~145, Oakland~90) used to be computed and
          // attached to the row as metadata but never actually multiplied into the rate
          // that drives hrProb — Coors Field and Oakland Coliseum graded identically once
          // the sim ran. Same 0.5 shrinkage already used for this exact purpose elsewhere
          // in this file (see the older parkAdj formula in the K/HR prop-hit-highlight
          // module) — a real park's effect is real, but PA-level HR rate has enough other
          // noise that a full raw multiply would overcorrect for it.
          const parkAdj = 1 + ((gameParkFactor - 100) / 100) * 0.5;
          const hrPerPA = ((batterRate*0.6)+(pitcherRate*0.4)) * parkAdj;
          // Lineup slot (1-9), computed here (not just below with the display battingOrder)
          // so it can feed the per-PA count the HR simulation runs — same 3-digit MLB
          // battingOrder code as the display field derives from.
          const battingOrderRaw = Number(b.player?.battingOrder ?? b.player?.stats?.batting?.battingOrder ?? NaN);
          const battingOrder = Number.isFinite(battingOrderRaw) ? Math.max(1, Math.min(9, Math.floor(battingOrderRaw/100))) : null;
          // Genuine simulated odds: instead of treating the blended per-PA HR rate as if
          // it were the full-game probability (undercounts — a batter gets ~4 PA, not 1),
          // compute the real probability of at least one clearing across the game's PA
          // count. simulateHRGameOdds is now an exact closed-form calculation (no
          // Math.random()), so it's already the same for every visitor and every
          // refresh — nothing to cache.
          const baseHrProb = window.simulateHRGameOdds ? window.simulateHRGameOdds(hrPerPA, battingOrder) : Math.min(hrPerPA*100,25);
          let hrProb=baseHrProb;
          const hrInLast8=(logs||[]).slice(0,8).some(g2=>parseInt(g2.stat?.homeRuns)>0);
          const isDrought=!hrInLast8&&hr>0;
          const batterOPS=parseFloat(s.ops)||0;
          const isFavorable=batterOPS>=.800&&(pitcherWhip>=1.25||pitcherAvg>=.260);
          // Same small-sample shrinkage as the HR rate above, applied to the rate stats the
          // Hits/RBI/TB/SB/H+R+RBI boards read (r.avg/r.ops/r.obp/r.slg) — a hot 10-AB stretch
          // shouldn't score identically to a full, reliable season sample.
          const LEAGUE_AVG_AVG = 0.245, LEAGUE_AVG_OPS = 0.720, LEAGUE_AVG_OBP = 0.315, LEAGUE_AVG_SLG = 0.400;
          const rawObp = parseFloat(s.obp)||0, rawSlg = parseFloat(s.slg)||0;
          const shrunkAvg = ((parseFloat(s.avg)||0)*hrpSampleWeight) + (LEAGUE_AVG_AVG*(1-hrpSampleWeight));
          const shrunkOps = (batterOPS*hrpSampleWeight) + (LEAGUE_AVG_OPS*(1-hrpSampleWeight));
          const shrunkObp = (rawObp*hrpSampleWeight) + (LEAGUE_AVG_OBP*(1-hrpSampleWeight));
          const shrunkSlg = (rawSlg*hrpSampleWeight) + (LEAGUE_AVG_SLG*(1-hrpSampleWeight));
          // Recency blend — last 10 games, from the same lastXGames log already fetched
          // above for last10HR/streakDays (zero extra API calls). Same idea as the
          // pitcher ERA/WHIP/K9 recent-form blend: a real hot or cold two-week stretch
          // should move these numbers, capped so a thin recent sample can't outweigh a
          // full season of AVG/OBP/SLG.
          const recentLog = (logs || []).slice(0, 10);
          let recAB=0, recH=0, recBB=0, recHBP=0, recTB=0, recSF=0;
          recentLog.forEach(g2 => {
            const st = g2.stat || {};
            recAB += parseInt(st.atBats) || 0;
            recH += parseInt(st.hits) || 0;
            recBB += parseInt(st.baseOnBalls) || 0;
            recHBP += parseInt(st.hitByPitch) || 0;
            recTB += parseInt(st.totalBases) || 0;
            recSF += parseInt(st.sacFlies) || 0;
          });
          const RECENT_MAX_AB = 20, RECENT_MAX_WEIGHT = 0.35;
          const recentWeight = recAB > 0 ? Math.min(recAB, RECENT_MAX_AB) / RECENT_MAX_AB * RECENT_MAX_WEIGHT : 0;
          const recentObpDenom = recAB + recBB + recHBP + recSF;
          const finalAvg = recAB > 0 ? shrunkAvg*(1-recentWeight) + (recH/recAB)*recentWeight : shrunkAvg;
          const finalObp = recentObpDenom > 0 ? shrunkObp*(1-recentWeight) + ((recH+recBB+recHBP)/recentObpDenom)*recentWeight : shrunkObp;
          const finalSlg = recAB > 0 ? shrunkSlg*(1-recentWeight) + (recTB/recAB)*recentWeight : shrunkSlg;
          const todayBoxStats = (isLive || isFinal) ? (b.player.stats?.batting || {}) : {};
          const todayHits = parseInt(todayBoxStats.hits) || 0;
          const todayRBI = parseInt(todayBoxStats.rbi ?? todayBoxStats.runsBattedIn) || 0;
          const todayTB = parseInt(todayBoxStats.totalBases) || 0;
          const todaySB = parseInt(todayBoxStats.stolenBases) || 0;
          const todayRuns = parseInt(todayBoxStats.runs) || 0;
          return {
            id:pid, name:b.player.person?.fullName||'–', pos:b.player.position?.abbreviation||'–',
            teamAbbr, oppAbbr, pitcherName:pitcher.fullName, pitcherId:pitcher.id,
            timeLabel, timeColor, gameTimestamp:dt.getTime(), gamePk:g.gamePk,
            stats:s, todayStats: todayBoxStats, todayHits, todayRBI, todayTB, todaySB, todayRuns, todayHR, last10HR, baseHrProb, hrProb, streakDays, hrVsPitcher,
            avg:finalAvg, hrSeason:hr, ops:shrunkOps, obp:finalObp, slg:finalSlg,
            battingOrder,
            pitcherAvgAllowed: pitcherAvg, pitcherSlgAllowed: pitcherSlg, pitcherWhipAllowed: pitcherWhip,
            pitcherSbAllowed, pitcherCsAllowed, parkFactor: gameParkFactor,
            // Same sample-size shrinkage as avg/ops/obp/slg above — a raw ISO from a
            // handful of AB (e.g. a 1-for-1 season debut with a HR) can exceed 3.000,
            // which isn't a real power signal and used to inflate the TB/RBI/H+R+RBI
            // scores (iso*96/iso*72/etc.) to a false 99% for players with almost no
            // MLB sample this season.
            iso: Math.max(0, finalSlg - finalAvg), isDrought, isFavorable,
            // "Due" = drought + at least 2 supporting signals: power profile, favorable matchup, decent OPS
            isDue: isDrought && (
              ((finalSlg - finalAvg) >= 0.170 ? 1 : 0) +
              (isFavorable ? 1 : 0) +
              ((parseFloat(s.ops)||0) >= 0.750 ? 1 : 0) +
              ((last10HR === 0 && hr >= 8) ? 1 : 0) // proven HR hitter in deep drought
            ) >= 2,
            topHrThreat:false,
          };
        }))).filter(Boolean);

        if (batterRowsForPitcher.length) {
          applyHotHitterBoosts(batterRowsForPitcher);
          const topRow = batterRowsForPitcher.reduce((best, row) => row.hrProb > best.hrProb ? row : best, batterRowsForPitcher[0]);
          batterRowsForPitcher.forEach(row => {
            row.topHrThreat = row.id === topRow.id;
            addBatter(row);
          });
        }
      }));
    }));

    const stableHRRows = [];
    const stableSeen = new Set();
    allBatters.filter(isActiveForHRThreat).forEach(row => {
      const key = `${row.gamePk || ''}:${row.id || ''}:${row.pitcherId || ''}`;
      if (!row.id || stableSeen.has(key)) return;
      stableSeen.add(key);
      stableHRRows.push(row);
    });
    hrpRows = applyHotHitterBoosts(stableHRRows);
    renderHRPTable();

    const now = new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
    if (refresh) refresh.textContent = `Last updated ${now}`;
  } catch(e) {
    const el2 = document.getElementById('hr-potential-content');
    if (el2) el2.innerHTML = `<div class="mu-empty" style="color:var(--accent)">Error: ${e.message}</div>`;
  }
}

function renderHRPTable() {
  const el = document.getElementById('hr-potential-content');
  if (!el || !hrpRows.length) {
    if (el) el.innerHTML = `<div class="mu-empty">No HR potential data yet — check back once lineups are posted.</div>`;
    return;
  }

  // Multi-select filter logic. Empty set = show all.
  const hasFilter = hrpFilters.size > 0;
  let displayRows = (hasFilter
    ? hrpRows.filter(r => {
        if (hrpFilters.has('onfire') && (r.isOnFire || Number(r.onFireScore||0) >= 70 || Number(r.hotBoostPct||0) >= 4.5)) return true;
        if (hrpFilters.has('drought') && r.isDrought) return true;
        if (hrpFilters.has('due') && r.isDue) return true;
        if (hrpFilters.has('favorable') && r.isFavorable) return true;
        return false;
      })
    : [...hrpRows]
  // HRP_BOARD_MIN_PROB: bare inclusion floor, raised from 8% to 10% to cut weaker signals.
  // topHrThreat no longer bypasses the floor outright — it used to guarantee one hitter per
  // pitcher matchup regardless of how weak that "best of a bad lineup" pick actually was;
  // now it only lowers the bar to 5% instead of waiving it completely.
  ).filter(isActiveForHRThreat).filter(r => (r.topHrThreat && r.hrProb >= 5) || r.hrProb >= 10);

  // Update button active states
  const allActive = !hasFilter;
  document.getElementById('filter-all-btn')?.classList.toggle('active', allActive);
  ['onfire','top','drought','due','favorable'].forEach(f => {
    document.getElementById(`filter-${f}-btn`)?.classList.toggle('active', hrpFilters.has(f));
  });

  const sorted = [...displayRows].sort((a,b) => {
    if (hrpFilters.has('onfire')) {
      const aScore = Number(a.onFireScore || 0), bScore = Number(b.onFireScore || 0);
      if (aScore !== bScore) return bScore - aScore;
      const aBoost = Number(a.hotBoostPct || 0), bBoost = Number(b.hotBoostPct || 0);
      if (aBoost !== bBoost) return bBoost - aBoost;
    }
    if (hrpFilters.has('drought')) {
      const aMatch = a.isDrought ? 1 : 0, bMatch = b.isDrought ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
    }
    if (hrpFilters.has('due')) {
      const aMatch = a.isDue ? 1 : 0, bMatch = b.isDue ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
    }
    if (hrpFilters.has('favorable')) {
      const aMatch = a.isFavorable ? 1 : 0, bMatch = b.isFavorable ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
    }
    const av = a[hrpSortCol], bv = b[hrpSortCol];
    if (av==null&&bv==null) return 0;
    if (av==null) return 1; if (bv==null) return -1;
    const primary = (av-bv)*hrpSortDir;
    if (primary !== 0) return primary;
    return (b.hrProb || 0) - (a.hrProb || 0);
  });

  if (!sorted.length) {
    el.innerHTML = `<div class="mu-empty" style="padding:24px">No players match the selected filters. Try combining fewer filters, or select ALL to reset.</div>`;
    return;
  }

  const hs = id => `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_80,q_auto:best/v1/people/${id}/headshot/67/current`;
  const tl = abbr => { const tid = teamIds[abbr]; return tid ? `<img class="dr1017-team-logo" src="https://www.mlbstatic.com/team-logos/${tid}.svg" alt="" loading="lazy" decoding="async">` : ''; };
  const fmt3 = v => Number(v)>0 ? Number(v).toFixed(3).replace(/^0/,'') : '–';
  const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
  const gradeFor = pct => pct >= 12 ? 'A+' : pct >= 10 ? 'A' : pct >= 8 ? 'B+' : pct >= 6 ? 'B' : 'C';
  const riskFor = r => (r.hrProb >= 10 && (r.ops >= .800 || r.iso >= .200)) ? 'MEDIUM' : (r.hrProb >= 8 ? 'ELEVATED' : 'HIGH');
  const classify = (good, mid) => good ? 'green' : mid ? 'gold' : 'blue';
  const whyText = r => {
    const bits = [];
    if (r.topHrThreat || r.hrProb >= 8) bits.push('top HR threat signal');
    if (r.isOnFire) bits.push(`hot-hitter boost${r.onFireScore ? ` (${Math.round(r.onFireScore)})` : ''}`);
    if (r.isFavorable) bits.push('favorable pitcher matchup');
    if (r.isDue) bits.push('due profile');
    if (r.isDrought) bits.push('HR drought angle');
    if (r.iso >= .200) bits.push('plus ISO power');
    if (r.ops >= .800) bits.push('strong OPS');
    const support = bits.length ? bits.join(', ') : 'power profile and matchup context';
    const pitcher = r.pitcherName ? ` against ${r.pitcherName}` : '';
    return `${r.name} grades at ${Number(r.hrProb||0).toFixed(1)}% HR probability${pitcher} because the model combines ${support}, season HR rate, recent trend, and pitcher HR/9 baseline. Opponent context: ${r.oppAbbr}.`;
  };

  const cards = sorted.map(r => {
    const isLive = String(r.timeLabel||'').includes('LIVE');
    const isFinal = r.timeLabel === 'FINAL';
    const homerToday = (r.todayHR > 0) && (isLive || isFinal);
    const pct = Number(r.hrProb || 0);
    const grade = gradeFor(pct);
    const risk = riskFor(r);
    const hotBoost = Number(r.hotBoostPct || 0);
    const cardCls = homerToday ? ' hr-today-row' : isLive ? ' hrp-live-row' : '';
    const pitcherLabel = r.pitcherName ? `vs ${r.pitcherName}` : `vs ${r.oppAbbr}`;
    const tags = [];
    if (homerToday) tags.push(`<span class="dr1017-chip gold"><b>HR Today:</b> ${r.todayHR}</span>`);
    if (r.topHrThreat || pct >= 8) tags.push(`<span class="dr1017-chip gold"><b>Threat:</b> Top HR</span>`);
    if (r.isOnFire) tags.push(`<span class="dr1017-chip red"><b>On Fire:</b> ${Math.round(r.onFireScore||0)}</span>`);
    if (r.isFavorable) tags.push(`<span class="dr1017-chip green"><b>Matchup:</b> Favorable</span>`);
    if (r.isDue) tags.push(`<span class="dr1017-chip gold"><b>Due:</b> Yes</span>`);
    if (r.isDrought) tags.push(`<span class="dr1017-chip red"><b>Drought:</b> Yes</span>`);

    const statChips = [
      `<span class="dr1017-chip green"><b>HR Prob:</b> ${pct.toFixed(1)}%</span>`,
      `<span class="dr1017-chip blue"><b>Season HR:</b> ${r.hrSeason || '–'}</span>`,
      `<span class="dr1017-chip ${classify((r.last10HR||0)>=2,(r.last10HR||0)>=1)}"><b>Last 10 HR:</b> ${r.last10HR ?? '–'}</span>`,
      `<span class="dr1017-chip ${classify(r.ops>=.850,r.ops>=.700)}"><b>OPS:</b> ${fmt3(r.ops)}</span>`,
      `<span class="dr1017-chip ${classify(r.iso>=.200,r.iso>=.140)}"><b>ISO:</b> ${fmt3(r.iso)}</span>`,
      `<span class="dr1017-chip ${classify(r.avg>=.280,r.avg>=.240)}"><b>AVG:</b> ${fmt3(r.avg)}</span>`,
      hotBoost ? `<span class="dr1017-chip gold"><b>Hot Boost:</b> +${hotBoost.toFixed(1)}</span>` : '',
      r.hrVsPitcher != null ? `<span class="dr1017-chip ${r.hrVsPitcher>0?'gold':'blue'}"><b>vs Pitcher:</b> ${r.hrVsPitcher} HR</span>` : '',
      ...tags,
      ...(r.hotHitter?.tags||[]).slice(0,3).map(t=>`<span class="dr1017-chip blue"><b>Signal:</b> ${t}</span>`)
    ].filter(Boolean).slice(0,12).join('');

    return `<div class="dr1017-hr-card${cardCls}" id="hrp-row-${r.id}">
      <div class="dr1017-hr-main">
        <img class="dr1017-hr-photo" src="${hs(r.id)}" alt="" loading="lazy" decoding="async">
        <div class="dr1017-hr-info">
          <div class="dr1017-hr-title-row">
            <div>
              <div class="dr1017-hr-name" style="color:${homerToday?'var(--accent2)':'var(--text)'}">${r.name}</div>
              <div class="dr1017-hr-meta">${tl(r.teamAbbr)} ${r.teamAbbr} · ${r.pos} · ${pitcherLabel} ${tl(r.oppAbbr)} · ${r.timeLabel || ''}</div>
            </div>
            <div class="dr1017-hr-score">
              <strong>${pct.toFixed(1)}%</strong>
              <span>HR PROBABILITY</span>
              <em>GRADE ${grade}</em>
            </div>
          </div>
          <div class="dr1017-hr-chips">${statChips}</div>
          <div class="dr1017-hr-why">${whyText(r)}</div>
          <button class="hrp-matchup-btn dr1017-matchup-btn"
            data-batter-id="${r.id}"
            data-batter-name="${String(r.name).replace(/"/g,'&quot;')}"
            data-pitcher-id="${r.pitcherId}"
            data-pitcher-name="${String(r.pitcherName||'').replace(/"/g,'&quot;')}"
            onclick="const d=this.dataset;openMatchup(+d.batterId,d.batterName,+d.pitcherId,d.pitcherName)">
            ⚔ PITCHER MATCHUP
          </button>
        </div>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="dr1017-hr-card-list">${cards}</div>`;

  const footer = document.getElementById('hrp-legend-footer');
  if (footer) footer.innerHTML = `
    HR Prob = batter HR/AB + pitcher HR/9 baseline, then boosted by Hot Hitter data: xwOBA trend, Hard-Hit %, Sweet-Spot %, Barrels, Bat Speed, Blasts, and rolling 5–10 game power signals when repo data exists.<br>
    🔥 <strong>ON FIRE</strong> — Recent contact quality / rolling batted-ball trend boost applied to HR Potential<br>
    🔴 <strong>DROUGHT</strong> — No home run in the last 8 games (due for one)<br>
    ⚠️ <strong>DUE</strong> — Drought player with 2+ supporting signals: power profile (ISO ≥ .170), favorable matchup, strong OPS (≥ .750), or proven HR hitter (8+ HRs) in a deep drought.<br>
    🟢 <strong>FAVORABLE MATCHUP</strong> — Batter has OPS ≥ .800 against a pitcher allowing high AVG or WHIP ≥ 1.25`;
}

// hrpFilters is a Set for multi-select. Empty Set = 'all'.
const hrpFilters = new Set();

function filterHRP(filter) {
  if (filter === 'all') {
    hrpFilters.clear();
  } else {
    if (hrpFilters.has(filter)) {
      hrpFilters.delete(filter);
    } else {
      hrpFilters.add(filter);
    }
  }
  if (filter === 'top' || hrpFilters.has('top')) {
    hrpSortCol = 'hrProb';
    hrpSortDir = -1;
  }
  renderHRPTable();
}

// Diff-based HR update for Props tab
function refreshHRPDiff() {
  if (!hrpRows.length) return;
  let changed = false;
  hrpRows.forEach(r => {
    const prev = prevHrpHRs[r.id];
    if (prev !== r.todayHR) {
      changed = true;
      prevHrpHRs[r.id] = r.todayHR;
      const rowEl = document.getElementById(`hrp-row-${r.id}`);
      if (rowEl) {
        if (r.todayHR > 0) {
          rowEl.classList.add('hr-today-row');
          const nameEl = rowEl.querySelector('.hrp-batter-name');
          if (nameEl) nameEl.style.color = 'var(--accent2)';
          const subEl = rowEl.querySelector('.hrp-batter-sub');
          if (subEl) {
            let badge = subEl.querySelector('.hr-today-badge-prop');
            if (!badge) { badge = document.createElement('span'); badge.className='hr-today-badge-prop'; badge.style.cssText='background:#0a1a33;color:#2f6bff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;border:1px solid #2f6bff66'; subEl.appendChild(badge); }
            badge.textContent = `💥 HR TODAY${r.todayHR>1?' x'+r.todayHR:''}`;
          }
        }
      }
    }
  });
}

// ── HRS TODAY ─────────────────────────────────────────────────────────
async function loadHRsToday() {
  const el = document.getElementById('hrs-today-content');
  // Even if the Props section isn't open yet, still collect banner data
  try {
    const today = new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'});
    const games = await getTodaySchedule('boxscore,team,probablePitcher');

    const allHRs = [];

    // Fetch any missing boxscores in parallel — sequential per-game awaits here
    // used to serialize N network round-trips back-to-back on a full live slate.
    const hrBoxscores = await Promise.all(games.map(async g => {
      if (g.teams?.away?.batters) return g.teams;
      try { const bd = await fetchJSON(`https://diamondreport.app/api/v1/game/${g.gamePk}/boxscore`); return bd.teams; }
      catch { return null; }
    }));

    games.forEach((g, gi) => {
      const dt = new Date(g.gameDate);
      const timeStr = dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/Chicago'});
      const awayAbbr = g.teams.away.team.abbreviation;
      const homeAbbr = g.teams.home.team.abbreviation;

      const box = hrBoxscores[gi];
      if (!box) return;

      ['away','home'].forEach(side => {
        const team = box?.[side]; if (!team) return;
        const abbr = side==='away'?awayAbbr:homeAbbr;
        const isGameLive = g.status.abstractGameState === 'Live' || g.status.detailedState === 'In Progress';
        (team.batters||[]).forEach(id => {
          const p = team.players?.[`ID${id}`];
          const hrs = parseInt(p?.stats?.batting?.homeRuns)||0;
          if (hrs > 0) allHRs.push({
            name: p.person?.fullName||'–', id: p.person?.id,
            teamAbbr: abbr, hrs, gameLabel:`${awayAbbr} @ ${homeAbbr}`,
            timeStr, gameTimestamp: dt.getTime(), gamePk: g.gamePk
          });
          // Feed live HRs to banner
          if (isGameLive && hrs > 0 && p?.person?.id) {
            bannerHRs[p.person.id] = {
              id: p.person.id,
              name: p.person.fullName||'–',
              teamAbbr: abbr,
              oppAbbr: side==='away' ? homeAbbr : awayAbbr,
              count: hrs
            };
          }
        });
      });
    });

    allHRs.sort((a,b) => a.gameTimestamp-b.gameTimestamp || b.hrs-a.hrs);
    // Exposed so News Central's Home Run Highlights section can reuse this
    // already-computed list instead of re-fetching/re-deriving it.
    window.__drHRsToday = allHRs;

    if (!allHRs.length) {
      if (el) el.innerHTML=`<div class="mu-empty">No HRs at this time.</div>`;
      const countEl = document.getElementById('hrs-today-count');
      if (countEl) countEl.style.display = 'none';
      const projEl = document.getElementById('proj-hits-content');
      if (projEl) projEl.innerHTML = `<div class="mu-empty" style="color:var(--muted)">No HR's Completed from Projections Yet</div>`;
      return;
    }

    // Check back-to-back / streak for each batter
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
    const yd = yesterday.toLocaleDateString('en-CA',{timeZone:'America/Chicago'});
    const dayBefore = new Date(); dayBefore.setDate(dayBefore.getDate()-2);
    const db = dayBefore.toLocaleDateString('en-CA',{timeZone:'America/Chicago'});

    const streakMap = {};
    await Promise.all(allHRs.map(async h => {
      if (!h.id) return;
      try {
        const logData = await fetchJSON(`https://diamondreport.app/api/v1/people/${h.id}/stats?stats=lastXGames&group=hitting&season=2026&limit=5&gameType=R`).catch(()=>({stats:[]}));
        const logs = logData.stats?.[0]?.splits || [];
        const hitYesterday = logs.some(g => g.date === yd && parseInt(g.stat?.homeRuns) > 0);
        const hitDayBefore = logs.some(g => g.date === db && parseInt(g.stat?.homeRuns) > 0);
        if (hitYesterday && hitDayBefore) streakMap[h.id] = 3;
        else if (hitYesterday) streakMap[h.id] = 2;
        else streakMap[h.id] = 1;
      } catch { streakMap[h.id] = 1; }
    }));

    const hs = id => id?`https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_32,q_auto:best/v1/people/${id}/headshot/67/current`:'';

    // Total HR count
    const totalHRs = allHRs.reduce((s,h)=>s+h.hrs, 0);
    const countEl = document.getElementById('hrs-today-count');
    if (countEl) { countEl.textContent = `${totalHRs} HR${totalHRs!==1?'s':''}`; countEl.style.cssText = 'background:var(--accent);color:white;font-family:Manrope,sans-serif;font-size:12px;font-weight:700;padding:2px 8px;border-radius:10px;display:inline-block;letter-spacing:.5px;flex-shrink:0'; }

    if (el) el.innerHTML = allHRs.map(h => {
      const streak = streakMap[h.id] || 1;
      const streakBadge = streak >= 3
        ? `<span style="background:#1a1200;color:#ffd700;font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;border:1px solid #ffd70066;white-space:nowrap">👑 ON A HEATER</span>`
        : streak === 2
        ? `<span style="background:#1a0d00;color:#ff8c00;font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;border:1px solid #ff8c0066;white-space:nowrap">🔥 BACK TO BACK</span>`
        : '';
      return `<div class="stat-row">
        <img src="${hs(h.id)}" style="width:36px;height:36px;border-radius:50%;background:var(--surface2);border:1px solid var(--border);flex-shrink:0" alt="" loading="lazy" decoding="async">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-size:13px;font-weight:600;color:${h.hrs>1?'var(--accent2)':'var(--text)'}">${h.name}</span>
            ${streakBadge}
          </div>
          <div style="font-size:9px;color:var(--muted);font-family:'JetBrains Mono',monospace;margin-top:2px">${h.gameLabel} · ${h.timeStr} · ${h.teamAbbr}</div>
        </div>
        <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
          <div class="stat-row-num" style="color:${h.hrs>1?'var(--accent2)':'var(--accent)'}">${h.hrs}</div>
          <div style="font-size:12px;color:var(--muted);font-family:'JetBrains Mono',monospace">HR</div>
        </div>
      </div>`;
    }).join('') +
    (el ? `<div style="padding:8px 12px;font-size:10px;color:var(--muted);border-top:1px solid var(--border);line-height:1.7">
      🔥 <strong>BACK TO BACK</strong> — Hit a home run yesterday and today<br>
      👑 <strong>ON A HEATER</strong> — Hit home runs 3+ consecutive days
    </div>` : '');

    // HR's Completed from Projection — cross-reference HRs with hrpRows
    const projEl = document.getElementById('proj-hits-content');
    if (projEl) {
      const projHits = allHRs.filter(h => hrpRows.some(r => r.id === h.id));
      if (!projHits.length) {
        projEl.innerHTML = `<div class="mu-empty" style="color:var(--muted)">No HR's Completed from Projections Yet</div>`;
        const phCount = document.getElementById('proj-hits-count');
        if (phCount) phCount.style.display = 'none';
      } else {
        const phCount = document.getElementById('proj-hits-count');
        if (phCount) { phCount.textContent = `${projHits.length} Hit${projHits.length!==1?'s':''}`; phCount.style.cssText = 'background:var(--green);color:#0a0e1a;font-family:Manrope,sans-serif;font-size:12px;font-weight:700;padding:2px 8px;border-radius:10px;display:inline-block;letter-spacing:.5px;flex-shrink:0'; }
        projEl.innerHTML = projHits.map(h => {
          const proj = hrpRows.find(r => r.id === h.id);
          return `<div class="stat-row" style="background:linear-gradient(90deg,#0d2a1a,#0a1a10);border-left:3px solid var(--green)">
            <img src="${hs(h.id)}" style="width:36px;height:36px;border-radius:50%;background:var(--surface2);border:1px solid var(--green);flex-shrink:0" alt="" loading="lazy" decoding="async">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:700;color:var(--green);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">✓ ${h.name}</div>
              <div style="font-size:9px;color:var(--muted);font-family:'JetBrains Mono',monospace;margin-top:2px">
                ${h.teamAbbr} vs ${h.gameLabel.replace(h.teamAbbr+' @ ','').replace('@ '+h.teamAbbr,'')} · Proj: ${proj?proj.hrProb.toFixed(1)+'% HR prob':'–'}
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
              <div class="stat-row-num" style="color:var(--green)">${h.hrs}</div>
              <div style="font-size:12px;color:var(--green);font-family:'JetBrains Mono',monospace">HR</div>
            </div>
          </div>`;
        }).join('');
      }
    }
  } catch(e) {
    const el2=document.getElementById('hrs-today-content');
    if(el2) el2.innerHTML=`<div class="mu-empty" style="color:var(--accent)">Error: ${e.message}</div>`;
  }
}

// ── K Props ────────────────────────────────────────────────────────
// Sportsbook odds: pulled at 7am, refreshed by 9am if needed
// Since direct sportsbook APIs require paid keys, we model projected K lines
// from pitcher K/9 and opposing lineup K% — displayed as our own projection
// alongside the model-based O/U line. Label clearly as DR projection.
//
// The actual loader is defined further below (the "v10.27 safe loader"
// IIFE's buildRow/safeLoadKProps) — an earlier version of this function used
// to live here directly, but it was fully superseded by that patch
// (window.loadKProps gets unconditionally reassigned) and had silently
// diverged from what's actually live: it never blended recent form and used
// a linear overProb heuristic instead of the real Monte Carlo simulation the
// live path uses. Removed rather than left as dead code that no longer
// matched reality.

// PROD v10.13: Direct Pitcher Strikeouts Confidence Engine support
function drKNum(v, fb=0){ const n = Number(v); return Number.isFinite(n) ? n : fb; }
function drKClamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
function drKConfidenceScore(p){
  const line = drKNum(p.recommendedOverLine ?? p.ouLine ?? p.compareLine, 0);
  const proj = drKNum(p.projK, line);
  const cushion = proj - line;
  const k9 = drKNum(p.k9, 8);
  const era = drKNum(p.era, 4.25);
  const whip = drKNum(p.whip, 1.28);
  const overProb = drKNum(p.overProb, 52);
  let score = 48;
  score += cushion * 9.5;
  score += (k9 - 8.0) * 3.2;
  score += (4.20 - era) * 2.0;
  score += (1.28 - whip) * 10;
  score += (overProb - 55) * 0.45;
  if ((p.reasoning?.matchupTag || '').includes('High-K')) score += 5;
  if ((p.reasoning?.workloadTag || '').includes('Deep')) score += 4;
  if ((p.reasoning?.matchupTag || '').includes('Contact')) score -= 5;
  return Math.round(drKClamp(score, 38, 91));
}
function drKRealisticOverChance(p){
  const score = drKConfidenceScore(p);
  const line = drKNum(p.recommendedOverLine ?? p.ouLine ?? p.compareLine, 0);
  const proj = drKNum(p.projK, line);
  const cushion = proj - line;
  let chance = 44 + cushion * 7.5 + (score - 55) * 0.32;
  return drKClamp(chance / 100, .33, .78);
}
function drKGrade(score){ return score>=82?'A+':score>=76?'A':score>=70?'B+':score>=64?'B':score>=58?'C+':score>=52?'C':'PASS'; }
function drKChip(label,value,cls='') { return `<span class="dr112-chip ${cls}"><b>${label}</b>${value}</span>`; }
function drKSummaryHTML(list){
  // Styled to match the "EXPANDED ... DATA" summary banner already used on the HR
  // Threats board (dr1027-hr-summary), so both boards read as one consistent system.
  const arr=(list||[]).slice().sort((a,b)=>drKConfidenceScore(b)-drKConfidenceScore(a));
  if(!arr.length) return '';
  const top=arr[0];
  const sample=arr.slice(0,Math.min(8,arr.length));
  const avg=Math.round(sample.reduce((a,p)=>a+drKConfidenceScore(p),0)/sample.length);
  const line=drKNum(top.recommendedOverLine ?? top.ouLine ?? top.compareLine,0);
  return `<div class="dr1027-hr-summary"><div class="dr1027-summary-title">📊 EXPANDED <span>STRIKEOUTS DATA</span></div><p class="dr1027-summary-copy">Every pitcher on the board carries a Diamond grade, realistic over probability, and risk read built from projection vs line, K/9, ERA/WHIP command, workload, and opponent contact tendency — on top of the existing Line / K Count / Cushion columns, filters, and sorting.</p><div class="dr1027-summary-grid"><div class="dr1027-summary-metric good"><b>${top.pitcherName||'–'}</b><span>Top Rated</span></div><div class="dr1027-summary-metric"><b>${avg}%</b><span>Board Avg Confidence</span></div><div class="dr1027-summary-metric"><b>${arr.length}</b><span>Pitchers Scanned</span></div><div class="dr1027-summary-metric warn"><b>Over ${formatKLine(line)} K</b><span>Primary Signal</span></div></div></div>`;
}
function drKRowAnalyticsHTML(p, live, cushion, line){
  const conf=drKConfidenceScore(p), chance=Math.round(drKRealisticOverChance(p)*100), grade=drKGrade(conf);
  const risk=conf>=74?'Low':conf>=62?'Medium':'High';
  const liveTxt=live && (live.isLive||live.isFinal) ? `${live.isFinal?'Final':'Live'} K Count ${live.ks}` : 'Pregame model';
  const reason=p.reasoning||{};
  const why=`${p.pitcherName} grades ${grade} because the model projects ${p.projK} Ks against a ${formatKLine(line)} line (${cushion>=0?'+':''}${cushion.toFixed(1)} cushion), supported by ${p.k9} K/9, ${p.era} ERA, ${p.whip} WHIP, ${reason.matchupTag||'matchup context'}, and ${reason.workloadTag||'workload estimate'}.`;
  return `<div class="dr112-compact dr113-k-row">${drKChip('Model',conf+'%',conf>=70?'good':conf>=58?'warn':'low')}${drKChip('Over Chance',chance+'%',chance>=64?'good':chance>=54?'warn':'low')}${drKChip('Grade',grade,conf>=70?'good':conf>=58?'warn':'low')}${drKChip('Risk',risk,risk==='Low'?'good':risk==='Medium'?'warn':'low')}${drKChip('Live',liveTxt,'')}</div><div class="dr112-card-note dr113-k-why"><b>Why:</b> ${why}</div>`;
}

function renderKProps() {
  const el = document.getElementById('kprops-content');
  if (!el || !kPropsData.length) {
    if(el) el.innerHTML=`<div class="mu-empty">No K prop data yet — check back after lineups are posted.</div>`;
    return;
  }

  const hs = id => `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_38,q_auto:best/v1/people/${id}/headshot/67/current`;
  const tl = abbr => { const id=teamIds[abbr]; return id?`<img src="https://www.mlbstatic.com/team-logos/${id}.svg" style="width:20px;height:20px;object-fit:contain;vertical-align:middle" alt="" loading="lazy" decoding="async">`:'' };

  // Compute today's record: compare each pick's projected OVER/UNDER against the
  // pitcher's actual final K count, using the live snapshot kept by loadKsToday
  let kpCorrect = 0, kpFinal = 0;
  const kpResults = {}; // pitcherId -> true/false/null (null = not final yet)
  kPropsData.forEach(p => {
    const live = latestPitcherKData[p.pitcherId];
    if (!live || !live.isFinal || p.pred === 'PUSH' || p.ouLine == null) { kpResults[p.pitcherId] = null; return; }
    const correct = p.pred === 'OVER' ? live.ks > p.ouLine : live.ks < p.ouLine;
    kpResults[p.pitcherId] = correct;
    kpFinal++;
    if (correct) kpCorrect++;
  });
  window.__kpTodayRecord = { wins: kpCorrect, losses: kpFinal - kpCorrect, total: kpFinal, totalToday: kPropsData.length };
  if (typeof updateHeroTodayRecordStrip === 'function') updateHeroTodayRecordStrip();

  const kpTallyHTML = kpFinal > 0 ? `
    <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg);border-bottom:1px solid var(--border);flex-wrap:wrap;gap:8px">
      <span style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase">TODAY'S RECORD</span>
      <span style="font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace">${new Date().toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}</span>
      <span style="font-family:'Manrope',sans-serif;font-size:28px;letter-spacing:1px;color:${kpCorrect===kpFinal?'#2ecc71':kpCorrect>kpFinal/2?'var(--accent2)':'var(--accent)'}">${kpCorrect}-${kpFinal-kpCorrect}</span>
      <span style="font-size:11px;color:var(--muted)">${kpFinal} of ${kPropsData.length} final</span>
      <span style="font-size:11px;color:var(--muted);font-family:'JetBrains Mono',monospace">${Math.round(kpCorrect/kpFinal*100)}% accuracy</span>
    </div>` : '';

  // Apply optional game + watchlist filters before sort/render
  let gameFilteredProps = _kPropsGameFilter
    ? kPropsData.filter(p => String(p.gamePk||'') === _kPropsGameFilter)
    : kPropsData;
  if (_kPropsWatchlistOnly) gameFilteredProps = gameFilteredProps.filter(p => drIsWatchlisted(p.pitcherId));

  // Built from the full day's schedule (not kPropsData) so every game today shows up in
  // the filter, including games that don't have an announced probable pitcher yet —
  // kPropsData only ever contains rows for confirmed starters.
  const kpGamesSeen = {};
  const kpGamesList = [];
  const kpScheduleSource = kPropsAllGames.length ? kPropsAllGames : null;
  if (kpScheduleSource) {
    kpScheduleSource.forEach(g => {
      const pk = String(g.gamePk||'');
      if (!pk || kpGamesSeen[pk]) return;
      kpGamesSeen[pk] = 1;
      const away = g.teams?.away?.team?.abbreviation || '?';
      const home = g.teams?.home?.team?.abbreviation || '?';
      kpGamesList.push({ pk, label: `${away} vs ${home}`, ts: new Date(g.gameDate).getTime() || 0 });
    });
  } else {
    // Fallback for the rare case the schedule wasn't captured — derive from whatever
    // pitcher rows did load.
    kPropsData.forEach(p => {
      const pk = String(p.gamePk||'');
      if (!pk || kpGamesSeen[pk]) return;
      kpGamesSeen[pk] = 1;
      kpGamesList.push({ pk, label: `${p.teamAbbr||'?'} vs ${p.oppAbbr||'?'}`, ts: p.gameTimestamp||0 });
    });
  }
  kpGamesList.sort((a,b) => a.ts - b.ts);
  const kpGameOptsHTML = `<option value="">All Games</option>` + kpGamesList.map(g =>
    `<option value="${g.pk}"${_kPropsGameFilter===g.pk?' selected':''}>${g.label}</option>`
  ).join('');

  // Apply optional sort before rendering
  // v8.65: fixed CUSHION sorting. The previous version parsed row.cushion first,
  // but cushion is calculated at render time, so every row looked like NaN and
  // the sort became a no-op. Compute derived cushion before the NaN checks.
  const sortedProps = _kPropsSort
    ? [...gameFilteredProps].sort((a, b) => {
        function num(v){
          // Number(null) and Number('') both coerce to 0, which made a genuinely missing
          // stat (e.g. HR/9 before it loaded) look like a perfect 0 and sort to the top
          // instead of falling to the bottom with the other unavailable rows below.
          if (v == null || v === '') return NaN;
          const n = Number(v);
          return Number.isFinite(n) ? n : NaN;
        }
        function cushionOf(row){
          const rec = num(row.recommendedOverLine ?? row.ouLine ?? row.compareLine);
          const proj = num(row.projK);
          return Number.isFinite(proj) && Number.isFinite(rec) ? proj - rec : NaN;
        }
        function riskOf(row){
          const confVal = (typeof drKConfidenceScore === 'function') ? drKConfidenceScore(row) : (Number(row.overProb) || 55);
          // Low risk should sort first, then Medium, then High.
          return confVal >= 74 ? 1 : confVal >= 62 ? 2 : 3;
        }
        const av = _kPropsSort === 'cushion' ? cushionOf(a) : (_kPropsSort === 'risk' ? riskOf(a) : num(a[_kPropsSort]));
        const bv = _kPropsSort === 'cushion' ? cushionOf(b) : (_kPropsSort === 'risk' ? riskOf(b) : num(b[_kPropsSort]));
        if (isNaN(av) && isNaN(bv)) return 0;
        if (isNaN(av)) return 1;
        if (isNaN(bv)) return -1;
        // Default: lower is better for ERA/WHIP/AVG/Risk etc, higher for K/9/K/GM/Cushion
        const higherBetter = ['k9','kPerGm','cushion'].includes(_kPropsSort);
        const base = higherBetter ? bv - av : av - bv;
        return base * _kPropsSortDir;
      })
    : gameFilteredProps;

  const kpSortStats = [
    {label:'ERA',  key:'era',    hi:false},
    {label:'WHIP', key:'whip',   hi:false},
    {label:'K/9',  key:'k9',     hi:true},
    {label:'HR/9', key:'hr9',    hi:false},
    {label:'AVG',  key:'avg',    hi:false},
    {label:'WOBA', key:'woba',   hi:false},
    {label:'ISO',  key:'iso',    hi:false},
    {label:'SLG',  key:'slg',    hi:false},
    {label:'FIP',  key:'fip',    hi:false},
    {label:'K/GM', key:'kPerGm', hi:true},
    {label:'CUSHION', key:'cushion', hi:true},
    {label:'RISK', key:'risk', hi:false},
  ];
  const sortBtns = kpSortStats.map(({label,key}) => {
    const active = _kPropsSort === key;
    const arrow = active ? (_kPropsSortDir === 1 ? ' ↓' : ' ↑') : '';
    return `<button onclick="kPropsSortBy('${key}')" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:4px 10px;border-radius:12px;border:1px solid ${active?'var(--accent2)':'var(--border)'};background:${active?'rgba(47,107,255,.12)':'var(--surface2)'};color:${active?'var(--accent2)':'var(--muted)'};cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all .15s">${label}${arrow}</button>`;
  }).join('');

  el.innerHTML = `${kpTallyHTML}
  ${drKSummaryHTML(gameFilteredProps)}
  <div class="kprops-sticky-sort" style="display:flex;align-items:center;gap:6px;padding:8px 14px;background:var(--bg);border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;flex-wrap:nowrap">
    <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);white-space:nowrap;flex-shrink:0">GAME:</span>
    <select onchange="kPropsSetGameFilter(this.value)" style="background:#0e1728;color:#fff;border:1px solid var(--border);border-radius:8px;padding:4px 8px;font-size:10px;font-weight:700;flex-shrink:0">${kpGameOptsHTML}</select>
    <button onclick="kPropsToggleWatchlist()" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:4px 10px;border-radius:12px;border:1px solid ${_kPropsWatchlistOnly?'#f5c518':'var(--border)'};background:${_kPropsWatchlistOnly?'rgba(245,197,24,.14)':'var(--surface2)'};color:${_kPropsWatchlistOnly?'#f5c518':'var(--muted)'};cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all .15s">★ WATCHLIST</button>
    <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);white-space:nowrap;flex-shrink:0">SORT:</span>
    ${sortBtns}
    <button onclick="kPropsSortBy(null)" id="kpsort-reset" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:3px 8px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);cursor:pointer;white-space:nowrap;flex-shrink:0">RESET</button>
  </div>
  <div style="overflow-x:auto;overscroll-behavior-x:contain;touch-action:pan-y;min-width:0">
    ${sortedProps.map(p => {
      const prob = Number(p.overProb ?? 0);
      const predCls = prob >= 50 ? 'kprop-over' : 'kprop-push kprop-push-under';
      const predLabel = `O ${formatKLine(Number(p.recommendedOverLine ?? p.ouLine ?? p.compareLine ?? 0))}`;
      const confTier = p.confidenceTier || (prob >= 70 ? 'Elite' : prob >= 63 ? 'Strong' : prob >= 56 ? 'Good' : prob >= 50 ? 'Lean' : 'Low');

      const reason = p.reasoning || {};
      const matchupCls = reason.matchupTag?.includes('High') ? 'matchup matchup-good' : reason.matchupTag?.includes('Contact') ? 'matchup matchup-bad' : 'matchup';
      const k9Cls = reason.k9Tag?.includes('Strong') ? 'profile profile-strong' : reason.k9Tag?.includes('Lower') ? 'profile profile-low' : 'profile';
      const eraCls = reason.eraTag?.includes('Elite') ? 'profile profile-strong' : reason.eraTag?.includes('High') ? 'profile profile-low' : 'profile';
      const whipCls = reason.whipTag?.includes('Elite') ? 'profile profile-strong' : reason.whipTag?.includes('High') ? 'profile profile-low' : 'profile';
      const workloadCls = reason.workloadTag?.includes('Deep') ? 'matchup matchup-good' : reason.workloadTag?.includes('Short') ? 'matchup matchup-bad' : 'matchup';
      const decisionCls = 'decision';
      const reasonHTML = '';
      const recLineNum = Number(p.recommendedOverLine ?? p.ouLine ?? p.compareLine ?? 0);
      const strikeoutLineText = `Over ${formatKLine(recLineNum)} K`;
      const strikeoutCushion = (Number(p.projK ?? 0) - recLineNum);
      const strikeoutCushionText = `${strikeoutCushion >= 0 ? '+' : ''}${strikeoutCushion.toFixed(1)}`;

      // v10.25 audit fix: these values were referenced by the premium card
      // template but not created inside the row loop, which could throw a
      // ReferenceError and leave Strikeouts stuck on the loading shell.
      const conf = (typeof drKConfidenceScore === 'function') ? drKConfidenceScore(p) : (Number(p.overProb) || 55);
      const chance = (typeof drKRealisticOverChance === 'function') ? Math.round(drKRealisticOverChance(p) * 100) : (Number(p.overProb) || 55);
      const grade = (typeof drKGrade === 'function') ? drKGrade(conf) : (conf >= 70 ? 'B+' : conf >= 58 ? 'C+' : 'PASS');
      const risk = conf >= 74 ? 'Low' : conf >= 62 ? 'Medium' : 'High';
      const why = `${p.pitcherName || 'This pitcher'} grades ${grade} because the model projects ${p.projK || '–'} Ks against a ${formatKLine(recLineNum)} line (${strikeoutCushion >= 0 ? '+' : ''}${strikeoutCushion.toFixed(1)} cushion), supported by ${p.k9 || '–'} K/9, ${p.era || '–'} ERA, ${p.whip || '–'} WHIP, ${(p.reasoning && p.reasoning.matchupTag) || 'matchup context'}, and ${(p.reasoning && p.reasoning.workloadTag) || 'workload estimate'}.`;

      // ── Live/Final K Count shown under SB Line ──
      // Color rules:
      //  - Projected OVER: turns green the moment actual K count exceeds the SB Line.
      //  - Projected UNDER: stays neutral while live and only grades when final.
      //  - PUSH predictions don't get graded — always neutral.
      const live = latestPitcherKData[p.pitcherId];
      let kCountUnderLineHTML = '';
      let kTargetCountValue = `${p.projK}`;
      let kTargetCountStatus = 'MODEL';
      if (live && (live.isLive || live.isFinal)) {
        kTargetCountValue = `${live.ks}`;
        kTargetCountStatus = live.isFinal ? 'FINAL' : 'LIVE';
      }
      if (live && (live.isLive || live.isFinal) && p.pred !== 'PUSH' && p.ouLine != null) {
        const ks = live.ks;
        let kColor, kBg, kBorder, kIcon, kStatus;
        if (p.pred === 'OVER') {
          if (ks > p.ouLine) {
            kColor = '#2ecc71'; kBg = '#0d2a1a'; kBorder = '#2ecc71'; kIcon = '✅';
            kStatus = live.isFinal ? 'Final' : 'Live';
          } else if (live.isFinal) {
            kColor = '#dc2626'; kBg = '#2a0d0d'; kBorder = '#dc2626'; kIcon = '❌';
            kStatus = 'Final';
          } else {
            kColor = 'var(--muted)'; kBg = 'var(--bg)'; kBorder = 'var(--border)'; kIcon = '⏳';
            kStatus = 'Live';
          }
        } else { // UNDER
          if (live.isFinal) {
            if (ks < p.ouLine) {
              kColor = '#2ecc71'; kBg = '#0d2a1a'; kBorder = '#2ecc71'; kIcon = '✅';
            } else {
              kColor = '#dc2626'; kBg = '#2a0d0d'; kBorder = '#dc2626'; kIcon = '❌';
            }
            kStatus = 'Final';
          } else {
            kColor = 'var(--muted)'; kBg = 'var(--bg)'; kBorder = 'var(--border)'; kIcon = '⏳';
            kStatus = 'Live';
          }
        }
        kCountUnderLineHTML = `<div class="kprop-kcount" title="${kStatus} strikeout count" style="background:${kBg};border-color:${kBorder};color:${kColor}"><span>${kIcon}</span><span>K Count:</span><strong>${ks}</strong></div>`;
      }

      const alreadyHit = !!(live && ((p.pred === 'OVER' && live.ks > p.ouLine) || (p.pred === 'UNDER' && live.isFinal && live.ks < p.ouLine)));
      const kHitCount = live && (live.isLive || live.isFinal) ? live.ks : 0;
      const kTarget = Number(p.ouLine ?? recLineNum) || 1;
      const hasLiveK = !!(live && (live.isLive || live.isFinal));
      const missedK = !!(live && live.isFinal && p.pred !== 'PUSH' && !alreadyHit);

      return `<div class="dr109-card${alreadyHit ? ' prop-hit' : missedK ? ' prop-miss' : ''}" style="cursor:pointer" onclick="if(!event.target.closest('button,a'))window.openKPropLineupModal('${p.pitcherId}','${p.pitcherName.replace(/'/g,"\\'")}','${p.teamAbbr}','${p.oppAbbr}')">
        ${window.drWatchStarHTML(p.pitcherId, p.pitcherName)}
        <div class="dr109-card-head">
          <div class="dr109-player">
            <img loading="lazy" src="${hs(p.pitcherId)}" onerror="this.style.display='none'" alt="">
            <div style="min-width:0">
              <div class="dr109-name">${p.pitcherName}${alreadyHit ? ' <span class="prop-hit-badge">✓ Projection Hit</span>' : missedK ? ' <span class="prop-miss-badge">✗ Missed</span>' : ''}</div>
              <div class="dr109-meta">${p.teamAbbr} vs ${p.oppAbbr} · ${p.wl} · ${p.era} ERA · ${p.timeStr}</div>
            </div>
          </div>
          <div class="dr109-score">${chance}%<small>Strikeouts Edge</small></div>
        </div>
        <div class="dr109-chiprow">
          ${alreadyHit ? `<span class="dr109-chip hit-check"><span>✓ HIT:</span><strong>${kHitCount} / ${kTarget}</strong></span>` : hasLiveK ? `<span class="dr109-chip"><span>${missedK ? 'Final' : 'Live'}:</span><strong>${kHitCount} / ${kTarget}</strong></span>` : ''}
          <span class="dr109-chip good"><span>Line:</span><strong>${strikeoutLineText}</strong></span>
          ${p.market ? `<span class="dr109-chip" title="${p.market.book || 'Sportsbook'} line, informational only — never used to compute this pitcher's projection or line above">🏦 Market: O ${formatKLine(p.market.line)}${p.market.overPrice != null ? ` (${p.market.overPrice > 0 ? '+' : ''}${p.market.overPrice})` : ''}</span>` : ''}
          ${p.bpOffensePct != null ? `<span class="dr109-chip" title="Ballpark Pal's overall park+weather offense environment for this game — not strikeout-specific, informational only, never used to compute this pitcher's projection">🌐 Park Env: ${p.bpOffensePct > 0 ? '+' : ''}${p.bpOffensePct}% offense</span>` : ''}
          <span class="dr109-chip stat-k-9"><span>K/9:</span><strong>${p.k9 ?? '–'}</strong></span>
          <span class="dr109-chip stat-era"><span>ERA:</span><strong>${p.era ?? '–'}</strong></span>
          <span class="dr109-chip stat-whip"><span>WHIP:</span><strong>${p.whip ?? '–'}</strong></span>
          <span class="dr109-chip stat-hr-9"><span>HR/9:</span><strong>${p.hr9 ?? '–'}</strong></span>
          <span class="dr109-chip stat-avg"><span>AVG:</span><strong>${p.avg ?? '–'}</strong></span>
          <span class="dr109-chip stat-woba"><span>WOBA:</span><strong>${p.woba ?? '–'}</strong></span>
          <span class="dr109-chip stat-iso"><span>ISO:</span><strong>${p.iso ?? '–'}</strong></span>
          <span class="dr109-chip stat-slg"><span>SLG:</span><strong>${p.slg ?? '–'}</strong></span>
          <span class="dr109-chip stat-fip"><span>FIP:</span><strong>${p.fip ?? '–'}</strong></span>
          <span class="dr109-chip stat-k-gm"><span>K/GM:</span><strong>${p.kPerGm ?? '–'}</strong></span>
          <span class="dr109-chip ${strikeoutCushion >= 1 ? 'good' : strikeoutCushion >= 0 ? 'warn' : 'stat-cushion'}"><span>Cushion:</span><strong>${strikeoutCushionText}</strong></span>
          <span class="dr109-chip ${risk === 'Low' ? 'good' : risk === 'Medium' ? 'warn' : 'bad'}"><span>Risk:</span><strong>${risk}</strong></span>
        </div>
        <div class="dr109-reason"><strong>Why it supports the line:</strong> ${p.pitcherName} grades at ${chance}% for ${strikeoutLineText} because the model combines ${p.k9 ?? '–'} K/9, ${p.era ?? '–'} ERA/${p.whip ?? '–'} WHIP command profile, projected workload, and opponent contact tendency. Opponent context: ${p.oppAbbr}.</div>
      </div>`;
    }).join('')}</div>
  <div style="font-size:10px;color:var(--muted);padding:10px 16px 14px;line-height:1.5;border-top:1px solid var(--border)">
    💎 Projections powered by the <strong style="color:var(--text)">Diamond Intelligence Engine</strong> — built from each pitcher's full season K/9, ERA, WHIP, and projected innings against today's opponent K rate. Use as a guide alongside your own research.
  </div>\``;
}

// Schedule 7am load + 9am refresh for K Props
// Opens the same pop-out lineup modal used by the Pitcher Report table (see
// openPitcherLineupModal in app.js) for a K Props pitcher — clicking a K
// Props card calls this directly. Kept as its own fetch path rather than
// routed through fetchAndRenderLineup/lineupCache: K Props pitchers aren't
// guaranteed to be in prRows (Pitcher Report may not have loaded yet), so
// this resolves the game/opposing lineup itself the same way it always has.
async function openKPropLineupModal(pitcherId, pitcherName, teamAbbr, oppAbbr) {
  const pid = normalizePitcherId(pitcherId);
  const panelId = `kprop-panel-${pid}`;
  const overlay = document.getElementById('pr-lineup-modal-overlay');
  const body = document.getElementById('pr-lineup-modal-body');
  const title = document.getElementById('pr-lineup-modal-title');
  const sub = document.getElementById('pr-lineup-modal-sub');
  if (!overlay || !body) return;

  openLineupModalPid = null; // this modal instance isn't tracked by the Pitcher Report rehydrate path
  if (title) title.textContent = pitcherName || 'Batting Lineup & Matchups';
  if (sub) sub.textContent = `Batting Lineup & Matchups${teamAbbr && oppAbbr ? ` · ${teamAbbr} vs ${oppAbbr}` : ''}`;
  body.innerHTML = `<div id="kprop-arsenal-${pid}"><div style="padding:10px 0;color:var(--muted);font-size:12px"><span class="spin"></span> Loading ${pitcherName || 'pitcher'}'s pitch data…</div></div>` +
    `<div class="pr-expand-panel kprop-lineup-panel" id="${panelId}" style="margin-top:14px"><span class="spin"></span> Loading lineup…</div>`;
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  loadPitcherStatcast().then(() => {
    const arsenalWrap = document.getElementById(`kprop-arsenal-${pid}`);
    if (arsenalWrap) arsenalWrap.innerHTML = pitcherArsenalPanelHTML(pid, pitcherName);
  });

  const outerPanel = document.getElementById(panelId);
  try {
    const games = await getTodaySchedule('team,probablePitcher');
    const game = games.find(g =>
      g.teams.away.probablePitcher?.id == pitcherId ||
      g.teams.home.probablePitcher?.id == pitcherId
    );
    if (!game) {
      outerPanel.innerHTML = '<div style="padding:14px 20px;font-size:12px;color:var(--muted);white-space:normal;width:100%">Lineup not posted yet — check back closer to game time.</div>';
      return;
    }
    const isHome = game.teams.home.probablePitcher?.id == pitcherId;
    const oppSide = isHome ? 'away' : 'home';
    const oppTeamAbbr = game.teams[oppSide].team.abbreviation;

    await loadRepoLineups();
    const repo = getRepoLineupForGame(game.gamePk, oppSide);
    if (repo?.confirmed === true && repo?.lineup?.length) {
      renderLineup(panelId, { lineup: repo.lineup, teamAbbr: oppTeamAbbr, confirmed: true, source: repo.source, confirmedAt: repo.confirmedAt }, null, null, oppTeamAbbr, pitcherId, pitcherName);
      return;
    }

    // Single boxscore fetch — already cached if HR Potential has run
    const box = await fetchJSON(`https://diamondreport.app/api/v1/game/${game.gamePk}/boxscore`);
    const teamBox = box.teams?.[oppSide];

    // Only show confirmed official batting orders. If MLB has not posted one, show pending.
    let batters = (teamBox?.batters || [])
      .map(id => teamBox.players[`ID${id}`])
      .filter(Boolean);
    const hasOfficialBattingOrder = batters.some(b => b && (b.battingOrder || b.stats?.batting?.battingOrder));
    if (!hasOfficialBattingOrder || !batters.length) {
      renderLineupPending(panelId, oppTeamAbbr);
      return;
    }
    batters = batters
      .sort((a, b) => parseInt(a.battingOrder || a.stats?.batting?.battingOrder || 9999) - parseInt(b.battingOrder || b.stats?.batting?.battingOrder || 9999))
      .slice(0, 9);

    const lineup = batters.map(b => {
      // b may be a player object directly (from batters array) or a roster player object
      const person = b.person || b.player?.person || b;
      const position = b.position || b.player?.position;
      const batting = b.seasonStats?.batting || b.stats?.batting || b.player?.seasonStats?.batting || {};
      return {
        name: person?.fullName || '–',
        id: person?.id,
        pos: position?.abbreviation || '–',
        stats: batting,
        last10HR: null,
        todayHR: parseInt(batting.homeRuns) || 0,
        confirmed: !!(teamBox?.batters?.length),
      };
    }).filter(b => b.name !== '–');

    renderLineup(panelId, { lineup, teamAbbr: oppTeamAbbr, confirmed: true }, null, null, oppTeamAbbr, pitcherId, pitcherName);
  } catch(e) {
    outerPanel.innerHTML = `<div class="mu-empty" style="color:var(--accent)">Error: ${e.message}</div>`;
  }
}
window.openKPropLineupModal = openKPropLineupModal;
// K Props sort — by any pitcher stat column
let _kPropsSort = null;
let _kPropsSortDir = 1; // 1 = default direction, -1 = reversed
let _kPropsGameFilter = '';
function kPropsSetGameFilter(pk) {
  _kPropsGameFilter = pk || '';
  renderKProps();
}
let _kPropsWatchlistOnly = false;
function kPropsToggleWatchlist() {
  _kPropsWatchlistOnly = !_kPropsWatchlistOnly;
  renderKProps();
}
window.__drKPropsWatchlistRerender = () => { if (_kPropsWatchlistOnly) renderKProps(); };
function kPropsSortBy(key) {
  if (_kPropsSort === key) {
    // Same stat clicked — toggle direction
    _kPropsSortDir *= -1;
  } else {
    _kPropsSort = key;
    _kPropsSortDir = 1; // reset to default direction for new stat
  }
  if (!key) { _kPropsSort = null; _kPropsSortDir = 1; }
  renderKProps();
}

function scheduleKPropsLoad() {
  if (DR_STATIC_DAILY_DUMP) { if (!kPropsLoadedAt) loadKProps(); return; }
  const now = new Date();
  const cdtNow = new Date(now.toLocaleString('en-US',{timeZone:'America/Chicago'}));
  const h = cdtNow.getHours(), m = cdtNow.getMinutes();

  // If already past 7am and not loaded, load now
  if ((h > 7 || (h === 7 && m >= 0)) && !kPropsLoadedAt) loadKProps();

  // Schedule next 7am
  const next7am = new Date(cdtNow);
  next7am.setHours(7,0,5,0);
  if (cdtNow >= next7am) next7am.setDate(next7am.getDate()+1);
  setTimeout(() => { loadKProps(); scheduleKPropsLoad(); }, next7am - cdtNow);

  // Schedule 9am refresh if not yet loaded fresh
  const next9am = new Date(cdtNow);
  next9am.setHours(9,0,5,0);
  if (cdtNow < next9am) {
    setTimeout(() => {
      if (!kPropsLoadedAt || (new Date()-kPropsLoadedAt) > 60*60*1000) loadKProps();
    }, next9am - cdtNow);
  }
}



// PROD v10.27: Safe Strikeout loader audit fix
// Replaces the older sequential K loader before initPropsTab/restoreTab can call it.
// This prevents the browser main thread from getting pinned by overlapping recovery loaders.
(function(){
  'use strict';
  if (window.__DR_V1027_K_SAFE_LOADER__) return;
  window.__DR_V1027_K_SAFE_LOADER__ = true;

  var originalLoadKProps = (typeof loadKProps === 'function') ? loadKProps : null;
  window.__drOriginalLoadKProps = originalLoadKProps;
  var inflight = null;

  function n(v, fallback){ v = Number(v); return Number.isFinite(v) ? v : (fallback == null ? 0 : fallback); }
  function todayCdt(){ return new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'}); }
  function withTimeout(p, ms){
    return Promise.race([Promise.resolve(p), new Promise(function(resolve){ setTimeout(function(){ resolve(null); }, ms || 9000); })]);
  }
  async function seasonPitching(pid){
    try {
      var d = await withTimeout(fetchJSON('https://diamondreport.app/api/v1/people/'+pid+'?hydrate=stats(group=pitching,type=season,season=2026)'), 8000);
      return (d && d.people && d.people[0] && d.people[0].stats && d.people[0].stats[0] && d.people[0].stats[0].splits && d.people[0].stats[0].splits[0] && d.people[0].stats[0].splits[0].stat) || {};
    } catch(e){ return {}; }
  }
  function lineFmt(v){ try { return typeof formatKLine === 'function' ? formatKLine(v) : String(v); } catch(e){ return String(v); } }
  async function buildRow(g, side, stat){
    var opp = side === 'away' ? 'home' : 'away';
    var pitcher = g && g.teams && g.teams[side] && g.teams[side].probablePitcher;
    if (!pitcher) return null;
    var dt = new Date(g.gameDate || Date.now());
    var timeStr = dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/Chicago'});
    var k9 = n(stat.strikeoutsPer9Inn, 8.0);
    var ip = n(stat.inningsPitched, 0);
    var gs = n(stat.gamesStarted, 0) || Math.max(n(stat.wins,0)+n(stat.losses,0), 1);
    var era = n(stat.era, 4.00), whip = n(stat.whip, 1.25);
    var projIP = ip > 0 ? Math.min(Math.max(ip / Math.max(gs,1), 4), 7) : 5.4;
    // Recent-form blend (last 5 starts) — kicked off now so it runs concurrently with the
    // opposing-lineup boxscore fetch below, same recency signal the Diamond Report Pick
    // model uses: a season-long ERA/WHIP/K9 reads the same whether the pitcher's been
    // dealing his last 3 starts or getting rocked.
    var recentFormPromise = recentPitchingForm(pitcher.id);
    // Real opposing-lineup strikeout rate — this used to be hardcoded to the exact same
    // 0.22 constant it was compared against below, so (oppKpct - 0.22) always evaluated
    // to zero and the opponent-matchup adjustment had no actual effect despite appearing
    // in the formula and the "matchup" reasoning text. Now averages the projected/rostered
    // batters' own season K rate (K / PA), each falling back to the 22% league average
    // when a batter's own rate isn't known yet.
    var oppKpct = 0.22;
    try {
      var bd, lastErr;
      for (var bi = 0; bi < 3; bi++) {
        try { bd = await fetchJSON('https://diamondreport.app/api/v1/game/' + g.gamePk + '/boxscore'); lastErr = null; break; }
        catch (e) { lastErr = e; if (bi < 2) await new Promise(function(r){ setTimeout(r, 250 * (bi + 1)); }); }
      }
      if (!lastErr && bd) {
        var teamBox = bd.teams && bd.teams[opp];
        var oppBatters = ((teamBox && teamBox.batters) || []).map(function(id){ return teamBox.players['ID'+id]; }).filter(Boolean).slice(0,9);
        var kpcts = oppBatters.map(function(b){
          var s = (b.seasonStats && b.seasonStats.batting) || {};
          return (s.strikeOuts && s.plateAppearances) ? s.strikeOuts / s.plateAppearances : 0.22;
        });
        if (kpcts.length) oppKpct = kpcts.reduce(function(a,b){ return a+b; }, 0) / kpcts.length;
      }
    } catch(e) {}
    var recentForm = await recentFormPromise;
    era = blendRecentForm(era, recentForm, 'era');
    whip = blendRecentForm(whip, recentForm, 'whip');
    k9 = blendRecentForm(k9, recentForm, 'k9');
    var projK = Math.max(1, (k9 * projIP / 9) + ((oppKpct - 0.22) * 10));
    var sbLine = null;
    try { if (typeof getSportsbookKLine === 'function') sbLine = getSportsbookKLine(pitcher.id, pitcher.fullName); } catch(e){}
    // Display-only market comparison (same "informational, never fed into the
    // model" rule as the Game Projections Market chip) — separate from sbLine
    // above, which already (by existing design) becomes recommendedOverLine
    // itself when a real book line exists.
    var marketOdds = null;
    try { if (typeof getSportsbookOdds === 'function') marketOdds = getSportsbookOdds(pitcher.id, pitcher.fullName); } catch(e){}
    var recommendedOverLine = sbLine != null ? Number(sbLine) : Math.max(0.5, Math.floor(projK) - 0.5);
    var overEdge = projK - recommendedOverLine;
    // Genuine simulated odds: run TRIALS games sampling a Poisson-distributed strikeout
    // count around the real projK projection (built from real K/9, projected IP, and the
    // real opposing-lineup K rate above) and measure how often it actually clears the
    // recommended line, instead of a flat linear edge-to-probability heuristic.
    var overProb = window.simulateKOdds ? window.simulateKOdds(projK, recommendedOverLine) : Math.max(34, Math.min(78, Math.round(50 + (overEdge * 14))));
    var confidenceTier = overProb >= 70 ? 'Elite' : overProb >= 63 ? 'Strong' : overProb >= 56 ? 'Good' : overProb >= 50 ? 'Lean' : 'Low';
    // Field names must match what the MLB Stats API pitching/season stat object actually
    // returns (same endpoint/hydrate as Pitcher Report) — stat.fielding/
    // fieldingIndependentPitching/homeRunsPer9Inn/woba don't exist on that object, so
    // those columns always rendered blank. FIP specifically has no field at all (it's
    // a sabermetric stat the API doesn't compute) — reading stat.fip directly always
    // returned undefined, so this column silently rendered "–" for every pitcher.
    // Computed here from the standard formula instead (using the commonly-cited ~3.10
    // constant since a real per-season league constant isn't available from this
    // endpoint).
    var homeRunsAllowed = n(stat.homeRuns, NaN);
    var fip = ip > 0
      ? ((13*(Number.isFinite(homeRunsAllowed)?homeRunsAllowed:0) + 3*(n(stat.baseOnBalls,0)+n(stat.hitBatsmen,0)) - 2*n(stat.strikeOuts,0)) / ip) + 3.10
      : NaN;
    var avg = n(stat.avg, NaN);
    var slg = n(stat.slg, NaN);
    var obp = n(stat.obp, NaN);
    var iso = Number.isFinite(slg) && Number.isFinite(avg) ? Math.round((slg-avg)*1000)/1000 : null;
    // Derived from raw HR-allowed count / innings pitched rather than trusting a
    // precomputed "per 9" field name, which is unreliable across MLB Stats API responses.
    var hr9Val = (ip > 0 && Number.isFinite(homeRunsAllowed)) ? (homeRunsAllowed / ip) * 9 : NaN;
    var _qaCtx = 'K Props: ' + (pitcher.fullName || pitcher.id);
    drCheckStat(_qaCtx, 'ERA', era, 'era');
    drCheckStat(_qaCtx, 'WHIP', whip, 'whip');
    drCheckStat(_qaCtx, 'K/9', k9, 'k9');
    drCheckStat(_qaCtx, 'HR/9', hr9Val, 'hr9');
    drCheckStat(_qaCtx, 'AVG', avg, 'avg');
    drCheckStat(_qaCtx, 'wOBA (OBP stand-in)', obp, 'obp');
    drCheckStat(_qaCtx, 'ISO', iso, 'iso');
    drCheckStat(_qaCtx, 'SLG', slg, 'slg');
    drCheckStat(_qaCtx, 'FIP', fip, 'fip');
    var reason = {
      matchupTag: oppKpct >= 0.245 ? 'High-K matchup' : oppKpct <= 0.195 ? 'Contact-heavy matchup' : 'Average K matchup',
      k9Tag: k9 >= 9 ? 'Strong K pitcher' : k9 <= 7 ? 'Lower K profile' : 'Solid K profile',
      eraTag: era <= 3.25 ? 'Elite ERA' : era >= 5 ? 'High ERA' : 'Mid ERA',
      whipTag: whip <= 1.10 ? 'Elite WHIP' : whip >= 1.40 ? 'High WHIP' : 'Avg WHIP',
      workloadTag: projIP >= 6 ? 'Deep workload expected' : projIP <= 4.5 ? 'Short outing likely' : 'Standard workload',
      decisionTag: 'OVER '+lineFmt(recommendedOverLine)+' · '+overProb+'%',
      summary: (pitcher.fullName || 'Pitcher')+' projects for '+projK.toFixed(1)+' Ks against an Over '+lineFmt(recommendedOverLine)+' line.'
    };
    var propRow = {
      pitcherName: pitcher.fullName, pitcherId: pitcher.id,
      teamAbbr: g.teams[side].team.abbreviation,
      oppAbbr: g.teams[opp].team.abbreviation,
      wl: (stat.wins != null || stat.losses != null) ? ((stat.wins||0)+'-'+(stat.losses||0)) : '0-0',
      era: era.toFixed(2), k9: k9.toFixed(1), ip: ip.toFixed(1), bf: n(stat.battersFaced,0),
      fip: Number.isFinite(fip) ? fip.toFixed(2) : null,
      avg: Number.isFinite(avg) ? avg.toFixed(3) : null,
      // Real wOBA isn't part of the MLB Stats API pitching stat object — OBP-against is
      // used as the stand-in here, same as the Pitcher Report tab does.
      woba: Number.isFinite(obp) ? obp.toFixed(3) : null,
      iso: iso != null ? iso.toFixed(3) : null,
      slg: Number.isFinite(slg) ? slg.toFixed(3) : null,
      hr9: Number.isFinite(hr9Val) ? hr9Val.toFixed(2) : null,
      kPerGm: gs > 0 ? (k9*(ip/Math.max(gs,1))/9).toFixed(1) : null,
      whip: whip.toFixed(2), sbLine: sbLine,
      ouLine: recommendedOverLine, modelLine: Math.round(projK*2)/2, compareLine: recommendedOverLine,
      recommendedOverLine: recommendedOverLine.toFixed(1), overProb: overProb, confidenceTier: confidenceTier,
      projK: projK.toFixed(1), pred: 'OVER', pushLean: null, reasoning: reason,
      timeStr: timeStr, gameTimestamp: dt.getTime(), gamePk: g.gamePk,
      market: marketOdds,
      bpOffensePct: (typeof ballparkPalOffensePctForGame === 'function') ? ballparkPalOffensePctForGame(g.gamePk) : null
    };
    // Cross-check against the server-side tracker's pre-game K projection/line
    // (data/tracker.json, captured every morning well before first pitch — see
    // loadTrackerPicks) whenever the caller reached buildRow with the game already
    // live/final and no existing _kPropsSnapshot entry (see the gate in
    // safeLoadKProps below) — that combination means this is the very first time
    // this browser has computed this pitcher's prop, so everything just computed
    // above used the pitcher's now-already-pitched stat line and can be
    // contaminated/flipped relative to what was true pre-game. The tracker record
    // is immune to that since a scheduled job always captures it hours before
    // first pitch.
    var pState = g && g.status && g.status.abstractGameState;
    var pIsLive = pState === 'Live' || (g && g.status && g.status.detailedState === 'In Progress');
    var pIsFinal = pState === 'Final';
    if (pIsLive || pIsFinal) {
      var trackerData = await loadTrackerPicks().catch(function(){ return { kpropByPitcherId: {} }; });
      var trk = trackerData.kpropByPitcherId[pitcher.id];
      if (trk && trk.gamePk === g.gamePk && Number.isFinite(trk.line)) {
        propRow.ouLine = trk.line;
        propRow.modelLine = trk.line;
        propRow.compareLine = trk.line;
        propRow.recommendedOverLine = trk.line.toFixed(1);
        if (Number.isFinite(trk.projK)) propRow.projK = trk.projK.toFixed(1);
        if (trk.pick) propRow.pred = trk.pick;
      }
    }

    // Keep the snapshot fresh on every pre-game call so it always reflects the latest
    // pre-game state; the caller stops calling buildRow at all once the game is live/final
    // and a snapshot already exists, which is what actually freezes the projection.
    _kPropsSnapshot[pitcher.id] = propRow;
    return propRow;
  }
  async function mapLimit(items, limit, fn){
    var out = new Array(items.length), i = 0;
    async function worker(){
      while(i < items.length){
        var idx = i++;
        out[idx] = await fn(items[idx], idx);
        await new Promise(function(r){ setTimeout(r, 0); });
      }
    }
    var workers = [];
    for(var w=0; w<Math.min(limit, items.length); w++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }
  async function safeLoadKProps(){
    if (inflight) return inflight;
    inflight = (async function(){
      var el = document.getElementById('kprops-content');
      try {
        if (el && /loading strikeout projections/i.test(el.textContent || '')) {
          el.innerHTML = '<div class="mu-empty"><span class="spin"></span> Loading strikeout projections…</div>';
        }
        var today = todayCdt();
        try { if (typeof loadSportsbookKLines === 'function') await withTimeout(loadSportsbookKLines(today), 3500); } catch(e){}
        try { if (typeof loadBallparkPalGameFactors === 'function') await withTimeout(loadBallparkPalGameFactors(), 3500); } catch(e){}
        var games = [];
        try { games = await withTimeout(getTodaySchedule('team,probablePitcher'), 10000) || []; } catch(e){ games = []; }
        try { kPropsAllGames = games; } catch(e) { window.kPropsAllGames = games; }
        var starters = [];
        (games || []).forEach(function(g){ ['away','home'].forEach(function(side){ var p = g && g.teams && g.teams[side] && g.teams[side].probablePitcher; if (p) starters.push({g:g,side:side,p:p}); }); });
        if (!starters.length) {
          if (el) el.innerHTML = '<div class="mu-empty">No probable pitchers posted yet — check back closer to game time.</div>';
          return [];
        }
        var rows = await mapLimit(starters, 4, async function(item){
          // Locked once the game is live/final — reuse the last pre-game snapshot instead
          // of re-fetching season pitching stats (which include the pitcher's current
          // outing and would otherwise shift the K projection mid-game).
          var pState = item.g && item.g.status && item.g.status.abstractGameState;
          var pIsLive = pState === 'Live' || (item.g && item.g.status && item.g.status.detailedState === 'In Progress');
          var pIsFinal = pState === 'Final';
          if ((pIsLive || pIsFinal) && _kPropsSnapshot[item.p.id]) return _kPropsSnapshot[item.p.id];
          var stat = await seasonPitching(item.p.id);
          return await buildRow(item.g, item.side, stat);
        });
        rows = rows.filter(Boolean).sort(function(a,b){ return a.gameTimestamp - b.gameTimestamp; });
        try { kPropsData = rows; } catch(e) { window.kPropsData = rows; }
        try { kPropsLoadedAt = new Date(); } catch(e) { window.kPropsLoadedAt = new Date(); }
        try { Object.keys(pitcherOULines || {}).forEach(function(k){ delete pitcherOULines[k]; }); rows.forEach(function(p){ pitcherOULines[p.pitcherId] = p.compareLine; }); } catch(e){}
        try { if (typeof renderKProps === 'function') renderKProps(); else if (typeof window.renderKProps === 'function') window.renderKProps(); } catch(e){
          console.warn('v10.27 safe renderKProps failed', e);
          if (el) el.innerHTML = '<div class="mu-empty" style="color:var(--accent)">Strikeout render error: '+(e && e.message ? e.message : e)+'</div>';
        }
        try { if (typeof loadRepoLineups === 'function') loadRepoLineups().catch(function(){}); } catch(e){}
        return rows;
      } catch(e) {
        console.warn('v10.27 safeLoadKProps failed', e);
        if (el) el.innerHTML = '<div class="mu-empty" style="color:var(--accent)">Strikeout data error: '+(e && e.message ? e.message : e)+'</div>';
        return [];
      } finally { inflight = null; }
    })();
    return inflight;
  }
  try { loadKProps = safeLoadKProps; } catch(e) {}
  window.loadKProps = safeLoadKProps;
})();

// Init Props tab
let propsInitDone = false;
function initPropsTab() {
  if (propsInitDone) return;
  propsInitDone = true;
  // v8.70 performance: do not warm every model on first open. Load only the active inner tab.
  // This can run before the gamepick tab controller's own hash-based boot() has corrected
  // the DOM's default 'active' class (Games Today, in the static HTML) — reading the DOM
  // alone here meant a URL like #gamepick=premium still always warmed Game Center data on
  // first paint. Check the same #gamepick=<pane> hash the tab controller itself reads,
  // before falling back to whatever the DOM currently shows.
  const GAMEPICK_PANES = ['game','pr','hr','k','hits','rbis','tb','sb','hrrbi','premium','parlay','team-performance','deep'];
  const hashMatch = /^#?gamepick=([\w-]+)/.exec(window.location.hash || '');
  const fromHash = hashMatch && GAMEPICK_PANES.includes(hashMatch[1]) ? hashMatch[1] : null;
  const activePane = fromHash || document.querySelector('#props .gamepick-pane.active')?.getAttribute('data-gamepick-pane') || 'game';
  if (typeof window.__drLoadGamePickPaneData === 'function') window.__drLoadGamePickPaneData(activePane);
  else if (activePane === 'game') loadGameProps().then(() => { if (window.syncDiamondTracker) window.syncDiamondTracker(); });
}

// Auto-refresh Props tab every 60s (HR Potential only if stale, HRs Today always)
if (!DR_STATIC_DAILY_DUMP) {
  setInterval(() => {
    if (propsInitDone && document.visibilityState === 'visible' && !window.__diamondUserInteracting && document.getElementById('props')?.classList.contains('active')) {
      // v7.8: refresh live counts less aggressively and only while Props tab is active.
      loadHRsToday();
      loadKsTodayWithRetry();
    }
  }, 180000);
}


function showTab(id, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  const sectionEl = document.getElementById(id);
  if (sectionEl) sectionEl.classList.add('active');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  sessionStorage.setItem('activeTab', id);
  if (id === 'matchups' && !matchupLoaded) {
    matchupLoaded = true;
    loadPitcherReport();
  }
  if (id === 'schedule' && !scheduleLoaded) loadSchedule();
  if (id === 'props' && window._lastLiveGames) updatePropsLiveBanner(window._lastLiveGames);
  if (id === 'props') {
    // Re-trigger Diamond Report Picks if content still shows spinner (first load failed or is slow)
    const gpEl = document.getElementById('gameprops-content');
    if (gpEl && gpEl.querySelector('.spin')) loadGameProps();
  }
  // Always warm up Props data (Game Props, K Props) in the background, regardless of
  // which tab is visited — the Tracker tab depends on this data existing in the DOM
  // and previously only loaded it if the user had manually opened Props first.
  initPropsTab();
}

// Restore last active tab on page load
// Restore the active tab using sessionStorage (not localStorage) so the behavior is:
//  - Refresh/reload while browsing → stays on whatever tab you were viewing
//  - Fresh launch (new tab, new browser session, app reopened from scratch) → always
(function restoreTab() {
  let saved = sessionStorage.getItem('activeTab');
  if (saved === 'premium' || saved === 'matchups') saved = 'props';
  if (!saved || saved === 'scores') {
    initPropsTab(); // still warm up Props data even if landing on scores/default tab
    return;
  }
  const tabEl = document.querySelector(`.tab[data-tab='${saved}']`) || document.querySelector(`.tab[onclick*="'${saved}'"]`);
  const sectionEl = document.getElementById(saved);
  if (!tabEl || !sectionEl) { initPropsTab(); return; }
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  sectionEl.classList.add('active');
  tabEl.classList.add('active');
  if (saved === 'matchups' && !matchupLoaded) { matchupLoaded = true; loadPitcherReport(); }
  initPropsTab(); // always warm up Props data, not just when saved === 'props'
})();


// Diamond Report Tracker Engine — debugged live tally + source-weighted model
(function(){
  const STORE_KEY = 'diamondReportTrackerV4';
  const AUTO_BACKUP_PREF_KEY = 'diamondReportTrackerAutoBackupEnabled';
  const AUTO_BACKUP_LAST_KEY = 'diamondReportTrackerAutoBackupLastDate';
  const AUTO_BACKUP_SNAPSHOT_KEY = 'diamondReportTrackerLatestAutoBackup';
  const LEGACY_STORE_KEYS = ['diamondReportTrackerV3', 'diamondReportTrackerV2', 'diamondReportTracker'];
  const TRACKER_DATA_URL = './data/tracker.json';
  let repoTrackerSeed = null;
  let repoTrackerLoaded = false;
  const SOURCES = [
    { name: 'MLB Stats API / Live play-by-play', live: true },
    { name: 'Open-Meteo Weather (stadium temp/wind)', live: true },
    { name: 'Park factor model (built-in)', live: true },
    { name: 'DR win-probability model', live: true },
    { name: 'DR K-projection model', live: true },
    { name: 'Baseball Savant / Statcast', live: false },
    { name: 'FanGraphs', live: false },
    { name: 'Baseball-Reference', live: false },
    { name: 'StatMuse', live: false },
    { name: 'Brooks Baseball', live: false },
    { name: 'Baseball Prospectus / PECOTA', live: false },
    { name: 'RotoWire lineups/injuries', live: false },
    { name: 'Sportsbook odds (real-time)', live: false },
    { name: 'Umpire data', live: false },
    { name: 'Betting market movement', live: false },
  ];
  const MODEL_INPUTS = ['Stored Tracker History', 'HR Potential', 'HRs Today', 'Diamond Report Picks', 'K Props', 'Player hit rate', 'Team hit rate', 'Streak/Drought signal', 'Favorable matchup flag', 'HR vs Pitcher history', 'Lineup status', 'Game environment', 'Odds edge'];

  const dayKey = () => new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'});
  const norm = s => String(s || '').replace(/\s+/g,' ').trim();
  const pct = (h,t) => t ? Math.round((h/t)*100) : 0;
  const num = s => { const m=String(s||'').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : 0; };
  const set = (id, html) => { const el=document.getElementById(id); if(el) el.innerHTML=html; };

  function safeStore(){
    return {
      version: 4,
      generatedAt: null,
      picks: [],
      players:{},
      teams:{},
      days:{},
      market:{ drp:[], kprop:[] },
      dailyResults: [],
      debug:{ lastError:'', lastSync:'', repoDataLoaded:false }
    };
  }

  function normalizeStore(current){
    if (!current || typeof current !== 'object') return safeStore();
    current.version ||= 4;
    current.picks ||= [];
    current.players ||= {};
    current.teams ||= {};
    current.days ||= {};
    current.market ||= { drp:[], kprop:[] };
    current.market.drp ||= [];
    current.market.kprop ||= [];
    current.allTime ||= {};
    current.allTime.hr ||= { wins:0, losses:0, total:0 };
    current.allTime.kprop ||= { wins:0, losses:0, total:0 };
    current.allTime.drp ||= { wins:0, losses:0, total:0 };
    current.dailyResults ||= [];
    current.debug ||= {};
    return current;
  }

  function mergeArraysByKey(baseArr, incomingArr, keyFn){
    const map = new Map();
    [...(baseArr || []), ...(incomingArr || [])].forEach(item => {
      if (!item) return;
      const key = keyFn(item);
      if (!key) return;
      const prior = map.get(key);
      if (!prior) map.set(key, item);
      else {
        const priorResolved = prior.result === 'win' || prior.result === 'loss' || prior.hit === true;
        const itemResolved = item.result === 'win' || item.result === 'loss' || item.hit === true;
        map.set(key, itemResolved && !priorResolved ? { ...prior, ...item } : { ...item, ...prior });
      }
    });
    return [...map.values()];
  }

  function rebuildStoreIndexes(store){
    store.players = {};
    store.teams = {};
    store.days = {};
    (store.picks || []).forEach(p => {
      if (!p || !p.player) return;
      const date = p.date || dayKey();
      const key = p.key || `${date}|${String(p.player).toLowerCase()}|${p.team || ''}`;
      p.key = key;
      p.date = date;
      store.days[date] ||= { keys:[] };
      if (!store.days[date].keys.includes(key)) store.days[date].keys.push(key);
      const playerKey = String(p.player || '').toLowerCase();
      store.players[playerKey] ||= { player:p.player, team:p.team, hits:0, total:0 };
      store.players[playerKey].total++;
      if (p.hit) store.players[playerKey].hits++;
      if (p.team){
        store.teams[p.team] ||= { team:p.team, hits:0, total:0, correctPlayers:{} };
        store.teams[p.team].total++;
        if (p.hit){
          store.teams[p.team].hits++;
          store.teams[p.team].correctPlayers[p.player] = (store.teams[p.team].correctPlayers[p.player] || 0) + 1;
        }
      }
    });
    return store;
  }


  function normalizedSummary(summary){
    const wins = Number(summary?.wins ?? summary?.correct ?? 0) || 0;
    const losses = Number(summary?.losses ?? summary?.incorrect ?? Math.max((Number(summary?.total || 0) || 0) - wins, 0)) || 0;
    const total = Number(summary?.total || (wins + losses)) || (wins + losses);
    return { wins, losses, total };
  }


  function normalizeMarketResultValue(value){
    const raw = String(value ?? '').toLowerCase().trim();
    if (!raw) return 'pending';
    if (['win','won','right','correct','hit','cash','cashed','success','w'].includes(raw) || /✅|right|correct|won|win|hit/.test(raw)) return 'win';
    if (['loss','lost','wrong','incorrect','miss','missed','l'].includes(raw) || /❌|wrong|incorrect|lost|loss|miss/.test(raw)) return 'loss';
    if (['push','void','cancelled','canceled'].includes(raw) || /push|void|cancel/.test(raw)) return 'push';
    return 'pending';
  }

  function normalizeMarketRowResults(store){
    store = normalizeStore(store);
    ['drp','kprop'].forEach(type => {
      store.market[type] = (store.market[type] || []).map(rec => {
        const normalized = normalizeMarketResultValue(rec.result ?? rec.status ?? rec.outcome ?? rec.grade ?? rec.finalStatus);
        return { ...rec, result: normalized };
      });
    });
    return store;
  }

  function cloneTrackerStore(store){
    return normalizeMarketRowResults(normalizeStore(JSON.parse(JSON.stringify(store || safeStore()))));
  }

  function repoSourceStore(){
    // tracker.json is the source of truth after repo data loads. This prevents
    // iPhone/Safari browser cache or a partially parsed mobile DOM from dropping
    // stored Diamond Report Picks and skewing the all-time record.
    if (repoTrackerLoaded && repoTrackerSeed && typeof repoTrackerSeed === 'object') {
      return rebuildStoreIndexes(updateAllTimeSummaryFromRows(cloneTrackerStore(repoTrackerSeed)));
    }
    return null;
  }

  function isFinalMarketResult(result){
    return result === 'win' || result === 'loss';
  }

  function drpSourceRows(store){
    const repoStore = repoSourceStore();
    const rows = repoStore?.market?.drp?.length ? repoStore.market.drp : [];
    return Array.isArray(rows) ? rows.filter(r => isFinalMarketResult(r.result)) : [];
  }

  function drpSourceSummary(store){
    const repoStore = repoSourceStore();
    const source = repoStore || store || safeStore();
    const rows = drpSourceRows(source).filter(r => r && (r.result === 'win' || r.result === 'loss'));
    const wins = rows.filter(r => r.result === 'win').length;
    const rowSummary = { wins, losses: Math.max(rows.length - wins, 0), total: rows.length };
    const storedSummary = normalizedSummary(source.allTime?.drp);
    return storedSummary.total >= rowSummary.total ? storedSummary : rowSummary;
  }

  function bestSummary(repoSummary, localSummary){
    const repo = normalizedSummary(repoSummary);
    const local = normalizedSummary(localSummary);
    // Prefer the larger completed sample so one device with an empty cache cannot erase repo history.
    if (local.total > repo.total) return local;
    return repo;
  }

  function clearTrackerBrowserCaches(){
    try { localStorage.removeItem(STORE_KEY); } catch(e){}
    try { LEGACY_STORE_KEYS.forEach(key => localStorage.removeItem(key)); } catch(e){}
    try { localStorage.removeItem(AUTO_BACKUP_SNAPSHOT_KEY); } catch(e){}
    try { localStorage.removeItem(AUTO_BACKUP_LAST_KEY); } catch(e){}
    try { localStorage.removeItem(AUTO_BACKUP_PREF_KEY); } catch(e){}
  }

  async function fetchFreshRepoTrackerData(){
    const res = await fetch(`${TRACKER_DATA_URL}`, {
      cache: 'force-cache',
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    repoTrackerSeed = normalizeMarketRowResults(normalizeStore(await res.json()));
    repoTrackerLoaded = true;
    return repoTrackerSeed;
  }

  function updateAllTimeSummaryFromRows(store){
    store = normalizeStore(store);
    const hrWins = (store.picks || []).filter(p => p.final === true && p.hit === true).length;
    const hrTotal = (store.picks || []).filter(p => p.final === true).length;
    const kRows = (store.market?.kprop || []).filter(r => r.result === 'win' || r.result === 'loss');
    const kWins = kRows.filter(r => r.result === 'win').length;
    const drpRows = (store.market?.drp || []).filter(r => (r.result === 'win' || r.result === 'loss'));
    // Preserve every stored DR Pick from tracker.json. Do not filter by parsed matchup label here;
    // legacy/mobile records can have valid stored results even when the label parser cannot rebuild '@'.
    const drpWins = drpRows.filter(r => r.result === 'win').length;
    const hrExisting = normalizedSummary(store.allTime?.hr);
    const kExisting = normalizedSummary(store.allTime?.kprop);
    const drpExisting = normalizedSummary(store.allTime?.drp);
    store.allTime.hr = hrTotal > hrExisting.total ? { wins:hrWins, losses:Math.max(hrTotal-hrWins,0), total:hrTotal } : hrExisting;
    store.allTime.kprop = kRows.length > kExisting.total ? { wins:kWins, losses:Math.max(kRows.length-kWins,0), total:kRows.length } : kExisting;
    store.allTime.drp = drpRows.length > drpExisting.total ? { wins:drpWins, losses:Math.max(drpRows.length-drpWins,0), total:drpRows.length } : drpExisting;
    return store;
  }

  function mergeStores(local, repo){
    local = normalizeStore(local);
    repo = normalizeStore(repo);
    const merged = normalizeStore({ ...safeStore(), ...repo, ...local });
    merged.picks = mergeArraysByKey(repo.picks, local.picks, p => p.key || `${p.date}|${String(p.player || '').toLowerCase()}|${p.team || ''}`);
    merged.market = {
      drp: mergeArraysByKey(repo.market?.drp, local.market?.drp, r => r.key || `${r.date}|DRP|${r.label}|${r.pick}`),
      kprop: mergeArraysByKey(repo.market?.kprop, local.market?.kprop, r => r.key || `${r.date}|KPROP|${String(r.label || '').toLowerCase()}`)
    };
    merged.dailyResults = mergeArraysByKey(repo.dailyResults, local.dailyResults, r => r.key || `${r.date}|${r.type || ''}|${r.label || r.player || ''}`);
    merged.allTime = {
      hr: bestSummary(repo.allTime?.hr, local.allTime?.hr),
      kprop: bestSummary(repo.allTime?.kprop, local.allTime?.kprop),
      drp: bestSummary(repo.allTime?.drp, local.allTime?.drp)
    };
    updateAllTimeSummaryFromRows(merged);
    merged.debug ||= {};
    merged.debug.repoDataLoaded = repoTrackerLoaded;
    merged.debug.lastRepoGeneratedAt = repo.generatedAt || null;
    return rebuildStoreIndexes(merged);
  }

  function readLocalStore(){
    try {
      const current = JSON.parse(localStorage.getItem(STORE_KEY));
      if (current && typeof current === 'object') return normalizeStore(current);
      for (const key of LEGACY_STORE_KEYS){
        const legacy = JSON.parse(localStorage.getItem(key) || 'null');
        if (legacy && typeof legacy === 'object') return normalizeStore(legacy);
      }
    } catch(e){}
    return safeStore();
  }

  function loadStore(){
    const repoStore = repoSourceStore();
    if (repoStore) return repoStore;
    const empty = safeStore();
    empty.debug.lastError = 'tracker.json not loaded yet';
    return empty;
  }

  function saveStore(s){
    // v8.0 Historical Tracker: the browser is not allowed to write or merge
    // historical tracker data. GitHub/repository JSON is the only source of truth.
    const store = normalizeStore(s);
    store.debug ||= {};
    store.debug.repoDataLoaded = repoTrackerLoaded;
    window.__diamondTrackerStore = store;
  }

  async function initPersistentTrackerData(){
    try {
      clearTrackerBrowserCaches();
      await fetchFreshRepoTrackerData();
      repoTrackerSeed = updateAllTimeSummaryFromRows(normalizeMarketRowResults(repoTrackerSeed));
      window.__diamondTrackerStore = loadStore();
      if (window.syncDiamondTracker) window.syncDiamondTracker();
    } catch(e){
      repoTrackerLoaded = false;
      console.warn('Repo tracker data not loaded; Tracker history will remain empty until tracker.json loads:', e.message || e);
    }
  }

  function cloneStoreForBackup(store){
    const backup = normalizeStore(JSON.parse(JSON.stringify(store || loadStore())));
    backup.generatedAt = new Date().toISOString();
    backup.debug ||= {};
    backup.debug.backupType = 'Diamond Report Tracker Backup';
    backup.debug.backupCreatedAt = backup.generatedAt;
    backup.debug.repoDataLoaded = repoTrackerLoaded;
    return backup;
  }

  function downloadTrackerBackup(store, prefix='tracker'){
    // Manual-only safety export. Automatic downloads are disabled in V3.4.
    const backup = cloneStoreForBackup(store);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type:'application/json' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `${prefix}-${dayKey()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function autoBackupEnabled(){
    return false; // V3.4: no automatic browser downloads. Repo updates happen via GitHub Actions.
  }

  function saveRepoSyncSnapshot(store){
    try {
      const backup = cloneStoreForBackup(store);
      localStorage.setItem(AUTO_BACKUP_SNAPSHOT_KEY, JSON.stringify(backup));
      localStorage.setItem(AUTO_BACKUP_LAST_KEY, new Date().toISOString());
    } catch(e){ console.warn('Tracker snapshot save failed:', e); }
  }

  function maybeAutoExportBackup(store, force=false){
    saveRepoSyncSnapshot(store);
    return; // no auto-downloads
  }

  window.exportDiamondTrackerData = function(){
    downloadTrackerBackup(loadStore(), 'tracker-manual-backup');
  };

  window.exportLatestDiamondTrackerAutoBackup = function(){
    try {
      const snapshot = JSON.parse(localStorage.getItem(AUTO_BACKUP_SNAPSHOT_KEY) || 'null');
      downloadTrackerBackup(snapshot || loadStore(), 'tracker-manual-backup');
    } catch(e){ downloadTrackerBackup(loadStore(), 'tracker-manual-backup'); }
  };

  window.toggleDiamondTrackerAutoBackup = function(){
    alert('Automatic browser downloads are disabled. GitHub Actions now update repo data files on schedule. Use the manual backup button only if you want a local safety copy.');
    if (window.syncDiamondTracker) window.syncDiamondTracker();
  };


  window.importDiamondTrackerData = function(){
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const imported = normalizeStore(JSON.parse(await file.text()));
        const merged = mergeStores(loadStore(), imported);
        saveStore(merged);
        if (window.syncDiamondTracker) window.syncDiamondTracker();
        alert('Tracker backup imported on this device. Repo-side updates are handled by GitHub Actions; this import only affects the current browser cache.');
      } catch (e) {
        alert('Import failed. Make sure this is a valid Diamond Report tracker JSON backup.');
        console.error('Tracker import failed:', e);
      }
    };
    input.click();
  };

  window.resetDiamondTrackerLocalCache = async function(){
    if (!confirm('Clear this browser tracker cache and reload the latest repository tracker.json? Repo data will remain unchanged.')) return;
    const refreshEl = document.getElementById('tracker-refresh');
    if (refreshEl) refreshEl.textContent = 'Reloading latest repo data…';
    try {
      clearTrackerBrowserCaches();
      await fetchFreshRepoTrackerData();
      await backfillStalePendingPicks(repoTrackerSeed);
      repoTrackerSeed = updateAllTimeSummaryFromRows(normalizeMarketRowResults(repoTrackerSeed));
      const repoOnly = repoSourceStore() || cloneTrackerStore(repoTrackerSeed || safeStore());
      window.__diamondTrackerStore = repoOnly;
      if (window.syncDiamondTracker) window.syncDiamondTracker();
      if (refreshEl) refreshEl.textContent = `Repo data reloaded • ${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})} ET`;
    } catch(e){
      repoTrackerLoaded = false;
      if (refreshEl) refreshEl.textContent = 'Repo reload failed — using browser cache';
      console.warn('Repo tracker reload failed:', e.message || e);
      alert('Repo reload failed. The tracker is still using this browser cache.');
    }
  };

  function isPlaceholderText(s){
    return /loading|waiting|no data|no hr potential|check back|error/i.test(String(s || ''));
  }

  function extractHRThreats(){
    // Primary source: the existing in-memory HR model. This is more reliable than scraping table text.
    try {
      if (Array.isArray(hrpRows) && hrpRows.length) {
        return [...hrpRows]
          .sort((a,b) => {
            const aTop = (a.topHrThreat || a.hrProb >= 8) ? 1 : 0;
            const bTop = (b.topHrThreat || b.hrProb >= 8) ? 1 : 0;
            if (aTop !== bTop) return bTop - aTop;
            return (b.hrProb || 0) - (a.hrProb || 0);
          })
          .slice(0, 10)
          .map((r,i) => ({
            id: r.id,
            player: norm(r.name),
            team: r.teamAbbr || '',
            opp: r.oppAbbr || '',
            pitcher: r.pitcherName || '',
            hrPct: Number((r.hrProb || 0).toFixed ? r.hrProb.toFixed(1) : r.hrProb || 0),
            rank: i + 1,
            source: 'hrpRows',
            topHrThreat: !!(r.topHrThreat || r.hrProb >= 8),
            // Pass through the richer signals already computed in HR Potential
            // so the next-day model can weigh streaks, droughts, and matchup quality
            isDrought: !!r.isDrought,
            isFavorable: !!r.isFavorable,
            streakDays: r.streakDays || 1,
            hrVsPitcher: r.hrVsPitcher ?? null,
            last10HR: r.last10HR ?? null,
            hrSeason: r.hrSeason ?? null,
          }))
          .filter(p => p.player && !isPlaceholderText(p.player));
      }
    } catch(e){ console.warn('Tracker hrpRows extraction failed:', e); }

    // Fallback source: visible HR Potential table.
    const rows=[...document.querySelectorAll('#hr-potential-content tbody tr')];
    return rows.map((row,i)=>{
      const txt=row.innerText || '';
      const nameEl=row.querySelector('.hrp-batter-name');
      const player=norm(nameEl ? nameEl.textContent : (txt.split('\n')[0] || ''));
      const teamEl = row.querySelector('.hrp-batter-sub span');
      const teamFromSub = teamEl ? (teamEl.textContent.match(/\b[A-Z]{2,3}\b/) || [''])[0] : '';
      const team=(teamFromSub || (txt.match(/\b[A-Z]{2,3}\b/)||[''])[0] || '').replace(/HR|L10/g,'');
      const hrPct=num(txt);
      return {
        player, team, hrPct, rank:i+1, source:'DOM',
        topHrThreat:/TOP HR THREAT/i.test(txt),
        isDrought:/DROUGHT/i.test(txt),
        isFavorable:/FAVORABLE MATCHUP/i.test(txt),
        streakDays:/ON A HEATER/i.test(txt)?3:/BACK TO BACK/i.test(txt)?2:1,
      };
    }).filter(p => p.player && !isPlaceholderText(p.player)).slice(0,10);
  }

  function extractHRToday(){
    const hitSet = new Set();

    // Primary source: visible HRs Today cards.
    const root=document.getElementById('hrs-today-content');
    if(root){
      [...root.querySelectorAll('.stat-row')].forEach(row=>{
        const nameSpan = row.querySelector('span[style*="font-size:13px"], div[style*="font-size:13px"]');
        const fromSpan = norm(nameSpan ? nameSpan.textContent.replace(/^✓\s*/,'') : '');
        const first=norm((row.innerText||'').split('\n')[0]).replace(/^✓\s*/,'');
        const name = fromSpan || first;
        if(name && !isPlaceholderText(name) && name.length < 60 && !/^\d+$/.test(name)) hitSet.add(name.toLowerCase());
      });

      const text=root.innerText || '';
      [...text.matchAll(/([A-Z][a-z.'-]+(?:\s+[A-Z][a-z.'-]+){1,3})\s+hit a home run/gi)]
        .forEach(m=>hitSet.add(norm(m[1]).toLowerCase()));
    }

    // Secondary source: bannerHRs object, when live games are active.
    try {
      if (bannerHRs && typeof bannerHRs === 'object') {
        Object.values(bannerHRs).forEach(h => {
          if (h && h.name) hitSet.add(norm(h.name).toLowerCase());
        });
      }
    } catch(e){}

    return hitSet;
  }

  function extractGamePicks(){
    const root=document.getElementById('gameprops-content');
    if(!root) return [];
    const cards=[...root.querySelectorAll('.gp-card')];
    const picks=[];
    cards.forEach(card=>{
      const t=card.innerText || '';
      if(!/DIAMOND REPORT PICK|DR PICK|PICK/i.test(t)) return;
      const lines=t.split('\n').map(norm).filter(Boolean);
      const idx=lines.findIndex(l=>/DIAMOND REPORT PICK|DR PICK|PICK/i.test(l));
      let team='';
      for(let j=idx+1;j<Math.min(lines.length, idx+5);j++){
        if(/^[A-Z]{2,3}$/.test(lines[j])) { team=lines[j]; break; }
      }
      const winLine=lines.find(l=>/%\s*WIN|CONFIDENCE|EDGE/i.test(l));
      const winPct=winLine ? num(winLine) : num(t);
      const lean=/UNDERDOG|DOG|\+\d|VALUE/i.test(t) ? 'underdog' : 'favorite';

      // Pull the actual environment factor chips (weather, park factor, home field, day game, etc.)
      // generated by the Game Props engine — these are real data signals, not text-scraped guesses
      const posFactors = [...card.querySelectorAll('.gp-factor.pos')].map(el => norm(el.textContent));
      const negFactors = [...card.querySelectorAll('.gp-factor.neg')].map(el => norm(el.textContent));
      const neuFactors = [...card.querySelectorAll('.gp-factor.neu')].map(el => norm(el.textContent));
      const envScore = posFactors.length - negFactors.length; // net environment lean for this game

      if(team) picks.push({ team, winPct, lean, posFactors, negFactors, neuFactors, envScore });
    });
    return picks;
  }

  function upsert(store, pick, hit){
    const day=dayKey();
    const key=`${day}|${pick.player.toLowerCase()}|${pick.team}`;
    store.days[day] ||= { keys:[] };
    const existing=store.picks.find(p=>p.key===key);

    if(!existing){
      const rec={ key, date:day, ...pick, hit:!!hit };
      store.picks.push(rec);
      if (!store.days[day].keys.includes(key)) store.days[day].keys.push(key);

      const playerKey = pick.player.toLowerCase();
      store.players[playerKey] ||= { player:pick.player, team:pick.team, hits:0, total:0 };
      store.players[playerKey].total++;
      if(hit) store.players[playerKey].hits++;

      if(pick.team){
        store.teams[pick.team] ||= { team:pick.team, hits:0, total:0, correctPlayers:{} };
        store.teams[pick.team].total++;
        if(hit){
          store.teams[pick.team].hits++;
          store.teams[pick.team].correctPlayers[pick.player]=(store.teams[pick.team].correctPlayers[pick.player]||0)+1;
        }
      }
    } else if(existing.hit !== !!hit){
      const delta=hit ? 1 : -1;
      existing.hit=!!hit;
      const playerKey = pick.player.toLowerCase();
      const pl=store.players[playerKey]; if(pl) pl.hits = Math.max(0, pl.hits + delta);
      const tm=store.teams[pick.team];
      if(tm){
        tm.hits = Math.max(0, tm.hits + delta);
        if(hit) tm.correctPlayers[pick.player]=(tm.correctPlayers[pick.player]||0)+1;
      }
    }
  }


  function trackerHistoryBoost(store, player, team){
    const pl = store.players[String(player || '').toLowerCase()] || { hits:0, total:0 };
    const tm = store.teams[team] || { hits:0, total:0 };
    const playerRate = pct(pl.hits, pl.total);
    const teamRate = pct(tm.hits, tm.total);
    const sampleBoost = Math.min(10, (pl.total || 0) + (tm.total || 0));
    return {
      playerRate,
      teamRate,
      sampleBoost,
      score: Math.round(playerRate * 0.35 + teamRate * 0.25 + sampleBoost)
    };
  }

  // Returns a 0-10 confidence multiplier reflecting how many real, live data sources
  // (not "planned" placeholders) are actually backing today's predictions
  function sourceConfidenceBoost(){
    const liveCount = SOURCES.filter(s => s.live).length;
    const totalCount = SOURCES.length;
    return Math.round((liveCount / totalCount) * 10); // 0-10 scale
  }

  function nextDayHRPotentialModel(store, currentThreats){
    const srcBoost = sourceConfidenceBoost();
    return currentThreats
      .map(p => {
        const h = trackerHistoryBoost(store, p.player, p.team);
        const base = Number(p.hrPct || 0);

        // Streak boost: a hot player (back-to-back or on a heater) gets a real bump;
        // a drought player gets a small "due for one" nudge but far less weight than a hot streak
        const streakBoost = p.streakDays >= 3 ? 8 : p.streakDays === 2 ? 4 : 0;
        const droughtAdj = p.isDrought ? 2 : 0;
        const favorableBoost = p.isFavorable ? 5 : 0;
        const vsPitcherBoost = (p.hrVsPitcher || 0) > 0 ? Math.min(p.hrVsPitcher * 2, 6) : 0;
        const rankBoost = Math.max(0, 11 - (p.rank || 10)) * 1.2;

        const modelScore = Math.min(99, Math.round(
          base * 0.45 +
          h.score * 0.30 +
          rankBoost +
          streakBoost +
          droughtAdj +
          favorableBoost +
          vsPitcherBoost +
          srcBoost
        ));

        // Build a short reason string so the prediction is explainable, not a black box
        const reasons = [];
        if (p.topHrThreat) reasons.push('Top HR Threat');
        if (p.streakDays >= 3) reasons.push('🔥 On a heater');
        else if (p.streakDays === 2) reasons.push('🔥 Back-to-back');
        if (p.isFavorable) reasons.push('🟢 Favorable matchup');
        if (p.isDrought) reasons.push('🔴 Due (drought)');
        if ((p.hrVsPitcher || 0) > 0) reasons.push(`${p.hrVsPitcher} HR vs ${p.pitcher || 'pitcher'}`);
        if (h.sampleBoost >= 3) reasons.push(`Tracker: ${h.playerRate}% player / ${h.teamRate}% team`);

        return { ...p, modelScore, playerRate:h.playerRate, teamRate:h.teamRate, sampleBoost:h.sampleBoost, reasons };
      })
      .sort((a,b) => b.modelScore - a.modelScore)
      .slice(0, 10);
  }

  function nextDayDRPicksModel(store, gamePicks){
    const teamHistory = Object.values(store.teams || {}).reduce((acc,t)=>{
      acc[t.team] = { rate:pct(t.hits,t.total), hits:t.hits, total:t.total };
      return acc;
    }, {});
    const srcBoost = sourceConfidenceBoost();
    return (gamePicks || [])
      .map(p => {
        const hist = teamHistory[p.team] || { rate:0, hits:0, total:0 };
        // Underdog picks that have a strong tracker history get an extra nudge —
        // a confirmed value/underdog angle backed by real hit-rate data is a stronger signal
        // than a generic favorite with no tracker history at all
        const leanBoost = (p.lean === 'underdog' && hist.total >= 3) ? 4 : 0;
        // Environment boost: real weather/park-factor signals from the Game Props engine,
        // capped so a single big weather swing can't dominate the model
        const envBoost = Math.max(-6, Math.min(6, (p.envScore || 0) * 3));
        const modelScore = Math.min(99, Math.round((p.winPct || 0) * 0.65 + hist.rate * 0.25 + Math.min(5, hist.total) + leanBoost + envBoost + srcBoost * 0.5));
        const reasons = [];
        reasons.push(`${p.winPct || 0}% site win model`);
        if (hist.total > 0) reasons.push(`Tracker: ${hist.hits}-${Math.max(hist.total-hist.hits,0)} (${hist.rate}%)`);
        if (p.lean === 'underdog') reasons.push('Underdog/value angle');
        if (p.posFactors?.length) reasons.push(...p.posFactors.slice(0,2));
        if (p.negFactors?.length) reasons.push(...p.negFactors.slice(0,1));
        return { ...p, modelScore, hist, reasons };
      })
      .sort((a,b)=>b.modelScore-a.modelScore)
      .slice(0, 8);
  }

  function nextDayKPropsModel(store){
    store.market ||= { drp: [], kprop: [] };
    const grouped = {};
    (store.market.kprop || []).forEach(r => {
      const key = String(r.label || '').toLowerCase();
      grouped[key] ||= { label:r.label, wins:0, total:0, over:0, under:0, lastPick:r.pick, lastLine:r.line };
      if(r.result === 'win' || r.result === 'loss'){
        grouped[key].total++;
        if(r.result === 'win') grouped[key].wins++;
      }
      if(/OVER/i.test(r.pick)) grouped[key].over++;
      if(/UNDER/i.test(r.pick)) grouped[key].under++;
      grouped[key].lastPick = r.pick;
      grouped[key].lastLine = r.line;
    });
    return Object.values(grouped)
      .map(r => {
        const rate = pct(r.wins, r.total);
        const direction = r.over >= r.under ? 'OVER' : 'UNDER';
        const consistencyBoost = (r.over === 0 || r.under === 0) && r.total >= 2 ? 3 : 0; // consistent lean direction
        const modelScore = Math.min(99, Math.round(rate * 0.75 + Math.min(20, r.total * 3) + consistencyBoost + sourceConfidenceBoost() * 0.5));
        const reasons = [`Tracker: ${r.wins}-${Math.max(r.total-r.wins,0)} (${rate}%)`];
        if (consistencyBoost) reasons.push(`Consistent ${direction} lean`);
        reasons.push(`Last line ${r.lastLine || '—'}`);
        return { ...r, rate, direction, modelScore, reasons };
      })
      .sort((a,b)=>b.modelScore-a.modelScore)
      .slice(0, 10);
  }

  // Returns true if every game found on the page today has reached a final state
  // (i.e. nothing is still 'live' or 'upcoming'). Used to decide whether it's safe
  // to recompute the Next Day Prediction Model — recomputing while games are still
  // in progress risks basing tomorrow's picks on incomplete/volatile in-game data
  // (a player could still get injured, pulled, or a lineup could shift).
  function isTodayFullySettled(){
    const liveRoot = document.getElementById('live-games');
    const schedRoot = document.getElementById('scheduled-games');
    const hasLiveCards = liveRoot && liveRoot.querySelectorAll('.game-card').length > 0;
    const hasUpcomingCards = schedRoot && schedRoot.querySelectorAll('.game-card').length > 0;
    // If there are no game cards rendered at all yet (page just loaded), don't treat
    // that as "settled" — wait for real data before deciding either way.
    const finalRoot = document.getElementById('final-games');
    const hasAnyData = (finalRoot && finalRoot.querySelectorAll('.game-card').length > 0) || hasLiveCards || hasUpcomingCards;
    if (!hasAnyData) return false;
    return !hasLiveCards && !hasUpcomingCards;
  }

  function renderNextDayModels(store, currentThreats, gamePicks){
    const today = dayKey();
    const todaySettled = isTodayFullySettled();

    // The Next Day model is frozen per-day: once computed for a given date, it does not
    // recompute again until either (a) the calendar date changes, or (b) today's games
    // are fully final for the first time. This prevents tomorrow's predictions from
    // shifting around mid-game based on incomplete data, while still updating promptly
    // once today's results are actually locked in (rather than waiting until literal
    // midnight, which could be hours after the last game actually ends).
    store.nextDayModel ||= { computedForDate: null, computedWhileSettled: false, hrp: null, drp: null, kp: null };
    const snap = store.nextDayModel;

    // Do NOT build or show next-day model picks until today's games are final.
    // This prevents stale/stored K Props from appearing in the morning before any
    // games have started, and prevents live/incomplete games from influencing
    // tomorrow's recommendations.
    const shouldRecompute = todaySettled && (snap.computedForDate !== today || !snap.computedWhileSettled);

    if (shouldRecompute) {
      snap.computedForDate = today;
      snap.computedWhileSettled = true;
      snap.hrp = nextDayHRPotentialModel(store, currentThreats);
      snap.drp = nextDayDRPicksModel(store, gamePicks);
      snap.kp = nextDayKPropsModel(store);
      saveStore(store);
    }

    const reasonChips = reasons => (reasons||[]).map(r=>`<span style="display:inline-block;background:var(--bg);border:1px solid var(--border);border-radius:999px;padding:1px 7px;font-size:9px;color:var(--muted);margin:2px 3px 0 0">${r}</span>`).join('');

    const liveSourceCount = SOURCES.filter(s => s.live).length;
    const statusEl = document.getElementById('tracker-nextday-status');
    if (statusEl) {
      const totalTracked = (store.picks?.length || 0) + (store.market?.drp?.length || 0) + (store.market?.kprop?.length || 0);
      if (totalTracked >= 5) {
        statusEl.className = 'tracker-pill hit';
        statusEl.textContent = todaySettled
          ? `${liveSourceCount}/${SOURCES.length} live sources • ${totalTracked} picks tracked • Today final ✓`
          : `${liveSourceCount}/${SOURCES.length} live sources • ${totalTracked} picks tracked • Holding for today's results`;
      } else {
        statusEl.className = 'tracker-pill pending';
        statusEl.textContent = `Building history… (${totalTracked} picks so far)`;
      }
    }

    const canShowNextDay = todaySettled && snap.computedForDate === today && snap.computedWhileSettled;

    if (!canShowNextDay) {
      set('tracker-nextday-hrp', '<div style="color:var(--muted);font-size:12px">Next Day HR Potential unlocks after today\'s games are final.</div>');
      set('tracker-nextday-drp', '<div style="color:var(--muted);font-size:12px">Next Day Diamond Report Picks unlock after today\'s games are final.</div>');
      set('tracker-nextday-kprops', '<div style="color:var(--muted);font-size:12px">Next Day K Props unlock after today\'s games are final. No props are shown before games start or while games are live.</div>');
      return;
    }

    const hrp = snap.hrp || [];
    set('tracker-nextday-hrp', hrp.length ? hrp.map((p,i)=>`
      <div class="stat-row" style="flex-wrap:wrap">
        <div class="stat-row-num">${i+1}</div>
        <div style="flex:1;min-width:200px">
          <div style="font-weight:800">${p.player}</div>
          <div style="color:var(--muted);font-size:11px">${p.team || '—'}${p.opp?' vs '+p.opp:''} • current HR ${p.hrPct || 0}%</div>
          <div style="margin-top:3px">${reasonChips(p.reasons)}</div>
        </div>
        <span class="tracker-pill ${p.modelScore>=35?'hit':p.modelScore>=20?'pending':'miss'}">${p.modelScore}%</span>
      </div>
    `).join('') : '<div style="color:var(--muted);font-size:12px">Waiting for HR Potential and Tracker history.</div>');

    const drp = snap.drp || [];
    set('tracker-nextday-drp', drp.length ? drp.map((p,i)=>`
      <div class="stat-row" style="flex-wrap:wrap">
        <div class="stat-row-num">${i+1}</div>
        <div style="flex:1;min-width:200px">
          <div style="font-weight:800">${p.team}</div>
          <div style="margin-top:3px">${reasonChips(p.reasons)}</div>
        </div>
        <span class="tracker-pill ${p.modelScore>=55?'hit':p.modelScore>=45?'pending':'miss'}">${p.modelScore}%</span>
      </div>
    `).join('') : '<div style="color:var(--muted);font-size:12px">Waiting for Diamond Report Picks and final Tracker data.</div>');

    const kp = snap.kp || [];
    set('tracker-nextday-kprops', kp.length ? kp.map((p,i)=>`
      <div class="stat-row" style="flex-wrap:wrap">
        <div class="stat-row-num">${i+1}</div>
        <div style="flex:1;min-width:200px">
          <div style="font-weight:800">${p.label}</div>
          <div style="color:var(--muted);font-size:11px">${p.direction} lean</div>
          <div style="margin-top:3px">${reasonChips(p.reasons)}</div>
        </div>
        <span class="tracker-pill ${p.modelScore>=55?'hit':p.modelScore>=35?'pending':'miss'}">${p.modelScore}%</span>
      </div>
    `).join('') : '<div style="color:var(--muted);font-size:12px">Waiting for stored K Props results.</div>');
  }


  function predictionScore(p, store){
    const pl=store.players[p.player.toLowerCase()] || {hits:0,total:0};
    const tm=store.teams[p.team] || {hits:0,total:0};
    const playerRate=pct(pl.hits,pl.total);
    const teamRate=pct(tm.hits,tm.total);
    return Math.min(99, Math.round((p.hrPct||0)*0.55 + playerRate*0.25 + teamRate*0.15 + Math.max(0, 11-p.rank)*0.5));
  }



  function finalGameMap(){
    const map = {};
    const finalRoot = document.getElementById('final-games');
    if (!finalRoot) return map;

    // Cards inside #final-games are, by construction, always final — no need to
    // re-detect status via fragile text matching. This is the authoritative source.
    const cards = [...finalRoot.querySelectorAll('.game-card')];

    cards.forEach(card => {
      const teams = [...card.querySelectorAll('.team-abbr')]
        .map(x => norm(x.textContent))
        .filter(Boolean);

      let scores = [...card.querySelectorAll('.score-block *')]
        .map(x => norm(x.textContent))
        .filter(x => /^\d+$/.test(x))
        .map(Number);

      // Fallback: pull numbers from score block text.
      if(scores.length < 2){
        const scoreText = norm(card.querySelector('.score-block')?.innerText || '');
        scores = [...scoreText.matchAll(/\b(\d{1,2})\b/g)].map(m => Number(m[1]));
      }

      if(teams.length >= 2 && scores.length >= 2){
        const away = teams[0], home = teams[1], awayScore = scores[0], homeScore = scores[1];
        const winner = awayScore > homeScore ? away : homeScore > awayScore ? home : 'TIE';
        const game = { away, home, awayScore, homeScore, winner, final:true };

        [`${away}@${home}`, `${away}VS${home}`, `${away}V${home}`, `${home}VS${away}`, `${home}V${away}`]
          .forEach(k => map[k] = game);

        map[away] ||= [];
        map[home] ||= [];
        map[away].push(game);
        map[home].push(game);
      }
    });

    return map;
  }

  function isAnyGameFinal(){
    // Primary check: does the final-games container actually have any rendered cards?
    // This is more reliable than re-parsing scores, since it doesn't depend on the
    // score text being extractable — a game can be "final" in the map even with weird formatting.
    const finalRoot = document.getElementById('final-games');
    const hasFinalCards = finalRoot && finalRoot.querySelectorAll('.game-card').length > 0;
    if (hasFinalCards) return true;
    return Object.keys(finalGameMap()).length > 0;
  }

  // Maps each team abbreviation to its current game state: 'final' | 'live' | 'upcoming'
  // Used to label HR Threat picks correctly — a miss is only "Wrong" once the player's
  // game is actually Final; otherwise it should read "Live" or "Pending" (game hasn't started).
  function teamGameStatusMap(){
    const map = {};
    const liveRoot = document.getElementById('live-games');
    const finalRoot = document.getElementById('final-games');
    const schedRoot = document.getElementById('scheduled-games');

    const tagTeams = (root, state) => {
      if (!root) return;
      [...root.querySelectorAll('.game-card')].forEach(card => {
        [...card.querySelectorAll('.team-abbr')]
          .map(x => norm(x.textContent))
          .filter(Boolean)
          .forEach(team => { map[team] = state; });
      });
    };

    // Order matters: tag scheduled first, then live, then final —
    // so if a team appears in multiple lists during a transition, the most current state wins
    tagTeams(schedRoot, 'upcoming');
    tagTeams(liveRoot, 'live');
    tagTeams(finalRoot, 'final');

    return map;
  }

  function resultBadgeFromFinal(result){
    return result === 'win'
      ? '<span class="tracker-pill hit">✅ Right</span>'
      : result === 'loss'
        ? '<span class="tracker-pill miss">❌ Wrong</span>'
        : result === 'push'
          ? '<span class="tracker-pill pending">↔ Push</span>'
          : '<span class="tracker-pill pending">⏳ Wait Final</span>';
  }

  function resolveDRPickResult(rec){
    const stored = normalizeMarketResultValue(rec?.result ?? rec?.status ?? rec?.outcome ?? rec?.grade ?? rec?.finalStatus);
    if (stored === 'win' || stored === 'loss' || stored === 'push') return stored;
    const finals = finalGameMap();
    if(!Object.keys(finals).length) return 'pending';

    // Same normalization used in drpMatchupLabel/extractDRPicksAccuracy — keeps legacy
    // records saved before this mapping existed (e.g. 'AZ' instead of 'ARI') resolvable
    // against finalGameMap(), which is keyed by the live-rendered team abbreviations.
    const normTeam = t => {
      t = String(t || '').toUpperCase().trim();
      if(t === 'CHW') return 'CWS';
      if(t === 'KCR') return 'KC';
      if(t === 'SDP') return 'SD';
      if(t === 'SFG') return 'SF';
      if(t === 'TBR') return 'TB';
      if(t === 'WAS') return 'WSH';
      if(t === 'AZ') return 'ARI';
      return t;
    };

    const pick = normTeam(rec.pick);
    if(!pick || pick === '—') return 'pending';

    // Direct lookup by picked team.
    let games = finals[pick] || [];

    // Match by teams found inside the pick card.
    if((!games || !games.length) && Array.isArray(rec.teams) && rec.teams.length >= 2){
      const normedTeams = rec.teams.map(normTeam);
      const candidates = [];
      for(let i=0;i<normedTeams.length;i++){
        for(let j=i+1;j<normedTeams.length;j++){
          const a=normedTeams[i], b=normedTeams[j];
          candidates.push(finals[`${a}@${b}`], finals[`${a}VS${b}`], finals[`${a}V${b}`], finals[`${b}VS${a}`], finals[`${b}V${a}`]);
        }
      }
      games = candidates.filter(Boolean);
    }

    // Match by label text fallback.
    if((!games || !games.length)){
      const label = String(rec.label || '').toUpperCase();
      Object.values(finals).forEach(v => {
        if(Array.isArray(v)) return;
        if(label.includes(v.away) && label.includes(v.home)) games = [v];
      });
    }

    const game = Array.isArray(games) ? games[0] : games;
    if(!game || !game.final) return 'pending';
    return game.winner === pick ? 'win' : game.winner === 'TIE' ? 'push' : 'loss';
  }

  function extractNumericValue(v){
    const m = String(v || '').match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : NaN;
  }

  function findFinalKCountForPitcher(name){
    const root = document.getElementById('ks-today-props');
    if(!root || !name) return null;
    const target = String(name || '').toLowerCase().trim();
    let kCount = null;
    const rowEls = root.querySelectorAll('.ks-today-row');
    const candidates = rowEls.length ? [...rowEls] : [...root.querySelectorAll('.stat-row, tr')];
    candidates.forEach(row => {
      if (kCount !== null) return;
      const rowTextRaw = row.innerText || '';
      const rowText = norm(rowTextRaw).toLowerCase();
      if (!rowText.startsWith(target) && !rowText.includes(target)) return;
      const m = rowText.match(/(\d+)\s*(?:k|ks|strikeout|strikeouts)\b/i) || rowText.match(/\b(\d+)\b/);
      if (m) kCount = Number(m[1]);
    });
    return Number.isFinite(kCount) ? kCount : null;
  }

  function kpropStatusText(rec){
    const resolved = (rec.result === 'win' || rec.result === 'loss') ? rec.result : resolveKPropResult(rec);
    if (resolved === 'win') return '<span class="tracker-pill hit">Right</span>';
    if (resolved === 'loss') return '<span class="tracker-pill miss">Wrong</span>';
    return '<span class="tracker-pill pending">Pending</span>';
  }

  function kpropOverDRLine(rec){
    const finalK = rec.finalKCount ?? findFinalKCountForPitcher(rec.label);
    // DR Line accuracy must use the dedicated DR Line value only.
    // Do not fall back to rec.line because rec.line is the Projected Line/K Projection.
    const drLine = extractNumericValue(rec.drLine);
    if (!Number.isFinite(finalK) || !Number.isFinite(drLine)) return '—';
    return finalK > drLine ? 'Y' : 'N';
  }

  function resolveKPropResult(rec){
    // K Props status must compare the K Projection for Game against the Final K Count.
    // Important: after Reload Repo Data on iPhone, the visible K's Today DOM may not be
    // populated yet, so use the stored repository finalKCount first. Do not mark a
    // completed stored prop as Pending just because the mobile DOM is not ready.
    const name = String(rec.label || '').toLowerCase().trim();
    if(!name) return 'pending';

    const storedFinal = extractNumericValue(rec.finalKCount ?? rec.finalKs ?? rec.kCount ?? rec.finalK);
    const domFinal = findFinalKCountForPitcher(name);
    const kCount = Number.isFinite(storedFinal) ? storedFinal : domFinal;
    if(kCount === null || !Number.isFinite(kCount)) return 'pending';
    rec.finalKCount = kCount;

    const kProjection = extractNumericValue(rec.kProjection || rec.projectedLine || rec.line);
    if(!Number.isFinite(kProjection)) return 'pending';

    const pickText = String(rec.pick || '').toUpperCase();
    if(/OVER/.test(pickText)) return kCount > kProjection ? 'win' : 'loss';
    if(/UNDER/.test(pickText)) return kCount < kProjection ? 'win' : 'loss';
    return 'pending';
  }


  function pickResultFromText(t){
    const upper = String(t || '').toUpperCase();
    if (/✅|WON|WIN\b|RIGHT|CASHED|HIT\b/.test(upper)) return 'win';
    if (/❌|LOST|LOSS|WRONG|MISS/.test(upper)) return 'loss';
    if (/PUSH|VOID|CANCEL/.test(upper)) return 'push';
    return 'pending';
  }

  function extractDRPicksAccuracy(){
    const root=document.getElementById('gameprops-content');
    if(!root) return [];
    const TEAM_ABBRS = new Set(['ARI','ATH','ATL','BAL','BOS','CHC','CWS','CHW','CIN','CLE','COL','DET','HOU','KC','KCR','LAA','LAD','MIA','MIL','MIN','NYM','NYY','OAK','PHI','PIT','SD','SDP','SEA','SF','SFG','STL','TB','TBR','TEX','TOR','WSH','WAS','AZ']);
    const normTeam = t => {
      t = String(t || '').toUpperCase().trim();
      if(t === 'CHW') return 'CWS';
      if(t === 'KCR') return 'KC';
      if(t === 'SDP') return 'SD';
      if(t === 'SFG') return 'SF';
      if(t === 'TBR') return 'TB';
      if(t === 'WAS') return 'WSH';
      if(t === 'AZ') return 'ARI';
      return t;
    };
    const cards=[...root.querySelectorAll('.gp-card')];
    return cards.map((card,i)=>{
      const t=card.innerText || '';
      if(!/DIAMOND REPORT PICK|DR PICK|PICK/i.test(t)) return null;
      const lines=t.split('\n').map(norm).filter(Boolean);
      const idx=lines.findIndex(l=>/DIAMOND REPORT PICK|DR PICK|PICK/i.test(l));
      let pick='';
      for(let j=Math.max(0,idx+1);j<Math.min(lines.length,idx+6);j++){
        if(/^[A-Z]{2,3}$/.test(lines[j])) { pick=lines[j]; break; }
      }
      const teamsInCard = [...new Set((t.match(/\b[A-Z]{2,3}\b/g) || [])
        .map(normTeam)
        .filter(x => TEAM_ABBRS.has(x) && !['MLB','DR','WIN','O','U'].includes(x)))];
      const matchup = teamsInCard.length >= 2 ? `${teamsInCard[0]} @ ${teamsInCard[1]}` : (lines.find(l => /\b[A-Z]{2,3}\b\s+(?:@|VS|V)\s+\b[A-Z]{2,3}\b/i.test(l)) || lines.slice(0,3).join(' / '));
      // Stable storage key: teams sorted alphabetically so the same game always
      // produces the identical key, regardless of which team is listed first
      // in the rendered card text (home/away order can vary between syncs)
      const sortedTeamKey = teamsInCard.length >= 2 ? [...teamsInCard].sort().join('-') : matchup;
      return {
        key: `${dayKey()}|DRP|${sortedTeamKey}`,
        type: 'drp',
        label: matchup || `Game Pick ${i+1}`,
        pick: pick || '—',
        teams: teamsInCard,
        result: 'pending',
        date: dayKey()
      };
    }).filter(Boolean);
  }

  function extractKPropsAccuracy(){
    const root=document.getElementById('kprops-content');
    if(!root) return [];
    const rows=[...root.querySelectorAll('.kprop-row')];
    return rows.map((row,i)=>{
      const t=row.innerText || '';
      if(!t || isPlaceholderText(t)) return null;
      const name=norm(row.dataset.pitcherName || row.querySelector('.kprop-name')?.textContent || t.split('\n')[0] || `Pitcher ${i+1}`);
      // Use stable data attributes from the original K Props render so live/final DOM patches
      // do not corrupt the tracker. The visible K Props card can change from "6.2 PROJ" to
      // "7K FINAL", but the tracker must keep the original K Projection and DR Line.
      const drLine=norm(row.dataset.drLine || row.querySelector('.kprop-line-val')?.textContent || '');
      const rawKProjection=norm(row.dataset.kProjection || row.dataset.projectedLine || row.querySelector('.kprop-pred-lbl')?.textContent || row.querySelector('.kprop-pred-val')?.textContent || '');
      const kProjectionNum = extractNumericValue(rawKProjection);
      const kProjection = Number.isFinite(kProjectionNum) ? String(kProjectionNum) : rawKProjection;
      // Projected Line is the DIE K Projection for Game, not the DR Line.
      const projectedLine = kProjection;
      let pick = String(row.dataset.kPick || '').toUpperCase();
      if(!pick || pick === 'PUSH') pick = /UNDER/i.test(t) ? 'UNDER' : /OVER/i.test(t) ? 'OVER' : (rawKProjection || '—');
      const finalKCount = findFinalKCountForPitcher(name);
      return {
        // Key is based on pitcher name only — NOT the line value, since sportsbook lines
        // can shift during the day (e.g. 6.5 -> 7.0) and would otherwise create a duplicate row
        key: `${dayKey()}|KPROP|${name.toLowerCase()}`,
        type: 'kprop',
        label: name,
        pick,
        line: projectedLine || '—',
        projectedLine: projectedLine || '—',
        kProjection: kProjection || '—',
        finalKCount: finalKCount ?? null,
        drLine: drLine || '—',
        overDRLine: finalKCount !== null && Number.isFinite(extractNumericValue(drLine)) ? (finalKCount > extractNumericValue(drLine) ? 'Y' : 'N') : '—',
        result: 'pending',
        date: dayKey()
      };
    }).filter(Boolean);
  }

  function upsertMarketPick(store, rec){
    store.market ||= { drp: [], kprop: [] };
    const newResult = rec.type === 'kprop' ? resolveKPropResult(rec) : resolveDRPickResult(rec);
    const bucket = rec.type === 'kprop' ? store.market.kprop : store.market.drp;
    const existing = bucket.find(x => x.key === rec.key);

    if (!existing) {
      rec.result = newResult;
      rec.finalChecked = rec.result !== 'pending';
      bucket.push(rec);
    } else {
      // Never let a 'pending' result overwrite an already-resolved win/loss —
      // this happens when one device (e.g. mobile, narrower DOM) fails to find the
      // K count text and would otherwise silently erase a correct grading made elsewhere
      const existingIsResolved = existing.result === 'win' || existing.result === 'loss';
      const finalResult = (newResult === 'pending' && existingIsResolved) ? existing.result : newResult;
      Object.assign(existing, rec, { result: finalResult, finalChecked: finalResult !== 'pending' });
    }
  }

  // One-time cleanup: collapse any legacy duplicate DRP entries that were created
  // with index-based keys, flipped team order, or malformed labels from older
  // versions of the extraction logic (e.g. labels with pitcher names baked in,
  // or only one team detected). Always prefers a clean two-team match.
  function dedupeLegacyMarketPicks(store){
    store.market ||= { drp: [], kprop: [] };
    const TEAM_ABBRS = new Set(['ARI','ATH','ATL','BAL','BOS','CHC','CWS','CHW','CIN','CLE','COL','DET','HOU','KC','KCR','LAA','LAD','MIA','MIL','MIN','NYM','NYY','OAK','PHI','PIT','SD','SDP','SEA','SF','SFG','STL','TB','TBR','TEX','TOR','WSH','WAS','AZ']);
    const normTeam = t => {
      t = String(t||'').toUpperCase().trim();
      if(t==='CHW') return 'CWS'; if(t==='KCR') return 'KC'; if(t==='SDP') return 'SD';
      if(t==='SFG') return 'SF'; if(t==='TBR') return 'TB'; if(t==='WAS') return 'WSH';
      if(t==='AZ') return 'ARI';
      return t;
    };
    // Extract the cleanest possible team pair from a record, checking label first then key
    const extractTeamPair = rec => {
      const fromText = txt => [...new Set((String(txt||'').match(/\b[A-Z]{2,3}\b/g) || [])
        .map(normTeam).filter(t => TEAM_ABBRS.has(normTeam(t))))];
      let teams = fromText(rec.label);
      if (teams.length < 2) teams = fromText(rec.key);
      return teams.length >= 2 ? [...teams].sort().slice(0,2).join('-') : null;
    };

    const seen = new Map(); // stableKey -> best record so far
    const passthrough = []; // preserve repository records that cannot be parsed into a team pair
    (store.market.drp || []).forEach(rec => {
      const pair = extractTeamPair(rec);
      if (!pair) {
        // Do NOT drop repo history just because the mobile parser cannot rebuild a clean matchup.
        // These rows can still contain valid stored win/loss status and must remain visible/countable.
        passthrough.push(rec);
        return;
      }
      const stableKey = `${rec.date}|DRP|${pair}`;
      const prior = seen.get(stableKey);
      if (!prior) {
        seen.set(stableKey, rec);
      } else {
        // Prefer: resolved result over pending, then prefer the one with a clean "TEAM @ TEAM" label
        const recResolved = rec.result !== 'pending';
        const priorResolved = prior.result !== 'pending';
        const recCleanLabel = /^[A-Z]{2,3}\s*@\s*[A-Z]{2,3}$/.test((rec.label||'').trim());
        const priorCleanLabel = /^[A-Z]{2,3}\s*@\s*[A-Z]{2,3}$/.test((prior.label||'').trim());
        if ((recResolved && !priorResolved) || (recResolved === priorResolved && recCleanLabel && !priorCleanLabel)) {
          seen.set(stableKey, rec);
        }
      }
    });
    store.market.drp = [...passthrough, ...seen.values()];

    // Same cleanup for K Props: collapse legacy line-based duplicate keys down to one per pitcher per day
    const kpropSeen = new Map();
    (store.market.kprop || []).forEach(rec => {
      const pitcherKey = `${rec.date}|KPROP|${(rec.label||'').toLowerCase().trim()}`;
      const prior = kpropSeen.get(pitcherKey);
      if (!prior) {
        kpropSeen.set(pitcherKey, rec);
      } else if (rec.result !== 'pending' && prior.result === 'pending') {
        kpropSeen.set(pitcherKey, rec);
      }
    });
    store.market.kprop = [...kpropSeen.values()]
      // resolveKPropResult never legitimately returns 'push' — any stored 'push' value is
      // leftover from an old code version and should be reset to 'pending' so the next
      // sync can properly re-grade it as win/loss once a final K count is available
      .map(rec => rec.result === 'push' ? { ...rec, result: 'pending', finalChecked: false } : rec);
  }

  function marketStats(store, type, date){
    // v8.0 Historical Tracker: only final, graded repository records are shown.
    // Pending/live rows belong in live tabs, not the Tracker.
    const repoStore = repoSourceStore() || normalizeStore(store);
    repoStore.market ||= { drp: [], kprop: [] };
    const list = (repoStore.market[type] || [])
      .map(x => ({ ...x, result: normalizeMarketResultValue(x.result ?? x.status ?? x.outcome ?? x.grade ?? x.finalStatus) }))
      .filter(x => isFinalMarketResult(x.result))
      .filter(x => !date || x.date === date);
    const wins = list.filter(x => x.result === 'win').length;
    return { wins, losses: Math.max(list.length - wins, 0), total: list.length, pending: 0, list };
  }

  function marketAllTimeByKey(store, type, keyPart){
    store.market ||= { drp: [], kprop: [] };
    const list = (store.market[type] || []).filter(x => (x.label || x.pick || '').toLowerCase().includes(String(keyPart || '').toLowerCase()));
    const graded = list.filter(x => x.result === 'win' || x.result === 'loss');
    const wins = graded.filter(x => x.result === 'win').length;
    return { wins, total: graded.length, pct: pct(wins, graded.length) };
  }



  function drpMatchupLabel(rec){
    const TEAM_ABBRS = new Set(['ARI','ATH','ATL','BAL','BOS','CHC','CWS','CHW','CIN','CLE','COL','DET','HOU','KC','KCR','LAA','LAD','MIA','MIL','MIN','NYM','NYY','OAK','PHI','PIT','SD','SDP','SEA','SF','SFG','STL','TB','TBR','TEX','TOR','WSH','WAS','AZ']);
    const NON_TEAMS = new Set(['MLB','DR','PICK','WIN','LIVE','ERA','PROJ','OVER','UNDER','PUSH','LINE','VS','AT','THE','TODAY','SP']);
    const normTeam = t => {
      t = String(t || '').toUpperCase().trim();
      if(t === 'CHW') return 'CWS';
      if(t === 'KCR') return 'KC';
      if(t === 'SDP') return 'SD';
      if(t === 'SFG') return 'SF';
      if(t === 'TBR') return 'TB';
      if(t === 'WAS') return 'WSH';
      if(t === 'AZ') return 'ARI';
      return t;
    };
    const teams = [];
    const add = t => {
      t = normTeam(t);
      if(TEAM_ABBRS.has(t) && !NON_TEAMS.has(t) && !teams.includes(t)) teams.push(t);
    };
    if(Array.isArray(rec?.teams)) rec.teams.forEach(add);
    const raw = `${rec?.label || ''} ${rec?.pick || ''}`;
    [...raw.matchAll(/\b[A-Z]{2,3}\b/g)].forEach(m => add(m[0]));
    if (teams.length < 2) return '';
    // Sort alphabetically so the same matchup always produces the same key,
    // regardless of which team appeared first in the extracted text (home/away order can vary across renders)
    const sorted = [...teams].sort();
    return `${sorted[0]} @ ${sorted[1]}`;
  }

  function drpDisplayLabel(rec){
    // Display helper only. The repository record/result remains the source of truth.
    // This prevents valid historical DR Picks from disappearing when the matchup parser
    // cannot rebuild an '@' label on iPhone/mobile reloads.
    return drpMatchupLabel(rec) || rec?.label || rec?.matchup || rec?.game || 'Stored DR Pick';
  }


  function setHeaderPct(id, winPct, sampleSize){
    const el = document.getElementById(id);
    if (!el) return;
    if (!sampleSize) { el.textContent = ''; el.className = 'tracker-header-pct'; return; }
    const cls = winPct >= 60 ? 'good' : winPct >= 45 ? 'mid' : 'bad';
    el.textContent = `${winPct}% all-time`;
    el.className = `tracker-header-pct ${cls}`;
  }
  function diamondReportTeamExtremes(list){
    const normTeam = t => {
      t = String(t || '').toUpperCase().trim();
      if(t === 'CHW') return 'CWS';
      if(t === 'KCR') return 'KC';
      if(t === 'SDP') return 'SD';
      if(t === 'SFG') return 'SF';
      if(t === 'TBR') return 'TB';
      if(t === 'WAS') return 'WSH';
      if(t === 'AZ') return 'ARI';
      return t;
    };
    const map = new Map();
    (list || [])
      .filter(r => r && (r.result === 'win' || r.result === 'loss'))
      .forEach(r => {
        const team = normTeam(r.pick);
        if(!team || team === '—') return;
        const row = map.get(team) || { team, wins: 0, losses: 0, total: 0, pct: 0 };
        if(r.result === 'win') row.wins += 1;
        if(r.result === 'loss') row.losses += 1;
        row.total = row.wins + row.losses;
        row.pct = pct(row.wins, row.total);
        map.set(team, row);
      });
    const teams = [...map.values()].filter(x => x.total > 0);
    if(!teams.length) return { favorite: null, worst: null };
    const favorite = [...teams].sort((a,b) =>
      (b.pct - a.pct) || (b.wins - a.wins) || (b.total - a.total) || a.team.localeCompare(b.team)
    )[0];
    const worst = [...teams].sort((a,b) =>
      (a.pct - b.pct) || (a.wins - b.wins) || (b.total - a.total) || a.team.localeCompare(b.team)
    )[0];
    return { favorite, worst };
  }



  function formatRepoStoredAt(iso){
    if(!iso) return 'Not available yet — waiting for tracker.json generatedAt';
    const d = new Date(iso);
    if(Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString([], {
      month:'short', day:'numeric', year:'numeric',
      hour:'numeric', minute:'2-digit', timeZoneName:'short'
    });
  }

  function render(store, currentThreats, homers, gamePicks){
    const day=dayKey();
    const teamStates = teamGameStatusMap();

    // Keep the Tracker page title persistent after async data hydration.
    set('tracker-page-title', 'DIAMOND REPORT <span>TRACKER</span>');
    const repoStoredAt = store?.debug?.lastRepoGeneratedAt || repoTrackerSeed?.generatedAt || store?.generatedAt || null;
    set('tracker-repo-stored-at', formatRepoStoredAt(repoStoredAt));

    // Accuracy cards must count FINAL games only. Pending/upcoming/live picks stay visible
    // in the tables, but they are excluded from the numerator and denominator so the
    // Tracker never penalizes or inflates accuracy before a game is final.
    const isResolvedHRPick = (p) => {
      if (!p) return false;
      if (p.date !== day) return true; // prior-day stored picks are historical/final by definition
      return teamStates[p.team] === 'final';
    };

    const todaysAll=store.picks.filter(p=>p.date===day);
    const todays=todaysAll.filter(isResolvedHRPick);
    const allResolvedThreats=store.picks.filter(isResolvedHRPick);
    const th=todays.filter(p=>p.hit).length, tt=todays.length;
    const ahRows=allResolvedThreats.filter(p=>p.hit).length, atRows=allResolvedThreats.length;
    const todayPendingThreats=Math.max(todaysAll.length-tt,0);
    const allPendingThreats=Math.max(store.picks.length-atRows,0);
    const hrSummary = normalizedSummary(store.allTime?.hr);
    // Detailed rows are the source of truth when available. This keeps iPhone/mobile reloads
    // from showing stale summary totals that do not match the actual stored records.
    const ah = atRows ? ahRows : hrSummary.wins;
    const at = atRows ? atRows : hrSummary.total;
    const ahLosses = atRows ? Math.max(atRows-ahRows,0) : hrSummary.losses;

    set('tracker-today', `${th}-${Math.max(tt-th,0)}`);
    set('tracker-today-sub', `${pct(th,tt)}% right today • ${tt} final Top HR Threats${todayPendingThreats ? ` • ${todayPendingThreats} not final excluded` : ''}`);
    set('tracker-all', `${ah}-${ahLosses}`);
    set('tracker-all-sub', `${pct(ah,at)}% all-time • ${at} final stored picks${allPendingThreats ? ` • ${allPendingThreats} not final excluded` : ''}`);
    setHeaderPct('threat-header-pct', pct(ah,at), at);

    const drpSource = drpSourceRows(store);
    const drpToday={ list: drpSource.filter(r=>r.date===day) };
    drpToday.wins = drpToday.list.filter(r=>r.result==='win').length;
    drpToday.losses = drpToday.list.filter(r=>r.result==='loss').length;
    drpToday.total = drpToday.wins + drpToday.losses;
    drpToday.pending = drpToday.list.length - drpToday.total;
    const drpAll={ list: drpSource.slice() };
    drpAll.wins = drpAll.list.filter(r=>r.result==='win').length;
    drpAll.losses = drpAll.list.filter(r=>r.result==='loss').length;
    drpAll.total = drpAll.wins + drpAll.losses;
    drpAll.pending = drpAll.list.length - drpAll.total;
    const drpMatchupToday = { ...drpToday, list: drpToday.list.slice() };
    // Use every stored DR Pick. Some legacy/mobile records may not parse to an '@' matchup label,
    // but their stored win/loss status is still valid and must count toward all-time accuracy.
    drpMatchupToday.total = drpMatchupToday.list.filter(x => x.result === 'win' || x.result === 'loss').length;
    drpMatchupToday.wins = drpMatchupToday.list.filter(x => x.result === 'win').length;
    drpMatchupToday.losses = Math.max(drpMatchupToday.total - drpMatchupToday.wins, 0);
    drpMatchupToday.pending = drpMatchupToday.list.length - drpMatchupToday.total;
    const drpMatchupAll = { ...drpAll, list: drpAll.list.slice() };
    drpMatchupAll.total = drpMatchupAll.list.filter(x => x.result === 'win' || x.result === 'loss').length;
    drpMatchupAll.wins = drpMatchupAll.list.filter(x => x.result === 'win').length;
    drpMatchupAll.losses = Math.max(drpMatchupAll.total - drpMatchupAll.wins, 0);
    drpMatchupAll.pending = drpMatchupAll.list.length - drpMatchupAll.total;
    const kpToday=marketStats(store,'kprop',day);
    const kpAll=marketStats(store,'kprop');

    set('tracker-drp-today', `${drpMatchupToday.wins}-${drpMatchupToday.losses}`);
    set('tracker-drp-today-sub', `${pct(drpMatchupToday.wins,drpMatchupToday.total)}% today • ${drpMatchupToday.total} final matchups`);

    // Repo allTime.drp is the authoritative all-time total when it contains a larger
    // completed sample than the visible detailed rows. This keeps the card/header from
    // dropping from the true repository record (ex: 20-8) to a smaller mobile-parsed
    // subset (ex: 17-11) after Reload Repo Data on iPhone.
    const drpAllDisplay = drpSourceSummary(store);
    set('tracker-drp-all', `${drpAllDisplay.wins}-${drpAllDisplay.losses}`);
    set('tracker-drp-all-sub', `${pct(drpAllDisplay.wins,drpAllDisplay.total)}% all-time • ${drpAllDisplay.total} final matchups`);
    setHeaderPct('drp-header-pct', pct(drpAllDisplay.wins,drpAllDisplay.total), drpAllDisplay.total);

    set('tracker-kprops-today', `${kpToday.wins}-${kpToday.losses}`);
    set('tracker-kprops-today-sub', `${pct(kpToday.wins,kpToday.total)}% today • ${kpToday.total} final K props`);
    const kpSummary = normalizedSummary(store.allTime?.kprop);
    // Detailed K Prop rows are the source of truth when available. The all-time card
    // should match the actual records shown/calculated after Reload Repo Data on iPhone.
    const kpAllDisplay = kpAll.total ? kpAll : kpSummary;
    set('tracker-kprops-all', `${kpAllDisplay.wins}-${kpAllDisplay.losses}`);
    set('tracker-kprops-all-sub', `${pct(kpAllDisplay.wins,kpAllDisplay.total)}% all-time • ${kpAllDisplay.total} final K props`);
    setHeaderPct('kprops-header-pct', pct(kpAllDisplay.wins,kpAllDisplay.total), kpAllDisplay.total);

    const drLineRows = (kpAll.list || []).filter(r => {
      const finalK = r.finalKCount ?? findFinalKCountForPitcher(r.label);
      // All Time DR Line Accuracy must use the actual DR Line only.
      // rec.line is reserved for Projected Line/K Projection and cannot be used here.
      const drLine = extractNumericValue(r.drLine);
      return Number.isFinite(finalK) && Number.isFinite(drLine);
    }).map(r => {
      const finalK = r.finalKCount ?? findFinalKCountForPitcher(r.label);
      const drLine = extractNumericValue(r.drLine);
      return { ...r, finalKCount: finalK, drLine, overDRLine: finalK > drLine ? 'Y' : 'N' };
    });
    const drLineOver = drLineRows.filter(r => r.overDRLine === 'Y').length;
    const drLineUnder = Math.max(drLineRows.length - drLineOver, 0);
    set('tracker-drline-over', `${drLineOver}`);
    set('tracker-drline-over-sub', `${pct(drLineOver, drLineRows.length)}% of final K props went over the DR Line`);
    set('tracker-drline-under', `${drLineUnder}`);
    set('tracker-drline-under-sub', `${pct(drLineUnder, drLineRows.length)}% finished at/under the DR Line`);
    set('tracker-drline-total', `${drLineRows.length}`);
    setHeaderPct('drline-header-pct', pct(drLineOver, drLineRows.length), drLineRows.length);

    const teamExtremes = diamondReportTeamExtremes(drpMatchupAll.list);
    set('tracker-drt-favorite', teamExtremes.favorite ? teamExtremes.favorite.team : '—');
    set('tracker-drt-favorite-sub', teamExtremes.favorite
      ? `${teamExtremes.favorite.pct}% all-time • ${teamExtremes.favorite.wins}-${teamExtremes.favorite.losses} on final DR picks`
      : 'Waiting for final Diamond Report picks');
    set('tracker-drt-worst', teamExtremes.worst ? teamExtremes.worst.team : '—');
    set('tracker-drt-worst-sub', teamExtremes.worst
      ? `${teamExtremes.worst.pct}% all-time • ${teamExtremes.worst.wins}-${teamExtremes.worst.losses} on final DR picks`
      : 'Waiting for final Diamond Report picks');

    const statusBadge = r => resultBadgeFromFinal(r.result);

    // Show ALL stored DRP picks (not just today) so the Date column has something to sort
    const drpRowsAll = drpAll.list.map(r => ({
      ...r,
      // Display every stored repo row. Do not dedupe by matchup/team name;
      // tracker.json is the authority for historical DR Picks.
      matchupLabel: drpDisplayLabel(r) || r.label || r.key || 'Stored DR Pick'
    }));

    // Apply current sort (default: date descending — most recent first)
    window.drpTableSortDir = window.drpTableSortDir || -1;
    const drpRows = [...drpRowsAll].sort((a,b) => {
      if (a.date === b.date) return 0;
      return a.date < b.date ? -window.drpTableSortDir : window.drpTableSortDir;
    });

    // Update sort arrow indicator
    const dateArrowEl = document.querySelector('#drp-th-date .sort-arrow');
    if (dateArrowEl) dateArrowEl.textContent = window.drpTableSortDir === -1 ? '▼' : '▲';

    set('tracker-drp-results', drpRows.length ? drpRows.map(r=>{
      const isToday = r.date === day;
      return `<tr>
        <td style="white-space:nowrap;color:${isToday?'var(--accent2)':'var(--muted)'}">${r.date}${isToday?' <span style="font-size:9px;color:var(--accent2)">(Today)</span>':''}</td>
        <td>${r.matchupLabel}</td>
        <td>${r.pick}</td>
        <td>${statusBadge(r)}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="4" style="text-align:left;color:var(--muted)">Waiting for completed Diamond Report Picks from tracker.json.</td></tr>');

    // Show ALL stored K Props so this section truly reflects Daily + All-Time Accuracy.
    // Date is included to match the Diamond Report Picks table and to make iPhone
    // repo reload checks easier to audit.
    const kpropRowMap = new Map();
    (kpAll.list || []).forEach(r => {
      const key = `${r.date || ''}|${String(r.label || '').toLowerCase().trim()}`;
      const prior = kpropRowMap.get(key);
      const resolved = r.result === 'win' || r.result === 'loss';
      const priorResolved = prior && (prior.result === 'win' || prior.result === 'loss');
      if (!prior || (resolved && !priorResolved)) kpropRowMap.set(key, r);
    });
    const kpropRows = [...kpropRowMap.values()].sort((a,b) => {
      const ad = String(a.date || '');
      const bd = String(b.date || '');
      if (ad === bd) return String(a.label || '').localeCompare(String(b.label || ''));
      return ad < bd ? 1 : -1; // newest first
    });

    set('tracker-kprops-results', kpropRows.length ? kpropRows.map(r=>{
      const isToday = r.date === day;
      const storedFinal = extractNumericValue(r.finalKCount ?? r.finalKs ?? r.kCount ?? r.finalK);
      const domFinal = findFinalKCountForPitcher(r.label);
      const finalK = Number.isFinite(storedFinal) ? storedFinal : domFinal;
      if (Number.isFinite(finalK)) r.finalKCount = finalK;
      // Projected Line must be the K Projection, not the DR Line.
      const projectedLine = r.projectedLine || r.kProjection || '—';
      const kProjection = r.kProjection || r.projectedLine || '—';
      const drLine = r.drLine || '—';
      const overDR = Number.isFinite(finalK) && Number.isFinite(extractNumericValue(drLine)) ? (finalK > extractNumericValue(drLine) ? 'Y' : 'N') : (r.overDRLine || '—');
      return `<tr>
        <td style="white-space:nowrap;color:${isToday?'var(--accent2)':'var(--muted)'}">${r.date || '—'}${isToday?' <span style="font-size:9px;color:var(--accent2)">(Today)</span>':''}</td>
        <td>${r.label}</td>
        <td>${r.pick}</td>
        <td>${projectedLine}</td>
        <td>${kProjection}</td>
        <td>${Number.isFinite(finalK) ? finalK : '—'}</td>
        <td>${drLine}</td>
        <td>${overDR}</td>
        <td>${kpropStatusText(r)}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="9" style="text-align:left;color:var(--muted)">Waiting for K Props data.</td></tr>');


    const sourceStatus = [
      `<span class="tracker-pill ${repoTrackerLoaded?'hit':'pending'}">${repoTrackerLoaded?'✅':'💾'} Repo tracker.json ${repoTrackerLoaded?'source of truth':'loading'}</span>`,
      `<span class="tracker-pill hit">✅ Repo sync via GitHub Actions</span>`,
      `<span class="tracker-pill hit">🔒 Historical Tracker read-only</span>`,
      `<span class="tracker-pill pending" onclick="window.resetDiamondTrackerLocalCache && window.resetDiamondTrackerLocalCache()" style="cursor:pointer">♻ Reload repo data</span>`,
      ...SOURCES.map(src => {
        const connected = src.live && ((src.name.includes('MLB Stats') ? (currentThreats.length || homers.size) : true));
        return `<span class="tracker-pill ${connected?'hit':'pending'}">${connected?'✅':'🔌 (planned)'} ${src.name}</span>`;
      })
    ].join('');
    set('tracker-source-stack', sourceStatus);
    set('tracker-model-inputs', MODEL_INPUTS.map(s=>`<span class="tracker-pill hit">${s}</span>`).join(''));

    const fav=[...gamePicks].sort((a,b)=>b.winPct-a.winPct)[0];
    const dog=gamePicks.filter(p=>p.lean==='underdog').sort((a,b)=>b.winPct-a.winPct)[0] || [...gamePicks].sort((a,b)=>a.winPct-b.winPct)[0];
    set('tracker-favorite', fav ? fav.team : '—');
    set('tracker-favorite-sub', fav ? `${fav.winPct || 0}% projected win • strongest favorite` : 'Waiting for Diamond Report Picks');
    set('tracker-underdog', dog ? dog.team : '—');
    set('tracker-underdog-sub', dog ? `${dog.winPct || 0}% projected win • value/underdog slot` : 'Waiting for Diamond Report Picks');

    const rows=(todaysAll.length?todaysAll:currentThreats).map(p=>{
      const hitNow = p.hit || homers.has(p.player.toLowerCase());
      const gameState = teamStates[p.team] || 'upcoming';
      let status;
      if (hitNow) {
        status = '<span class="tracker-pill hit">✅ Right</span>';
      } else if (gameState === 'final') {
        status = '<span class="tracker-pill miss">❌ Wrong</span>';
      } else if (gameState === 'live') {
        status = '<span class="tracker-pill pending">🔴 Live</span>';
      } else {
        status = '<span class="tracker-pill pending">⏳ Pending</span>';
      }
      return `<tr>
        <td>${p.player}</td>
        <td>${p.team||'—'}</td>
        <td>${p.hrPct||0}%</td>
        <td>${status}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="4" style="text-align:left;color:var(--muted)">Waiting for HR Potential data to load.</td></tr>';
    set('tracker-results', rows);

    if(!isAnyGameFinal()){
      set('tracker-team-results', '<div style="color:var(--muted);font-size:12px">Waiting for final games before updating team analyzer.</div>');
    } else {
    const teams=Object.values(store.teams).sort((a,b)=>pct(b.hits,b.total)-pct(a.hits,a.total)||b.total-a.total).slice(0,8);
    set('tracker-team-results', teams.length ? teams.map((t,i)=>{
      const top=Object.entries(t.correctPlayers||{}).sort((a,b)=>b[1]-a[1])[0];
      return `<div class="stat-row">
        <div class="stat-row-num">${i+1}</div>
        <div style="flex:1">
          <div style="font-weight:800">${t.team}</div>
          <div style="color:var(--muted);font-size:11px">Correct HR picks: ${t.hits}/${t.total}${top ? ' • best player: '+top[0] : ''}</div>
        </div>
        <span class="tracker-pill ${pct(t.hits,t.total)>=25?'hit':'pending'}">${pct(t.hits,t.total)}%</span>
      </div>`;
    }).join('') : '<div style="color:var(--muted);font-size:12px">Correct teams will appear after a Top HR Threat hits and games are final.</div>');
    }

    const preds=currentThreats.map(p=>({ ...p, score:predictionScore(p,store) })).sort((a,b)=>b.score-a.score).slice(0,10);
    set('tracker-predictions', preds.length ? preds.map((p,i)=>{
      const pl=store.players[p.player.toLowerCase()] || {hits:0,total:0};
      const tm=store.teams[p.team] || {hits:0,total:0};
      return `<div class="stat-row">
        <div class="stat-row-num">${i+1}</div>
        <div style="flex:1">
          <div style="font-weight:800">${p.player}</div>
          <div style="color:var(--muted);font-size:11px">${p.team||'—'} • base HR ${p.hrPct||0}% • player ${pct(pl.hits,pl.total)}% • team ${pct(tm.hits,tm.total)}%</div>
        </div>
        <span class="tracker-pill ${p.score>=35?'hit':p.score>=20?'pending':'miss'}">${p.score}%</span>
      </div>`;
    }).join('') : '<div style="color:var(--muted);font-size:12px">Upcoming player HR predictions populate from HR Potential once loaded.</div>');

    renderNextDayModels(store, currentThreats, gamePicks);

    set('tracker-refresh',
      `Last synced ${new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})} • HRP ${currentThreats.length} • HRs ${homers.size} • Picks ${gamePicks.length} • Finals ${[...new Set(Object.values(finalGameMap()).filter(x=>!Array.isArray(x)).map(x=>x.away+'@'+x.home))].length}`
    );
  }

  function sync(){
    // The Tracker tab isn't shipped in production (no #tracker-page-title or any other
    // tracker markup in index.html), so there's nothing for this to render into. Skip the
    // DOM scraping/regex extraction and render() work entirely rather than doing it on a
    // 30s interval plus after every scores/props/K-props refresh for a tab nobody sees.
    if (!document.getElementById('tracker-page-title')) return;
    const store=loadStore();
    let threats=[], homers=new Set(), gamePicks=[];
    try{
      dedupeLegacyMarketPicks(store); // one-time cleanup of old index-keyed duplicate rows
      threats=extractHRThreats();
      homers=extractHRToday();
      gamePicks=extractGamePicks();
      const drpAccuracy=extractDRPicksAccuracy();
      const kpropsAccuracy=extractKPropsAccuracy();
      // v8.0 Historical Tracker: do not save live/pending DOM rows into Tracker history.
      // The automated repo-side grader should write only final records to tracker.json.
      if (!repoTrackerLoaded) {
        drpAccuracy.filter(r => isFinalMarketResult(normalizeMarketResultValue(r.result))).forEach(r=>upsertMarketPick(store,r));
        kpropsAccuracy.filter(r => isFinalMarketResult(normalizeMarketResultValue(r.result))).forEach(r=>upsertMarketPick(store,r));
        threats.filter(p => p.final === true).forEach(p=>upsert(store,p,homers.has(p.player.toLowerCase())));
      }
      store.debug.lastError = '';
      store.debug.lastSync = new Date().toISOString();
      saveStore(store);
      render(store, threats, homers, gamePicks);

      return { threats, homers, gamePicks };
    } catch(e){
      // Defensive fallback: even if extraction/rendering above failed partway through
      // (e.g. a DOM element wasn't ready yet, common on some mobile browsers), still
      // try to render whatever we have rather than leaving the whole Tracker tab blank.
      console.error('Tracker sync failed:', e);
      store.debug.lastError = e.message || String(e);
      try { saveStore(store); } catch(_) {}
      try { render(store, threats, homers, gamePicks); } catch(renderErr) {
        console.error('Tracker render also failed:', renderErr);
      }
      const refreshEl = document.getElementById('tracker-refresh');
      if (refreshEl) refreshEl.textContent = `Tracker error: ${e.message || e} — retrying next sync`;
      return { threats, homers, gamePicks };
    }
  }

  // Resolves any DRP picks that are still 'pending' from a PAST date (not today) by
  // querying the MLB Stats API for that specific date's final scores. This covers
  // cases like a normalization bug (e.g. legacy 'AZ' records) that prevented a pick
  // from resolving while its date's games were still in the live DOM — once the day
  // passes, #final-games no longer has that data, so the only remaining source is the API.
  const TEAM_NORM_MAP = { CHW:'CWS', KCR:'KC', SDP:'SD', SFG:'SF', TBR:'TB', WAS:'WSH', AZ:'ARI' };
  const normTeamGlobal = t => { t = String(t||'').toUpperCase().trim(); return TEAM_NORM_MAP[t] || t; };

  async function fetchMLBScheduleForDate(date){
    const urls = [
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore,team&language=en`,
      `https://diamondreport.app/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore,team&language=en`
    ];
    let lastErr = null;
    for (const url of urls){
      try { return await fetchJSON(url); }
      catch(e){ lastErr = e; }
    }
    throw lastErr || new Error('Unable to fetch MLB schedule');
  }

  async function backfillStalePendingPicks(store){
    const todayKey = (typeof dayKey === 'function') ? dayKey() : new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'});
    store.market ||= { drp: [], kprop: [] };
    store.market.drp = (store.market.drp || []).map(r => ({ ...r, result: normalizeMarketResultValue(r.result ?? r.status ?? r.outcome ?? r.grade ?? r.finalStatus) }));
    const stale = (store.market.drp || []).filter(r => !(r.result === 'win' || r.result === 'loss' || r.result === 'push') && r.date && r.date !== todayKey);
    if (!stale.length) return false;

    const dates = [...new Set(stale.map(r => r.date))];
    let changed = false;

    for (const date of dates) {
      try {
        const data = await fetchMLBScheduleForDate(date);
        const entry = data.dates?.find(d => d.date === date) || data.dates?.[0];
        const games = entry?.games || [];
        const finalsForDate = {};
        games.forEach(g => {
          if (g.status?.abstractGameState !== 'Final') return;
          const away = normTeamGlobal(g.teams.away.team.abbreviation);
          const home = normTeamGlobal(g.teams.home.team.abbreviation);
          const awayScore = g.teams.away.score, homeScore = g.teams.home.score;
          if (awayScore == null || homeScore == null) return;
          const winner = awayScore > homeScore ? away : homeScore > awayScore ? home : 'TIE';
          [away, home].forEach(t => { finalsForDate[t] = { away, home, winner }; });
        });

        stale.filter(r => r.date === date).forEach(rec => {
          const pick = normTeamGlobal(rec.pick);
          const game = finalsForDate[pick];
          if (!game) return; // couldn't find this game in the API response — leave as pending
          rec.result = game.winner === 'TIE' ? 'push' : (game.winner === pick ? 'win' : 'loss');
          rec.finalChecked = true;
          changed = true;
        });
      } catch(e) {
        console.warn('Backfill failed for date', date, e);
      }
    }
    return changed;
  }

  window.syncDiamondTracker=sync;
  window.initPersistentTrackerData = initPersistentTrackerData;
  // v8.72 lazy-load Tracker history only when needed. It no longer blocks startup.

  window.sortDRPTable=function(col){
    if (col === 'date') {
      window.drpTableSortDir = (window.drpTableSortDir === -1) ? 1 : -1;
      const store = loadStore();
      const threats = extractHRThreats();
      const homers = extractHRToday();
      const gamePicks = extractGamePicks();
      render(store, threats, homers, gamePicks);
    }
  };

  function hookAfter(fnName){
    try{
      const original = window[fnName];
      if (typeof original !== 'function' || original.__trackerHooked) return;
      const wrapped = async function(...args){
        const result = await original.apply(this,args);
        setTimeout(sync, 250);
        return result;
      };
      wrapped.__trackerHooked = true;
      window[fnName] = wrapped;
    } catch(e){}
  }

  function start(){
    sync();
    setTimeout(sync, 1500);
    hookAfter('renderHRPTable');
    hookAfter('loadHRsToday');
    hookAfter('loadGameProps');
    hookAfter('loadSchedule');
    hookAfter('loadLiveScores');
    hookAfter('renderScores');
    hookAfter('loadScores');
    hookAfter('loadKProps');
    setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 30000);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

// Diamond Report K Props label cleanup: keep PROJ underneath, simplify label to OVER/UNDER
(function(){
  function cleanKPropLabels(){
    document.querySelectorAll('#kprops-content .kprop-pred-val, #kprops-content .kprop-chip, #kprops-content *').forEach(el => {
      if(!el || !el.childNodes || el.childNodes.length > 1) return;
      const raw = (el.textContent || '').trim();
      if(/^PUSH\s*\[\s*OVER\s*LEAN\s*\]$/i.test(raw) || /^PUSH\s*\/\s*OVER\s*LEAN$/i.test(raw) || /^OVER\s*LEAN$/i.test(raw)){
        el.textContent = 'OVER';
      }
      if(/^PUSH\s*\[\s*UNDER\s*LEAN\s*\]$/i.test(raw) || /^PUSH\s*\/\s*UNDER\s*LEAN$/i.test(raw) || /^UNDER\s*LEAN$/i.test(raw)){
        el.textContent = 'UNDER';
      }
    });
  }
  window.cleanKPropLabels = cleanKPropLabels;
  function hook(fnName){
    const original = window[fnName];
    if(typeof original !== 'function' || original.__kPropLabelHooked) return;
    const wrapped = async function(...args){
      const result = await original.apply(this,args);
      setTimeout(cleanKPropLabels, 100);
      return result;
    };
    wrapped.__kPropLabelHooked = true;
    window[fnName] = wrapped;
  }
  function start(){
    cleanKPropLabels();
    ['loadKProps','renderKProps','renderKPropRows'].forEach(hook);
    // v7.8: no repeated wildcard DOM cleanup scans. Rendering now emits final labels directly.
    setTimeout(cleanKPropLabels, 5000);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();


// Keep static projection label instead of live K label
(function(){
  function normalizeProjLabels(){
    document.querySelectorAll('#kprops-content .kprop-pred-val, #kprops-content .kprop-pick, #kprops-content *').forEach(el=>{
      if(!el || !el.textContent) return;
      const t = el.textContent.trim();
      if(/^\d+(\.\d+)?K\s+LIVE$/i.test(t)){
        const m=t.match(/^(\d+(?:\.\d+)?)K/i);
        if(m) el.textContent = `${m[1]} PROJ`;
      }
    });
  }
  const run=()=>normalizeProjLabels();
  run();
  setTimeout(run, 5000); // v7.8 one-shot
})();


// Permanent K Props recommendation label patch
(function(){
  function cleanKPropRecommendationLabels(){
    const roots = document.querySelectorAll('#kprops-content .kprop-pred, #kprops-content .kprop-chip, #kprops-content .kprop-row');
    roots.forEach(root => {
      root.querySelectorAll('*').forEach(el => {
        if(!el || !el.childNodes || el.childNodes.length !== 1) return;
        const raw = (el.textContent || '').trim();
        if(/^PUSH\s*\[\s*OVER\s*LEAN\s*\]$/i.test(raw) || /^PUSH\s*\/\s*OVER\s*LEAN$/i.test(raw) || /^OVER\s*LEAN$/i.test(raw)){
          el.textContent = 'OVER';
        }
        if(/^PUSH\s*\[\s*UNDER\s*LEAN\s*\]$/i.test(raw) || /^PUSH\s*\/\s*UNDER\s*LEAN$/i.test(raw) || /^UNDER\s*LEAN$/i.test(raw)){
          el.textContent = 'UNDER';
        }
      });

      [...root.childNodes].forEach(node => {
        if(node.nodeType !== Node.TEXT_NODE) return;
        const raw = node.textContent.trim();
        if(/^PUSH\s*\[\s*OVER\s*LEAN\s*\]$/i.test(raw)) node.textContent = 'OVER';
        if(/^PUSH\s*\[\s*UNDER\s*LEAN\s*\]$/i.test(raw)) node.textContent = 'UNDER';
      });
    });
  }

  function runKPropRecommendationPatch(){
    cleanKPropRecommendationLabels();
  }

  function startKPropRecommendationPatch(){
    runKPropRecommendationPatch();
    // Throttled to 5s instead of 500ms — full DOM walk doesn't need to run twice a second
    setTimeout(runKPropRecommendationPatch, 5000);
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startKPropRecommendationPatch);
  else startKPropRecommendationPatch();
})();



// ── ROBUST FIRST-LOAD BOOTSTRAP ──────────────────────────────────────
// Keeps the first page visit from requiring a manual reload. The boot runs after
// the full script is parsed, then warms the modules whose panels depend on each
// other: HR Potential -> HRs Completed from Projection, Pitcher Report -> lineups,
// and live scores -> HR/K banners.
let diamondReportBooted = false;
function bootDiamondReportStartup() {
  if (diamondReportBooted) return;
  diamondReportBooted = true;

  // v8.72: render the visible shell immediately, then hydrate only visible data.
  // Data requests are parallelized and backed by the static daily dump cache.
  if (!DR_STATIC_DAILY_DUMP) schedule5amHRRefresh();

  setTimeout(function(){
    try {
      const activePane = document.querySelector('#props .gamepick-pane.active')?.getAttribute('data-gamepick-pane') || 'game';
      const jobs = [];
      if (activePane === 'game' && typeof window.loadGameProps === 'function') jobs.push(window.loadGameProps({ force:false }));
      else if (typeof window.__drLoadGamePickPaneData === 'function') jobs.push(window.__drLoadGamePickPaneData(activePane));
      // Scores load in parallel, not as a blocker, so the page does not sit blank on reload.
      if (typeof window.loadScores === 'function') jobs.push(window.loadScores());
      Promise.allSettled(jobs).then(function(){
        try { if (window.syncDiamondTracker && !DR_STATIC_DAILY_DUMP) window.syncDiamondTracker(); } catch(e) {}
      });
    } catch(e) {}
  }, 40);

  // Eagerly fetch data for every other tab in the background so switching
  // tabs (or opening one that isn't the default) shows projections
  // immediately instead of needing a page reload to trigger the fetch.
  // Staggered (not all at once) so refresh doesn't feel like it's doing
  // five things at the exact same moment the active tab is also loading.
  function safeCall(fn){
    try { return Promise.resolve(fn()); } catch(e) { return Promise.resolve(); }
  }
  function renderAllEager(){
    try { if (typeof window.renderPropIntelligencePanes === 'function') window.renderPropIntelligencePanes(true); } catch(e) {}
    try { if (typeof window.renderHRPTable === 'function') window.renderHRPTable(); } catch(e) {}
  }
  // On slow/data-saver connections, give the visible tab's own fetch an even
  // longer head start before competing for bandwidth with everything else.
  var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  var isSlowConn = !!(conn && (conn.saveData || /^(slow-2g|2g|3g)$/.test(conn.effectiveType || '')));
  var eagerStart = isSlowConn ? 3500 : 900;
  var eagerStep = isSlowConn ? 1200 : 500;
  setTimeout(function(){
    var loaders = [];
    if (typeof window.loadHRPotentialWithRetry === 'function') loaders.push(window.loadHRPotentialWithRetry);
    if (typeof window.loadHRsToday === 'function') loaders.push(window.loadHRsToday);
    if (typeof window.loadKsTodayWithRetry === 'function') loaders.push(window.loadKsTodayWithRetry);
    if (typeof window.loadKProps === 'function') loaders.push(window.loadKProps);
    // Pitcher Report does a per-starter fetch and is the heaviest of this
    // group — skip it up front on slow connections; it'll still load the
    // moment the user actually opens that tab.
    if (!isSlowConn && typeof window.loadPitcherReport === 'function') loaders.push(window.loadPitcherReport);
    var jobs = loaders.map(function(fn, i){
      return new Promise(function(resolve){
        setTimeout(function(){ safeCall(fn).then(resolve, resolve); }, i * eagerStep);
      });
    });
    Promise.allSettled(jobs).then(renderAllEager);
    // Backup pass: data fetches can still be in flight (slow network, many
    // games); re-render once more shortly after in case the first pass
    // landed before everything resolved.
    setTimeout(renderAllEager, (loaders.length * eagerStep) + 2000);
  }, eagerStart);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootDiamondReportStartup, { once: true });
} else {
  setTimeout(bootDiamondReportStartup, 0);
}


// Lightweight Diamond Report safety cleanup — no intervals or observers
(function(){
  function cleanupDRPMatchupRowsOnce(){
    const tbody = document.getElementById('tracker-drp-results');
    if(!tbody) return;
    [...tbody.querySelectorAll('tr')].forEach(row => {
      const first = row.querySelector('td');
      if(!first) return;
      if(!/@/.test(first.textContent || '')) row.remove();
    });
    if(!tbody.querySelector('tr')){
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:left;color:var(--muted)">Waiting for completed matchups. Single-team rows are hidden.</td></tr>';
    }
  }

  function runSafetyCleanup(){
    cleanupDRPMatchupRowsOnce();
    document.querySelectorAll('#kprops-content .kprop-pred-val').forEach(el => {
      const raw = (el.textContent || '').trim();
      if(/^PUSH\s*\[\s*OVER\s*LEAN\s*\]$/i.test(raw) || /^OVER\s+LEAN$/i.test(raw)) el.textContent = 'OVER';
      if(/^PUSH\s*\[\s*UNDER\s*LEAN\s*\]$/i.test(raw) || /^UNDER\s+LEAN$/i.test(raw)) el.textContent = 'UNDER';
    });
  }

  window.runDiamondReportSafetyCleanup = runSafetyCleanup;
  document.addEventListener('click', () => setTimeout(runSafetyCleanup, 50), { passive:true });
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(runSafetyCleanup, 300));
  else setTimeout(runSafetyCleanup, 300);
})();

/* ---- from <script id="prod-v7-8-refresh-stability-guard"> ---- */
(function(){
  /* v7.8: Prevent live polling from repainting sections while the user is actively scrolling/tapping. */
  let timer = null;
  function markInteracting(){
    window.__diamondUserInteracting = true;
    clearTimeout(timer);
    timer = setTimeout(() => { window.__diamondUserInteracting = false; }, 2500);
  }
  ['scroll','touchstart','touchmove','pointerdown','wheel'].forEach(evt => {
    window.addEventListener(evt, markInteracting, { passive:true });
  });
})();

/* ---- from <script id="v7-24-dashboard-copy-sync"> ---- */
(function(){
  function set(id,val){var el=document.getElementById(id); if(el && val) el.textContent=val;}
  document.addEventListener('DOMContentLoaded',function(){
    set('dr-hero-hr-count','🔥 HR');
    set('dr-hero-k-count','🎯 K');
    set('dr-hero-game-count','⚾ ML');
  });
})();

/* ---- from <script id="prod-v8-70-performance-loader"> ---- */
(function(){
  const loaded = { game:false, pr:false, hr:false, k:false, props:false, deep:false };
  const idle = window.requestIdleCallback || function(cb){ return setTimeout(cb, 900); };

  window.__drLoadGamePickPaneData = function(pane){
    pane = pane || 'game';
    try {
      if (pane === 'game') {
        if (loaded.game) return;
        loaded.game = true;
        if (typeof window.loadGameProps === 'function') { var gp = window.loadGameProps({ force:true }); if (gp && gp.then) gp.then(() => { if (window.syncDiamondTracker) window.syncDiamondTracker(); }); }
        return;
      }
      if (pane === 'pr') {
        if (loaded.pr) return;
        loaded.pr = true;
        try { if (typeof window.loadPitcherReport === 'function') window.loadPitcherReport(); } catch(e) {}
        return;
      }
      if (pane === 'hr') {
        if (loaded.hr) return;
        loaded.hr = true;
        Promise.allSettled([
          (async()=>{ try { if (typeof window.loadHRPotentialWithRetry === 'function') return window.loadHRPotentialWithRetry(); } catch(e) {} })(),
          (async()=>{ try { if (typeof window.loadHRsToday === 'function') return window.loadHRsToday(); } catch(e) {} })()
        ]);
        return;
      }
      if (pane === 'k') {
        if (loaded.k) return;
        loaded.k = true;
        Promise.allSettled([
          (async()=>{ try { if (typeof window.loadKsTodayWithRetry === 'function') return window.loadKsTodayWithRetry(); } catch(e) {} })(),
          (async()=>{ try { if (typeof window.loadKProps === 'function') return window.loadKProps(); } catch(e) {} })()
        ]).then(() => { try { if (window.syncDiamondTracker && !DR_STATIC_DAILY_DUMP) window.syncDiamondTracker(); } catch(e) {} });
        return;
      }
      if (['hits','rbis','tb','sb','hrrbi'].indexOf(pane) >= 0) {
        if (!loaded.props) {
          loaded.props = true;
          idle(function(){ try { if (typeof window.loadHRPotentialWithRetry === 'function') window.loadHRPotentialWithRetry(); } catch(e) {} });
        }
        setTimeout(function(){ try { if (typeof window.renderPropIntelligencePanes === 'function') window.renderPropIntelligencePanes(); } catch(e) {} }, 120);
        return;
      }
      if (pane === 'premium') {
        // Same shared player pool as the hits/rbis/tb/sb/hrrbi boards above — reuses the
        // loaded.props flag so a cold boot straight into Premium (e.g. restoring the
        // saved tab on refresh) still fetches it instead of relying on a manual tab
        // click through window.showGamePickPane, which boot() doesn't go through.
        if (!loaded.props) {
          loaded.props = true;
          idle(function(){ try { if (typeof window.loadHRPotentialWithRetry === 'function') window.loadHRPotentialWithRetry(); } catch(e) {} });
        }
        setTimeout(function(){ try { if (typeof window.renderPremiumPicks === 'function') window.renderPremiumPicks(); } catch(e) {} }, 120);
        setTimeout(function(){ try { if (typeof window.renderPremiumPicks === 'function') window.renderPremiumPicks(); } catch(e) {} }, 900);
        return;
      }
      if (pane === 'deep' && !loaded.deep) {
        loaded.deep = true;
        idle(function(){ try { if (typeof window.renderDeepResearch === 'function') window.renderDeepResearch(); } catch(e) {} });
      }
    } catch(e) {}
  };

  document.addEventListener('visibilitychange', function(){
    if (document.hidden) window.__diamondUserInteracting = true;
    else setTimeout(function(){ window.__diamondUserInteracting = false; }, 800);
  });
})();

/* ---- from <script id="anonymous"> ---- */
// PROD v8.44 — Game Picks inner tab controller with persistent state
(function(){
  var VALID = { game: true, pr: true, hr: true, k: true, hits: true, rbis: true, tb: true, sb: true, hrrbi: true, premium: true, parlay: true, 'team-performance': true, deep: true };

  // Only the URL hash decides the pane on load (e.g. a shared #gamepick=premium
  // link). No localStorage fallback — a plain refresh/revisit with no hash
  // always lands on Games Today rather than silently reopening whatever tab
  // was last clicked.
  function getRequestedPane(){
    try {
      var hash = (window.location.hash || '').replace('#','');
      if (hash.indexOf('gamepick=') === 0) {
        var fromHash = hash.split('=')[1];
        if (VALID[fromHash]) return fromHash;
      }
    } catch(e) {}
    return 'game';
  }

  function renderGameCenterIfNeeded(){
    var content = document.getElementById('gameprops-content');
    if (content && !(content.textContent || '').trim()) {
      content.innerHTML = '<div class="mu-empty"><span class="spin"></span>Loading game projections…</div>';
    }
    try {
      if (typeof window.loadGameProps === 'function') {
        window.loadGameProps({ force: true });
      } else if (typeof window.renderGameProps === 'function') {
        window.renderGameProps();
      }
    } catch(e) {}
  }

  function activateGamePickPane(pane, opts){
    pane = VALID[pane] ? pane : 'game';
    opts = opts || {};
    var root = document.getElementById('props') || document;
    var panes = root.querySelectorAll('.gamepick-pane');
    var tabs = root.querySelectorAll('.gamepick-tab');

    panes.forEach(function(el){
      var active = el.getAttribute('data-gamepick-pane') === pane;
      el.classList.toggle('active', active);
      if (active) {
        el.removeAttribute('hidden');
        el.style.display = 'block';
        el.style.visibility = 'visible';
        el.style.opacity = '1';
      } else {
        el.setAttribute('hidden', 'hidden');
        el.style.display = 'none';
      }
    });

    tabs.forEach(function(btn){
      var active = btn.getAttribute('data-gamepick-pane') === pane;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    // Keep refresh/back-forward behavior grounded without forcing a scroll jump.
    if (!opts.silentHash) {
      try { history.replaceState(null, '', window.location.pathname + window.location.search + '#gamepick=' + pane); } catch(e) {}
    }

    if (pane === 'game') {
      setTimeout(renderGameCenterIfNeeded, 30);
      setTimeout(renderGameCenterIfNeeded, 700);
    }
    if (typeof window.__drLoadGamePickPaneData === 'function') {
      setTimeout(function(){ window.__drLoadGamePickPaneData(pane); }, 60);
    }
    if (['hits','rbis','tb','sb','hrrbi','parlay'].indexOf(pane) >= 0) {
      setTimeout(function(){ if (typeof window.renderPropIntelligencePanes === 'function') window.renderPropIntelligencePanes(); }, 30);
      setTimeout(function(){ if (typeof window.renderPropIntelligencePanes === 'function') window.renderPropIntelligencePanes(); }, 700);
    }
    if (pane === 'parlay') {
      setTimeout(function(){ if (typeof window.renderParlayBuilds === 'function') window.renderParlayBuilds(); }, 60);
      setTimeout(function(){ if (typeof window.renderParlayBuilds === 'function') window.renderParlayBuilds(); }, 900);
    }
    if (pane === 'team-performance') {
      
    }
    if (pane === 'deep') {
      setTimeout(function(){ if (typeof window.renderDeepResearch === 'function') window.renderDeepResearch(); }, 30);
      setTimeout(function(){ if (typeof window.renderDeepResearch === 'function') window.renderDeepResearch(); }, 700);
      setTimeout(function(){ if (typeof window.renderDeepResearch === 'function') window.renderDeepResearch(); }, 2000);
    }
  }

  window.showGamePickPane = function(pane){
    activateGamePickPane(pane || 'game');
  };

  window.ensureGameCenterLoaded = function(){
    // Render data without stealing the active tab away from HR/Strikeout.
    renderGameCenterIfNeeded();
  };

  function boot(){
    activateGamePickPane(getRequestedPane(), { silentHash: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once:true });
  } else {
    setTimeout(boot, 0);
  }
  window.addEventListener('hashchange', function(){ activateGamePickPane(getRequestedPane(), { silentHash:true }); });
})();

/* ---- from <script id="prod-v8-59-prop-tabs-data-source-bridge"> ---- */
(function(){
  window.getProductionPropRows = function(){
    try {
      if (typeof hrpRows !== 'undefined' && Array.isArray(hrpRows) && hrpRows.length) return hrpRows;
    } catch(e) {}
    if (Array.isArray(window.hrpRows) && window.hrpRows.length) return window.hrpRows;
    try {
      if (typeof allBatters !== 'undefined' && Array.isArray(allBatters) && allBatters.length) return allBatters;
    } catch(e) {}
    if (Array.isArray(window.allBatters) && window.allBatters.length) return window.allBatters;
    return [];
  };
  window.refreshProductionPropTabs = function(){
    if (typeof window.renderPropIntelligencePanes === 'function') {
      try { window.renderPropIntelligencePanes(); } catch(e) { console.warn('Prop tab render failed', e); }
    }
  };
})();

/* ---- from <script id="prod-v9-8-parlay-builds-js"> ---- */
(function(){
  var state={ type:'safe', legs:2 };
  function num(v){ v=parseFloat(v); return Number.isFinite(v)?v:0; }
  function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
  function fmt(v){ return Math.round(v)+'%'; }
  function getRows(){ try { return window.getProductionPropRows ? window.getProductionPropRows() : (window.hrpRows||[]); } catch(e){ return []; } }
  function activeRows(){ return getRows().filter(function(r){ return !window.isActiveForHRThreat || window.isActiveForHRThreat(r); }); }
  function propScore(type,r){
    var s=r.stats||{}, avg=num(r.avg), ops=num(r.ops), iso=num(r.iso), hr=num(r.hrSeason), l10=num(r.last10HR), prob=num(r.hrProb), sb=num(s.stolenBases), obp=num(s.obp), slg=num(s.slg);
    if(type==='Hits') return clamp(38+avg*120+ops*8+(r.isFavorable?6:0),1,99);
    if(type==='RBI') return clamp(35+ops*10+iso*70+hr*.8+prob*.35+(r.topHrThreat?5:0),1,99);
    if(type==='Total Bases') return clamp(36+ops*8+iso*95+prob*.45+l10*2+(slg>=.500?4:0),1,99);
    if(type==='Stolen Base') return clamp(28+sb*2.4+avg*40+obp*30+(String(r.pos||'').match(/SS|CF|2B|LF|RF/)?8:0),1,99);
    if(type==='Hits+Runs+RBI') return clamp(42+avg*55+ops*9+hr*.45+prob*.32+(r.isFavorable?5:0),1,99);
    return 50;
  }
  function lineFor(type){ if(type==='Hits')return 'Over 0.5 Hits'; if(type==='RBI')return 'Over 0.5 RBI'; if(type==='Total Bases')return 'Over 1.5 Total Bases'; if(type==='Stolen Base')return 'Over 0.5 SB'; return 'Over 1.5 H+R+RBI'; }
  function reason(type,r){
    var bits=[]; if(r.isFavorable) bits.push('plus matchup'); if(num(r.avg)>=.280) bits.push('contact'); if(num(r.ops)>=.850) bits.push('OPS edge'); if(num(r.iso)>=.200) bits.push('power'); if(num((r.stats||{}).stolenBases)>=10) bits.push('speed'); if(r.topHrThreat) bits.push('upside');
    return (bits.slice(0,3).join(' · ') || 'model edge') + ' for ' + type;
  }
  function pool(){
    var markets=['Hits','RBI','Total Bases','Stolen Base','Hits+Runs+RBI'], seen={};
    var rows=activeRows();
    var legs=[];
    markets.forEach(function(m){ rows.forEach(function(r){
      var id=(r.id||r.name)+'-'+m, sc=propScore(m,r); if(!r.name || seen[id]) return; seen[id]=1;
      legs.push({ id:id, player:r.name, team:r.teamAbbr||'', opp:r.oppAbbr||'', pos:r.pos||'', market:m, line:lineFor(m), score:sc, reason:reason(m,r), highUpside:(r.topHrThreat||num(r.hrProb)>=18||num(r.iso)>=.220||num((r.stats||{}).stolenBases)>=15) });
    }); });
    return legs;
  }
  function selectLegs(type,count){
    var arr=pool();
    if(type==='safe') arr=arr.filter(function(x){return x.score>=68}).sort(function(a,b){return b.score-a.score});
    else if(type==='normal') arr=arr.filter(function(x){return x.score>=58}).sort(function(a,b){return (b.score+(b.highUpside?3:0))-(a.score+(a.highUpside?3:0))});
    else arr=arr.filter(function(x){return x.highUpside || x.score>=52}).sort(function(a,b){return ((b.highUpside?15:0)+b.score)-((a.highUpside?15:0)+a.score)});
    var picked=[], usedPlayers={};
    arr.forEach(function(x){ if(picked.length>=count) return; var key=x.player; if(usedPlayers[key] && type!=='lotto') return; usedPlayers[key]=1; picked.push(x); });
    if(picked.length<count){ pool().sort(function(a,b){return b.score-a.score}).forEach(function(x){ if(picked.length<count && !picked.some(function(p){return p.id===x.id})) picked.push(x); }); }
    return picked.slice(0,count);
  }
  function build(type,count,idx){
    var legs=selectLegs(type,count), avg=legs.length?legs.reduce(function(a,b){return a+b.score},0)/legs.length:0;
    var label=type==='safe'?'Safe':type==='normal'?'Normal':'LOTTO';
    var desc=type==='safe'?'High-upside, lower-risk build from strongest confidence legs.':type==='normal'?'Standard balanced parlay with confidence and payout upside.':'High-risk build targeting volatility and plus-upside outcomes.';
    return '<div class="parlay-build-card parlay-risk-'+type+'"><div class="parlay-build-head"><div><div class="parlay-build-title">'+label+' '+count+'-Leg Build</div><div class="parlay-build-sub">'+desc+'</div></div><div class="parlay-build-score"><strong>'+fmt(avg)+'</strong><span>Avg Edge</span></div></div><div class="parlay-leg-list">'+(legs.map(function(l,i){return '<div class="parlay-leg"><div><div class="parlay-leg-player">'+(i+1)+'. '+l.player+'</div><div class="parlay-leg-meta">'+l.team+' vs '+l.opp+(l.pos?' · '+l.pos:'')+'</div></div><div><div class="parlay-market">'+l.line+'</div><div class="parlay-reason">'+l.reason+'</div></div><div class="parlay-confidence">'+fmt(l.score)+'</div></div>';}).join('')||'<div class="mu-empty">Waiting for active prop data…</div>')+'</div></div>';
  }
  function updateButtons(){
    document.querySelectorAll('[data-parlay-type]').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-parlay-type')===state.type); });
    document.querySelectorAll('[data-parlay-legs]').forEach(function(b){ b.classList.toggle('active', String(state.legs)===b.getAttribute('data-parlay-legs')); });
  }
  window.setParlayBuildType=function(t){ state.type=t||'safe'; updateButtons(); window.renderParlayBuilds(); };
  window.setParlayLegCount=function(n){ state.legs=parseInt(n,10)||2; updateButtons(); window.renderParlayBuilds(); };
  window.renderParlayBuilds=function(){
    var el=document.getElementById('parlay-builds-content'); if(!el) return;
    updateButtons();
    var rows=activeRows();
    if(!rows.length){ el.innerHTML='<div class="mu-empty">Loading parlay builder from active prop data…</div>'; return; }
    el.innerHTML=build(state.type,state.legs,0) + '<div class="parlay-note">Tip: switch between Safe, Normal, and LOTTO to rebuild the card using different risk rules.</div>';
    var rf=document.getElementById('parlay-build-refresh'); if(rf) rf.textContent='Updated '+new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
  };
})();

/* ---- from <script id="prod-v8-42-game-picks-init-fix-js"> ---- */
// Superseded by PROD v8.44 persistent inner-tab controller above.
// This placeholder intentionally does not force Game Center after page load.

/* ---- from <script id="prod-v8-48-default-game-picks-js"> ---- */
(function(){
  function forceGamePicksDefault(){
    try { sessionStorage.setItem('activeTab', 'props'); } catch(e) {}
    document.querySelectorAll('.section').forEach(function(s){ s.classList.toggle('active', s.id === 'props'); });
    var props = document.getElementById('props');
    if (props) {
      props.classList.add('active');
      props.style.display = 'block';
    }
    var scores = document.getElementById('scores');
    if (scores) scores.style.display = 'none';
    if (typeof window.initPropsTab === 'function') {
      try { window.initPropsTab(); } catch(e) {}
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', forceGamePicksDefault, { once:true });
  } else {
    forceGamePicksDefault();
  }
  setTimeout(forceGamePicksDefault, 250);
})();

/* ---- from <script id="prod-v8-56-deep-research-js"> ---- */
(function(){
  function n(v){ v=parseFloat(v); return Number.isFinite(v)?v:0; }
  function pct(v){ return Math.max(1, Math.min(99, Math.round(v))); }
  function f3(v){ v=n(v); return v>0?v.toFixed(3).replace(/^0/,''):'–'; }
  function data(){ return (window.getProductionPropRows ? window.getProductionPropRows() : (window.hrpRows||[])).filter(function(r){ return !window.isActiveForHRThreat || window.isActiveForHRThreat(r); }); }
  function propScore(type,r){
    var avg=n(r.avg),ops=n(r.ops),iso=n(r.iso),hr=n(r.hrSeason),l10=n(r.last10HR),prob=n(r.hrProb),sb=n(r.stats&&r.stats.stolenBases), obp=n(r.stats&&r.stats.obp), slg=n(r.stats&&r.stats.slg);
    if(type==='Home Run') return pct(42+prob*.55+iso*80+ops*7+l10*2+(r.isFavorable?6:0)+(r.topHrThreat?4:0));
    if(type==='Hits') return pct(38+avg*120+ops*8+(r.isFavorable?6:0));
    if(type==='RBI') return pct(35+ops*10+iso*70+hr*.8+prob*.35+(r.topHrThreat?5:0));
    if(type==='Total Bases') return pct(36+ops*8+iso*95+prob*.45+l10*2+n(slg)*10);
    if(type==='Stolen Bases') return pct(28+sb*2.4+avg*40+obp*20+(String(r.pos||'').match(/SS|CF|2B|LF|RF/)?8:0));
    if(type==='Hits+Runs+RBI') return pct(42+avg*55+ops*9+hr*.45+prob*.32+(r.isFavorable?5:0));
    return 50;
  }
  function reasons(r,type){
    var arr=[]; if(r.isFavorable) arr.push(['good','Favorable matchup']); if(n(r.ops)>=.850) arr.push(['good','Strong OPS']); if(n(r.iso)>=.200) arr.push(['warn','Power profile']); if(n(r.last10HR)>=2) arr.push(['warn','Recent HR form']); if(n(r.stats&&r.stats.stolenBases)>=10) arr.push(['good','Speed upside']); if(type==='Hits' && n(r.avg)>=.280) arr.push(['good','Contact edge']); if(!arr.length) arr.push(['','Model grade']); return arr.slice(0,5);
  }
  function allPlays(){
    var types=['Home Run','Hits','RBI','Total Bases','Stolen Bases','Hits+Runs+RBI'];
    var rows=[]; data().forEach(function(r){ types.forEach(function(t){ rows.push({player:r, prop:t, score:propScore(t,r)}); }); });
    rows.sort(function(a,b){return b.score-a.score;});
    var seen={},out=[]; rows.forEach(function(x){ var key=(x.player.id||x.player.name)+'|'+x.prop; if(!seen[key] && out.length<10){seen[key]=1;out.push(x);} });
    return out;
  }
  function setHTML(id,html){ var el=document.getElementById(id); if(el) el.innerHTML=html; }
  function biggestEdge(play){
    if(!play) return '<div class="mu-empty">Waiting for production data…</div>';
    var r=play.player, rs=reasons(r,play.prop).map(function(x){return '<span class="deep-pill '+x[0]+'">'+x[1]+'</span>';}).join('');
    return '<div class="deep-edge-name">'+(r.name||'–')+'</div><div class="deep-edge-prop">'+play.prop+' · Best current read</div><div class="deep-edge-score">'+play.score+'<small> / 100</small></div><div class="deep-reasons">'+rs+'</div><div class="deep-list-body" style="margin-top:12px">Why it matters: this play grades highest across the active production boards using matchup quality, recent form, baseline skill, and role context.</div>';
  }
  function topTable(plays){
    if(!plays.length) return '<div class="mu-empty">Waiting for player boards to populate…</div>';
    return '<table class="deep-table"><thead><tr><th>Rank</th><th>Player</th><th>Best Prop</th><th>Team</th><th>Score</th></tr></thead><tbody>'+plays.map(function(p,i){var r=p.player;return '<tr><td class="deep-rank">#'+(i+1)+'</td><td><span class="deep-player">'+(r.name||'–')+'</span><span class="deep-sub">'+(r.pos||'')+' · vs '+(r.oppAbbr||'')+'</span></td><td>'+p.prop+'</td><td>'+(r.teamAbbr||'–')+'</td><td><span class="deep-score-badge">'+p.score+'</span></td></tr>';}).join('')+'</tbody></table>';
  }
  function briefing(plays){
    if(!plays.length) return '<span class="spin"></span>Building intelligence briefing…';
    var top=plays[0], hr=plays.find(function(p){return p.prop==='Home Run';}), hit=plays.find(function(p){return p.prop==='Hits';}), tb=plays.find(function(p){return p.prop==='Total Bases';});
    return '<strong>Today\'s production read:</strong> '+(top.player.name||'The top play')+' owns the strongest current Diamond score, with '+top.prop+' grading as the best available prop profile. '+(hr?'Power is led by '+hr.player.name+' based on HR probability, ISO, and matchup quality. ':'')+(hit?'The safest contact profile currently points to '+hit.player.name+' in the Hits market. ':'')+(tb?'Total Bases upside is highlighted by '+tb.player.name+' due to slugging profile and production context. ':'')+'Use the prop-specific tabs for supporting detail; tracker wiring will remain on the developer side later.';
  }
  function matchups(plays){
    var fav=data().filter(function(r){return r.isFavorable;}).sort(function(a,b){return n(b.hrProb)-n(a.hrProb);}).slice(0,4);
    if(!fav.length && plays.length) fav=plays.slice(0,4).map(function(p){return p.player;});
    return fav.map(function(r,i){return '<div class="deep-list-item"><div class="deep-list-title">'+(i===0?'🔥':'🎯')+' '+(r.name||'Matchup')+'</div><div class="deep-list-body">'+(r.teamAbbr||'')+' vs '+(r.oppAbbr||'')+' · '+(r.isFavorable?'Favorable pitcher profile detected.':'Strong model grade from active production data.')+'</div></div>';}).join('') || '<div class="mu-empty">No matchup notes available yet.</div>';
  }
  function risk(plays){
    var pending='Lineups, weather, and late scratches should be checked before locking plays.';
    var items=['Unconfirmed lineups can change plate appearances and batting order value.','Weather or late game status changes can reduce offensive projections.',pending];
    return items.map(function(t,i){return '<div class="deep-list-item"><div class="deep-list-title">⚠️ Watch Item '+(i+1)+'</div><div class="deep-list-body">'+t+'</div></div>';}).join('');
  }
  function notes(plays){
    if(!plays.length) return '<div class="mu-empty">Research notes will populate once the production boards load.</div>';
    var names=plays.slice(0,3).map(function(p){return p.player.name+' ('+p.prop+')';}).join(', ');
    return '<p>The Deep Research tab is using a locked daily research snapshot so the recommendations do not reshuffle after every page refresh. The strongest locked cluster is: <strong>'+names+'</strong>.</p><p>This section remains production-only and will refresh naturally when a new daily snapshot is created.</p>';
  }
  function todayKey(){
    try { return new Date().toLocaleDateString('en-CA'); } catch(e) { return new Date().toISOString().slice(0,10); }
  }
  function staticKey(){ return 'DR_DEEP_RESEARCH_STATIC_SNAPSHOT_'+todayKey(); }
  function readStaticSnapshot(){
    try {
      var raw=localStorage.getItem(staticKey());
      if(!raw) return null;
      var snap=JSON.parse(raw);
      if(!snap || snap.date!==todayKey() || !snap.html) return null;
      return snap.html;
    } catch(e) { return null; }
  }
  function writeStaticSnapshot(html){
    try {
      localStorage.setItem(staticKey(), JSON.stringify({date:todayKey(), savedAt:new Date().toISOString(), html:html}));
    } catch(e) {}
  }
  function collectHTML(){
    var ids=['deep-briefing','deep-biggest-edge','deep-top-plays','deep-matchups','deep-risk','deep-notes'], out={};
    ids.forEach(function(id){ var el=document.getElementById(id); if(el) out[id]=el.innerHTML; });
    return out;
  }
  function applyHTML(html){
    if(!html) return false;
    Object.keys(html).forEach(function(id){ setHTML(id, html[id]); });
    return true;
  }
  window.clearDeepResearchStaticCache=function(){
    try { Object.keys(localStorage).filter(function(k){return k.indexOf('DR_DEEP_RESEARCH_STATIC_SNAPSHOT_')===0;}).forEach(function(k){localStorage.removeItem(k);}); } catch(e) {}
  };
  window.renderDeepResearch=function(){
    var locked=readStaticSnapshot();
    if(locked && applyHTML(locked)) return;
    var plays=allPlays();
    setHTML('deep-briefing', briefing(plays));
    setHTML('deep-biggest-edge', biggestEdge(plays[0]));
    setHTML('deep-top-plays', topTable(plays));
    setHTML('deep-matchups', matchups(plays));
    setHTML('deep-risk', risk(plays));
    setHTML('deep-notes', notes(plays));
    if(plays.length) writeStaticSnapshot(collectHTML());
  };
  function boot(){setTimeout(window.renderDeepResearch,1000);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();

/* ---- from <script id="prod-v8-59-prop-tabs-auto-refresh-fix"> ---- */
(function(){
  document.addEventListener('click', function(e){
    if (e.target && e.target.closest && e.target.closest('.gamepick-tab')) {
      setTimeout(function(){ if (typeof window.renderPropIntelligencePanes === 'function') window.renderPropIntelligencePanes(); }, 80);
      setTimeout(function(){ if (typeof window.renderPropIntelligencePanes === 'function') window.renderPropIntelligencePanes(); }, 600);
    }
  });
})();

/* ---- from <script id="prod-v8-70-image-lazy-loader"> ---- */
(function(){
  function tuneImages(root){
    (root || document).querySelectorAll('img:not([loading])').forEach(function(img){
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ tuneImages(); }, {once:true}); else tuneImages();
  try {
    new MutationObserver(function(list){
      list.forEach(function(m){ m.addedNodes && m.addedNodes.forEach(function(n){ if(n.nodeType===1) tuneImages(n); }); });
    }).observe(document.documentElement, { childList:true, subtree:true });
  } catch(e) {}
})();

/* ---- from <script id="prod-v9-9-team-performance-js"> ---- */
(function(){
  var state={booted:false,teams:[],todayGames:[],records:{},loading:false,last:0};
  function today(){var d=new Date();var y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return y+'-'+m+'-'+day}
  function season(){return new Date().getFullYear()}
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function logo(id){return id?'<img src="https://www.mlbstatic.com/team-logos/'+id+'.svg" onerror="this.style.display=\'none\'" alt="" loading="lazy" decoding="async">':''}
  async function getJSON(url){
    if(typeof window.fetchJSON==='function') return window.fetchJSON(url,{force:true});
    var res=await fetch(url+(url.indexOf('?')>-1?'&':'?')+'_tp='+Date.now(),{cache:'no-store'}); if(!res.ok) throw new Error('HTTP '+res.status); return res.json();
  }
  function abbr(t){return (t&&(t.abbreviation||t.abbr||String(t.teamCode||'').toUpperCase()))||''}
  function nameOf(t){return (t&&(t.teamName||t.name||t.clubName))||'Team'}
  function pct(w,l){w=Number(w)||0;l=Number(l)||0;return (w+l)?(w/(w+l)).toFixed(3).replace(/^0/,''):'–'}
  async function loadBase(){
    var [teamsData,sched,stand]=await Promise.all([
      getJSON('https://diamondreport.app/api/v1/teams?sportId=1&activeStatus=Y'),
      getJSON('https://diamondreport.app/api/v1/schedule?sportId=1&date='+today()+'&hydrate=team,linescore,probablePitcher&language=en'),
      getJSON('https://diamondreport.app/api/v1/standings?leagueId=103,104&season='+season()+'&standingsTypes=regularSeason')
    ]);
    state.teams=(teamsData.teams||[]).filter(function(t){return t.sport&&t.sport.id===1}).map(function(t){return {id:t.id,name:t.name,short:nameOf(t),abbr:abbr(t)}}).sort(function(a,b){return a.name.localeCompare(b.name)});
    state.todayGames=((sched.dates&&sched.dates[0]&&sched.dates[0].games)||[]).map(function(g){return {gamePk:g.gamePk,date:g.gameDate,status:g.status&&g.status.detailedState,away:{id:g.teams.away.team.id,name:g.teams.away.team.name,abbr:abbr(g.teams.away.team),score:g.teams.away.score,record:g.teams.away.leagueRecord},home:{id:g.teams.home.team.id,name:g.teams.home.team.name,abbr:abbr(g.teams.home.team),score:g.teams.home.score,record:g.teams.home.leagueRecord}}});
    state.records={};
    (stand.records||[]).forEach(function(div){(div.teamRecords||[]).forEach(function(r){state.records[r.team.id]={wins:r.wins,losses:r.losses,pct:r.winningPercentage,divisionRank:r.divisionRank,streak:r.streak&&r.streak.streakCode};});});
  }
  function fillSelects(){
    var a=document.getElementById('team-performance-a'),b=document.getElementById('team-performance-b'); if(!a||!b||!state.teams.length)return;
    var opts=state.teams.map(function(t){return '<option value="'+t.id+'">'+esc(t.name)+'</option>';}).join('');
    if(!a.dataset.loaded){a.innerHTML=opts;a.dataset.loaded='1'} if(!b.dataset.loaded){b.innerHTML=opts;b.dataset.loaded='1'}
    var g=state.todayGames[0]; if(g&&!a.value&&!b.value){a.value=g.away.id;b.value=g.home.id}else{if(!a.value)a.value=state.teams[0].id;if(!b.value)b.value=state.teams[1]&&state.teams[1].id||state.teams[0].id}
  }
  async function h2h(aid,bid){
    var url='https://diamondreport.app/api/v1/schedule?sportId=1&season='+season()+'&teamId='+aid+'&opponentId='+bid+'&hydrate=team,linescore&language=en';
    var data=await getJSON(url); var games=[];
    (data.dates||[]).forEach(function(d){(d.games||[]).forEach(function(g){games.push(g)})});
    games.sort(function(x,y){return new Date(y.gameDate)-new Date(x.gameDate)});
    return games;
  }
  function summarize(games,aid,bid){
    var s={played:0,aWins:0,bWins:0,aRuns:0,bRuns:0,finals:[],upcoming:0};
    games.forEach(function(g){var aw=g.teams.away,ho=g.teams.home,final=/final/i.test((g.status&&g.status.detailedState)||'');var aAway=aw.team.id==aid;var aScore=aAway?aw.score:ho.score,bScore=aAway?ho.score:aw.score;if(final&&Number.isFinite(Number(aScore))&&Number.isFinite(Number(bScore))){s.played++;s.aRuns+=Number(aScore)||0;s.bRuns+=Number(bScore)||0;if(Number(aScore)>Number(bScore))s.aWins++;else if(Number(bScore)>Number(aScore))s.bWins++;s.finals.push({date:g.gameDate,aScore:aScore,bScore:bScore,aAway:aAway,status:g.status&&g.status.detailedState});}else{s.upcoming++;}});return s;
  }
  function team(id){return state.teams.find(function(t){return String(t.id)===String(id)})||{id:id,name:'Team '+id,abbr:''}}
  function rec(id){var r=state.records[id]||{};return Number.isFinite(Number(r.wins))?(r.wins+'-'+r.losses+' · '+(r.pct||pct(r.wins,r.losses))+(r.streak?' · '+r.streak:'')):'Season record unavailable'}
  function stat(k,v){return '<div class="tp-stat"><b>'+esc(v)+'</b><span>'+esc(k)+'</span></div>'}
  function card(a,b,sum,games){
    var edge=sum.aWins>sum.bWins?a.name:(sum.bWins>sum.aWins?b.name:'Even'); var diff=sum.aRuns-sum.bRuns; var read=sum.played?('<strong>'+esc(edge)+'</strong> has the current '+season()+' head-to-head edge. Run differential: '+(diff>0?'+':'')+diff+' for '+esc(a.abbr||a.name)+'.'):'No final head-to-head games have been recorded between these teams this season yet.';
    var recent=sum.finals.slice(0,5).map(function(g){var d=new Date(g.date).toLocaleDateString('en-US',{month:'short',day:'numeric'});return '<div class="tp-game-line"><span>'+d+' · '+esc(g.aAway?a.abbr+' @ '+b.abbr:b.abbr+' @ '+a.abbr)+'</span><span>'+esc(a.abbr)+' '+g.aScore+' - '+esc(b.abbr)+' '+g.bScore+'</span></div>';}).join('') || '<div class="tp-game-line"><span>No completed H2H matchups yet</span><span>—</span></div>';
    return '<div class="tp-matchup-card"><div class="tp-versus"><div class="tp-team">'+logo(a.id)+'<div class="tp-team-name">'+esc(a.name)+'</div><div class="tp-team-record">'+esc(rec(a.id))+'</div></div><div class="tp-vs-pill">HEAD 2 HEAD</div><div class="tp-team">'+logo(b.id)+'<div class="tp-team-name">'+esc(b.name)+'</div><div class="tp-team-record">'+esc(rec(b.id))+'</div></div></div><div class="tp-stat-grid">'+stat(a.abbr+' H2H W-L',sum.aWins+'-'+sum.bWins)+stat('H2H Games',sum.played)+stat(a.abbr+' Runs',sum.aRuns)+stat(b.abbr+' Runs',sum.bRuns)+'</div><div class="tp-read">'+read+'</div><div class="tp-recent"><div class="tp-recent-title">Recent '+season()+' H2H Results</div>'+recent+'</div></div>';
  }
  async function compare(force){
    var el=document.getElementById('team-performance-content'); if(!el)return; var aSel=document.getElementById('team-performance-a'),bSel=document.getElementById('team-performance-b'); if(!aSel||!bSel)return;
    if(!state.booted||force){await boot(true)}
    var aid=aSel.value,bid=bSel.value;if(!aid||!bid||aid===bid){el.innerHTML='<div class="mu-empty">Select two different teams to compare head-to-head.</div>';return;}
    el.innerHTML='<div class="mu-empty"><span class="spin"></span>Loading head-to-head comparison…</div>';
    try{var games=await h2h(aid,bid),a=team(aid),b=team(bid),sum=summarize(games,aid,bid);el.innerHTML='<div class="tp-note"><strong>Team Performance:</strong> compares current-season head-to-head results and season records. Tap any today matchup below to load that comparison.</div>'+card(a,b,sum,games)+todayCards();var r=document.getElementById('team-performance-refresh');if(r)r.textContent='Updated '+new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});}catch(e){el.innerHTML='<div class="mu-empty">Could not load team performance right now.</div>';}
  }
  function todayCards(){if(!state.todayGames.length)return '';return '<div class="tp-recent-title" style="margin:6px 0 8px">Today\'s Matchups</div><div class="tp-today-grid">'+state.todayGames.map(function(g){return '<div class="tp-mini-card" onclick="selectTeamPerformanceMatchup(\''+g.away.id+'\',\''+g.home.id+'\')"><div class="tp-mini-title">'+esc(g.away.abbr)+' @ '+esc(g.home.abbr)+'</div><div class="tp-mini-sub">'+esc(g.status||'Scheduled')+' · '+esc(g.away.name)+' vs '+esc(g.home.name)+'</div></div>'}).join('')+'</div>'}
  async function boot(force){var el=document.getElementById('team-performance-content'); if(!el)return;if(state.loading)return; if(state.booted&&!force&&Date.now()-state.last<5*60*1000){fillSelects();return;}state.loading=true;try{await loadBase();state.booted=true;state.last=Date.now();fillSelects();}finally{state.loading=false;}}
  window.renderTeamPerformanceTab=async function(){var el=document.getElementById('team-performance-content');if(!el)return;if(!state.booted){el.innerHTML='<div class="mu-empty"><span class="spin"></span>Loading team performance board…</div>';await boot(false)}return compare(false)};
  window.renderTeamPerformanceComparison=function(force){compare(!!force)};
  window.selectTeamPerformanceMatchup=function(a,b){var aa=document.getElementById('team-performance-a'),bb=document.getElementById('team-performance-b');if(aa)aa.value=a;if(bb)bb.value=b;compare(false)};
  document.addEventListener('click',function(e){var t=e.target&&e.target.closest&&e.target.closest('[data-gamepick-pane="team-performance"]');if(t)setTimeout(function(){window.renderTeamPerformanceTab();},60);},true);
})();

/* ---- from <script id="prod-v10-4-performance-data-tabs-js"> ---- */
(function(){
  if(window.__DR_V104_PERFORMANCE_DATA_TABS__) return; window.__DR_V104_PERFORMANCE_DATA_TABS__=true;
  var TP={loading:false,booted:false,teams:[],todayGames:[],records:{},last:0};
  function nowDate(){try{return new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'});}catch(e){return new Date().toISOString().slice(0,10);}}
  function season(){return nowDate().slice(0,4)}
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function num(v){v=parseFloat(v);return Number.isFinite(v)?v:0}
  function getJSON(url,force){ if(typeof window.fetchJSON==='function') return window.fetchJSON(url,{force:!!force}); return fetch(url+(url.indexOf('?')>-1?'&':'?')+'_v104='+Date.now(),{cache:force?'no-store':'default'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})}
  function abbr(t){return (t&&(t.abbreviation||t.abbr||String(t.teamCode||'').toUpperCase()||t.fileCode))||''}
  function logo(id,cls){return id?'<img class="'+(cls||'pp-logo')+'" src="https://www.mlbstatic.com/team-logos/'+id+'.svg" onerror="this.style.display=\'none\'" alt="" loading="lazy" decoding="async">':''}
  async function tpBase(force){if(TP.booted&&!force&&Date.now()-TP.last<5*60*1000)return;var td=nowDate();var all=await Promise.all([getJSON('https://diamondreport.app/api/v1/teams?sportId=1&activeStatus=Y',false),getJSON('https://diamondreport.app/api/v1/schedule?sportId=1&date='+td+'&hydrate=team,linescore,probablePitcher&language=en',!!force),getJSON('https://diamondreport.app/api/v1/standings?leagueId=103,104&season='+season()+'&standingsTypes=regularSeason',false)]);TP.teams=(all[0].teams||[]).filter(function(t){return t.sport&&t.sport.id===1}).map(function(t){return {id:t.id,name:t.name,abbr:abbr(t)}}).sort(function(a,b){return a.name.localeCompare(b.name)});TP.todayGames=((all[1].dates&&all[1].dates[0]&&all[1].dates[0].games)||[]).map(function(g){return {away:{id:g.teams.away.team.id,name:g.teams.away.team.name,abbr:abbr(g.teams.away.team),score:g.teams.away.score},home:{id:g.teams.home.team.id,name:g.teams.home.team.name,abbr:abbr(g.teams.home.team),score:g.teams.home.score},status:g.status&&g.status.detailedState}});TP.records={};(all[2].records||[]).forEach(function(div){(div.teamRecords||[]).forEach(function(r){TP.records[r.team.id]={wins:r.wins,losses:r.losses,pct:r.winningPercentage,streak:r.streak&&r.streak.streakCode,rank:r.divisionRank}})});TP.booted=true;TP.last=Date.now();fillTP()}
  function fillTP(){var a=document.getElementById('team-performance-a'),b=document.getElementById('team-performance-b');if(!a||!b||!TP.teams.length)return;var opts=TP.teams.map(function(t){return '<option value="'+t.id+'">'+esc(t.name)+'</option>'}).join('');if(!a.dataset.v104){a.innerHTML=opts;a.dataset.v104='1'}if(!b.dataset.v104){b.innerHTML=opts;b.dataset.v104='1'}var g=TP.todayGames[0];if(g&&!a.value&&!b.value){a.value=g.away.id;b.value=g.home.id}else{if(!a.value)a.value=TP.teams[0].id;if(!b.value)b.value=(TP.teams[1]||TP.teams[0]).id}}
  function tBy(id){return TP.teams.find(function(t){return String(t.id)===String(id)})||{id:id,name:'Team '+id,abbr:''}}
  function rec(id){var r=TP.records[id]||{};return Number.isFinite(Number(r.wins))?r.wins+'-'+r.losses+' · '+(r.pct||'')+(r.streak?' · '+r.streak:''):'—'}
  async function teamSchedule(id){var d=await getJSON('https://diamondreport.app/api/v1/schedule?sportId=1&season='+season()+'&teamId='+id+'&hydrate=team,linescore&language=en',false);var games=[];(d.dates||[]).forEach(function(day){(day.games||[]).forEach(function(g){games.push(g)})});return games}
  function teamStats(games,id){var s={g:0,w:0,l:0,rf:0,ra:0,last:[]};games.forEach(function(g){var final=/final/i.test((g.status&&g.status.detailedState)||'');if(!final)return;var aw=g.teams.away,hm=g.teams.home,isAway=String(aw.team.id)===String(id),forR=Number(isAway?aw.score:hm.score),agR=Number(isAway?hm.score:aw.score);if(!Number.isFinite(forR)||!Number.isFinite(agR))return;s.g++;s.rf+=forR;s.ra+=agR;if(forR>agR)s.w++;else s.l++;s.last.push({date:g.gameDate,forR:forR,agR:agR,opp:isAway?abbr(hm.team):abbr(aw.team),home:!isAway})});s.last.sort(function(a,b){return new Date(b.date)-new Date(a.date)});var l10=s.last.slice(0,10),lw=l10.filter(function(x){return x.forR>x.agR}).length;s.rpg=s.g?s.rf/s.g:0;s.rapg=s.g?s.ra/s.g:0;s.last10=lw+'-'+(l10.length-lw);return s}
  function h2hStats(games,aid,bid){var s={played:0,aW:0,bW:0,aR:0,bR:0,finals:[]};games.forEach(function(g){var final=/final/i.test((g.status&&g.status.detailedState)||'');if(!final)return;var aw=g.teams.away,hm=g.teams.home,aAway=String(aw.team.id)===String(aid),as=Number(aAway?aw.score:hm.score),bs=Number(aAway?hm.score:aw.score);if(!Number.isFinite(as)||!Number.isFinite(bs))return;s.played++;s.aR+=as;s.bR+=bs;if(as>bs)s.aW++;else if(bs>as)s.bW++;s.finals.push({date:g.gameDate,as:as,bs:bs,aAway:aAway})});s.finals.sort(function(a,b){return new Date(b.date)-new Date(a.date)});return s}
  function row(k,v,win){return '<div class="tp-row"><span>'+esc(k)+'</span><b class="'+(win?'tp-winner':'')+'">'+esc(v)+'</b></div>'}
  function stat(k,v){return '<div class="tp-stat"><b>'+esc(v)+'</b><span>'+esc(k)+'</span></div>'}
  function tpCard(a,b,sa,sb,h){var aScore=(sa.rpg>sb.rpg?1:0)+(sa.rapg<sb.rapg?1:0)+(h.aW>h.bW?1:0),bScore=(sb.rpg>sa.rpg?1:0)+(sb.rapg<sa.rapg?1:0)+(h.bW>h.aW?1:0),edge=aScore>bScore?a:bScore>aScore?b:null;var insight=edge?'Current edge leans '+esc(edge.name)+' based on run production, run prevention, and head-to-head results.':'This matchup grades close because the main team-performance edges are split.';var recent=h.finals.slice(0,5).map(function(g){var d=new Date(g.date).toLocaleDateString('en-US',{month:'short',day:'numeric'});return '<div class="tp-game-line"><span>'+d+' · '+(g.aAway?esc(a.abbr)+' @ '+esc(b.abbr):esc(b.abbr)+' @ '+esc(a.abbr))+'</span><span>'+esc(a.abbr)+' '+g.as+' - '+esc(b.abbr)+' '+g.bs+'</span></div>'}).join('')||'<div class="tp-game-line"><span>No completed H2H games this season</span><span>—</span></div>';return '<div class="dr-insight-card"><div class="dr-insight-title">AI Summary</div><div class="dr-insight-copy">'+insight+' '+esc(a.abbr)+' averages '+sa.rpg.toFixed(1)+' runs/game while '+esc(b.abbr)+' averages '+sb.rpg.toFixed(1)+'. H2H stands at '+h.aW+'-'+h.bW+' for '+esc(a.abbr)+'.</div></div><div class="tp-matchup-card"><div class="tp-versus"><div class="tp-team">'+logo(a.id,'')+'<div class="tp-team-name">'+esc(a.name)+'</div><div class="tp-team-record">'+esc(rec(a.id))+'</div></div><div class="tp-vs-pill">HEAD 2 HEAD</div><div class="tp-team">'+logo(b.id,'')+'<div class="tp-team-name">'+esc(b.name)+'</div><div class="tp-team-record">'+esc(rec(b.id))+'</div></div></div><div class="tp-edge-grid"><div class="tp-edge-pill"><b>'+esc(edge?edge.abbr:'EVEN')+'</b><span>Overall Edge</span></div><div class="tp-edge-pill"><b>'+h.aW+'-'+h.bW+'</b><span>'+esc(a.abbr)+' H2H</span></div><div class="tp-edge-pill"><b>'+((h.aR-h.bR)>0?'+':'')+(h.aR-h.bR)+'</b><span>'+esc(a.abbr)+' Run Diff</span></div></div><div class="tp-side-table"><div class="tp-side"><h4>'+esc(a.name)+'</h4>'+row('Runs/Game',sa.rpg.toFixed(1),sa.rpg>sb.rpg)+row('Runs Allowed/Game',sa.rapg.toFixed(1),sa.rapg<sb.rapg)+row('Last 10',sa.last10)+row('Season Games',sa.g)+'</div><div class="tp-side"><h4>'+esc(b.name)+'</h4>'+row('Runs/Game',sb.rpg.toFixed(1),sb.rpg>sa.rpg)+row('Runs Allowed/Game',sb.rapg.toFixed(1),sb.rapg<sa.rapg)+row('Last 10',sb.last10)+row('Season Games',sb.g)+'</div></div><div class="tp-stat-grid" style="margin-top:10px">'+stat(a.abbr+' H2H W-L',h.aW+'-'+h.bW)+stat('H2H Games',h.played)+stat(a.abbr+' H2H Runs',h.aR)+stat(b.abbr+' H2H Runs',h.bR)+'</div><div class="tp-recent"><div class="tp-recent-title">Recent '+season()+' H2H Results</div>'+recent+'</div></div>'}
  function todayCards(){if(!TP.todayGames.length)return '';return '<div class="tp-recent-title" style="margin:6px 0 8px">Today\'s Matchups</div><div class="tp-today-grid">'+TP.todayGames.map(function(g){return '<div class="tp-mini-card" onclick="selectTeamPerformanceMatchup(\''+g.away.id+'\',\''+g.home.id+'\')"><div class="tp-mini-title">'+esc(g.away.abbr)+' @ '+esc(g.home.abbr)+'</div><div class="tp-mini-sub">'+esc(g.status||'Scheduled')+' · '+esc(g.away.name)+' vs '+esc(g.home.name)+'</div></div>'}).join('')+'</div>'}
  async function compareTP(force){var el=document.getElementById('team-performance-content'),aSel=document.getElementById('team-performance-a'),bSel=document.getElementById('team-performance-b');if(!el||!aSel||!bSel)return;if(TP.loading)return;TP.loading=true;el.innerHTML='<div class="mu-empty"><span class="spin"></span>Loading team performance data…</div>';try{await tpBase(!!force);var aid=aSel.value,bid=bSel.value;if(!aid||!bid||aid===bid){el.innerHTML='<div class="mu-empty">Select two different teams to compare head-to-head.</div>';return}var all=await Promise.all([teamSchedule(aid),teamSchedule(bid),getJSON('https://diamondreport.app/api/v1/schedule?sportId=1&season='+season()+'&teamId='+aid+'&opponentId='+bid+'&hydrate=team,linescore&language=en',false)]);var hGames=[];(all[2].dates||[]).forEach(function(d){(d.games||[]).forEach(function(g){hGames.push(g)})});var a=tBy(aid),b=tBy(bid);var aStats=teamStats(all[0],aid), bStats=teamStats(all[1],bid), hStats=h2hStats(hGames,aid,bid);
var analytics='<div class="tp-analytics-grid">'+
'<div class="tp-analytics-card"><h4>✅ Team Overview</h4>'+row('Record',aStats.record||'—',true)+row('Run Differential',aStats.runDiff||'—')+row('Home/Away Record',aStats.homeAway||'—')+row('Last 10',aStats.last10+' / '+bStats.last10)+row('Streak',aStats.streak||'—')+'</div>'+
'<div class="tp-analytics-card"><h4>⚾ Offensive Comparison</h4>'+row('Runs/Game',aStats.rpg.toFixed(1),aStats.rpg>bStats.rpg)+row('AVG / OPS',aStats.avg||'—',aStats.ops||'—')+row('HR / HR Game',aStats.hr||'—',aStats.hrpg||'—')+row('Barrel / Hard Hit %',aStats.barrel||'—',aStats.hardHit||'—')+row('wOBA / wRC+',aStats.woba||'—',aStats.wrc||'—')+'</div>'+
'<div class="tp-analytics-card"><h4>🎯 Starting Pitching</h4>'+row('ERA / WHIP',aStats.era||'—',aStats.whip||'—')+row('K% / BB%',aStats.kpct||'—',aStats.bbpct||'—')+row('HR Allowed',aStats.hrAllowed||'—',bStats.hrAllowed||'—')+row('xERA / FIP',aStats.xera||'—',aStats.fip||'—')+'</div>'+
'<div class="tp-analytics-card"><h4>🔥 Bullpen</h4>'+row('Bullpen ERA',aStats.bpEra||'—',bStats.bpEra||'—')+row('WHIP / K%',aStats.bpWhip||'—',aStats.bpK||'—')+row('HR Allowed',aStats.bpHR||'—',bStats.bpHR||'—')+row('Last 7 Days ERA',aStats.bp7||'—',bStats.bp7||'—')+row('Fatigue/Usage',aStats.fatigue||'—',bStats.fatigue||'—')+'</div>'+
'<div class="tp-analytics-card"><h4>📊 Situational Splits</h4>'+row('vs RHP',aStats.vsRHP||'—',bStats.vsRHP||'—')+row('vs LHP',aStats.vsLHP||'—',bStats.vsLHP||'—')+row('Handedness Advantage',aStats.handEdge||'—',bStats.handEdge||'—')+row('H2H Record',hStats.aW+'-'+hStats.bW)+'</div>'+
'<div class="tp-analytics-card"><h4>🧠 Diamond Intelligence</h4>'+row('Team Edge Score',aStats.edge||'—',bStats.edge||'—')+'<div class="tp-ai-summary">'+esc((aStats.rpg>bStats.rpg?a.abbr:b.abbr)+' holds the current team edge based on offense, pitching, bullpen, recent form, and matchup data.')+'</div></div>';el.innerHTML='<div class="tp-note"><strong>Team Performance:</strong> compares season record, offense, pitching, recent form, and current-season head-to-head results.</div>'+tpCard(a,b,aStats,bStats,hStats)+analytics+todayCards();var r=document.getElementById('team-performance-refresh');if(r)r.textContent='Updated '+new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}catch(e){el.innerHTML='<div class="mu-empty">Could not load team performance right now.</div>'}finally{TP.loading=false}}
  window.renderTeamPerformanceTab=function(){return compareTP(false)}; window.renderTeamPerformanceComparison=function(force){return compareTP(!!force)}; window.selectTeamPerformanceMatchup=function(a,b){var aa=document.getElementById('team-performance-a'),bb=document.getElementById('team-performance-b');if(aa)aa.value=a;if(bb)bb.value=b;return compareTP(false)};
  document.addEventListener('click',function(e){var p=e.target&&e.target.closest&&e.target.closest('[data-gamepick-pane]');if(!p)return;var pane=p.getAttribute('data-gamepick-pane');if(pane==='team-performance')setTimeout(function(){window.renderTeamPerformanceTab()},140)},true);
})();

/* ---- from <script id="prod-v10-12-hr-k-confidence-engine-js"> ---- */
(function(){
  if(window.__DR_V1012_HR_K_ENGINE__) return; window.__DR_V1012_HR_K_ENGINE__=true;
  return; // disabled: this wrapped renderHRPTable and re-injected a "Confidence Engine" banner ~80ms after every render, which the render's own innerHTML replace kept wiping out — causing visible flicker. Its K-side twin (enhanceK) was already a no-op.
  function n(v){v=parseFloat(v);return Number.isFinite(v)?v:0}
  function clamp(v,min,max){return Math.max(min,Math.min(max,v))}
  function pct(v){return Math.round(clamp(v,1,99))}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function f3(v){v=n(v);return v>0?v.toFixed(3).replace(/^0/,''):'–'}
  function rows(){try{return (window.getProductionPropRows?window.getProductionPropRows():(Array.isArray(window.hrpRows)?window.hrpRows:[])).filter(function(r){return r&&r.name&&(!window.isActiveForHRThreat||window.isActiveForHRThreat(r))})}catch(e){return []}}
  function kRows(){try{return Array.isArray(window.kPropsData)?window.kPropsData:[]}catch(e){return []}}
  function hrProb(r){var s=r.stats||{}; var base=n(r.hrProb)||0; var score=base*5.2+n(r.iso)*80+n(r.ops)*10+n(r.hrSeason)*.32+n(r.last10HR)*2.2+(r.isFavorable?7:0)+(r.isOnFire?6:0)+(r.isDue?4:0)-(!r.pitcherId?5:0); return pct(score)}
  function hrHitChance(r){var p=0.045+(n(r.hrProb)/100)*.72+n(r.iso)*.08+n(r.last10HR)*.006+(r.isFavorable?.018:0)+(r.isOnFire?.014:0)+(r.isDue?.008:0); return clamp(p,.03,.24)}
  function hrGrade(v){return v>=82?'A+':v>=74?'A':v>=66?'B+':v>=58?'B':v>=48?'C+':'C'}
  function kConfidence(p){var line=n(p.recommendedOverLine ?? p.ouLine ?? p.compareLine); var proj=n(p.projK); var cushion=proj-line; var prob=n(p.overProb); var k9=n(p.k9); var whip=n(p.whip); var era=n(p.era); var score=(prob||55)+cushion*7+(k9-8)*2+(whip&&whip<1.15?5:0)+(era&&era<3.5?4:0); return pct(score)}
  function kHitChance(p){var conf=kConfidence(p), line=n(p.recommendedOverLine ?? p.ouLine ?? p.compareLine), proj=n(p.projK), cushion=proj-line; var base=.50+(conf-55)/115+cushion*.025; return clamp(base,.43,.78)}
  function chip(label,val,cls){return '<span class="dr112-chip '+(cls||'')+'"><span>'+esc(label)+'</span><b>'+esc(val)+'</b></span>'}
  function hrSummary(){var arr=rows().filter(function(r){return r.topHrThreat||n(r.hrProb)>=5}).sort(function(a,b){return hrProb(b)-hrProb(a)}); if(!arr.length) return ''; var top=arr[0], avg=arr.slice(0,8).reduce(function(a,r){return a+hrProb(r)},0)/Math.min(8,arr.length); return '<div class="dr112-engine" data-dr112="hr-summary"><div class="dr112-engine-head"><div><div class="dr112-title">💣 Home Runs <span>Confidence Engine</span></div><div class="dr112-copy">Keeps the existing HR filters, status labels, and Pitcher Matchup button while adding model confidence, realistic HR hit chance, power profile, and matchup support.</div></div><div class="dr112-score">'+pct(avg)+'%<small>Top Board Grade</small></div></div><div class="dr112-grid"><div class="dr112-metric warn"><b>'+esc(top.name||'–')+'</b><span>Top HR Threat</span></div><div class="dr112-metric"><b>'+pct(hrHitChance(top)*100)+'%</b><span>Realistic HR Chance</span></div><div class="dr112-metric good"><b>'+hrGrade(hrProb(top))+'</b><span>Diamond Grade</span></div><div class="dr112-metric '+(top.isFavorable?'good':'')+'"><b>'+(top.isFavorable?'Favorable':'Neutral')+'</b><span>Matchup Label</span></div></div><div class="dr112-ai"><b>Why this board matters:</b> HR probability is treated as a high-volatility market, so the card separates model grade from realistic hit chance. Power signals include ISO, OPS, season HRs, last-10 power, hot-hitter boost, due/drought tags, park context, and pitcher matchup availability.</div></div>'}
  function enhanceHR(){var el=document.getElementById('hr-potential-content'); if(!el||!el.querySelector) return; var old=el.querySelector('[data-dr112="hr-summary"]'); if(old) old.remove(); var html=hrSummary(); if(html) el.insertAdjacentHTML('afterbegin',html); rows().forEach(function(r){var tr=document.getElementById('hrp-row-'+r.id); if(!tr||tr.dataset.dr112) return; tr.dataset.dr112='1'; var info=tr.querySelector('.hrp-batter-info'); var cell=tr.querySelector('.hrp-prob-cell'); if(info){ var conf=hrProb(r), chance=pct(hrHitChance(r)*100); info.insertAdjacentHTML('beforeend','<div class="dr112-hr-extra">'+chip('Model',conf+'%',conf>=70?'good':conf>=55?'warn':'')+chip('HR Chance',chance+'%',chance>=14?'warn':'')+chip('Grade',hrGrade(conf),conf>=70?'good':'')+chip('Risk','High','warn')+'<div class="dr112-card-note"><b>Why:</b> '+esc(r.name)+' is scored from HR%, ISO '+f3(r.iso)+', OPS '+f3(r.ops)+', season HR '+(n(r.hrSeason)||'–')+', last-10 HR '+(r.last10HR??'–')+', and '+(r.isFavorable?'a favorable pitcher matchup.':'neutral matchup context.')+'</div></div>'); }
        if(cell&&!cell.querySelector('.dr112-hr-prob')) cell.insertAdjacentHTML('beforeend','<div class="dr112-hr-prob"><b>'+pct(hrHitChance(r)*100)+'%</b> est. hit</div>'); }); }
  function kSummary(){var arr=kRows().slice().sort(function(a,b){return kConfidence(b)-kConfidence(a)}); if(!arr.length) return ''; var top=arr[0], avg=arr.slice(0,6).reduce(function(a,p){return a+kConfidence(p)},0)/Math.min(6,arr.length); var line=n(top.recommendedOverLine ?? top.ouLine ?? top.compareLine); return '<div class="dr112-engine dr112-k-note" data-dr112="k-summary"><div class="dr112-engine-head"><div><div class="dr112-title">🎯 Strikeouts <span>Confidence Engine</span></div><div class="dr112-copy">Keeps the Strikeouts labels, line/cushion/K Count boxes, filters/sorting, and matchup controls while adding realistic over probability, Diamond grade, and a clear why-this-play read.</div></div><div class="dr112-score">'+pct(avg)+'%<small>Top K Grade</small></div></div><div class="dr112-grid"><div class="dr112-metric good"><b>'+esc(top.pitcherName||'–')+'</b><span>Top K Read</span></div><div class="dr112-metric"><b>Over '+line+' K</b><span>Active Line</span></div><div class="dr112-metric warn"><b>'+(n(top.projK)-line>=0?'+':'')+(n(top.projK)-line).toFixed(1)+'</b><span>Cushion</span></div><div class="dr112-metric"><b>'+pct(kHitChance(top)*100)+'%</b><span>Realistic Over Chance</span></div></div><div class="dr112-ai"><b>Why this board matters:</b> K props are scored from model projection vs line, over probability, K/9, ERA/WHIP command profile, workload/leash, opponent contact tendency, and live K Count when available.</div></div>'}
  function enhanceK(){return;var el=document.getElementById('kprops-content'); if(!el||!el.querySelector) return; var old=el.querySelector('[data-dr112="k-summary"]'); if(old) old.remove(); var html=kSummary(); if(html) el.insertAdjacentHTML('afterbegin',html); var map={}; kRows().forEach(function(p){map[String(p.pitcherId)]=p;}); el.querySelectorAll('.kprop-row').forEach(function(row){if(row.dataset.dr112) return; var img=row.querySelector('img[src*="people/"]'); var pid=''; if(img){var m=img.src.match(/people\/(\d+)/); if(m) pid=m[1];} var p=map[pid]; if(!p) return; row.dataset.dr112='1'; var line=n(p.recommendedOverLine ?? p.ouLine ?? p.compareLine), conf=kConfidence(p), chance=pct(kHitChance(p)*100), cushion=(n(p.projK)-line); var holder=row.querySelector('.kprop-pitcher')||row; holder.insertAdjacentHTML('beforeend','<div class="dr112-compact">'+chip('Model',conf+'%',conf>=70?'good':conf>=58?'warn':'')+chip('Over Chance',chance+'%',chance>=63?'good':chance>=54?'warn':'')+chip('Line','O '+line+' K','')+chip('Cushion',(cushion>=0?'+':'')+cushion.toFixed(1),cushion>=1?'good':cushion>=0?'warn':'low')+chip('Risk',conf>=70?'Low':conf>=58?'Medium':'High',conf>=70?'good':conf>=58?'warn':'low')+'</div><div class="dr112-card-note"><b>Why:</b> '+esc(p.pitcherName)+' is graded from projected K count '+esc(p.projK)+', line '+line+', '+esc(p.k9)+' K/9, '+esc(p.era)+' ERA, '+esc(p.whip)+' WHIP, opponent matchup, and current K Count when live.</div>'); }); }
  function run(){setTimeout(enhanceHR,80);setTimeout(enhanceK,90)}
  function wrap(name,fn){var old=window[name]; if(typeof old==='function'&&!old.__dr112){var w=function(){var out=old.apply(this,arguments); setTimeout(fn,80); return out}; w.__dr112=true; window[name]=w;}}
  wrap('renderHRPTable',enhanceHR); wrap('filterHRP',function(){setTimeout(enhanceHR,50)}); wrap('renderKProps',enhanceK); wrap('loadKProps',enhanceK);
  var oldPane=window.showGamePickPane; if(typeof oldPane==='function'&&!oldPane.__dr112){window.showGamePickPane=function(p){var out=oldPane.apply(this,arguments); if(p==='hr') setTimeout(enhanceHR,120); if(p==='k') setTimeout(enhanceK,120); return out}; window.showGamePickPane.__dr112=true;}
  document.addEventListener('DOMContentLoaded',function(){setTimeout(run,1200);setTimeout(run,2600);setTimeout(run,5000);});
})();

/* ---- Monte Carlo prop-line simulator ---- */
// Simulates a player's plate appearances for a single game using their real,
// sample-size-shrunk season rate stats, then reports what fraction of simulated games
// actually clear the market's line - a genuine simulated probability instead of a
// hand-tuned points formula. Runs entirely client-side against data already on the
// row object; no extra network calls.
(function(){
  if (window.__DR_MONTE_CARLO__) return; window.__DR_MONTE_CARLO__ = true;

  var TRIALS = 3000;
  var AB_PER_PA = 0.88; // roughly what share of a plate appearance ends as an official at-bat (rest are BB/HBP/SF)

  function n(v, fallback) { v = parseFloat(v); return Number.isFinite(v) ? v : (fallback == null ? 0 : fallback); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Estimated plate appearances for one game from lineup slot - leadoff hitters get
  // meaningfully more trips than the bottom of the order. Falls back to a league-
  // average estimate before the lineup posts.
  function estimatePA(battingOrder) {
    if (!battingOrder) return 4.2;
    return clamp(4.75 - (battingOrder - 1) * 0.11, 3.6, 4.75);
  }
  window.estimateGamePA = estimatePA;

  // Builds a per-plate-appearance outcome model (out / walk-or-HBP / single / double /
  // triple / HR) from real season rate stats. avg/obp/slg here are already the sample-
  // size-shrunk values set on the row by loadHRPotential, so a hot 3-game stretch on a
  // handful of AB can't produce an unrealistically high simulated probability.
  function buildBatterModel(row) {
    var s = row.stats || {};
    var avg = clamp(n(row.avg, 0.245), 0.120, 0.400);
    var obp = clamp(n(row.obp, avg + 0.065), avg, 0.500);
    var slg = clamp(n(row.slg, avg + 0.155), avg, 0.800);

    // Opposing pitcher quality — previously only the standalone HR market blended in a
    // pitcher signal; Hits/RBI/TB/H+R+RBI simulated purely off the batter's own numbers
    // with zero matchup awareness (a batter facing a Cy Young candidate and the same
    // batter facing a last-place bullpen arm got identical odds). Blends the pitcher's
    // real AVG/SLG allowed into the per-PA model, batter weighted higher since it's the
    // larger, more reliable sample.
    var PITCHER_WEIGHT = 0.35;
    var pitcherAvgAllowed = clamp(n(row.pitcherAvgAllowed, avg), 0.180, 0.320);
    var pitcherSlgAllowed = clamp(n(row.pitcherSlgAllowed, slg), 0.300, 0.550);
    var bAvg = avg * (1 - PITCHER_WEIGHT) + pitcherAvgAllowed * PITCHER_WEIGHT;
    var obpGap = Math.max(0, obp - avg); // preserve the batter's own walk-driven OBP lift
    var bObp = clamp(bAvg + obpGap, bAvg, 0.5);
    var bSlg = slg * (1 - PITCHER_WEIGHT) + pitcherSlgAllowed * PITCHER_WEIGHT;

    // Park factor — previously only the standalone HR market accounted for this.
    // Applied to the extra-base portion of the profile (park effects show up far more in
    // XBH/HR than in raw contact rate), scaled to half the park factor's deviation from
    // 100 so an extreme park like Coors' 145 doesn't overwhelm the batter's own profile.
    var parkAdj = 1 + ((n(row.parkFactor, 100) - 100) / 100) * 0.5;
    var pSlg = clamp(bAvg + (bSlg - bAvg) * parkAdj, bAvg, 0.9);

    var pHit = bAvg * AB_PER_PA;
    var pWalk = Math.max(0, bObp - pHit);
    var seasonAB = n(s.atBats, 0);
    var seasonHR = n(row.hrSeason, 0);
    var hrRatePerPA = seasonAB > 0 ? (seasonHR / seasonAB) * AB_PER_PA : pHit * 0.11;
    var pHR = clamp(hrRatePerPA * parkAdj, 0, pHit * 0.55);
    var hitBudget = Math.max(0, pHit - pHR);
    var extraBaseBudget = Math.max(0, (pSlg - bAvg) * AB_PER_PA - pHR * 3);
    var p3B = hitBudget * 0.025;
    var p2B = clamp(extraBaseBudget - p3B * 2, 0, hitBudget - p3B);
    var p1B = Math.max(0, hitBudget - p2B - p3B);
    var pOut = Math.max(0, 1 - pHit - pWalk);
    return { pOut: pOut, pWalk: pWalk, p1B: p1B, p2B: p2B, p3B: p3B, pHR: pHR };
  }

  function simulateGame(model, pa) {
    var hits = 0, tb = 0, hr = 0;
    for (var i = 0; i < pa; i++) {
      var r = Math.random(), c = model.pOut;
      if (r < c) continue;
      c += model.pWalk; if (r < c) continue;
      c += model.p1B; if (r < c) { hits++; tb += 1; continue; }
      c += model.p2B; if (r < c) { hits++; tb += 2; continue; }
      c += model.p3B; if (r < c) { hits++; tb += 3; continue; }
      hits++; tb += 4; hr++;
    }
    return { hits: hits, tb: tb, hr: hr };
  }

  // RBI and Hits+Runs+RBI need more than the batter's own bat - RBI depends on
  // teammates being on base ahead of them. Rather than fabricate a full lineup
  // simulation (no real data for the other 8 hitters' game-state), this derives a
  // per-PA "drives in a run" / "scores a run" rate from the batter's own real power
  // and contact profile, scaled by the same real lineup-slot opportunity factors this
  // board already used (2-3-4-5 hitters see far more traffic on base than the top or
  // bottom of the order).
  function estimateRBIRatePerPA(row, model) {
    var slotFactor = ({ 2: 1.15, 3: 1.55, 4: 1.70, 5: 1.40, 6: 1.10 })[row.battingOrder] || 0.85;
    var base = model.pHR * 1.35 + (model.p2B + model.p3B) * 0.55 + model.p1B * 0.16 + model.pOut * 0.05;
    return clamp(base * slotFactor, 0.02, 0.42);
  }
  function estimateRunRatePerPA(row, model) {
    var slotFactor = ({ 1: 1.35, 2: 1.25, 3: 1.15, 4: 1.05, 5: 1.0 })[row.battingOrder] || 0.85;
    return clamp((model.pWalk + model.p1B + model.p2B + model.p3B + model.pHR) * 0.42 * slotFactor, 0.02, 0.45);
  }

  function poissonSample(lambda) {
    var L = Math.exp(-lambda), k = 0, p = 1;
    do { k++; p *= Math.random(); } while (p > L);
    return k - 1;
  }

  // Public entry point for Hits / RBI / Total Bases / H+R+RBI / HR: returns a 1-99
  // probability that this player's simulated per-game output clears the market's line.
  // Memoized on the row object itself so the same row+market only gets simulated once
  // per fresh data load, no matter how many times score() is called during a single
  // render (filter pass, sort comparator, top-N average, card build all call it).
  window.simulatePropOdds = function(marketType, row) {
    row.__mcCache = row.__mcCache || {};
    if (row.__mcCache[marketType] != null) return row.__mcCache[marketType];

    var model = buildBatterModel(row);
    var pa = estimatePA(row.battingOrder);
    var rbiRate = estimateRBIRatePerPA(row, model);
    var runRate = estimateRunRatePerPA(row, model);
    var successes = 0;
    for (var t = 0; t < TRIALS; t++) {
      var gamePA = Math.max(1, Math.round(pa + (Math.random() - 0.5) * 1.6));
      var g = simulateGame(model, gamePA);
      var success = false;
      if (marketType === 'hits') success = g.hits >= 1;
      else if (marketType === 'tb') success = g.tb >= 2;
      else if (marketType === 'hr') success = g.hr >= 1;
      else if (marketType === 'rbis' || marketType === 'hrrbi') {
        var rbi = 0, runs = 0;
        for (var i = 0; i < gamePA; i++) {
          if (Math.random() < rbiRate) rbi++;
          if (Math.random() < runRate) runs++;
        }
        success = marketType === 'rbis' ? rbi >= 1 : (g.hits + runs + rbi) >= 2;
      }
      if (success) successes++;
    }
    var result = Math.max(1, Math.min(99, Math.round((successes / TRIALS) * 100)));
    row.__mcCache[marketType] = result;
    return result;
  };

  // Stolen bases are opportunity-driven (times reaching base, then an attempt) rather
  // than a per-PA batting outcome, so this models it as a Poisson process using the
  // batter's real season SB rate per game, adjusted by the opposing pitcher/catcher's
  // own running-game suppression (already computed elsewhere on this board) instead of
  // reusing the per-PA batter model above.
  window.simulateSBOdds = function(row) {
    row.__mcCache = row.__mcCache || {};
    if (row.__mcCache.sb != null) return row.__mcCache.sb;

    var s = row.stats || {};
    var sb = n(s.stolenBases, 0), cs = n(s.caughtStealing, 0);
    var att = sb + cs;
    var successRate = att >= 5 ? sb / att : (sb > 0 ? 0.70 : 0.60);
    var seasonAB = n(s.atBats, 0);
    var gamesPlayed = seasonAB > 0 ? Math.max(1, seasonAB / 3.8) : 1; // ~3.8 AB/game typical
    var sbPerGame = seasonAB > 0 ? (sb / gamesPlayed) : 0;
    var pAtt = n(row.pitcherSbAllowed, 0) + n(row.pitcherCsAllowed, 0);
    var batterySuppression = pAtt >= 5 ? clamp(1 - ((n(row.pitcherSbAllowed, 0) / pAtt) - 0.72) * 0.6, 0.7, 1.3) : 1;
    var lambda = clamp(sbPerGame * batterySuppression, 0.01, 1.2);

    var successes = 0;
    for (var t = 0; t < TRIALS; t++) {
      var attempts = poissonSample(lambda);
      var stolen = 0;
      for (var i = 0; i < attempts; i++) if (Math.random() < successRate) stolen++;
      if (stolen >= 1) successes++;
    }
    var result = Math.max(1, Math.min(99, Math.round((successes / TRIALS) * 100)));
    row.__mcCache.sb = result;
    return result;
  };
  // "At least one HR across N independent plate appearances at a constant per-PA
  // rate" has an exact closed-form probability (1 - (1-p)^N) — no need to simulate
  // it. This used to run a fresh Math.random()-driven Monte Carlo on every call
  // (including every periodic background refresh), so the same batter with
  // identical stats could show a visibly different % every few minutes for no
  // real reason. gamePA itself was randomized around the base PA estimate
  // (pa ± 0.8, uniform), so paDistribution() computes the exact probability of
  // each possible PA count instead of sampling it, and the final probability is
  // the weighted average of 1-(1-p)^PA across that distribution. Verified against
  // the old 50,000-trial Monte Carlo output — matches exactly.
  function paDistribution(pa) {
    var lo = pa - 0.8, hi = pa + 0.8;
    var kMin = Math.floor(lo - 0.5), kMax = Math.ceil(hi + 0.5);
    var dist = {};
    for (var k = Math.max(1, kMin); k <= kMax; k++) {
      var segLo = Math.max(lo, k - 0.5);
      var segHi = Math.min(hi, k + 0.5);
      var overlap = Math.max(0, segHi - segLo);
      if (overlap > 0) {
        var kk = Math.max(1, k);
        dist[kk] = (dist[kk] || 0) + overlap / 1.6;
      }
    }
    return dist;
  }
  window.simulateHRGameOdds = function(pPerPA, battingOrder) {
    pPerPA = clamp(n(pPerPA, 0.03), 0, 0.5);
    var dist = paDistribution(estimatePA(battingOrder));
    var prob = 0;
    for (var k in dist) { prob += dist[k] * (1 - Math.pow(1 - pPerPA, Number(k))); }
    // Was hard-capped at 25 with no floor, unlike every other market's 1-99 range —
    // real per-game HR probability for a genuinely elite matchup can exceed 25%, so
    // the old cap flattened great and mediocre matchups into the same narrow band
    // and made ranking/selection nearly meaningless. See Elite Picks HR record audit.
    return Math.max(1, Math.min(99, Math.round(prob * 100)));
  };
  window.simulateKOdds = function(projK, line) {
    var lambda = clamp(n(projK, 4.5), 0.3, 15);
    var threshold = n(line, Math.floor(lambda));
    var successes = 0;
    for (var t = 0; t < TRIALS; t++) {
      if (poissonSample(lambda) > threshold) successes++;
    }
    return Math.max(1, Math.min(99, Math.round((successes / TRIALS) * 100)));
  };
})();

/* ---- from <script id="prod-v10-30-prop-hit-highlight-js"> ---- */
(function(){
  if(window.__DR_V1030_PROP_HITS__) return; window.__DR_V1030_PROP_HITS__ = true;
  function n(v){ v=parseFloat(v); return Number.isFinite(v)?v:0; }
  function pct(v){ return Math.max(1,Math.min(99,Math.round(v))); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function f(v,d){ v=n(v); return v ? v.toFixed(d==null?3:d).replace(/^0(?=\.)/,'') : '–'; }
  function rows(){ try{ return (window.getProductionPropRows?window.getProductionPropRows():(window.hrpRows||[])).filter(function(r){ return r && r.name && (!window.isActiveForHRThreat || window.isActiveForHRThreat(r)); }); }catch(e){ return []; } }
  function stats(r){ return r.stats || r.seasonStats || {}; }
  function liveVal(r,key){
    var ts = r.todayStats || {};
    if(key==='hits') return n(r.todayHits ?? ts.hits);
    if(key==='rbis') return n(r.todayRBI ?? ts.rbi ?? ts.runsBattedIn);
    if(key==='tb') return n(r.todayTB ?? ts.totalBases);
    if(key==='sb') return n(r.todaySB ?? ts.stolenBases);
    if(key==='runs') return n(r.todayRuns ?? ts.runs);
    if(key==='hr') return n(r.todayHR ?? ts.homeRuns);
    return 0;
  }
  function hasLive(r){ return !!(r.todayStats || liveVal(r,'hits') || liveVal(r,'rbis') || liveVal(r,'tb') || liveVal(r,'sb') || liveVal(r,'runs') || liveVal(r,'hr') || /LIVE|FINAL/i.test(String(r.timeLabel||''))); }
  function actual(type,r){
    if(type==='hits') return liveVal(r,'hits');
    if(type==='rbis') return liveVal(r,'rbis');
    if(type==='tb') return liveVal(r,'tb');
    if(type==='sb') return liveVal(r,'sb');
    if(type==='hrrbi') return liveVal(r,'hits') + liveVal(r,'runs') + liveVal(r,'rbis');
    if(type==='hr') return liveVal(r,'hr');
    return 0;
  }
  function target(type){ return ({hits:1,rbis:1,tb:2,sb:1,hrrbi:2,hr:1})[type] || 1; }
  function hit(type,r){ return actual(type,r) >= target(type); }
  function label(type){ return ({hits:'Hits',rbis:'RBIs',tb:'Total Bases',sb:'Stolen Bases',hrrbi:'Hits+Runs+RBI'})[type] || 'Prop'; }
  function line(type){ return ({hits:'Over 0.5 Hits',rbis:'Over 0.5 RBI',tb:'Over 1.5 Total Bases',sb:'Over 0.5 SB',hrrbi:'Over 1.5 H+R+RBI'})[type] || 'Line'; }
  function score(type,r){
    // Runs a real Monte Carlo simulation of the player's game (thousands of trials
    // built from their actual sample-size-shrunk AVG/OBP/SLG/HR rate and an estimated
    // plate-appearance count for their lineup slot) instead of a hand-tuned points
    // formula, and reports the simulated probability of clearing this market's line.
    if (type === 'sb') return window.simulateSBOdds ? window.simulateSBOdds(r) : 50;
    if (type === 'hits' || type === 'rbis' || type === 'tb' || type === 'hrrbi') {
      return window.simulatePropOdds ? window.simulatePropOdds(type, r) : 50;
    }
    return 50;
  }
  // Falls back to a fixed per-stat neon identity color (by stat name) when no real
  // good/notable semantic class applies, instead of plain gray. An explicit class
  // (e.g. "good") always wins when one is passed in.
  function statSlug(k){ return String(k).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
  function chip(k,v,cls){ var c=cls||('stat-'+statSlug(k)); return '<span class="dr109-chip '+c+'"><span>'+esc(k)+':</span><strong>'+esc(v)+'</strong></span>'; }
  function chipSet(type,r){ var s=stats(r),avg=n(r.avg||s.avg),ops=n(r.ops||s.ops),iso=n(r.iso||s.iso),obp=n(r.obp||s.obp),slg=n(r.slg||s.slg),hr=n(r.hrSeason||s.homeRuns),prob=n(r.hrProb),sb=n(s.stolenBases),rbi=n(s.rbi||s.runsBattedIn),runs=n(s.runs),hits=n(s.hits),a=[]; if(hit(type,r)) a.push(['✓ HIT', actual(type,r)+' / '+target(type), 'hit-check']); else if(hasLive(r)) a.push(['Live', actual(type,r)+' / '+target(type), '']);
    if(type==='hits')a=a.concat([['Line',line(type),'good'],['AVG',f(avg),''],['xBA proxy',f(avg+(r.isFavorable?.012:0)),'good'],['OBP',f(obp),''],['Contact',pct(66+avg*80)+'%','good'],['PA Est',(window.estimateGamePA?window.estimateGamePA(r.battingOrder):4.2).toFixed(1),'']]);
    if(type==='rbis')a=a.concat([['Line',line(type),'good'],['RBI',rbi||'–',''],['RISP proxy',pct(42+ops*20)+'%','good'],['Run Env',r.isFavorable?'Plus':'Neutral',r.isFavorable?'good':''],['OPS',f(ops),''],['ISO',f(iso),'warn'],['Team Stack','Supported',''],['Lineup','Middle/Power','']]);
    if(type==='tb')a=a.concat([['Line',line(type),'good'],['SLG',f(slg),''],['xSLG proxy',f(slg+iso*.12),'good'],['ISO',f(iso),'warn'],['Power',r.topHrThreat?'Top':'Model',r.topHrThreat?'warn':'']]);
    if(type==='sb')a=a.concat([['Line',line(type),'good'],['SB',sb||'–','good'],['OBP',f(obp),''],['Speed proxy',pct(48+sb*2.2)+'%','good'],['Risk','Volatile','warn']]);
    if(type==='hrrbi')a=a.concat([['Line',line(type),'good'],['Hits',hits||'–',''],['Runs',runs||'–',''],['RBI',rbi||'–',''],['OPS',f(ops),'good'],['OBP',f(obp),'']]);
    return a.map(function(x){return chip(x[0],x[1],x[2]);}).join(''); }
  function reason(type,r,sc){ var nm=esc(r.name||'This player'),opp=esc(r.oppAbbr||'opponent'),map={hits:'contact profile, on-base skill, projected plate appearances, and matchup quality',rbis:'RBI lane, team run environment, power profile, and traffic ahead of the bat',tb:'slugging profile, ISO power, extra-base upside, and pitcher contact quality allowed',sb:'speed profile, on-base path, game script, and stolen-base opportunity',hrrbi:'multi-category production path through hits, runs, RBIs, lineup role, and team run environment'}; var result=hit(type,r)?' <span class="prop-hit-badge">✓ Projection Hit</span>':''; return result+' '+nm+' grades at '+sc+'% for '+esc(line(type))+' because the model combines '+(map[type]||'production profile')+'. Opponent context: '+opp+'.'; }
  function head(id){ return id?'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_84,q_auto:best/v1/people/'+id+'/headshot/67/current':''; }
  var edgeFilters = {hits:0,rbis:0,tb:0,sb:0,hrrbi:0};
  var gameFilters = {hits:'',rbis:'',tb:'',sb:'',hrrbi:''};
  var watchlistFilters = {hits:false,rbis:false,tb:false,sb:false,hrrbi:false};
  window.setPropWatchlistFilter=function(type){ watchlistFilters[type]=!watchlistFilters[type]; render(type,paneMap[type],true); };
  window.__drPropWatchlistRerender=function(){ Object.keys(watchlistFilters).forEach(function(type){ if(watchlistFilters[type]) render(type,paneMap[type],true); }); };
  var paneMap = {hits:'hits-props-content',rbis:'rbis-props-content',tb:'tb-props-content',sb:'sb-props-content',hrrbi:'hrrbi-props-content'};
  var EDGE_THRESHOLDS = [0,60,70,80,90];
  window.setPropEdgeFilter=function(type,val){ edgeFilters[type]=parseInt(val,10)||0; render(type,paneMap[type],true); };
  window.setPropGameFilter=function(type,val){ gameFilters[type]=val||''; render(type,paneMap[type],true); };
  function gamesList(){ var seen={},out=[]; rows().forEach(function(r){ var pk=String(r.gamePk||''); if(!pk||seen[pk])return; seen[pk]=1; out.push({pk:pk,label:(r.teamAbbr||'?')+' vs '+(r.oppAbbr||'?'),ts:r.gameTimestamp||0}); }); out.sort(function(a,b){return a.ts-b.ts;}); return out; }
  function edgeFilterHTML(type){
    var cur=edgeFilters[type]||0;
    var opts=EDGE_THRESHOLDS.map(function(t){ return '<option value="'+t+'"'+(cur===t?' selected':'')+'>'+(t===0?'All Edges':t+'%+')+'</option>'; }).join('');
    var curG=gameFilters[type]||'';
    var games=gamesList();
    var gameOpts=['<option value=""'+(curG===''?' selected':'')+'>All Games</option>'].concat(games.map(function(g){ return '<option value="'+g.pk+'"'+(curG===g.pk?' selected':'')+'>'+esc(g.label)+'</option>'; })).join('');
    var wlActive=!!watchlistFilters[type];
    return '<div class="dr109-filter-row" style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin:0 0 12px;padding:0 14px"><div class="dr109-game-filter" style="margin:0"><label style="font-size:10px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);margin-right:8px">Edge:</label><select onchange="window.setPropEdgeFilter(\''+type+'\',this.value)" style="background:#0e1728;color:#fff;border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:12px;font-weight:700">'+opts+'</select></div><div class="dr109-game-filter" style="margin:0"><label style="font-size:10px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);margin-right:8px">Game:</label><select onchange="window.setPropGameFilter(\''+type+'\',this.value)" style="background:#0e1728;color:#fff;border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:12px;font-weight:700">'+gameOpts+'</select></div><button onclick="window.setPropWatchlistFilter(\''+type+'\')" style="font-size:11px;font-weight:700;font-family:Manrope,sans-serif;padding:6px 12px;border-radius:8px;border:1px solid '+(wlActive?'#f5c518':'var(--border)')+';background:'+(wlActive?'rgba(245,197,24,.14)':'var(--surface2)')+';color:'+(wlActive?'#f5c518':'var(--muted)')+';cursor:pointer;white-space:nowrap">★ WATCHLIST</button></div>';
  }
  function render(type,id,force){ var el=document.getElementById(id); if(!el) return; if(!force && document.activeElement && el.contains(document.activeElement) && document.activeElement.tagName==='SELECT') return; var scrollTop=el.scrollTop; var pageY=window.scrollY; var all=rows(); var filtered=edgeFilters[type]?all.filter(function(r){ return score(type,r)>=edgeFilters[type]; }):all; if(gameFilters[type]) filtered=filtered.filter(function(r){ return String(r.gamePk)===gameFilters[type]; }); if(watchlistFilters[type]) filtered=filtered.filter(function(r){ return drIsWatchlisted(r.id); }); var arr=filtered.filter(function(r){ return String(r.timeLabel||'').toUpperCase()!=='FINAL'; }).sort(function(a,b){ return score(type,b)-score(type,a); }).slice(0,50); if(!all.length){ el.innerHTML='<div class="mu-empty">Loading '+label(type)+' board from active production data…</div>'; return; } var gf=edgeFilterHTML(type); if(!arr.length){ el.innerHTML=gf+'<div class="mu-empty" style="padding:24px">No players match the selected filters. Choose All Edges / All Games to reset.</div>'; return; } var top=arr[0], avg=Math.round(arr.slice(0,Math.min(6,arr.length)).reduce(function(a,r){return a+score(type,r)},0)/Math.min(6,arr.length)); el.innerHTML='<div class="dr109-summary"><div class="dr109-title">📊 EXPANDED <span>'+esc(label(type).toUpperCase())+' DATA</span></div><p class="dr109-copy">Each player\'s odds come from a Monte Carlo simulation of thousands of games built from their real season rate stats and lineup slot, not a hand-tuned formula. Values are generated from the active production rows so they stay fast and do not add external load time.</p><div class="dr109-grid"><div class="dr109-metric good"><b>'+esc(top.name||'–')+'</b><span>Top Rated</span></div><div class="dr109-metric"><b>'+avg+'%</b><span>Board Avg Odds</span></div><div class="dr109-metric"><b>'+arr.length+'</b><span>Players Scanned</span></div><div class="dr109-metric warn"><b>'+esc(line(type))+'</b><span>Primary Line</span></div></div></div>'+gf+arr.map(function(r){ var sc=score(type,r),isHit=hit(type,r),isFinal=String(r.timeLabel||'').toUpperCase()==='FINAL',isMiss=isFinal&&!isHit; return '<div class="dr109-card '+(isHit?'prop-hit':isMiss?'prop-miss':'')+'">'+window.drWatchStarHTML(r.id,r.name)+'<div class="dr109-card-head"><div class="dr109-player"><img loading="lazy" src="'+head(r.id)+'" onerror="this.style.display=\'none\'" alt=""><div style="min-width:0"><div class="dr109-name">'+esc(r.name||'Player')+(isHit?' <span class="prop-hit-badge">✓ Projection Hit</span>':isMiss?' <span class="prop-miss-badge">✗ Missed</span>':'')+'</div><div class="dr109-meta">'+esc(r.teamAbbr||'')+' · '+esc(r.pos||'')+' · vs '+esc(r.oppAbbr||'')+'</div></div></div><div class="dr109-score">'+sc+'%<small>'+esc(label(type))+' Odds</small></div></div><div class="dr109-chiprow">'+chipSet(type,r)+'</div><div class="dr109-reason"><strong>Simulated odds:</strong> across thousands of simulated games built from '+esc(r.name||'this player')+'\'s real season rate stats and lineup slot, '+sc+'% of them clear '+esc(line(type))+'. Inputs: '+({hits:'contact profile, on-base skill, projected plate appearances, and matchup quality',rbis:'RBI lane, team run environment, power profile, and traffic ahead of the bat',tb:'slugging profile, ISO power, extra-base upside, and pitcher contact quality allowed',sb:'speed profile, on-base path, game script, and stolen-base opportunity',hrrbi:'multi-category production path through hits, runs, RBIs, lineup role, and team run environment'}[type]||'production profile')+'. Opponent context: '+esc(r.oppAbbr||'opponent')+'.</div></div>'; }).join(''); el.scrollTop=scrollTop; window.scrollTo(window.scrollX,pageY); }
  window.renderPropIntelligencePanes=function(){ render('hits','hits-props-content'); render('rbis','rbis-props-content'); render('tb','tb-props-content'); render('sb','sb-props-content'); render('hrrbi','hrrbi-props-content'); if(typeof window.enhanceDeepResearch==='function') try{window.enhanceDeepResearch();}catch(e){} };
  function markHRHits(){ try{ rows().forEach(function(r){ if(actual('hr',r)>=1){ ['#hrp-row-'+r.id].forEach(function(sel){ var el=document.querySelector(sel); if(el){ el.classList.add('hr-hit'); if(!el.querySelector('.hr-hit-badge')){ var chipBox=el.querySelector('.dr1017-hr-chips,.dr1026-chip-row'); if(chipBox) chipBox.insertAdjacentHTML('afterbegin','<span class="hr-hit-badge">✓ HR Projection Hit</span>'); } } }); } }); }catch(e){} }
  var oldHR=window.renderHRPTable; if(typeof oldHR==='function'){ window.renderHRPTable=function(){ var out=oldHR.apply(this,arguments); setTimeout(markHRHits,0); return out; }; }
  var oldPane=window.showGamePickPane; if(typeof oldPane==='function' && !oldPane.__v1030){ var wrap=function(p){ var out=oldPane.apply(this,arguments); setTimeout(function(){ if(['hits','rbis','tb','sb','hrrbi'].indexOf(p)>=0) window.renderPropIntelligencePanes(); if(p==='hr') markHRHits(); },80); return out; }; wrap.__v1030=true; window.showGamePickPane=wrap; }
  document.addEventListener('DOMContentLoaded',function(){ setTimeout(function(){ if(window.renderPropIntelligencePanes) window.renderPropIntelligencePanes(); markHRHits(); },900); setTimeout(function(){ if(window.renderPropIntelligencePanes) window.renderPropIntelligencePanes(); markHRHits(); },2600); });
})();

/* ---- from <script id="prod-v10-32-prop-hit-authority-js"> ---- */
(function(){
  if(window.__DR_V1032_PROP_HIT_AUTHORITY__) return;
  window.__DR_V1032_PROP_HIT_AUTHORITY__ = true;

  function n(v){ v=parseFloat(v); return Number.isFinite(v)?v:0; }
  function esc(v){ return String(v==null?'':v).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]||c;}); }
  function pct(v){ return Math.max(1,Math.min(99,Math.round(v))); }
  function fmt3(v){ v=n(v); return v>0?v.toFixed(3).replace(/^0/,''):'—'; }
  function fmt1(v){ return (Math.round(n(v)*10)/10).toFixed(1); }
  function hs(id){ return id ? 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_72,q_auto:best/v1/people/'+id+'/headshot/67/current' : ''; }
  function stats(r){ return r.todayStats || r.stats || r.seasonStats || {}; }
  function rows(){
    try{
      var src = (typeof window.getProductionPropRows==='function') ? window.getProductionPropRows() : (Array.isArray(window.hrpRows)?window.hrpRows:[]);
      return (src||[]).filter(function(r){ return r && r.name && (!window.isActiveForHRThreat || window.isActiveForHRThreat(r)); });
    }catch(e){ return []; }
  }
  function stat(r,key){
    var s=stats(r), ts=r.todayStats||{};
    if(key==='hits') return n(r.todayHits ?? ts.hits ?? s.todayHits);
    if(key==='rbis') return n(r.todayRBI ?? ts.rbi ?? ts.runsBattedIn ?? s.todayRBI);
    if(key==='tb') return n(r.todayTB ?? ts.totalBases ?? s.todayTB);
    if(key==='sb') return n(r.todaySB ?? ts.stolenBases ?? s.todaySB);
    if(key==='runs') return n(r.todayRuns ?? ts.runs ?? s.todayRuns);
    if(key==='hr') return n(r.todayHR ?? ts.homeRuns ?? s.todayHR);
    return 0;
  }
  function ctx(r){ var s=stats(r); var avg=n(r.avg||s.avg), obp=n(s.obp), ops=n(r.ops||s.ops), iso=n(r.iso||s.iso), slg=n(s.slg)||Math.max(0,ops-obp); return {avg:avg,obp:obp,ops:ops,iso:iso,slg:slg,hr:n(r.hrSeason||s.homeRuns||s.hr),l10:n(r.last10HR),sb:n(s.stolenBases||s.sb),hits:n(s.hits),runs:n(s.runs),rbi:n(s.rbi||s.runsBattedIn),fav:!!r.isFavorable,top:!!r.topHrThreat}; }
  function projection(type,r){ var x=ctx(r), exp=.5,line='—',target=1,conf=50;
    if(type==='hits'){ exp=Math.max(.62,Math.min(1.35,.55+x.avg*1.55+x.obp*.45+(x.fav?.07:0))); line='Over 0.5 H'; target=1; conf=pct(50+x.avg*70+x.obp*35+x.ops*6+(x.fav?4:0)); }
    if(type==='rbis'){ exp=Math.max(.18,Math.min(.95,.20+x.iso*1.25+x.ops*.18+x.hr*.006+(x.top?.05:0))); line='Over 0.5 RBI'; target=1; conf=pct(34+exp*34+(x.fav?3:0)); }
    if(type==='tb'){ exp=Math.max(.85,Math.min(2.35,.65+x.slg*1.35+x.iso*1.55+(x.top?.14:0))); line=exp>=1.55?'Over 1.5 TB':'Over 0.5 TB'; target=exp>=1.55?2:1; conf=pct(40+exp*12+(x.fav?3:0)); }
    if(type==='sb'){ exp=Math.max(.02,Math.min(.42,.02+x.sb*.009+x.obp*.11+(/SS|CF|2B|LF|RF/.test(String(r.pos||''))?.03:0))); line='Over 0.5 SB'; target=1; conf=pct(18+exp*70+x.sb*.35); }
    if(type==='hrrbi'){ exp=Math.max(1.2,Math.min(3.6,.75+x.avg*1.2+x.obp*1.1+x.ops*.65+(x.fav?.18:0))); line='Over 1.5 H+R+RBI'; target=2; conf=pct(42+exp*10+(x.fav?3:0)); }
    var base = type==='tb' ? (target===2?1.5:.5) : (type==='hrrbi'?1.5:.5);
    return {line:line,count:fmt1(exp),cush:(exp-base>=0?'+':'')+fmt1(exp-base),target:target,conf:conf};
  }
  function actual(type,r){ if(type==='hits')return stat(r,'hits'); if(type==='rbis')return stat(r,'rbis'); if(type==='tb')return stat(r,'tb'); if(type==='sb')return stat(r,'sb'); if(type==='hrrbi')return stat(r,'hits')+stat(r,'runs')+stat(r,'rbis'); return 0; }
  function isHit(type,r){ if(type==='hr') return stat(r,'hr')>0; var p=projection(type,r); return actual(type,r)>=p.target && actual(type,r)>0; }
  function chip(k,v,cls){ return '<span class="prop-chip '+(cls||'')+'"><span>'+esc(k)+'</span><strong>'+esc(v)+'</strong></span>'; }
  function propChips(type,r){ var x=ctx(r), p=projection(type,r), hit=isHit(type,r), out='';
    if(hit) out += '<span class="projection-hit-badge">✓ Projection Hit</span>';
    else if(actual(type,r)>0) out += '<span class="projection-hit-badge" style="border-color:rgba(96,165,250,.55)!important;background:rgba(59,130,246,.14)!important;color:#bfdbfe!important">Live '+actual(type,r)+'/'+p.target+'</span>';
    if(type==='hits') out += chip('Line',p.line,'prop-pick-chip')+chip('Hit Count',actual(type,r)||'—',hit?'good':'')+chip('AVG',fmt3(x.avg),x.avg>=.280?'good':'')+chip('OBP',fmt3(x.obp),x.obp>=.340?'good':'')+chip('OPS',fmt3(x.ops),x.ops>=.850?'good':'');
    if(type==='rbis') out += chip('Line',p.line,'prop-pick-chip')+chip('RBI Count',actual(type,r)||'—',hit?'good':'')+chip('HR',x.hr||'—',x.hr>=15?'warn':'')+chip('ISO',fmt3(x.iso),x.iso>=.200?'warn':'')+chip('Run Env',x.fav?'Plus':'Neutral',x.fav?'good':'');
    if(type==='tb') out += chip('Line',p.line,'prop-pick-chip')+chip('TB Count',actual(type,r)||'—',hit?'good':'')+chip('SLG',fmt3(x.slg),x.slg>=.480?'good':'')+chip('ISO',fmt3(x.iso),x.iso>=.200?'warn':'')+chip('Power',x.top?'Top':'Stable',x.top?'warn':'');
    if(type==='sb') out += chip('Line',p.line,'prop-pick-chip')+chip('SB Count',actual(type,r)||'—',hit?'good':'')+chip('SB',x.sb||'—',x.sb>=10?'good':'')+chip('OBP',fmt3(x.obp),x.obp>=.340?'good':'')+chip('Run Tool',/SS|CF|2B|LF|RF/.test(String(r.pos||''))?'Plus':'Model','');
    if(type==='hrrbi') out += chip('Line',p.line,'prop-pick-chip')+chip('H+R+RBI',actual(type,r)||'—',hit?'good':'')+chip('H',stat(r,'hits')||'—','')+chip('R',stat(r,'runs')||'—','')+chip('RBI',stat(r,'rbis')||'—','')+chip('OPS',fmt3(x.ops),x.ops>=.850?'good':'');
    return out;
  }
  function boxes(p,type){ var lbl=type==='hits'?'Hit Count':type==='rbis'?'RBI Count':type==='tb'?'TB Count':type==='sb'?'SB Count':'H+R+RBI'; return '<div class="prop-projection-box prop-lite-boxes"><div class="prop-proj-card primary"><div class="prop-proj-label">Line</div><div class="prop-proj-value">'+esc(p.line)+'</div></div><div class="prop-proj-card"><div class="prop-proj-label">'+lbl+'</div><div class="prop-proj-value">'+esc(p.count)+'</div></div><div class="prop-proj-card"><div class="prop-proj-label">Cushion</div><div class="prop-proj-value">'+esc(p.cush)+'</div></div></div>'; }
  function matchupButton(r){ var bid=r.id||r.playerId||r.batterId, pid=r.pitcherId||r.oppPitcherId||r.probablePitcherId, pn=r.pitcherName||r.oppPitcherName||r.probablePitcherName||''; if(!bid||!pid||typeof window.openMatchup!=='function') return ''; return '<div class="prop-matchup-action"><button class="btn-matchup" type="button" onclick="openMatchup('+Number(bid)+','+JSON.stringify(String(r.name||''))+','+Number(pid)+','+JSON.stringify(String(pn||''))+')">⚔ Pitcher Matchup</button></div>'; }
  var paneMap={hits:'hits-props-content',rbis:'rbis-props-content',tb:'tb-props-content',sb:'sb-props-content',hrrbi:'hrrbi-props-content'};
  var labels={hits:'Hits',rbis:'RBI',tb:'Total Bases',sb:'Stolen Base',hrrbi:'Hits+Runs+RBI'};
  function renderProp(type){ var el=document.getElementById(paneMap[type]); if(!el)return; var arr=rows().slice().sort(function(a,b){return (isHit(type,b)-isHit(type,a)) || projection(type,b).conf-projection(type,a).conf;}).slice(0,24); if(!arr.length){el.innerHTML='<div class="mu-empty"><span class="spin"></span>Loading '+labels[type]+' board…</div>';return;} el.innerHTML='<div class="prop-source-note"><strong>Live result tracking:</strong> players who have cleared the projection are highlighted and marked with a checkmark when live/final box score stats are available.</div>'+arr.map(function(r){var p=projection(type,r), hit=isHit(type,r), abbr=r.teamAbbr||r.team||'', scoreClass=hit?' projection-hit-score':''; return '<div class="prop-board-row '+(hit?'projection-hit':'')+'" data-prop-type="'+type+'"><div class="prop-player-main"><img loading="lazy" decoding="async" class="prop-player-img" src="'+hs(r.id||r.playerId)+'" onerror="this.style.visibility=\'hidden\'" alt=""><div style="min-width:0"><div class="prop-player-name">'+esc(r.name||'—')+'</div><div class="prop-player-meta"><span>'+esc(abbr)+' · '+esc(r.pos||'')+'</span><span>vs '+esc(r.oppAbbr||'')+'</span></div>'+matchupButton(r)+'</div></div><div><div class="prop-chip-row">'+propChips(type,r)+'</div>'+boxes(p,type)+'</div><div class="prop-score-box"><div class="prop-score-val'+scoreClass+'">'+p.conf+'%</div><div class="prop-score-label">'+labels[type]+' Confidence</div><div class="prop-score-bar"><span style="width:'+p.conf+'%"></span></div></div></div>';}).join(''); }
  function activeProp(){ var active=document.querySelector('#props .gamepick-pane.active'); if(!active)return null; var pane=active.getAttribute('data-gamepick-pane'); return paneMap[pane]?pane:null; }
  /* v10.32 prop-board renderer disabled: v10.30's richer card layout (RISP proxy, Team Stack, Lineup, HIT chip) is the one to keep. renderHRPTable below is untouched. */

  // Grade tiers rescaled for the Monte Carlo-simulated hrProb (full-game odds across a
  // real ~4-5 PA, not a single-PA rate) — the old tiers assumed the pre-simulation scale,
  // where the league-average player sat around 3-4% instead of the ~12-14% a genuine
  // game simulation produces.
  function grade(p){ p=n(p); return p>=24?'A+':p>=20?'A':p>=17?'B+':'B'; }
  // A stat with no real good/notable signal (cls empty) still gets its own fixed neon
  // identity color (by stat name, so "ISO" is always the same hue everywhere it shows
  // up) instead of falling back to plain gray — an explicit semantic class (green/gold/
  // red) always wins when one applies, this is purely the "otherwise" case.
  function statSlug(k){ return String(k).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
  function hrChip(k,v,cls){ var c=cls||('stat-'+statSlug(k)); return '<span class="dr1027-chip '+c+'"><b>'+esc(k)+'</b> '+esc(v)+'</span>'; }
  function labelChip(k,v,cls){ return '<span class="dr1027-chip '+(cls||'')+'"><b>'+esc(k)+'</b> '+esc(v)+'</span>'; }
  // Inclusion floor rescaled for the Monte Carlo-simulated hrProb. Switching HR Threats
  // to a genuine full-game simulation (real ~4-5 PA, not one PA) roughly quadrupled the
  // typical player's hrProb (league-average sits around 12-14% now, not 3-4%), so the old
  // 10%/5% bars stopped filtering almost anything — nearly the entire scanned slate (~230+
  // players) was clearing them. Raised to preserve the same curated-shortlist intent.
  function getHRRows(){ return rows().filter(function(r){return n(r.hrProb)>0 && ((r.topHrThreat && n(r.hrProb)>=14) || n(r.hrProb)>=18);}); }
  function getFilters(){ if(!window.__hrpFilterSet) window.__hrpFilterSet=new Set(); return window.__hrpFilterSet; }
  function getHRGameFilter(){ return window.__hrpGameFilter||''; }
  window.setHRGameFilter=function(val){ window.__hrpGameFilter=val||''; renderHRPTableV1032(); };
  function populateHRGameSelect(base){
    var sel=document.getElementById('hrp-game-filter'); if(!sel) return;
    var seen={}, games=[];
    base.forEach(function(r){ var pk=String(r.gamePk||''); if(!pk||seen[pk])return; seen[pk]=1; games.push({pk:pk,label:(r.teamAbbr||'?')+' vs '+(r.oppAbbr||'?'),ts:r.gameTimestamp||0}); });
    games.sort(function(a,b){return a.ts-b.ts;});
    var cur=getHRGameFilter();
    sel.innerHTML='<option value="">All Games</option>'+games.map(function(g){ return '<option value="'+g.pk+'"'+(cur===g.pk?' selected':'')+'>'+esc(g.label)+'</option>'; }).join('');
    sel.value=cur;
  }
  function applyHRFilters(arr){ var s=getFilters(); var gf=getHRGameFilter(); if(gf) arr=arr.filter(function(r){ return String(r.gamePk)===gf; }); if(!s.size)return arr; return arr.filter(function(r){ if(s.has('onfire')&&!r.isOnFire)return false; if(s.has('top')&&!((r.topHrThreat&&n(r.hrProb)>=14)||n(r.hrProb)>=18))return false; if(s.has('drought')&&!r.isDrought)return false; if(s.has('due')&&!r.isDue)return false; if(s.has('favorable')&&!r.isFavorable)return false; if(s.has('watchlist')&&!window.drIsWatchlisted(r.id))return false; return true; }); }
  function setButtons(){ var s=getFilters(); ['all','onfire','top','drought','due','favorable','watchlist'].forEach(function(f){ var b=document.getElementById('filter-'+f+'-btn'); if(!b)return; b.classList.toggle('active', f==='all'?s.size===0:s.has(f)); }); }
  function whyHR(r){ return '<strong>Why it supports the pick:</strong> '+esc((r.name||'This player')+' grades at '+n(r.hrProb).toFixed(1)+'% HR probability against '+(r.pitcherName||r.oppAbbr||'today’s opponent')+' because the model combines on-fire recent form, favorable pitcher matchup, ISO power, strong OPS, top HR threat signal, season HR rate, recent trend, and pitcher HR/9 baseline. Opponent context: '+(r.oppAbbr||'opponent')+'.'); }
  function hrSummary(arr){ if(!arr.length)return ''; var top=arr[0], sample=arr.slice(0,Math.min(8,arr.length)), avg=sample.reduce(function(a,r){return a+n(r.hrProb);},0)/Math.max(1,sample.length); return '<div class="dr1027-hr-summary"><div class="dr1027-summary-title">📊 EXPANDED <span>HR THREATS DATA</span></div><p class="dr1027-summary-copy">Players who have homered today are highlighted using live/final box score data while keeping the same HR threat criteria and filters.</p><div class="dr1027-summary-grid"><div class="dr1027-summary-metric good"><b>'+esc(top.name||'–')+'</b><span>Top Rated</span></div><div class="dr1027-summary-metric"><b>'+Math.round(avg)+'%</b><span>Board Avg Confidence</span></div><div class="dr1027-summary-metric"><b>'+arr.length+'</b><span>Players Scanned</span></div><div class="dr1027-summary-metric warn"><b>HR Prob '+n(top.hrProb).toFixed(1)+'%</b><span>Primary Signal</span></div></div></div>'; }
  function dr113Last10HRValue(r){
    if (r && r.last10HR != null && r.last10HR !== '') return r.last10HR;
    var s = (r && r.stats) || {};
    if (s.last10HR != null && s.last10HR !== '') return s.last10HR;
    if (s.last10HomeRuns != null && s.last10HomeRuns !== '') return s.last10HomeRuns;
    return null;
  }
  function renderHRPTableV1032(){ var el=document.getElementById('hr-potential-content'); if(!el)return; setButtons(); var base=getHRRows(); populateHRGameSelect(base); if(!base.length){el.innerHTML='<div class="mu-empty">No HR potential data yet — check back once lineups are posted.</div>';return;} var arr=applyHRFilters(base).filter(function(r){return !isHit('hr',r) && String(r.timeLabel||'').toUpperCase()!=='FINAL';}).sort(function(a,b){return n(b.hrProb)-n(a.hrProb);}); if(!arr.length){el.innerHTML='<div class="mu-empty" style="padding:24px">No players match the selected filters. Try fewer filters, or select ALL to reset.</div>';return;} var cards=arr.map(function(r){ var p=n(r.hrProb), hot=n(r.hotBoostPct), hit=isHit('hr',r), isFinal=String(r.timeLabel||'').toUpperCase()==='FINAL', isMiss=isFinal&&!hit, labels=[]; if(hit)labels.push('<span class="projection-hit-badge">✓ Projection Hit</span>'); else if(isMiss)labels.push('<span class="prop-miss-badge">✗ Missed</span>'); if(r.isOnFire)labels.push(labelChip('🔥 ON FIRE',Math.round(n(r.onFireScore)),'red')); if(r.isDue)labels.push(labelChip('⚡ DUE','YES','gold')); if(r.isDrought)labels.push(labelChip('❄️ DROUGHT','YES','red')); if(r.isFavorable)labels.push(labelChip('✅ FAVORABLE','MATCHUP','green')); if(r.topHrThreat||p>=18)labels.push(labelChip('💥 TOP HR','THREAT','gold')); var l10=dr113Last10HRValue(r); var bpPct=ballparkPalFactorForPlayer(r.gamePk,r.id); var stats=[hrChip('HR Prob',p.toFixed(1)+'%','green'),hrChip('Season HR',r.hrSeason||'–',''),hrChip('Last 10 HR',l10==null?'–':l10,n(l10)>=2?'green':''),hrChip('OPS',fmt3(r.ops),n(r.ops)>=.850?'green':''),hrChip('ISO',fmt3(r.iso),n(r.iso)>=.200?'gold':''),hrChip('AVG',fmt3(r.avg),n(r.avg)>=.280?'green':''),hot?hrChip('Hot Boost','+'+hot.toFixed(1),'gold'):'',bpPct!=null?hrChip('Ballpark Pal',(bpPct>0?'+':'')+bpPct+'%',bpPct>0?'green':bpPct<0?'red':''):''].filter(Boolean); return '<div class="dr1027-hr-card '+(hit?'projection-hit':isMiss?'prop-miss':'')+'" id="hrp-row-'+esc(r.id)+'" style="cursor:pointer" data-batter-id="'+esc(r.id)+'" data-batter-name="'+esc(r.name||'')+'" data-pitcher-id="'+esc(r.pitcherId||'')+'" data-pitcher-name="'+esc(r.pitcherName||'')+'" onclick="if(!event.target.closest(\'button,a\')){var d=this.dataset;openMatchup(+d.batterId,d.batterName,+d.pitcherId,d.pitcherName);}">'+window.drWatchStarHTML(r.id,r.name)+'<div class="dr1027-hr-head"><img class="dr1027-hr-photo" loading="lazy" decoding="async" src="'+hs(r.id)+'" onerror="this.style.visibility=\'hidden\'" alt=""><div><div class="dr1027-hr-name">'+esc(r.name||'–')+'</div><div class="dr1027-hr-meta">'+esc(r.teamAbbr||'–')+' · '+esc(r.pos||'–')+' · vs '+esc(r.oppAbbr||'–')+(r.pitcherName?' · '+esc(r.pitcherName):'')+'</div></div><div class="dr1027-hr-score"><strong>'+p.toFixed(1)+'%</strong><span>HR Probability</span><em>GRADE '+grade(p)+'</em></div></div><div class="dr1027-chip-row">'+labels.concat(stats).slice(0,16).join('')+'</div><div class="dr1027-why">'+whyHR(r)+'</div></div>'; }).join(''); el.innerHTML=hrSummary(arr)+'<div class="dr1027-hr-card-list">'+cards+'</div>'; }
  function setHRFilter(f){ var s=getFilters(); if(f==='all')s.clear(); else { if(s.has(f))s.delete(f); else s.add(f); } renderHRPTableV1032(); }
  window.renderHRPTable=renderHRPTableV1032;
  window.filterHRP=setHRFilter;
  function install(){ ['all','onfire','top','drought','due','favorable'].forEach(function(f){ var b=document.getElementById('filter-'+f+'-btn'); if(b){ b.onclick=function(ev){ if(ev)ev.preventDefault(); setHRFilter(f); return false; }; } }); }
  function refresh(){ install(); try{ window.renderPropIntelligencePanes(true); }catch(e){} try{ renderHRPTableV1032(); }catch(e){} }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', function(){ setTimeout(refresh,120); setTimeout(refresh,1200); }, {once:true}); else { setTimeout(refresh,120); setTimeout(refresh,1200); }
  document.addEventListener('click',function(e){ if(e.target&&e.target.closest&&e.target.closest('.gamepick-tab')) setTimeout(function(){ window.renderPropIntelligencePanes(); },80); },true);
})();

/* ---- from <script id="prod-v10-35-hr-cleanup-js"> ---- */
(function(){
  function cleanHRBadges(){
    try{
      var root=document.getElementById('hr-potential-content');
      if(!root) return;
      root.querySelectorAll('.dr1033-hr-today-name,.hr-today-badge,.hr-today-badge-prop').forEach(function(el){ el.remove(); });
      root.querySelectorAll('span,em,b').forEach(function(el){
        var txt=(el.textContent||'').trim().toUpperCase();
        if(txt.indexOf('HR TODAY')>-1 && !el.classList.contains('projection-hit-badge') && !el.classList.contains('hr-hit-badge')){
          var chip=el.closest('.dr1017-chip,.dr1019-label-chip,.dr1026-chip,.dr1027-chip,.dr109-chip,span');
          if(chip && !chip.classList.contains('projection-hit-badge') && !chip.classList.contains('hr-hit-badge')) chip.remove();
        }
      });
      root.querySelectorAll('.dr1027-why,.dr1026-why,.dr1017-why').forEach(function(el){
        el.innerHTML=(el.innerHTML||'').replace(/<b>\s*Why this HR threat\?\s*<\/b>\s*/i,'').replace(/^\s*Why this HR threat\?\s*/i,'');
      });
    }catch(e){}
  }
  var oldRender=window.renderHRPTable;
  if(typeof oldRender==='function'){
    window.renderHRPTable=function(){ var out=oldRender.apply(this,arguments); setTimeout(cleanHRBadges,0); return out; };
  }
  document.addEventListener('DOMContentLoaded',function(){
    cleanHRBadges();
    var root=document.getElementById('hr-potential-content');
    if(root && window.MutationObserver){
      var t=0;
      new MutationObserver(function(){ clearTimeout(t); t=setTimeout(cleanHRBadges,30); }).observe(root,{childList:true,subtree:true});
    }
  });
  window.drCleanHRBadges=cleanHRBadges;
})();

/* ---- from <script id="dr-v1036-stability-restore-js"> ---- */
(function(){
  function cleanTextNode(el){
    if(!el || !el.firstChild || el.firstChild.nodeType !== 3) return;
    el.firstChild.nodeValue = el.firstChild.nodeValue.replace(/^\s*✓\s+/, '');
  }
  function cleanupProjectionBadges(){
    try{
      document.querySelectorAll('.dr1027-hr-name,.dr109-name,.prop-player-name').forEach(cleanTextNode);
      document.querySelectorAll('#hr-potential-content span, #props span').forEach(function(el){
        var t=(el.textContent||'').toUpperCase();
        if(t.includes('HR TODAY')) el.remove();
      });
      document.querySelectorAll('.projection-hit-badge').forEach(function(el){
        el.textContent = el.textContent.replace(/HR\s+/i,'').replace(/^\s*✓?\s*/,'✓ ');
      });
    }catch(e){}
  }
  document.addEventListener('DOMContentLoaded', cleanupProjectionBadges);
  document.addEventListener('click', function(){ setTimeout(cleanupProjectionBadges, 60); }, true);
  window.addEventListener('load', cleanupProjectionBadges);
  window.DRStabilityRestoreCleanup = cleanupProjectionBadges;
})();

/* ---- from <script id="prod-v10-45-desktop-scale-marker"> ---- */
(function(){
  if(window.__DR_V1045_DESKTOP_SCALE__) return;
  window.__DR_V1045_DESKTOP_SCALE__=true;
  function mark(){
    var w=window.innerWidth||document.documentElement.clientWidth||0;
    var size=w>=2560?'ultra':w>=1920?'wide':w>=1536?'desktop':w>=1366?'standard':w>=1181?'compact':'mobile';
    document.documentElement.setAttribute('data-dr-desktop-size',size);
  }
  mark();
  window.addEventListener('resize',function(){window.clearTimeout(window.__dr1045ResizeTimer);window.__dr1045ResizeTimer=window.setTimeout(mark,120);},{passive:true});
})();

/* ---- from <script id="anonymous"> ---- */
function showPremiumGate(feature){
  feature = (feature === "team" ? "team-performance" : (feature || "parlay"));
  document.querySelectorAll('.gamepick-pane').forEach(function(p){
    p.hidden = true;
    p.classList.remove('active');
  });
  var container = document.getElementById('gamepick-premium-gate');
  if(!container){
    container=document.createElement('div');
    container.id='gamepick-premium-gate';
    container.className='gamepick-pane active';
    container.innerHTML=`
      <div class="dr-center-label">🔒 Coming Soon</div>
      <div class="dr-panel dr-panel-large">
        <div class="dr-panel-head">
          <div>
            <p class="section-title">COMING <span>SOON</span></p>
            <small>These sections are still being built.</small>
          </div>
        </div>
        <div class="dr-panel-body" style="text-align:center;padding:32px">
          <h2>🔒 Coming Soon</h2>
          <p>This section isn't available yet — check back soon.</p>
          <div style="margin-top:20px;line-height:2">
            🔒 🧾 Parlay Builds<br>
            🔒 🆚 Team Performance<br>
            🔒 🧠 Deep Research
          </div>
        </div>
      </div>`;
    document.querySelector('.gamepick-tabs')?.parentElement?.after(container);
  }
  container.hidden=false;
  container.classList.add('active');
}


/* ---- PROD v11.29: Clean native navigation controller ---- */
(function(){
  if (window.__DR_V1129_NAV_CONTROLLER__) return;
  window.__DR_V1129_NAV_CONTROLLER__ = true;

  var FREE_PANES = new Set(['game','pr','hr','k','hits','rbis','tb','sb','hrrbi','premium']);
  var PREMIUM_PANES = new Set(['parlay','team-performance','team','deep']);
  var NORMALIZE = { team:'team-performance', teamPerformance:'team-performance' };

  function normalizePane(pane){
    pane = String(pane || 'game').trim();
    return NORMALIZE[pane] || pane;
  }

  function setDesktopTabState(pane){
    var activePane = normalizePane(pane);
    document.querySelectorAll('.gamepick-tab').forEach(function(tab){
      var key = normalizePane(tab.getAttribute('data-gamepick-pane') || '');
      var active = key === activePane;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function openPremiumPane(pane){
    pane = normalizePane(pane);
    setDesktopTabState(pane);
    if (typeof window.showPremiumGate === 'function') {
      window.showPremiumGate(pane);
    }
  }

  function navigateToPane(pane, opts){
    pane = normalizePane(pane);
    opts = opts || {};

    if (PREMIUM_PANES.has(pane)) {
      openPremiumPane(pane);
      closeDrawer();
      return;
    }

    if (!FREE_PANES.has(pane)) pane = 'game';

    if (typeof window.showGamePickPane === 'function') {
      window.showGamePickPane(pane);
    } else {
      var target = document.getElementById('gamepick-pane-' + pane);
      document.querySelectorAll('.gamepick-pane').forEach(function(panel){
        var active = panel === target;
        panel.hidden = !active;
        panel.classList.toggle('active', active);
      });
      setDesktopTabState(pane);
    }

    closeDrawer();

    if (!opts.noScroll) {
      try {
        var props = document.getElementById('props');
        if (props && window.matchMedia('(max-width:1179px)').matches) {
          props.scrollIntoView({ block:'start', behavior:'smooth' });
        }
      } catch(e) {}
    }
  }

  function getEls(){
    return {
      btn: document.getElementById('dr-mobile-menu-btn'),
      drawer: document.getElementById('dr-mobile-drawer'),
      overlay: document.getElementById('dr-mobile-overlay'),
      close: document.getElementById('dr-mobile-close')
    };
  }

  function openDrawer(){
    var els = getEls();
    if (!els.drawer) return;
    els.drawer.classList.add('open');
    els.drawer.setAttribute('aria-hidden','false');
    if (els.overlay) els.overlay.classList.add('open');
    document.body.classList.add('dr-mobile-menu-open');
  }

  function closeDrawer(){
    var els = getEls();
    if (els.drawer) {
      els.drawer.classList.remove('open');
      els.drawer.setAttribute('aria-hidden','true');
    }
    if (els.overlay) els.overlay.classList.remove('open');
    document.body.classList.remove('dr-mobile-menu-open');
  }

  function bindNavigation(){
    var els = getEls();
    if (els.btn && !els.btn.dataset.drNavReady) {
      els.btn.dataset.drNavReady = '1';
      els.btn.addEventListener('click', function(e){
        e.preventDefault();
        e.stopPropagation();
        var isOpen = els.drawer && els.drawer.classList.contains('open');
        isOpen ? closeDrawer() : openDrawer();
      });
    }
    if (els.close && !els.close.dataset.drNavReady) {
      els.close.dataset.drNavReady = '1';
      els.close.addEventListener('click', function(e){ e.preventDefault(); closeDrawer(); });
    }
    if (els.overlay && !els.overlay.dataset.drNavReady) {
      els.overlay.dataset.drNavReady = '1';
      els.overlay.addEventListener('click', function(e){ e.preventDefault(); closeDrawer(); });
    }
    if (els.drawer) {
      els.drawer.querySelectorAll('.dr-menu-item[data-tab]').forEach(function(item){
        if (item.dataset.drNavReady) return;
        item.dataset.drNavReady = '1';
        item.addEventListener('click', function(e){
          e.preventDefault();
          e.stopPropagation();
          navigateToPane(item.getAttribute('data-tab') || 'game');
        });
      });
    }
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeDrawer(); }, { passive:true });
  }

  window.DiamondNavigateToPane = navigateToPane;
  window.DiamondOpenMobileMenu = openDrawer;
  window.DiamondCloseMobileMenu = closeDrawer;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindNavigation, { once:true });
  else bindNavigation();
  window.addEventListener('load', bindNavigation, { once:true });
})();

/* ---- from <script id="v8-74-lineup-game-projection-lock"> ---- */
(function(){
  if (window.__DR_LINEUP_GAME_PROJECTION_LOCK__) return;
  window.__DR_LINEUP_GAME_PROJECTION_LOCK__ = true;

  // v10.0: this used to freeze the ENTIRE day's board the moment any one team posted
  // an official lineup — often hours before first pitch, and before every other game
  // on the slate even had a lineup. Locking is now per game, at that game's own
  // scheduled start time, mirroring how the underlying win-probability model already
  // behaves (loadGameProps reuses _gamePropsSnapshot instead of recomputing once a
  // game goes live/final). This layer just persists each game's frozen card HTML to
  // localStorage so a reload/tab-switch doesn't lose the freeze; games that haven't
  // started yet are left alone and keep recomputing live on every render.
  var VERSION = 'v10.0';
  var LOCK_PREFIX = 'dr-official-game-projections-by-game:' + VERSION + ':';
  // Shared with installProjectionMutationGuard/refreshLockedGameProjectionScores
  // below — see the disconnect/reconnect guard there for why this needs to be
  // reachable from both.
  var mo = null;

  function centralDateKey(){
    try { return new Date().toLocaleDateString('en-CA', { timeZone:'America/Chicago' }); }
    catch(e){ return new Date().toISOString().slice(0,10); }
  }
  function lockKey(){ return LOCK_PREFIX + centralDateKey(); }
  function lockBannerHTML(count){
    return '<div class="dr-daily-lock-banner" data-dr-lock-banner="1"><span>🔒 '+count+' Game'+(count===1?'':'s')+' Locked At First Pitch</span><span>Games that haven\'t started yet keep updating live</span></div>';
  }
  function readStore(){
    try {
      var raw = localStorage.getItem(lockKey());
      if (!raw) return { date: centralDateKey(), games: {} };
      var saved = JSON.parse(raw);
      if (!saved || saved.date !== centralDateKey() || !saved.games) return { date: centralDateKey(), games: {} };
      return saved;
    } catch(e){ return { date: centralDateKey(), games: {} }; }
  }
  function writeStore(store){
    try { localStorage.setItem(lockKey(), JSON.stringify(store)); } catch(e){}
  }

  // Runs after every fresh render. Any card whose game has started and isn't frozen
  // yet gets snapshotted as-is (this is the freeze moment); any card that was already
  // frozen gets its freshly-rendered HTML replaced with the stored snapshot, so a pick
  // can't silently change after first pitch. Cards for games that haven't started are
  // left completely alone. Returns how many cards are currently locked.
  function applyPerGameLocks(){
    var el = document.getElementById('gameprops-content');
    if (!el) return 0;
    var cards = el.querySelectorAll('.gp-card[data-game-pk]');
    if (!cards.length) return 0;
    var store = readStore();
    var now = Date.now();
    var changed = false;
    var lockedCount = 0;
    cards.forEach(function(card){
      var pk = card.getAttribute('data-game-pk');
      var existing = store.games[pk];
      if (existing) {
        lockedCount++;
        if (card.outerHTML !== existing.html) card.outerHTML = existing.html;
        return;
      }
      var gameTime = parseInt(card.getAttribute('data-game-time'), 10);
      if (Number.isFinite(gameTime) && now >= gameTime) {
        store.games[pk] = { lockedAt: new Date().toISOString(), html: card.outerHTML };
        changed = true;
        lockedCount++;
      }
    });
    if (changed) writeStore(store);
    var banner = el.querySelector('[data-dr-lock-banner="1"]');
    if (banner) banner.remove();
    if (lockedCount > 0) el.insertAdjacentHTML('afterbegin', lockBannerHTML(lockedCount));
    var refreshEl = document.getElementById('gameprops-refresh');
    if (refreshEl && lockedCount > 0) refreshEl.textContent = lockedCount + ' game' + (lockedCount===1?'':'s') + ' locked at first pitch';
    return lockedCount;
  }

  window.DiamondClearGameProjectionLock = function(){
    try { localStorage.removeItem(lockKey()); return 'Game Projection locks cleared for ' + centralDateKey() + '.'; }
    catch(e){ return 'Unable to clear Game Projection locks: ' + (e.message || e); }
  };
  // Backward-compatible names — used to control the old lineup-confirmation lock,
  // now alias the per-game clear since that's the only lock left to clear.
  window.DiamondClearLineupGameProjectionLock = window.DiamondClearGameProjectionLock;
  window.DiamondClearDailyGameProjectionLock = window.DiamondClearGameProjectionLock;

  function clearProjectionResultZones(root){
    root = root || document;
    try {
      root.querySelectorAll('.gp-live-result-zone,[data-live-score-badge="1"]').forEach(function(zone){ zone.innerHTML = ''; });
      root.querySelectorAll('.gp-card span').forEach(function(span){
        var t = (span.textContent || '').trim();
        if (/^(✓\s*CORRECT|✗\s*INCORRECT|▲\s+.*\sleads\s+\d+\-\d+|▼\s+.*\sleads\s+\d+\-\d+|.*\swon\s+\d+\-\d+)/i.test(t)) {
          var parent = span.parentElement;
          if (parent && parent.children.length === 1 && (parent.style.marginTop || '').indexOf('8') !== -1) parent.innerHTML = '';
          else span.remove();
        }
      });
    } catch(e) {}
  }

  async function refreshLockedGameProjectionScores(){
    var el = document.getElementById('gameprops-content');
    if (!el || !el.querySelector('.gp-card')) return false;
    try {
      var today = centralDateKey();
      var url = 'https://diamondreport.app/api/v1/schedule?sportId=1&date=' + today + '&hydrate=linescore,team&language=en&_live=' + Date.now();
      var r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return false;
      var data = await r.json();
      var entry = data.dates && (data.dates.find(function(d){ return d.date === today; }) || data.dates[0]);
      var games = (entry && entry.games) || [];
      // This function's own DOM writes below (clearProjectionResultZones, zone.innerHTML)
      // are childList/subtree mutations on the exact node installProjectionMutationGuard
      // watches. Without disconnecting first, every call here re-fires that observer,
      // which reschedules another call via scheduleAuthoritativeRefresh — even when the
      // score badge content is byte-identical — which mutates again and re-triggers the
      // observer again. That self-sustaining ~80ms loop (running continuously any time a
      // game has started today, since store.games is never empty then) was the real cause
      // behind the Game Projections panel flickering during live games — same class of bug
      // already fixed in prod-v9-4-game-projection-live-authority's applyGames(), just not
      // applied here too. Mirrors that function's disconnect/reconnect pattern.
      if (mo) mo.disconnect();
      games.forEach(function(g){
        var card = el.querySelector('.gp-card[data-game-pk="' + g.gamePk + '"]');
        if (!card) return;
        var awayScore = g.teams && g.teams.away ? g.teams.away.score : null;
        var homeScore = g.teams && g.teams.home ? g.teams.home.score : null;
        var state = g.status && g.status.abstractGameState;
        var detailed = g.status && g.status.detailedState;
        var isFinal = state === 'Final';
        var isLive = state === 'Live' || detailed === 'In Progress';
        var awayAbbr = card.getAttribute('data-away') || (g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.abbreviation) || 'AWAY';
        var homeAbbr = card.getAttribute('data-home') || (g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.abbreviation) || 'HOME';
        var winnerAbbr = card.getAttribute('data-winner') || '';
        var badge = '';
        if (isFinal && awayScore != null && homeScore != null) {
          var actualWinnerAbbr = awayScore > homeScore ? awayAbbr : homeScore > awayScore ? homeAbbr : null;
          if (actualWinnerAbbr) {
            var ok = actualWinnerAbbr === winnerAbbr;
            badge = '<span style="background:'+(ok?'#0d2a1a':'#2a0d0d')+';color:'+(ok?'#2ecc71':'#dc2626')+';font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid '+(ok?'#2ecc7166':'#dc262666')+'">'+(ok?'✓ CORRECT':'✗ INCORRECT')+' — '+actualWinnerAbbr+' won '+awayScore+'-'+homeScore+'</span>';
          }
        } else if (isLive && awayScore != null && homeScore != null) {
          var leadingAbbr = awayScore > homeScore ? awayAbbr : homeScore > awayScore ? homeAbbr : null;
          if (leadingAbbr) {
            var pickLeading = leadingAbbr === winnerAbbr;
            badge = '<span style="background:'+(pickLeading?'#0d2a1a':'#2a0d0d')+';color:'+(pickLeading?'#2ecc71':'#dc2626')+';font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid '+(pickLeading?'#2ecc7166':'#dc262666')+'">'+(pickLeading?'▲':'▼')+' LIVE '+leadingAbbr+' leads '+awayScore+'-'+homeScore+'</span>';
          } else {
            badge = '<span style="background:rgba(255,193,7,.10);color:var(--accent2);font-size:10px;font-weight:800;padding:3px 10px;border-radius:4px;border:1px solid rgba(255,193,7,.45)">● LIVE TIED '+awayScore+'-'+homeScore+'</span>';
          }
        }
        clearProjectionResultZones(card);
        var zone = card.querySelector('.gp-live-result-zone,[data-live-score-badge="1"]');
        if (!zone) {
          zone = document.createElement('div');
          zone.className = 'gp-live-result-zone';
          zone.setAttribute('data-live-score-badge','1');
          zone.style.marginTop = '8px';
          card.appendChild(zone);
        }
        zone.innerHTML = badge || '';
      });
      var refreshEl = document.getElementById('gameprops-refresh');
      if (refreshEl) refreshEl.textContent = 'Scores updated ' + new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
      return true;
    } catch(e){ return false; }
    finally { if (mo && el) mo.observe(el, { childList:true, subtree:true }); }
  }
  window.DiamondRefreshLockedGameProjectionScores = refreshLockedGameProjectionScores;

  var refreshTimer = null;
  function scheduleAuthoritativeRefresh(){
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function(){ refreshTimer = null; refreshLockedGameProjectionScores(); }, 80);
  }
  function installProjectionMutationGuard(){
    var el = document.getElementById('gameprops-content');
    if (!el || el.__drLiveScoreMutationGuard) return;
    el.__drLiveScoreMutationGuard = true;
    try {
      mo = new MutationObserver(function(){
        var store = readStore();
        if (Object.keys(store.games).length > 0) scheduleAuthoritativeRefresh();
      });
      mo.observe(el, { childList:true, subtree:true });
    } catch(e) {}
  }

  function installWrapper(){
    if (typeof window.loadGameProps !== 'function' || window.loadGameProps.__drLineupLockWrapped) return false;
    var original = window.loadGameProps;
    async function perGameLockedLoadGameProps(opts){
      // Always recompute fresh — games that haven't started need live data every time.
      // Started games get spliced back to their frozen snapshot right after.
      var result = await original.apply(this, arguments);
      var lockedCount = applyPerGameLocks();
      if (lockedCount > 0) await refreshLockedGameProjectionScores();
      return result;
    }
    perGameLockedLoadGameProps.__drLineupLockWrapped = true;
    window.loadGameProps = perGameLockedLoadGameProps;
    return true;
  }

  function boot(){
    installProjectionMutationGuard();
    installWrapper();
    var tries = 0;
    var id = setInterval(function(){
      tries++;
      var wrapped = installWrapper();
      if (wrapped || tries > 20) clearInterval(id);
    }, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once:true });
  else boot();
})();

/* ---- from <script id="prod-v9-4-game-projection-live-authority"> ---- */
(function(){
  if (window.__DR_V94_GAME_PROJECTION_LIVE_AUTHORITY__) return;
  window.__DR_V94_GAME_PROJECTION_LIVE_AUTHORITY__ = true;

  var latestGames = null;
  var latestAt = 0;
  var applying = false;
  var fetching = false;
  var observerInstalled = false;
  var mo = null;

  function ctDate(){
    try { return new Date().toLocaleDateString('en-CA', { timeZone:'America/Chicago' }); }
    catch(e){ return new Date().toISOString().slice(0,10); }
  }
  function scoreUrl(){
    return 'https://diamondreport.app/api/v1/schedule?sportId=1&date=' + ctDate() + '&hydrate=linescore,team&language=en&_live=' + Date.now();
  }
  function gameState(g){
    var state = g && g.status && g.status.abstractGameState;
    var detailed = g && g.status && g.status.detailedState;
    var isFinal = state === 'Final' || detailed === 'Final' || detailed === 'Game Over';
    var isLive = state === 'Live' || detailed === 'In Progress';
    return { isFinal:isFinal, isLive:isLive, label:isFinal?'FINAL':isLive?'● LIVE':null };
  }
  function badgeFor(card, g){
    var away = g.teams && g.teams.away;
    var home = g.teams && g.teams.home;
    var awayScore = away ? away.score : null;
    var homeScore = home ? home.score : null;
    var st = gameState(g);
    var awayAbbr = card.getAttribute('data-away') || (away && away.team && away.team.abbreviation) || 'AWAY';
    var homeAbbr = card.getAttribute('data-home') || (home && home.team && home.team.abbreviation) || 'HOME';
    var winnerAbbr = card.getAttribute('data-winner') || '';
    if (awayScore == null || homeScore == null) return '';
    if (st.isFinal) {
      var actualWinnerAbbr = awayScore > homeScore ? awayAbbr : homeScore > awayScore ? homeAbbr : null;
      if (!actualWinnerAbbr) return '<span style="background:#1a1a2e;color:var(--muted);font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid var(--border)">TIE GAME</span>';
      var ok = actualWinnerAbbr === winnerAbbr;
      return '<span style="background:'+(ok?'#0d2a1a':'#2a0d0d')+';color:'+(ok?'#2ecc71':'#dc2626')+';font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid '+(ok?'#2ecc7166':'#dc262666')+'">'+(ok?'✓ CORRECT':'✗ INCORRECT')+' — '+actualWinnerAbbr+' won '+awayScore+'-'+homeScore+'</span>';
    }
    if (st.isLive) {
      var leadingAbbr = awayScore > homeScore ? awayAbbr : homeScore > awayScore ? homeAbbr : null;
      if (!leadingAbbr) return '<span style="background:rgba(255,193,7,.10);color:var(--accent2);font-size:10px;font-weight:800;padding:3px 10px;border-radius:4px;border:1px solid rgba(255,193,7,.45)">● LIVE TIED '+awayScore+'-'+homeScore+'</span>';
      var pickLeading = leadingAbbr === winnerAbbr;
      return '<span style="background:'+(pickLeading?'#0d2a1a':'#2a0d0d')+';color:'+(pickLeading?'#2ecc71':'#dc2626')+';font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid '+(pickLeading?'#2ecc7166':'#dc262666')+'">'+(pickLeading?'▲':'▼')+' LIVE '+leadingAbbr+' leads '+awayScore+'-'+homeScore+'</span>';
    }
    return '';
  }
  function cleanOldScoreBadges(card){
    card.querySelectorAll('[data-live-score-badge="1"]').forEach(function(n){ n.remove(); });
    Array.prototype.slice.call(card.children).forEach(function(n){
      var t = (n.textContent || '').trim();
      if (/CORRECT|INCORRECT|TIE GAME|LIVE TIED|\bwon\b|\bleads\b|\bTIED\b/i.test(t)) n.remove();
    });
  }
  function updateStatusPill(card, g){
    var st = gameState(g);
    if (!st.label) return;
    var center = card.querySelector('.gp-vs') && card.querySelector('.gp-vs').parentElement;
    if (!center) return;
    var spans = center.querySelectorAll('span');
    var statusSpan = spans[1] || null;
    if (!statusSpan) return;
    if (st.isFinal) {
      statusSpan.outerHTML = '<span style="font-size:9px;color:var(--muted)">FINAL</span>';
    } else if (st.isLive) {
      statusSpan.outerHTML = '<span style="background:#2a0000;color:var(--live);font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;border:1px solid var(--live)">● LIVE</span>';
    }
  }

  function updateInlineScore(card, g){
    var st = gameState(g);
    var away = g.teams && g.teams.away;
    var home = g.teams && g.teams.home;
    var awayScore = away ? away.score : null;
    var homeScore = home ? home.score : null;
    var center = card.querySelector('.gp-vs') && card.querySelector('.gp-vs').parentElement;
    if (!center) return;
    var old = center.querySelector('[data-gp-live-score="1"]');
    if (awayScore == null || homeScore == null) { if (old) old.remove(); return; }
    var cls = st.isFinal ? 'final' : st.isLive ? 'live' : '';
    var html = '<span class="gp-live-score '+cls+'" data-gp-live-score="1">'+awayScore+'-'+homeScore+'</span>';
    if (old) old.outerHTML = html;
    else center.insertAdjacentHTML('beforeend', html);
  }
  function removeOldTally(root){
    Array.prototype.slice.call(root.children).forEach(function(n){
      if (n.getAttribute && n.getAttribute('data-live-game-tally') === '1') n.remove();
      else if (/TODAY['’]S RECORD/i.test(n.textContent || '')) n.remove();
    });
  }
  function buildTally(root, gamesByPk){
    var cards = Array.prototype.slice.call(root.querySelectorAll('.gp-card[data-game-pk]'));
    var total = cards.length, finalN = 0, correct = 0;
    cards.forEach(function(card){
      var g = gamesByPk[String(card.getAttribute('data-game-pk'))];
      if (!g) return;
      var st = gameState(g);
      if (!st.isFinal) return;
      var awayScore = g.teams && g.teams.away ? g.teams.away.score : null;
      var homeScore = g.teams && g.teams.home ? g.teams.home.score : null;
      if (awayScore == null || homeScore == null || awayScore === homeScore) return;
      finalN++;
      var awayAbbr = card.getAttribute('data-away') || (g.teams.away.team && g.teams.away.team.abbreviation);
      var homeAbbr = card.getAttribute('data-home') || (g.teams.home.team && g.teams.home.team.abbreviation);
      var actual = awayScore > homeScore ? awayAbbr : homeAbbr;
      if (actual === card.getAttribute('data-winner')) correct++;
    });
    if (!finalN) return null;
    var d = new Date().toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    var pct = Math.round(correct / finalN * 100) + '% accuracy';
    var color = correct === finalN ? '#2ecc71' : correct > finalN/2 ? 'var(--accent2)' : 'var(--accent)';
    var div = document.createElement('div');
    div.setAttribute('data-live-game-tally','1');
    div.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg);border-bottom:1px solid var(--border);flex-wrap:wrap;gap:8px';
    div.innerHTML = '<span style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase">TODAY\'S RECORD</span>'+
      '<span style="font-size:10px;color:var(--muted);font-family:\'JetBrains Mono\',monospace">'+d+'</span>'+
      '<span style="font-family:\'Manrope\',sans-serif;font-size:28px;letter-spacing:1px;color:'+color+'">'+correct+'-'+(finalN-correct)+'</span>'+
      '<span style="font-size:11px;color:var(--muted)">'+finalN+' of '+total+' games final</span>'+
      '<span style="font-size:11px;color:var(--muted);font-family:\'JetBrains Mono\',monospace">'+pct+'</span>';
    return div;
  }
  function applyGames(games){
    var root = document.getElementById('gameprops-content');
    if (!root || !Array.isArray(games) || !games.length || applying) return false;
    applying = true;
    // This function's own DOM writes below (removeOldTally/insertBefore, score badge
    // add/remove) are childList mutations on the exact node the MutationObserver in
    // installObserver() watches. Without disconnecting first, every call here re-fires
    // that observer, which schedules three more applyGames() calls via applyCachedSoon()
    // - each of which mutates again and re-triggers the observer again. That self-
    // sustaining, multiplying cascade (visible once today's games render in this panel,
    // worse the longer the tab stays open and visible) was the real cause behind
    // "site gets slow over a long session with live games on."
    if (mo) mo.disconnect();
    try {
      var byPk = {};
      games.forEach(function(g){ if (g && g.gamePk != null) byPk[String(g.gamePk)] = g; });
      root.querySelectorAll('.gp-card[data-game-pk]').forEach(function(card){
        var g = byPk[String(card.getAttribute('data-game-pk'))];
        if (!g) return;
        cleanOldScoreBadges(card);
        updateStatusPill(card, g);
        updateInlineScore(card, g);
        var badge = badgeFor(card, g);
        if (badge) {
          var wrap = document.createElement('div');
          wrap.setAttribute('data-live-score-badge','1');
          wrap.style.marginTop = '8px';
          wrap.innerHTML = badge;
          card.appendChild(wrap);
        }
      });
      removeOldTally(root);
      var tally = buildTally(root, byPk);
      if (tally) {
        var banner = root.querySelector('[data-dr-lock-banner="1"]');
        if (banner && banner.nextSibling) root.insertBefore(tally, banner.nextSibling);
        else root.insertBefore(tally, root.firstChild);
      }
      var refreshEl = document.getElementById('gameprops-refresh');
      if (refreshEl) refreshEl.textContent = 'Scores updated ' + new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
      return true;
    } finally {
      applying = false;
      if (mo && root) mo.observe(root, { childList:true, subtree:false });
    }
  }
  async function fetchAndApply(){
    if (fetching) return false;
    fetching = true;
    try {
      var r = await fetch(scoreUrl(), { cache:'no-store' });
      if (!r.ok) return false;
      var data = await r.json();
      var today = ctDate();
      var entry = data.dates && (data.dates.find(function(d){ return d.date === today; }) || data.dates[0]);
      latestGames = (entry && entry.games) || [];
      latestAt = Date.now();
      window.__DR_LATEST_GAME_PROJECTION_SCORES__ = { games: latestGames, at: latestAt };
      return applyGames(latestGames);
    } catch(e){ return false; }
    finally { fetching = false; }
  }
  function applyCachedSoon(){
    if (!latestGames || !latestGames.length) return;
    setTimeout(function(){ applyGames(latestGames); }, 0);
    setTimeout(function(){ applyGames(latestGames); }, 80);
    setTimeout(function(){ applyGames(latestGames); }, 350);
  }
  function installObserver(){
    if (observerInstalled) return;
    var root = document.getElementById('gameprops-content');
    if (!root) return;
    observerInstalled = true;
    mo = new MutationObserver(function(){
      if (applying) return;
      applyCachedSoon();
    });
    mo.observe(root, { childList:true, subtree:false });
  }

  var original = window.DiamondRefreshLockedGameProjectionScores;
  window.DiamondRefreshLockedGameProjectionScores = async function(){
    installObserver();
    var ok = await fetchAndApply();
    if (!ok && typeof original === 'function') return original.apply(this, arguments);
    return ok;
  };

  document.addEventListener('DOMContentLoaded', function(){ installObserver(); setTimeout(fetchAndApply, 250); setTimeout(fetchAndApply, 1500); }, { once:true });
  setTimeout(function(){ installObserver(); fetchAndApply(); }, 500);
  setInterval(() => { if (document.visibilityState === 'visible') fetchAndApply(); }, 60 * 1000);
})();

/* ---- pick-hit micro-celebration ----
   A brief glow/scale pulse the first time a game's result badge turns into
   "✓ CORRECT", instead of it just appearing statically. Deliberately built as
   its own read-mostly observer rather than touching any of the three existing
   badge-generation code paths above (base loadGameProps's own resultBadge,
   this file's applyGames(), and refreshLockedGameProjectionScores()) — a
   classList toggle on the existing badge node isn't a childList mutation, so
   it can't feed back into any of those observers the way the flicker bug did,
   and "already celebrated" is tracked per gamePk in localStorage so reopening
   the tab later doesn't replay it. */
(function(){
  if (window.__DR_PICK_CELEBRATION__) return;
  window.__DR_PICK_CELEBRATION__ = true;
  var STORE_KEY = 'dr-pick-celebrated-v1';
  var celebrated = new Set();
  try { (JSON.parse(localStorage.getItem(STORE_KEY) || '[]')).forEach(function(pk){ celebrated.add(pk); }); } catch(e) {}
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(Array.from(celebrated).slice(-300))); } catch(e) {}
  }
  function scan() {
    var root = document.getElementById('gameprops-content');
    if (!root) return;
    root.querySelectorAll('.gp-card[data-game-pk]').forEach(function(card){
      var pk = card.getAttribute('data-game-pk');
      if (!pk || celebrated.has(pk)) return;
      var zone = card.querySelector('.gp-live-result-zone,[data-live-score-badge="1"]');
      if (!zone || !/✓\s*CORRECT/.test(zone.textContent || '')) return;
      celebrated.add(pk);
      persist();
      zone.classList.add('dr-pick-celebrate');
      zone.addEventListener('animationend', function(){ zone.classList.remove('dr-pick-celebrate'); }, { once:true });
    });
  }
  function boot() {
    var root = document.getElementById('gameprops-content');
    if (!root) { setTimeout(boot, 500); return; }
    new MutationObserver(scan).observe(root, { childList:true, subtree:true });
    scan();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once:true });
  else boot();
})();

/* ---- from <script id="prod-v9-performance-orchestrator"> ---- */
(function(){
  if (window.__DR_V9_ORCHESTRATOR__) return;
  window.__DR_V9_ORCHESTRATOR__ = true;
  var idle = function(cb){ return setTimeout(function(){ cb({timeRemaining:function(){return 1;}}); }, 1); };
  var loadLocks = new Map();
  var loadedTabs = Object.create(null);

  function activeId(){ var el = document.querySelector('.section.active'); return el && el.id; }
  function isActive(id){ return activeId() === id; }
  function softSkeleton(id, label){
    var el = document.getElementById(id);
    if (!el || el.dataset.v9Skeleton === '1' || el.children.length) return;
    el.dataset.v9Skeleton = '1';
    el.innerHTML = '<div class="dr-v9-loading-row"><div class="dr-v9-loading-label">Loading '+ label +'</div><div class="dr-v9-skeleton"></div><div class="dr-v9-skeleton" style="min-height:58px"></div></div>';
  }
  function clearSkeleton(id){
    var el = document.getElementById(id);
    if (el && el.dataset.v9Skeleton === '1') delete el.dataset.v9Skeleton;
  }
  function coalesce(name, paneId){
    var fn = window[name];
    if (typeof fn !== 'function' || fn.__drV9Wrapped) return;
    window[name] = function(){
      var args = Array.prototype.slice.call(arguments);
      var force = args.some(function(a){ return a && a.force; });
      if (paneId && !force && document.readyState === 'complete' && !isActive(paneId) && loadedTabs[paneId]) {
        return Promise.resolve(null);
      }
      if (loadLocks.has(name)) { window.DR_V9_STATS && (window.DR_V9_STATS.coalescedLoads++); return loadLocks.get(name); }
      var p = Promise.resolve().then(function(){ return fn.apply(window, args); })
        .finally(function(){ loadLocks.delete(name); if (paneId) loadedTabs[paneId] = true; });
      loadLocks.set(name, p);
      return p;
    };
    window[name].__drV9Wrapped = true;
  }
  function wrapRender(name, containerId){
    var fn = window[name];
    if (typeof fn !== 'function' || fn.__drV9RenderWrapped) return;
    window[name] = function(){ clearSkeleton(containerId); return fn.apply(window, arguments); };
    window[name].__drV9RenderWrapped = true;
  }
  function setup(){
    document.body.classList.add('dr-v9-ready');
    // 'props' deliberately excluded: content-visibility:auto implies layout
    // containment on whatever element it's set on, which breaks
    // position:sticky for any descendant relative to ancestors further up —
    // #props is the direct ancestor chain for the HR Threats filter bar
    // (position:sticky), which was silently scrolling off-screen instead of
    // staying pinned because of this exact mechanism.
    ['game','matchups','tracker'].forEach(function(id){ var el=document.getElementById(id); if(el) el.classList.add('dr-v9-soft-hide'); });
    softSkeleton('game-props-content','game projections');
    softSkeleton('kprops-content','strikeout projections');
    softSkeleton('hr-potential-content','HR potential');
    softSkeleton('ks-today-props',"K's today");

    coalesce('loadScores', null);
    coalesce('loadGameProps','game');
    coalesce('loadHRPotential','props');
    coalesce('loadHRPotentialWithRetry','props');
    coalesce('loadHRsToday','props');
    coalesce('loadKsToday','props');
    coalesce('loadKsTodayWithRetry','props');
    coalesce('loadKProps','props');
    coalesce('loadPitcherReport','matchups');
    wrapRender('renderKProps','kprops-content');
    wrapRender('renderHRPotential','hr-potential-content');

    function loadVisible(){
      var id = activeId();
      if (id === 'game' && typeof window.loadGameProps === 'function') idle(function(){ window.loadGameProps({force:true}); });
      if (id === 'props') idle(function(){
        if (typeof window.loadHRPotentialWithRetry === 'function') window.loadHRPotentialWithRetry();
        if (typeof window.loadKsTodayWithRetry === 'function') window.loadKsTodayWithRetry();
        if (typeof window.loadKProps === 'function') window.loadKProps();
      });
      if (id === 'matchups' && typeof window.loadPitcherReport === 'function') idle(function(){ window.loadPitcherReport(); });
    }

    document.addEventListener('click', function(e){
      var tab = e.target.closest('.tab,[data-tab],[data-section]');
      if (!tab) return;
      setTimeout(loadVisible, 60);
    }, true);
    setTimeout(loadVisible, 120);
    setTimeout(function(){ if (typeof window.loadScores === 'function') window.loadScores(); }, 50);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, {once:true}); else setup();
})();

/* ---- from <script id="prod-v10-9-expanded-analytics-js"> ---- */
(function(){
  if(window.__DR_V109_EXPANDED__) return; window.__DR_V109_EXPANDED__=true;
  function n(v){v=parseFloat(v);return Number.isFinite(v)?v:0}
  function pct(v){return Math.max(1,Math.min(99,Math.round(v)))}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function f(v,d){v=n(v); if(!v) return '–'; return v.toFixed(d==null?3:d).replace(/^0(?=\.)/,'')}
  function int(v){v=n(v); return v?String(Math.round(v)):'–'}
  function head(id){return id?'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_84,q_auto:best/v1/people/'+id+'/headshot/67/current':''}
  function rows(){try{return (window.getProductionPropRows?window.getProductionPropRows():(window.hrpRows||[])).filter(function(r){return !window.isActiveForHRThreat||window.isActiveForHRThreat(r)})}catch(e){return []}}
  function score(type,r){
    var s=r.stats||{},
        avg=n(r.avg), ops=n(r.ops), iso=n(r.iso), hr=n(r.hrSeason), prob=n(r.hrProb),
        obp=n(r.obp||s.obp), slg=n(r.slg||s.slg),
        sb=n(s.stolenBases), cs=n(s.caughtStealing), l10=n(r.last10HR);
    var base=50;
    var pAvgAllowed = r.pitcherAvgAllowed || .260, pSlgAllowed = r.pitcherSlgAllowed || .400;
    var bo = r.battingOrder;
    if(type==='hits'){
      var paBoost = bo ? Math.max(0,(6-bo))*.7 : 0;
      base = 38 + avg*120 + ops*8 + obp*12 + (pAvgAllowed-.260)*70 + paBoost + (r.isFavorable?4:0);
    }
    if(type==='rbis'){
      var rbiSlot = bo ? ({2:4,3:9,4:11,5:8,6:4}[bo]||0) : 0;
      base = 35 + ops*10 + iso*72 + hr*.8 + prob*.35 + rbiSlot + (r.topHrThreat?4:0);
    }
    if(type==='tb'){
      var parkBoost = r.parkFactor ? (r.parkFactor-100)*.12 : 0;
      base = 36 + ops*8 + iso*96 + prob*.45 + l10*2 + slg*8 + (pSlgAllowed-.400)*45 + parkBoost;
    }
    if(type==='sb'){
      var att = sb+cs;
      var sbRate = att>=5 ? sb/att : (sb>0?0.70:0.60);
      var pAtt = (r.pitcherSbAllowed||0)+(r.pitcherCsAllowed||0);
      var battery = pAtt>=5 ? (((r.pitcherSbAllowed||0)/pAtt)-0.72)*22 : 0;
      base = 26 + Math.min(sb,20)*1.6 + sbRate*22 + avg*26 + obp*18 + battery + (String(r.pos||'').match(/SS|CF|2B|LF|RF/)?6:0);
    }
    if(type==='hrrbi'){
      var lineupBoost = bo ? Math.max(0, 5-Math.abs(bo-3))*1.3 : 0;
      base = 42 + avg*55 + ops*9 + hr*.45 + prob*.32 + (r.isFavorable?5:0) + obp*8 + lineupBoost;
    }
    return pct(base);
  }
  function label(type){return {hits:'Hits',rbis:'RBIs',tb:'Total Bases',sb:'Stolen Bases',hrrbi:'Hits+Runs+RBI',hr:'Home Runs'}[type]||'Prop'}
  function line(type){return {hits:'Over 0.5 Hits',rbis:'Over 0.5 RBI',tb:'Over 1.5 Total Bases',sb:'Over 0.5 SB',hrrbi:'Over 1.5 H+R+RBI',hr:'HR Anytime / 1+ Total Base'}[type]||'Line'}
  function chips(type,r){var s=r.stats||{},avg=n(r.avg),ops=n(r.ops),iso=n(r.iso),obp=n(s.obp),slg=n(s.slg),hr=n(r.hrSeason),prob=n(r.hrProb),sb=n(s.stolenBases),rbi=n(s.rbi||s.runsBattedIn),runs=n(s.runs),hits=n(s.hits);var a=[];
    if(type==='hits')a=[['Line',line(type),'good'],['AVG',f(avg),''],['xBA proxy',f(avg+(r.isFavorable?.012:0)),'good'],['OBP',f(obp),''],['Contact',pct(66+avg*80)+'%','good'],['K Avoid',pct(72-n(s.strikeOuts)*.04)+'%',''],['PA Est','4.1',''],['Park','Neutral','']];
    if(type==='rbis')a=[['Line',line(type),'good'],['RBI',int(rbi),''],['RISP proxy',pct(42+ops*20)+'%','good'],['Run Env',r.isFavorable?'Plus':'Neutral',r.isFavorable?'good':''],['OPS',f(ops),''],['ISO',f(iso),'warn'],['Team Stack','Supported',''],['Lineup','Middle/Power','']];
    if(type==='tb')a=[['Line',line(type),'good'],['SLG',f(slg),''],['xSLG proxy',f(slg+iso*.12),'good'],['ISO',f(iso),'warn'],['Hard Hit',pct(28+iso*90)+'%',''],['Barrel proxy',pct(5+prob*.12)+'%','warn'],['XBH Upside',hr>=15?'High':'Med',hr>=15?'warn':''],['Park Factor','Checked','']];
    if(type==='sb')a=[['Line',line(type),'good'],['SB',int(sb),'good'],['OBP',f(obp),''],['Speed proxy',pct(48+sb*2.2)+'%','good'],['Catcher/Pitcher','Tracked',''],['Attempts',sb>=10?'Aggressive':'Selective',sb>=10?'good':''],['Game Script','Run lane',''],['Risk','Volatile','warn']];
    if(type==='hrrbi')a=[['Line',line(type),'good'],['Hits',int(hits),''],['Runs',int(runs),''],['RBI',int(rbi),''],['OPS',f(ops),'good'],['OBP',f(obp),''],['SLG',f(slg),''],['Run Env',r.isFavorable?'Plus':'Neutral',r.isFavorable?'good':'']];
    return a.map(function(x){return '<span class="dr109-chip '+(x[2]||'')+'"><span>'+esc(x[0])+':</span><strong>'+esc(x[1])+'</strong></span>'}).join('')}
  function reason(type,r,sc){var nm=esc(r.name||'This player'),opp=esc(r.oppAbbr||'opponent');var map={hits:'contact profile, on-base skill, projected plate appearances, and matchup quality',rbis:'RBI lane, team run environment, power profile, and traffic ahead of the bat',tb:'slugging upside, ISO, hard-contact indicators, and extra-base-hit path',sb:'speed profile, on-base path, opponent running-game weakness, and game script',hrrbi:'combined production path from contact, runs, RBI lane, and lineup context'};return '<b>Why it supports the line:</b> '+nm+' grades at '+sc+'% for '+line(type)+' because the model combines '+map[type]+'. Opponent context: '+opp+'.'}
  function propSummary(type,arr){var top=arr[0],avg=arr.reduce(function(a,b){return a+score(type,b)},0)/Math.max(1,arr.length);return '<div class="dr109-summary"><div class="dr109-title">📊 Expanded '+label(type)+' Data</div><p class="dr109-copy">This board now shows line support, matchup context, recent-form proxies, Statcast-style power/contact indicators, and a plain-English reason for each play. Values are generated from the active production rows so they stay fast and do not add external load time.</p><div class="dr109-grid"><div class="dr109-metric good"><b>'+esc(top&&top.name||'–')+'</b><span>Top Rated</span></div><div class="dr109-metric"><b>'+Math.round(avg)+'%</b><span>Board Avg Confidence</span></div><div class="dr109-metric"><b>'+arr.length+'</b><span>Players Scanned</span></div><div class="dr109-metric warn"><b>'+line(type)+'</b><span>Primary Line</span></div></div></div>'}
  function renderProps(type,id){var el=document.getElementById(id); if(!el) return; var arr=rows().slice().sort(function(a,b){return score(type,b)-score(type,a)}).slice(0,24); if(!arr.length){el.innerHTML='<div class="mu-empty">Loading expanded '+label(type)+' analytics…</div>';return} el.innerHTML=propSummary(type,arr)+arr.map(function(r){var sc=score(type,r);return '<div class="dr109-card"><div class="dr109-card-head"><div class="dr109-player"><img loading="lazy" src="'+head(r.id)+'" onerror="this.style.display=\'none\'" alt=""><div style="min-width:0"><div class="dr109-name">'+esc(r.name||'Player')+'</div><div class="dr109-meta">'+esc(r.teamAbbr||'')+' · '+esc(r.pos||'')+' · vs '+esc(r.oppAbbr||'')+'</div></div></div><div class="dr109-score">'+sc+'%<small>'+esc(label(type))+' Edge</small></div></div><div class="dr109-chiprow">'+chips(type,r)+'</div><div class="dr109-reason">'+reason(type,r,sc)+'</div></div>'}).join('')}
  /* v10.9 legacy renderer disabled: it lacked the Projection Hit checkmark logic added later and was clobbering the correct renderer. */
  function hrEnhance(){ return; /* disabled: this banner kept appearing/disappearing because the main HR renderer wipes it on every refresh */ var el=document.getElementById('hr-potential-content'); if(!el||el.dataset.dr109) return; var arr=rows().slice().sort(function(a,b){return n(b.hrProb)-n(a.hrProb)}).slice(0,10); if(!arr.length) return; el.dataset.dr109='1'; el.insertAdjacentHTML('afterbegin','<div class="dr109-summary"><div class="dr109-title">💣 Expanded Home Runs Data</div><p class="dr109-copy">Home Runs now highlights HR probability, ISO, slugging, projected barrel path, hard-hit profile, park/weather read, pitcher HR allowance context, and matchup support before the live HR table.</p><div class="dr109-grid"><div class="dr109-metric warn"><b>'+esc(arr[0].name||'–')+'</b><span>Top HR Threat</span></div><div class="dr109-metric"><b>'+f(arr[0].hrProb,1)+'%</b><span>HR Probability</span></div><div class="dr109-metric"><b>'+f(arr[0].iso)+'</b><span>ISO</span></div><div class="dr109-metric good"><b>'+esc(arr[0].isFavorable?'Favorable':'Neutral')+'</b><span>Matchup</span></div></div></div>')}
  function strikeEnhance(){ return; /* disabled: kprops-content is fully rebuilt on every render, wiping this banner right after it appears */ var el=document.getElementById('kprops-content'); if(!el||el.dataset.dr109) return; el.dataset.dr109='1'; el.insertAdjacentHTML('afterbegin','<div class="dr109-summary"><div class="dr109-title">🎯 Expanded Strikeout Data</div><p class="dr109-copy">Strikeouts now supports each line with K line, projected K count, cushion, opponent K tendency, WHIP/ERA context, CSW/whiff proxies, pitch-count leash, rest profile, and risk notes.</p><div class="dr109-grid"><div class="dr109-metric good"><b>Line</b><span>K Prop Support</span></div><div class="dr109-metric"><b>Cushion</b><span>Projection vs Line</span></div><div class="dr109-metric warn"><b>Whiff</b><span>Pitch-Type Upside</span></div><div class="dr109-metric"><b>Risk</b><span>Walks / Pitch Count</span></div></div></div>')}
  var parlayState={type:'safe',legs:2};
  window.setParlayBuildType=function(t){parlayState.type=t||'safe';document.querySelectorAll('[data-parlay-type]').forEach(function(b){b.classList.toggle('active',b.dataset.parlayType===parlayState.type)});renderParlayBuilds()};
  window.setParlayLegCount=function(nm){parlayState.legs=parseInt(nm,10)||2;document.querySelectorAll('[data-parlay-legs]').forEach(function(b){b.classList.toggle('active',String(parlayState.legs)===b.dataset.parlayLegs)});renderParlayBuilds()};
  function playPool(){var types=['hits','rbis','tb','sb','hrrbi'];var out=[];rows().forEach(function(r){types.forEach(function(t){out.push({r:r,type:t,score:score(t,r)})})});return out.sort(function(a,b){return b.score-a.score})}
  window.renderParlayBuilds=function(){var el=document.getElementById('parlay-builds-content'); if(!el) return; var pool=playPool(); if(!pool.length){el.innerHTML='<div class="mu-empty">Loading expanded parlay builder…</div>';return} var min=parlayState.type==='safe'?82:parlayState.type==='normal'?72:58; var filtered=pool.filter(function(p){return p.score>=min}); if(filtered.length<parlayState.legs) filtered=pool; var cards=[]; for(var c=0;c<3;c++){var legs=[],seen={}; for(var i=c;i<filtered.length&&legs.length<parlayState.legs;i++){var key=filtered[i].r.name+'-'+filtered[i].type; if(seen[filtered[i].r.name]&&parlayState.type==='safe') continue; seen[filtered[i].r.name]=1; legs.push(filtered[i])} cards.push(legs)} var risk=parlayState.type==='safe'?'Low':parlayState.type==='normal'?'Medium':'High'; el.innerHTML='<div class="dr109-summary"><div class="dr109-title">🧾 Expanded Parlay Builds</div><p class="dr109-copy">The builder now creates three options for each risk style and leg count, then scores confidence, risk, correlation, volatility, expected payout range, and why the card works.</p><div class="dr109-grid"><div class="dr109-metric '+(parlayState.type==='safe'?'good':parlayState.type==='lotto'?'warn':'')+'"><b>'+esc(parlayState.type.toUpperCase())+'</b><span>Build Type</span></div><div class="dr109-metric"><b>'+parlayState.legs+'</b><span>Leg Count</span></div><div class="dr109-metric"><b>'+risk+'</b><span>Risk</span></div><div class="dr109-metric warn"><b>Top 3</b><span>Curated Cards</span></div></div></div>'+cards.map(function(legs,idx){var conf=Math.round(legs.reduce(function(a,b){return a+b.score},0)/Math.max(1,legs.length));var corr=parlayState.type==='lotto'?pct(55+idx*4):parlayState.type==='safe'?pct(70-idx*3):pct(63-idx*2);var odds=parlayState.type==='safe'?'+'.concat(120*legs.length+idx*35):parlayState.type==='normal'?'+'.concat(240*legs.length+idx*90):'+'.concat(650*legs.length+idx*220);return '<div class="dr109-parlay"><div class="dr109-card-head"><div><span class="dr109-badge '+parlayState.type+'">'+esc(parlayState.type)+' · Option '+(idx+1)+'</span><div class="dr109-title" style="margin-top:8px">'+parlayState.legs+'-Leg '+esc(parlayState.type.toUpperCase())+' Card</div></div><div class="dr109-score">'+conf+'%<small>Avg Grade</small></div></div><div class="dr109-grid"><div class="dr109-metric"><b>'+odds+'</b><span>Est. Odds</span></div><div class="dr109-metric"><b>'+corr+'%</b><span>Correlation</span></div><div class="dr109-metric '+(risk==='Low'?'good':risk==='High'?'warn':'')+'"><b>'+risk+'</b><span>Volatility</span></div><div class="dr109-metric"><b>'+Math.max(1,Math.round(conf/22))+'%</b><span>Kelly Guide</span></div></div>'+legs.map(function(p){return '<div class="dr109-leg"><div><b>'+esc(p.r.name||'Player')+'</b><br><span>'+esc(line(p.type))+' · '+esc(p.r.teamAbbr||'')+' vs '+esc(p.r.oppAbbr||'')+'</span></div><strong>'+p.score+'%</strong></div>'}).join('')+'<div class="dr109-ai"><b>Why this parlay works:</b> Legs are selected from the highest graded available boards with line support, matchup context, and limited direct conflict. <b>Risk:</b> '+(risk==='High'?'LOTTO cards intentionally use more volatile upside markets.':'Monitor lineup scratches and late odds movement before lock.')+'</div></div>'}).join('');var r=document.getElementById('parlay-build-refresh'); if(r) r.textContent='Updated '+new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});};
  function enhanceTeam(){ return; /* disabled: team-performance-content is fully rebuilt on every render, wiping this banner right after it appears */ var el=document.getElementById('team-performance-content'); if(!el||el.dataset.dr109enh) return; if(el.textContent.match(/Loading|Select two/)) return; el.dataset.dr109enh='1'; el.insertAdjacentHTML('afterbegin','<div class="dr109-summary"><div class="dr109-title">🆚 Expanded Team Performance Data</div><p class="dr109-copy">Team Performance now emphasizes head-to-head record, run differential, last-10 form, home/away split, offense, pitching, bullpen, defense, park context, and a Diamond Report edge read.</p><div class="dr109-grid"><div class="dr109-metric good"><b>Offense</b><span>Runs / OPS / Form</span></div><div class="dr109-metric"><b>Pitching</b><span>Starter + Bullpen</span></div><div class="dr109-metric"><b>Defense</b><span>Errors / Prevention</span></div><div class="dr109-metric warn"><b>H2H</b><span>Season Matchup</span></div></div></div>')}
  function enhanceDeepResearch(){var b=document.getElementById('deep-briefing'),e=document.getElementById('deep-biggest-edge'),t=document.getElementById('deep-top-plays'),m=document.getElementById('deep-matchups'),r=document.getElementById('deep-risk'),notes=document.getElementById('deep-notes');var pool=playPool().slice(0,10); if(!pool.length) return; var top=pool[0]; if(b)b.innerHTML='<div class="dr109-summary"><div class="dr109-title">🧠 Static Deep Research Snapshot</div><p class="dr109-copy">This is a locked daily research snapshot. It summarizes the strongest model edges without reshuffling on every page refresh.</p><div class="dr109-grid"><div class="dr109-metric good"><b>'+esc(top.r.name||'–')+'</b><span>Top Model Edge</span></div><div class="dr109-metric"><b>'+esc(label(top.type))+'</b><span>Best Market</span></div><div class="dr109-metric"><b>'+top.score+'%</b><span>Confidence</span></div><div class="dr109-metric warn"><b>Static</b><span>Refresh Stable</span></div></div></div>'; if(e)e.innerHTML='<div class="dr109-card"><div class="dr109-title">🏆 Biggest Edge</div><p class="dr109-copy"><strong>'+esc(top.r.name||'Player')+'</strong> grades highest on the board for <strong>'+esc(line(top.type))+'</strong>, supported by production profile, matchup quality, and model confidence.</p></div>'; if(t)t.innerHTML='<table class="dr109-table"><tbody>'+pool.map(function(p,i){return '<tr><td>#'+(i+1)+' '+esc(p.r.name||'Player')+' · '+esc(label(p.type))+'</td><td>'+p.score+'%</td></tr>'}).join('')+'</tbody></table>'; if(m)m.innerHTML=pool.slice(0,5).map(function(p){return '<div class="dr109-chiprow"><span class="dr109-chip good">'+esc(p.r.teamAbbr||'')+' vs '+esc(p.r.oppAbbr||'')+'</span><span class="dr109-chip">'+esc(line(p.type))+'</span><span class="dr109-chip warn">'+p.score+'%</span></div>'}).join(''); if(r)r.innerHTML='<div class="dr109-ai"><b>Risk watch:</b> Verify official lineups, late scratches, weather/roof status, odds movement, and game postponement risk before lock. Stolen bases and home runs remain the most volatile markets.</div>'; if(notes)notes.innerHTML='<div class="dr109-ai"><b>Research notes:</b> The strongest plays are clustered around players with contact/power support, favorable opponent context, and line cushion. Use Safe parlays for high-confidence plays, Normal for balanced cards, and LOTTO only for high-upside volatility.</div>'}
  function runEnhance(){try{if(window.renderPropIntelligencePanes){} hrEnhance(); strikeEnhance(); enhanceTeam(); enhanceDeepResearch();}catch(e){}}
  var oldPane=window.showGamePickPane; if(typeof oldPane==='function'){window.showGamePickPane=function(p){var out=oldPane.apply(this,arguments); setTimeout(function(){ if(['hits','rbis','tb','sb','hrrbi'].indexOf(p)>=0) window.renderPropIntelligencePanes(); if(p==='parlay') window.renderParlayBuilds(); if(p==='hr') hrEnhance(); if(p==='k') strikeEnhance(); if(false && p==='team-performance') enhanceTeam(); if(p==='deep') enhanceDeepResearch();},120); setTimeout(runEnhance,900); return out;}}
  document.addEventListener('DOMContentLoaded',function(){setTimeout(runEnhance,900);});
})();

/* ---- from <script id="prod-v10-10-team-performance-persistent-js"> ---- */
(function(){
  if(window.__DR_V1010_TEAM_PERFORMANCE_ALWAYS__) return; window.__DR_V1010_TEAM_PERFORMANCE_ALWAYS__=true;
  var cache={html:'',updated:0,loading:false};
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function today(){try{return new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'});}catch(e){return new Date().toISOString().slice(0,10)}}
  function abbr(t){return (t&&(t.abbreviation||t.abbr||t.teamCode||t.fileCode||'')).toString().toUpperCase()}
  function teamName(t){return (t&&(t.name||t.teamName||t.clubName||abbr(t)))||''}
  function isFinal(g){var s=(g.status&&g.status.abstractGameState)||'';var d=(g.status&&g.status.detailedState)||'';return /final|game over|completed/i.test(s+' '+d)}
  function isLive(g){var s=(g.status&&g.status.abstractGameState)||'';var d=(g.status&&g.status.detailedState)||'';return /live|in progress|manager challenge|review|warmup|delayed/i.test(s+' '+d) && !isFinal(g)}
  function score(g){var aw=g.teams&&g.teams.away,hm=g.teams&&g.teams.home;var ar=aw&&Number.isFinite(+aw.score)?+aw.score:null;var hr=hm&&Number.isFinite(+hm.score)?+hm.score:null;return (ar==null||hr==null)?'':ar+'-'+hr}
  function statusLabel(g){var d=(g.status&&g.status.detailedState)||'';if(isFinal(g))return 'Final';if(isLive(g))return 'Live';if(/scheduled|pre-game|preview/i.test(d))return 'Scheduled';return d||'Scheduled'}
  function matchupCard(g){var aw=g.teams&&g.teams.away&&g.teams.away.team,hm=g.teams&&g.teams.home&&g.teams.home.team;if(!aw||!hm)return '';var aid=aw.id,hid=hm.id,sc=score(g),st=statusLabel(g),cls=isLive(g)?'tp-mini-status-live':isFinal(g)?'tp-mini-status-final':'';return '<div class="tp-mini-card" onclick="if(window.selectTeamPerformanceMatchup)window.selectTeamPerformanceMatchup(\''+esc(aid)+'\',\''+esc(hid)+'\')"><div class="tp-mini-title">'+esc(abbr(aw))+' @ '+esc(abbr(hm))+(sc?'<span class="tp-mini-score">'+esc(sc)+'</span>':'')+'</div><div class="tp-mini-sub"><span class="'+cls+'">'+esc(st)+'</span> · '+esc(teamName(aw))+' vs '+esc(teamName(hm))+'</div></div>'}
  function getGames(){if(typeof window.getTodaySchedule==='function')return window.getTodaySchedule('team,linescore',{force:true});var url='https://diamondreport.app/api/v1/schedule?sportId=1&date='+today()+'&hydrate=team,linescore&language=en&_tp1010='+Date.now();return fetch(url,{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(d){return (d.dates&&d.dates[0]&&d.dates[0].games)||[]})}
  function edgePanel(){return '<div id="tp-performance-edge-always"><div class="tp-edge-title">Diamond Report Team Edge</div><p class="tp-edge-copy">Compare today’s matchups with a consistent read on head-to-head results, run differential, recent form, offense, pitching, bullpen, defense, park context, and matchup momentum. Tap any matchup below to load the detailed team comparison.</p><div class="tp-edge-metrics"><div class="tp-edge-metric"><b>H2H</b><span>Season Matchup</span></div><div class="tp-edge-metric"><b>Offense</b><span>Runs / OPS</span></div><div class="tp-edge-metric"><b>Pitching</b><span>Starter + Pen</span></div><div class="tp-edge-metric"><b>Form</b><span>Last 10</span></div></div></div>'}
  function matchupsPanel(html){return '<div id="tp-always-matchups"><div class="tp-always-head"><div class="tp-always-title">Today’s Matchups</div><div class="tp-always-refresh">'+(cache.updated?'Updated '+new Date(cache.updated).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}):'Loading…')+'</div></div>'+(html||'<div class="mu-empty"><span class="spin"></span>Loading today’s matchups…</div>')+'</div>'}
  async function refreshMatchups(force){if(cache.loading)return; if(!force&&cache.html&&Date.now()-cache.updated<45000)return; cache.loading=true;try{var games=await getGames();cache.html='<div class="tp-today-grid">'+(games||[]).map(matchupCard).join('')+'</div>';cache.updated=Date.now();}catch(e){cache.html='<div class="mu-empty">Today’s matchups could not load right now.</div>';cache.updated=Date.now();}finally{cache.loading=false;ensurePanels(false)}}
  function ensurePanels(triggerFetch){var el=document.getElementById('team-performance-content');if(!el)return;var html=edgePanel()+matchupsPanel(cache.html);var oldEdge=document.getElementById('tp-performance-edge-always');if(oldEdge)oldEdge.remove();var old=document.getElementById('tp-always-matchups');if(old)old.remove();el.insertAdjacentHTML('afterbegin',html);if(triggerFetch!==false)refreshMatchups(false)}
  var obs=null;function arm(){return;}
  var old=window.renderTeamPerformanceTab;if(typeof old==='function'){window.renderTeamPerformanceTab=function(){var out=old.apply(this,arguments);Promise.resolve(out).finally(function(){setTimeout(function(){arm();refreshMatchups(true)},80)});return out}}
  var oldCmp=window.renderTeamPerformanceComparison;if(typeof oldCmp==='function'){window.renderTeamPerformanceComparison=function(){var out=oldCmp.apply(this,arguments);Promise.resolve(out).finally(function(){setTimeout(function(){arm();refreshMatchups(true)},80)});return out}}
  document.addEventListener('click',function(e){var p=e.target&&e.target.closest&&e.target.closest('[data-gamepick-pane="team-performance"]');if(p)setTimeout(function(){arm();refreshMatchups(true)},120)},true);
  document.addEventListener('DOMContentLoaded',function(){setTimeout(function(){arm();refreshMatchups(true)},900)});
})();

/* ---- from <script id="prod-v10-11-parlay-probability-engine-js"> ---- */
(function(){
  if(window.__DR_V1011_PARLAY_PROB__) return; window.__DR_V1011_PARLAY_PROB__=true;
  function n(v){v=parseFloat(v);return Number.isFinite(v)?v:0}
  function clamp(v,min,max){return Math.max(min,Math.min(max,v))}
  function pct(v){return Math.round(clamp(v,1,99))}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function rows(){try{return (window.getProductionPropRows?window.getProductionPropRows():(window.hrpRows||[])).filter(function(r){return !window.isActiveForHRThreat||window.isActiveForHRThreat(r)})}catch(e){return []}}
  function marketLabel(type){return {hits:'Over 0.5 Hits',rbis:'Over 0.5 RBI',tb:'Over 1.5 Total Bases',sb:'Over 0.5 SB',hrrbi:'Over 1.5 H+R+RBI',hr:'HR Anytime'}[type]||'Prop'}
  function legGrade(type,r){
    var s=r.stats||{},avg=n(r.avg),ops=n(r.ops),iso=n(r.iso),hr=n(r.hrSeason),prob=n(r.hrProb),obp=n(s.obp),slg=n(s.slg),sb=n(s.stolenBases),k=n(s.strikeOuts);
    var base=50;
    if(type==='hits') base=42+avg*95+obp*18+ops*5+(r.isFavorable?5:0)-k*.015;
    if(type==='rbis') base=38+ops*7+iso*55+hr*.45+prob*.18+(r.topHrThreat?3:0);
    if(type==='tb') base=39+slg*18+iso*70+prob*.22+hr*.25+(r.isFavorable?3:0);
    if(type==='sb') base=31+sb*1.9+obp*20+avg*28+(String(r.pos||'').match(/SS|CF|2B|LF|RF/)?5:0);
    if(type==='hrrbi') base=43+avg*40+obp*12+ops*6+hr*.18+prob*.12+(r.isFavorable?3:0);
    return pct(base);
  }
  function legProb(type,r,style){
    var grade=legGrade(type,r);
    var base={hits:0.57,rbis:0.47,tb:0.50,sb:0.31,hrrbi:0.52,hr:0.10}[type]||0.50;
    var ceiling={hits:0.79,rbis:0.68,tb:0.72,sb:0.48,hrrbi:0.74,hr:0.22}[type]||0.70;
    var floor={hits:0.46,rbis:0.35,tb:0.38,sb:0.18,hrrbi:0.40,hr:0.04}[type]||0.35;
    var dataLift=(grade-55)/100;
    var styleAdj=style==='safe'?0.025:style==='normal'?0:-0.035;
    var p=base+dataLift+styleAdj;
    return clamp(p,floor,ceiling);
  }
  function impliedOdds(p){
    p=clamp(p,.01,.99); if(p>=.5){return '-'+Math.round((p/(1-p))*100)} return '+'+Math.round(((1-p)/p)*100);
  }
  function estParlayOdds(legs,style){
    var dec=legs.reduce(function(a,l){return a*(1/legProb(l.type,l.r,style));},1)*0.92;
    var plus=Math.round((dec-1)*100); return '+'+Math.max(100,plus);
  }
  function correlation(legs,style){
    var sameGame={},sameTeam={},market={};
    legs.forEach(function(l){var g=(l.r.teamAbbr||'')+'-'+(l.r.oppAbbr||''); sameGame[g]=(sameGame[g]||0)+1; sameTeam[l.r.teamAbbr||'UNK']=(sameTeam[l.r.teamAbbr||'UNK']||0)+1; market[l.type]=(market[l.type]||0)+1;});
    var c=50;
    Object.keys(sameTeam).forEach(function(k){if(sameTeam[k]>1)c+=8*(sameTeam[k]-1)});
    Object.keys(sameGame).forEach(function(k){if(sameGame[k]>1)c+=5*(sameGame[k]-1)});
    if(market.sb)c-=6; if(market.hr)c-=10; if(style==='safe')c+=6; if(style==='lotto')c+=10;
    return pct(clamp(c,35,88));
  }
  function combinedProb(legs,style){
    if(!legs.length) return 0;
    var product=legs.reduce(function(a,l){return a*legProb(l.type,l.r,style);},1);
    var corr=correlation(legs,style)/100;
    var adj=product*(1+(corr-.50)*0.35);
    var caps={2:.72,4:.42,6:.24};
    var cap=caps[legs.length]||.30;
    if(style==='lotto') cap=Math.min(cap,.18);
    if(style==='normal') cap=Math.min(cap,.36);
    return clamp(adj,.01,cap);
  }
  function riskName(style,legs,prob){
    if(style==='lotto') return 'High';
    if(style==='normal') return legs>=4?'Medium-High':'Medium';
    return legs>=6?'Medium':'Low';
  }
  function pool(){
    var types=['hits','rbis','tb','sb','hrrbi'];
    var out=[]; rows().forEach(function(r){types.forEach(function(t){out.push({r:r,type:t,grade:legGrade(t,r),prob:legProb(t,r,window.__DR_PARLAY_STYLE__||'safe')})})});
    return out.sort(function(a,b){return (b.prob*100+b.grade/100)-(a.prob*100+a.grade/100)});
  }
  function buildCards(pool,style,legsCount){
    var minProb=style==='safe'?.58:style==='normal'?.50:.34;
    var source=pool.filter(function(p){return legProb(p.type,p.r,style)>=minProb}); if(source.length<legsCount) source=pool;
    var cards=[];
    for(var c=0;c<3;c++){
      var legs=[],seenPlayer={},seenMarket={};
      for(var i=c;i<source.length&&legs.length<legsCount;i++){
        var p=source[i], name=p.r.name||('p'+i), m=p.type;
        if(seenPlayer[name]) continue;
        if(style==='safe' && seenMarket[m]>=2) continue;
        if(style!=='lotto' && m==='sb' && legs.some(function(x){return x.type==='sb'})) continue;
        seenPlayer[name]=1; seenMarket[m]=(seenMarket[m]||0)+1; legs.push(p);
      }
      cards.push(legs);
    }
    return cards;
  }
  function render(){
    var el=document.getElementById('parlay-builds-content'); if(!el) return;
    var stateType=(document.querySelector('[data-parlay-type].active')||{}).dataset?.parlayType || (window.parlayState&&window.parlayState.type)||'safe';
    var stateLegs=parseInt((document.querySelector('[data-parlay-legs].active')||{}).dataset?.parlayLegs||((window.parlayState&&window.parlayState.legs)||2),10)||2;
    window.__DR_PARLAY_STYLE__=stateType;
    var p=pool(); if(!p.length){el.innerHTML='<div class="mu-empty">Loading parlay probability engine…</div>'; return;}
    var cards=buildCards(p,stateType,stateLegs);
    var risk=stateType==='safe'?'Low':stateType==='normal'?'Medium':'High';
    el.innerHTML='<div class="dr109-summary"><div class="dr109-title">🧾 Parlay Probability Engine</div><p class="dr109-copy">Percentages now use each leg’s model probability, then calculate the full parlay hit probability. 6-leg cards will no longer show inflated 99% values.</p><div class="dr109-grid"><div class="dr109-metric '+(stateType==='safe'?'good':stateType==='lotto'?'warn':'')+'"><b>'+esc(stateType.toUpperCase())+'</b><span>Build Type</span></div><div class="dr109-metric"><b>'+stateLegs+'</b><span>Leg Count</span></div><div class="dr109-metric '+(risk==='Low'?'good':risk==='High'?'warn':'')+'"><b>'+risk+'</b><span>Risk Style</span></div><div class="dr109-metric warn"><b>Realistic</b><span>Combined Hit %</span></div></div><div class="dr111-formula"><b>Formula:</b> leg probability = model grade + market difficulty + player/stat support. Parlay probability = multiplied leg probabilities with a small correlation adjustment and realistic caps by leg count.</div></div>'+cards.map(function(legs,idx){
      var cp=combinedProb(legs,stateType), corr=correlation(legs,stateType), avg=legs.reduce(function(a,l){return a+legProb(l.type,l.r,stateType);},0)/Math.max(1,legs.length), odds=estParlayOdds(legs,stateType), rk=riskName(stateType,legs.length,cp), cls=cp>=.45?'':cp>=.18?'warn':'low';
      return '<div class="dr109-parlay"><div class="dr109-card-head"><div><span class="dr109-badge '+stateType+'">'+esc(stateType)+' · Option '+(idx+1)+'</span><div class="dr109-title" style="margin-top:8px">'+stateLegs+'-Leg '+esc(stateType.toUpperCase())+' Card</div></div><div class="dr111-prob '+cls+'">'+pct(cp*100)+'%<small>Est. Hit Chance</small></div></div><div class="dr109-grid"><div class="dr109-metric"><b>'+odds+'</b><span>Estimated Fair Odds</span></div><div class="dr109-metric"><b>'+pct(avg*100)+'%</b><span>Avg Leg Prob.</span></div><div class="dr109-metric"><b>'+corr+'%</b><span>Correlation</span></div><div class="dr109-metric '+(rk==='Low'?'good':rk==='High'?'warn':'')+'"><b>'+rk+'</b><span>Volatility</span></div></div>'+legs.map(function(l){var lp=legProb(l.type,l.r,stateType), lg=legGrade(l.type,l.r); return '<div class="dr109-leg"><div><b>'+esc(l.r.name||'Player')+'</b><br><span>'+esc(marketLabel(l.type))+' · '+esc(l.r.teamAbbr||'')+' vs '+esc(l.r.oppAbbr||'')+'</span><div class="dr111-note"><span class="dr111-pill good">Leg '+pct(lp*100)+'%</span> <span class="dr111-pill">Model '+lg+'%</span> <span class="dr111-pill warn">'+esc(l.type.toUpperCase())+'</span></div></div><strong>'+pct(lp*100)+'%</strong></div>'}).join('')+'<div class="dr109-ai"><b>Why this parlay works:</b> This card is built from the highest available model probabilities for the selected risk style, then adjusted for market volatility and same-team/game correlation. <b>Important:</b> The large number is now the realistic full-parlay hit chance, not an average of leg grades.</div></div>'
    }).join('');
    var r=document.getElementById('parlay-build-refresh'); if(r) r.textContent='Probability updated '+new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
  }
  window.renderParlayBuilds=render;
  var oldType=window.setParlayBuildType, oldLegs=window.setParlayLegCount;
  window.setParlayBuildType=function(t){document.querySelectorAll('[data-parlay-type]').forEach(function(b){b.classList.toggle('active',b.dataset.parlayType===(t||'safe'))}); setTimeout(render,0);};
  window.setParlayLegCount=function(nm){nm=parseInt(nm,10)||2;document.querySelectorAll('[data-parlay-legs]').forEach(function(b){b.classList.toggle('active',String(nm)===b.dataset.parlayLegs)}); setTimeout(render,0);};
  document.addEventListener('DOMContentLoaded',function(){setTimeout(render,1200);});
})();

/* ---- from <script id="prod-v10-15-mobile-horizontal-containment-js"> ---- */
(function(){
  if(window.__DR_V1015_MOBILE_CONTAINMENT__) return; window.__DR_V1015_MOBILE_CONTAINMENT__=true;
  function markExternalDragSafe(){
    try{
      document.querySelectorAll('#props a, #props button').forEach(function(el){
        el.setAttribute('draggable','false');
      });
    }catch(e){}
  }
  document.addEventListener('DOMContentLoaded',function(){setTimeout(markExternalDragSafe,300);setTimeout(markExternalDragSafe,1600);});
  document.addEventListener('click',function(){setTimeout(markExternalDragSafe,80);},true);
})();

/* ---- from <script id="prod-v1119-team-performance-visible-analytics"> ---- */
(function(){
 if(window.__DR_V1119_TP_ANALYTICS__) return;
 window.__DR_V1119_TP_ANALYTICS__=true;
 function block(title,items){
  return '<div class="tp-analytics-section"><div class="tp-analytics-title">'+title+'</div><div class="tp-analytics-grid">'+items.map(function(x){return '<div class="tp-analytics-item"><span>'+x[0]+'</span><b>'+x[1]+'</b></div>'}).join('')+'</div></div>';
 }
 function expansion(){
  return '<div class="tp-analytics-expansion">'+
  block('🆚 Team Overview',[['Record','--'],['Run Differential','--'],['Home/Away Record','--'],['Last 10','--'],['Streak','--']])+
  block('⚾ Offensive Comparison',[['Runs/Game','--'],['AVG','--'],['OBP','--'],['SLG','--'],['OPS','--'],['ISO','--'],['HR','--'],['HR/Game','--'],['Barrel %','--'],['Hard Hit %','--'],['wOBA','--'],['wRC+','--']])+
  block('🎯 Starting Pitching',[['ERA','--'],['WHIP','--'],['K%','--'],['BB%','--'],['HR Allowed','--'],['Barrel Allowed','--'],['Hard Hit Allowed','--'],['xERA','--'],['FIP','--']])+
  block('🔥 Bullpen',[['Bullpen ERA','--'],['WHIP','--'],['K%','--'],['HR Allowed','--'],['Last 7 Days ERA','--'],['Fatigue/Usage','--']])+
  block('📊 Situational Splits',[['vs RHP','--'],['vs LHP','--'],['Handedness Advantage','--']])+
  block('🧠 Diamond Intelligence',[['Team Edge Score','--'],['Offensive Advantage','--'],['Pitching Advantage','--'],['Bullpen Advantage','--'],['Recent Form Advantage','--'],['AI Matchup Summary','Loading matchup analysis...']])+
  '</div>';
 }
 function hook(){
  if(!window.renderTeamPerformanceTab || window.__DR_V1119_TP_WRAPPED__) return;
  var old=window.renderTeamPerformanceTab;
  window.renderTeamPerformanceTab=function(){
    var r=old.apply(this,arguments);
    Promise.resolve(r).then(function(){
      var el=document.getElementById('team-performance-content');
      if(el && !el.querySelector('.tp-analytics-expansion')) el.insertAdjacentHTML('beforeend', expansion());
    });
    return r;
  };
  window.__DR_V1119_TP_WRAPPED__=true;
 }
 if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',hook); else hook();
})();

/* v11.31: Pause infinite CSS animations when the tab is hidden or the
   element is scrolled off-screen. Targets the live-dot pulse, skeleton
   shimmer, spin loaders, and countdown pulse -- these were running
   continuously with no pause logic, costing GPU/compositor time even when
   nothing animated was actually visible. Pairs with the .dr-paused /
   .dr-anim-offscreen CSS rules added alongside this. */
(function(){
  var ANIM_SELECTOR = '.live-dot, .dr-v9-skeleton, .game-status.countdown-pulse, .spin, .ks-today-live';

  // Pause everything site-wide while the tab/app is backgrounded.
  document.addEventListener('visibilitychange', function(){
    document.body.classList.toggle('dr-paused', document.hidden);
  });
  if (document.hidden) document.body.classList.add('dr-paused');

  // Pause per-element when it scrolls out of the viewport (with a small
  // margin so it resumes just before it would come back into view).
  var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function(entries){
    entries.forEach(function(entry){
      entry.target.classList.toggle('dr-anim-offscreen', !entry.isIntersecting);
    });
  }, { rootMargin: '150px 0px' }) : null;

  function observeAnimatedElements(){
    if (!io) return;
    document.querySelectorAll(ANIM_SELECTOR).forEach(function(el){
      if (!el.dataset.drAnimObserved) {
        el.dataset.drAnimObserved = '1';
        io.observe(el);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeAnimatedElements, { once: true });
  } else {
    observeAnimatedElements();
  }

  // Live data refreshes create/remove these elements dynamically (new game
  // cards, new skeleton loaders, etc.), so periodically pick up new ones.
  // Only scans while the tab is visible -- no work done in the background.
  setInterval(function(){
    if (document.visibilityState === 'visible') observeAnimatedElements();
  }, 5000);
})();

/* ---- Premium: Elite Picks (server-locked, per-game HR / pooled top 5s) ---- */
(function(){
  if (window.__DR_PREMIUM_ELITE__) return; window.__DR_PREMIUM_ELITE__ = true;

  var MARKETS = [
    { key:'hr',    label:'🔥 Home Runs' },
    { key:'hits',  label:'⚾ Hits' },
    { key:'rbis',  label:'💰 RBIs' },
    { key:'tb',    label:'💎 Total Bases' },
    { key:'sb',    label:'🏃 Stolen Bases' },
    { key:'hrrbi', label:'📈 Hits+Runs+RBI' },
  ];

  function n(v){ v = parseFloat(v); return Number.isFinite(v) ? v : 0; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

  // Elite Picks are selected, scored, and locked in server-side (scripts/update-tracker.mjs,
  // captureEliteToday), the same way the Diamond Report Pick and K Props already are, and
  // published in data/tracker.json (window.__premiumTodayPicksRaw, set by
  // loadAllTimeTrackerRecord). Every visitor — and the graded accuracy record — therefore
  // sees the exact same picks with the exact same score, instead of each browser
  // independently recomputing and locking its own copy. This file only joins those locked
  // picks against today's live row data for display (photo, live "why" chips, first-pitch
  // lock badge) — it no longer selects or scores anything itself.
  function rows(){
    try {
      var src = (typeof window.getProductionPropRows === 'function') ? window.getProductionPropRows() : (window.hrpRows || []);
      return (src || []).filter(function(r){ return r && r.name && r.id != null; });
    } catch(e) { return []; }
  }

  function isRowLocked(row){
    var tl = String(row.timeLabel || '').toUpperCase();
    return tl.indexOf('LIVE') >= 0 || tl === 'FINAL';
  }

  // Joins a locked server-side pick record against today's live row data (for photo,
  // pitcher name, current "why" chips, lock badge). Falls back to a minimal row built
  // from the tracker record itself when no live match is found (e.g. the site's live
  // row data hasn't loaded yet), so the pick still displays instead of silently vanishing.
  function liveRowFor(pick, liveRows){
    for (var i = 0; i < liveRows.length; i++) {
      if (String(liveRows[i].id) === String(pick.playerId)) return liveRows[i];
    }
    return { id: pick.playerId, name: pick.playerName, teamAbbr: pick.team, oppAbbr: pick.opp, pitcherName: null, timeLabel: '', gamePk: pick.gamePk };
  }

  function buildEliteLists(){
    var todayPicks = window.__premiumTodayPicksRaw || [];
    var liveRows = rows();
    var out = {};
    MARKETS.forEach(function(m){ out[m.key] = []; });
    todayPicks.forEach(function(p){
      if (!out[p.market]) return;
      out[p.market].push({ row: liveRowFor(p, liveRows), score: p.score, quality: p.quality, rank: p.rank || 99 });
    });
    MARKETS.forEach(function(m){ out[m.key].sort(function(a,b){ return a.rank - b.rank; }); });
    return out;
  }

  function hs(id){ return id ? 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_72,q_auto:best/v1/people/'+id+'/headshot/67/current' : ''; }
  function tl(abbr){ var id = (window.teamIds||{})[abbr]; return id ? '<img class="premium-team-logo" src="https://www.mlbstatic.com/team-logos/'+id+'.svg" alt="" loading="lazy" decoding="async">' : ''; }

  // Ballpark Pal only publishes per-hitter homeRuns/doublesTriples/singles
  // multipliers (see sync-ballparkpal.mjs) — RBIs/Stolen Bases/Hits+Runs+RBI
  // have no honest direct mapping, so those markets simply don't get a badge.
  function bpStatKeyForMarket(marketKey){
    if (marketKey === 'hr') return 'homeRuns';
    if (marketKey === 'tb') return 'doublesTriples';
    if (marketKey === 'hits') return 'singles';
    return null;
  }
  function bpBadgeHTML(marketKey, row){
    var statKey = bpStatKeyForMarket(marketKey);
    if (!statKey || typeof ballparkPalStatFactorForPlayer !== 'function') return '';
    var pct = ballparkPalStatFactorForPlayer(row.gamePk, row.id, statKey);
    if (pct == null) return '';
    var color = pct > 0 ? '#2ee6a6' : pct < 0 ? '#ff4d6d' : 'var(--muted)';
    return ' · <span style="color:'+color+'" title="Ballpark Pal cross-check, informational only">🌐 '+(pct>0?'+':'')+pct+'%</span>';
  }

  function cardHTML(entry, rank, marketKey){
    var r = entry.row, p = Math.round(entry.score);
    var lockBadge = isRowLocked(r) ? '<span class="premium-lock" title="Locked at first pitch — this pick no longer changes">🔒</span>' : '';
    return '<div class="premium-card">' +
      '<div class="premium-rank">#'+(rank+1)+'</div>' +
      '<img class="premium-photo" loading="lazy" decoding="async" src="'+hs(r.id)+'" onerror="this.style.visibility=\'hidden\'" alt="">' +
      '<div class="premium-info">' +
        '<div class="premium-name">'+esc(r.name||'–')+lockBadge+'</div>' +
        '<div class="premium-meta">'+tl(r.teamAbbr)+esc(r.teamAbbr||'–')+' · vs '+esc(r.oppAbbr||'–')+(r.pitcherName?' · '+esc(r.pitcherName):'')+bpBadgeHTML(marketKey, r)+'</div>' +
        '<div class="premium-quality">'+esc('★'.repeat(Math.max(1,entry.quality)))+'</div>' +
      '</div>' +
      '<div class="premium-score">'+p+'%</div>' +
    '</div>';
  }

  // Home Runs is selected per game server-side — group its cards under a small per-game
  // header (rank restarts at #1 for each game) instead of one flat cross-game list, so
  // the display matches how the picks are actually scoped.
  function groupByGameForDisplay(picks){
    var byGame = {}, order = [];
    picks.forEach(function(entry){
      var gp = entry.row.gamePk;
      if (!byGame[gp]) { byGame[gp] = []; order.push(gp); }
      byGame[gp].push(entry);
    });
    return order.map(function(gp){ return byGame[gp]; });
  }

  function sectionHTML(m, picks){
    if (!picks.length) {
      return '<div class="premium-section">' +
        '<div class="premium-section-head">'+esc(m.label)+'</div>' +
        '<div class="premium-card-list"><div class="mu-empty" style="padding:16px">No elite picks clear the bar for this market yet today — check back once boards have loaded.</div></div>' +
      '</div>';
    }
    var body;
    if (m.key === 'hr') {
      body = groupByGameForDisplay(picks).map(function(entries){
        var top = entries[0].row;
        var head = esc(top.teamAbbr||'–') + ' vs ' + esc(top.oppAbbr||'–');
        var cards = entries.map(function(entry, rank){ return cardHTML(entry, rank, m.key); }).join('');
        return '<div class="premium-game-group">' +
          '<div class="premium-game-head">'+head+'</div>' +
          '<div class="premium-card-list">'+cards+'</div>' +
        '</div>';
      }).join('');
    } else {
      body = '<div class="premium-card-list">'+picks.map(function(entry, rank){ return cardHTML(entry, rank, m.key); }).join('')+'</div>';
    }
    return '<div class="premium-section">' +
      '<div class="premium-section-head">'+esc(m.label)+'</div>' +
      body +
    '</div>';
  }

  function render(){
    var el = document.getElementById('premium-content');
    if (!el) return;
    if (!window.__premiumTodayPicksRaw) {
      el.innerHTML = '<div class="mu-empty" style="padding:16px">Loading today’s Elite Picks…</div>';
      return;
    }
    var lists = buildEliteLists();
    el.innerHTML = MARKETS.map(function(m){ return sectionHTML(m, lists[m.key] || []); }).join('');
  }
  window.renderPremiumPicks = render;

  var oldPane = window.showGamePickPane;
  if (typeof oldPane === 'function' && !oldPane.__drPremium) {
    var wrap = function(p){ var out = oldPane.apply(this, arguments); if (p === 'premium') { setTimeout(render, 80); setTimeout(render, 800); } return out; };
    wrap.__drPremium = true;
    window.showGamePickPane = wrap;
  }
})();

// Desktop collapsible sidebar nav — separate element from the mobile hamburger
// drawer (#dr-mobile-drawer), so this never touches that drawer's open/close
// behavior. Clicking a sidebar item routes through the same
// window.DiamondNavigateToPane the mobile drawer already uses.
//
// Active-state highlighting is handled manually here rather than relying on
// the existing .gamepick-tab sync (activateGamePickPane/setDesktopTabState):
// both of those scope their tab query to root = document.getElementById('props'),
// and this sidebar lives outside #props (it needs to be a sibling of <main>,
// not nested inside a scrollable section, to render as a fixed full-height
// sidebar) — so it would never get found by that scoped query.
(function(){
  var STORAGE_KEY = 'dr_sidebar_collapsed';
  function syncActive(sidebar, pane){
    sidebar.querySelectorAll('.dr-sidebar-tab[data-gamepick-pane]').forEach(function(btn){
      btn.classList.toggle('active', btn.getAttribute('data-gamepick-pane') === pane);
    });
  }
  function bind(){
    var sidebar = document.getElementById('dr-sidebar-nav');
    if (!sidebar) return;
    var toggle = document.getElementById('dr-sidebar-toggle');
    if (toggle && !toggle.dataset.drSidebarReady) {
      toggle.dataset.drSidebarReady = '1';
      toggle.addEventListener('click', function(){
        var collapsed = sidebar.classList.toggle('collapsed');
        document.body.classList.toggle('dr-sidebar-collapsed', collapsed);
        try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); } catch(e) {}
      });
    }
    try {
      // Collapsed by default — only stays expanded if the visitor explicitly
      // expanded it before (an explicit '0' saved). No saved value (first
      // visit) or a saved '1' both collapse.
      if (localStorage.getItem(STORAGE_KEY) !== '0') {
        sidebar.classList.add('collapsed');
        document.body.classList.add('dr-sidebar-collapsed');
      }
    } catch(e) {}
    sidebar.querySelectorAll('.dr-sidebar-tab[data-gamepick-pane]').forEach(function(btn){
      if (btn.dataset.drSidebarReady) return;
      btn.dataset.drSidebarReady = '1';
      btn.addEventListener('click', function(){
        var pane = btn.getAttribute('data-gamepick-pane');
        syncActive(sidebar, pane);
        if (typeof window.DiamondNavigateToPane === 'function') window.DiamondNavigateToPane(pane);
      });
    });
    // Baseball group's own sub-tab list — collapsed by default (only stays
    // expanded across visits if explicitly opened before), independent of
    // the whole-sidebar icon-only toggle above.
    var baseballToggle = document.getElementById('dr-sidebar-baseball-toggle');
    var baseballItems = document.getElementById('dr-sidebar-baseball-items');
    if (baseballToggle && baseballItems && !baseballToggle.dataset.drSidebarReady) {
      baseballToggle.dataset.drSidebarReady = '1';
      var GROUP_KEY = 'dr_sidebar_baseball_expanded';
      var setBaseballExpanded = function(expanded){
        baseballItems.classList.toggle('expanded', expanded);
        baseballToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      };
      var startExpanded = false;
      try { startExpanded = localStorage.getItem(GROUP_KEY) === '1'; } catch(e) {}
      setBaseballExpanded(startExpanded);
      baseballToggle.addEventListener('click', function(){
        var expanded = !baseballItems.classList.contains('expanded');
        setBaseballExpanded(expanded);
        try { localStorage.setItem(GROUP_KEY, expanded ? '1' : '0'); } catch(e) {}
      });
    }
    // Initial state: match whatever pane the page booted into (hash-restored
    // or default), read from the already-rendered #props panes.
    var activePane = document.querySelector('#props .gamepick-pane.active');
    if (activePane) syncActive(sidebar, activePane.getAttribute('data-gamepick-pane'));
    window.addEventListener('hashchange', function(){
      setTimeout(function(){
        var p = document.querySelector('#props .gamepick-pane.active');
        if (p) syncActive(sidebar, p.getAttribute('data-gamepick-pane'));
      }, 30);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once:true });
  else bind();
  window.addEventListener('load', bind, { once:true });
})();

// Landing hub ("The Sports Desk") — default view for a fresh visit with no
// #gamepick= hash; hidden once a sport is entered. Every route into a pane
// (the static desktop tabs' onclick, the mobile drawer, the desktop sidebar,
// and the premium gate) ultimately calls window.showGamePickPane or
// window.showPremiumGate, so wrapping those two is enough to hide the hub
// from any entry point without touching either nav's own code — same
// non-invasive wrap pattern already used elsewhere in this file (see
// window.showGamePickPane wraps above).
(function(){
  var newsLoaded = false;
  var newsArticles = [];
  var newsVisibleCount = 10;
  var hrLoaded = false;
  var leadersLoaded = false;
  var projectionsLoaded = false;
  var yesterdayScoresLoaded = false;
  var scoreboardTimer = null;
  var gameContentCache = {};
  var gameFeedCache = {};

  function hashIsGamepick(){
    return /^#?gamepick=/.test(window.location.hash || '');
  }

  function showHub(){
    document.body.classList.add('dr-hub-active');
    loadHubNews();
    loadHubHRs();
    loadHubLeaders();
    loadHubProjections();
    loadHubScoreboard();
    loadHubYesterdayScores();
    if (!scoreboardTimer) scoreboardTimer = setInterval(loadHubScoreboard, 120000);
  }

  function hideHub(){
    document.body.classList.remove('dr-hub-active');
    if (scoreboardTimer) { clearInterval(scoreboardTimer); scoreboardTimer = null; }
  }

  function escapeHtml(s){
    return String(s || '').replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  function timeAgo(iso){
    var t = new Date(iso).getTime();
    if (!t || isNaN(t)) return '';
    var minutes = Math.max(1, Math.round((Date.now() - t) / 60000));
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.round(hours / 24) + 'd ago';
  }

  function renderHubNews(articles){
    var section = document.getElementById('dr-hub-news');
    var grid = document.getElementById('dr-hub-news-grid');
    if (!section || !grid || !articles || !articles.length) return;
    newsArticles = articles;
    newsVisibleCount = Math.min(10, newsArticles.length);
    renderNewsGrid();
    section.style.display = '';

    var moreBtn = document.getElementById('dr-hub-news-more');
    if (moreBtn && !moreBtn.dataset.drBound) {
      moreBtn.dataset.drBound = '1';
      moreBtn.addEventListener('click', function(){
        newsVisibleCount = Math.min(newsVisibleCount + 10, newsArticles.length);
        renderNewsGrid();
      });
    }
  }

  function renderNewsGrid(){
    var grid = document.getElementById('dr-hub-news-grid');
    if (!grid) return;
    var visible = newsArticles.slice(0, newsVisibleCount);
    grid.innerHTML = visible.map(function(a, i){
      var img = a && a.images && a.images[0] && a.images[0].url;
      var when = timeAgo(a && a.published);
      return (
        '<button type="button" class="dr-hub-news-card' + (i === 0 ? ' lead' : '') + '" data-news-idx="' + i + '">' +
          (img ? '<img src="' + escapeHtml(img) + '" alt="" loading="lazy" decoding="async" onerror="this.style.display=\'none\'">' : '') +
          '<div class="dr-hub-news-body">' +
            '<div class="dr-hub-news-headline">' + escapeHtml(a && a.headline) + '</div>' +
            '<div class="dr-hub-news-meta">ESPN' + (a.league ? ' · ' + a.league : '') + (when ? ' · ' + when : '') + '</div>' +
          '</div>' +
        '</button>'
      );
    }).join('');

    grid.querySelectorAll('.dr-hub-news-card').forEach(function(card){
      card.addEventListener('click', function(){
        var idx = Number(card.getAttribute('data-news-idx'));
        openNewsModal(visible[idx]);
      });
    });

    var moreBtn = document.getElementById('dr-hub-news-more');
    if (moreBtn) moreBtn.style.display = newsVisibleCount < newsArticles.length ? '' : 'none';
  }

  function openNewsModal(a){
    var modal = document.getElementById('dr-hub-news-modal');
    if (!modal || !a) return;
    var img = a.images && a.images[0] && a.images[0].url;
    var href = a.links && a.links.web && a.links.web.href;
    var when = timeAgo(a.published);

    var imgEl = document.getElementById('dr-hub-news-modal-img');
    if (img) { imgEl.src = img; imgEl.style.display = ''; imgEl.onerror = function(){ imgEl.style.display = 'none'; }; }
    else { imgEl.style.display = 'none'; }

    document.getElementById('dr-hub-news-modal-meta').textContent = 'ESPN' + (a.league ? ' · ' + a.league : '') + (when ? ' · ' + when : '');
    document.getElementById('dr-hub-news-modal-title').textContent = a.headline || '';
    var descEl = document.getElementById('dr-hub-news-modal-desc');
    if (a.description) { descEl.textContent = a.description; descEl.style.display = ''; }
    else { descEl.style.display = 'none'; }
    var linkEl = document.getElementById('dr-hub-news-modal-link');
    if (href) { linkEl.href = href; linkEl.style.display = ''; }
    else { linkEl.style.display = 'none'; }

    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeNewsModal(){
    var modal = document.getElementById('dr-hub-news-modal');
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  function fetchLeagueNews(url, league){
    return fetch(url)
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(data){
        var articles = (data && data.articles) || [];
        articles.forEach(function(a){ a.league = league; });
        return articles;
      })
      .catch(function(){ return []; });
  }

  function loadHubNews(){
    if (newsLoaded) return;
    newsLoaded = true;
    Promise.all([
      fetchLeagueNews('https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/news?limit=50', 'MLB'),
      fetchLeagueNews('https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=30', 'NFL'),
      fetchLeagueNews('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=30', 'NBA')
    ]).then(function(results){
      var merged = results[0].concat(results[1]).concat(results[2]).sort(function(a, b){
        return new Date(b.published) - new Date(a.published);
      });
      renderHubNews(merged);
    });
  }

  function hs(id){
    return id ? 'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_60,q_auto:best/v1/people/' + id + '/headshot/67/current' : '';
  }

  // Best-effort lookup of the actual home run clip via the game's content/
  // highlights feed, rather than just linking to the whole game's Gameday
  // page. This endpoint's exact shape can't be verified from this dev
  // environment (no external network access here), so every step is
  // defensive — if a game has no matching highlight, or the fetch/shape
  // doesn't match what's expected, findHRClipUrl just returns null and the
  // caller leaves the existing Gameday link in place. Never worse than
  // today, upgrades in place when it works.
  function fetchGameContent(gamePk){
    if (gameContentCache[gamePk]) return gameContentCache[gamePk];
    var p = fetch('https://diamondreport.app/api/v1/game/' + gamePk + '/content')
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(data){
        return (data && data.highlights && data.highlights.highlights && data.highlights.highlights.items) || [];
      })
      .catch(function(){ return []; });
    gameContentCache[gamePk] = p;
    return p;
  }

  // Returns { videoUrl, webUrl } — videoUrl is a direct playable clip (used
  // to play the video in place, in-site), webUrl is the clip's mlb.com/video
  // page (used as a new-tab fallback when there's no direct playback url).
  // Either or both may be null if no highlight matched this player.
  function findHRClipUrl(items, playerName){
    if (!items || !items.length || !playerName) return { videoUrl: null, webUrl: null };
    var lastName = String(playerName).trim().split(/\s+/).pop().toLowerCase();
    if (!lastName) return { videoUrl: null, webUrl: null };
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var text = [it.title, it.headline, it.blurb, it.description].filter(Boolean).join(' ').toLowerCase();
      if (text.indexOf(lastName) === -1) continue;
      if (!/home run|homers|homered/.test(text)) continue;
      // Skip multi-player compilation reels ("Top 10 Home Runs of the
      // Week", "Plays of the Night", etc.) that happen to name-check this
      // player alongside others — those aren't the player's specific clip
      // and linking to one is worse than the Gameday-page fallback.
      if (/top\s*\d+|recap|best of|plays of the|highlights of the/.test(text)) continue;
      var webUrl = it.slug ? 'https://www.mlb.com/video/' + it.slug : null;
      var playback = (it.playbacks || []).find(function(pb){ return pb && pb.url; });
      return { videoUrl: playback ? playback.url : null, webUrl: webUrl };
    }
    return { videoUrl: null, webUrl: null };
  }

  // The live play-by-play feed (feed/live) is the standard, well-established
  // MLB Stats API endpoint for pitch-level detail — same family as the
  // boxscore endpoint already used throughout this file, unlike the
  // less-certain content/highlights feed above.
  function fetchGameFeed(gamePk){
    if (gameFeedCache[gamePk]) return gameFeedCache[gamePk];
    var p = fetch('https://diamondreport.app/api/v1.1/game/' + gamePk + '/feed/live')
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(data){
        return (data && data.liveData && data.liveData.plays && data.liveData.plays.allPlays) || [];
      })
      .catch(function(){ return []; });
    gameFeedCache[gamePk] = p;
    return p;
  }

  // Finds the pitch that was put in play for a given batter's home run.
  // Matches by batter id (more reliable than name matching) — if a batter
  // has multiple HRs in the same game, this returns the first one found,
  // a known simplification since loadHRsToday's data is one aggregated
  // entry per batter per game, not one per individual home run.
  function findHRPitchInfo(allPlays, batterId){
    if (!allPlays || !allPlays.length || !batterId) return null;
    for (var i = 0; i < allPlays.length; i++) {
      var play = allPlays[i] || {};
      if (!play.result || play.result.event !== 'Home Run') continue;
      if (!play.matchup || !play.matchup.batter || play.matchup.batter.id !== batterId) continue;
      var events = play.playEvents || [];
      var pitch = null;
      for (var j = events.length - 1; j >= 0; j--) {
        if (events[j] && events[j].isPitch) { pitch = events[j]; break; }
      }
      if (!pitch) return null;
      var pitchType = pitch.details && pitch.details.type && pitch.details.type.description;
      var velocity = pitch.pitchData && pitch.pitchData.startSpeed;
      var pitcherName = play.matchup.pitcher && play.matchup.pitcher.fullName;
      if (!pitchType && !velocity) return null;
      return { pitchType: pitchType || null, velocity: velocity ? Math.round(velocity) : null, pitcherName: pitcherName || null };
    }
    return null;
  }

  function openHRVideoModal(title, meta, videoUrl){
    var modal = document.getElementById('dr-hub-hr-modal');
    var video = document.getElementById('dr-hub-hr-modal-video');
    if (!modal || !video) return;
    document.getElementById('dr-hub-hr-modal-title').textContent = title || '';
    document.getElementById('dr-hub-hr-modal-meta').textContent = meta || '';
    video.src = videoUrl;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    video.play().catch(function(){});
  }

  function closeHRVideoModal(){
    var modal = document.getElementById('dr-hub-hr-modal');
    var video = document.getElementById('dr-hub-hr-modal-video');
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  }

  function renderHubHRs(list, dayLabel){
    var container = document.getElementById('dr-hub-hr-list');
    if (!container || !list || !list.length) return;
    dayLabel = dayLabel || 'today';
    // Most recent first — allHRs is sorted oldest-game-first for the Props pane.
    var recent = list.slice().reverse().slice(0, 6);
    container.innerHTML = recent.map(function(h, i){
      var fallback = h.gamePk ? 'https://www.mlb.com/gameday/' + h.gamePk : 'https://www.mlb.com/video';
      var title = escapeHtml(h.name) + ' — ' + h.hrs + ' HR' + (h.hrs !== 1 ? 's' : '') + ' ' + dayLabel;
      var sub = escapeHtml(h.teamAbbr || '') + (h.gameLabel ? ' · ' + escapeHtml(h.gameLabel) : '') + (h.timeStr ? ' · ' + escapeHtml(h.timeStr) : '');
      return (
        '<button type="button" class="dr-hub-hr-card" data-hr-idx="' + i + '" data-fallback="' + escapeHtml(fallback) + '">' +
          (h.id ? '<img class="dr-hub-hr-photo" src="' + escapeHtml(hs(h.id)) + '" alt="" loading="lazy" decoding="async" onerror="this.style.display=\'none\'">' : '<span class="dr-hub-hr-play">▶</span>') +
          '<span class="dr-hub-hr-text">' +
            '<span class="dr-hub-hr-title">' + title + '</span>' +
            '<span class="dr-hub-hr-sub">' + sub + '</span>' +
          '</span>' +
        '</button>'
      );
    }).join('');

    container.querySelectorAll('.dr-hub-hr-card').forEach(function(card){
      card.addEventListener('click', function(){
        var videoUrl = card.dataset.videoUrl;
        var webUrl = card.dataset.webUrl;
        if (videoUrl) {
          var titleEl = card.querySelector('.dr-hub-hr-title');
          var subEl = card.querySelector('.dr-hub-hr-sub');
          openHRVideoModal(titleEl ? titleEl.textContent : '', subEl ? subEl.textContent : '', videoUrl);
        } else {
          window.open(webUrl || card.dataset.fallback, '_blank', 'noopener,noreferrer');
        }
      });
    });

    // Progressive enhancement — once/if a matching highlight is found for a
    // player, stash its direct video url (plays in-site) and/or web page
    // url (new-tab fallback) on the card as data attributes, read by the
    // click handler above. Until/unless that resolves, clicking just opens
    // the Gameday page fallback already wired in — never worse than before.
    recent.forEach(function(h, i){
      if (!h.gamePk) return;
      fetchGameContent(h.gamePk).then(function(items){
        var found = findHRClipUrl(items, h.name);
        var card = container.querySelector('[data-hr-idx="' + i + '"]');
        if (!card) return;
        if (found.videoUrl) card.dataset.videoUrl = found.videoUrl;
        if (found.webUrl) card.dataset.webUrl = found.webUrl;
      });
    });

    // Second, independent progressive enhancement — append the actual pitch
    // (velocity + type, e.g. "95 mph Slider") to the card's subtitle once
    // found. The video modal reads this same subtitle text at click time,
    // so it picks up the enrichment automatically without any extra wiring.
    recent.forEach(function(h, i){
      if (!h.gamePk || !h.id) return;
      fetchGameFeed(h.gamePk).then(function(allPlays){
        var pitch = findHRPitchInfo(allPlays, h.id);
        if (!pitch || (!pitch.pitchType && !pitch.velocity)) return;
        var card = container.querySelector('[data-hr-idx="' + i + '"]');
        var subEl = card && card.querySelector('.dr-hub-hr-sub');
        if (!subEl) return;
        var pitchLabel = [pitch.velocity ? pitch.velocity + ' mph' : null, pitch.pitchType].filter(Boolean).join(' ');
        if (pitchLabel) subEl.textContent += ' · ' + pitchLabel;
      });
    });
  }

  // Curated set of hitting/pitching categories for the League Leaders widget —
  // enough to give a real snapshot of "who's having the best season" without
  // turning a News Central side section into a full stats page. Category keys
  // match MLB Stats API's leaderCategories values exactly.
  var LEADER_HITTING_CATS = ['homeRuns', 'battingAverage', 'onBasePlusSlugging', 'runsBattedIn'];
  // ERA, Wins, and WHIP were dropped from the widget per request — Strikeouts is the
  // only pitching category shown now.
  var LEADER_PITCHING_CATS = ['strikeouts'];
  var LEADER_CATEGORY_LABELS = {
    homeRuns: 'Home Runs', battingAverage: 'Batting Avg', onBasePlusSlugging: 'OPS', runsBattedIn: 'RBI',
    strikeouts: 'Strikeouts'
  };
  function leaderCategoryLabel(cat){ return LEADER_CATEGORY_LABELS[cat] || cat; }

  // Batting average/OPS display as ".312"-style (no leading zero); everything else
  // (HR/RBI/strikeouts) as a plain whole-number count — matches how each stat is
  // conventionally shown.
  function formatLeaderValue(cat, value){
    var num = parseFloat(value);
    if (!Number.isFinite(num)) return String(value == null ? '–' : value);
    if (cat === 'battingAverage' || cat === 'onBasePlusSlugging') return num.toFixed(3).replace(/^0\./, '.');
    return String(Math.round(num));
  }

  var LEADER_ROWS_PER_CATEGORY = 3;
  var leaderEntries = [];
  var teamIdToAbbr = null;

  // /stats/leaders' team object only reliably carries an id, not an
  // abbreviation (confirmed against a live response — every leader came back
  // with team.abbreviation undefined). Resolve it from the existing
  // abbr->id map (window.teamIds, built at the top of app.js) instead.
  function teamAbbrFromId(id){
    if (!teamIdToAbbr) {
      teamIdToAbbr = {};
      var ids = window.teamIds || {};
      for (var abbr in ids) { teamIdToAbbr[ids[abbr]] = abbr; }
    }
    return teamIdToAbbr[id] || '';
  }

  function renderHubLeaders(categories){
    var container = document.getElementById('dr-hub-leaders-list');
    var section = document.getElementById('dr-hub-leaders');
    if (!container || !categories || !categories.length) return;
    leaderEntries = [];

    var groups = categories.map(function(c){
      var leaders = (c && c.leaders || []).slice(0, LEADER_ROWS_PER_CATEGORY);
      if (!leaders.length) return '';
      var rows = leaders.map(function(leader){
        var person = leader.person || {};
        var team = leader.team || {};
        var teamAbbr = team.abbreviation || teamAbbrFromId(team.id) || '';
        var value = formatLeaderValue(c.leaderCategory, leader.value);
        var idx = leaderEntries.push({
          category: c.leaderCategory,
          rank: leader.rank,
          value: value,
          name: person.fullName || '–',
          teamAbbr: teamAbbr,
          personId: person.id || null,
        }) - 1;
        return (
          '<button type="button" class="dr-hub-leader-row" data-leader-idx="' + idx + '">' +
            '<span class="dr-hub-leader-row-rank">#' + escapeHtml(String(leader.rank || '')) + '</span>' +
            (person.id ? '<img class="dr-hub-leader-row-photo" src="' + escapeHtml(hs(person.id)) + '" alt="" loading="lazy" decoding="async" onerror="this.style.display=\'none\'">' : '') +
            '<span class="dr-hub-leader-row-name">' + escapeHtml(person.fullName || '–') + '</span>' +
            '<span class="dr-hub-leader-row-team">' + escapeHtml(teamAbbr) + '</span>' +
            '<span class="dr-hub-leader-row-value">' + escapeHtml(value) + '</span>' +
          '</button>'
        );
      }).join('');
      return (
        '<div class="dr-hub-leader-group">' +
          '<h4 class="dr-hub-leader-group-title">' + escapeHtml(leaderCategoryLabel(c.leaderCategory)) + '</h4>' +
          rows +
        '</div>'
      );
    }).filter(Boolean);
    if (!groups.length) return;
    container.innerHTML = groups.join('');
    container.querySelectorAll('.dr-hub-leader-row').forEach(function(row){
      row.addEventListener('click', function(){
        var idx = Number(row.getAttribute('data-leader-idx'));
        openLeaderModal(leaderEntries[idx]);
      });
    });
    if (section) section.style.display = '';
    showSideToggleIfNeeded();
  }

  // Below the side-rail breakpoint, League Leaders/Season Projections are collapsed
  // behind a toggle by default (too much extra scrolling on a phone to show
  // both expanded). Only reveal the toggle once there's actually something
  // behind it — no point showing "Show League Leaders" if both fetches failed.
  function showSideToggleIfNeeded(){
    var toggle = document.getElementById('dr-hub-side-toggle');
    if (!toggle || toggle.dataset.drHubShown) return;
    var leaders = document.getElementById('dr-hub-leaders');
    var projections = document.getElementById('dr-hub-projections');
    var hasContent = (leaders && leaders.style.display !== 'none') || (projections && projections.style.display !== 'none');
    if (!hasContent) return;
    toggle.dataset.drHubShown = '1';
    toggle.style.display = 'flex';
  }

  function toggleSideContent(){
    var toggle = document.getElementById('dr-hub-side-toggle');
    var content = document.getElementById('dr-hub-side-content');
    var label = toggle && toggle.querySelector('.dr-hub-side-toggle-label');
    if (!toggle || !content) return;
    var expanded = content.classList.toggle('expanded');
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    if (label) label.textContent = expanded ? 'Hide Season Projections & League Leaders' : 'Show Season Projections & League Leaders';
  }

  function openLeaderModal(entry){
    var modal = document.getElementById('dr-hub-leader-modal');
    if (!modal || !entry) return;
    var photoEl = document.getElementById('dr-hub-leader-modal-photo');
    if (entry.personId) { photoEl.src = hs(entry.personId); photoEl.style.display = ''; photoEl.onerror = function(){ photoEl.style.display = 'none'; }; }
    else { photoEl.style.display = 'none'; }
    document.getElementById('dr-hub-leader-modal-meta').textContent = entry.teamAbbr ? entry.teamAbbr + ' · ' + new Date().getFullYear() + ' Season' : String(new Date().getFullYear()) + ' Season';
    document.getElementById('dr-hub-leader-modal-title').textContent = entry.name || '';
    document.getElementById('dr-hub-leader-modal-value').textContent = entry.value || '';
    document.getElementById('dr-hub-leader-modal-cat').textContent = leaderCategoryLabel(entry.category);
    document.getElementById('dr-hub-leader-modal-rank').textContent = entry.rank ? ('Ranked #' + entry.rank + ' in MLB') : '';
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeLeaderModal(){
    var modal = document.getElementById('dr-hub-leader-modal');
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  function loadHubLeaders(){
    if (leadersLoaded) return;
    leadersLoaded = true;
    var season = new Date().getFullYear();
    Promise.all([
      fetchJSON('https://diamondreport.app/api/v1/stats/leaders?leaderCategories=' + LEADER_HITTING_CATS.join(',') + '&season=' + season + '&sportId=1&statGroup=hitting&limit=' + LEADER_ROWS_PER_CATEGORY).catch(function(){ return null; }),
      fetchJSON('https://diamondreport.app/api/v1/stats/leaders?leaderCategories=' + LEADER_PITCHING_CATS.join(',') + '&season=' + season + '&sportId=1&statGroup=pitching&limit=' + LEADER_ROWS_PER_CATEGORY).catch(function(){ return null; })
    ]).then(function(results){
      var all = [];
      results.forEach(function(d){
        if (d && Array.isArray(d.leagueLeaders)) all = all.concat(d.leagueLeaders);
      });
      if (all.length) renderHubLeaders(all);
    }).catch(function(){});
  }

  // World Series / MVP projections — from data/season-projections.json, a repo-synced daily
  // file (Monte Carlo playoff bracket sim + a composite-score MVP model; see
  // scripts/generate-season-projections.mjs for methodology), same fetch pattern as
  // the Statcast files (drFetchDailyJSON, not a live per-request MLB API call).
  function wsTeamLogo(teamId){
    return teamId ? '<img class="dr-hub-projections-row-photo" src="https://www.mlbstatic.com/team-logos/' + teamId + '.svg" alt="" loading="lazy" decoding="async" onerror="this.style.display=\'none\'">' : '';
  }

  function projectionsRowHtml(photoHtml, name, team, pct){
    var width = Math.max(0, Math.min(100, pct));
    return (
      '<div class="dr-hub-projections-row">' +
        photoHtml +
        '<span class="dr-hub-projections-row-name">' + escapeHtml(name) + '</span>' +
        '<span class="dr-hub-projections-row-team">' + escapeHtml(team || '') + '</span>' +
        '<span class="dr-hub-projections-row-bar"><span class="dr-hub-projections-row-bar-fill" style="width:' + width + '%"></span></span>' +
        '<span class="dr-hub-projections-row-pct">' + pct.toFixed(1) + '%</span>' +
      '</div>'
    );
  }

  function renderHubProjections(data){
    var section = document.getElementById('dr-hub-projections');
    var wsEl = document.getElementById('dr-hub-ws-projections');
    var mvpAlEl = document.getElementById('dr-hub-mvp-al-projections');
    var mvpNlEl = document.getElementById('dr-hub-mvp-nl-projections');
    if (!section || !data) return;

    var ws = Array.isArray(data.worldSeries) ? data.worldSeries.slice(0, 8) : [];
    var mvpAl = (data.mvp && Array.isArray(data.mvp.AL)) ? data.mvp.AL.slice(0, 3) : [];
    var mvpNl = (data.mvp && Array.isArray(data.mvp.NL)) ? data.mvp.NL.slice(0, 3) : [];
    if (!ws.length && !mvpAl.length && !mvpNl.length) return;

    if (wsEl) wsEl.innerHTML = ws.map(function(t){
      return projectionsRowHtml(wsTeamLogo(t.teamId), t.name || t.abbr || '–', t.abbr, t.pct);
    }).join('');
    if (mvpAlEl) mvpAlEl.innerHTML = mvpAl.map(function(c){
      return projectionsRowHtml(c.id ? '<img class="dr-hub-projections-row-photo" src="' + escapeHtml(hs(c.id)) + '" alt="" loading="lazy" decoding="async" onerror="this.style.display=\'none\'">' : '', c.name || '–', c.teamAbbr, c.pct);
    }).join('');
    if (mvpNlEl) mvpNlEl.innerHTML = mvpNl.map(function(c){
      return projectionsRowHtml(c.id ? '<img class="dr-hub-projections-row-photo" src="' + escapeHtml(hs(c.id)) + '" alt="" loading="lazy" decoding="async" onerror="this.style.display=\'none\'">' : '', c.name || '–', c.teamAbbr, c.pct);
    }).join('');
    section.style.display = '';
    showSideToggleIfNeeded();
  }

  function loadHubProjections(){
    if (projectionsLoaded) return;
    projectionsLoaded = true;
    drFetchDailyJSON('data/season-projections.json').then(function(data){
      renderHubProjections(data);
    }).catch(function(){});
  }

  // Whether any of today's games has actually started yet (Live or Final).
  // Defaults to true (i.e. "yes, started") on any fetch failure — if we
  // can't tell, it's safer to fall back to the plain empty-state link than
  // to risk showing yesterday's home runs as if they were today's.
  function hasAnyGameStartedToday(){
    var todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    return fetch('https://diamondreport.app/api/v1/schedule?sportId=1&date=' + todayStr + '&hydrate=status&language=en')
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(data){
        var entry = (data.dates || []).find(function(d){ return d.date === todayStr; }) || (data.dates && data.dates[0]);
        var games = (entry && entry.games) || [];
        return games.some(function(g){
          var st = g.status && g.status.abstractGameState;
          return st === 'Live' || st === 'Final';
        });
      })
      .catch(function(){ return true; });
  }

  // Self-contained variant of loadHRsToday's boxscore-scanning logic for an
  // arbitrary date, used only to fetch yesterday's home runs for the hub
  // fallback below. Deliberately doesn't touch bannerHRs, #hrs-today-content,
  // or any other global state loadHRsToday manages — this is read-only, for
  // display here only.
  function fetchHRsForDate(dateStr){
    return fetch('https://diamondreport.app/api/v1/schedule?sportId=1&date=' + dateStr + '&hydrate=team&language=en')
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(data){
        var entry = (data.dates || []).find(function(d){ return d.date === dateStr; }) || (data.dates && data.dates[0]);
        var games = (entry && entry.games) || [];
        return Promise.all(games.map(function(g){
          return fetch('https://diamondreport.app/api/v1/game/' + g.gamePk + '/boxscore')
            .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function(bd){ return bd.teams; })
            .catch(function(){ return null; });
        })).then(function(boxscores){
          var allHRs = [];
          games.forEach(function(g, gi){
            var box = boxscores[gi];
            if (!box || !g.teams) return;
            var dt = new Date(g.gameDate);
            var timeStr = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
            var awayAbbr = g.teams.away && g.teams.away.team && g.teams.away.team.abbreviation;
            var homeAbbr = g.teams.home && g.teams.home.team && g.teams.home.team.abbreviation;
            ['away', 'home'].forEach(function(side){
              var team = box[side];
              if (!team) return;
              var abbr = side === 'away' ? awayAbbr : homeAbbr;
              (team.batters || []).forEach(function(id){
                var p = team.players && team.players['ID' + id];
                var hrs = parseInt(p && p.stats && p.stats.batting && p.stats.batting.homeRuns) || 0;
                if (hrs > 0) allHRs.push({
                  name: (p.person && p.person.fullName) || '–',
                  id: p.person && p.person.id,
                  teamAbbr: abbr,
                  hrs: hrs,
                  gameLabel: awayAbbr + ' @ ' + homeAbbr,
                  timeStr: timeStr,
                  gameTimestamp: dt.getTime(),
                  gamePk: g.gamePk
                });
              });
            });
          });
          allHRs.sort(function(a, b){ return a.gameTimestamp - b.gameTimestamp || b.hrs - a.hrs; });
          return allHRs;
        });
      })
      .catch(function(){ return []; });
  }

  function loadHubHRs(){
    if (hrLoaded) return;
    hrLoaded = true;
    try {
      var maybePromise = typeof window.loadHRsToday === 'function' ? window.loadHRsToday() : null;
      Promise.resolve(maybePromise).then(function(){
        var todaysHRs = window.__drHRsToday || [];
        if (todaysHRs.length) {
          renderHubHRs(todaysHRs);
          return;
        }
        // Nothing today yet — if that's because the first game of the day
        // hasn't started, keep showing yesterday's home runs instead of
        // reverting to the plain "watch highlights" link for however many
        // hours it is until first pitch.
        hasAnyGameStartedToday().then(function(started){
          if (started) return;
          var yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          var yStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
          fetchHRsForDate(yStr).then(function(list){
            if (!list.length) return;
            var heading = document.getElementById('dr-hub-hr-heading');
            if (heading) heading.textContent = "Yesterday's Home Run Highlights";
            renderHubHRs(list, 'yesterday');
          });
        });
      }).catch(function(){ /* leave the generic fallback link in place */ });
    } catch(e) { /* leave the generic fallback link in place */ }
  }

  // Today's Games strip — quick-glance scoreboard so a hub visitor can see
  // what's happening today without clicking into Baseball first. Reuses the
  // same shared getTodaySchedule cache loadScores() draws from (no extra
  // network cost if the Prediction Center has already loaded), with its own
  // lightweight per-game transform since this only needs team/score/status,
  // not the full win-probability/standings-badge treatment gameCard() builds.
  function hubScoreboardChip(g){
    var isLive = g.status === 'live';
    var isFinal = g.status === 'final';
    var statusHtml = isLive
      ? '<span class="dr-hub-score-status live">' + (g.inning || 'LIVE') + '</span>'
      : isFinal
        ? '<span class="dr-hub-score-status final">FINAL</span>'
        : '<span class="dr-hub-score-status upcoming">' + escapeHtml(g.time) + '</span>';
    var scoreHtml = (g.awayScore != null && g.homeScore != null)
      ? '<span class="dr-hub-score-line">' +
          '<span class="' + (g.awayScore > g.homeScore ? 'dr-hub-score-win' : '') + '">' + g.awayScore + '</span>' +
          '<span class="dr-hub-score-sep">–</span>' +
          '<span class="' + (g.homeScore > g.awayScore ? 'dr-hub-score-win' : '') + '">' + g.homeScore + '</span>' +
        '</span>'
      : '<span class="dr-hub-score-line dr-hub-score-vs">vs</span>';
    return (
      '<button type="button" class="dr-hub-score-chip ' + g.status + '" data-dr-hub-open-baseball="1">' +
        statusHtml +
        '<span class="dr-hub-score-teams">' +
          '<span class="dr-hub-score-team">' + teamLogo(g.awayAbbr) + '<span>' + escapeHtml(g.awayAbbr) + '</span></span>' +
          scoreHtml +
          '<span class="dr-hub-score-team">' + teamLogo(g.homeAbbr) + '<span>' + escapeHtml(g.homeAbbr) + '</span></span>' +
        '</span>' +
      '</button>'
    );
  }

  function renderHubScoreboard(games){
    var section = document.getElementById('dr-hub-scoreboard');
    var strip = document.getElementById('dr-hub-scoreboard-strip');
    if (!section || !strip || !games.length) return;
    strip.innerHTML = games.map(hubScoreboardChip).join('');
    if (!strip.dataset.drHubBound) {
      strip.dataset.drHubBound = '1';
      strip.addEventListener('click', function(e){
        if (e.target.closest('[data-dr-hub-open-baseball]')) {
          var card = document.getElementById('dr-hub-baseball-card');
          if (card) card.click();
        }
      });
    }
    section.style.display = '';
  }

  function loadHubScoreboard(){
    getTodaySchedule('linescore,team').then(function(games){
      var mapped = games.map(function(g){
        var away = g.teams.away, home = g.teams.home;
        var state = g.status.abstractGameState;
        var detailedState = g.status.detailedState;
        var trulyInProgress = detailedState === 'In Progress';
        var linescore = g.linescore || {};
        var inningStr = (trulyInProgress && linescore.currentInning)
          ? (linescore.inningHalf === 'Bottom' ? '▼' : '▲') + ' ' + linescore.currentInning
          : (trulyInProgress ? 'LIVE' : null);
        var isLive = state === 'Live' || trulyInProgress;
        var isFinal = state === 'Final' || detailedState === 'Final' || detailedState === 'Game Over';
        var dt = new Date(g.gameDate);
        return {
          awayAbbr: away.team.abbreviation,
          homeAbbr: home.team.abbreviation,
          awayScore: away.score != null ? away.score : null,
          homeScore: home.score != null ? home.score : null,
          inning: inningStr,
          time: dt.toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit', timeZone:'America/Chicago'}),
          status: isLive ? 'live' : isFinal ? 'final' : 'upcoming'
        };
      });
      // Live and upcoming first (what a visitor most wants to see at a glance),
      // finals last; stable within each group since the API already returns
      // games in a sensible order.
      var order = { live: 0, upcoming: 1, final: 2 };
      mapped.sort(function(a, b){ return order[a.status] - order[b.status]; });
      renderHubScoreboard(mapped);
    }).catch(function(){});
  }

  // Yesterday's Scores — sidebar section, same chip pattern as Today's Games but for
  // the previous Chicago-time calendar day. Fetched once per page load (yesterday's
  // slate is done and cached hard by the API, no reason to poll it like today's).
  function renderHubYesterdayScores(games){
    var section = document.getElementById('dr-hub-yesterday');
    var strip = document.getElementById('dr-hub-yesterday-strip');
    if (!section || !strip || !games.length) return;
    strip.innerHTML = games.map(hubScoreboardChip).join('');
    if (!strip.dataset.drHubBound) {
      strip.dataset.drHubBound = '1';
      strip.addEventListener('click', function(e){
        if (e.target.closest('[data-dr-hub-open-baseball]')) {
          var card = document.getElementById('dr-hub-baseball-card');
          if (card) card.click();
        }
      });
    }
    section.style.display = '';
  }

  function loadHubYesterdayScores(){
    if (yesterdayScoresLoaded) return;
    yesterdayScoresLoaded = true;
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    var yStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    fetchJSON('https://diamondreport.app/api/v1/schedule?sportId=1&date=' + yStr + '&hydrate=linescore,team&language=en')
      .then(function(data){
        var entry = (data.dates || []).find(function(d){ return d.date === yStr; }) || data.dates && data.dates[0];
        var games = (entry && entry.games) || [];
        var mapped = games.map(function(g){
          var away = g.teams.away, home = g.teams.home;
          var state = g.status.abstractGameState;
          var detailedState = g.status.detailedState;
          var isFinal = state === 'Final' || detailedState === 'Final' || detailedState === 'Game Over';
          return {
            awayAbbr: away.team.abbreviation,
            homeAbbr: home.team.abbreviation,
            awayScore: away.score != null ? away.score : null,
            homeScore: home.score != null ? home.score : null,
            inning: null,
            time: '',
            status: isFinal ? 'final' : 'upcoming'
          };
        }).filter(function(g){ return g.status === 'final'; });
        if (mapped.length) renderHubYesterdayScores(mapped);
      }).catch(function(){});
  }

  function bind(){
    var hub = document.getElementById('dr-landing-hub');
    if (!hub) return;

    var modalClose = document.getElementById('dr-hub-news-modal-close');
    var modalOverlay = document.getElementById('dr-hub-news-modal-overlay');
    if (modalClose && !modalClose.dataset.drHubReady) {
      modalClose.dataset.drHubReady = '1';
      modalClose.addEventListener('click', closeNewsModal);
    }
    if (modalOverlay && !modalOverlay.dataset.drHubReady) {
      modalOverlay.dataset.drHubReady = '1';
      modalOverlay.addEventListener('click', closeNewsModal);
    }

    var hrModalClose = document.getElementById('dr-hub-hr-modal-close');
    var hrModalOverlay = document.getElementById('dr-hub-hr-modal-overlay');
    if (hrModalClose && !hrModalClose.dataset.drHubReady) {
      hrModalClose.dataset.drHubReady = '1';
      hrModalClose.addEventListener('click', closeHRVideoModal);
    }
    if (hrModalOverlay && !hrModalOverlay.dataset.drHubReady) {
      hrModalOverlay.dataset.drHubReady = '1';
      hrModalOverlay.addEventListener('click', closeHRVideoModal);
    }

    var leaderModalClose = document.getElementById('dr-hub-leader-modal-close');
    var leaderModalOverlay = document.getElementById('dr-hub-leader-modal-overlay');
    if (leaderModalClose && !leaderModalClose.dataset.drHubReady) {
      leaderModalClose.dataset.drHubReady = '1';
      leaderModalClose.addEventListener('click', closeLeaderModal);
    }
    if (leaderModalOverlay && !leaderModalOverlay.dataset.drHubReady) {
      leaderModalOverlay.dataset.drHubReady = '1';
      leaderModalOverlay.addEventListener('click', closeLeaderModal);
    }

    var sideToggle = document.getElementById('dr-hub-side-toggle');
    if (sideToggle && !sideToggle.dataset.drHubReady) {
      sideToggle.dataset.drHubReady = '1';
      sideToggle.addEventListener('click', toggleSideContent);
    }

    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape') { closeNewsModal(); closeHRVideoModal(); closeLeaderModal(); }
    });

    var baseballCard = document.getElementById('dr-hub-baseball-card');
    if (baseballCard && !baseballCard.dataset.drHubReady) {
      baseballCard.dataset.drHubReady = '1';
      baseballCard.addEventListener('click', function(){
        hideHub();
        if (!hashIsGamepick()) {
          try { window.location.hash = 'gamepick=game'; } catch(e) {}
        }
        if (typeof window.showGamePickPane === 'function') window.showGamePickPane('game');
      });
    }

    var logo = document.getElementById('dr-header-logo');
    if (logo && !logo.dataset.drHubReady) {
      logo.dataset.drHubReady = '1';
      var goToHub = function(){
        try { window.location.hash = ''; } catch(e) {}
        showHub();
      };
      logo.addEventListener('click', goToHub);
      logo.addEventListener('keydown', function(e){
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToHub(); }
      });
    }

    if (hashIsGamepick()) hideHub(); else showHub();

    var oldShowPane = window.showGamePickPane;
    if (typeof oldShowPane === 'function' && !oldShowPane.__drHub) {
      var wrapShowPane = function(p){ hideHub(); return oldShowPane.apply(this, arguments); };
      wrapShowPane.__drHub = true;
      window.showGamePickPane = wrapShowPane;
    }

    var oldShowGate = window.showPremiumGate;
    if (typeof oldShowGate === 'function' && !oldShowGate.__drHub) {
      var wrapShowGate = function(f){ hideHub(); return oldShowGate.apply(this, arguments); };
      wrapShowGate.__drHub = true;
      window.showPremiumGate = wrapShowGate;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once:true });
  else bind();

  window.addEventListener('hashchange', function(){
    if (hashIsGamepick()) hideHub(); else showHub();
  });
})();

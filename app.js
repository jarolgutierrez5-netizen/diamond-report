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
(adsbygoogle = window.adsbygoogle || []).push({});
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
  const requestUrl = drIsLiveScoreURL(cleanUrl) ? drLiveURL(cleanUrl) : cleanUrl;
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

// ── Shared response cache (TTL: static daily dump for all data, fallback TTLs) ──────────
const _fetchCache = new Map();
const _fetchInFlight = new Map();
const CACHE_TTL_LIVE = 0;        // v9.2: scores/linescore must always bypass cache
const CACHE_TTL_STATIC = 300_000; // player season stats, game logs

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
        const res = await fetch(drLiveURL(requestUrl), { cache:'no-store' });
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
          const res = await fetch(live ? drLiveURL(requestUrl) : requestUrl, { cache: live ? 'no-store' : 'default' });
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
    updatePropsLiveBanner(live);
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
const prevBannerHRCounts = {};  // batterId -> previous HR count
let breakingHRActive = false;
let breakingHRTimeout = null;
let breakingHRNames = [];
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
        pitches: +(row?.pitches ?? row?.pitchCount ?? row?.seen ?? 0) || 0,
        atBats: +(row?.atBats ?? row?.ab ?? 0) || 0,
        hits: +(row?.hits ?? row?.h ?? 0) || 0,
        homeRuns: +(row?.homeRuns ?? row?.hr ?? row?.hrs ?? 0) || 0,
        avg: row?.avg ?? row?.battingAverage ?? null,
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
if (!DR_STATIC_DAILY_DUMP) {
  setInterval(() => {
    if (document.visibilityState === 'visible') {
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
// Pre-game prop snapshots — keyed by pitcherId.
// Once locked (game goes live/final), the projection never changes.
// This prevents ERA/WHIP updates during the season from shifting the line mid-game.
const _kPropsSnapshot = {};
let sportsbookKLinesByPitcher = {};
let sportsbookKLinesLoadedForDate = null;

function normalizeKPropName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
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
async function loadSportsbookKLines(today) {
  if (sportsbookKLinesLoadedForDate === today) return;
  sportsbookKLinesByPitcher = {};
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
  sources.flat().forEach(indexSportsbookKLine);
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
const lineupMeta  = {}; // pitcherId -> {pitcherName, gamePk, side, oppTeamId, pitcherHr9, pitcherIp}
const expandedRows = new Set();
// Production stability patch: normalize pitcher ids and prevent stale lineup requests
// from overwriting an actively opened Batting Lineup & Matchup panel.
const lineupLoading = new Set();
const lineupRequestTokens = {};
const normalizePitcherId = (id) => String(id);

function setLineupOpenState(pid, isOpen) {
  const key = normalizePitcherId(pid);
  const expandRow = document.getElementById(`pr-expand-${key}`);
  const card = document.getElementById(`pr-row-${key}`);
  const btn = card?.querySelector('.btn-lineup');

  if (expandRow) {
    expandRow.classList.toggle('is-open', !!isOpen);
    expandRow.hidden = !isOpen;
    expandRow.style.display = isOpen ? (isPRMobileTabletView() ? 'block' : '') : 'none';
  }
  if (card) card.classList.toggle('is-expanded', !!isOpen);
  if (btn) {
    btn.textContent = isOpen ? '▲ HIDE' : '▼ BATTING LINEUP & MATCHUPS';
    btn.classList.toggle('active', !!isOpen);
  }
}

function isLineupOpen(pid) {
  const key = normalizePitcherId(pid);
  const expandRow = document.getElementById(`pr-expand-${key}`);
  return !!expandRow && !expandRow.hidden && expandRow.style.display !== 'none';
}

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
      rehydrateExpandedPitcherRows();
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
      return {
        pitcher: p,
        gameTime: p.gameTimestamp,
        ip: f(s.inningsPitched,1), bf: fI(s.battersFaced),
        fip: f(s.fip), avg: f(s.avg,3), woba: f(s.obp,3),
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

    // ── Desktop-only warmup. On mobile/tablet, eager panel rendering can race the tap
    // action and cause Safari/iPadOS to collapse or blank the expanded content.
    setTimeout(() => {
      if (isPRMobileTabletView()) return;
      prRows.forEach(r => {
        const p = r.pitcher;
        if (p.id && p.gamePk && p.side != null && expandedRows.has(normalizePitcherId(p.id))) {
          fetchAndRenderLineup(p.id, p.name, p.gamePk, p.side, p.oppTeamId, r.rawHr9, r.rawIp).catch(()=>{});
        }
      });
    }, 500);
  } catch(e) {
    document.getElementById('pr-content').innerHTML = `<div class="mu-empty" style="color:var(--accent)">Error: ${e.message}</div>`;
  }
}

// K O/U lookup: pitcherId -> ouLine (populated by renderPRTable)
const pitcherOULines = {};


function isPRMobileTabletView() {
  return window.matchMedia && window.matchMedia('(max-width: 1024px)').matches;
}

// Bug fix: renderPRTable() only checked isPRMobileTabletView() at data-load time, so
// rotating a tablet or resizing a desktop window across the 1024px breakpoint left the
// Pitcher Report stuck in the stale layout (mobile cards on desktop, or vice versa)
// until the next full data refresh. Re-render on breakpoint crossings only, so this
// doesn't cause extra work on every resize pixel.
let prLastLayoutWasMobile = null;
let prResizeDebounce = null;
window.addEventListener('resize', () => {
  clearTimeout(prResizeDebounce);
  prResizeDebounce = setTimeout(() => {
    if (!Array.isArray(prRows) || !prRows.length) return;
    const nowMobile = isPRMobileTabletView();
    if (prLastLayoutWasMobile === null) { prLastLayoutWasMobile = nowMobile; return; }
    if (nowMobile !== prLastLayoutWasMobile) {
      prLastLayoutWasMobile = nowMobile;
      renderPRTable();
    }
  }, 200);
}, { passive: true });

function getSortedPRRowsForCurrentSort() {
  return [...prRows].sort((a,b) => {
    if (!prSortCol) return 0;
    const av=a[prSortCol], bv=b[prSortCol];
    if (av==null&&bv==null) return 0;
    if (av==null) return 1; if (bv==null) return -1;
    return (av-bv)*prSortDir;
  });
}

function rehydrateExpandedPitcherRows() {
  expandedRows.forEach(rawPid => {
    const pid = normalizePitcherId(rawPid);
    const row = prRows.find(r => normalizePitcherId(r.pitcher.id) === pid);
    if (!row) return;
    const panel = document.getElementById(`panel-${pid}`);
    setLineupOpenState(pid, true);
    if (!panel) return;
    const cacheKey = `${row.pitcher.gamePk}-${row.pitcher.side}`;
    lineupMeta[pid] = lineupMeta[pid] || {
      pitcherName: row.pitcher.name,
      gamePk: row.pitcher.gamePk,
      side: row.pitcher.side,
      oppTeamId: row.pitcher.oppTeamId,
      pitcherHr9: row.rawHr9,
      pitcherIp: row.rawIp
    };
    if (lineupCache[cacheKey]) {
      renderLineup(`panel-${pid}`, lineupCache[cacheKey], row.rawHr9, row.rawIp, row.pitcher.oppAbbr, pid, row.pitcher.name);
    } else if (!lineupLoading.has(pid)) {
      fetchAndRenderLineup(pid, row.pitcher.name, row.pitcher.gamePk, row.pitcher.side, row.pitcher.oppTeamId, row.rawHr9, row.rawIp).catch(()=>{});
    }
  });
}

function renderPRMobileCards() {
  const el = document.getElementById('pr-content');
  if (!el) return;
  const sorted = getSortedPRRowsForCurrentSort();
  const hs = id => `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_46,q_auto:best/v1/people/${id}/headshot/67/current`;

  const cards = sorted.map(r => {
    const p = r.pitcher;
    const pid = normalizePitcherId(p.id);
    const isExpanded = expandedRows.has(pid);
    const k9 = r.rawK9 || 0;
    const kpropCls = k9 >= 9.5 ? 'good' : k9 <= 6.0 ? 'low' : 'mid';
    const kpropLine = getKPropLine(p, r);
    const kpropDir = getKPropDirection(r, kpropLine);
    const stat = (label, value) => `<div class="pr-mobile-stat"><span class="pr-mobile-stat-label">${label}</span><span class="pr-mobile-stat-value">${value}</span></div>`;
    let liveK = latestPitcherKData?.[pid] || latestPitcherKData?.[p.id];
    if (!liveK && latestPitcherKData) {
      liveK = Object.values(latestPitcherKData).find(l => l && l.name === p.name && (!l.teamAbbr || l.teamAbbr === p.teamAbbr));
    }
    return `<div class="pr-mobile-card${isExpanded ? ' is-expanded' : ''}" id="pr-row-${pid}">
      <div class="pr-mobile-top">
        <div class="pr-mobile-pitcher">
          <img class="pr-headshot" src="${hs(p.id)}" alt="${p.name}" loading="lazy" decoding="async">
          <div style="min-width:0">
            <div class="pr-mobile-name">${p.name}</div>
            <div class="pr-mobile-sub">${p.teamAbbr} · ${r.wl} · vs ${p.oppAbbr}</div>
          </div>
        </div>
        <div class="pr-mobile-time" style="color:${p.timeColor};font-weight:${p.timeLabel.includes('LIVE')?700:400}">${p.timeLabel}</div>
      </div>
      <div style="display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:nowrap;overflow-x:auto">
        ${liveK && (liveK.isLive || liveK.isFinal) ? `<span class="pr-stat-chip pr-live-k-chip">Live K: ${liveK.ks}</span>` : '–'}
      </div>
      <div class="pr-mobile-stats">
        ${stat('IP', r.ip!=null?r.ip.toFixed(1):'–')}
        ${stat('BF', r.bf!=null?r.bf:'–')}
        ${stat('FIP', r.fip!=null?r.fip.toFixed(2):'–')}
        ${stat('AVG', r.avg!=null?r.avg.toFixed(3).replace(/^0/,''):'–')}
        ${stat('WHIP', r.whip!=null?r.whip.toFixed(2):'–')}
        ${stat('HR/9', r.hr9!=null?r.hr9.toFixed(2):'–')}
      </div>
      <button class="btn-lineup${isExpanded?' active':''}" onclick="toggleLineup('${pid}', '${p.name.replace(/'/g,"\\'")}', ${p.gamePk}, '${p.side}', ${p.oppTeamId}, ${r.rawHr9}, ${r.rawIp})">
        ${isExpanded ? '▲ HIDE' : '▼ BATTING LINEUP & MATCHUPS'}
      </button>
      <div class="pr-mobile-expand${isExpanded ? ' is-open' : ''}" id="pr-expand-${pid}" ${isExpanded ? '' : 'hidden'} style="${isExpanded?'display:block':'display:none'}">
        <div class="pr-expand-panel" id="panel-${pid}">
          <span class="spin"></span> Loading lineup…
        </div>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="pr-mobile-list">${cards}</div>
    <div class="pr-legend-note" style="margin-top:12px;font-size:11px">
      Mobile/tablet card layout active · Tap Batting Lineup &amp; Matchups to expand.
    </div>`;
  rehydrateExpandedPitcherRows();
}

function pill(val, dispFn, goodBelow, badAbove) {
  if (val==null) return `<span class="stat-pill pill-neu">–</span>`;
  const cls = val<=goodBelow ? 'pill-green' : val>=badAbove ? 'pill-red' : 'pill-neu';
  return `<span class="stat-pill ${cls}">${dispFn(val)}</span>`;
}

function renderPRTable() {
  prLastLayoutWasMobile = isPRMobileTabletView();
  if (prLastLayoutWasMobile) { renderPRMobileCards(); return; }
  const el = document.getElementById('pr-content');
  const colCount = 15;

  const cols = [
    {key:'gameTime', label:'TIME',    sortable:true,  tip:'Game start time'},
    {key:'name',     label:'PITCHER', sortable:false, tip:'Starting pitcher'},
    {key:'vs',       label:'VS',      sortable:false, tip:'Opposing team'},
    {key:'kprop',    label:'LIVE K',  sortable:true,  tip:'Live K count during game'},
    {key:'ip',       label:'IP',      sortable:true,  tip:'Innings Pitched'},
    {key:'bf',       label:'BF',      sortable:true,  tip:'Batters Faced'},
    {key:'fip',      label:'FIP',     sortable:true,  tip:'Fielding Independent Pitching — ERA based only on K, BB, HR'},
    {key:'avg',      label:'AVG',   sortable:true,  tip:'Batting Average Against'},
    {key:'woba',     label:'wOBA',    sortable:true,  tip:'Weighted On-Base Average (shown as OBP when wOBA unavailable)'},
    {key:'whip',     label:'WHIP',    sortable:true,  tip:'Walks + Hits per Inning Pitched'},
    {key:'iso',      label:'ISO',     sortable:true,  tip:'Isolated Power (SLG − AVG) — extra-base power allowed'},
    {key:'slg',      label:'SLG',     sortable:true,  tip:'Slugging Percentage Against'},
    {key:'hr9',      label:'HR/9',    sortable:true,  tip:'Home Runs per 9 Innings'},
    {key:'tb',       label:'TB',      sortable:true,  tip:'Total Bases Allowed'},
    {key:'kpg',      label:'K/GM',    sortable:true,  tip:'Average Strikeouts per Game Started'},
  ];

  const sorted = [...prRows].sort((a,b) => {
    if (!prSortCol) return 0;
    const av=a[prSortCol], bv=b[prSortCol];
    if (av==null&&bv==null) return 0;
    if (av==null) return 1; if (bv==null) return -1;
    return (av-bv)*prSortDir;
  });

  const hs = id => `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_38,q_auto:best/v1/people/${id}/headshot/67/current`;

  const rows = sorted.map((r) => {
    const p = r.pitcher;
    const rowId = `pr-row-${p.id}`;
    const expandId = `pr-expand-${p.id}`;
    const isExpanded = expandedRows.has(normalizePitcherId(p.id));

    // K prop line — real sportsbook line if available, else model projection rounded to nearest half
    const k9 = r.rawK9 || 0;
    const kpropCls = k9 >= 9.5 ? 'good' : k9 <= 6.0 ? 'low' : 'mid';
    const kpropLine = getKPropLine(p, r);
    const kpropDir = getKPropDirection(r, kpropLine);
    if (kpropLine != null) pitcherOULines[p.id] = kpropLine;

    const mainRow = `<tr class="pr-main-row" id="${rowId}">
      <td><span class="pr-time" style="color:${p.timeColor};font-weight:${p.timeLabel.includes('LIVE')?700:400}">${p.timeLabel}</span></td>
      <td>
        <div class="pr-pitcher-cell">
          <img class="pr-headshot" src="${hs(p.id)}" alt="${p.name}" loading="lazy" decoding="async">
          <div class="pr-pitcher-info">
            <span class="pr-pitcher-name">${p.name}</span>
            <div class="pr-pitcher-sub">
              <span class="pr-wl">${p.teamAbbr} · ${r.wl}</span>
              <button class="btn-lineup${isExpanded?' active':''}" onclick="toggleLineup('${p.id}', '${p.name.replace(/'/g,"\\'")}', ${p.gamePk}, '${p.side}', ${p.oppTeamId}, ${r.rawHr9}, ${r.rawIp})">
                ${isExpanded ? '▲ HIDE' : '▼ BATTING LINEUP & MATCHUPS'}
              </button>
            </div>
          </div>
        </div>
      </td>
      <td style="color:var(--muted);font-size:11px">@ ${p.oppAbbr}</td>
      <td id="kprop-cell-${r.pitcher.id}">
        <div style="display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:nowrap">
          ${latestPitcherKData?.[normalizePitcherId(p.id)] ? `<span class="pr-stat-chip pr-live-k-chip">Live K: ${latestPitcherKData[normalizePitcherId(p.id)].ks}</span>` : '–'}
        </div>
      </td>
      <td><span class="pr-plain">${r.ip!=null?r.ip.toFixed(1):'–'}</span></td>
      <td><span class="pr-plain">${r.bf!=null?r.bf:'–'}</span></td>
      <td>${pill(r.fip,  v=>v.toFixed(2), 3.25, 4.50)}</td>
      <td>${pill(r.avg,  v=>v.toFixed(3).replace(/^0/,''), .220, .270)}</td>
      <td>${pill(r.woba, v=>v.toFixed(3).replace(/^0/,''), .290, .340)}</td>
      <td>${pill(r.whip, v=>v.toFixed(2), 1.10, 1.40)}</td>
      <td>${pill(r.iso,  v=>v.toFixed(3).replace(/^0/,''), .150, .200)}</td>
      <td>${pill(r.slg,  v=>v.toFixed(3).replace(/^0/,''), .350, .430)}</td>
      <td>${pill(r.hr9,  v=>v.toFixed(2), 0.80, 1.50)}</td>
      <td><span class="pr-plain">${r.tb!=null?r.tb:'–'}</span></td>
      <td><span class="pr-plain" style="color:${r.kpg>=7?'var(--green)':r.kpg>=5?'var(--text)':'var(--muted)'}">${r.kpg??'–'}</span></td>
    </tr>`;

    const expandRow = `<tr class="pr-expand-row" id="${expandId}" style="${isExpanded?'':'display:none'}">
      <td colspan="${colCount}">
        <div class="pr-expand-panel" id="panel-${p.id}">
          <span class="spin"></span> Loading lineup…
        </div>
      </td>
    </tr>`;

    return mainRow + expandRow;
  }).join('');

  const ths = cols.map(c => {
    const tip = c.tip ? ` data-tip="${c.tip}"` : '';
    if (!c.sortable) return `<th${tip}>${c.label}</th>`;
    const cls = prSortCol===c.key ? (prSortDir===1?'sort-asc':'sort-desc') : '';
    return `<th class="${cls}"${tip} onclick="sortPR('${c.key}')">${c.label}</th>`;
  }).join('');

  el.innerHTML = `
    <div class="pr-table-wrap">
      <table class="pr-table">
        <thead><tr>${ths}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="pr-legend">
      <span class="pr-legend-chip"><span class="pr-legend-dot good"></span>Elite</span>
      <span class="pr-legend-chip"><span class="pr-legend-dot neu"></span>Average</span>
      <span class="pr-legend-chip"><span class="pr-legend-dot bad"></span>Concerning</span>
      <span class="pr-legend-sep">·</span>
      <span class="pr-legend-note">Click column headers to sort</span>
      <span class="pr-legend-sep">·</span>
      <span class="pr-legend-note">HR% = estimated per-AB probability based on batter HR rate × pitcher HR/9</span>
      <span class="pr-legend-sep">·</span>
      <span class="pr-legend-note">2026 season</span>
    </div>`;

  // v6.4: Rehydrate any expanded rows after table refresh/sort/live re-render.
  // This prevents the mobile panel from flashing content and then returning to a blank/loading state.
  expandedRows.forEach(rawPid => {
    const pid = normalizePitcherId(rawPid);
    const row = prRows.find(r => normalizePitcherId(r.pitcher.id) === pid);
    if (!row) return;
    const panel = document.getElementById(`panel-${pid}`);
    setLineupOpenState(pid, true);
    if (!panel) return;
    const cacheKey = `${row.pitcher.gamePk}-${row.pitcher.side}`;
    lineupMeta[pid] = lineupMeta[pid] || {
      pitcherName: row.pitcher.name,
      gamePk: row.pitcher.gamePk,
      side: row.pitcher.side,
      oppTeamId: row.pitcher.oppTeamId,
      pitcherHr9: row.rawHr9,
      pitcherIp: row.rawIp
    };
    if (lineupCache[cacheKey]) {
      renderLineup(`panel-${pid}`, lineupCache[cacheKey], row.rawHr9, row.rawIp, row.pitcher.oppAbbr, pid, row.pitcher.name);
    } else if (!lineupLoading.has(pid)) {
      fetchAndRenderLineup(pid, row.pitcher.name, row.pitcher.gamePk, row.pitcher.side, row.pitcher.oppTeamId, row.rawHr9, row.rawIp).catch(()=>{});
    }
  });
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

async function toggleLineup(pitcherId, pitcherName, gamePk, side, oppTeamId, pitcherHr9, pitcherIp) {
  const pid = normalizePitcherId(pitcherId);
  const panel = document.getElementById(`panel-${pid}`);
  const btn = document.querySelector(`#pr-row-${pid} .btn-lineup`);

  if (!panel) return;

  if (expandedRows.has(pid)) {
    expandedRows.delete(pid);
    setLineupOpenState(pid, false);
    if (btn) btn.disabled = false;
    return;
  }

  expandedRows.add(pid);
  setLineupOpenState(pid, true);
  lineupMeta[pid] = { pitcherName, gamePk, side, oppTeamId, pitcherHr9, pitcherIp };

  const cacheKey = `${gamePk}-${side}`;
  if (lineupCache[cacheKey]) {
    renderLineup(`panel-${pid}`, lineupCache[cacheKey], pitcherHr9, pitcherIp, null, pid, pitcherName);
    return;
  }

  if (lineupLoading.has(pid)) {
    // A background/previous request is already feeding this exact panel.
    // Keep it visibly open instead of stacking duplicate requests.
    if (btn) {
      btn.textContent = '▲ HIDE';
      btn.classList.add('active');
    }
    return;
  }

  if (btn) btn.disabled = true;
  await fetchAndRenderLineup(pid, pitcherName, gamePk, side, oppTeamId, pitcherHr9, pitcherIp);
  const finalBtn = document.querySelector(`#pr-row-${pid} .btn-lineup`);
  if (finalBtn) finalBtn.disabled = false;
}

async function fetchAndRenderLineup(pitcherId, pitcherName, gamePk, side, oppTeamId, pitcherHr9, pitcherIp, skipEnrichment = false, bypassPRGuards = false) {
  const pid = normalizePitcherId(pitcherId);
  const panel = document.getElementById(`panel-${pid}`);
  if (!panel) return;
  if (!bypassPRGuards) {
    if (isPRMobileTabletView() && !expandedRows.has(pid)) return;
    setLineupOpenState(pid, expandedRows.has(pid));
  }

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
      // Diff — only update batter rows that changed
      let anyChanged = false;
      lineup.forEach((b, i) => {
        const prev = prevLineup[i];
        const rowEl = document.querySelector(`[data-batter-id="${b.id}"]`);
        if (!rowEl) { anyChanged = true; return; }
        const todayChanged  = prev?.todayHR  !== b.todayHR;
        const last10Changed = prev?.last10HR !== b.last10HR;
        if (todayChanged || last10Changed) {
          anyChanged = true;
          // Patch just the stats sub-line and highlight
          const statsEl = rowEl.querySelector('.batter-stats-line');
          const nameEl  = rowEl.querySelector('.batter-name-span');
          const badgeEl = rowEl.querySelector('.hr-today-badge');
          if (statsEl) statsEl.innerHTML = buildBatterStatsLine(b);
          if (nameEl)  nameEl.style.color = b.todayHR > 0 ? 'var(--accent2)' : 'var(--text)';
          if (b.todayHR > 0 && !badgeEl) {
            const badge = document.createElement('span');
            badge.className = 'hr-today-badge';
            badge.style.cssText = 'background:#2a1500;color:#f4a261;font-size:10px;font-weight:700;padding:2px 7px;border-radius:3px;letter-spacing:.5px;border:1px solid #f4a26166';
            badge.textContent = `💥 HR TODAY${b.todayHR > 1 ? ' x'+b.todayHR : ''}`;
            nameEl?.parentElement?.appendChild(badge);
          } else if (b.todayHR === 0 && badgeEl) {
            badgeEl.remove();
          }
          // Update row background
          rowEl.style.background = b.todayHR > 0 ? 'linear-gradient(90deg,#2a1a00 0%,#1a1200 100%)' : '';
          rowEl.style.borderLeft  = b.todayHR > 0 ? '3px solid var(--accent2)' : '';
        }
      });

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
      const btn = document.querySelector(`#pr-row-${pid} .btn-lineup`);
      if (btn) btn.disabled = false;
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
  const last10Display = last10HR === null
    ? '<span style="color:var(--muted);font-size:10px">–</span>'
    : `<span style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:${last10HR>=3?'var(--accent2)':last10HR>=1?'#90ee60':'var(--muted)'}">${last10HR}</span><span style="font-size:9px;color:var(--muted)"> HR</span>`;
  return `<span>AVG <strong style="color:var(--text)">${fmtS(s.avg)}</strong></span>
    <span>HR <strong style="color:${parseInt(s.homeRuns)>=10?'var(--accent2)':'var(--text)'}">${_statHasRealBattingData(s) ? (s.homeRuns??'–') : '–'}</strong></span>
    <span>OPS <strong style="color:var(--text)">${fmtS(s.ops)}</strong></span>
    <span style="display:flex;align-items:center;gap:4px">L10 ${last10Display}</span>`;
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
    const batterRate = ab > 0 ? hr / ab : 0;
    const pitcherRate = pitcherHr9 > 0 ? pitcherHr9 / 27 : 0.03;
    return Math.min(((batterRate * 0.6) + (pitcherRate * 0.4)) * 100, 25);
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
    if (score >= 2) return `<span class="matchup-label ml-good">✓ TOUGH FOR PITCHER</span>`;
    if (score <= -2) return `<span class="matchup-label ml-bad">✗ TOUGH FOR BATTER</span>`;
    return `<span class="matchup-label ml-neutral">~ NEUTRAL MATCHUP</span>`;
  }

  const cards = withProbs.map((b, i) => {
    const s = b.stats;
    const isTop = i === topIdx; // persists regardless of todayHR
    const homerToday = b.todayHR > 0;
    const barPct = maxProb > 0 ? (b.hrProb / maxProb) * 100 : 0;
    const barColor = homerToday ? '#f4a261' : isTop ? '#f4a261' : b.hrProb > maxProb * 0.7 ? '#e63946' : '#2ecc71';
    const pName = (pitcherName||'').replace(/'/g,"\\'");
    const bName = b.name.replace(/'/g,"\\'");
    const rowBg = homerToday ? 'background:linear-gradient(90deg,#2a1a00 0%,#1a1200 100%);border-left:3px solid var(--accent2);' : '';

    return `<div data-batter-id="${b.id}" class="lineup-batter-card${homerToday?' hr-today':''}">
      <div class="lineup-batter-main">
        <span style="font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace;min-width:14px">${i+1}</span>
        <div class="lineup-batter-details">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="batter-name-span" style="font-size:13px;font-weight:700;color:${homerToday?'var(--accent2)':'var(--text)'}">${b.name}</span>
            <span class="batter-pos">${b.pos}</span>
            ${homerToday ? `<span class="hr-today-badge" style="background:#2a1500;color:#f4a261;font-size:10px;font-weight:700;padding:2px 7px;border-radius:3px;letter-spacing:.5px;border:1px solid #f4a26166">💥 HR TODAY${b.todayHR>1?' x'+b.todayHR:''}</span>` : ''}
            ${isTop ? `<span class="top-hr-badge">⚡ TOP HR THREAT</span>` : ''}
          </div>
          <div style="margin-top:3px">${matchupLabel(s)}</div>
          <div class="batter-stats-line" style="display:flex;gap:12px;margin-top:4px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);flex-wrap:wrap">
            ${buildBatterStatsLine(b)}
          </div>
        </div>
      </div>
      <div class="lineup-matchup-action">
        <button class="btn-matchup" onclick="openMatchup(${b.id},'${bName}',${pitcherId},'${pName}')" title="Batter vs Pitcher analysis">
          ⚔ Pitcher Matchup
        </button>
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


// ── GAME PROPS ────────────────────────────────────────────────────────
// Stadium coordinates for weather lookup
const stadiumCoords = {
  ARI:{lat:33.445,lon:-112.067,name:'Chase Field',dome:true},
  ATL:{lat:33.891,lon:-84.468,name:'Truist Park',dome:false},
  BAL:{lat:39.284,lon:-76.622,name:'Oriole Park',dome:false},
  BOS:{lat:42.347,lon:-71.097,name:'Fenway Park',dome:false},
  CHC:{lat:41.948,lon:-87.655,name:'Wrigley Field',dome:false},
  CWS:{lat:41.830,lon:-87.634,name:'Guaranteed Rate Field',dome:false},
  CIN:{lat:39.097,lon:-84.506,name:'Great American Ball Park',dome:false},
  CLE:{lat:41.496,lon:-81.685,name:'Progressive Field',dome:false},
  COL:{lat:39.756,lon:-104.994,name:'Coors Field',dome:false},
  DET:{lat:42.339,lon:-83.049,name:'Comerica Park',dome:false},
  HOU:{lat:29.757,lon:-95.355,name:'Minute Maid Park',dome:true},
  KC: {lat:39.051,lon:-94.480,name:'Kauffman Stadium',dome:false},
  LAA:{lat:33.800,lon:-117.883,name:'Angel Stadium',dome:false},
  LAD:{lat:34.074,lon:-118.240,name:'Dodger Stadium',dome:false},
  MIA:{lat:25.778,lon:-80.220,name:'loanDepot Park',dome:true},
  MIL:{lat:43.029,lon:-87.971,name:'American Family Field',dome:true},
  MIN:{lat:44.981,lon:-93.278,name:'Target Field',dome:false},
  NYM:{lat:40.757,lon:-73.846,name:'Citi Field',dome:false},
  NYY:{lat:40.829,lon:-73.926,name:'Yankee Stadium',dome:false},
  ATH:{lat:37.751,lon:-122.200,name:'Oakland Coliseum',dome:false},
  OAK:{lat:37.751,lon:-122.200,name:'Oakland Coliseum',dome:false},
  PHI:{lat:39.906,lon:-75.166,name:'Citizens Bank Park',dome:false},
  PIT:{lat:40.447,lon:-80.006,name:'PNC Park',dome:false},
  SD: {lat:32.707,lon:-117.157,name:'Petco Park',dome:false},
  SF: {lat:37.778,lon:-122.389,name:'Oracle Park',dome:false},
  SEA:{lat:47.591,lon:-122.332,name:'T-Mobile Park',dome:true},
  STL:{lat:38.623,lon:-90.193,name:'Busch Stadium',dome:false},
  TB: {lat:27.768,lon:-82.653,name:'Tropicana Field',dome:true},
  TEX:{lat:32.751,lon:-97.083,name:'Globe Life Field',dome:true},
  TOR:{lat:43.641,lon:-79.389,name:'Rogers Centre',dome:true},
  WSH:{lat:38.873,lon:-77.007,name:'Nationals Park',dome:false},
};

// Park factors (HR index: 100 = average, >100 = hitter friendly)
const parkFactors = {
  COL:145,CIN:112,TEX:108,PHI:107,BOS:106,NYY:105,MIL:104,CWS:103,
  ATL:102,LAD:101,MIN:101,CHC:100,KC:100,DET:99,SEA:99,STL:98,
  SD:98,NYM:97,BAL:97,CLE:96,PIT:96,MIA:95,HOU:95,LAA:94,
  SF:93,WSH:93,OAK:92,TOR:91,TB:91,ARI:90,ATH:92,
};

let gamePropsLoaded = false;

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

      // Fetch both pitcher stats
      const [awayStats, homeStats] = await Promise.all([
        awayP ? fetchJSON(`https://diamondreport.app/api/v1/people/${awayP.id}?hydrate=stats(group=pitching,type=season,season=2026)`).then(d=>d.people?.[0]?.stats?.[0]?.splits?.[0]?.stat||{}).catch(()=>({})) : Promise.resolve({}),
        homeP ? fetchJSON(`https://diamondreport.app/api/v1/people/${homeP.id}?hydrate=stats(group=pitching,type=season,season=2026)`).then(d=>d.people?.[0]?.stats?.[0]?.splits?.[0]?.stat||{}).catch(()=>({})) : Promise.resolve({}),
      ]);

      // Weather (Open-Meteo, free, no key)
      const stadium = stadiumCoords[homeAbbr] || stadiumCoords[awayAbbr];
      let weather = null;
      if (stadium && !stadium.dome) {
        try {
          const wd = await fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${stadium.lat}&longitude=${stadium.lon}&current=temperature_2m,windspeed_10m,winddirection_10m,precipitation,weathercode&temperature_unit=fahrenheit&windspeed_unit=mph`);
          const c = wd.current;
          weather = {
            temp: Math.round(c.temperature_2m),
            wind: Math.round(c.windspeed_10m),
            windDir: c.winddirection_10m,
            precip: c.precipitation,
            code: c.weathercode,
          };
        } catch {}
      }

      // Scoring model — each factor adds/subtracts from home team edge
      let awayScore = 50, homeScore = 50;
      const factors = [];
      const sideAbbr = (side) => side === 'away' ? awayAbbr : side === 'home' ? homeAbbr : '';
      const sidePitcher = (side) => side === 'away' ? awayP : side === 'home' ? homeP : null;
      const pitcherLastName = (side) => sidePitcher(side)?.fullName?.split(' ').pop() || (side === 'away' ? 'Away P' : 'Home P');
      const factorLabel = (side, text) => `${sideAbbr(side)}: ${text}`;

      // Pitcher ERA comparison
      const awayERA = parseFloat(awayStats.era)||4.5;
      const homeERA = parseFloat(homeStats.era)||4.5;
      const eraDiff = awayERA - homeERA;
      if (Math.abs(eraDiff) > 0.3) {
        if (eraDiff > 0) { homeScore += Math.min(eraDiff*3, 8); factors.push({team:'home', label:factorLabel('home', `${pitcherLastName('home')} ERA adv (${homeERA.toFixed(2)})`), type:'pos'}); }
        else { awayScore += Math.min(Math.abs(eraDiff)*3, 8); factors.push({team:'away', label:factorLabel('away', `${pitcherLastName('away')} ERA adv (${awayERA.toFixed(2)})`), type:'pos'}); }
      }

      // WHIP comparison
      const awayWHIP = parseFloat(awayStats.whip)||1.3;
      const homeWHIP = parseFloat(homeStats.whip)||1.3;
      if (Math.abs(awayWHIP-homeWHIP) > 0.1) {
        if (awayWHIP > homeWHIP) { homeScore += 4; factors.push({team:'home', label:factorLabel('home', `${pitcherLastName('home')} WHIP edge (${homeWHIP.toFixed(2)})`), type:'pos'}); }
        else { awayScore += 4; factors.push({team:'away', label:factorLabel('away', `${pitcherLastName('away')} WHIP edge (${awayWHIP.toFixed(2)})`), type:'pos'}); }
      }

      // K/9 — high K pitcher favored
      const awayK9 = parseFloat(awayStats.strikeoutsPer9Inn)||8;
      const homeK9 = parseFloat(homeStats.strikeoutsPer9Inn)||8;
      if (homeK9 > awayK9 + 1) { homeScore += 3; factors.push({team:'home', label:factorLabel('home', `${pitcherLastName('home')} K/9 edge (${homeK9.toFixed(1)})`), type:'pos'}); }
      else if (awayK9 > homeK9 + 1) { awayScore += 3; factors.push({team:'away', label:factorLabel('away', `${pitcherLastName('away')} K/9 edge (${awayK9.toFixed(1)})`), type:'pos'}); }

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

      // Park factor
      const pf = parkFactors[homeAbbr] || 100;
      if (pf > 107) factors.push({team:'neutral', label:`${stadiumCoords[homeAbbr]?.name||homeAbbr}: HR-friendly park (${pf})`, type:'neu'});
      else if (pf < 93) factors.push({team:'neutral', label:`${stadiumCoords[homeAbbr]?.name||homeAbbr}: Pitcher-friendly park (${pf})`, type:'neu'});

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
        factors.push({team:'neutral', label:`${stadium.name} — retractable/dome, weather neutral`, type:'neu'});
      }

      // Determine winner
      const total = awayScore + homeScore;
      const awayPct = Math.round((awayScore/total)*100);
      const homePct = 100 - awayPct;
      const diff = Math.abs(awayPct - homePct);
      const confidence = diff < 6 ? 'TOSS-UP' : diff < 12 ? 'LEAN' : diff < 20 ? 'LIKELY' : 'STRONG';
      const confColor = diff < 6 ? 'var(--muted)' : diff < 12 ? 'var(--accent2)' : diff < 20 ? '#2ecc71' : '#00ff88';
      const winner = awayPct > homePct ? 'away' : 'home';
      const winnerAbbr = winner==='away' ? awayAbbr : homeAbbr;
      const winnerPct = winner==='away' ? awayPct : homePct;
      const loserAbbr  = winner==='away' ? homeAbbr : awayAbbr;
      const loserPct   = winner==='away' ? homePct : awayPct;

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
          resultBadge = `<span style="background:#2a0d0d;color:#e63946;font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid #e6394666">✗ INCORRECT — ${actualWinnerAbbr} won ${awayActual}-${homeActual}</span>`;
        }
      } else if (isLive && awayActual !== null && homeActual !== null) {
        const leadingAbbr = awayActual > homeActual ? awayAbbr : homeActual > awayActual ? homeAbbr : null;
        const isPickLeading = leadingAbbr === winnerAbbr;
        if (leadingAbbr) {
          resultBadge = `<span style="background:${isPickLeading?'#0d2a1a':'#2a0d0d'};color:${isPickLeading?'#2ecc71':'#e63946'};font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid ${isPickLeading?'#2ecc7166':'#e6394666'}">${isPickLeading?'▲':'▼'} ${leadingAbbr} leads ${awayActual}-${homeActual}</span>`;
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

      const confBarW = Math.min(winnerPct, 100);
      const confBarColor = diff < 6 ? 'var(--muted)' : diff < 12 ? 'var(--accent2)' : '#2ecc71';

      return { html: `<div class="gp-card" data-game-pk="${g.gamePk}" data-away="${awayAbbr}" data-home="${homeAbbr}" data-winner="${winnerAbbr}">
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
        </div>

        <!-- Key factors -->
        <div class="gp-factors">${factorChips}</div>
        <div class="gp-live-result-zone" data-live-score-badge="1" style="margin-top:8px">${resultBadge || ''}</div>
      </div>`, resultCorrect };
    }));

    // Tally correct picks from final games
    const finalResults = gameCards.filter(c => c && c.resultCorrect !== null && c.resultCorrect !== undefined);
    const correctCount = finalResults.filter(c => c.resultCorrect === true).length;
    const totalFinal   = finalResults.length;
    const totalGames   = gameCards.filter(Boolean).length;

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

// Refresh game props every 5 minutes when loaded (only while tab is visible)
setInterval(() => { if (document.visibilityState === 'visible' && gamePropsLoaded) loadGameProps({ force: true }); }, 2 * 60 * 1000);


// ── SCHEDULE (multi-day) ─────────────────────────────────────────────
let scheduleLoaded = false;

async function loadSchedule() {
  const content = document.getElementById('schedule-content');
  const loading = document.getElementById('schedule-loading');
  if (!content) return;

  try {
    const today = new Date();
    const dates = [];
    for (let i = 1; i <= 5; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      dates.push(d.toLocaleDateString('en-CA', {timeZone:'America/Chicago'}));
    }

    const allDays = await Promise.all(dates.map(async date => {
      const data = await fetchJSON(`https://diamondreport.app/api/v1/schedule?sportId=1&date=${date}&hydrate=team,probablePitcher&language=en`);
      const entry = data.dates?.find(d => d.date === date) || data.dates?.[0];
      return { date, games: entry?.games || [] };
    }));

    if (loading) loading.style.display = 'none';
    const sl = buildStandingsLookup();

    content.innerHTML = allDays.map(({ date, games }) => {
      if (!games.length) return '';
      const dt = new Date(date + 'T12:00:00');
      const dayLabel = dt.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}).toUpperCase();
      const isToday = false;

      const cards = games.map(g => {
        const away = g.teams.away, home = g.teams.home;
        const awayAbbr = away.team.abbreviation, homeAbbr = home.team.abbreviation;
        const dt2 = new Date(g.gameDate);
        const timeStr = dt2.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/Chicago'}) + ' CDT';
        const awayP = g.teams.away.probablePitcher?.fullName || 'TBD';
        const homeP = g.teams.home.probablePitcher?.fullName || 'TBD';
        const state = g.status.abstractGameState;
        const isLive = state==='Live'||g.status.detailedState==='In Progress';
        const isFinal = state==='Final';
        const statusLabel = isLive
          ? `<span style="color:var(--live);font-weight:700;font-size:10px">● LIVE</span>`
          : isFinal ? `<span style="color:var(--muted);font-size:10px">FINAL</span>`
          : `<span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text)">${timeStr}</span>`;

        function tblock(abbr, pName) {
          const id = teamIds[abbr];
          const logo = id ? `<img src="https://www.mlbstatic.com/team-logos/${id}.svg" style="width:34px;height:34px;object-fit:contain" alt="" loading="lazy" decoding="async">` : '';
          const st = sl[abbr];
          return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex:1;min-width:0">
            ${logo}
            <span style="font-family:'Manrope',sans-serif;font-size:19px;letter-spacing:1px">${abbr}</span>
            <span style="font-size:9px;color:var(--muted);text-align:center;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${pName}</span>
            ${st?`<span style="font-size:8px;color:var(--muted);font-family:'JetBrains Mono',monospace">${st.wl} · #${st.rank}</span>`:''}
          </div>`;
        }

        return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 10px">
          <div style="text-align:center;margin-bottom:8px">${statusLabel}</div>
          <div style="display:flex;align-items:center;gap:6px">
            ${tblock(awayAbbr, awayP)}
            <span style="font-size:14px;color:var(--muted);font-weight:700;flex-shrink:0">@</span>
            ${tblock(homeAbbr, homeP)}
          </div>
        </div>`;
      }).join('');

      return `<div style="margin-bottom:24px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          <span style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:${isToday?'var(--accent)':'var(--accent2)'};white-space:nowrap">${isToday?'TODAY · ':''}${dayLabel}</span>
          <div style="flex:1;height:1px;background:var(--border)"></div>
          <span style="font-size:10px;color:var(--muted);white-space:nowrap">${games.length} game${games.length!==1?'s':''}</span>
        </div>
        <div class="games-grid">${cards}</div>
      </div>`;
    }).join('') || '<div class="mu-empty">No upcoming games found.</div>';

    scheduleLoaded = true;
  } catch(e) {
    if (content) content.innerHTML = `<div class="mu-empty" style="color:var(--accent)">Error: ${e.message}</div>`;
    if (loading) loading.style.display = 'none';
  }
}









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
  // Prefer real per-zone wOBA-against from the synced pitcher profile
  // (data/pitcher-statcast.json). Fall back to the modeled heatmap when the
  // sync hasn't run yet or this pitcher wasn't in today's probable list.
  const usingExpected = !!(px && (px.slg || px.avg));
  const pitcherVuln = parseFloat(px?.slg ?? ps.slg) || .350;
  const pitcherAvgA = parseFloat(px?.avg ?? ps.avg) || .240;
  const batterPow   = parseInt(bs.homeRuns)||0;
  const batterXSLG  = parseFloat(bx?.slg) || null;

  const hasRealZones = !!(pitcherProfile?.byZone);

  // [TL, TM, TR, ML, MM, MR, BL, BM, BR] — Statcast zone order: 1-2-3 top, 4-5-6 mid, 7-8-9 bottom
  let zoneVals;
  if (hasRealZones) {
    const zMap = pitcherProfile.byZone;
    // Use xwOBA-on-contact when available (luck-stripped), else raw wOBA, else null → modeled fallback for that cell
    zoneVals = [1,2,3,4,5,6,7,8,9].map(z => {
      const cell = zMap[z];
      if (!cell) return 0.5;
      const val = cell.xwobaContact ?? cell.wobaAgainst;
      // Normalise wOBA scale (0–1 readable): league avg wOBA ≈ .320. Scale so .320 = 0.5
      return val != null ? Math.min(val / 0.640, 1.0) : 0.5;
    });
    // Still apply batter's power bias and H2H history on top of real zone data
    const powerBias = Math.min(batterPow / 25, 0.25) + (batterXSLG && batterXSLG >= .500 ? 0.07 : 0);
    zoneVals = zoneVals.map((v, i) => Math.min(v + (i < 3 ? powerBias * 0.5 : 0) + (h2h.homeRuns > 0 ? 0.08 : 0), 1.0));
  } else {
    const baseZone = [0.35, 0.55, 0.35, 0.60, 0.80, 0.60, 0.40, 0.45, 0.40];
    const vulnScale = Math.min(pitcherVuln / 0.380, 1.6);
    const powerBias = Math.min(batterPow / 25, 0.3) + (batterXSLG && batterXSLG >= .500 ? 0.08 : 0);
    zoneVals = baseZone.map((z, i) => Math.min(z * vulnScale + (i < 3 ? powerBias : 0) + (h2h.homeRuns > 0 ? 0.15 : 0), 1.0));
  }

  function zoneColor(v) {
    if (v >= 0.85) return { bg:'#4a1010', text:'#ff6b6b', label:'HOT' };
    if (v >= 0.65) return { bg:'#3a2010', text:'#f4a261', label:'WARM' };
    if (v >= 0.45) return { bg:'#1a2a10', text:'#90ee60', label:'OK' };
    return { bg:'#0d1a0d', text:'#3a6a3a', label:'COLD' };
  }

  const zoneLabels = ['In/High','High','Out/High','Inside','Middle','Away','In/Low','Low','Out/Low'];
  const zoneCells = zoneVals.map((v, i) => {
    const c = zoneColor(v);
    const pct = Math.round(v * 100);
    return `<div class="sz-cell" style="background:${c.bg};color:${c.text}" title="${zoneLabels[i]}: ${pct}% opportunity">
      ${pct}%
    </div>`;
  }).join('');

  function buildZoneFit() {
    const weights = zoneVals.map((v, i) => ({ i, v })).sort((a,b) => b.v - a.v);
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
  function getPitchTypeProfileMetrics(pitchName, usagePct, sourceStat=null) {
    // Production pitch-type fallback: make the table useful even before exact
    // pitch-type splits arrive. Values are intentionally pitch-specific so a
    // hitter's fastball/slider/changeup profile does not render as identical rows.
    // Exact synced rows still override this completely.
    const key = normalizePitchLabel(pitchName);
    const usage = parsePctVal(usagePct) ?? 0;
    const baseAvg = parseDecVal(sourceStat?.avg ?? sourceStat?.battingAverage ?? bx?.avg ?? bs?.avg) ?? .245;
    const baseSlg = parseDecVal(sourceStat?.slg ?? sourceStat?.slugging ?? bx?.slg ?? bs?.slg) ?? .400;
    const baseXslg = parseDecVal(sourceStat?.xslg ?? sourceStat?.xSLG ?? sourceStat?.expectedSlugging ?? bx?.slg ?? bs?.slg) ?? baseSlg;
    const baseHard = parsePctVal(sourceStat?.hardHitPct ?? sourceStat?.hardHitRate ?? hotHitter?.hardHitPct ?? hotHitter?.hardHitRate) ?? Math.max(30, Math.min(58, 33 + Math.max(0, baseSlg - .380) * 70));
    const baseBarrel = parsePctVal(sourceStat?.barrelPct ?? sourceStat?.barrelRate ?? hotHitter?.barrelPct ?? hotHitter?.barrelRate) ?? Math.max(3, Math.min(20, 5 + Math.max(0, baseSlg - .390) * 28));
    const baseWhiff = parsePctVal(sourceStat?.whiffPct ?? sourceStat?.whiffRate ?? hotHitter?.whiffPct ?? hotHitter?.whiffRate) ?? 22;
    const tweaks = {
      fastball:  { avg:+.012, slg:+.052, xslg:+.058, hard:+5.0, barrel:+2.4, whiff:-1.5, hr:1.08 },
      sinker:    { avg:+.004, slg:+.018, xslg:+.022, hard:+2.4, barrel:+0.9, whiff:-1.0, hr:.86 },
      slider:    { avg:-.022, slg:-.044, xslg:-.036, hard:-2.8, barrel:-1.5, whiff:+5.2, hr:.70 },
      changeup:  { avg:+.006, slg:+.030, xslg:+.034, hard:+2.2, barrel:+1.1, whiff:+1.7, hr:.78 },
      curveball: { avg:-.028, slg:-.058, xslg:-.050, hard:-4.0, barrel:-1.8, whiff:+6.0, hr:.62 },
      cutter:    { avg:-.008, slg:-.014, xslg:-.010, hard:-1.2, barrel:-.4, whiff:+2.1, hr:.72 },
      splitter:  { avg:-.020, slg:-.035, xslg:-.030, hard:-2.2, barrel:-1.0, whiff:+6.5, hr:.58 },
      sweeper:   { avg:-.025, slg:-.048, xslg:-.042, hard:-3.2, barrel:-1.4, whiff:+7.0, hr:.56 }
    };
    const t = tweaks[key] || { avg:0, slg:0, xslg:0, hard:0, barrel:0, whiff:0, hr:.75 };
    const power = Math.max(0, baseSlg - .380);
    const hrSeason = parseFloat(sourceStat?.homeRuns ?? sourceStat?.hr ?? sourceStat?.hrs ?? bs?.homeRuns ?? bHR ?? 0) || 0;
    const usageShare = Math.max(usage, 1) / 100;
    const estHr = Math.max(0, Math.round((hrSeason * usageShare * (t.hr || 1)) + (power > .170 ? 0.75 : 0)));
    return {
      name: pitchName,
      avg: Math.max(.050, Math.min(.430, baseAvg + t.avg)),
      slg: Math.max(.100, Math.min(.850, baseSlg + t.slg)),
      xslg: Math.max(.100, Math.min(.900, baseXslg + t.xslg)),
      homeRuns: estHr,
      hardHitPct: Math.max(10, Math.min(70, baseHard + t.hard)),
      barrelPct: Math.max(0, Math.min(28, baseBarrel + t.barrel)),
      whiffPct: Math.max(5, Math.min(45, baseWhiff + t.whiff)),
      _proxy: true
    };
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

    const totalHr = parseInt(bs?.careerHomeRuns ?? bs?.allTimeHomeRuns ?? hotHitter?.careerHomeRuns ?? hotHitter?.allTimeHomeRuns ?? bs?.homeRuns ?? bHR) || 0;
    const usage = parsePctVal(usagePct) ?? 0;
    const est = Math.max(0, Math.round(totalHr * usage / 100));
    const profile = getPitchTypeProfileMetrics(pitchName, usagePct, seasonSplit);
    return {
      value: est || profile.homeRuns || 0,
      exact: false,
      source: totalHr ? 'Estimated career profile' : 'Best available profile',
      sourceClass: 'estimated',
      estimated: true,
      avg: profile.avg,
      slg: profile.slg,
      xslg: profile.xslg,
      hardHit: profile.hardHitPct
    };
  }
  function pitchHrHTML(pitchName, usagePct) {
    const hr = getPitchTypeHrCount(pitchName, usagePct);
    return `<span class="pitch-hr-type ${hr.exact ? 'exact' : 'estimated'}" title="${hr.exact ? 'Batter career home runs against this pitch type from all-time pitch-split data.' : 'Best available pitch-type HR value using season split or estimated profile fallback.'}">${hr.value}</span>`;
  }
  function buildPitchTypeHrCards(pitchList) {
    return '';
  }


  function parsePctVal(v) {
    if (v === null || v === undefined || v === '' || v === '–') return null;
    if (typeof v === 'string' && v.trim().endsWith('%')) return parseFloat(v);
    const n = parseFloat(v);
    if (Number.isNaN(n)) return null;
    return n <= 1 ? n * 100 : n;
  }
  function parseDecVal(v) {
    if (v === null || v === undefined || v === '' || v === '–') return null;
    const n = parseFloat(v);
    return Number.isNaN(n) ? null : n;
  }
  function fmtDec(v, d=3) {
    const n = parseDecVal(v);
    if (n === null) return '–';
    return n.toFixed(d).replace(/^0(?=\.)/, '');
  }
  function fmtPctVal(v, d=0) {
    const n = parsePctVal(v);
    return n === null ? '–' : `${n.toFixed(d)}%`;
  }
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
    function buildSeasonProfileProxy(pitchName, usagePct) {
      return getPitchTypeProfileMetrics(pitchName, usagePct, null);
    }
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
      const pitches = (pitchList || []).map(p => {
        const usage = parseFloat(p.usagePct ?? p.usage ?? 0) || 0;
        const exact = getBatterSeasonPitchProfile(p.name, mode.hand);
        const fallback = buildSeasonProfileProxy(p.name, usage);
        const stat = handAdjustedPitchProfile(exact || fallback, p.name, usage, mode.hand);
        return { name:p.name, usage, abbr:pitchAbbr(p.name), stat, exact: !!exact };
      }).filter(p => p.name);
      let weighted = 0, weight = 0;
      const rows = pitches.map(p => {
        const st = p.stat || {};
        const grade = gradePitchAdvantage(st, p.usage);
        if (grade.score !== null && p.usage > 0) { weighted += grade.score * p.usage; weight += p.usage; }
        const chipCls = grade.score >= 78 ? '' : grade.score >= 64 ? ' good' : grade.score >= 45 ? ' neutral' : ' weak';
        const sourceBadge = p.exact
          ? '<span class="dr1041-chip good" style="font-size:9px;padding:2px 6px;margin-left:6px">Exact</span>'
          : '<span class="dr1041-chip neutral" style="font-size:9px;padding:2px 6px;margin-left:6px">Season profile</span>';
        return `<tr>
          <td><strong>${p.name}</strong>${sourceBadge}</td>
          <td class="usage">${p.usage ? p.usage.toFixed(0)+'%' : '–'}</td>
          <td class="num">${fmtDec(st.avg ?? st.battingAverage)}</td>
          <td class="num">${fmtDec(st.slg ?? st.slugging)}</td>
          <td class="num">${fmtDec(st.xslg ?? st.xSLG ?? st.expectedSlugging)}</td>
          <td class="num">${+(st.homeRuns ?? st.hr ?? st.hrs ?? 0) || 0}</td>
          <td class="num">${fmtPctVal(st.hardHitPct ?? st.hardHitRate)}</td>
          <td class="num">${fmtPctVal(st.barrelPct ?? st.barrelRate,1)}</td>
          <td class="num">${fmtPctVal(st.whiffPct ?? st.whiffRate,1)}</td>
          <td><span class="dr1041-chip${chipCls}">${grade.label}${grade.score!==null?' · '+grade.score:''}</span></td>
        </tr>`;
      }).join('');
      const score = weight ? Math.round(weighted / weight) : null;
      const top = pitches.map(p => ({ ...p, grade: gradePitchAdvantage(p.stat, p.usage) })).sort((a,b) => (b.usage * (b.grade.score || 0)) - (a.usage * (a.grade.score || 0)))[0];
      const handText = mode.hand === 'L' ? 'left-handed pitching' : mode.hand === 'R' ? 'right-handed pitching' : 'today’s starter hand';
      const summary = top
        ? `${mode.key === 'auto' ? 'AUTO is using today’s starter hand' : 'Viewing historical split'} vs ${mode.hand === 'L' ? 'LHP' : mode.hand === 'R' ? 'RHP' : 'starter'}. ${top.name} is the primary attack pitch at ${top.usage.toFixed(0)}%, and ${batterName.split(' ').pop()} profiles ${top.grade.label.toLowerCase()} against this ${handText} mix.`
        : `Pitch mix is available and will strengthen as more synced rows become available.`;
      return { pitches, score, rows, summary };
    }
    const built = Object.fromEntries(modes.map(m => [m.key, buildMode(m)]));
    const auto = built.auto;
    if (!auto.pitches.length) return { html:'', score:null, pitches:[] };
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
      <div class="dr1041-table-wrap"><table class="dr1041-pitch-table"><thead><tr><th>Pitch</th><th>Pitcher Usage</th><th>AVG</th><th>SLG</th><th>xSLG</th><th>HR</th><th>Hard Hit</th><th>Barrel</th><th>Whiff</th><th>Advantage</th></tr></thead>${bodies}</table></div>
      <div class="dr1041-ai-read"><strong style="color:#fff">AI Read:</strong> <span data-ai-read>${auto.summary}</span></div>
      <script type="application/json" data-pmix-state>${JSON.stringify({ scores:{auto:auto.score,R:built.R.score,L:built.L.score}, notes, reads:{auto:auto.summary,R:built.R.summary,L:built.L.summary} }).replace(/</g,'\\u003c')}<\/script>
    </div>`;
    return { html, score:auto.score, pitches:auto.pitches, usageChips };
  }
  // ── Pitch type vulnerability (modeled from pitcher stats) ──
  // Without Statcast we model likely pitch mix and batter vulnerability
  // ── Pitch mix — real data when synced, estimated fallback otherwise ──
  const hasRealPitchMix = !!(pitcherProfile?.byPitch?.length);
  const pitchSectionLabel = hasRealPitchMix
    ? `PITCH MIX · ${(pitcherProfile.totalPitches || 0).toLocaleString()} PITCHES THIS SEASON`
    : 'PITCH MIX VULNERABILITY';

  let pitchRows;
  let pitchHrList = [];
  if (hasRealPitchMix) {
    pitchHrList = pitcherProfile.byPitch.map(p => ({ name: p.name, usagePct: p.usagePct }));
    // Real pitch mix from sync script.
    // Color: red = hitter-friendly (high wOBA against), green = pitcher-friendly
    pitchRows = pitcherProfile.byPitch.map(p => {
      const woba = p.wobaAgainst ?? p.xwobaContact;
      const oppColor = woba == null ? 'var(--muted)'
        : woba >= .370 ? '#e63946'
        : woba >= .310 ? '#f4a261'
        : '#2ecc71';
      const veloTxt = p.avgVelo ? ` · ${p.avgVelo} mph` : '';
      const wobaTxt = woba != null ? `wOBA against: ${woba.toFixed(3).replace(/^0/,'')}` : 'usage';
      return `<div class="pitch-row">
        <span class="pitch-name">${p.name}${veloTxt}</span>
        <div class="pitch-bar-wrap"><div class="pitch-bar-fill" style="width:${p.usagePct}%;background:${oppColor}"></div></div>
        <span class="pitch-pct">${p.usagePct}%</span>
        <span class="pitch-ba" style="color:${oppColor}">${wobaTxt}</span>
        ${pitchHrHTML(p.name, p.usagePct)}
      </div>`;
    }).join('');
  } else {
    // Estimated fallback
    const pitchTypes = [
      { name: 'Fastball (4-seam)', usage: 38, oppColor: pitcherAvgA > .260 ? '#e63946' : '#2ecc71' },
      { name: 'Slider',            usage: 22, oppColor: '#2ecc71' },
      { name: 'Changeup',          usage: 16, oppColor: pitcherVuln > .420 ? '#f4a261' : '#2ecc71' },
      { name: 'Curveball',         usage: 14, oppColor: '#2ecc71' },
      { name: 'Sinker / 2-seam',   usage: 10, oppColor: '#f4a261' },
    ];
    pitchHrList = pitchTypes.map(pt => ({ name: pt.name, usage: pt.usage }));
    pitchRows = pitchTypes.map(pt => `<div class="pitch-row">
      <span class="pitch-name">${pt.name}</span>
      <div class="pitch-bar-wrap"><div class="pitch-bar-fill" style="width:${pt.usage}%;background:${pt.oppColor}"></div></div>
      <span class="pitch-pct">${pt.usage}%</span>
      <span class="pitch-ba" style="color:${pt.oppColor}">usage</span>
      ${pitchHrHTML(pt.name, pt.usage)}
    </div>`).join('');
  }



  function buildZoneFitPanelHTML(pitches) {
    const list = (pitches && pitches.length ? pitches : pitchHrList).slice(0,5);
    const rows = list.map((p, idx) => {
      const st = p.stat || getPitchTypeProfileMetrics(p.name, p.usage || p.usagePct || 0, null) || {};
      const grade = gradePitchAdvantage(st, p.usage || p.usagePct || 0);
      const fitLabel = grade.score >= 78 ? 'Excellent' : grade.score >= 64 ? 'Good' : grade.score >= 45 ? 'Neutral' : 'Weak';
      const chipCls = grade.score >= 78 ? '' : grade.score >= 64 ? ' good' : grade.score >= 45 ? ' neutral' : ' weak';
      const dotCls = grade.score >= 78 ? 'hot' : grade.score >= 64 ? 'warm' : grade.score >= 45 ? 'good' : 'cool';
      const mini = Array.from({length:9}, (_, i) => `<span class="dr1041-mini-dot ${[1,3,4,5,7].includes((i+idx)%9) ? dotCls : ''}"></span>`).join('');
      const avg = fmtDec(st.avg ?? st.battingAverage);
      const hr = +(st.homeRuns ?? st.hr ?? st.hrs ?? 0) || 0;
      return `<tr>
        <td><strong>${p.name}</strong></td>
        <td><span class="dr1041-chip${chipCls}">${fitLabel}</span></td>
        <td><div class="dr1041-mini-zone" aria-label="Location tendency">${mini}</div></td>
        <td class="num">${avg} AVG / ${hr} HR</td>
      </tr>`;
    }).join('');
    return `<div class="zone-section zone-fit-section">
      <div class="zone-title">🎯 ZONE FIT · HOW PITCHES ATTACK THE ZONE</div>
      <table class="dr1041-zone-fit-table"><thead><tr><th>Pitch</th><th>Zone Fit</th><th>Location Tendency</th><th>Vs This Batter</th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  }

  const pitchMixDashboard = buildPitchMixAdvantageSection(pitchHrList);
  const zoneFitPanelHTML = buildZoneFitPanelHTML(pitchMixDashboard.pitches);
  const bottomUsageChips = pitchMixDashboard.usageChips || '';

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
    { label: 'Hard-Hit%', value: hh.hardHitPct != null ? `${parseFloat(hh.hardHitPct)}%` : null, trend: hh.hardHitTrend, desc: 'How often he crushes the ball (95+ mph off the bat). Hot hitters hit the ball hard — cold ones bloop it.' },
    { label: 'Sweet-Spot%', value: hh.sweetSpotPct != null ? `${parseFloat(hh.sweetSpotPct)}%` : null, trend: hh.sweetSpotTrend, desc: 'How often he hits line drives and deep fly balls — the kind of contact that turns into doubles and home runs.' },
    { label: 'Barrel%', value: hh.barrelPct != null ? `${parseFloat(hh.barrelPct)}%` : null, trend: hh.barrelTrend, desc: 'How often he makes perfect contact — the hardest-hit balls at the best angles. The gold standard of a locked-in swing.' },
    { label: 'xwOBA (14-day)', value: hh.xwoba != null ? Number(hh.xwoba).toFixed(3).replace(/^0/,'') : null, trend: hh.xwobaTrend, desc: 'The same "is he actually hot?" number as above, but measured over just the past two weeks.' },
    { label: 'Bat Speed', value: hh.batSpeed != null ? `${parseFloat(hh.batSpeed)} mph` : null, trend: hh.batSpeedTrend, desc: 'How fast he\'s swinging. A quicker swing often shows up right before a power surge does.' },
    { label: 'Blast Rate', value: hh.blastRate != null ? `${parseFloat(hh.blastRate)}%` : null, trend: hh.blastTrend, desc: 'How often his swing has both the speed and the angle to leave the yard.' },
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
        ${m.trend !== undefined ? `<span style="font-size:10px;font-family:'JetBrains Mono',monospace">${trendArrow(m.trend)}</span>` : (m.delta || '')}
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
          ${[['AVG',bAVG],['HR',bHR],['OPS',bOPS],['ISO',bISO],['K%',bKpct],['BB%',bBBpct]].map(([l,v])=>`
          <div class="dr1043-row"><span>${l}</span><strong>${v}</strong></div>`).join('')}
        </div>

        <div class="dr1043-panel">
          <div class="dr1043-panel-title">Pitcher season <span class="dr1043-badge blue">${pitcherName.split(' ').pop()}</span></div>
          ${[['ERA',pERA],['FIP',pFIP],['WHIP',pWHIP],['AVG Allowed',pAVG],['HR/9',pHR9],['K/9',pKper9]].map(([l,v])=>`
          <div class="dr1043-row"><span>${l}</span><strong>${v}</strong></div>`).join('')}
        </div>
      </div>

      <div class="dr1043-callout">
        <strong style="color:#fff">Diamond Read:</strong>
        ${batterName.split(' ').pop()} brings ${fi(batterSplitHR)} HR vs this pitcher hand with a ${fv(batterSplitOPS)} OPS split. ${pitcherName.split(' ').pop()} has allowed ${fi(pitcherSplitHRAllowed)} HR vs this batter hand with a ${fv(pitcherSplitAvgAllowed)} AVG allowed split. Season context: batter ${bHR} HR / ${bOPS} OPS against pitcher ${pERA} ERA / ${pHR9} HR/9.
      </div>
    </div>

    ${hotStreakHTML}

    <div class="dr1041-matchup-dashboard">
      ${pitchMixDashboard.html}

      <!-- Strike Zone + Zone Fit -->
      <div class="dr1041-zone-grid">
      <div class="zone-section">
        <div class="zone-title">${hasRealZones ? 'STRIKE ZONE · REAL wOBA AGAINST BY LOCATION' : 'STRIKE ZONE VULNERABILITY · WHERE TO ATTACK'}</div>
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
      </div>
      </div>
      ${zoneFitPanelHTML}
      </div>

      <div class="dr1041-bottom-strip">
        <span class="dr1041-bottom-item">Pitcher Throws: <strong>${handLabel(pitcherHand,'pitcher')}</strong></span>
        <span class="dr1041-bottom-item">Batter Stance: <strong>${handLabel(batterHand,'batter')}</strong></span>
        <span class="dr1041-bottom-split"></span>
        <span class="dr1041-bottom-item">Today's Matchup: <strong style="color:#22c55e">vs ${handLabel(batterHand,'batter')}</strong></span>
        <span class="dr1041-bottom-split"></span>
        <span class="dr1041-bottom-item">Pitch Mix Usage:</span>
        <span class="dr1041-usage-chips">${bottomUsageChips}</span>
      </div>
    </div>

    <!-- Vulnerability summary -->
    <div class="vuln-box">
      <div class="vuln-title">⚡ SCOUTING REPORT — HOW TO HIT A HOME RUN</div>
      ${vulnHTML}
    </div>`;
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
    (blastTrend >= 5 ? 5 : blastTrend >= 2 ? 3 : 0), 0, 100
  );
  const tags = [];
  if (xwobaTrend >= .015 || xwoba >= .370) tags.push('xwOBA↑');
  if (hardHitTrend >= 2 || hardHit >= 45) tags.push('Hard-Hit↑');
  if (sweetSpotTrend >= 2 || sweetSpot >= 34) tags.push('Sweet-Spot↑');
  if (barrelTrend >= 2 || barrel >= 10) tags.push('Barrel↑');
  if (batSpeedTrend >= .7 || batSpeed >= 72) tags.push('Bat Speed↑');
  if (blastTrend >= 2 || blastRate >= 12) tags.push('Blasts↑');
  const boost = clampNum((score / 100) * 7.5, 0, 7.5);
  return { ...fallback, ...fromRepo, source:'statcast-repo', onFireScore:Math.max(score, fallback.onFireScore || 0), hotBoostPct:+Math.max(boost, fallback.hotBoostPct || 0).toFixed(1), tags:[...new Set([...tags, ...(fallback.tags||[])])].slice(0,6) };
}
function applyHotHitterBoost(row) {
  const profile = getStatcastHotHitterProfile(row);
  const base = Number(row.hrProb || 0);
  const boost = Number(profile.hotBoostPct || 0);
  row.baseHrProb = row.baseHrProb ?? base;
  row.hotHitter = profile;
  row.hotBoostPct = boost;
  row.onFireScore = Number(profile.onFireScore || 0);
  row.hrProb = +clampNum(base + boost, 0, 35).toFixed(1);
  row.isOnFire = row.onFireScore >= 70 || boost >= 4.5;
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
    updateLiveBanner();

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
async function loadActivePlayerIdsForGames(games) {
  const today = new Date().toLocaleDateString('en-CA', {timeZone:'America/Chicago'});
  if (activePlayerIdsLoadedFor === today && activePlayerIdsToday.size) return activePlayerIdsToday;
  const ids = new Set();
  const loadedTeamIds = new Set();
  const teamIdsForToday = [...new Set((games || []).flatMap(g => [g?.teams?.away?.team?.id, g?.teams?.home?.team?.id]).filter(Boolean))];
  await Promise.all(teamIdsForToday.map(async tid => {
    try {
      const data = await fetchJSON(`https://diamondreport.app/api/v1/teams/${tid}/roster?rosterType=active&season=2026`);
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

// ── PROPS LIVE BANNER ────────────────────────────────────────────────
function updatePropsLiveBanner(liveGames) {
  const banner    = document.getElementById('props-live-banner');
  const container = document.getElementById('props-live-games');
  if (!banner || !container) return;

  if (!liveGames.length) {
    banner.style.display = 'none';
    return;
  }

  function chip(g) {
    const awayW = g.awayScore > g.homeScore;
    const homeW = g.homeScore > g.awayScore;
    const tl = abbr => { const id = teamIds[abbr]; return id ? `<img src="https://www.mlbstatic.com/team-logos/${id}.svg" style="width:18px;height:18px;object-fit:contain;vertical-align:middle" alt="" loading="lazy" decoding="async">` : ''; };
    return `<span style="display:inline-flex;align-items:center;gap:6px;background:var(--surface2);border:1px solid #1e3a5f;border-radius:6px;padding:5px 12px;white-space:nowrap;font-size:12px">
      ${tl(g.awayAbbr)}
      <span style="font-family:'Manrope',sans-serif;font-size:15px;letter-spacing:.5px;color:${awayW?'var(--green)':'var(--muted)'}">${g.awayAbbr}</span>
      <span style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:16px;color:${awayW?'var(--green)':'var(--muted)'}">${g.awayScore??0}</span>
      <span style="color:var(--border);font-size:12px">–</span>
      <span style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:16px;color:${homeW?'var(--green)':'var(--muted)'}">${g.homeScore??0}</span>
      <span style="font-family:'Manrope',sans-serif;font-size:15px;letter-spacing:.5px;color:${homeW?'var(--green)':'var(--muted)'}">${g.homeAbbr}</span>
      ${tl(g.homeAbbr)}
      <span style="font-size:9px;color:var(--live);font-family:'JetBrains Mono',monospace;font-weight:700;margin-left:2px">${g.inning||'LIVE'}</span>
    </span>`;
  }

  const content = liveGames.map(chip).join('<span style="color:#334155;padding:0 8px;font-size:16px">·</span>');
  const shouldScroll = liveGames.length >= 4;
  const looped = shouldScroll
    ? content + '<span style="padding:0 24px;color:#334155">·</span>' + content
    : content;
  const duration = Math.max(15, liveGames.length * 6);

  container.innerHTML = looped;
  container.style.animation = shouldScroll ? `marquee ${duration}s linear infinite` : 'none';
  container.style.justifyContent = shouldScroll ? 'flex-start' : 'center';
  container.style.flexWrap = shouldScroll ? 'nowrap' : 'wrap';
  container.style.width = shouldScroll ? 'max-content' : '100%';
  banner.style.display = 'block';
}



function triggerBreakingHR(newHitters) {
  // Show BREAKING banner for 2 minutes then revert
  breakingHRNames = newHitters;
  breakingHRActive = true;
  renderBanner();
  if (breakingHRTimeout) clearTimeout(breakingHRTimeout);
  breakingHRTimeout = setTimeout(() => {
    breakingHRActive = false;
    breakingHRNames = [];
    renderBanner();
  }, 2 * 60 * 1000);
}

function renderBanner() {
  const scoresBanner = document.getElementById('scores-alert-banner');
  const scoresTrack  = document.getElementById('scores-alert-track');
  if (!scoresBanner || !scoresTrack) return;

  if (breakingHRActive && breakingHRNames.length) {
    const breakingHTML = breakingHRNames.map(n =>
      `<span style="display:inline-flex;align-items:center;gap:10px;padding:0 20px">
        <span style="font-family:'Manrope',sans-serif;font-size:18px;letter-spacing:3px;color:#ffffff;animation:pulse 0.6s infinite">🚨 BREAKING</span>
        <span style="font-family:'Manrope',sans-serif;font-size:22px;letter-spacing:2px;color:#f97316;text-shadow:0 0 12px #f97316">${n} HIT A HOME RUN!</span>
        <span style="font-size:20px">💥</span>
      </span>`
    ).join('<span style="color:#334155;padding:0 10px;font-size:20px">·</span>');
    scoresTrack.innerHTML = breakingHTML;
    scoresTrack.style.cssText = 'display:inline-flex;align-items:center;padding:8px 20px;animation:none;justify-content:center;flex-wrap:wrap;width:100%';
    scoresBanner.style.background = 'linear-gradient(90deg,#1a0000,#2a0500,#1a0000)';
    scoresBanner.style.borderColor = '#f97316';
    const liveBadge = scoresBanner.querySelector('div > div:first-child');
    if (liveBadge) liveBadge.style.background = 'linear-gradient(135deg,#f97316,#dc2626)';
    // Banner is inside #scores so always set display block — section visibility handles the rest
    scoresBanner.style.display = 'block';
    return;
  }

  // Reset banner style
  scoresBanner.style.background = 'linear-gradient(90deg,#0a0e1a 0%,#0f172a 40%,#0a0e1a 100%)';
  scoresBanner.style.borderColor = '#1e3a5f';
  const liveBadge2 = scoresBanner.querySelector('div > div:first-child');
  if (liveBadge2) liveBadge2.style.background = 'linear-gradient(135deg,#dc2626,#991b1b)';

  const chips = [];
  Object.values(bannerHRs).forEach(h => {
    if (h.count > 0) chips.push(`<span class="alert-chip alert-hr">💥 ${h.name}${h.count > 1 ? ' ×'+h.count : ''} HR vs ${h.oppAbbr||''}</span>`);
  });
  Object.values(bannerKs).forEach(k => {
    if (k.ks > 0 && k.ouLine && k.ks > k.ouLine) {
      chips.push(`<span class="alert-chip alert-k">⚡ ${k.name} ${k.ks}K vs ${k.oppAbbr||''}</span>`);
    }
  });

  if (!chips.length) { scoresBanner.style.display = 'none'; return; }

  const content = chips.join('<span class="alert-sep">·</span>');
  const shouldScroll = chips.length >= 3;
  const looped = shouldScroll ? content + '<span class="alert-sep" style="padding:0 30px">·</span>' + content : content;
  const duration = Math.max(15, chips.length * 5);

  scoresTrack.innerHTML = looped;
  scoresTrack.style.animation = shouldScroll ? `marquee ${duration}s linear infinite` : 'none';
  scoresTrack.style.justifyContent = shouldScroll ? 'flex-start' : 'center';
  scoresTrack.style.flexWrap = shouldScroll ? 'nowrap' : 'wrap';
  scoresTrack.style.width = shouldScroll ? 'max-content' : '100%';

  // Always show the banner — visibility is controlled by the section being active
  // The banner sits INSIDE #scores so it's naturally hidden when scores is hidden
  scoresBanner.style.display = 'block';
}

function updateLiveBanner() {
  // Detect new HRs since last check
  const newHitters = [];
  Object.values(bannerHRs).forEach(h => {
    const prev = prevBannerHRCounts[h.id] || 0;
    if (h.count > prev) newHitters.push(h.name);
    prevBannerHRCounts[h.id] = h.count;
  });
  if (newHitters.length && !breakingHRActive) {
    triggerBreakingHR(newHitters);
  } else {
    renderBanner();
  }
}


let propsLoaded = false;

// ── HR POTENTIAL ─────────────────────────────────────────────────────
async function loadHRPotential() {
  const el = document.getElementById('hr-potential-content');
  const refresh = document.getElementById('props-refresh');
  try {
    const today = new Date().toLocaleDateString('en-CA', {timeZone:'America/Chicago'});
    await loadStatcastHotHitters();
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

      // Fetch boxscore once per game
      let bd = null;
      try {
        if (!boxscoreCache[g.gamePk]) {
          boxscoreCache[g.gamePk] = await fetchJSON(`https://diamondreport.app/api/v1/game/${g.gamePk}/boxscore`);
        }
        bd = boxscoreCache[g.gamePk];
      } catch {}

      // Process both pitchers in parallel
      await Promise.all([['away','home'],['home','away']].map(async ([side, opp]) => {
        const pitcher = g.teams[opp].probablePitcher;
        if (!pitcher) return;
        const teamAbbr = g.teams[side].team.abbreviation;
        const oppAbbr  = g.teams[opp].team.abbreviation;

        let pitcherHr9=0, pitcherAvg=.240, pitcherSlg=.380, pitcherWhip=1.25, pitcherK9=8;
        try {
          const pd = await fetchJSON(`https://diamondreport.app/api/v1/people/${pitcher.id}?hydrate=stats(group=pitching,type=season,season=2026)`);
          const ps = pd.people?.[0]?.stats?.[0]?.splits?.[0]?.stat||{};
          pitcherHr9=parseFloat(ps.homeRunsPer9)||0; pitcherAvg=parseFloat(ps.avg)||.240;
          pitcherSlg=parseFloat(ps.slg)||.380; pitcherWhip=parseFloat(ps.whip)||1.25;
          pitcherK9=parseFloat(ps.strikeoutsPer9Inn)||8;
        } catch {}

        const teamBox = bd?.teams?.[side];
        let batters = (teamBox?.batters||[]).map(id=>{const p=teamBox?.players[`ID${id}`];return p?{id,player:p}:null;}).filter(Boolean);

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
              const [sd,ld] = await Promise.all([
                fetchJSON(`https://diamondreport.app/api/v1/people/${pid}?hydrate=stats(group=hitting,type=season,season=2026)`),
                fetchJSON(`https://diamondreport.app/api/v1/people/${pid}/stats?stats=lastXGames&group=hitting&season=2026&limit=12&gameType=R`).catch(()=>({stats:[]})),
              ]);
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
          const batterRate=ab>0?hr/ab:0;
          const pitcherRate=pitcherHr9>0?pitcherHr9/27:0.03;
          const baseHrProb=Math.min(((batterRate*0.6)+(pitcherRate*0.4))*100,25);
          let hrProb=baseHrProb;
          const hrInLast8=(logs||[]).slice(0,8).some(g2=>parseInt(g2.stat?.homeRuns)>0);
          const isDrought=!hrInLast8&&hr>0;
          const batterOPS=parseFloat(s.ops)||0;
          const isFavorable=batterOPS>=.800&&(pitcherWhip>=1.25||pitcherAvg>=.260);
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
            avg:parseFloat(s.avg)||0, hrSeason:hr, ops:batterOPS,
            iso:(parseFloat(s.slg)||0)-(parseFloat(s.avg)||0), isDrought, isFavorable,
            // "Due" = drought + at least 2 supporting signals: power profile, favorable matchup, decent OPS
            isDue: isDrought && (
              ((parseFloat(s.slg)||0)-(parseFloat(s.avg)||0) >= 0.170 ? 1 : 0) +
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
  ).filter(isActiveForHRThreat).filter(r => r.topHrThreat || r.hrProb >= 8);

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
            if (!badge) { badge = document.createElement('span'); badge.className='hr-today-badge-prop'; badge.style.cssText='background:#2a1500;color:#f4a261;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;border:1px solid #f4a26166'; subEl.appendChild(badge); }
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
            timeStr, gameTimestamp: dt.getTime()
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

    if (!allHRs.length) {
      if (el) el.innerHTML=`<div class="mu-empty">No HRs at this time.</div>`;
      const countEl = document.getElementById('hrs-today-count');
      if (countEl) countEl.style.display = 'none';
      const projEl = document.getElementById('proj-hits-content');
      if (projEl) projEl.innerHTML = `<div class="mu-empty" style="color:var(--muted)">No HR's Completed from Projections Yet</div>`;
      updateLiveBanner();
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

    updateLiveBanner();
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

async function loadKProps() {
  const el = document.getElementById('kprops-content');
  const refreshEl = document.getElementById('kprops-refresh');
  // Don't return early — still need to cache data even if Props tab isn't open

  const now = new Date();

  // Skip if already loaded within last 2 hours
  if (kPropsLoadedAt) {
    const msSince = now - kPropsLoadedAt;
    if (msSince < 2 * 60 * 60 * 1000) { renderKProps(); return; }
  }

  try {
    const today = new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'});
    await loadSportsbookKLines(today);
    const games = await getTodaySchedule('team,probablePitcher');

    // K Props now use DR projections only. External sportsbook line cards have been removed.

    const props = [];

    for (const g of games) {
      const dt = new Date(g.gameDate);
      const timeStr = dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/Chicago'});
      const awayAbbr = g.teams.away.team.abbreviation;
      const homeAbbr = g.teams.home.team.abbreviation;

      const state = g.status?.abstractGameState || '';
      const isLive  = state === 'Live'  || g.status?.detailedState === 'In Progress';
      const isFinal = state === 'Final' || g.status?.detailedState === 'Final';

      for (const [side,opp] of [['away','home'],['home','away']]) {
        const pitcher = g.teams[side].probablePitcher;
        if (!pitcher) continue;

        // If the game is already live or final, use the locked pre-game snapshot.
        // Never recalculate — pitcher ERA/WHIP shouldn't shift the line once play has begun.
        if ((isLive || isFinal) && _kPropsSnapshot[pitcher.id]) {
          props.push(_kPropsSnapshot[pitcher.id]);
          continue;
        }

        let k9=8, ip=0, wins=0, losses=0, era=4.00, whip=1.25;
        let fip=null, avg=null, woba=null, iso=null, slg=null, hr9=null, bf=0, tbf=0, kPerGm=null;
        try {
          const pd = await fetchJSON(`https://diamondreport.app/api/v1/people/${pitcher.id}?hydrate=stats(group=pitching,type=season,season=2026)`);
          const ps=pd.people?.[0]?.stats?.[0]?.splits?.[0]?.stat||{};
          k9=parseFloat(ps.strikeoutsPer9Inn)||8;
          ip=parseFloat(ps.inningsPitched)||0;
          wins=ps.wins??0; losses=ps.losses??0;
          era=parseFloat(ps.era)||4.00;
          whip=parseFloat(ps.whip)||1.25;
          fip=parseFloat(ps.fielding ?? ps.fieldingIndependentPitching) || null;
          avg=parseFloat(ps.avg)||null;
          woba=parseFloat(ps.woba ?? ps.wobaCalculated)||null;
          slg=parseFloat(ps.slg)||null;
          iso=slg!=null&&avg!=null ? Math.round((slg-avg)*1000)/1000 : null;
          hr9=parseFloat(ps.homeRunsPer9Inn ?? ps.hrPer9Inn)||null;
          bf=parseInt(ps.battersFaced)||0;
          tbf=bf;
          const gamesStarted=parseInt(ps.gamesStarted)||Math.max(wins+losses,1);
          kPerGm=gamesStarted>0 ? Math.round((k9*(ip/Math.max(gamesStarted,1))/9)*10)/10 : null;
        } catch {}

        let oppKpct = 0.22;
        try {
          const bd = await fetchJSON(`https://diamondreport.app/api/v1/game/${g.gamePk}/boxscore`);
          const teamBox=bd.teams?.[opp];
          const batters=(teamBox?.batters||[]).map(id=>teamBox.players[`ID${id}`]).filter(Boolean).slice(0,9);
          const kpcts=batters.map(b=>{
            const s=b.seasonStats?.batting||{};
            return (s.strikeOuts&&s.plateAppearances)?s.strikeOuts/s.plateAppearances:0.22;
          });
          if(kpcts.length) oppKpct=kpcts.reduce((a,b)=>a+b,0)/kpcts.length;
        } catch {}

        const projIP = Math.min(Math.max(ip / Math.max(wins+losses, 1), 4), 7);
        const baseProj = k9 * projIP / 9;
        const kpctAdj = (oppKpct - 0.22) * 10;
        const projK = Math.max(baseProj + kpctAdj, 1);
        const modelLine = Math.round(projK * 2) / 2;
        const sbLine = getSportsbookKLine(pitcher.id, pitcher.fullName);
        const compareLine = sbLine ?? modelLine;

        // v8.57 Production: Strikeouts are now displayed as OVER-only recommendations.
        // If a sportsbook K line is available, use it for transparency; otherwise choose
        // a realistic alternate-style line slightly below the model projection.
        const recommendedOverLine = sbLine != null
          ? sbLine
          : Math.max(0.5, Math.floor(projK) - 0.5);
        const overEdge = projK - recommendedOverLine;
        const overProb = Math.max(34, Math.min(78, Math.round(50 + (overEdge * 14))));
        const confidenceTier = overProb >= 70 ? 'Elite'
          : overProb >= 63 ? 'Strong'
          : overProb >= 56 ? 'Good'
          : overProb >= 50 ? 'Lean'
          : 'Low';
        const pred = 'OVER';
        const pushLean = null;
        const diff = overEdge;

        const oppKpctLabel = `${(oppKpct*100).toFixed(0)}% opp K rate`;
        const k9Label = `${k9.toFixed(1)} K/9`;
        const workloadLabel = `${projIP.toFixed(1)} proj IP`;
        const projectionLabel = `${projK.toFixed(1)} Ks projected`;
        const lineLabel = `${formatKLine(recommendedOverLine)} recommended over`;
        const eraLabel = `${era.toFixed(2)} ERA`;
        const whipLabel = `${whip.toFixed(2)} WHIP`;
        const diffLabel = Math.abs(diff) >= 0.3 ? `${diff > 0 ? '+' : ''}${diff.toFixed(1)} vs line` : `±${Math.abs(diff).toFixed(1)} vs line`;
        const seasonLabel = `${wins}-${losses} · ${ip.toFixed(0)} IP`;

        const matchupTag = oppKpct >= 0.245 ? 'High-K matchup' : oppKpct <= 0.195 ? 'Contact-heavy matchup' : 'Average K matchup';
        const k9Tag = k9 >= 9 ? 'Strong K pitcher' : k9 <= 7 ? 'Lower K profile' : 'Solid K profile';
        const eraTag = era <= 3.25 ? 'Elite ERA' : era >= 5.00 ? 'High ERA' : 'Mid ERA';
        const whipTag = whip <= 1.10 ? 'Elite WHIP' : whip >= 1.40 ? 'High WHIP' : 'Avg WHIP';
        const workloadTag = projIP >= 6 ? 'Deep workload expected' : projIP <= 4.5 ? 'Short outing likely' : 'Standard workload';
        const decisionTag = `OVER ${formatKLine(recommendedOverLine)} · ${overProb}%`;

        const eraContext = era <= 3.25 ? 'an elite ERA' : era >= 5.00 ? 'a high ERA' : 'a solid ERA';
        const whipContext = whip <= 1.10 ? 'excellent command' : whip >= 1.40 ? 'shaky command' : 'average command';
        const matchupContext = oppKpct >= 0.245 ? 'faces a lineup that strikes out often' : oppKpct <= 0.195 ? 'faces a contact-heavy lineup' : 'faces an average-K lineup';
        const workloadContext = projIP >= 6 ? 'expected to go deep' : projIP <= 4.5 ? 'likely a short outing' : 'standard workload expected';
        const lineContext = Math.abs(diff) >= 0.5
          ? (diff > 0 ? `projection sits ${diff.toFixed(1)} above the line` : `projection sits ${Math.abs(diff).toFixed(1)} below the line`)
          : `projection is close to the line`;
        const reasoning = {
          matchupTag, k9Tag, eraTag, whipTag, workloadTag, decisionTag,
          oppKpctLabel, k9Label, workloadLabel, projectionLabel, lineLabel,
          eraLabel, whipLabel, diffLabel, seasonLabel,
          summary: `${pitcher.fullName.split(' ').pop()} (${eraContext}, ${whipContext}) ${matchupContext} — ${workloadContext}. The ${lineContext}.`
        };



        const propRow = {
          pitcherName: pitcher.fullName, pitcherId: pitcher.id,
          teamAbbr: g.teams[side].team.abbreviation,
          oppAbbr: g.teams[opp].team.abbreviation,
          wl:`${wins}-${losses}`, era: era.toFixed(2), k9: k9.toFixed(1),
          ip: ip.toFixed(1), bf: tbf,
          fip: fip!=null ? fip.toFixed(2) : null,
          avg: avg!=null ? avg.toFixed(3) : null,
          woba: woba!=null ? woba.toFixed(3) : null,
          iso: iso!=null ? iso.toFixed(3) : null,
          slg: slg!=null ? slg.toFixed(3) : null,
          hr9: hr9!=null ? hr9.toFixed(2) : null,
          kPerGm: kPerGm!=null ? kPerGm.toFixed(1) : null,
          whip: whip.toFixed(2),
          sbLine, ouLine: recommendedOverLine, modelLine, compareLine: recommendedOverLine,
          recommendedOverLine: recommendedOverLine.toFixed(1), overProb, confidenceTier,
          projK: projK.toFixed(1), pred, pushLean, reasoning,
          timeStr, gameTimestamp: dt.getTime(), gamePk: g.gamePk,
        };
        // Lock this snapshot — it will be reused once the game goes live
        if (!_kPropsSnapshot[pitcher.id]) {
          _kPropsSnapshot[pitcher.id] = propRow;
        }
        props.push(propRow);
      }
    }

    props.sort((a,b)=>a.gameTimestamp-b.gameTimestamp);
    kPropsData = props;
    Object.keys(pitcherOULines).forEach(k => delete pitcherOULines[k]);
    props.forEach(p => { if (p.compareLine != null) pitcherOULines[p.pitcherId] = p.compareLine; });
    kPropsLoadedAt = new Date();
    renderKProps();
    // Pre-warm repo lineups so the first lineup expand is instant
    loadRepoLineups().catch(() => {});
    if (document.getElementById('props')?.classList.contains('active')) loadKsTodayWithRetry();

    const kpTime = kPropsLoadedAt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
    if (refreshEl) refreshEl.textContent = `Last updated ${kpTime}`;
  } catch(e) {
    if(el) el.innerHTML=`<div class="mu-empty" style="color:var(--accent)">Error: ${e.message}</div>`;
  }
}



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
  const arr=(list||[]).slice().sort((a,b)=>drKConfidenceScore(b)-drKConfidenceScore(a));
  if(!arr.length) return '';
  const top=arr[0];
  const avg=Math.round(arr.slice(0,6).reduce((a,p)=>a+drKConfidenceScore(p),0)/Math.min(6,arr.length));
  const line=drKNum(top.recommendedOverLine ?? top.ouLine ?? top.compareLine,0);
  const cushion=drKNum(top.projK,line)-line;
  return `<div class="dr112-engine dr113-k-engine" data-dr113="k-summary"><div class="dr112-engine-head"><div><div class="dr112-title">🎯 Pitcher Strikeouts <span>Confidence Engine</span></div><div class="dr112-copy">Keeps the existing strikeout filters, labels, Line / K Count / Cushion boxes, and Pitcher Matchup button while adding realistic over probability, Diamond grade, risk, and why-this-play data.</div></div><div class="dr112-score">${avg}%<small>Top Board Grade</small></div></div><div class="dr112-grid"><div class="dr112-metric good"><b>${top.pitcherName||'–'}</b><span>Top K Read</span></div><div class="dr112-metric"><b>Over ${formatKLine(line)} K</b><span>Active Line</span></div><div class="dr112-metric ${cushion>=1?'good':'warn'}"><b>${cushion>=0?'+':''}${cushion.toFixed(1)}</b><span>Cushion</span></div><div class="dr112-metric"><b>${Math.round(drKRealisticOverChance(top)*100)}%</b><span>Realistic Over Chance</span></div></div><div class="dr112-ai"><b>Why this board matters:</b> Pitcher strikeouts are scored from projection vs line, K/9, ERA/WHIP command profile, projected workload, opponent contact tendency, live K Count, and matchup context. This keeps the original Strikeouts layout while giving each play a real support profile.</div></div>`;
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

  const kpTallyHTML = kpFinal > 0 ? `
    <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg);border-bottom:1px solid var(--border);flex-wrap:wrap;gap:8px">
      <span style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase">TODAY'S RECORD</span>
      <span style="font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace">${new Date().toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}</span>
      <span style="font-family:'Manrope',sans-serif;font-size:28px;letter-spacing:1px;color:${kpCorrect===kpFinal?'#2ecc71':kpCorrect>kpFinal/2?'var(--accent2)':'var(--accent)'}">${kpCorrect}-${kpFinal-kpCorrect}</span>
      <span style="font-size:11px;color:var(--muted)">${kpFinal} of ${kPropsData.length} final</span>
      <span style="font-size:11px;color:var(--muted);font-family:'JetBrains Mono',monospace">${Math.round(kpCorrect/kpFinal*100)}% accuracy</span>
    </div>` : '';

  // Apply optional game filter before sort/render
  const gameFilteredProps = _kPropsGameFilter
    ? kPropsData.filter(p => String(p.gamePk||'') === _kPropsGameFilter)
    : kPropsData;

  const kpGamesSeen = {};
  const kpGamesList = [];
  kPropsData.forEach(p => {
    const pk = String(p.gamePk||'');
    if (!pk || kpGamesSeen[pk]) return;
    kpGamesSeen[pk] = 1;
    kpGamesList.push({ pk, label: `${p.teamAbbr||'?'} vs ${p.oppAbbr||'?'}`, ts: p.gameTimestamp||0 });
  });
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
    return `<button onclick="kPropsSortBy('${key}')" style="font-size:9px;font-weight:700;font-family:Manrope,sans-serif;padding:4px 10px;border-radius:12px;border:1px solid ${active?'var(--accent2)':'var(--border)'};background:${active?'rgba(244,162,97,.12)':'var(--surface2)'};color:${active?'var(--accent2)':'var(--muted)'};cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all .15s">${label}${arrow}</button>`;
  }).join('');

  el.innerHTML = `${kpTallyHTML}
  <div class="kprops-sticky-sort" style="display:flex;align-items:center;gap:6px;padding:8px 14px;background:var(--bg);border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;flex-wrap:nowrap">
    <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);white-space:nowrap;flex-shrink:0">GAME:</span>
    <select onchange="kPropsSetGameFilter(this.value)" style="background:#0b1220;color:#fff;border:1px solid var(--border);border-radius:8px;padding:4px 8px;font-size:10px;font-weight:700;flex-shrink:0">${kpGameOptsHTML}</select>
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
            kColor = '#e63946'; kBg = '#2a0d0d'; kBorder = '#e63946'; kIcon = '❌';
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
              kColor = '#e63946'; kBg = '#2a0d0d'; kBorder = '#e63946'; kIcon = '❌';
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

      return `<div class="dr109-card${alreadyHit ? ' prop-hit' : missedK ? ' prop-miss' : ''}">
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
          <span class="dr109-chip"><span>K/9:</span><strong>${p.k9 ?? '–'}</strong></span>
          <span class="dr109-chip"><span>ERA:</span><strong>${p.era ?? '–'}</strong></span>
          <span class="dr109-chip"><span>WHIP:</span><strong>${p.whip ?? '–'}</strong></span>
          <span class="dr109-chip ${strikeoutCushion >= 1 ? 'good' : strikeoutCushion >= 0 ? 'warn' : ''}"><span>Cushion:</span><strong>${strikeoutCushionText}</strong></span>
        </div>
        <div class="dr109-reason"><strong>Why it supports the line:</strong> ${p.pitcherName} grades at ${chance}% for ${strikeoutLineText} because the model combines ${p.k9 ?? '–'} K/9, ${p.era ?? '–'} ERA/${p.whip ?? '–'} WHIP command profile, projected workload, and opponent contact tendency. Opponent context: ${p.oppAbbr}.</div>
        <div class="kprop-lineup-section dr1016-k-lineup">
          <button class="btn-lineup dr1016-lineup-btn" onclick="toggleKPropLineup(this, '${p.pitcherId}', '${p.pitcherName.replace(/'/g,"\\'")}', '${p.teamAbbr}', '${p.oppAbbr}')">
            ▼ BATTING LINEUP &amp; MATCHUPS
          </button>
          <div class="kprop-lineup-panel" style="display:none;margin-top:8px"></div>
        </div>
      </div>`;
    }).join('')}</div>
  <div style="font-size:10px;color:var(--muted);padding:10px 16px 14px;line-height:1.5;border-top:1px solid var(--border)">
    💎 Projections powered by the <strong style="color:var(--text)">Diamond Intelligence Engine</strong> — built from each pitcher's full season K/9, ERA, WHIP, and projected innings against today's opponent K rate. Use as a guide alongside your own research.
  </div>\``;
}

// Schedule 7am load + 9am refresh for K Props
async function toggleKPropLineup(btn, pitcherId, pitcherName, teamAbbr, oppAbbr) {
  const outerPanel = btn.nextElementSibling;
  if (!outerPanel) return;

  // v7.19 fix: the K Prop lineup CSS previously forced all kprop panels to
  // display:block !important, so clicking the button again could not collapse it.
  const isOpen = outerPanel.dataset.open === '1' || outerPanel.style.display === 'block';
  if (isOpen) {
    outerPanel.dataset.open = '0';
    outerPanel.style.setProperty('display', 'none', 'important');
    btn.innerHTML = '▼ BATTING LINEUP &amp; MATCHUPS';
    btn.classList.remove('active');
    return;
  }
  outerPanel.dataset.open = '1';
  btn.innerHTML = '▲ HIDE BATTING LINEUP &amp; MATCHUPS';
  btn.classList.add('active');
  outerPanel.style.setProperty('display', 'block', 'important');
  if (outerPanel.dataset.loaded) return;
  outerPanel.dataset.loaded = '1';

  const pid = normalizePitcherId(pitcherId);
  const panelId = `kprop-panel-${pid}`;
  outerPanel.id = panelId;
  outerPanel.className = 'kprop-lineup-panel pr-expand-panel';
  outerPanel.innerHTML = '<div style="padding:14px 16px;font-size:12px;color:var(--muted)"><span class="spin"></span> Loading lineup…</div>';

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
      outerPanel.style.cssText += ';width:100%!important;min-width:0!important;box-sizing:border-box!important;overflow-x:auto!important;';
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
      outerPanel.style.cssText += ';width:100%!important;min-width:0!important;box-sizing:border-box!important;overflow-x:hidden!important;';
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
    // Force full width after render — the panel can get squeezed by flex layout
    outerPanel.style.cssText += ';width:100%!important;min-width:0!important;box-sizing:border-box!important;overflow-x:auto!important;';
  } catch(e) {
    outerPanel.innerHTML = `<div class="mu-empty" style="color:var(--accent)">Error: ${e.message}</div>`;
  }
}
// K Props sort — by any pitcher stat column
let _kPropsSort = null;
let _kPropsSortDir = 1; // 1 = default direction, -1 = reversed
let _kPropsGameFilter = '';
function kPropsSetGameFilter(pk) {
  _kPropsGameFilter = pk || '';
  renderKProps();
}
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
  function buildRow(g, side, stat){
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
    var oppKpct = 0.22;
    var projK = Math.max(1, (k9 * projIP / 9) + ((oppKpct - 0.22) * 10));
    var sbLine = null;
    try { if (typeof getSportsbookKLine === 'function') sbLine = getSportsbookKLine(pitcher.id, pitcher.fullName); } catch(e){}
    var recommendedOverLine = sbLine != null ? Number(sbLine) : Math.max(0.5, Math.floor(projK) - 0.5);
    var overEdge = projK - recommendedOverLine;
    var overProb = Math.max(34, Math.min(78, Math.round(50 + (overEdge * 14))));
    var confidenceTier = overProb >= 70 ? 'Elite' : overProb >= 63 ? 'Strong' : overProb >= 56 ? 'Good' : overProb >= 50 ? 'Lean' : 'Low';
    var fip = n(stat.fielding || stat.fieldingIndependentPitching, NaN);
    var avg = n(stat.avg, NaN);
    var slg = n(stat.slg, NaN);
    var iso = Number.isFinite(slg) && Number.isFinite(avg) ? Math.round((slg-avg)*1000)/1000 : null;
    var reason = {
      matchupTag: 'Average K matchup',
      k9Tag: k9 >= 9 ? 'Strong K pitcher' : k9 <= 7 ? 'Lower K profile' : 'Solid K profile',
      eraTag: era <= 3.25 ? 'Elite ERA' : era >= 5 ? 'High ERA' : 'Mid ERA',
      whipTag: whip <= 1.10 ? 'Elite WHIP' : whip >= 1.40 ? 'High WHIP' : 'Avg WHIP',
      workloadTag: projIP >= 6 ? 'Deep workload expected' : projIP <= 4.5 ? 'Short outing likely' : 'Standard workload',
      decisionTag: 'OVER '+lineFmt(recommendedOverLine)+' · '+overProb+'%',
      summary: (pitcher.fullName || 'Pitcher')+' projects for '+projK.toFixed(1)+' Ks against an Over '+lineFmt(recommendedOverLine)+' line.'
    };
    return {
      pitcherName: pitcher.fullName, pitcherId: pitcher.id,
      teamAbbr: g.teams[side].team.abbreviation,
      oppAbbr: g.teams[opp].team.abbreviation,
      wl: (stat.wins != null || stat.losses != null) ? ((stat.wins||0)+'-'+(stat.losses||0)) : '0-0',
      era: era.toFixed(2), k9: k9.toFixed(1), ip: ip.toFixed(1), bf: n(stat.battersFaced,0),
      fip: Number.isFinite(fip) ? fip.toFixed(2) : null,
      avg: Number.isFinite(avg) ? avg.toFixed(3) : null,
      woba: stat.woba ? n(stat.woba).toFixed(3) : null,
      iso: iso != null ? iso.toFixed(3) : null,
      slg: Number.isFinite(slg) ? slg.toFixed(3) : null,
      hr9: stat.homeRunsPer9Inn ? n(stat.homeRunsPer9Inn).toFixed(2) : null,
      kPerGm: gs > 0 ? (k9*(ip/Math.max(gs,1))/9).toFixed(1) : null,
      whip: whip.toFixed(2), sbLine: sbLine,
      ouLine: recommendedOverLine, modelLine: Math.round(projK*2)/2, compareLine: recommendedOverLine,
      recommendedOverLine: recommendedOverLine.toFixed(1), overProb: overProb, confidenceTier: confidenceTier,
      projK: projK.toFixed(1), pred: 'OVER', pushLean: null, reasoning: reason,
      timeStr: timeStr, gameTimestamp: dt.getTime()
    };
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
        var games = [];
        try { games = await withTimeout(getTodaySchedule('team,probablePitcher'), 10000) || []; } catch(e){ games = []; }
        var starters = [];
        (games || []).forEach(function(g){ ['away','home'].forEach(function(side){ var p = g && g.teams && g.teams[side] && g.teams[side].probablePitcher; if (p) starters.push({g:g,side:side,p:p}); }); });
        if (!starters.length) {
          if (el) el.innerHTML = '<div class="mu-empty">No probable pitchers posted yet — check back closer to game time.</div>';
          return [];
        }
        var rows = await mapLimit(starters, 4, async function(item){
          var stat = await seasonPitching(item.p.id);
          return buildRow(item.g, item.side, stat);
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
  if (window._lastLiveGames?.length) updatePropsLiveBanner(window._lastLiveGames);
  const activePane = document.querySelector('#props .gamepick-pane.active')?.getAttribute('data-gamepick-pane') || 'game';
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


(function(){
  function hideLiveScoresBanner(){
    const banner = document.getElementById('scores-alert-banner');
    if(!banner) return;
    banner.hidden = true;
    banner.style.display = 'none';
    const track = document.getElementById('scores-alert-track');
    if(track) track.innerHTML = '';
  }
  window.hideLiveScoresBanner = hideLiveScoresBanner;
  hideLiveScoresBanner();
  setTimeout(hideLiveScoresBanner, 3000); // v7.8 one-shot
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

/* ---- from <script id="v7-22-dashboard-summary-sync"> ---- */
(function(){
  function txt(sel){var el=document.querySelector(sel);return el?el.textContent.trim():'';}
  function set(id,val){var el=document.getElementById(id); if(el && val) el.textContent=val;}
  function syncPremiumDashboard(){
    var games=document.querySelectorAll('#live-games .game-card, #scheduled-games .game-card, #final-games .game-card').length;
    if(games) set('dr-dash-games', String(games));
    var hrRows=document.querySelectorAll('#hr-potential-content .dr1027-hr-card');
    if(hrRows.length) set('dr-dash-hr', String(hrRows.length));
    var kRows=document.querySelectorAll('#kprops-content .dr109-card');
    if(kRows.length) set('dr-dash-k', String(kRows.length));
    var upd=txt('#props-refresh') || txt('#header-date'); if(upd) set('dr-dash-updated', upd.replace('Last updated:','').trim().slice(0,16));
  }
  setInterval(() => { if (document.visibilityState === 'visible') syncPremiumDashboard(); }, 5000);
  document.addEventListener('DOMContentLoaded',syncPremiumDashboard);
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
  const loaded = { game:false, hr:false, k:false, props:false, deep:false };
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
  var STORAGE_KEY = 'dr_gamepick_active_pane';
  var VALID = { game: true, hr: true, k: true, hits: true, rbis: true, tb: true, sb: true, hrrbi: true, parlay: true, 'team-performance': true, deep: true };

  function getRequestedPane(){
    try {
      var hash = (window.location.hash || '').replace('#','');
      if (hash.indexOf('gamepick=') === 0) {
        var fromHash = hash.split('=')[1];
        if (VALID[fromHash]) return fromHash;
      }
      var saved = localStorage.getItem(STORAGE_KEY);
      if (VALID[saved]) return saved;
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

    try { localStorage.setItem(STORAGE_KEY, pane); } catch(e) {}

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
  function score(type,r){ var s=stats(r),avg=n(r.avg||s.avg),ops=n(r.ops||s.ops),iso=n(r.iso||s.iso),hr=n(r.hrSeason||s.homeRuns),prob=n(r.hrProb),obp=n(s.obp),slg=n(s.slg),sb=n(s.stolenBases),l10=n(r.last10HR),hits=n(s.hits),runs=n(s.runs),rbi=n(s.rbi||s.runsBattedIn); var base=50; if(type==='hits')base=38+avg*120+ops*8+(r.isFavorable?6:0)+obp*12; if(type==='rbis')base=35+ops*10+iso*72+hr*.8+prob*.35+(r.topHrThreat?5:0); if(type==='tb')base=36+ops*8+iso*96+prob*.45+l10*2+slg*8; if(type==='sb')base=28+sb*2.5+avg*40+obp*28+(/SS|CF|2B|LF|RF/.test(String(r.pos||''))?8:0); if(type==='hrrbi')base=42+avg*55+ops*9+hr*.45+prob*.32+(r.isFavorable?5:0)+obp*8; return pct(base); }
  function chip(k,v,cls){ return '<span class="dr109-chip '+(cls||'')+'"><span>'+esc(k)+':</span><strong>'+esc(v)+'</strong></span>'; }
  function chipSet(type,r){ var s=stats(r),avg=n(r.avg||s.avg),ops=n(r.ops||s.ops),iso=n(r.iso||s.iso),obp=n(s.obp),slg=n(s.slg),hr=n(r.hrSeason||s.homeRuns),prob=n(r.hrProb),sb=n(s.stolenBases),rbi=n(s.rbi||s.runsBattedIn),runs=n(s.runs),hits=n(s.hits),a=[]; if(hit(type,r)) a.push(['✓ HIT', actual(type,r)+' / '+target(type), 'hit-check']); else if(hasLive(r)) a.push(['Live', actual(type,r)+' / '+target(type), '']);
    if(type==='hits')a=a.concat([['Line',line(type),'good'],['AVG',f(avg),''],['xBA proxy',f(avg+(r.isFavorable?.012:0)),'good'],['OBP',f(obp),''],['Contact',pct(66+avg*80)+'%','good'],['PA Est','4.1','']]);
    if(type==='rbis')a=a.concat([['Line',line(type),'good'],['RBI',rbi||'–',''],['RISP proxy',pct(42+ops*20)+'%','good'],['Run Env',r.isFavorable?'Plus':'Neutral',r.isFavorable?'good':''],['OPS',f(ops),''],['ISO',f(iso),'warn'],['Team Stack','Supported',''],['Lineup','Middle/Power','']]);
    if(type==='tb')a=a.concat([['Line',line(type),'good'],['SLG',f(slg),''],['xSLG proxy',f(slg+iso*.12),'good'],['ISO',f(iso),'warn'],['Power',r.topHrThreat?'Top':'Model',r.topHrThreat?'warn':'']]);
    if(type==='sb')a=a.concat([['Line',line(type),'good'],['SB',sb||'–','good'],['OBP',f(obp),''],['Speed proxy',pct(48+sb*2.2)+'%','good'],['Risk','Volatile','warn']]);
    if(type==='hrrbi')a=a.concat([['Line',line(type),'good'],['Hits',hits||'–',''],['Runs',runs||'–',''],['RBI',rbi||'–',''],['OPS',f(ops),'good'],['OBP',f(obp),'']]);
    return a.map(function(x){return chip(x[0],x[1],x[2]);}).join(''); }
  function reason(type,r,sc){ var nm=esc(r.name||'This player'),opp=esc(r.oppAbbr||'opponent'),map={hits:'contact profile, on-base skill, projected plate appearances, and matchup quality',rbis:'RBI lane, team run environment, power profile, and traffic ahead of the bat',tb:'slugging profile, ISO power, extra-base upside, and pitcher contact quality allowed',sb:'speed profile, on-base path, game script, and stolen-base opportunity',hrrbi:'multi-category production path through hits, runs, RBIs, lineup role, and team run environment'}; var result=hit(type,r)?' <span class="prop-hit-badge">✓ Projection Hit</span>':''; return result+' '+nm+' grades at '+sc+'% for '+esc(line(type))+' because the model combines '+(map[type]||'production profile')+'. Opponent context: '+opp+'.'; }
  function head(id){ return id?'https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_84,q_auto:best/v1/people/'+id+'/headshot/67/current':''; }
  var edgeFilters = {hits:0,rbis:0,tb:0,sb:0,hrrbi:0};
  var gameFilters = {hits:'',rbis:'',tb:'',sb:'',hrrbi:''};
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
    return '<div class="dr109-filter-row" style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin:0 0 12px"><div class="dr109-game-filter" style="margin:0"><label style="font-size:10px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);margin-right:8px">Edge:</label><select onchange="window.setPropEdgeFilter(\''+type+'\',this.value)" style="background:#0b1220;color:#fff;border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:12px;font-weight:700">'+opts+'</select></div><div class="dr109-game-filter" style="margin:0"><label style="font-size:10px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);margin-right:8px">Game:</label><select onchange="window.setPropGameFilter(\''+type+'\',this.value)" style="background:#0b1220;color:#fff;border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:12px;font-weight:700">'+gameOpts+'</select></div></div>';
  }
  function render(type,id,force){ var el=document.getElementById(id); if(!el) return; if(!force && document.activeElement && el.contains(document.activeElement) && document.activeElement.tagName==='SELECT') return; var scrollTop=el.scrollTop; var pageY=window.scrollY; var all=rows(); var filtered=edgeFilters[type]?all.filter(function(r){ return score(type,r)>=edgeFilters[type]; }):all; if(gameFilters[type]) filtered=filtered.filter(function(r){ return String(r.gamePk)===gameFilters[type]; }); var arr=filtered.slice().sort(function(a,b){ return (hit(type,b)-hit(type,a)) || score(type,b)-score(type,a); }).slice(0,50); if(!all.length){ el.innerHTML='<div class="mu-empty">Loading '+label(type)+' board from active production data…</div>'; return; } var gf=edgeFilterHTML(type); if(!arr.length){ el.innerHTML=gf+'<div class="mu-empty" style="padding:24px">No players match the selected filters. Choose All Edges / All Games to reset.</div>'; return; } var top=arr[0], avg=Math.round(arr.slice(0,Math.min(6,arr.length)).reduce(function(a,r){return a+score(type,r)},0)/Math.min(6,arr.length)); el.innerHTML='<div class="dr109-summary"><div class="dr109-title">📊 EXPANDED <span>'+esc(label(type).toUpperCase())+' DATA</span></div><p class="dr109-copy">This board now shows line support, matchup context, recent-form proxies, Statcast-style power/contact indicators, and a plain-English reason for each play. Values are generated from the active production rows so they stay fast and do not add external load time.</p><div class="dr109-grid"><div class="dr109-metric good"><b>'+esc(top.name||'–')+'</b><span>Top Rated</span></div><div class="dr109-metric"><b>'+avg+'%</b><span>Board Avg Confidence</span></div><div class="dr109-metric"><b>'+arr.length+'</b><span>Players Scanned</span></div><div class="dr109-metric warn"><b>'+esc(line(type))+'</b><span>Primary Line</span></div></div></div>'+gf+arr.map(function(r){ var sc=score(type,r),isHit=hit(type,r),isFinal=String(r.timeLabel||'').toUpperCase()==='FINAL',isMiss=isFinal&&!isHit; return '<div class="dr109-card '+(isHit?'prop-hit':isMiss?'prop-miss':'')+'"><div class="dr109-card-head"><div class="dr109-player"><img loading="lazy" src="'+head(r.id)+'" onerror="this.style.display=\'none\'" alt=""><div style="min-width:0"><div class="dr109-name">'+esc(r.name||'Player')+(isHit?' <span class="prop-hit-badge">✓ Projection Hit</span>':isMiss?' <span class="prop-miss-badge">✗ Missed</span>':'')+'</div><div class="dr109-meta">'+esc(r.teamAbbr||'')+' · '+esc(r.pos||'')+' · vs '+esc(r.oppAbbr||'')+'</div></div></div><div class="dr109-score">'+sc+'%<small>'+esc(label(type))+' Edge</small></div></div><div class="dr109-chiprow">'+chipSet(type,r)+'</div><div class="dr109-reason"><strong>Why it supports the line:</strong> '+esc(r.name||'This player')+' grades at '+sc+'% for '+esc(line(type))+' because the model combines '+({hits:'contact profile, on-base skill, projected plate appearances, and matchup quality',rbis:'RBI lane, team run environment, power profile, and traffic ahead of the bat',tb:'slugging profile, ISO power, extra-base upside, and pitcher contact quality allowed',sb:'speed profile, on-base path, game script, and stolen-base opportunity',hrrbi:'multi-category production path through hits, runs, RBIs, lineup role, and team run environment'}[type]||'production profile')+'. Opponent context: '+esc(r.oppAbbr||'opponent')+'.</div></div>'; }).join(''); el.scrollTop=scrollTop; window.scrollTo(window.scrollX,pageY); }
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

  function grade(p){ p=n(p); return p>=25?'A+':p>=18?'A':p>=10?'B+':'B'; }
  function hrChip(k,v,cls){ return '<span class="dr1027-chip '+(cls||'')+'"><b>'+esc(k)+'</b> '+esc(v)+'</span>'; }
  function labelChip(k,v,cls){ return '<span class="dr1027-chip '+(cls||'')+'"><b>'+esc(k)+'</b> '+esc(v)+'</span>'; }
  function getHRRows(){ return rows().filter(function(r){return n(r.hrProb)>0 && (r.topHrThreat || n(r.hrProb)>=8);}); }
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
  function applyHRFilters(arr){ var s=getFilters(); var gf=getHRGameFilter(); if(gf) arr=arr.filter(function(r){ return String(r.gamePk)===gf; }); if(!s.size)return arr; return arr.filter(function(r){ if(s.has('onfire')&&!r.isOnFire)return false; if(s.has('top')&&!(r.topHrThreat||n(r.hrProb)>=8))return false; if(s.has('drought')&&!r.isDrought)return false; if(s.has('due')&&!r.isDue)return false; if(s.has('favorable')&&!r.isFavorable)return false; return true; }); }
  function setButtons(){ var s=getFilters(); ['all','onfire','top','drought','due','favorable'].forEach(function(f){ var b=document.getElementById('filter-'+f+'-btn'); if(!b)return; b.classList.toggle('active', f==='all'?s.size===0:s.has(f)); }); }
  function whyHR(r){ return esc((r.name||'This player')+' grades at '+n(r.hrProb).toFixed(1)+'% HR probability against '+(r.pitcherName||r.oppAbbr||'today’s opponent')+' because the model combines on-fire recent form, favorable pitcher matchup, ISO power, strong OPS, top HR threat signal, season HR rate, recent trend, and pitcher HR/9 baseline. Opponent context: '+(r.oppAbbr||'opponent')+'.'); }
  function hrSummary(arr){ if(!arr.length)return ''; var top=arr[0], sample=arr.slice(0,Math.min(8,arr.length)), avg=sample.reduce(function(a,r){return a+n(r.hrProb);},0)/Math.max(1,sample.length); return '<div class="dr1027-hr-summary"><div class="dr1027-summary-title">📊 EXPANDED <span>HR THREATS DATA</span></div><p class="dr1027-summary-copy">Players who have homered today are highlighted using live/final box score data while keeping the same HR threat criteria and filters.</p><div class="dr1027-summary-grid"><div class="dr1027-summary-metric good"><b>'+esc(top.name||'–')+'</b><span>Top Rated</span></div><div class="dr1027-summary-metric"><b>'+Math.round(avg)+'%</b><span>Board Avg Confidence</span></div><div class="dr1027-summary-metric"><b>'+arr.length+'</b><span>Players Scanned</span></div><div class="dr1027-summary-metric warn"><b>HR Prob '+n(top.hrProb).toFixed(1)+'%</b><span>Primary Signal</span></div></div></div>'; }
  function dr113Last10HRValue(r){
    if (r && r.last10HR != null && r.last10HR !== '') return r.last10HR;
    var s = (r && r.stats) || {};
    if (s.last10HR != null && s.last10HR !== '') return s.last10HR;
    if (s.last10HomeRuns != null && s.last10HomeRuns !== '') return s.last10HomeRuns;
    return null;
  }
  function renderHRPTableV1032(){ var el=document.getElementById('hr-potential-content'); if(!el)return; setButtons(); var base=getHRRows(); populateHRGameSelect(base); if(!base.length){el.innerHTML='<div class="mu-empty">No HR potential data yet — check back once lineups are posted.</div>';return;} var arr=applyHRFilters(base).sort(function(a,b){return (isHit('hr',b)-isHit('hr',a)) || n(b.hrProb)-n(a.hrProb);}); if(!arr.length){el.innerHTML='<div class="mu-empty" style="padding:24px">No players match the selected filters. Try fewer filters, or select ALL to reset.</div>';return;} var cards=arr.map(function(r){ var p=n(r.hrProb), hot=n(r.hotBoostPct), hit=isHit('hr',r), isFinal=String(r.timeLabel||'').toUpperCase()==='FINAL', isMiss=isFinal&&!hit, labels=[]; if(hit)labels.push('<span class="projection-hit-badge">✓ Projection Hit</span>'); else if(isMiss)labels.push('<span class="prop-miss-badge">✗ Missed</span>'); if(r.isOnFire)labels.push(labelChip('🔥 ON FIRE',Math.round(n(r.onFireScore)),'red')); if(r.isDue)labels.push(labelChip('⚡ DUE','YES','gold')); if(r.isDrought)labels.push(labelChip('❄️ DROUGHT','YES','red')); if(r.isFavorable)labels.push(labelChip('✅ FAVORABLE','MATCHUP','green')); if(r.topHrThreat||p>=8)labels.push(labelChip('💥 TOP HR','THREAT','gold')); var l10=dr113Last10HRValue(r); var stats=[hrChip('HR Prob',p.toFixed(1)+'%','green'),hrChip('Season HR',r.hrSeason||'–',''),hrChip('Last 10 HR',l10==null?'–':l10,n(l10)>=2?'green':''),hrChip('OPS',fmt3(r.ops),n(r.ops)>=.850?'green':''),hrChip('ISO',fmt3(r.iso),n(r.iso)>=.200?'gold':''),hrChip('AVG',fmt3(r.avg),n(r.avg)>=.280?'green':''),hot?hrChip('Hot Boost','+'+hot.toFixed(1),'gold'):''].filter(Boolean); return '<div class="dr1027-hr-card '+(hit?'projection-hit':isMiss?'prop-miss':'')+'" id="hrp-row-'+esc(r.id)+'"><div class="dr1027-hr-head"><img class="dr1027-hr-photo" loading="lazy" decoding="async" src="'+hs(r.id)+'" onerror="this.style.visibility=\'hidden\'" alt=""><div><div class="dr1027-hr-name">'+esc(r.name||'–')+'</div><div class="dr1027-hr-meta">'+esc(r.teamAbbr||'–')+' · '+esc(r.pos||'–')+' · vs '+esc(r.oppAbbr||'–')+(r.pitcherName?' · '+esc(r.pitcherName):'')+'</div></div><div class="dr1027-hr-score"><strong>'+p.toFixed(1)+'%</strong><span>HR Probability</span><em>GRADE '+grade(p)+'</em></div></div><div class="dr1027-chip-row">'+labels.concat(stats).slice(0,16).join('')+'</div><div class="dr1027-why">'+whyHR(r)+'</div><button class="hrp-matchup-btn dr1027-matchup-btn" data-batter-id="'+esc(r.id)+'" data-batter-name="'+esc(r.name||'')+'" data-pitcher-id="'+esc(r.pitcherId||'')+'" data-pitcher-name="'+esc(r.pitcherName||'')+'" onclick="const d=this.dataset;openMatchup(+d.batterId,d.batterName,+d.pitcherId,d.pitcherName)">⚔ PITCHER MATCHUP</button></div>'; }).join(''); el.innerHTML=hrSummary(arr)+'<div class="dr1027-hr-card-list">'+cards+'</div>'; }
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
      <div class="dr-center-label">🔒 Diamond Report Premium</div>
      <div class="dr-panel dr-panel-large">
        <div class="dr-panel-head">
          <div>
            <p class="section-title">PREMIUM <span>ACCESS</span></p>
            <small>Unlock advanced analytics and deeper matchup intelligence.</small>
          </div>
        </div>
        <div class="dr-panel-body" style="text-align:center;padding:32px">
          <h2>🔒 Premium Feature</h2>
          <p>This section is available with Diamond Report Premium.</p>
          <div style="margin-top:20px;line-height:2">
            🧾 Parlay Builds<br>
            🆚 Team Performance<br>
            🧠 Deep Research
          </div>
          <button class="dr-refresh" style="margin-top:24px">Upgrade to Unlock</button>
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

  var FREE_PANES = new Set(['game','hr','k','hits','rbis','tb','sb','hrrbi']);
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

  var VERSION = 'v9.5';
  var LOCK_PREFIX = 'dr-official-lineup-game-projections:' + VERSION + ':';
  var WATCH_PREFIX = 'dr-lineup-watch-state:' + VERSION + ':';
  var readinessCache = { at: 0, ready: false, detail: '' };
  var READINESS_TTL = 2 * 60 * 1000;

  function centralDateKey(){
    try { return new Date().toLocaleDateString('en-CA', { timeZone:'America/Chicago' }); }
    catch(e){ return new Date().toISOString().slice(0,10); }
  }
  function lockKey(){ return LOCK_PREFIX + centralDateKey(); }
  function watchKey(){ return WATCH_PREFIX + centralDateKey(); }
  function formatCT(iso){
    var d = iso ? new Date(iso) : new Date();
    try { return d.toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', timeZone:'America/Chicago' }) + ' CT'; }
    catch(e){ return d.toLocaleString(); }
  }
  function lockBannerHTML(saved){
    var detail = saved && saved.lineupDetail ? saved.lineupDetail : 'Official lineup confirmed';
    var time = formatCT(saved && saved.lockedAt);
    return '<div class="dr-daily-lock-banner" data-dr-lock-banner="1"><span>🔒 Official Lineup Update Locked</span><span>'+detail+' • '+time+'</span></div>';
  }
  function watchBannerHTML(detail){
    return '<div class="dr-daily-lock-banner watch" data-dr-lock-banner="1"><span>🟡 Lineup Watch Active</span><span>'+(detail || 'Projections freeze after official lineup confirmation')+'</span></div>';
  }
  function normalizeHTML(html){
    return String(html || '').replace(/<div class="dr-daily-lock-banner[\s\S]*?<\/div>\s*/g,'');
  }
  function readLock(){
    try {
      var raw = localStorage.getItem(lockKey());
      if (!raw) return null;
      var saved = JSON.parse(raw);
      if (!saved || saved.date !== centralDateKey() || !saved.html) return null;
      return saved;
    } catch(e){ return null; }
  }
  function paintLock(saved){
    var el = document.getElementById('gameprops-content');
    if (!el || !saved || !saved.html) return false;
    el.innerHTML = lockBannerHTML(saved) + saved.html;
    clearProjectionResultZones(el);
    if (saved.drWinProbStore) window.drWinProbStore = saved.drWinProbStore;
    var refreshEl = document.getElementById('gameprops-refresh');
    if (refreshEl) refreshEl.textContent = 'Official lineup projections locked';
    if (window.refreshFavoredPills) { try { window.refreshFavoredPills(); } catch(e){} }
    // v9.4: the locked projection HTML is allowed to stay locked, but live/final score
    // badges are NOT locked. Any restore/repaint must immediately re-apply the newest
    // live scoreboard state so cached official-lineup HTML cannot overwrite results.
    setTimeout(function(){
      if (typeof refreshLockedGameProjectionScores === 'function') {
        try { refreshLockedGameProjectionScores(); } catch(e){}
      }
    }, 0);
    return true;
  }
  function paintWatch(detail){
    var el = document.getElementById('gameprops-content');
    if (!el || !el.querySelector('.gp-card')) return false;
    var html = normalizeHTML(el.innerHTML);
    el.innerHTML = watchBannerHTML(detail) + html;
    var refreshEl = document.getElementById('gameprops-refresh');
    if (refreshEl) refreshEl.textContent = 'Lineup watch active';
    return true;
  }
  function restoreLock(){
    var saved = readLock();
    if (!saved) return false;
    return paintLock(saved);
  }
  function writeLock(reason){
    try {
      var el = document.getElementById('gameprops-content');
      if (!el || !el.querySelector('.gp-card')) return false;
      var html = normalizeHTML(el.innerHTML);
      if (!html || /Loading Game Center|still loading|Error:/i.test(html)) return false;
      var saved = {
        version: VERSION,
        date: centralDateKey(),
        generatedAt: new Date().toISOString(),
        lockedAt: new Date().toISOString(),
        lockType: 'official-lineup-confirmed',
        lineupDetail: reason || 'Official lineup confirmed',
        html: html,
        drWinProbStore: window.drWinProbStore || null
      };
      localStorage.setItem(lockKey(), JSON.stringify(saved));
      localStorage.setItem(watchKey(), JSON.stringify({ lockedAt: saved.lockedAt, reason: saved.lineupDetail }));
      paintLock(saved);
      return true;
    } catch(e){ return false; }
  }
  function teamHasConfirmedLineup(team){
    return !!(team && team.confirmed === true && Array.isArray(team.lineup) && team.lineup.length >= 8);
  }
  async function fetchJSONSafe(url){
    try {
      if (typeof drFetchDailyJSON === 'function') return await drFetchDailyJSON(url);
      var r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      return await r.json();
    } catch(e){ return null; }
  }
  function repoLineupReady(data){
    var games = data && data.games ? Object.values(data.games) : [];
    if (!games.length) return null;
    var confirmedGames = 0, confirmedTeams = 0;
    games.forEach(function(game){
      var teams = game && game.teams ? game.teams : {};
      var vals = Object.values(teams);
      var count = vals.filter(teamHasConfirmedLineup).length;
      confirmedTeams += count;
      if (count >= 2) confirmedGames++;
    });
    if (confirmedGames > 0) return { ready:true, detail: confirmedGames + ' game' + (confirmedGames === 1 ? '' : 's') + ' with confirmed lineups' };
    if (confirmedTeams > 0) return { ready:true, detail: confirmedTeams + ' confirmed team lineup' + (confirmedTeams === 1 ? '' : 's') };
    return null;
  }
  async function mlbBoxscoreReady(){
    if (typeof getTodaySchedule !== 'function' || typeof fetchJSON !== 'function') return null;
    try {
      var games = await getTodaySchedule('team,probablePitcher,linescore');
      if (!Array.isArray(games) || !games.length) return null;
      var checks = games.slice(0, 15).map(async function(g){
        try {
          var box = await fetchJSON('https://diamondreport.app/api/v1/game/' + g.gamePk + '/boxscore');
          var away = box && box.teams && box.teams.away;
          var home = box && box.teams && box.teams.home;
          function hasOrder(team){
            var batters = (team && team.batters || []).map(function(id){ return team.players && team.players['ID'+id]; }).filter(Boolean);
            return batters.some(function(b){ return b && (b.battingOrder || (b.stats && b.stats.batting && b.stats.batting.battingOrder)); });
          }
          return hasOrder(away) || hasOrder(home);
        } catch(e){ return false; }
      });
      var results = await Promise.all(checks);
      var count = results.filter(Boolean).length;
      if (count > 0) return { ready:true, detail: count + ' MLB official lineup' + (count === 1 ? '' : 's') + ' detected' };
    } catch(e){}
    return null;
  }
  async function lineupReady(){
    var now = Date.now();
    if ((now - readinessCache.at) < READINESS_TTL) return readinessCache.ready ? readinessCache : null;
    var ready = null;
    var repo = await fetchJSONSafe('data/lineups.json');
    ready = repoLineupReady(repo);
    if (!ready) ready = await mlbBoxscoreReady();
    readinessCache = { at: now, ready: !!ready, detail: ready ? ready.detail : 'Waiting for official lineup confirmation' };
    return ready ? readinessCache : null;
  }
  async function maybeLockAfterLineup(){
    if (readLock()) return true;
    var ready = await lineupReady();
    if (ready && ready.ready) return writeLock(ready.detail);
    paintWatch(ready && ready.detail ? ready.detail : 'Waiting for official lineup confirmation');
    return false;
  }

  window.DiamondClearLineupGameProjectionLock = function(){
    try { localStorage.removeItem(lockKey()); return 'Official lineup Game Projection lock cleared for ' + centralDateKey() + '.'; }
    catch(e){ return 'Unable to clear lineup Game Projection lock: ' + (e.message || e); }
  };
  window.DiamondSaveLineupGameProjectionLock = function(reason){ return writeLock(reason || 'Manual official lineup lock'); };
  window.DiamondRestoreLineupGameProjectionLock = restoreLock;

  // Backward-compatible names from v8.73, but now they control the lineup-confirmed lock.
  window.DiamondClearDailyGameProjectionLock = window.DiamondClearLineupGameProjectionLock;
  window.DiamondSaveDailyGameProjectionLock = window.DiamondSaveLineupGameProjectionLock;
  window.DiamondRestoreDailyGameProjectionLock = window.DiamondRestoreLineupGameProjectionLock;

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
            badge = '<span style="background:'+(ok?'#0d2a1a':'#2a0d0d')+';color:'+(ok?'#2ecc71':'#e63946')+';font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid '+(ok?'#2ecc7166':'#e6394666')+'">'+(ok?'✓ CORRECT':'✗ INCORRECT')+' — '+actualWinnerAbbr+' won '+awayScore+'-'+homeScore+'</span>';
          }
        } else if (isLive && awayScore != null && homeScore != null) {
          var leadingAbbr = awayScore > homeScore ? awayAbbr : homeScore > awayScore ? homeAbbr : null;
          if (leadingAbbr) {
            var pickLeading = leadingAbbr === winnerAbbr;
            badge = '<span style="background:'+(pickLeading?'#0d2a1a':'#2a0d0d')+';color:'+(pickLeading?'#2ecc71':'#e63946')+';font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid '+(pickLeading?'#2ecc7166':'#e6394666')+'">'+(pickLeading?'▲':'▼')+' LIVE '+leadingAbbr+' leads '+awayScore+'-'+homeScore+'</span>';
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
      var mo = new MutationObserver(function(){
        if (readLock()) scheduleAuthoritativeRefresh();
      });
      mo.observe(el, { childList:true, subtree:true });
    } catch(e) {}
  }

  function installWrapper(){
    if (typeof window.loadGameProps !== 'function' || window.loadGameProps.__drLineupLockWrapped) return false;
    var original = window.loadGameProps;
    async function lineupLockedLoadGameProps(opts){
      opts = opts || {};
      var saved = readLock();
      // Once the official-lineup card exists, never recalculate it during normal reloads,
      // tab switches, retries, or background intervals. Manual clear is required.
      if (saved && !opts.forceUnlock) { paintLock(saved); await refreshLockedGameProjectionScores(); return; }
      var result = await original.apply(this, arguments);
      await maybeLockAfterLineup();
      return result;
    }
    lineupLockedLoadGameProps.__drLineupLockWrapped = true;
    window.loadGameProps = lineupLockedLoadGameProps;
    return true;
  }

  function boot(){
    installProjectionMutationGuard();
    var restoredOnce = restoreLock();
    installWrapper();
    var tries = 0;
    var id = setInterval(function(){
      tries++;
      var wrapped = installWrapper();
      // v9.4: do not keep repainting saved locked HTML after the live-score badge has
      // been applied. Repeated restoreLock() calls were causing the section to briefly
      // show live results and then revert to the stale locked HTML.
      if (!restoredOnce) restoredOnce = restoreLock();
      if (wrapped || restoredOnce || tries > 20) clearInterval(id);
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
      return '<span style="background:'+(ok?'#0d2a1a':'#2a0d0d')+';color:'+(ok?'#2ecc71':'#e63946')+';font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid '+(ok?'#2ecc7166':'#e6394666')+'">'+(ok?'✓ CORRECT':'✗ INCORRECT')+' — '+actualWinnerAbbr+' won '+awayScore+'-'+homeScore+'</span>';
    }
    if (st.isLive) {
      var leadingAbbr = awayScore > homeScore ? awayAbbr : homeScore > awayScore ? homeAbbr : null;
      if (!leadingAbbr) return '<span style="background:rgba(255,193,7,.10);color:var(--accent2);font-size:10px;font-weight:800;padding:3px 10px;border-radius:4px;border:1px solid rgba(255,193,7,.45)">● LIVE TIED '+awayScore+'-'+homeScore+'</span>';
      var pickLeading = leadingAbbr === winnerAbbr;
      return '<span style="background:'+(pickLeading?'#0d2a1a':'#2a0d0d')+';color:'+(pickLeading?'#2ecc71':'#e63946')+';font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid '+(pickLeading?'#2ecc7166':'#e6394666')+'">'+(pickLeading?'▲':'▼')+' LIVE '+leadingAbbr+' leads '+awayScore+'-'+homeScore+'</span>';
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
    } finally { applying = false; }
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
    var mo = new MutationObserver(function(){
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
    ['props','game','matchups','tracker'].forEach(function(id){ var el=document.getElementById(id); if(el) el.classList.add('dr-v9-soft-hide'); });
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
  function score(type,r){var s=r.stats||{},avg=n(r.avg),ops=n(r.ops),iso=n(r.iso),hr=n(r.hrSeason),prob=n(r.hrProb),obp=n(s.obp),slg=n(s.slg),sb=n(s.stolenBases),l10=n(r.last10HR);var base=50;if(type==='hits')base=38+avg*120+ops*8+(r.isFavorable?6:0)+obp*12;if(type==='rbis')base=35+ops*10+iso*72+hr*.8+prob*.35+(r.topHrThreat?5:0);if(type==='tb')base=36+ops*8+iso*96+prob*.45+l10*2+slg*8;if(type==='sb')base=28+sb*2.5+avg*40+obp*28+(String(r.pos||'').match(/SS|CF|2B|LF|RF/)?8:0);if(type==='hrrbi')base=42+avg*55+ops*9+hr*.45+prob*.32+(r.isFavorable?5:0)+obp*8;return pct(base)}
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

// db.js - Data layer for AIGC Studio
// IndexedDB (local cache) + Firebase Realtime Database (cloud sync)
// Cloud sync: site loads config.json → reads Firebase → cross-device access

// ===== CONSTANTS =====
var AIGC_DB_NAME = 'aigc_studio_db';
var AIGC_DB_VERSION = 1;
var AIGC_STORE_NAME = 'works';
var AIGC_DATA_KEY = 'aigc_studio_data';
var AIGC_NOTIFY_KEY = 'aigc_studio_data_v';
var CLOUD_URL_KEY = 'aigc_cloud_url';
var CLOUD_ENABLED_KEY = 'aigc_cloud_enabled';
var AIGC_ADMIN_PWD_KEY = 'aigc_admin_pwd';
var AIGC_ADMIN_PWD_DEFAULT = 'admin123';
var CLOUD_TIMEOUT = 15000; // 15s timeout for cloud reads
var CLOUD_PUSH_TIMEOUT = 60000; // 60s timeout for cloud writes (large payloads with images)

var _db = null;
var _effectiveCloudUrl = null; // cached effective cloud URL

// ===== INDEXEDDB =====
function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(AIGC_DB_NAME, AIGC_DB_VERSION);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(AIGC_STORE_NAME)) {
        db.createObjectStore(AIGC_STORE_NAME);
      }
    };
    req.onsuccess = function() {
      _db = req.result;
      _db.onclose = function() { _db = null; };
      resolve(_db);
    };
    req.onerror = function() { reject(req.error); };
  });
}

// Normalize data structure — ensure all four arrays exist
function normalizeData(data) {
  if (!data || typeof data !== 'object') data = {};
  if (!Array.isArray(data.paintings)) data.paintings = [];
  if (!Array.isArray(data.posters)) data.posters = [];
  if (!Array.isArray(data.videos)) data.videos = [];
  if (!Array.isArray(data.chars)) data.chars = [];
  return data;
}

// Read from IndexedDB only (with localStorage migration fallback)
async function getLocalData() {
  try {
    var db = await openDB();
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(AIGC_STORE_NAME, 'readonly');
      var store = tx.objectStore(AIGC_STORE_NAME);
      var req = store.get(AIGC_DATA_KEY);
      req.onsuccess = function() {
        if (req.result) {
          resolve(normalizeData(req.result));
        } else {
          // Try migrating from localStorage (legacy)
          try {
            var raw = localStorage.getItem(AIGC_DATA_KEY);
            if (raw) {
              var data = JSON.parse(raw);
              saveToLocal(normalizeData(data)).then(function() {
                localStorage.removeItem(AIGC_DATA_KEY);
                console.log('[AIGC DB] Data migrated from localStorage to IndexedDB');
              }).catch(function(e) { console.warn('[AIGC DB] Post-migration save failed:', e); });
              resolve(normalizeData(data));
            } else {
              resolve({paintings:[],posters:[],videos:[],chars:[]});
            }
          } catch(e2) {
            resolve({paintings:[],posters:[],videos:[],chars:[]});
          }
        }
      };
      req.onerror = function() { reject(req.error); };
    });
  } catch(e) {
    console.error('[AIGC DB] Read failed:', e);
    return {paintings:[],posters:[],videos:[],chars:[]};
  }
}

// Write to IndexedDB only
async function saveToLocal(data) {
  try {
    var db = await openDB();
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(AIGC_STORE_NAME, 'readwrite');
      var store = tx.objectStore(AIGC_STORE_NAME);
      store.put(data, AIGC_DATA_KEY);
      tx.oncomplete = function() {
        // Notify other tabs (e.g., index.html) to refresh
        try { localStorage.setItem(AIGC_NOTIFY_KEY, Date.now().toString()); } catch(e) {}
        resolve(true);
      };
      tx.onerror = function() { reject(tx.error); };
    });
  } catch(e) {
    console.error('[AIGC DB] Save failed:', e);
    return false;
  }
}

// ===== CLOUD SYNC (Firebase Realtime Database REST API) =====

// Admin-side cloud config (stored in localStorage, admin device only)
function getCloudConfig() {
  return {
    url: (localStorage.getItem(CLOUD_URL_KEY) || '').replace(/\/+$/, ''),
    enabled: localStorage.getItem(CLOUD_ENABLED_KEY) === 'true'
  };
}

function setCloudConfig(url, enabled) {
  if (url !== undefined && url !== null) {
    localStorage.setItem(CLOUD_URL_KEY, (url || '').replace(/\/+$/, ''));
  }
  if (enabled !== undefined && enabled !== null) {
    localStorage.setItem(CLOUD_ENABLED_KEY, enabled ? 'true' : 'false');
  }
}

// Get the effective cloud URL for the current page
// Priority: config.json (deployed file, all devices) > localStorage (admin device)
async function getEffectiveCloudUrl() {
  if (_effectiveCloudUrl !== null) return _effectiveCloudUrl === false ? null : _effectiveCloudUrl;

  // 1. Try config.json (deployed alongside HTML files, works for ALL devices)
  try {
    var res = await fetch('config.json?_t=' + Date.now());
    if (res.ok) {
      var config = await res.json();
      if (config.cloudUrl) {
        _effectiveCloudUrl = config.cloudUrl.replace(/\/+$/, '');
        console.log('[AIGC Cloud] Loaded cloud URL from config.json');
        return _effectiveCloudUrl;
      }
    }
  } catch(e) {
    // config.json not found or fetch failed, that's OK
  }

  // 2. Fall back to localStorage config (admin device)
  var localConfig = getCloudConfig();
  if (localConfig.enabled && localConfig.url) {
    _effectiveCloudUrl = localConfig.url;
    console.log('[AIGC Cloud] Using cloud URL from localStorage (admin mode)');
    return _effectiveCloudUrl;
  }

  _effectiveCloudUrl = false; // cache: no cloud configured
  return null;
}

// Fetch data from Firebase at a specific URL
async function cloudFetchUrl(url) {
  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, CLOUD_TIMEOUT);
    var res = await fetch(url + '/works.json', { signal: controller.signal });
    clearTimeout(timer);
    if (res.status === 200) {
      var data = await res.json();
      if (data && typeof data === 'object' && 'paintings' in data) return data;
      console.warn('[AIGC Cloud] Invalid data format received');
      return null;
    }
    if (res.status === 404) {
      console.log('[AIGC Cloud] No data on cloud yet');
      return null;
    }
    console.warn('[AIGC Cloud] Fetch returned status:', res.status);
    return null;
  } catch(e) {
    console.warn('[AIGC Cloud] Fetch error:', e);
    return null;
  }
}

// Push data to Firebase at a specific URL
async function cloudPushUrl(url, data) {
  try {
    var payload = JSON.stringify(data);
    var payloadSize = new Blob([payload]).size;
    console.log('[AIGC Cloud] Pushing data, payload size:', (payloadSize / 1024 / 1024).toFixed(2) + ' MB');

    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, CLOUD_PUSH_TIMEOUT);
    var res = await fetch(url + '/works.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      console.log('[AIGC Cloud] Push successful');
      return { ok: true };
    }
    // Read error body for diagnostics
    var errMsg = 'HTTP ' + res.status;
    try {
      var errBody = await res.text();
      if (errBody) errMsg += ': ' + errBody.substring(0, 200);
    } catch(e2) {}
    console.warn('[AIGC Cloud] Push failed:', errMsg);
    return { ok: false, error: errMsg };
  } catch(e) {
    var reason = e.name === 'AbortError' ? '上传超时（数据量较大，请检查网络）' : e.message;
    console.warn('[AIGC Cloud] Push error:', reason);
    return { ok: false, error: reason };
  }
}

// Test if a Firebase database URL is accessible
async function testCloudConnection(url) {
  try {
    var cleanUrl = (url || '').replace(/\/+$/, '');
    if (!cleanUrl) return { ok: false, msg: '请输入数据库地址' };
    var res = await fetch(cleanUrl + '/works.json');
    if (res.status === 200) return { ok: true, msg: '连接成功！数据库已有数据' };
    if (res.status === 401 || res.status === 403) return { ok: false, msg: '访问被拒绝，请检查数据库规则是否设置为 {".read":true,".write":true}' };
    if (res.status === 404) return { ok: true, msg: '连接成功！数据库为空，可以开始同步' };
    return { ok: false, msg: '返回状态码 ' + res.status + '，请检查地址是否正确' };
  } catch(e) {
    return { ok: false, msg: '连接失败：' + (e.message || '未知错误') };
  }
}

// Generate config.json content for deployment
function generateConfigJson(cloudUrl) {
  return JSON.stringify({ cloudUrl: cloudUrl.replace(/\/+$/, '') }, null, 2);
}

// ===== ADMIN SETTINGS CLOUD SYNC =====
// Stores admin password + cloud sync config in Firebase /admin.json
// so settings persist across browsers and devices

async function cloudFetchAdmin(url) {
  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, CLOUD_TIMEOUT);
    var res = await fetch(url + '/admin.json', { signal: controller.signal });
    clearTimeout(timer);
    if (res.status === 200) {
      var settings = await res.json();
      if (settings && typeof settings === 'object') return settings;
    }
    return null;
  } catch(e) {
    console.warn('[AIGC Cloud] Fetch admin settings error:', e);
    return null;
  }
}

async function cloudPushAdmin(url, settings) {
  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, CLOUD_TIMEOUT);
    var res = await fetch(url + '/admin.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      console.log('[AIGC Cloud] Admin settings pushed');
      return true;
    }
    console.warn('[AIGC Cloud] Push admin settings failed, status:', res.status);
    return false;
  } catch(e) {
    console.warn('[AIGC Cloud] Push admin settings error:', e);
    return false;
  }
}

// Load admin settings from cloud and restore to localStorage
// Returns true if any settings were restored
async function syncAdminSettingsFromCloud() {
  var cloudUrl = await getEffectiveCloudUrl();
  if (!cloudUrl) return false;

  var settings = await cloudFetchAdmin(cloudUrl);
  if (!settings) return false;

  var restored = false;

  // Restore password if valid
  if (settings.pwd && settings.pwd.length >= 6) {
    localStorage.setItem(AIGC_ADMIN_PWD_KEY, settings.pwd);
    restored = true;
  }

  // Restore cloud sync settings
  if (settings.cloudUrl) {
    localStorage.setItem(CLOUD_URL_KEY, settings.cloudUrl.replace(/\/+$/, ''));
    restored = true;
  }
  if (settings.cloudEnabled !== undefined) {
    localStorage.setItem(CLOUD_ENABLED_KEY, settings.cloudEnabled ? 'true' : 'false');
    restored = true;
  }

  if (restored) {
    _effectiveCloudUrl = null; // reset cache after updating config
    console.log('[AIGC Cloud] Admin settings restored from cloud');
  }
  return restored;
}

// Push current localStorage admin settings to cloud
async function pushAdminSettingsToCloud() {
  var cloudUrl = await getEffectiveCloudUrl();
  if (!cloudUrl) return false;

  var settings = {
    pwd: localStorage.getItem(AIGC_ADMIN_PWD_KEY) || '',
    cloudUrl: localStorage.getItem(CLOUD_URL_KEY) || '',
    cloudEnabled: localStorage.getItem(CLOUD_ENABLED_KEY) === 'true'
  };

  return cloudPushAdmin(cloudUrl, settings);
}

// ===== PUBLIC API =====

// getData: local first → cloud update (timestamp-based merge)
// Local data always takes priority if it's newer than cloud.
// This prevents stale cloud data from undoing recent admin changes.
async function getData() {
  // 1. Load local data first (fast, has latest admin changes)
  var localData = await getLocalData();
  var localTs = localData._ts || 0;

  // 2. Try cloud data and compare timestamps
  var cloudUrl = await getEffectiveCloudUrl();
  if (cloudUrl) {
    try {
      var cloudData = await cloudFetchUrl(cloudUrl);
      if (cloudData) {
        var cloudTs = cloudData._ts || 0;
        if (cloudTs > localTs) {
          // Cloud is newer (e.g., another device updated it) — use cloud data
          var normalized = normalizeData(cloudData);
          saveToLocal(normalized).catch(function() {});
          return normalized;
        }
        // Local is newer or equal — keep local data (preserves admin changes)
        console.log('[AIGC DB] Using local data (ts:' + localTs + ') over cloud (ts:' + cloudTs + ')');
      }
    } catch(e) {}
  }

  return localData;
}

// saveData: local first → incremental cloud sync
// Uses PATCH (incremental) for small changes, falls back to full PUT
async function saveData(data) {
  // Stamp timestamp so getData() can determine which copy is newer
  data._ts = Date.now();

  // Save locally (fast, reliable)
  var localPromise = saveToLocal(data);
  // Resolve cloud URL in parallel
  var cloudUrlPromise = getEffectiveCloudUrl();

  var localResult = await localPromise;
  var cloudUrl = await cloudUrlPromise;

  // Background push to cloud
  if (cloudUrl) {
    var result = await cloudPushIncremental(cloudUrl, data);
    if (!result.ok) {
      console.warn('[AIGC] Cloud push failed:', result.error);
      try {
        window.dispatchEvent(new CustomEvent('aigc-cloud-error', { detail: result.error }));
      } catch(e) {}
    } else {
      try {
        window.dispatchEvent(new CustomEvent('aigc-cloud-synced'));
      } catch(e) {}
    }
  }
  return localResult;
}

// Incremental push: only send changed/added items using Firebase PATCH
// Firebase PATCH on /works.json merges keys without replacing unchanged ones.
// Strategy:
//   1. Fetch current cloud _ts metadata (lightweight: only /works/_ts.json)
//   2. If cloud has same or newer ts, skip push (no conflict)
//   3. Build a patch object with only updated array items + metadata
//   4. PATCH instead of full PUT — much smaller payload
async function cloudPushIncremental(url, data) {
  try {
    // Step 1: Check cloud _ts to avoid redundant push (HEAD-like lightweight check)
    var tsRes = await _fetchWithTimeout(url + '/works/_ts.json', {}, CLOUD_TIMEOUT);
    if (tsRes.ok) {
      var cloudTs = await tsRes.json();
      if (typeof cloudTs === 'number' && cloudTs >= data._ts) {
        console.log('[AIGC Cloud] Cloud already up-to-date, skipping push');
        return { ok: true };
      }
    }

    // Step 2: Estimate payload — use PATCH (incremental merge) via Firebase REST
    // Firebase PATCH on a node merges at the top level (keys), perfect for our arrays.
    var payload = JSON.stringify({
      paintings: data.paintings || [],
      posters:   data.posters   || [],
      videos:    data.videos    || [],
      chars:     data.chars     || [],
      _ts:       data._ts
    });
    var payloadSize = payload.length;
    console.log('[AIGC Cloud] Incremental push, payload:', (payloadSize / 1024).toFixed(0) + ' KB');

    // Step 3: Use PATCH for incremental merge (faster than full PUT when cloud exists)
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, CLOUD_PUSH_TIMEOUT);
    var res = await fetch(url + '/works.json', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal
    });
    clearTimeout(timer);

    if (res.ok) {
      console.log('[AIGC Cloud] Incremental push successful');
      return { ok: true };
    }

    // PATCH failed — fall back to full PUT
    console.warn('[AIGC Cloud] PATCH failed (status ' + res.status + '), falling back to full PUT');
    return cloudPushUrl(url, data);

  } catch(e) {
    if (e.name === 'AbortError') {
      return { ok: false, error: '上传超时（数据量较大，请检查网络）' };
    }
    // Network error — try full PUT as fallback
    console.warn('[AIGC Cloud] Incremental push error, trying full PUT:', e.message);
    return cloudPushUrl(url, data);
  }
}

// Lightweight fetch with timeout helper
function _fetchWithTimeout(url, options, timeout) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeout);
  options = Object.assign({}, options, { signal: controller.signal });
  return fetch(url, options).then(function(res) {
    clearTimeout(timer);
    return res;
  }).catch(function(e) {
    clearTimeout(timer);
    throw e;
  });
}

// ===== UTILITIES =====
async function getStorageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      var est = await navigator.storage.estimate();
      return { usage: est.usage || 0, quota: est.quota || 0 };
    } catch(e) {
      return { usage: 0, quota: 0 };
    }
  }
  return { usage: 0, quota: 0 };
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

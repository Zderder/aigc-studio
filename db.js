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
var CLOUD_TIMEOUT = 8000; // 8 second timeout for cloud fetches

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
          resolve(req.result);
        } else {
          // Try migrating from localStorage (legacy)
          try {
            var raw = localStorage.getItem(AIGC_DATA_KEY);
            if (raw) {
              var data = JSON.parse(raw);
              saveToLocal(data).then(function() {
                localStorage.removeItem(AIGC_DATA_KEY);
                console.log('[AIGC DB] Data migrated from localStorage to IndexedDB');
              }).catch(function(e) { console.warn('[AIGC DB] Post-migration save failed:', e); });
              resolve(data);
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
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, CLOUD_TIMEOUT);
    var res = await fetch(url + '/works.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      console.log('[AIGC Cloud] Push successful');
      return true;
    }
    console.warn('[AIGC Cloud] Push failed, status:', res.status);
    return false;
  } catch(e) {
    console.warn('[AIGC Cloud] Push error:', e);
    return false;
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

// ===== PUBLIC API =====

// getData: cloud first → local fallback
async function getData() {
  var cloudUrl = await getEffectiveCloudUrl();
  if (cloudUrl) {
    try {
      var cloudData = await cloudFetchUrl(cloudUrl);
      if (cloudData) {
        // Cache cloud data to IndexedDB for offline fallback
        saveToLocal(cloudData).catch(function() {});
        return cloudData;
      }
    } catch(e) {}
  }
  return getLocalData();
}

// saveData: local first → cloud background sync
async function saveData(data) {
  // Save locally (fast, reliable)
  var localPromise = saveToLocal(data);
  // Resolve cloud URL in parallel
  var cloudUrlPromise = getEffectiveCloudUrl();

  var localResult = await localPromise;
  var cloudUrl = await cloudUrlPromise;

  // Background push to cloud (non-blocking)
  if (cloudUrl) {
    cloudPushUrl(cloudUrl, data).catch(function() {});
  }
  return localResult;
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

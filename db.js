// db.js - IndexedDB data layer for AIGC Studio
// Replaces localStorage (5MB limit) with IndexedDB (hundreds of MB+)
const AIGC_DB_NAME = 'aigc_studio_db';
const AIGC_DB_VERSION = 1;
const AIGC_STORE_NAME = 'works';
const AIGC_DATA_KEY = 'aigc_studio_data';
const AIGC_NOTIFY_KEY = 'aigc_studio_data_v';

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AIGC_DB_NAME, AIGC_DB_VERSION);
    req.onupgradeneeded = function(e) {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(AIGC_STORE_NAME)) {
        db.createObjectStore(AIGC_STORE_NAME);
      }
    };
    req.onsuccess = function() {
      _db = req.result;
      // Handle connection close
      _db.onclose = function() { _db = null; };
      resolve(_db);
    };
    req.onerror = function() { reject(req.error); };
  });
}

async function getData() {
  try {
    const db = await openDB();
    return new Promise(function(resolve, reject) {
      const tx = db.transaction(AIGC_STORE_NAME, 'readonly');
      const store = tx.objectStore(AIGC_STORE_NAME);
      const req = store.get(AIGC_DATA_KEY);
      req.onsuccess = function() {
        if (req.result) {
          resolve(req.result);
        } else {
          // Try migrating from localStorage
          try {
            const raw = localStorage.getItem(AIGC_DATA_KEY);
            if (raw) {
              var data = JSON.parse(raw);
              saveData(data).then(function() {
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

async function saveData(data) {
  try {
    const db = await openDB();
    return new Promise(function(resolve, reject) {
      const tx = db.transaction(AIGC_STORE_NAME, 'readwrite');
      const store = tx.objectStore(AIGC_STORE_NAME);
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

async function getStorageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
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

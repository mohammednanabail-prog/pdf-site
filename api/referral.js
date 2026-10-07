const admin = require('firebase-admin');

/* ============================================================
   Firebase Admin Init
   ============================================================ */
if (!admin.apps.length) {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey
    }),
    databaseURL: 'https://pdf-tools-7230f-default-rtdb.firebaseio.com'
  });
}

const db = admin.database();

/* ============================================================
   Rate limiter
   ============================================================ */
const rl = new Map();
function checkRL(key, max = 10, windowMs = 60000) {
  const now = Date.now();
  const arr = (rl.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  rl.set(key, arr);
  if (rl.size > 5000) rl.clear();
  return true;
}

/* ============================================================
   Defaults
   ============================================================ */
const DEFAULTS = {
  vipTiers: [
    { referrals: 5, minutes: 5 },
    { referrals: 10, minutes: 10 }
  ],
  monetag: {
    enabled: true,
    scriptUrl: 'https://quge5.com/88/tag.min.js',
    zoneId: '289087',
    extraScript: '',
    position: 'head'
  },
  referralMessages: {
    ar: "أفضل أداة مجانية وسريعة 100% لتحويل الصور إلى PDF والتعامل مع المستندات من الموبايل مباشرة وبدون برامج:",
    en: "The best 100% free and fast tool to convert images to PDF and handle documents right from your phone, without any software:",
    fr: "Le meilleur outil gratuit et rapide à 100% pour convertir des images en PDF et gérer vos documents depuis votre mobile, sans logiciel :"
  },
  siteSettings: {
    siteTitle: {
      ar: "Image → PDF | 26 أداة مجانية",
      en: "Image → PDF | 26 Free Tools",
      fr: "Image → PDF | 26 outils gratuits"
    },
    siteDescription: {
      ar: "أدوات مجانية لتحويل الصور وملفات PDF ودمجها وتقسيمها وضغطها.",
      en: "Free tools to convert images and PDFs, merge, split, and compress files.",
      fr: "Outils gratuits pour convertir images et PDF, fusionner, diviser et compresser."
    },
    vipCardEnabled: true,
    vipCardPosition: 'top',
    vipCardColor: 'cyan',
    adsEnabled: true,
    watermarkEnabled: true,
    languageDefault: 'en',
    maintenanceMode: false,
    maintenanceMessage: {
      ar: "الموقع تحت الصيانة مؤقتاً. نعتذر عن الإزعاج.",
      en: "Site is temporarily under maintenance. We apologize.",
      fr: "Le site est temporairement en maintenance. Nous nous excusons."
    }
  }
};

/* ============================================================
   Public endpoints
   ============================================================ */
async function getConfig(res) {
  const snap = await db.ref('config').once('value');
  const cfg = snap.val() || {};
  return res.status(200).json({
    vipTiers: cfg.vipTiers || DEFAULTS.vipTiers,
    monetag: Object.assign({}, DEFAULTS.monetag, cfg.monetag || {}),
    referralMessages: Object.assign({}, DEFAULTS.referralMessages, cfg.referralMessages || {}),
    siteSettings: Object.assign({}, DEFAULTS.siteSettings, cfg.siteSettings || {})
  });
}

async function getRefCount(body, res) {
  const userId = String(body.userId || '').replace(/[^a-zA-Z0-9_]/g, '').substring(0, 100);
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const snap = await db.ref('referrals/' + userId + '/count').once('value');
  return res.status(200).json({ count: snap.val() || 0 });
}

async function incRef(body, ip, res) {
  const referrerId = String(body.referrerId || '').replace(/[^a-zA-Z0-9_]/g, '').substring(0, 100);
  const visitorId = String(body.visitorId || '').replace(/[^a-zA-Z0-9_]/g, '').substring(0, 100);
  if (!referrerId || !visitorId) return res.status(400).json({ error: 'Missing params' });
  if (referrerId === visitorId) return res.status(200).json({ success: false, reason: 'self' });
  if (!checkRL('inc_' + ip, 5, 60000)) return res.status(429).json({ error: 'Rate limit' });
  const trackRef = db.ref('referrals/' + referrerId + '/tracked/' + visitorId);
  const trackSnap = await trackRef.once('value');
  if (trackSnap.exists()) return res.status(200).json({ success: false, reason: 'already' });
  const countRef = db.ref('referrals/' + referrerId + '/count');
  await countRef.transaction(c => Math.min((c || 0) + 1, 500));
  await trackRef.set(Date.now());
  return res.status(200).json({ success: true });
}

/* ============================================================
   Admin auth
   ============================================================ */
async function verifyAdmin(req) {
  const pwd = req.headers['x-admin-pass'] || '';
  if (!pwd) return false;
  const snap = await db.ref('config/adminPassword').once('value');
  const stored = snap.val() || 'admin2024';
  return pwd === stored;
}

/* ============================================================
   Admin endpoints
   ============================================================ */
async function adminLogin(body, ip, res) {
  if (!checkRL('login_' + ip, 5, 300000)) {
    return res.status(429).json({ success: false, error: 'Too many attempts' });
  }
  const pwd = String(body.password || '');
  const snap = await db.ref('config/adminPassword').once('value');
  const stored = snap.val() || 'admin2024';
  if (pwd === stored) return res.status(200).json({ success: true });
  return res.status(401).json({ success: false, error: 'Wrong password' });
}

async function adminGetConfig(req, res) {
  if (!await verifyAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const snap = await db.ref('config').once('value');
  const cfg = snap.val() || {};
  delete cfg.adminPassword;
  return res.status(200).json({
    vipTiers: cfg.vipTiers || DEFAULTS.vipTiers,
    monetag: Object.assign({}, DEFAULTS.monetag, cfg.monetag || {}),
    referralMessages: Object.assign({}, DEFAULTS.referralMessages, cfg.referralMessages || {}),
    siteSettings: Object.assign({}, DEFAULTS.siteSettings, cfg.siteSettings || {})
  });
}

/* 🆕 Generic key saver — يقبل أي مفتاح */
async function adminSaveKey(req, body, res) {
  if (!await verifyAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const allowedKeys = ['vipTiers', 'monetag', 'referralMessages', 'siteSettings'];
  const key = String(body.key || '');
  if (!allowedKeys.includes(key)) return res.status(400).json({ error: 'Invalid key: ' + key });
  let value = body.value;

  // Validation per key
  if (key === 'vipTiers') {
    if (!Array.isArray(value) || !value.length) return res.status(400).json({ error: 'vipTiers must be non-empty array' });
    value = value.map(t => ({
      referrals: Math.max(1, Math.min(10000, parseInt(t.referrals) || 1)),
      minutes: Math.max(1, Math.min(10080, parseInt(t.minutes) || 1))
    })).sort((a, b) => a.referrals - b.referrals);
  }
  if (key === 'monetag') {
    value = {
      enabled: !!value.enabled,
      scriptUrl: String(value.scriptUrl || '').substring(0, 500),
      zoneId: String(value.zoneId || '').substring(0, 100),
      extraScript: String(value.extraScript || '').substring(0, 5000),
      position: String(value.position || 'head').substring(0, 20)
    };
  }
  if (key === 'referralMessages') {
    value = {
      ar: String(value.ar || '').substring(0, 2000),
      en: String(value.en || '').substring(0, 2000),
      fr: String(value.fr || '').substring(0, 2000)
    };
  }
  if (key === 'siteSettings') {
    value = {
      siteTitle: {
        ar: String((value.siteTitle && value.siteTitle.ar) || '').substring(0, 200),
        en: String((value.siteTitle && value.siteTitle.en) || '').substring(0, 200),
        fr: String((value.siteTitle && value.siteTitle.fr) || '').substring(0, 200)
      },
      siteDescription: {
        ar: String((value.siteDescription && value.siteDescription.ar) || '').substring(0, 500),
        en: String((value.siteDescription && value.siteDescription.en) || '').substring(0, 500),
        fr: String((value.siteDescription && value.siteDescription.fr) || '').substring(0, 500)
      },
      vipCardEnabled: value.vipCardEnabled !== false,
      vipCardPosition: String(value.vipCardPosition || 'top').substring(0, 20),
      vipCardColor: String(value.vipCardColor || 'cyan').substring(0, 20),
      adsEnabled: value.adsEnabled !== false,
      watermarkEnabled: value.watermarkEnabled !== false,
      languageDefault: String(value.languageDefault || 'en').substring(0, 5),
      maintenanceMode: !!value.maintenanceMode,
      maintenanceMessage: {
        ar: String((value.maintenanceMessage && value.maintenanceMessage.ar) || '').substring(0, 500),
        en: String((value.maintenanceMessage && value.maintenanceMessage.en) || '').substring(0, 500),
        fr: String((value.maintenanceMessage && value.maintenanceMessage.fr) || '').substring(0, 500)
      }
    };
  }

  await db.ref('config/' + key).set(value);
  return res.status(200).json({ success: true });
}

async function adminChangePassword(req, body, res) {
  if (!await verifyAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const np = String(body.newPassword || '');
  if (np.length < 6) return res.status(400).json({ error: 'Password too short (min 6)' });
  await db.ref('config/adminPassword').set(np);
  return res.status(200).json({ success: true });
}

async function adminStats(req, res) {
  if (!await verifyAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const snap = await db.ref('referrals').once('value');
  const refs = snap.val() || {};
  let totalRefs = 0;
  const users = Object.keys(refs);
  users.forEach(uid => {
    const c = refs[uid];
    if (c && typeof c.count === 'number') totalRefs += c.count;
  });
  const cfgSnap = await db.ref('config/vipTiers').once('value');
  const tiers = cfgSnap.val() || DEFAULTS.vipTiers;
  const firstTier = (tiers[0] && tiers[0].referrals) || 5;
  let reached = 0;
  users.forEach(uid => {
    if (refs[uid] && refs[uid].count >= firstTier) reached++;
  });
  const tiersCount = tiers.length;
  const topTier = tiers[tiersCount - 1] && tiers[tiersCount - 1].minutes;
  return res.status(200).json({
    totalUsers: users.length,
    totalRefs,
    reached,
    topTier: topTier || 0,
    tiersCount
  });
}

async function adminReferrers(req, res) {
  if (!await verifyAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const snap = await db.ref('referrals').once('value');
  const refs = snap.val() || {};
  const list = Object.keys(refs).map(uid => ({
    uid,
    count: (refs[uid] && refs[uid].count) || 0
  })).sort((a, b) => b.count - a.count).slice(0, 20);
  return res.status(200).json({ list });
}

/* ============================================================
   Main handler
   ============================================================ */
module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pass');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  const action = body.action || req.query.action;
  const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();

  try {
    switch (action) {
      case 'config':                return await getConfig(res);
      case 'referral-count':        return await getRefCount(body, res);
      case 'increment-referral':    return await incRef(body, ip, res);
      case 'admin-login':           return await adminLogin(body, ip, res);
      case 'admin-get-config':      return await adminGetConfig(req, res);
      case 'admin-save-key':        return await adminSaveKey(req, body, res);
      case 'admin-change-password': return await adminChangePassword(req, body, res);
      case 'admin-stats':           return await adminStats(req, res);
      case 'admin-referrers':       return await adminReferrers(req, res);
      default:
        return res.status(400).json({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
};
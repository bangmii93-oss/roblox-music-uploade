require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const ROBLOX_CREATOR_TYPE = process.env.ROBLOX_CREATOR_TYPE || 'User';
const ROBLOX_CREATOR_ID = process.env.ROBLOX_CREATOR_ID;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory job store: operationId -> { status, assetId, error, displayName, operationPath }
const jobs = {};

const MAX_ATTEMPTS = 360; // 30 menit di 5s interval sebelum auto-poll berhenti sementara
const POLL_INTERVAL_MS = 5000;

/**
 * STEP 1: Upload SATU FILE ke Roblox Open Cloud, kembalikan operation id.
 * Dipakai secara internal oleh /api/upload-batch untuk tiap file.
 */
async function uploadOneFile(file, displayNameRaw) {
  const displayName = (displayNameRaw || file.originalname || 'Untitled Audio').slice(0, 50);

  const requestPayload = {
    assetType: 'Audio',
    displayName,
    description: 'Uploaded via Roblox Music Uploader',
    creationContext: {
      creator:
        ROBLOX_CREATOR_TYPE === 'Group'
          ? { groupId: Number(ROBLOX_CREATOR_ID) }
          : { userId: Number(ROBLOX_CREATOR_ID) }
    }
  };

  const form = new FormData();
  form.append('request', JSON.stringify(requestPayload));
  form.append('fileContent', file.buffer, {
    filename: file.originalname,
    contentType: file.mimetype || 'audio/mpeg'
  });

  const uploadRes = await axios.post('https://apis.roblox.com/assets/v1/assets', form, {
    headers: {
      ...form.getHeaders(),
      'x-api-key': ROBLOX_API_KEY
    }
  });

  const operationPath = uploadRes.data.path;
  const operationId = operationPath.split('/').pop();

  jobs[operationId] = {
    status: 'Pending',
    assetId: null,
    error: null,
    displayName,
    fileName: file.originalname,
    operationPath
  };

  pollRobloxStatus(operationId, operationPath);

  return { operationId, fileName: file.originalname, displayName };
}

/**
 * STEP 1 (BATCH): Terima banyak file sekaligus. Tiap file diupload independen
 * ke Roblox (satu request per file, karena API Roblox memang per-asset),
 * lalu masing-masing dapat operationId & job sendiri.
 */
app.post('/api/upload-batch', upload.array('audio', 25), async (req, res) => {
  try {
    if (!ROBLOX_API_KEY || !ROBLOX_CREATOR_ID) {
      return res.status(500).json({ error: 'Server belum diisi ROBLOX_API_KEY / ROBLOX_CREATOR_ID (cek file .env)' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Tidak ada file audio yang dikirim' });
    }

    // displayNames dikirim sebagai JSON array string, urutannya sejajar dengan req.files
    let displayNames = [];
    try {
      displayNames = JSON.parse(req.body.displayNames || '[]');
    } catch (e) {
      displayNames = [];
    }

    const results = [];
    const errors = [];

    // Upload berurutan (bukan Promise.all) supaya tidak membanjiri Roblox API
    // sekaligus dan gampang dilacak kalau salah satu gagal duluan.
    for (let i = 0; i < req.files.length; i++) {
      try {
        const result = await uploadOneFile(req.files[i], displayNames[i]);
        results.push(result);
      } catch (err) {
        errors.push({
          fileName: req.files[i].originalname,
          error: err.response?.data?.message || err.message
        });
      }
    }

    res.json({ uploaded: results, failed: errors });
  } catch (err) {
    console.error('Batch upload error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

/**
 * STEP 2: Poll Roblox sampai operation upload-nya sendiri selesai (asset object dibuat).
 * CATATAN: ini BELUM berarti moderasi lolos - Roblox bikin asset object dulu,
 * baru jalanin moderasi konten terpisah. moderationResult dicek berikutnya.
 */
async function pollRobloxStatus(operationId, operationPath, attempt = 0) {
  try {
    const statusRes = await axios.get(`https://apis.roblox.com/assets/v1/${operationPath}`, {
      headers: { 'x-api-key': ROBLOX_API_KEY }
    });

    const data = statusRes.data;

    if (data.done) {
      if (data.response && data.response.assetId) {
        const assetId = data.response.assetId;
        jobs[operationId].assetId = assetId;

        const moderationState = data.response.moderationResult?.moderationState;

        if (moderationState === 'MODERATION_STATE_APPROVED') {
          jobs[operationId].status = 'Approved';
        } else if (moderationState === 'MODERATION_STATE_REJECTED') {
          jobs[operationId].status = 'Rejected';
          jobs[operationId].error = 'Ditolak moderasi Roblox';
        } else {
          jobs[operationId].status = 'Pending';
          pollAssetModeration(operationId, assetId);
        }
      } else if (data.error) {
        jobs[operationId].status = 'Rejected';
        jobs[operationId].error = data.error.message || 'Ditolak moderasi Roblox';
      } else {
        jobs[operationId].status = 'Rejected';
        jobs[operationId].error = 'Moderasi selesai tapi tidak ada assetId';
      }
      return;
    }

    if (attempt >= MAX_ATTEMPTS) {
      jobs[operationId].status = 'AwaitingManualRecheck';
      jobs[operationId].error = 'Auto-check dihentikan sementara, klik "Cek ulang status" untuk lanjut cek manual';
      return;
    }

    setTimeout(() => pollRobloxStatus(operationId, operationPath, attempt + 1), POLL_INTERVAL_MS);
  } catch (err) {
    jobs[operationId].status = 'Error';
    jobs[operationId].error = err.response?.data?.message || err.message;
  }
}

/**
 * STEP 2b: Setelah asset ada, terus cek verdict moderasi aslinya
 * (moderationResult.moderationState) sampai settle jadi Approved/Rejected.
 */
async function pollAssetModeration(operationId, assetId, attempt = 0) {
  try {
    const assetRes = await axios.get(`https://apis.roblox.com/assets/v1/assets/${assetId}`, {
      headers: { 'x-api-key': ROBLOX_API_KEY }
    });

    const moderationState = assetRes.data.moderationResult?.moderationState;

    if (moderationState === 'MODERATION_STATE_APPROVED') {
      jobs[operationId].status = 'Approved';
      jobs[operationId].assetId = assetId;
      return;
    }
    if (moderationState === 'MODERATION_STATE_REJECTED') {
      jobs[operationId].status = 'Rejected';
      jobs[operationId].error = 'Ditolak moderasi Roblox';
      return;
    }

    if (attempt >= MAX_ATTEMPTS) {
      jobs[operationId].status = 'AwaitingManualRecheck';
      jobs[operationId].error = 'Auto-check dihentikan sementara, klik "Cek ulang status" untuk lanjut cek manual';
      return;
    }

    setTimeout(() => pollAssetModeration(operationId, assetId, attempt + 1), POLL_INTERVAL_MS);
  } catch (err) {
    jobs[operationId].status = 'Error';
    jobs[operationId].error = err.response?.data?.message || err.message;
  }
}

/**
 * STEP 3: Client polling status satu job.
 */
app.get('/api/status/:operationId', (req, res) => {
  const job = jobs[req.params.operationId];
  if (!job) return res.status(404).json({ error: 'Job tidak ditemukan' });
  res.json(job);
});

/**
 * STEP 3b (BATCH): Client polling status banyak job sekaligus lewat query string
 * ?ids=id1,id2,id3 supaya tidak perlu N request terpisah tiap tick.
 */
app.get('/api/status-batch', (req, res) => {
  const ids = (req.query.ids || '').split(',').filter(Boolean);
  const result = {};
  for (const id of ids) {
    result[id] = jobs[id] || { status: 'NotFound', error: 'Job tidak ditemukan' };
  }
  res.json(result);
});

/**
 * STEP 4: Manual recheck untuk satu job (dipanggil dari tombol "Cek ulang status").
 */
app.post('/api/recheck/:operationId', async (req, res) => {
  const operationId = req.params.operationId;
  const job = jobs[operationId];
  if (!job) return res.status(404).json({ error: 'Job tidak ditemukan' });

  try {
    if (job.assetId) {
      const assetRes = await axios.get(`https://apis.roblox.com/assets/v1/assets/${job.assetId}`, {
        headers: { 'x-api-key': ROBLOX_API_KEY }
      });
      const moderationState = assetRes.data.moderationResult?.moderationState;

      if (moderationState === 'MODERATION_STATE_APPROVED') {
        job.status = 'Approved';
        job.error = null;
      } else if (moderationState === 'MODERATION_STATE_REJECTED') {
        job.status = 'Rejected';
        job.error = 'Ditolak moderasi Roblox';
      } else {
        job.status = 'Pending';
        job.error = null;
        pollAssetModeration(operationId, job.assetId);
      }
    } else if (job.operationPath) {
      const statusRes = await axios.get(`https://apis.roblox.com/assets/v1/${job.operationPath}`, {
        headers: { 'x-api-key': ROBLOX_API_KEY }
      });
      const data = statusRes.data;

      if (data.done && data.response?.assetId) {
        job.assetId = data.response.assetId;
        job.status = 'Pending';
        job.error = null;
        pollAssetModeration(operationId, job.assetId);
      } else {
        job.status = 'Pending';
        job.error = null;
        pollRobloxStatus(operationId, job.operationPath);
      }
    } else {
      return res.status(400).json({ error: 'Job tidak punya operationPath maupun assetId, tidak bisa di-recheck' });
    }

    res.json(job);
  } catch (err) {
    job.status = 'Error';
    job.error = err.response?.data?.message || err.message;
    res.status(500).json(job);
  }
});

app.listen(PORT, () => {
  console.log(`Roblox Music Uploader jalan di http://localhost:${PORT}`);
});

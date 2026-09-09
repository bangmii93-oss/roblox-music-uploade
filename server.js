require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const { EventEmitter } = require('events');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const ROBLOX_CREATOR_TYPE = process.env.ROBLOX_CREATOR_TYPE || 'User';
const ROBLOX_CREATOR_ID = process.env.ROBLOX_CREATOR_ID;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory job store: operationId -> { status, assetId, error, displayName, fileName, operationPath }
const jobs = {};

// Dipakai buat siaran (broadcast) tiap kali status job berubah, supaya semua
// tab yang lagi buka bisa update REALTIME tanpa harus nanya-nanya (polling).
const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(0);

const MAX_ATTEMPTS = 360; // 30 menit di 5s interval sebelum auto-poll berhenti sementara
const POLL_INTERVAL_MS = 5000;

/**
 * Satu-satunya tempat yang boleh mengubah isi job. Setiap perubahan langsung
 * disiarkan ke semua client yang lagi dengar lewat SSE (/api/events).
 */
function updateJob(operationId, patch) {
  if (!jobs[operationId]) return;
  Object.assign(jobs[operationId], patch);
  jobEvents.emit('update', { operationId, ...jobs[operationId] });
}

/**
 * STEP 1: Upload SATU FILE ke Roblox Open Cloud, kembalikan operation id.
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
  jobEvents.emit('update', { operationId, ...jobs[operationId] });

  pollRobloxStatus(operationId, operationPath);

  return { operationId, fileName: file.originalname, displayName };
}

/**
 * STEP 1 (BATCH): Terima banyak file sekaligus, upload berurutan ke Roblox.
 */
app.post('/api/upload-batch', upload.array('audio', 25), async (req, res) => {
  try {
    if (!ROBLOX_API_KEY || !ROBLOX_CREATOR_ID) {
      return res.status(500).json({ error: 'Server belum diisi ROBLOX_API_KEY / ROBLOX_CREATOR_ID (cek file .env)' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Tidak ada file audio yang dikirim' });
    }

    let displayNames = [];
    try {
      displayNames = JSON.parse(req.body.displayNames || '[]');
    } catch (e) {
      displayNames = [];
    }

    const results = [];
    const errors = [];

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
        const moderationState = data.response.moderationResult?.moderationState;

        if (moderationState === 'MODERATION_STATE_APPROVED') {
          updateJob(operationId, { status: 'Approved', assetId });
        } else if (moderationState === 'MODERATION_STATE_REJECTED') {
          updateJob(operationId, { status: 'Rejected', assetId, error: 'Ditolak moderasi Roblox' });
        } else {
          updateJob(operationId, { status: 'Pending', assetId });
          pollAssetModeration(operationId, assetId);
        }
      } else if (data.error) {
        updateJob(operationId, { status: 'Rejected', error: data.error.message || 'Ditolak moderasi Roblox' });
      } else {
        updateJob(operationId, { status: 'Rejected', error: 'Moderasi selesai tapi tidak ada assetId' });
      }
      return;
    }

    if (attempt >= MAX_ATTEMPTS) {
      updateJob(operationId, {
        status: 'AwaitingManualRecheck',
        error: 'Auto-check dihentikan sementara, klik "Cek ulang status" untuk lanjut cek manual'
      });
      return;
    }

    setTimeout(() => pollRobloxStatus(operationId, operationPath, attempt + 1), POLL_INTERVAL_MS);
  } catch (err) {
    updateJob(operationId, { status: 'Error', error: err.response?.data?.message || err.message });
  }
}

/**
 * STEP 2b: Setelah asset ada, terus cek verdict moderasi aslinya sampai settle.
 * Ini bagian yang paling sering diakses - dipakai buat mastiin status Approved/Rejected
 * ke-detect secepat mungkin lalu langsung disiarkan lewat SSE.
 */
async function pollAssetModeration(operationId, assetId, attempt = 0) {
  try {
    const assetRes = await axios.get(`https://apis.roblox.com/assets/v1/assets/${assetId}`, {
      headers: { 'x-api-key': ROBLOX_API_KEY }
    });

    const moderationState = assetRes.data.moderationResult?.moderationState;

    if (moderationState === 'MODERATION_STATE_APPROVED') {
      updateJob(operationId, { status: 'Approved', assetId });
      return;
    }
    if (moderationState === 'MODERATION_STATE_REJECTED') {
      updateJob(operationId, { status: 'Rejected', assetId, error: 'Ditolak moderasi Roblox' });
      return;
    }

    if (attempt >= MAX_ATTEMPTS) {
      updateJob(operationId, {
        status: 'AwaitingManualRecheck',
        error: 'Auto-check dihentikan sementara, klik "Cek ulang status" untuk lanjut cek manual'
      });
      return;
    }

    setTimeout(() => pollAssetModeration(operationId, assetId, attempt + 1), POLL_INTERVAL_MS);
  } catch (err) {
    updateJob(operationId, { status: 'Error', error: err.response?.data?.message || err.message });
  }
}

/**
 * STEP 3: Client polling status satu job (dipakai sebagai fallback / snapshot awal).
 */
app.get('/api/status/:operationId', (req, res) => {
  const job = jobs[req.params.operationId];
  if (!job) return res.status(404).json({ error: 'Job tidak ditemukan' });
  res.json(job);
});

/**
 * STEP 3b (BATCH): Snapshot status banyak job sekaligus - dipakai sekali saat
 * halaman baru dibuka/direfresh untuk tahu status TERKINI sebelum SSE nyambung.
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
 * STEP 3c (REALTIME): Server-Sent Events. Client buka satu koneksi ini sekali,
 * lalu setiap kali ADA job yang statusnya berubah (approved/rejected/dsb),
 * server langsung dorong (push) datanya - client TIDAK perlu nanya berkala lagi.
 * Ini yang bikin update di web sinkron sama kondisi asli di Roblox/Studio.
 */
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('retry: 3000\n\n');

  const onUpdate = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  jobEvents.on('update', onUpdate);

  // Keep-alive comment tiap 20 detik supaya koneksi tidak ditutup paksa
  // oleh proxy/hosting (mis. Railway) yang punya idle timeout.
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    jobEvents.off('update', onUpdate);
  });
});

/**
 * STEP 4: Manual recheck untuk satu job (dipanggil dari tombol "cek ulang").
 * FIX: kalau server sudah tidak punya record job ini (restart/redeploy) tapi
 * client masih simpan assetId-nya di localStorage (dikirim di body), job
 * dibuat ulang di sini alih-alih langsung 404 - supaya recheck tetap bisa
 * jalan tanpa perlu upload ulang dari awal.
 */
app.post('/api/recheck/:operationId', async (req, res) => {
  const operationId = req.params.operationId;
  let job = jobs[operationId];
  const clientAssetId = req.body?.assetId;

  if (!job && clientAssetId) {
    jobs[operationId] = {
      status: 'Pending',
      assetId: clientAssetId,
      error: null,
      displayName: null,
      fileName: null,
      operationPath: null
    };
    job = jobs[operationId];
  }

  if (!job) return res.status(404).json({ error: 'Job tidak ditemukan' });

  try {
    if (job.assetId) {
      const assetRes = await axios.get(`https://apis.roblox.com/assets/v1/assets/${job.assetId}`, {
        headers: { 'x-api-key': ROBLOX_API_KEY }
      });
      const moderationState = assetRes.data.moderationResult?.moderationState;

      if (moderationState === 'MODERATION_STATE_APPROVED') {
        updateJob(operationId, { status: 'Approved', error: null });
      } else if (moderationState === 'MODERATION_STATE_REJECTED') {
        updateJob(operationId, { status: 'Rejected', error: 'Ditolak moderasi Roblox' });
      } else {
        updateJob(operationId, { status: 'Pending', error: null });
        pollAssetModeration(operationId, job.assetId);
      }
    } else if (job.operationPath) {
      const statusRes = await axios.get(`https://apis.roblox.com/assets/v1/${job.operationPath}`, {
        headers: { 'x-api-key': ROBLOX_API_KEY }
      });
      const data = statusRes.data;

      if (data.done && data.response?.assetId) {
        updateJob(operationId, { assetId: data.response.assetId, status: 'Pending', error: null });
        pollAssetModeration(operationId, data.response.assetId);
      } else {
        updateJob(operationId, { status: 'Pending', error: null });
        pollRobloxStatus(operationId, job.operationPath);
      }
    } else {
      return res.status(400).json({ error: 'Job tidak punya operationPath maupun assetId, tidak bisa di-recheck' });
    }

    res.json(jobs[operationId]);
  } catch (err) {
    updateJob(operationId, { status: 'Error', error: err.response?.data?.message || err.message });
    res.status(500).json(jobs[operationId]);
  }
});

/**
 * STEP 4b (FIX BARU): Dipanggil otomatis dari client saat /api/status-batch
 * balikin 'NotFound' untuk sebuah job, tapi client masih punya assetId-nya
 * di localStorage. Membuat ulang job record di server lalu langsung cek
 * status asli ke Roblox - supaya job yang "dilupakan" server (habis restart)
 * bisa pulih otomatis tanpa perlu user pencet apa-apa.
 */
app.post('/api/recheck-by-asset', async (req, res) => {
  const { operationId, assetId } = req.body || {};
  if (!operationId || !assetId) {
    return res.status(400).json({ error: 'operationId dan assetId wajib diisi' });
  }

  jobs[operationId] = jobs[operationId] || {
    status: 'Pending',
    assetId,
    error: null,
    displayName: null,
    fileName: null,
    operationPath: null
  };

  try {
    const assetRes = await axios.get(`https://apis.roblox.com/assets/v1/assets/${assetId}`, {
      headers: { 'x-api-key': ROBLOX_API_KEY }
    });
    const moderationState = assetRes.data.moderationResult?.moderationState;

    if (moderationState === 'MODERATION_STATE_APPROVED') {
      updateJob(operationId, { status: 'Approved', error: null });
    } else if (moderationState === 'MODERATION_STATE_REJECTED') {
      updateJob(operationId, { status: 'Rejected', error: 'Ditolak moderasi Roblox' });
    } else {
      updateJob(operationId, { status: 'Pending', error: null });
      pollAssetModeration(operationId, assetId);
    }
    res.json(jobs[operationId]);
  } catch (err) {
    updateJob(operationId, { status: 'Error', error: err.response?.data?.message || err.message });
    res.status(500).json(jobs[operationId]);
  }
});

app.listen(PORT, () => {
  console.log(`Roblox Music Uploader jalan di http://localhost:${PORT}`);
});

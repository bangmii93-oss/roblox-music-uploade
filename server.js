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

// In-memory job store: operationId -> { status, assetId, error }
const jobs = {};

/**
 * STEP 1: Upload audio file to Roblox Open Cloud, get back an operation id.
 */
app.post('/api/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!ROBLOX_API_KEY || !ROBLOX_CREATOR_ID) {
      return res.status(500).json({ error: 'Server belum diisi ROBLOX_API_KEY / ROBLOX_CREATOR_ID (cek file .env)' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Tidak ada file audio yang dikirim' });
    }

    const displayName = (req.body.displayName || req.file.originalname || 'Untitled Audio').slice(0, 50);

    const requestPayload = {
      assetType: 'Audio',
      displayName,
      description: req.body.description || 'Uploaded via Roblox Music Uploader',
      creationContext: {
        creator:
          ROBLOX_CREATOR_TYPE === 'Group'
            ? { groupId: Number(ROBLOX_CREATOR_ID) }
            : { userId: Number(ROBLOX_CREATOR_ID) }
      }
    };

    const form = new FormData();
    form.append('request', JSON.stringify(requestPayload));
    form.append('fileContent', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype || 'audio/mpeg'
    });

    const uploadRes = await axios.post('https://apis.roblox.com/assets/v1/assets', form, {
      headers: {
        ...form.getHeaders(),
        'x-api-key': ROBLOX_API_KEY
      }
    });

    // Roblox returns something like { path: "operations/1234567890" }
    const operationPath = uploadRes.data.path;
    const operationId = operationPath.split('/').pop();

    jobs[operationId] = { status: 'Pending', assetId: null, error: null, displayName };

    res.json({ operationId, status: 'Pending' });

    // Kick off background polling so the client can just poll our own /api/status
    pollRobloxStatus(operationId, operationPath);
  } catch (err) {
    console.error('Upload error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

/**
 * STEP 2: Poll Roblox until the upload operation itself finishes (asset object created).
 * NOTE: this does NOT mean moderation passed yet - Roblox creates the asset object
 * first, then runs content moderation separately. We check moderationResult next.
 */
async function pollRobloxStatus(operationId, operationPath, attempt = 0) {
  const MAX_ATTEMPTS = 60; // ~5 minutes at 5s interval
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
          jobs[operationId].status = 'Approved';
          jobs[operationId].assetId = assetId;
        } else if (moderationState === 'MODERATION_STATE_REJECTED') {
          jobs[operationId].status = 'Rejected';
          jobs[operationId].error = 'Ditolak moderasi Roblox';
        } else {
          // Asset object created, but moderation verdict not final yet.
          // Keep checking the asset itself until moderation settles.
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
      jobs[operationId].status = 'Timeout';
      jobs[operationId].error = 'Melebihi batas waktu menunggu moderasi';
      return;
    }

    setTimeout(() => pollRobloxStatus(operationId, operationPath, attempt + 1), 5000);
  } catch (err) {
    jobs[operationId].status = 'Error';
    jobs[operationId].error = err.response?.data?.message || err.message;
  }
}

/**
 * STEP 2b: Once the asset exists, keep checking its real moderation verdict
 * (moderationResult.moderationState) until it settles as Approved/Rejected.
 */
async function pollAssetModeration(operationId, assetId, attempt = 0) {
  const MAX_ATTEMPTS = 60; // ~5 more minutes at 5s interval
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
      jobs[operationId].status = 'Timeout';
      jobs[operationId].error = 'Melebihi batas waktu menunggu hasil moderasi akhir';
      return;
    }

    setTimeout(() => pollAssetModeration(operationId, assetId, attempt + 1), 5000);
  } catch (err) {
    jobs[operationId].status = 'Error';
    jobs[operationId].error = err.response?.data?.message || err.message;
  }
}

/**
 * STEP 3: Client polls this to see if moderation is done and get the asset ID.
 */
app.get('/api/status/:operationId', (req, res) => {
  const job = jobs[req.params.operationId];
  if (!job) return res.status(404).json({ error: 'Job tidak ditemukan' });
  res.json(job);
});

app.listen(PORT, () => {
  console.log(`Roblox Music Uploader jalan di http://localhost:${PORT}`);
});

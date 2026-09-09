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

// Nunggu operation upload SELESAI DIBUAT (asset object-nya jadi), BUKAN
// nunggu moderasi Roblox kelar. Begitu asset id muncul, langsung dianggap
// beres - tidak ada pengecekan approve/reject sama sekali di sini.
const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 30; // ~1 menit nunggu asset object-nya jadi

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Upload satu file ke Roblox Open Cloud, lalu tunggu sampai operation-nya
 * selesai supaya bisa ambil assetId. Tidak ada pengecekan moderationState
 * di sini - assetId langsung dikembalikan begitu operation "done".
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

  // Poll operation sampai "done" - cuma buat dapetin assetId, bukan buat
  // ngecek status moderasinya.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const statusRes = await axios.get(`https://apis.roblox.com/assets/v1/${operationPath}`, {
      headers: { 'x-api-key': ROBLOX_API_KEY }
    });
    const data = statusRes.data;

    if (data.done) {
      if (data.response && data.response.assetId) {
        return { fileName: file.originalname, displayName, assetId: data.response.assetId };
      }
      const msg = data.error?.message || 'Asset gagal dibuat (tidak ada assetId)';
      throw new Error(msg);
    }

    await wait(POLL_INTERVAL_MS);
  }

  throw new Error('Timeout menunggu Roblox selesai membuat asset');
}

/**
 * Terima banyak file sekaligus, upload berurutan ke Roblox, langsung
 * kembalikan assetId per file begitu asset-nya jadi.
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

app.listen(PORT, () => {
  console.log(`Roblox Music Uploader jalan di http://localhost:${PORT}`);
});

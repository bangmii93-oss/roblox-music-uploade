# Roblox Music Uploader

Web app untuk upload musik ke Roblox lewat Open Cloud API, dengan:
- Preview audio + kontrol playback speed sebelum upload
- Upload otomatis ke Roblox
- Polling status moderasi otomatis, begitu lolos langsung tampil Asset ID

## Setup

1. Install dependency:
   ```
   npm install
   ```

2. Copy `.env.example` jadi `.env`, lalu isi:
   ```
   ROBLOX_API_KEY=isi_api_key_kamu
   ROBLOX_CREATOR_TYPE=User        # atau "Group"
   ROBLOX_CREATOR_ID=isi_user_id_atau_group_id
   ```

   API key dibuat di: https://create.roblox.com/dashboard/credentials
   Pastikan API key punya izin (scope) **Assets: Write & Read** untuk User/Group yang sesuai.

3. Jalankan:
   ```
   npm start
   ```

4. Buka `http://localhost:3000` di browser.

## Cara pakai

1. Pilih file audio → otomatis muncul player preview.
2. Geser slider "Playback speed" untuk dengar di kecepatan berbeda sebelum upload.
3. Isi nama tampilan (opsional, default nama file).
4. Klik "Upload ke Roblox".
5. App akan otomatis polling status moderasi tiap 3 detik. Begitu Roblox meluluskan, Asset ID langsung muncul di layar — tinggal disalin dan dipakai di game.

## Catatan penting

- Roblox membatasi format & durasi audio (umumnya .mp3/.ogg, maksimal beberapa menit tergantung tipe akun). File yang tidak sesuai akan otomatis ditolak oleh Roblox saat step upload.
- Moderasi Roblox bisa makan waktu dari beberapa detik sampai beberapa menit — server akan terus polling sampai 5 menit sebelum dianggap timeout.
- Fitur cek copyright (dari rencana awal) belum ada di scaffold ini — bisa ditambahkan dengan mengintegrasikan API fingerprinting audio (misalnya AudD atau ACRCloud) sebelum step upload di `server.js`.
- Jangan commit file `.env` (berisi API key) ke Git/publik manapun.

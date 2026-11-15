# PRD: WhatsApp Bot Base (Production-Ready)

## Introduction

Membangun **base codebot WhatsApp** yang siap production: klien WhatsApp (via `zapo-js`), storage SQLite, multi-session, event dispatch, command parser, utils, serta helper button/media. Ini fondasi inti — fitur bisnis (order, booking, dll) menyusul lewat command plugin.

Base sudah lengkap sebagai kerangka. Yang dikerjakan sekarang HANYA kerangka + 3 command demo (ping, menu, help).

## Goals

- Bot run terus-menerus, reconnect otomatis, state persist antar-restart
- Multi-session: satu proses tangani banyak nomor WhatsApp
- Pairing fleksibel: QR scan + 8-char pairing code (configurable)
- Sistem command extensible: tambah fitur = tambah satu file handler, tanpa ubah core
- Helper ready untuk button, media, dan utils umum
- Bootstrap cepat: `npm install && npm start` langsung jalan

## User Stories

### US-001: Bot connect & pair
**Description:** Sebagai operator, saya bisa menjalankan bot, scan QR atau masukkan pairing code, dan bot online.
**Acceptance Criteria:**
- [ ] `npm start` launch client, default session
- [ ] Emit `auth_qr` → tampil QR terminal
- [ ] Emit `auth_code` → tampil pairing code 8 karakter
- [ ] Setelah scan, state tersimpan di SQLite, restart tidak perlu pair ulang
- [ ] Typecheck/lint passes

### US-002: Multi-session
**Description:** Sebagai operator, saya bisa add/remove beberapa nomor pada proses yang sama.
**Acceptance Criteria:**
- [ ] Setiap nomor = `sessionId` unik
- [ ] Store memisahkan state per sessionId
- [ ] Command admin untuk list & stop session
- [ ] Gagal satu session tidak menghentikan session lain
- [ ] Typecheck/lint passes

### US-003: Command parser
**Description:** Sebagai pengguna, saya bisa kirim command (mis. `!ping`, `!menu`).
**Acceptance Criteria:**
- [ ] Prefix default `!`, configurable per-session
- [ ] Parser pisahkan command, args, dan mentions
- [ ] Command tak dikenal → balas `!help`
- [ ] Command handler terdaftar via registry sederhana
- [ ] Typecheck/lint passes

### US-004: Button & media helper
**Description:** Sebagai bot, saya bisa kirim pesan button dan media sesuai kebutuhan.
**Acceptance Criteria:**
- [ ] Helper kirim text + button list
- [ ] Helper kirim media (image/document) dari file/buffer
- [ ] Event `button` menangkap reply button
- [ ] Typecheck/lint passes

### US-005: Command demo (ping/menu/help)
**Description:** Sebagai pengguna, saya bisa uji bot dengan command dasar.
**Acceptance Criteria:**
- [ ] `!ping` → balas `pong` + latency
- [ ] `!menu` → daftar command aktif
- [ ] `!help [cmd]` → penjelasan per command
- [ ] Ketiganya jadi contoh pola penulisan command baru
- [ ] Typecheck/lint passes

## Functional Requirements

- FR-1: Inisialisasi `WaClient` per sessionId dengan store terbagi
- FR-2: Store SQLite (`@zapo-js/store-sqlite`) persist auth, signal, appState, messages, threads, contacts
- FR-3: Event wiring minimal: `auth_qr`, `auth_code`, `auth_paired`, `message`, `button`, `group`, `disconnected`
- FR-4: Reconnect & backoff otomatis pada `disconnected`
- FR-5: Registry command: register/alias/handler, dukungan async
- FR-6: Utils: extract text, JID helpers, format latency, sanitize input
- FR-7: Helper button (text+button list) dan media (kirim file/buffer)
- FR-8: Config via env: `DEFAULT_SESSION`, `COMMAND_PREFIX`, `PAIRING_MODE` (`qr`|`code`|`both`)
- FR-9: Logging pino, level configurable

## Non-Goals (Out of Scope)

- Tanpa command bisnis (order, booking, CRM, dll)
- Tanpa scheduler/cron job
- Tanpa anti-spam / moderation
- Tanpa web dashboard / admin UI
- Tanpa deployment script (Docker/docker) — menyusul
- Tanpa framework command pihak ketiga — gunakan registry internal sederhana

## Technical Considerations

- Runtime: Node 22+ (pakai `node:sqlite` native bila memungkinkan, tanpa native addon)
- Deps inti: `zapo-js`, `@zapo-js/store-sqlite`, `pino`, `pino-pretty`
- Multi-session via array config session; tiap session gabung satu store backend
- Command handler polos function: `({ client, event, args, session }) => void`
- Kode JS (ESM), tanpa TypeScript build step

## Success Metrics

- Time-to-first-reply setelah install < 5 menit
- Restart bot tidak memerlukan re-pair (state persist)
- Tambah command baru tanpa edit core: cukup satu file handler + register
- Satu proses jalan stabil untuk multiple session dengan memori wajar

## Open Questions

- Perlu Perlukah command prefix berbeda per session?
- Perlu dukungan media download ke disk di base ini?
- Butuh rate-limit per session sekarang, atau menyusul?

/*
  TT CITY CRM — мост Wazzup24 ⇄ CRM (входящие + исходящие в реальном времени)
  Один файл. Запускается где угодно: Render, Railway, Glitch, свой VPS, или локально+ngrok.

  Что делает:
   • принимает webhook от Wazzup24 (входящие сообщения клиентов) и хранит их;
   • отдаёт CRM накопленные сообщения по GET /messages (CRM опрашивает каждые 5 сек);
   • проксирует исходящие POST /send → Wazzup24 (чтобы ключ не светился в браузере).

  ── Запуск локально ──
    npm init -y && npm i express node-fetch@2 nodemailer
    WAZZUP_KEY=9eeb5eff811640a580c078df55cc9c3a CRM_TOKEN=tt-secret node wazzup-bridge.js
    npx ngrok http 3003           # получите публичный https-адрес

  ── Webhook в кабинете Wazzup24 ──
    Настройки → Вебхуки → URL:  https://ВАШ-АДРЕС/wazzup/webhook
    Включить «Сообщения и статусы».

  ── В CRM ──
    Настройки → Общий сервер → адрес = https://ВАШ-АДРЕС , токен = значение CRM_TOKEN
*/
const express = require('express');
const fetch = require('node-fetch');

const WAZZUP_KEY = process.env.WAZZUP_KEY || '9eeb5eff811640a580c078df55cc9c3a';
const CRM_TOKEN  = process.env.CRM_TOKEN  || 'tt-secret';
const PORT       = process.env.PORT || 3003;
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://wazzup-crm.onrender.com';

const app = express();
app.use(express.json({ limit: '40mb' }));

// CORS — чтобы CRM (другой домен) могла обращаться
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.end();
  next();
});

// ─── ОБЩАЯ БАЗА CRM (один JSON для всех менеджеров) ───
const fs = require('fs');
const DB_FILE = 'crm-db.json';
let crmStore = { v: 0, data: null };
try { if (fs.existsSync(DB_FILE)) crmStore = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
function crmPersist() { try { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(crmStore)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); } catch (e) {} }
// отдать всю базу
app.get('/db', auth, (_, res) => res.json(crmStore));
// принять обновлённую базу (берём только более свежую версию)
app.put('/db', auth, (req, res) => {
  const { v, data } = req.body || {};
  if (!data || !data.units) return res.status(400).json({ error: 'no data' });
  if ((v || 0) >= (crmStore.v || 0)) { crmStore = { v: v || Date.now(), data }; crmPersist(); }
  res.json({ ok: true, v: crmStore.v });
});

// ─── ПОЧТА: приглашения сотрудникам ───
// Задайте в Render → Environment: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
let mailer = null;
try {
  const nodemailer = require('nodemailer');
  if (process.env.SMTP_HOST) {
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 12000,
    });
  }
} catch (e) { console.log('nodemailer не установлен — добавьте в зависимости'); }

app.post('/invite', auth, async (req, res) => {
  const { name, email, login, password, role, link, company } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: 'нет email' });
  if (!mailer) return res.status(503).json({ ok: false, error: 'SMTP не настроен (задайте SMTP_* в Render)' });
  const co = company || 'TT CITY';
  const html = '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#1c1b18">' +
    '<div style="background:#1c1b18;color:#fff;padding:22px 26px;border-radius:14px 14px 0 0;font-size:18px;font-weight:700">' + co + ' · CRM</div>' +
    '<div style="border:1px solid #ece6db;border-top:none;border-radius:0 0 14px 14px;padding:24px 26px">' +
    '<p>Здравствуйте, <b>' + (name || '') + '</b>!</p>' +
    '<p>Вас пригласили в систему CRM ' + co + '. Данные для входа:</p>' +
    '<div style="background:#faf6ec;border:1px solid #ecdcbb;border-radius:10px;padding:14px 16px;margin:14px 0">' +
    'Логин: <b>' + (login || '') + '</b><br>Пароль: <b>' + (password || '') + '</b><br>Роль: ' + (role || '') + '</div>' +
    (link ? '<a href="' + link + '" style="display:inline-block;background:#a9854c;color:#fff;text-decoration:none;padding:11px 22px;border-radius:100px;font-weight:700">Войти в CRM</a>' : '') +
    '<p style="color:#8a8273;font-size:13px;margin-top:18px">После первого входа смените пароль в настройках.</p>' +
    '</div></div>';
  try {
    await mailer.sendMail({
      from: process.env.SMTP_FROM || ('CRM ' + co + ' <' + process.env.SMTP_USER + '>'),
      to: email, subject: 'Приглашение в CRM ' + co, html,
    });
    console.log('INVITE OK →', email);
    res.json({ ok: true });
  } catch (e) { console.log('INVITE FAIL →', email, ':', String(e.message || e)); res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// Хранилище сообщений в памяти (для продакшна замените на БД/файл)
let messages = [];   // {id, phone, name, from:'in'|'out', text, t}
let seq = 0;
const imageStore = {};  // id -> data:image/png;base64,...  (квартирные листы для Wazzup)

// Wazzup шлёт webhook сюда
app.post('/wazzup/webhook', (req, res) => {
  const body = req.body || {};
  const list = body.messages || (body.message ? [body.message] : []);
  for (const m of list) {
    const phone = '+' + String(m.chatId || '').replace(/\D/g, '');
    const uri = m.contentUri || '';
    const isImg = /\.(png|jpe?g|webp|gif)(\?|$)/i.test(uri) || (m.type && /image/i.test(m.type));
    const isFile = uri && !isImg;
    messages.push({
      id: ++seq,
      phone,
      name: (m.contact && m.contact.name) || m.authorName || phone,
      from: (m.isEcho === true || (m.status && m.status !== 'inbound')) ? 'out' : 'in',
      text: m.text || '',
      img: isImg ? uri : null,
      fileUrl: isFile ? uri : null,
      fileName: isFile ? (uri.split('/').pop().split('?')[0] || 'Документ') : null,
      kind: isImg ? 'image' : (isFile ? 'file' : 'text'),
      t: m.dateTime ? new Date(m.dateTime).getTime() : Date.now(),
    });
  }
  if (messages.length > 5000) messages = messages.slice(-5000);
  res.json({ ok: true });
});

// CRM опрашивает новые сообщения: GET /messages?since=<id>
app.get('/messages', auth, (req, res) => {
  const since = parseInt(req.query.since || '0');
  res.json({ lastId: seq, messages: messages.filter(m => m.id > since) });
});

// CRM отправляет картинку (квартирный лист PNG): POST /send-image {phone, imageBase64, filename, caption}
app.post('/send-image', auth, async (req, res) => {
  const { phone, imageBase64, filename, caption, channelId } = req.body;
  try {
    const ch = channelId || (await firstChannel());
    // Wazzup принимает contentUri (публичная ссылка). Хостим картинку на самом мосте.
    const id = 'img_' + (++seq) + '_' + Date.now();
    imageStore[id] = imageBase64; // data:image/png;base64,....
    const publicUri = PUBLIC_URL.replace(/\/+$/, '') + '/img/' + id + '.png';
    const chatId = String(phone).replace(/\D/g, '');
    const send = (payload) => fetch('https://api.wazzup24.com/v3/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + WAZZUP_KEY },
      body: JSON.stringify(Object.assign({ channelId: ch, chatType: 'whatsapp', chatId }, payload)),
    });
    // 1) картинка БЕЗ текста (Wazzup не принимает contentUri + text вместе → INVALID_MESSAGE_DATA)
    const r = await send({ contentUri: publicUri });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(400).json({ ok: false, error: (j.error && (j.error.description || j.error)) || ('код ' + r.status) });
    // 2) подпись отдельным сообщением
    if (caption) { try { await send({ text: caption }); } catch (e) {} }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// Отдаём захостенную картинку Wazzup-у (публично, без токена)
app.get('/img/:id.png', (req, res) => {
  const data = imageStore[req.params.id];
  if (!data) return res.status(404).end();
  const b64 = String(data).replace(/^data:image\/\w+;base64,/, '');
  res.set('Content-Type', 'image/png');
  res.send(Buffer.from(b64, 'base64'));
});

// CRM отправляет исходящее: POST /send {phone, text}
app.post('/send', auth, async (req, res) => {
  const { phone, text, channelId } = req.body;
  try {
    const ch = channelId || (await firstChannel());
    const r = await fetch('https://api.wazzup24.com/v3/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + WAZZUP_KEY },
      body: JSON.stringify({ channelId: ch, chatType: 'whatsapp', chatId: String(phone).replace(/\D/g, ''), text }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { res.json({ ok: true }); }
    else res.status(400).json({ ok: false, error: j.error || ('код ' + r.status) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.get('/status', auth, async (_, res) => {
  try {
    const r = await fetch('https://api.wazzup24.com/v3/channels', { headers: { Authorization: 'Bearer ' + WAZZUP_KEY } });
    const ch = await r.json();
    const wa = (Array.isArray(ch) ? ch : []).find(x => x.transport === 'whatsapp' || x.transport === 'wapi') || (ch || [])[0];
    res.json({ connected: wa && wa.state === 'active', channel: wa ? wa.channelId : null, state: wa ? wa.state : 'none' });
  } catch (e) { res.json({ connected: false, error: String(e) }); }
});

async function firstChannel() {
  const r = await fetch('https://api.wazzup24.com/v3/channels', { headers: { Authorization: 'Bearer ' + WAZZUP_KEY } });
  const ch = await r.json();
  const wa = (Array.isArray(ch) ? ch : []).find(x => x.transport === 'whatsapp' || x.transport === 'wapi') || (ch || [])[0];
  return wa ? wa.channelId : null;
}
function auth(req, res, next) {
  if (req.headers['x-token'] !== CRM_TOKEN) return res.status(401).json({ error: 'bad token' });
  next();
}

app.listen(PORT, () => console.log('Wazzup bridge → :' + PORT));

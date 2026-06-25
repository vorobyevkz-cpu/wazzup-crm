/*
  TT CITY CRM — мост Wazzup24 ⇄ CRM (входящие + исходящие в реальном времени)
  Один файл. Запускается где угодно: Render, Railway, Glitch, свой VPS, или локально+ngrok.

  Что делает:
   • принимает webhook от Wazzup24 (входящие сообщения клиентов) и хранит их;
   • отдаёт CRM накопленные сообщения по GET /messages (CRM опрашивает каждые 5 сек);
   • проксирует исходящие POST /send → Wazzup24 (чтобы ключ не светился в браузере).

  ── Запуск локально ──
    npm init -y && npm i express node-fetch@2
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
app.use(express.json({ limit: '2mb' }));

// CORS — чтобы CRM (другой домен) могла обращаться
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.end();
  next();
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

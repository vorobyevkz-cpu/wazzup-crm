const express = require('express');
const fetch = require('node-fetch');

const WAZZUP_KEY = process.env.WAZZUP_KEY || '9eeb5eff811640a580c078df55cc9c3a';
const CRM_TOKEN  = process.env.CRM_TOKEN  || 'tt-secret';
const PORT       = process.env.PORT || 3003;

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.end();
  next();
});

let messages = [];   
let seq = 0;

app.post('/wazzup/webhook', (req, res) => {
  const body = req.body || {};
  const list = body.messages || (body.message ? [body.message] : []);
  for (const m of list) {
    const phone = '+' + String(m.chatId || '').replace(/\D/g, '');
    messages.push({
      id: ++seq,
      phone,
      name: (m.contact && m.contact.name) || m.authorName || phone,
      from: m.isEcho || m.status ? 'out' : 'in',
      text: m.text || (m.contentUri ? '[вложение]' : ''),
      t: m.dateTime ? new Date(m.dateTime).getTime() : Date.now(),
    });
  }
  if (messages.length > 5000) messages = messages.slice(-5000);
  res.json({ ok: true });
});

app.get('/messages', auth, (req, res) => {
  const since = parseInt(req.query.since || '0');
  res.json({ lastId: seq, messages: messages.filter(m => m.id > since) });
});

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
    if (r.ok) { messages.push({ id: ++seq, phone, name: phone, from: 'out', text, t: Date.now() }); res.json({ ok: true }); }
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

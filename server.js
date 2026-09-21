import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || '.');
const BOTLIY_API_KEY = process.env.BOTLIY_API_KEY;
const BOTLIY_BASE_URL = (process.env.BOTLIY_BASE_URL || 'https://botliy.online/api/v1').replace(/\/$/, '');
const BOTLIY_CHAT_URL = `${BOTLIY_BASE_URL}/chat/completions`;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-v4.1';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

if (!BOTLIY_API_KEY) { console.error('BOTLIY_API_KEY missing'); process.exit(1); }

const USERS_DIR = path.join(DATA_DIR, 'user.storage');
const AI_DIR = path.join(DATA_DIR, 'data.ai');
const UPLOADS_DIR = path.join(AI_DIR, 'uploads');

await fs.mkdir(USERS_DIR, { recursive: true });
await fs.mkdir(AI_DIR, { recursive: true });
await fs.mkdir(UPLOADS_DIR, { recursive: true });

console.log(`users:  ${USERS_DIR}`);
console.log(`ai mem: ${AI_DIR}`);
console.log(`botliy: ${BOTLIY_CHAT_URL}`);

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

const safeId = (id) => /^[a-zA-Z0-9_-]+$/.test(id);
const readJSON = async (f, fb = null) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fb; } };
const writeJSON = (f, d) => fs.writeFile(f, JSON.stringify(d, null, 2));

async function findUserByEmail(email) {
  const files = await fs.readdir(USERS_DIR);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const u = await readJSON(path.join(USERS_DIR, f));
    if (u?.email?.toLowerCase() === email.toLowerCase()) return u;
  }
  return null;
}
async function findUserById(id) {
  if (!safeId(id)) return null;
  return readJSON(path.join(USERS_DIR, `${id}.json`));
}
const saveUser = (u) => writeJSON(path.join(USERS_DIR, `${u.id}.json`), u);

function auth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    req.userId = p.userId;
    req.tokenVersion = p.tv || 0;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const dir = path.join(UPLOADS_DIR, req.userId);
    await fs.mkdir(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ============ CLEAN URL ROUTES ============
// Serve HTML for clean paths
const page = (name) => (req, res) => res.sendFile(path.join(__dirname, 'public', name));

app.get('/', page('login.html'));
app.get('/login', page('login.html'));
app.get('/signup', page('signup.html'));
app.get('/chat', page('chat.html'));

// Static assets (css, js, svg, manifest, sw)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ============ AUTH ============
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (await findUserByEmail(email)) return res.status(409).json({ error: 'This email is already used' });

    const userId = crypto.randomBytes(12).toString('hex');
    const user = {
      id: userId, email: email.toLowerCase(),
      name: name || email.split('@')[0],
      passwordHash: await bcrypt.hash(password, 10),
      tokenVersion: 0, createdAt: new Date().toISOString(),
      conversations: [],
      settings: { theme: 'dark', language: 'system', voice: 'Mira', improveModel: true }
    };
    await saveUser(user);
    const token = jwt.sign({ userId, tv: 0 }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, settings: user.settings } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await findUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign({ userId: user.id, tv: user.tokenVersion || 0 }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, settings: user.settings } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

app.post('/api/logout-all', auth, async (req, res) => {
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await saveUser(user);
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', auth, async (req, res) => {
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if ((user.tokenVersion || 0) !== req.tokenVersion) {
    res.clearCookie('token');
    return res.status(401).json({ error: 'Session expired' });
  }
  res.json({ id: user.id, email: user.email, name: user.name, settings: user.settings || {} });
});

app.patch('/api/me', auth, async (req, res) => {
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { name, settings } = req.body || {};
  if (typeof name === 'string' && name.trim()) user.name = name.trim().slice(0, 60);
  if (settings && typeof settings === 'object') user.settings = { ...(user.settings || {}), ...settings };
  await saveUser(user);
  res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, settings: user.settings } });
});

app.delete('/api/me', auth, async (req, res) => {
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  for (const c of user.conversations || []) { try { await fs.unlink(path.join(AI_DIR, `${user.id}_${c.id}.json`)); } catch {} }
  try { await fs.rm(path.join(UPLOADS_DIR, user.id), { recursive: true, force: true }); } catch {}
  try { await fs.unlink(path.join(USERS_DIR, `${user.id}.json`)); } catch {}
  res.clearCookie('token');
  res.json({ ok: true });
});

// ============ CONVERSATIONS ============
app.get('/api/conversations', auth, async (req, res) => {
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user.conversations || []);
});

app.post('/api/conversations', auth, async (req, res) => {
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const id = crypto.randomBytes(8).toString('hex');
  const convo = { id, title: req.body?.title || 'New chat', createdAt: new Date().toISOString() };
  user.conversations = user.conversations || [];
  user.conversations.push(convo);
  await saveUser(user);
  await writeJSON(path.join(AI_DIR, `${user.id}_${id}.json`), {
    userId: user.id, conversationId: id, title: convo.title,
    createdAt: convo.createdAt, messages: []
  });
  res.json(convo);
});

app.get('/api/conversations/:id', auth, async (req, res) => {
  const { id } = req.params;
  if (!safeId(id)) return res.status(400).json({ error: 'Bad id' });
  const mem = await readJSON(path.join(AI_DIR, `${req.userId}_${id}.json`));
  if (!mem) return res.status(404).json({ error: 'Not found' });
  res.json(mem);
});

app.patch('/api/conversations/:id', auth, async (req, res) => {
  const { id } = req.params;
  if (!safeId(id)) return res.status(400).json({ error: 'Bad id' });
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { title } = req.body || {};
  if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'Bad title' });
  const c = (user.conversations || []).find(x => x.id === id);
  if (c) { c.title = title.trim().slice(0, 80); await saveUser(user); }
  const memPath = path.join(AI_DIR, `${user.id}_${id}.json`);
  const mem = await readJSON(memPath);
  if (mem) { mem.title = title.trim().slice(0, 80); await writeJSON(memPath, mem); }
  res.json({ ok: true });
});

app.delete('/api/conversations/:id', auth, async (req, res) => {
  const { id } = req.params;
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.conversations = (user.conversations || []).filter(c => c.id !== id);
  await saveUser(user);
  try { await fs.unlink(path.join(AI_DIR, `${req.userId}_${id}.json`)); } catch {}
  res.json({ ok: true });
});

app.delete('/api/conversations', auth, async (req, res) => {
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  for (const c of user.conversations || []) { try { await fs.unlink(path.join(AI_DIR, `${user.id}_${c.id}.json`)); } catch {} }
  user.conversations = [];
  await saveUser(user);
  res.json({ ok: true });
});

app.get('/api/search', auth, async (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  if (!q) return res.json([]);
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const results = [];
  for (const c of user.conversations || []) {
    const mem = await readJSON(path.join(AI_DIR, `${user.id}_${c.id}.json`));
    if (!mem) continue;
    for (const m of mem.messages || []) {
      if (typeof m.content === 'string' && m.content.toLowerCase().includes(q)) {
        const idx = m.content.toLowerCase().indexOf(q);
        results.push({
          conversationId: c.id, title: c.title, role: m.role, ts: m.ts,
          snippet: m.content.slice(Math.max(0, idx - 40), idx + q.length + 60)
        });
        if (results.length >= 40) break;
      }
    }
    if (results.length >= 40) break;
  }
  res.json(results);
});

app.get('/api/export', auth, async (req, res) => {
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const out = { user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt }, conversations: [] };
  for (const c of user.conversations || []) {
    const mem = await readJSON(path.join(AI_DIR, `${user.id}_${c.id}.json`));
    if (mem) out.conversations.push(mem);
  }
  res.setHeader('Content-Disposition', `attachment; filename="bluebex-export-${Date.now()}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(out, null, 2));
});

// ============ UPLOADS ============
app.post('/api/upload', auth, upload.array('files', 8), (req, res) => {
  const files = (req.files || []).map(f => ({
    name: f.originalname, size: f.size, mime: f.mimetype,
    url: `/api/files/${req.userId}/${f.filename}`
  }));
  res.json({ files });
});

app.get('/api/files/:uid/:name', auth, async (req, res) => {
  const { uid, name } = req.params;
  if (uid !== req.userId) return res.status(403).json({ error: 'Forbidden' });
  const safe = path.basename(name);
  const fp = path.join(UPLOADS_DIR, uid, safe);
  try { await fs.access(fp); res.sendFile(fp); }
  catch { res.status(404).json({ error: 'Not found' }); }
});

// ============ CHAT (SSE) ============
app.post('/api/chat', auth, async (req, res) => {
  try {
    const { conversationId, message, model, deepThink, search, attachments } = req.body;
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message required' });
    if (!safeId(conversationId)) return res.status(400).json({ error: 'Bad conversationId' });

    const user = await findUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const memPath = path.join(AI_DIR, `${req.userId}_${conversationId}.json`);
    const mem = await readJSON(memPath);
    if (!mem) return res.status(404).json({ error: 'Conversation not found' });

    mem.messages.push({
      role: 'user', content: message, ts: new Date().toISOString(),
      attachments: Array.isArray(attachments) ? attachments : []
    });

    if (mem.messages.filter(m => m.role === 'user').length === 1 && (!mem.title || mem.title === 'New chat')) {
      mem.title = message.slice(0, 40);
      const c = (user.conversations || []).find(x => x.id === conversationId);
      if (c) { c.title = mem.title; await saveUser(user); }
    }
    await writeJSON(memPath, mem);

    const apiMessages = [
      { role: 'system', content: 'You are Bluebex, a helpful, concise assistant.' },
      ...mem.messages.map(m => ({ role: m.role, content: m.content }))
    ];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    if (deepThink) send('thinking', { on: true });

    const body = { model: model || DEFAULT_MODEL, messages: apiMessages, stream: true };
    if (search) body.search = true;
    if (deepThink) body.reasoning = true;

    const upstream = await fetch(BOTLIY_CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BOTLIY_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify(body)
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('Upstream error:', upstream.status, errText);
      send('error', { error: 'Upstream API error', status: upstream.status, detail: errText });
      return res.end();
    }

    const contentType = upstream.headers.get('content-type') || '';
    let full = '';

    if (contentType.includes('text/event-stream') && upstream.body) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop();
        for (const line of parts) {
          const t = line.trim();
          if (!t || !t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const delta = j?.choices?.[0]?.delta?.content
                       ?? j?.choices?.[0]?.message?.content
                       ?? j?.choices?.[0]?.text ?? '';
            if (delta) { full += delta; send('delta', { text: delta }); }
          } catch {}
        }
      }
    } else {
      const data = await upstream.json();
      full = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '(no response)';
      send('delta', { text: full });
    }

    if (!full) full = '(no response)';
    mem.messages.push({ role: 'assistant', content: full, ts: new Date().toISOString() });
    await writeJSON(memPath, mem);
    send('done', { conversation: mem });
    res.end();
  } catch (err) {
    console.error('Chat error:', err);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    } catch {}
  }
});

app.post('/api/feedback', auth, async (req, res) => {
  const { conversationId, ts, vote } = req.body || {};
  if (!safeId(conversationId)) return res.status(400).json({ error: 'Bad id' });
  const memPath = path.join(AI_DIR, `${req.userId}_${conversationId}.json`);
  const mem = await readJSON(memPath);
  if (!mem) return res.status(404).json({ error: 'Not found' });
  const msg = mem.messages.find(m => m.ts === ts);
  if (msg) { msg.feedback = vote; await writeJSON(memPath, mem); }
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`running: http://localhost:${PORT}`));
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('Unauthorized'); }
  return res;
}

// ---------- Toast (created on demand) ----------
function toast(msg) {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.display = 'none'; }, 1700);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Markdown ----------
let codeBlocks = [];
function renderMarkdown(text) {
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang: lang || 'code', code });
    return `\u0000CB${codeBlocks.length - 1}\u0000`;
  });
  text = escapeHtml(text);
  text = text.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  text = text.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  text = text.replace(/^# (.*)$/gm, '<h1>$1</h1>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>');
  text = text.replace(/(<li>[\s\S]*?<\/li>)/g, m => `<ul>${m}</ul>`);
  text = text.replace(/\n{2,}/g, '</p><p>');
  text = `<p>${text}</p>`;
  text = text.replace(/\u0000CB(\d+)\u0000/g, (_, i) => {
    const b = codeBlocks[+i];
    return `<div class="code-head"><span>${escapeHtml(b.lang)}</span>
      <div class="code-actions">
        <button data-copy-code="${i}">Copy</button>
        <button data-dl-code="${i}">Download</button>
      </div></div><pre><code>${escapeHtml(b.code)}</code></pre>`;
  });
  return text;
}
document.addEventListener('click', async (e) => {
  const cp = e.target.closest('[data-copy-code]');
  if (cp) {
    const b = codeBlocks[+cp.dataset.copyCode];
    if (b) { await navigator.clipboard.writeText(b.code); toast('Copied'); }
  }
  const dl = e.target.closest('[data-dl-code]');
  if (dl) {
    const b = codeBlocks[+dl.dataset.dlCode];
    if (b) {
      const blob = new Blob([b.code], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `bluebex-${Date.now()}.${b.lang || 'txt'}`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }
});

// ---------- State ----------
const state = {
  user: null, conversations: [], currentId: null, messages: [],
  attachments: [], thinking: false, searchOn: false, streaming: false,
  settings: {}
};

// ---------- Boot ----------
async function boot() {
  const me = await (await api('/api/me')).json();
  state.user = me;
  state.settings = me.settings || {};
  $('#uname').textContent = me.name || me.email;
  $('#avatar').textContent = (me.name || me.email).charAt(0).toUpperCase();

  applyTheme(state.settings.theme || 'dark');
  if (localStorage.getItem('bb_collapsed') === '1') $('#sidebar').classList.add('collapsed');

  await loadConvos();
  bindUI();
  autoGrow();

  // Service worker
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'system') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'dark' : 'light';
  } else root.dataset.theme = t;
}

// ---------- Conversations ----------
async function loadConvos() {
  state.conversations = await (await api('/api/conversations')).json();
  renderConvos();
}
function groupByDate(list) {
  const today = new Date(); today.setHours(0,0,0,0);
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  const g = { Today: [], Yesterday: [], Older: [] };
  for (const c of list) {
    const d = new Date(c.createdAt);
    if (d >= today) g.Today.push(c);
    else if (d >= yest) g.Yesterday.push(c);
    else g.Older.push(c);
  }
  return g;
}
function renderConvos() {
  const nav = $('#convos');
  nav.innerHTML = '';
  const groups = groupByDate(state.conversations);
  for (const [label, items] of Object.entries(groups)) {
    if (!items.length) continue;
    const h = document.createElement('div');
    h.className = 'group-label';
    h.textContent = label;
    nav.appendChild(h);
    for (const c of items) {
      const el = document.createElement('div');
      el.className = 'convo' + (c.id === state.currentId ? ' active' : '');
      el.dataset.id = c.id;
      el.innerHTML = `<span class="t">${escapeHtml(c.title || 'Untitled')}</span>
        <button class="row-act">⋯</button>`;
      el.querySelector('.row-act').addEventListener('click', (e) => { e.stopPropagation(); convoMenu(c.id, e.currentTarget); });
      el.addEventListener('click', () => openConvo(c.id));
      nav.appendChild(el);
    }
  }
}
function convoMenu(id, anchor) {
  const old = document.getElementById('convoMenu');
  if (old) old.remove();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.id = 'convoMenu';
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left - 120, window.innerWidth - 180))}px`;
  menu.style.width = '160px';
  menu.innerHTML = `<button data-act="rename">Rename</button><button data-act="delete">Delete</button>`;
  document.body.appendChild(menu);
  const off = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', off); } };
  setTimeout(() => document.addEventListener('click', off), 0);
  menu.querySelector('[data-act="rename"]').addEventListener('click', async () => {
    const t = prompt('Rename chat', state.conversations.find(c => c.id === id)?.title || '');
    if (t && t.trim()) {
      await api(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title: t.trim() }) });
      await loadConvos();
      if (state.currentId === id) $('#chatTitle').textContent = t.trim();
    }
    menu.remove();
  });
  menu.querySelector('[data-act="delete"]').addEventListener('click', async () => {
    if (!confirm('Delete this conversation?')) { menu.remove(); return; }
    await api(`/api/conversations/${id}`, { method: 'DELETE' });
    if (state.currentId === id) resetChat();
    await loadConvos();
    menu.remove();
  });
}
async function newChat() {
  const convo = await (await api('/api/conversations', { method: 'POST', body: JSON.stringify({}) })).json();
  await loadConvos();
  openConvo(convo.id);
}
async function openConvo(id) {
  state.currentId = id;
  closeMobileSidebar();
  const mem = await (await api(`/api/conversations/${id}`)).json();
  state.messages = mem.messages || [];
  $('#chatTitle').textContent = mem.title || 'Chat';
  renderMessages();
  renderConvos();
  focusInput();
}
function resetChat() {
  state.currentId = null;
  state.messages = [];
  $('#chatTitle').textContent = 'New chat';
  renderMessages();
  renderConvos();
}

// ---------- Messages ----------
function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  if (!state.messages.length) {
    box.innerHTML = `<div class="empty"><div class="empty-inner">
      <img src="/logo.svg" alt="" width="44" height="41">
      <h2>Hi. What can I do for you?</h2>
    </div></div>`;
    return;
  }
  for (const m of state.messages) box.appendChild(messageEl(m));
  scrollBottom();
}
function messageEl(m) {
  const row = document.createElement('div');
  row.className = `msg-row ${m.role}`;
  row.dataset.ts = m.ts || '';
  if (m.role === 'user') {
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = m.content;
    row.appendChild(b);
    if (m.attachments?.length) {
      const atts = document.createElement('div');
      atts.className = 'attachments';
      for (const a of m.attachments) atts.appendChild(attachChip(a, true));
      row.appendChild(atts);
    }
    row.appendChild(actionsBar(m, 'user'));
  } else {
    const c = document.createElement('div');
    c.className = 'md';
    c.innerHTML = renderMarkdown(m.content);
    row.appendChild(c);
    row.appendChild(actionsBar(m, 'assistant'));
  }
  return row;
}
function attachChip(a, readonly = false) {
  const el = document.createElement('div');
  el.className = 'attach-chip';
  const isImg = a.mime?.startsWith('image/');
  el.innerHTML = `<span class="thumb">${isImg
    ? `<img src="${a.url}" style="width:100%;height:100%;object-fit:cover;border-radius:6px">`
    : `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/></svg>`}</span>
    <span class="nm">${escapeHtml(a.name)}</span>
    ${readonly ? '' : `<button type="button" class="rm">×</button>`}`;
  el.querySelector('.nm').addEventListener('click', () => openFile(a));
  if (!readonly) {
    el.querySelector('.rm').addEventListener('click', () => {
      state.attachments = state.attachments.filter(x => x.url !== a.url);
      renderAttachments();
    });
  }
  return el;
}
function actionsBar(m, role) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  const mk = (label, title, fn) => {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.title = title;
    b.textContent = label;
    b.style.fontSize = '12px';
    b.addEventListener('click', fn);
    return b;
  };
  if (role === 'user') {
    bar.appendChild(mk('Copy', 'Copy', async () => { await navigator.clipboard.writeText(m.content); toast('Copied'); }));
    bar.appendChild(mk('Edit', 'Edit', () => editUserMessage(m)));
  } else {
    bar.appendChild(mk('Copy', 'Copy', async () => { await navigator.clipboard.writeText(m.content); toast('Copied'); }));
    bar.appendChild(mk('Redo', 'Regenerate', regenerate));
    bar.appendChild(mk('Good', 'Good', () => feedback(m, 1)));
    bar.appendChild(mk('Bad', 'Bad', () => feedback(m, -1)));
    bar.appendChild(mk('Speak', 'Read aloud', () => speak(m.content)));
    bar.appendChild(mk('Share', 'Share', () => shareMessage(m)));
  }
  return bar;
}
async function editUserMessage(m) {
  const next = prompt('Edit message', m.content);
  if (next === null || next.trim() === '' || next === m.content) return;
  const idx = state.messages.indexOf(m);
  state.messages = state.messages.slice(0, idx);
  renderMessages();
  await sendMessage(next.trim());
}

// ---------- Composer ----------
function autoGrow() {
  const ta = $('#input');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    $('#sendBtn').disabled = !ta.value.trim() || state.streaming;
  });
}
function focusInput() { $('#input').focus(); }
function renderAttachments() {
  const box = $('#attachments');
  box.innerHTML = '';
  if (!state.attachments.length) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  state.attachments.forEach(a => box.appendChild(attachChip(a, false)));
}
async function uploadFiles(files) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const res = await fetch('/api/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
  if (!res.ok) { toast('Upload failed'); return; }
  const data = await res.json();
  state.attachments.push(...data.files);
  renderAttachments();
}

// ---------- Send ----------
async function sendMessage(textOverride) {
  const ta = $('#input');
  const text = (textOverride ?? ta.value).trim();
  if (!text || state.streaming) return;

  if (!state.currentId) {
    const convo = await (await api('/api/conversations', { method: 'POST', body: JSON.stringify({}) })).json();
    state.currentId = convo.id;
    await loadConvos();
    $('#chatTitle').textContent = 'New chat';
  }

  const userMsg = { role: 'user', content: text, ts: new Date().toISOString(), attachments: state.attachments };
  state.messages.push(userMsg);
  if (!textOverride) { ta.value = ''; ta.style.height = 'auto'; }
  const attachmentsToSend = state.attachments.slice();
  state.attachments = [];
  renderAttachments();
  $('#sendBtn').disabled = true;
  renderMessages();

  const asst = { role: 'assistant', content: '', ts: new Date().toISOString() };
  state.messages.push(asst);
  const row = messageEl(asst);
  $('#messages').appendChild(row);
  const contentEl = row.querySelector('.md');
  contentEl.innerHTML = '<div class="dots"><span></span><span></span><span></span></div>';
  scrollBottom();

  state.streaming = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        conversationId: state.currentId,
        message: text,
        deepThink: state.thinking,
        search: state.searchOn,
        attachments: attachmentsToSend
      })
    });
    if (!res.ok || !res.body) throw new Error('Stream failed');

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', acc = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop();
      for (const ev of events) {
        const lines = ev.split('\n');
        let type = 'message', data = '';
        for (const l of lines) {
          if (l.startsWith('event:')) type = l.slice(6).trim();
          else if (l.startsWith('data:')) data += l.slice(5).trim();
        }
        if (!data) continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        if (type === 'delta') {
          acc += parsed.text;
          contentEl.innerHTML = renderMarkdown(acc);
          scrollBottom();
        } else if (type === 'error') {
          contentEl.innerHTML = `<p style="color:var(--danger)">Error: ${escapeHtml(parsed.error || 'failed')}</p>`;
        }
      }
    }
    asst.content = acc || '(no response)';
    contentEl.innerHTML = renderMarkdown(asst.content);
    scrollBottom();
    const mem = await (await api(`/api/conversations/${state.currentId}`)).json();
    state.messages = mem.messages;
    $('#chatTitle').textContent = mem.title || 'Chat';
    await loadConvos();
    renderMessages();
  } catch (err) {
    console.error(err);
    contentEl.innerHTML = `<p style="color:var(--danger)">Network error</p>`;
  } finally {
    state.streaming = false;
    $('#sendBtn').disabled = !$('#input').value.trim();
    focusInput();
  }
}
async function regenerate() {
  if (!state.currentId || state.streaming) return;
  const lastUser = [...state.messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].role === 'assistant') { state.messages.splice(i, 1); break; }
  }
  renderMessages();
  await sendMessage(lastUser.content);
}
async function feedback(m, vote) {
  if (!m.ts) return;
  await api('/api/feedback', { method: 'POST', body: JSON.stringify({ conversationId: state.currentId, ts: m.ts, vote }) });
  toast(vote > 0 ? 'Thanks' : 'Feedback recorded');
}
function speak(text) {
  if (!('speechSynthesis' in window)) { toast('Not supported'); return; }
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}
async function shareMessage(m) {
  if (navigator.share) { try { await navigator.share({ title: 'Bluebex', text: m.content }); } catch {} }
  else { await navigator.clipboard.writeText(m.content); toast('Copied'); }
}

// ---------- File preview (built on demand) ----------
function openFile(a) {
  closeOverlays();
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'fileModal';
  modal.innerHTML = `
    <div class="file-panel">
      <div class="file-head">
        <span>${escapeHtml(a.name)}</span>
        <div>
          <a class="icon-btn" href="${a.url}" download>↓</a>
          <button class="icon-btn" data-close>×</button>
        </div>
      </div>
      <div class="file-body"></div>
    </div>`;
  const body = modal.querySelector('.file-body');
  if (a.mime?.startsWith('image/')) body.innerHTML = `<img src="${a.url}" alt="">`;
  else if (a.mime === 'application/pdf') body.innerHTML = `<iframe src="${a.url}"></iframe>`;
  else if (a.mime?.startsWith('text/')) fetch(a.url).then(r => r.text()).then(t => { body.innerHTML = `<pre>${escapeHtml(t)}</pre>`; });
  else body.innerHTML = `<p class="muted" style="padding:32px">Preview not available. Use download.</p>`;
  modal.querySelector('[data-close]').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

// ---------- Search overlay (built on demand) ----------
let searchTimer;
function openSearch() {
  closeOverlays();
  const ov = document.createElement('div');
  ov.className = 'search-overlay';
  ov.id = 'searchOverlay';
  ov.innerHTML = `
    <div class="search-panel">
      <div class="search-input">
        <input id="searchInput" placeholder="Search chat content…">
        <button class="icon-btn" data-close>×</button>
      </div>
      <div class="search-results" id="searchResults"></div>
    </div>`;
  ov.querySelector('[data-close]').onclick = () => ov.remove();
  ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
  document.body.appendChild(ov);
  const input = ov.querySelector('#searchInput');
  setTimeout(() => input.focus(), 30);
  input.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    const box = ov.querySelector('#searchResults');
    if (!q) { box.innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      const list = await (await api(`/api/search?q=${encodeURIComponent(q)}`)).json();
      box.innerHTML = '';
      if (!list.length) { box.innerHTML = '<div class="none">No matches</div>'; return; }
      const rx = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
      for (const h of list) {
        const el = document.createElement('div');
        el.className = 'hit';
        el.innerHTML = `<div style="flex:1">
          <div class="meta"><strong>${escapeHtml(h.title || 'Chat')}</strong> · ${new Date(h.ts).toLocaleTimeString()}</div>
          <div class="snip">${escapeHtml(h.snippet || '').replace(rx, '<mark>$1</mark>')}</div>
        </div>`;
        el.addEventListener('click', () => { ov.remove(); openConvo(h.conversationId); });
        box.appendChild(el);
      }
    }, 200);
  });
}

// ---------- Settings modal (built on demand) ----------
function openSettings() {
  closeOverlays();
  const s = state.settings || {};
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'settingsModal';
  modal.innerHTML = `
    <div class="modal-panel">
      <button class="icon-btn modal-close" data-close>×</button>
      <h3 class="modal-title">Settings</h3>
      <div class="modal-grid">
        <nav class="modal-nav">
          <button class="tab active" data-tab="general">General</button>
          <button class="tab" data-tab="profile">Profile</button>
          <button class="tab" data-tab="data">Data</button>
          <button class="tab" data-tab="about">About</button>
        </nav>
        <div class="modal-content">
          <section class="panel" data-panel="general">
            <h4>Theme</h4>
            <div class="theme-grid">
              <button class="theme-card" data-theme="light">Light</button>
              <button class="theme-card" data-theme="dark">Dark</button>
              <button class="theme-card" data-theme="system">System</button>
            </div>
            <h4>Language</h4>
            <div class="row-between">
              <select id="languageSel">
                <option value="system">System</option>
                <option value="en">English</option>
                <option value="hi">Hindi</option>
                <option value="ar">Arabic</option>
              </select>
            </div>
            <h4>Voice</h4>
            <div class="row-between">
              <select id="voiceSel"><option>Mira</option><option>System</option></select>
            </div>
          </section>
          <section class="panel" data-panel="profile" hidden>
            <div class="row-between"><span>Name</span><input id="profileName" class="mini-input" type="text" value="${escapeHtml(state.user.name || '')}"></div>
            <div class="row-between"><span>Email</span><span class="muted">${escapeHtml(maskEmail(state.user.email))}</span></div>
            <div class="row-between"><span>Log out of all devices</span><button class="btn-danger-outline" data-act="logout-all">Log out</button></div>
            <div class="row-between"><span>Delete account</span><button class="btn-danger-outline" data-act="delete-account">Delete</button></div>
          </section>
          <section class="panel" data-panel="data" hidden>
            <div class="row-between"><span>Export data</span><button class="btn-ghost" data-act="export">Export</button></div>
            <div class="row-between"><span>Delete all chats</span><button class="btn-danger-outline" data-act="delete-all-chats">Delete all</button></div>
          </section>
          <section class="panel" data-panel="about" hidden>
            <p class="muted">Bluebex — version 1.0.0</p>
          </section>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector('[data-close]').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  // Tabs
  modal.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    modal.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    modal.querySelectorAll('.panel').forEach(p => p.hidden = p.dataset.panel !== t.dataset.tab);
  });

  // Theme
  const applyThemeCard = () => {
    modal.querySelectorAll('.theme-card').forEach(c => c.classList.toggle('active', c.dataset.theme === (s.theme || 'dark')));
  };
  applyThemeCard();
  modal.querySelectorAll('.theme-card').forEach(c => c.onclick = async () => {
    s.theme = c.dataset.theme;
    applyTheme(s.theme);
    applyThemeCard();
    await api('/api/me', { method: 'PATCH', body: JSON.stringify({ settings: { theme: s.theme } }) });
  });

  // Name
  modal.querySelector('#profileName').onchange = async (e) => {
    const name = e.target.value.trim();
    if (!name) return;
    await api('/api/me', { method: 'PATCH', body: JSON.stringify({ name }) });
    state.user.name = name;
    $('#uname').textContent = name;
    $('#avatar').textContent = name.charAt(0).toUpperCase();
    toast('Saved');
  };

  // Logout all
  modal.querySelector('[data-act="logout-all"]').onclick = async () => {
    if (!confirm('Log out from all devices?')) return;
    await api('/api/logout-all', { method: 'POST' });
    location.href = '/login';
  };

  // Delete account
  modal.querySelector('[data-act="delete-account"]').onclick = async () => {
    if (!confirm('Delete your account and ALL data?')) return;
    await api('/api/me', { method: 'DELETE' });
    location.href = '/login';
  };

  // Export
  modal.querySelector('[data-act="export"]').onclick = () => { location.href = '/api/export'; };

  // Delete all chats
  modal.querySelector('[data-act="delete-all-chats"]').onclick = async () => {
    if (!confirm('Delete all chats?')) return;
    await api('/api/conversations', { method: 'DELETE' });
    resetChat();
    modal.remove();
    toast('All chats deleted');
  };

  // Language + voice
  modal.querySelector('#languageSel').value = s.language || 'system';
  modal.querySelector('#voiceSel').value = s.voice || 'Mira';
  modal.querySelector('#languageSel').onchange = (e) => api('/api/me', { method: 'PATCH', body: JSON.stringify({ settings: { language: e.target.value } }) });
  modal.querySelector('#voiceSel').onchange = (e) => api('/api/me', { method: 'PATCH', body: JSON.stringify({ settings: { voice: e.target.value } }) });
}

function maskEmail(e) {
  const [u, d] = e.split('@');
  if (!d) return e;
  return `${u.slice(0, 2)}*****${u.slice(-1)}@${d}`;
}

function closeOverlays() {
  document.querySelectorAll('.modal, .search-overlay, .menu').forEach(m => m.remove());
}

// ---------- Sidebar ----------
function openMobileSidebar() { $('#sidebar').classList.add('open'); $('#backdrop').style.display = 'block'; }
function closeMobileSidebar() { $('#sidebar').classList.remove('open'); $('#backdrop').style.display = 'none'; }

// ---------- Install ----------
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
function showInstallPrompt() {
  if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; return; }
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIOS) toast('Tap Share → Add to Home Screen');
  else toast('Use your browser menu → Install app');
}

// ---------- Bind UI ----------
function bindUI() {
  $('#newChatBtn').addEventListener('click', newChat);
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });

  const ta = $('#input');
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      const isTouch = matchMedia('(hover: none)').matches;
      if (!isTouch) { e.preventDefault(); sendMessage(); }
    }
  });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); newChat(); }
    if (e.key === 'Escape') closeOverlays();
  });

  $('#thinkPill').addEventListener('click', () => {
    state.thinking = !state.thinking;
    $('#thinkPill').dataset.on = String(state.thinking);
  });
  $('#searchPill').addEventListener('click', () => {
    state.searchOn = !state.searchOn;
    $('#searchPill').dataset.on = String(state.searchOn);
  });

  $('#clipBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => {
    if (e.target.files?.length) uploadFiles(e.target.files);
    e.target.value = '';
  });

  $('#collapseBtn').addEventListener('click', () => {
    const sb = $('#sidebar');
    sb.classList.toggle('collapsed');
    localStorage.setItem('bb_collapsed', sb.classList.contains('collapsed') ? '1' : '0');
  });

  $('#menuBtn').addEventListener('click', openMobileSidebar);
  $('#backdrop').addEventListener('click', closeMobileSidebar);

  $('#searchBtn').addEventListener('click', openSearch);

  $('#shareBtn').addEventListener('click', () => {
    if (navigator.share) navigator.share({ title: 'Bluebex', url: location.href }).catch(()=>{});
    else { navigator.clipboard.writeText(location.href); toast('Link copied'); }
  });

  // User menu — built on demand
  $('#userBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const old = document.getElementById('userMenu');
    if (old) { old.remove(); return; }
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.id = 'userMenu';
    menu.innerHTML = `
      <button data-act="install">Download mobile App</button>
      <button data-act="settings">Settings</button>
      <button data-act="help">Help &amp; Feedback</button>
      <button data-act="logout">Log out</button>`;
    document.body.appendChild(menu);
    const r = $('#userBtn').getBoundingClientRect();
    menu.style.left = `${Math.max(8, r.left)}px`;
    menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 8)}px`;
    menu.style.width = '220px';

    menu.querySelectorAll('button').forEach(b => b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      menu.remove();
      const act = b.dataset.act;
      if (act === 'logout') { await api('/api/logout', { method: 'POST' }); location.href = '/login'; }
      else if (act === 'settings') openSettings();
      else if (act === 'install') showInstallPrompt();
      else if (act === 'help') toast('Help & Feedback — coming soon');
    }));

    setTimeout(() => {
      const off = (ev) => {
        if (!menu.contains(ev.target) && !ev.target.closest('#userBtn')) {
          menu.remove();
          document.removeEventListener('click', off);
        }
      };
      document.addEventListener('click', off);
    }, 0);
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings.theme === 'system') applyTheme('system');
  });
}

function scrollBottom() {
  const box = $('#messages');
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

boot().catch(err => console.error(err));
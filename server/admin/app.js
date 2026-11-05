/* Understage Admin — includes Send & close on support tickets — dark + gold console. Talks to existing /admin/* APIs. */
const E2EE_NOTE = 'Everything else stays end-to-end encrypted. Admins only see what the reporter chose to share.';
const TABS = ['Reports', 'Suspensions', 'Support', 'Workspaces', 'Audit'];

const state = {
  tab: sessionStorage.getItem('us_admin_tab') || 'Reports',
  mode: sessionStorage.getItem('us_admin_mode') || '',
  token: sessionStorage.getItem('us_admin_token') || '',
  bearer: sessionStorage.getItem('us_admin_bearer') || '',
  reports: [],
  suspensions: [],
  tickets: [],
  ticket: null,
  workspaces: null,
  audit: [],
  selReport: null,
  selTicketId: null,
  toast: '',
  error: '',
  dest: '',
  code: '',
  reply: '',
  ticketReply: '',
  suspendWho: '',
  suspendHint: '',
  busy: false,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function headers() {
  const h = { 'content-type': 'application/json' };
  if (state.mode === 'token' && state.token) h['x-admin-token'] = state.token;
  if (state.mode === 'user' && state.bearer) h.authorization = 'Bearer ' + state.bearer;
  return h;
}


async function loadTicket(id) {
  const raw = await api('GET', '/admin/tickets/' + id);
  const ticket = raw.ticket || raw;
  const listed = state.tickets.find((x) => x.id === id);
  return {
    ...ticket,
    username: ticket.username || (listed && listed.username) || '',
    messages: raw.messages || ticket.messages || [],
  };
}

function loggedIn() {
  return (state.mode === 'token' && state.token) || (state.mode === 'user' && state.bearer);
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const err = new Error(data.message || data.error || ('HTTP ' + r.status));
    err.status = r.status;
    err.code = data.error;
    throw err;
  }
  return data;
}

function toast(msg) {
  state.toast = msg;
  render();
  setTimeout(() => { if (state.toast === msg) { state.toast = ''; render(); } }, 2600);
}

function when(ts) {
  if (!ts) return '—';
  const n = Number(ts);
  if (!Number.isFinite(n)) return '—';
  return new Date(n).toLocaleString();
}

function tag(status) {
  const s = String(status || '').toLowerCase();
  const label = ({
    open: 'Open', pending: 'Waiting', resolved: 'Closed',
    reviewing: 'In review', actioned: 'Resolved', dismissed: 'Dismissed',
    active: 'Active', lifted: 'Lifted', expired: 'Expired', permanent: 'Permanent',
  })[s] || status || '';
  const cls = ({
    open: 'open', pending: 'pending', resolved: 'resolved',
    reviewing: 'review', actioned: 'actioned', dismissed: 'dismissed',
    active: 'new', lifted: 'ok', expired: 'muted', permanent: 'perm',
  })[s] || '';
  return `<span class="tag ${cls}">${esc(label)}</span>`;
}

function reportStatus(s) {
  return ({ open: 'New', reviewing: 'In review', actioned: 'Resolved', dismissed: 'Dismissed' })[s] || s;
}

function persistAuth() {
  sessionStorage.setItem('us_admin_mode', state.mode);
  sessionStorage.setItem('us_admin_token', state.token);
  sessionStorage.setItem('us_admin_bearer', state.bearer);
  sessionStorage.setItem('us_admin_tab', state.tab);
}

function logout() {
  state.mode = ''; state.token = ''; state.bearer = ''; state.error = '';
  persistAuth();
  render();
}

async function loginToken() {
  state.error = '';
  const token = (document.getElementById('admin-token') || {}).value || '';
  if (!token.trim()) { state.error = 'Enter an admin token.'; render(); return; }
  state.mode = 'token';
  state.token = token.trim();
  try {
    await api('GET', '/admin/reports');
    persistAuth();
    toast('Signed in with admin token');
    await refresh();
  } catch (e) {
    state.mode = ''; state.token = '';
    state.error = e.message || 'Token was rejected';
    render();
  }
}

async function requestCode() {
  state.error = '';
  const dest = ((document.getElementById('admin-dest') || {}).value || '').trim();
  if (!dest) { state.error = 'Enter an admin phone or email.'; render(); return; }
  state.dest = dest;
  const kind = dest.includes('@') ? 'email' : 'phone';
  try {
    const r = await fetch('/auth/otp/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, destination: dest }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || data.error || 'Could not send a code');
    toast(data.devCode ? ('Code sent (dev: ' + data.devCode + ')') : 'Code sent');
  } catch (e) {
    state.error = e.message;
    render();
  }
}

async function loginUser() {
  state.error = '';
  const dest = ((document.getElementById('admin-dest') || {}).value || state.dest || '').trim();
  const code = ((document.getElementById('admin-code') || {}).value || '').trim();
  if (!dest || !code) { state.error = 'Phone/email and code are required.'; render(); return; }
  const kind = dest.includes('@') ? 'email' : 'phone';
  try {
    const r = await fetch('/auth/otp/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, destination: dest, code }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || data.error || 'Sign-in failed');
    if (!data.user || !data.user.isAdmin) throw new Error('This account is not a platform admin.');
    state.mode = 'user';
    state.bearer = data.accessToken;
    persistAuth();
    toast('Signed in as ' + (data.user.displayName || data.user.username || 'admin'));
    await refresh();
  } catch (e) {
    state.error = e.message;
    render();
  }
}

async function refresh() {
  if (!loggedIn()) { render(); return; }
  state.error = '';
  try {
    const [reports, suspensions, tickets, workspaces, audit] = await Promise.all([
      api('GET', '/admin/reports'),
      api('GET', '/admin/suspensions'),
      api('GET', '/admin/tickets'),
      api('GET', '/admin/workspaces'),
      api('GET', '/admin/audit').catch(() => ({ items: [] })),
    ]);
    state.reports = reports.reports || [];
    state.suspensions = suspensions.suspensions || [];
    state.tickets = tickets.tickets || [];
    state.workspaces = workspaces;
    state.audit = audit.entries || [];
    if (state.selReport) {
      state.selReport = state.reports.find((r) => r.id === state.selReport.id) || state.selReport;
    }
    if (state.selTicketId) {
      try { state.ticket = await loadTicket(state.selTicketId); }
      catch { state.ticket = null; }
    }
    render();
  } catch (e) {
    if (e.status === 401) {
      logout();
      state.error = 'Session expired. Sign in again.';
      render();
      return;
    }
    state.error = e.message;
    render();
  }
}

function evidenceBlock(rep) {
  const ev = Array.isArray(rep.evidence) ? rep.evidence : [];
  if (!ev.length) return '<p class="muted small">No evidence was shared.</p>';
  return ev.map((item) => {
    const text = item && (item.text || item.body || item.message || (typeof item === 'string' ? item : JSON.stringify(item)));
    const at = item && item.at ? `<div class="muted small">${esc(when(item.at))}</div>` : '';
    return `<div class="evidence">${at}${esc(text)}</div>`;
  }).join('');
}

function reportsView() {
  const list = state.reports.map((r) => {
    const on = state.selReport && state.selReport.id === r.id;
    return `<div class="card" style="${on ? 'border-color:var(--gold)' : ''}">
      <div class="row">
        <div>
          <div><b>@${esc(r.reporter)}</b> reported <b>@${esc(r.reported)}</b></div>
          <div class="muted small">${esc(r.number ? r.number + ' · ' : '')}${esc(r.reason)} · ${esc(when(r.createdAt || r.created_at))}</div>
        </div>
        ${tag(r.status === 'open' ? 'open' : r.status)}
      </div>
      <div class="actions">
        <button class="ghost" data-act="open-report" data-id="${esc(r.id)}">Review</button>
      </div>
    </div>`;
  }).join('') || '<p class="muted">No reports in the queue.</p>';

  const det = state.selReport;
  const detail = det ? `<div class="card">
      <div class="row">
        <div>
          <h3 style="margin:0 0 4px">Report ${esc(det.id)}</h3>
          <div class="muted small">@${esc(det.reporter)} → @${esc(det.reported)} · ${esc(det.reason)}</div>
        </div>
        ${tag(det.status === 'open' ? 'open' : det.status)}
      </div>
      <p class="note">${esc(E2EE_NOTE)}</p>
      <div class="small muted">Evidence the reporter chose to share</div>
      ${evidenceBlock(det)}
      <div class="actions">
        <button class="ghost" data-act="set-report" data-id="${esc(det.id)}" data-status="reviewing">Mark in review</button>
        <button class="ghost" data-act="set-report" data-id="${esc(det.id)}" data-status="actioned">Mark resolved</button>
        <button class="ghost" data-act="set-report" data-id="${esc(det.id)}" data-status="dismissed">Dismiss</button>
      </div>
      <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
      <h4 style="margin:0 0 8px">Suspend account</h4>
      <p class="muted small">Temporarily or permanently suspend @${esc(det.reported)} (${esc(det.reportedId)}).</p>
      <div class="actions">
        <button class="danger" data-act="suspend-from-report" data-id="${esc(det.reportedId)}" data-hint="@${esc(det.reported)}" data-d="7d">Suspend 7 days</button>
        <button class="danger" data-act="suspend-from-report" data-id="${esc(det.reportedId)}" data-hint="@${esc(det.reported)}" data-d="30d">Suspend 30 days</button>
        <button class="danger" data-act="suspend-from-report" data-id="${esc(det.reportedId)}" data-hint="@${esc(det.reported)}" data-d="permanent">Permanent</button>
      </div>
    </div>` : `<div class="card"><p class="muted">Select a report to review the shared evidence.</p><p class="note">${esc(E2EE_NOTE)}</p></div>`;

  return `<div class="kpis">
      <div class="kpi"><b>${state.reports.length}</b><span>Reports</span></div>
      <div class="kpi"><b>${state.reports.filter((r) => r.status === 'open').length}</b><span>New</span></div>
    </div>
    <div class="split">${`<div>${list}</div>`}${detail}</div>`;
}

function suspStatus(s) {
  if (s.lifted) return 'lifted';
  if (Number(s.until) >= 8e15) return 'permanent';
  if (Number(s.until) > Date.now()) return 'active';
  return 'expired';
}

function suspensionsView() {
  const rows = state.suspensions.map((s) => `<tr>
      <td>${esc(s.display_name || '')}<div class="muted small">@${esc(s.username || s.user_id)}</div></td>
      <td>${tag(suspStatus(s))}</td>
      <td class="small">${esc(s.reason || '—')}</td>
      <td class="small">${esc(when(s.until))}</td>
      <td>${s.lifted ? `<span class="muted small">Lifted</span>`
        : `<button class="ghost" data-act="unsuspend" data-id="${esc(s.id)}">Unsuspend</button>`}</td>
    </tr>`).join('');
  return `<div class="card">
      <h3 style="margin-top:0">Suspend account</h3>
      <p class="muted small">Temporary (7 or 30 days) or permanent. Revokes every session for that user.</p>
      <label>User id</label>
      <input id="suspend-who" placeholder="u_…" value="${esc(state.suspendWho)}">
      <label>Reason</label>
      <input id="suspend-reason" placeholder="Why this account is being suspended">
      <div class="actions">
        <button class="danger" data-act="suspend" data-d="7d">7 days</button>
        <button class="danger" data-act="suspend" data-d="30d">30 days</button>
        <button class="danger" data-act="suspend" data-d="permanent">Permanent</button>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">Suspensions</h3>
      <table>
        <thead><tr><th>User</th><th>Status</th><th>Reason</th><th>Until</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">No suspensions.</td></tr>'}</tbody>
      </table>
    </div>`;
}

function ticketsView() {
  const list = state.tickets.map((t) => `<div class="card" style="${state.selTicketId === t.id ? 'border-color:var(--gold)' : ''}">
      <div class="row">
        <div>
          <div><b>${esc(t.subject)}</b></div>
          <div class="muted small">@${esc(t.username)} · ${esc(when(t.createdAt || t.created_at))}</div>
        </div>
        ${tag(t.status)}
      </div>
      <div class="actions"><button class="ghost" data-act="open-ticket" data-id="${esc(t.id)}">Open</button></div>
    </div>`).join('') || '<p class="muted">No support tickets.</p>';

  const t = state.ticket;
  let detail = '<div class="card"><p class="muted">Select a ticket to reply.</p></div>';
  if (t) {
    const msgs = (t.messages || []).map((m) => `<div class="evidence">
        <div class="muted small">${esc(m.author === 'support' ? 'Support' : 'User')} · ${esc(when(m.created_at))}</div>
        ${esc(m.body)}
      </div>`).join('');
    detail = `<div class="card">
      <div class="row"><div><h3 style="margin:0">${esc(t.subject)}</h3><div class="muted small">@${esc(t.username)} · ${esc(t.category || '')}</div></div>${tag(t.status)}</div>
      ${msgs || '<p class="muted small">No messages yet.</p>'}
      <label>Reply</label>
      <textarea id="ticket-reply" placeholder="Write a reply">${esc(state.ticketReply)}</textarea>
      <div class="actions">
        <button class="ghost" data-act="ticket-reply">Send reply</button>
        <button class="act" data-act="ticket-close">Send &amp; close</button>
      </div>
    </div>`;
  }
  return `<div class="split"><div>${list}</div>${detail}</div>`;
}

function workspacesView() {
  const ws = state.workspaces || { active: [], wrapped: [], stats: {} };
  const stats = ws.stats || {};
  const activeN = stats.active != null ? stats.active : (ws.active || []).length;
  const wrappedN = stats.wrapped != null ? stats.wrapped : (ws.wrapped || []).length;
  const membersN = stats.members != null ? stats.members : (ws.active || []).concat(ws.wrapped || []).reduce((n, w) => n + Number(w.members || 0), 0);
  const row = (w) => `<tr>
      <td>${esc(w.name)}<div class="muted small mono">${esc(w.id)}</div></td>
      <td>${esc(w.owner || w.created_by || '—')}</td>
      <td>${esc(w.members)}</td>
      <td>${esc(w.plan || '—')} · ${esc(w.seat_limit || '—')} seats</td>
      <td>${w.wrapped_at ? esc(when(w.wrapped_at)) : '<span class="tag ok">Active</span>'}</td>
    </tr>`;
  return `<div class="kpis">
      <div class="kpi"><b>${esc(activeN)}</b><span>Active</span></div>
      <div class="kpi"><b>${esc(membersN)}</b><span>Members</span></div>
      <div class="kpi"><b>${esc(wrappedN)}</b><span>Wrapped</span></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">Active workspaces</h3>
      <table>
        <thead><tr><th>Workspace</th><th>Owner</th><th>Members</th><th>Plan</th><th></th></tr></thead>
        <tbody>${(ws.active || []).map(row).join('') || '<tr><td colspan="5" class="muted">None</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card">
      <h3 style="margin-top:0">Wrapped</h3>
      <table>
        <thead><tr><th>Workspace</th><th>Owner</th><th>Members</th><th>Plan</th><th>Wrapped</th></tr></thead>
        <tbody>${(ws.wrapped || []).map(row).join('') || '<tr><td colspan="5" class="muted">None wrapped.</td></tr>'}</tbody>
      </table>
    </div>`;
}

function auditView() {
  const items = Array.isArray(state.audit) ? state.audit : [];
  const rows = items.map((a) => `<tr>
      <td class="small">${esc(when(a.at || a.created_at))}</td>
      <td class="mono small">${esc(a.actorId || a.actor_id)}</td>
      <td>${esc(a.action)}</td>
      <td class="mono small">${esc(a.targetType || a.target_type || '')} ${esc(a.targetId || a.target_id || '')}</td>
      <td class="small">${esc(typeof a.meta === 'string' ? a.meta : JSON.stringify(a.meta || {}))}</td>
    </tr>`).join('');
  return `<div class="card">
      <h3 style="margin-top:0">Audit log</h3>
      <table>
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Meta</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">No audit events yet.</td></tr>'}</tbody>
      </table>
    </div>`;
}

function loginView() {
  return `<header><h1>Understage <span>Admin</span></h1></header>
    <main>
      <div class="login card">
        <h2 style="margin-top:0">Sign in</h2>
        <p class="muted small">Use a platform admin token (<code>x-admin-token</code>) or an account marked <code>is_admin</code>.</p>
        ${state.error ? `<p class="err">${esc(state.error)}</p>` : ''}
        <label>Admin token</label>
        <input id="admin-token" type="password" placeholder="ADMIN_TOKEN" autocomplete="off">
        <button class="act" data-act="login-token">Sign in with token</button>
        <p class="muted small" style="margin:18px 0 8px">or admin phone / email</p>
        <label>Phone or email</label>
        <input id="admin-dest" placeholder="+44… or ops@…" value="${esc(state.dest)}">
        <div class="actions">
          <button class="ghost" data-act="request-code">Send code</button>
        </div>
        <label>One-time code</label>
        <input id="admin-code" placeholder="6-digit code" inputmode="numeric">
        <button class="act" data-act="login-user">Sign in as admin user</button>
      </div>
    </main>`;
}

function shell(inner) {
  const nav = TABS.map((t) => `<button class="${state.tab === t ? 'on' : ''}" data-act="tab" data-tab="${t}">${t}</button>`).join('');
  return `<header>
      <h1>Understage <span>Admin</span></h1>
      <nav>${nav}</nav>
      <button class="ghost" data-act="logout">Sign out</button>
    </header>
    <main>
      ${state.error ? `<p class="err">${esc(state.error)}</p>` : ''}
      ${inner}
    </main>
    ${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ''}`;
}

function render() {
  const root = document.getElementById('app');
  if (!loggedIn()) { root.innerHTML = loginView(); return; }
  const views = {
    Reports: reportsView,
    Suspensions: suspensionsView,
    Support: ticketsView,
    Workspaces: workspacesView,
    Audit: auditView,
  };
  root.innerHTML = shell((views[state.tab] || reportsView)());
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  try {
    if (act === 'login-token') return loginToken();
    if (act === 'request-code') return requestCode();
    if (act === 'login-user') return loginUser();
    if (act === 'logout') return logout();
    if (act === 'tab') {
      state.tab = btn.getAttribute('data-tab');
      persistAuth();
      render();
      return;
    }
    if (act === 'open-report') {
      state.selReport = state.reports.find((r) => r.id === btn.getAttribute('data-id')) || null;
      render();
      return;
    }
    if (act === 'set-report') {
      await api('PATCH', '/admin/reports/' + btn.getAttribute('data-id'), { status: btn.getAttribute('data-status') });
      toast('Report updated');
      await refresh();
      return;
    }
    if (act === 'suspend-from-report' || act === 'suspend') {
      const userId = act === 'suspend'
        ? ((document.getElementById('suspend-who') || {}).value || '').trim()
        : btn.getAttribute('data-id');
      const reasonEl = document.getElementById('suspend-reason');
      const reason = reasonEl ? reasonEl.value : ('Suspended from report ' + (state.selReport && state.selReport.reason || ''));
      const duration = btn.getAttribute('data-d');
      if (!userId) { state.error = 'User id is required.'; render(); return; }
      await api('POST', '/admin/suspensions', { userId, reason: reason || 'Admin suspension', duration });
      toast(duration === 'permanent' ? 'Account permanently suspended' : 'Account suspended (' + duration + ')');
      state.tab = 'Suspensions';
      persistAuth();
      await refresh();
      return;
    }
    if (act === 'unsuspend') {
      await api('DELETE', '/admin/suspensions/' + btn.getAttribute('data-id'));
      toast('Account unsuspended');
      await refresh();
      return;
    }
    if (act === 'open-ticket') {
      state.selTicketId = btn.getAttribute('data-id');
      state.ticket = await loadTicket(state.selTicketId);
      state.ticketReply = '';
      render();
      return;
    }
    if (act === 'ticket-reply' || act === 'ticket-close') {
      const body = ((document.getElementById('ticket-reply') || {}).value || '').trim();
      if (!body) { state.error = 'Write a reply first.'; render(); return; }
      if (!state.selTicketId) return;
      await api('POST', '/admin/tickets/' + state.selTicketId + '/messages', { body });
      if (act === 'ticket-close') {
        await api('PATCH', '/admin/tickets/' + state.selTicketId, { status: 'resolved' });
        toast('Reply sent and ticket closed');
      } else {
        toast('Reply sent');
      }
      state.ticketReply = '';
      state.ticket = await loadTicket(state.selTicketId);
      await refresh();
      return;
    }
  } catch (err) {
    state.error = err.message || String(err);
    render();
  }
});

render();
if (loggedIn()) refresh();

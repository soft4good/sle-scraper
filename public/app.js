const view = document.getElementById('view');
let options = { categories: [], states: [], cities: [], events: [], channels: [] };

const api = async (path, init = {}) => {
  const response = await fetch(`/api${path}`, {
    headers: init.body ? { 'Content-Type': 'application/json' } : {},
    ...init,
  });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error((body?.problems ?? [`HTTP ${response.status}`]).join('; '));
  return body;
};

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
};

const brl = (value) => (typeof value === 'number'
  ? value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })
  : '—');

const EVENT_LABELS = {
  new_lot: 'New matching lot',
  proposals_open: 'Proposals open',
  deadline_soon: 'Deadline within 24h',
};

// ---------- lot cards ----------

function lotCard(lot) {
  const image = lot.thumbnailUrl
    ? el('img', { src: lot.thumbnailUrl, loading: 'lazy', alt: lot.category ?? 'lot' })
    : el('div', { class: 'no-image' }, 'no photo');
  const badges = el('div', {},
    el('span', { class: 'badge' }, lot.category ?? '?'),
    lot.pctOfAppraisal != null ? el('span', { class: `badge ${lot.pctOfAppraisal <= 25 ? 'good' : ''}` }, `${lot.pctOfAppraisal}% of appraisal`) : null,
    lot.allowsIndividuals
      ? el('span', { class: 'badge good' }, 'Individuals can bid')
      : el('span', { class: 'badge warn' }, 'Companies only'),
  );
  const description = (lot.searchText ?? '').split('\n').slice(0, 3).join(' · ');
  return el('div', { class: 'lot-card' },
    image,
    el('div', { class: 'body' },
      el('div', { class: 'price' }, brl(lot.minBid), ' ',
        el('span', { class: 'muted', style: 'font-size:.75rem' }, lot.appraisalValue ? `appraised ${brl(lot.appraisalValue)}` : '')),
      badges,
      el('div', { class: 'meta' }, `Lot #${lot.lotNumber} · ${lot.city ?? lot.unitName ?? '?'} · ends ${lot.proposalsEndAt ?? '?'}`),
      el('div', { class: 'desc' }, description),
      el('a', { href: lot.officialUrl, target: '_blank', rel: 'noopener' }, 'Open on official site ↗'),
    ),
  );
}

function lotGrid(lots) {
  return el('div', { class: 'grid' }, ...lots.map(lotCard));
}

// ---------- triggers ----------

function summarizeConfig(config) {
  const parts = [];
  if (config.keywords) parts.push(`keywords: ${config.keywords.join(', ')}`);
  if (config.excludeKeywords) parts.push(`excluding: ${config.excludeKeywords.join(', ')}`);
  if (config.categories) parts.push(`categories: ${config.categories.join(', ')}`);
  if (config.states) parts.push(`states: ${config.states.join(', ')}`);
  if (config.cities) parts.push(`cities: ${config.cities.join(', ')}`);
  if (config.minPrice != null) parts.push(`≥ ${brl(config.minPrice)}`);
  if (config.maxPrice != null) parts.push(`≤ ${brl(config.maxPrice)}`);
  if (config.maxPctOfAppraisal != null) parts.push(`≤ ${config.maxPctOfAppraisal}% of appraisal`);
  if (config.individualsOnly) parts.push('individuals can bid');
  if (config.requireImages) parts.push('with photos');
  if (config.featuredOnly) parts.push('featured');
  return parts.join(' · ') || 'no conditions';
}

function chipSelect(name, values, selected = []) {
  return el('div', { class: 'chips', 'data-chips': name },
    ...values.map((value) => el('label', {},
      el('input', { type: 'checkbox', value, ...(selected.includes(value) ? { checked: '' } : {}) }),
      value,
    )),
  );
}

function readChips(form, name) {
  const checked = [...form.querySelectorAll(`[data-chips="${name}"] input:checked`)].map((input) => input.value);
  return checked.length > 0 ? checked : undefined;
}

function splitList(value) {
  const items = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function triggerForm(trigger, onSaved) {
  const config = trigger?.config ?? {};
  const numberValue = (key) => (config[key] != null ? config[key] : '');
  const form = el('form', { class: 'panel', 'data-testid': 'trigger-form' });

  form.append(
    el('h2', {}, trigger ? `Edit trigger: ${trigger.name}` : 'New trigger'),
    el('div', { class: 'row' },
      el('div', { style: 'flex:2' }, el('label', {}, 'Name'),
        el('input', { name: 'name', required: '', style: 'width:100%', value: trigger?.name ?? '' })),
      el('div', {}, el('label', {}, 'Enabled'),
        el('select', { name: 'enabled' },
          el('option', { value: '1', ...(trigger?.enabled !== false ? { selected: '' } : {}) }, 'yes'),
          el('option', { value: '0', ...(trigger?.enabled === false ? { selected: '' } : {}) }, 'no'))),
    ),
    el('fieldset', {}, el('legend', {}, 'Text match (comma-separated; multi-word terms require all words)'),
      el('div', { class: 'row' },
        el('div', { style: 'flex:1' }, el('label', {}, 'Keywords (any of)'),
          el('input', { name: 'keywords', style: 'width:100%', placeholder: 'veleiro, barco a vela, lancha', value: (config.keywords ?? []).join(', ') })),
        el('div', { style: 'flex:1' }, el('label', {}, 'Exclude keywords'),
          el('input', { name: 'excludeKeywords', style: 'width:100%', placeholder: 'sucata, desmontagem', value: (config.excludeKeywords ?? []).join(', ') })),
      )),
    el('fieldset', {}, el('legend', {}, 'Categories'),
      chipSelect('categories', options.categories, config.categories ?? [])),
    el('fieldset', {}, el('legend', {}, 'Location'),
      el('label', {}, 'States (UF)'),
      chipSelect('states', options.states, config.states ?? []),
      el('label', { style: 'margin-top:.5rem' }, 'Cities / units currently in auctions'),
      chipSelect('cities', options.cities, config.cities ?? [])),
    el('fieldset', {}, el('legend', {}, 'Price & flags'),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Min price (R$)'), el('input', { name: 'minPrice', type: 'number', min: '0', value: numberValue('minPrice') })),
        el('div', {}, el('label', {}, 'Max price (R$)'), el('input', { name: 'maxPrice', type: 'number', min: '0', value: numberValue('maxPrice') })),
        el('div', {}, el('label', {}, 'Max % of appraisal'), el('input', { name: 'maxPctOfAppraisal', type: 'number', min: '0', max: '100', value: numberValue('maxPctOfAppraisal') })),
        el('div', {}, el('label', {}, el('input', { type: 'checkbox', name: 'individualsOnly', ...(config.individualsOnly ? { checked: '' } : {}) }), ' Individuals can bid')),
        el('div', {}, el('label', {}, el('input', { type: 'checkbox', name: 'requireImages', ...(config.requireImages ? { checked: '' } : {}) }), ' has photos')),
        el('div', {}, el('label', {}, el('input', { type: 'checkbox', name: 'featuredOnly', ...(config.featuredOnly ? { checked: '' } : {}) }), ' featured only')),
      )),
    el('fieldset', {}, el('legend', {}, 'Notify on'),
      el('div', { class: 'row' },
        chipSelect('events', options.events.map((event) => event), config.events ?? options.events),
        el('div', {}, el('label', {}, 'Channels'),
          chipSelect('channels', options.channels, config.channels ?? options.channels)),
      )),
    el('div', { class: 'row' },
      el('button', { type: 'submit' }, trigger ? 'Save changes' : 'Create trigger'),
      el('button', { type: 'button', class: 'secondary', 'data-testid': 'preview-button', onclick: () => preview() }, 'Preview matches'),
      trigger ? el('button', { type: 'button', class: 'secondary', onclick: () => onSaved() }, 'Cancel') : null,
    ),
    el('div', { 'data-testid': 'form-message' }),
    el('div', { 'data-testid': 'preview-area' }),
  );

  function collectConfig() {
    const data = new FormData(form);
    const config = {};
    const keywords = splitList(data.get('keywords') ?? '');
    const excludeKeywords = splitList(data.get('excludeKeywords') ?? '');
    if (keywords) config.keywords = keywords;
    if (excludeKeywords) config.excludeKeywords = excludeKeywords;
    for (const key of ['categories', 'states', 'cities', 'events', 'channels']) {
      const values = readChips(form, key);
      if (values) config[key] = values;
    }
    for (const key of ['minPrice', 'maxPrice', 'maxPctOfAppraisal']) {
      const value = data.get(key);
      if (value !== null && value !== '') config[key] = Number(value);
    }
    for (const key of ['individualsOnly', 'requireImages', 'featuredOnly']) {
      if (data.get(key)) config[key] = true;
    }
    return { name: data.get('name'), enabled: data.get('enabled') === '1', config };
  }

  function showMessage(text, kind) {
    const box = form.querySelector('[data-testid="form-message"]');
    box.replaceChildren(el('div', { class: `msg ${kind}` }, text));
  }

  async function preview() {
    try {
      const { config } = collectConfig();
      const result = await api('/triggers/test', { method: 'POST', body: JSON.stringify({ config }) });
      const area = form.querySelector('[data-testid="preview-area"]');
      area.replaceChildren(
        el('p', { 'data-testid': 'preview-count' }, 'Currently matches ',
          el('span', { class: 'count' }, String(result.total)), ' lot(s)'),
        lotGrid(result.lots),
      );
    } catch (error) {
      showMessage(error.message, 'error');
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = collectConfig();
      if (trigger) await api(`/triggers/${trigger.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/triggers', { method: 'POST', body: JSON.stringify(payload) });
      onSaved();
    } catch (error) {
      showMessage(error.message, 'error');
    }
  });

  return form;
}

async function renderTriggers(params) {
  const triggers = await api('/triggers');
  view.replaceChildren();

  const matchesFor = params.get('matches');
  if (matchesFor) {
    const trigger = triggers.find((entry) => String(entry.id) === matchesFor);
    if (trigger) {
      const result = await api('/triggers/test', { method: 'POST', body: JSON.stringify({ config: trigger.config }) });
      view.append(el('div', { class: 'panel' },
        el('h2', {}, `Current matches for “${trigger.name}”`),
        el('p', {}, el('span', { class: 'count' }, String(result.total)), ' lot(s) · ',
          el('a', { href: '#/triggers', style: 'color:var(--accent)' }, 'back to triggers')),
        lotGrid(result.lots)));
      return;
    }
  }

  const editId = params.get('edit');
  const editing = triggers.find((entry) => String(entry.id) === editId);
  const list = el('div', { class: 'panel', 'data-testid': 'trigger-list' },
    el('h2', {}, `Triggers (${triggers.length})`),
    triggers.length === 0 ? el('p', { class: 'muted' }, 'No triggers yet — create one below.') : null,
    ...triggers.map((trigger) => el('div', { class: `trigger-row ${trigger.enabled ? '' : 'disabled'}` },
      el('span', { class: 'name' }, trigger.name),
      el('span', { class: 'summary' }, summarizeConfig(trigger.config)),
      el('a', { href: `#/triggers?matches=${trigger.id}`, style: 'color:var(--accent);font-size:.85rem' }, 'matches'),
      el('button', { class: 'secondary', onclick: () => { location.hash = `#/triggers?edit=${trigger.id}`; } }, 'Edit'),
      el('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm(`Delete trigger "${trigger.name}"?`)) return;
          await api(`/triggers/${trigger.id}`, { method: 'DELETE' });
          render();
        },
      }, 'Delete'),
    )),
  );
  view.append(list, triggerForm(editing, () => { location.hash = '#/triggers'; render(); }));
}

// ---------- browse ----------

async function renderBrowse() {
  view.replaceChildren();
  const form = el('form', { class: 'panel row', 'data-testid': 'browse-form' },
    el('div', { style: 'flex:2' }, el('label', {}, 'Keyword'), el('input', { name: 'keyword', style: 'width:100%' })),
    el('div', {}, el('label', {}, 'Category'),
      el('select', { name: 'category' }, el('option', { value: '' }, 'any'),
        ...options.categories.map((category) => el('option', { value: category }, category)))),
    el('div', {}, el('label', {}, 'State'),
      el('select', { name: 'state' }, el('option', { value: '' }, 'any'),
        ...options.states.map((state) => el('option', { value: state }, state)))),
    el('div', {}, el('label', {}, 'Max price'), el('input', { name: 'maxPrice', type: 'number', min: '0' })),
    el('div', {}, el('label', {}, 'Max % appraisal'), el('input', { name: 'maxPctOfAppraisal', type: 'number', min: '0' })),
    el('div', {}, el('label', {}, el('input', { type: 'checkbox', name: 'individuals', value: '1' }), ' Individuals can bid')),
    el('div', {}, el('label', {}, el('input', { type: 'checkbox', name: 'images', value: '1' }), ' photos')),
    el('div', {}, el('button', { type: 'submit' }, 'Filter')),
  );
  const results = el('div', { 'data-testid': 'browse-results' });
  view.append(form, results);

  async function load() {
    const data = new FormData(form);
    const query = new URLSearchParams();
    for (const [key, value] of data.entries()) if (value) query.set(key, value);
    query.set('limit', '60');
    const { total, lots } = await api(`/lots?${query}`);
    results.replaceChildren(
      el('p', {}, el('span', { class: 'count', 'data-testid': 'browse-count' }, String(total)),
        ' lot(s) in active auctions', total > lots.length ? ` — showing first ${lots.length}` : ''),
      lotGrid(lots),
    );
  }
  form.addEventListener('submit', (event) => { event.preventDefault(); load(); });
  await load();
}

// ---------- notifications ----------

async function renderNotifications() {
  const rows = await api('/notifications');
  view.replaceChildren(el('div', { class: 'panel' },
    el('h2', {}, `Notification history (${rows.length})`),
    rows.length === 0 ? el('p', { class: 'muted' }, 'Nothing sent yet.') : el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Sent'), el('th', {}, 'Event'), el('th', {}, 'Title'),
        el('th', {}, 'Lot'), el('th', {}, 'Channels'))),
      el('tbody', {}, ...rows.map((row) => el('tr', {},
        el('td', {}, new Date(row.sentAt).toLocaleString()),
        el('td', {}, EVENT_LABELS[row.event] ?? row.event),
        el('td', {}, row.url ? el('a', { href: row.url, style: 'color:var(--accent)' }, row.title ?? '') : (row.title ?? '')),
        el('td', {}, row.lotNumber ? `${row.noticeId} #${row.lotNumber}` : row.noticeId),
        el('td', {}, row.channels.join(', ') || '—'),
      ))),
    ),
  ));
}

// ---------- settings ----------

async function renderSettings() {
  const status = await api('/status');
  view.replaceChildren();
  const message = el('div', {});

  const show = (text, kind) => message.replaceChildren(el('div', { class: `msg ${kind}` }, text));

  view.append(el('div', { class: 'panel' },
    el('h2', {}, 'Settings'),
    el('div', { class: 'row' },
      el('div', { style: 'flex:1' },
        el('label', {}, 'ntfy topic (push notifications — subscribe to it in the ntfy app)'),
        el('input', { id: 'ntfy-topic', style: 'width:100%', value: status.ntfyTopic ?? '' })),
      el('div', {}, el('button', {
        onclick: async () => {
          const ntfyTopic = document.getElementById('ntfy-topic').value.trim() || null;
          await api('/settings', { method: 'PUT', body: JSON.stringify({ ntfyTopic }) });
          show('Saved.', 'ok');
        },
      }, 'Save')),
    ),
    el('div', { class: 'row', style: 'margin-top:.8rem' },
      el('button', {
        class: 'secondary',
        'data-testid': 'test-toast',
        onclick: async () => {
          try { await api('/test-notification', { method: 'POST', body: JSON.stringify({ channel: 'toast' }) }); show('Toast sent — check your Windows desktop.', 'ok'); }
          catch (error) { show(error.message, 'error'); }
        },
      }, 'Send test toast'),
      el('button', {
        class: 'secondary',
        'data-testid': 'test-ntfy',
        onclick: async () => {
          try { await api('/test-notification', { method: 'POST', body: JSON.stringify({ channel: 'ntfy' }) }); show('Push sent — check the ntfy app.', 'ok'); }
          catch (error) { show(error.message, 'error'); }
        },
      }, 'Send test push'),
    ),
    message,
  ), el('div', { class: 'panel' },
    el('h2', {}, 'Scraper status'),
    el('p', {}, `Last run: ${status.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : 'never'}`),
    el('p', { class: 'muted' }, status.lastRunSummary ? JSON.stringify(status.lastRunSummary) : ''),
    el('p', {}, `${status.counts.notices} notices · ${status.counts.lots} lots · ${status.counts.pendingDetails} pending details · ${status.counts.notifications} notifications sent`),
  ));
}

// ---------- shell ----------

async function refreshRunStatus() {
  try {
    const status = await api('/status');
    document.getElementById('run-status').textContent = status.running
      ? 'scraping…'
      : (status.lastRunAt ? `last run ${new Date(status.lastRunAt).toLocaleTimeString()}` : 'never run');
    document.getElementById('run-now').disabled = status.running;
    return status.running;
  } catch { return false; }
}

document.getElementById('run-now').addEventListener('click', async () => {
  await api('/run', { method: 'POST' }).catch(() => {});
  const poll = setInterval(async () => {
    if (!await refreshRunStatus()) { clearInterval(poll); render(); }
  }, 2000);
  refreshRunStatus();
});

const routes = {
  triggers: renderTriggers,
  browse: renderBrowse,
  notifications: renderNotifications,
  settings: renderSettings,
};

async function render() {
  const [path, queryString] = (location.hash.replace(/^#\//, '') || 'triggers').split('?');
  const route = routes[path.split('/')[0]] ? path.split('/')[0] : 'triggers';
  for (const link of document.querySelectorAll('nav a')) {
    link.classList.toggle('active', link.dataset.nav === route);
  }
  // legacy deep link: #/triggers/<id>/matches → #/triggers?matches=<id>
  const legacy = path.match(/^triggers\/(\d+)\/matches$/);
  const params = new URLSearchParams(legacy ? `matches=${legacy[1]}` : queryString);
  try {
    await routes[route](params);
  } catch (error) {
    view.replaceChildren(el('div', { class: 'msg error' }, `Failed to load: ${error.message}`));
  }
}

window.addEventListener('hashchange', render);

(async () => {
  options = await api('/options');
  await refreshRunStatus();
  await render();
})();

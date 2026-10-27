// Noor Patisserie backend: orders, menu, reviews, settings, photo uploads. Storage: one KV namespace (DATA).
const J = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...h } });
const cl = (s, n) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const te = new TextEncoder();
const eq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return !r };
async function sign(env, exp) {
  const k = await crypto.subtle.importKey('raw', te.encode(env.ADMIN_PASSWORD + '|noor-session'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return exp + '.' + hex(await crypto.subtle.sign('HMAC', k, te.encode(String(exp))));
}
async function authed(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const m = (req.headers.get('cookie') || '').match(/noor_s=(\d+\.[a-f0-9]+)/);
  if (!m) return false;
  const exp = +m[1].split('.')[0];
  return exp > Date.now() && eq(m[1], await sign(env, exp));
}
async function getJ(env, k, u) {
  let v = await env.DATA.get(k, 'json');
  if (v == null) {
    const s = await (await env.ASSETS.fetch(new Request(new URL('/seed.json', u)))).json();
    v = s[k]; await env.DATA.put(k, JSON.stringify(v));
  }
  return v;
}
const put = (env, k, v) => env.DATA.put(k, JSON.stringify(v));
async function recent(env, limit = 80) {
  const l = await env.DATA.list({ prefix: 'o:', limit });
  return (await Promise.all(l.keys.map(k => env.DATA.get(k.name, 'json')))).filter(Boolean);
}
async function notify(env, text) {
  const t = [];
  if (env.DISCORD_WEBHOOK) t.push(fetch(env.DISCORD_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text }) }));
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) t.push(fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }) }));
  await Promise.allSettled(t); return t.length;
}
const csvCell = v => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"' };

async function placeOrder(req, env, ctx, u) {
  const b = await req.json(), S = await getJ(env, 'settings', u), M = await getJ(env, 'menu', u);
  const name = cl(b.name, 60), phone = cl(b.phone, 20), mode = b.mode === 'delivery' ? 'delivery' : 'pickup', addr = cl(b.address, 200);
  if (!name || !/^[+\d][\d\s-]{6,18}$/.test(phone)) return J({ error: 'Please enter your name and a valid phone number.' }, 400);
  if ((mode === 'delivery' && !S.allowDelivery) || (mode === 'pickup' && !S.allowPickup)) return J({ error: 'That option is not available right now.' }, 400);
  if (mode === 'delivery' && addr.length < 8) return J({ error: 'Please enter your full delivery address.' }, 400);
  const items = []; let sub = 0;
  for (const l of (Array.isArray(b.items) ? b.items : []).slice(0, 40)) {
    const it = M.find(x => x.id === l.id), q = Math.min(50, Math.max(1, parseInt(l.q) || 0));
    if (!it || !it.available) return J({ error: `“${it ? it.name : 'An item'}” is not available right now.` }, 400);
    items.push({ id: it.id, name: it.name, price: it.price, q }); sub += it.price * q;
  }
  if (!items.length) return J({ error: 'Your order is empty.' }, 400);
  if (sub < S.minOrder) return J({ error: `Minimum order is ${S.currency} ${S.minOrder}.` }, 400);
  const fee = mode === 'delivery' && !(S.freeAbove > 0 && sub >= S.freeAbove) ? S.deliveryFee : 0;
  const pay = b.pay === 'online' && S.allowOnline ? 'online' : 'cash';
  const seq = (+(await env.DATA.get('seq')) || 0) + 1; await env.DATA.put('seq', String(seq));
  const t = Date.now(), k = 'o:' + String(9e12 - t).padStart(13, '0') + ':' + seq;
  const o = { k, n: seq, t, name, phone, mode, addr, note: cl(b.note, 300), pay, txn: pay === 'online' ? cl(b.txn, 40) : '', items, sub, fee, total: sub + fee, status: 'new' };
  await put(env, k, o);
  ctx.waitUntil(notify(env, `🧁 New order #${seq} — ${name} (${mode})\n` + items.map(i => `${i.q} × ${i.name}`).join('\n') + `\nTotal ${S.currency} ${o.total} · ${pay === 'online' ? 'paid online, txn ' + o.txn : 'pay in person'}\n${phone}`));
  return J({ ok: 1, n: seq, total: o.total });
}

async function admin(req, env, u, p) {
  const m = req.method, get = k => getJ(env, k, u);
  if (p === '/api/admin/state') {
    return J({ settings: await get('settings'), menu: await get('menu'), reviews: await get('reviews'), orders: await recent(env), alerts: { discord: !!env.DISCORD_WEBHOOK, telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) } });
  }
  if (p === '/api/admin/orders') return J({ orders: await recent(env) });
  if (p === '/api/admin/orders.csv') {
    const from = u.searchParams.get('from'), to = u.searchParams.get('to');
    const f = from ? Date.parse(from + 'T00:00:00') : 0, t = to ? Date.parse(to + 'T23:59:59') : Infinity;
    const rows = (await recent(env, 1000)).filter(o => o.t >= f && o.t <= t);
    const head = ['Order', 'Date', 'Name', 'Phone', 'Type', 'Address', 'Items', 'Subtotal', 'Delivery', 'Total', 'Payment', 'Transaction ID', 'Status'];
    const body = rows.map(o => [o.n, new Date(o.t).toISOString().replace('T', ' ').slice(0, 16), o.name, o.phone, o.mode, o.addr, o.items.map(i => `${i.q}x ${i.name}`).join('; '), o.sub, o.fee, o.total, o.pay, o.txn, o.status].map(csvCell).join(','));
    return new Response('\ufeff' + [head.map(csvCell).join(','), ...body].join('\r\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="noor-orders.csv"' } });
  }
  if (p === '/api/admin/order' && m === 'POST') {
    const b = await req.json(), o = await env.DATA.get(String(b.k || ''), 'json');
    if (!o || !['new', 'baking', 'ready', 'done', 'cancelled'].includes(b.status)) return J({ error: 'Not found' }, 404);
    o.status = b.status; await put(env, o.k, o); return J({ ok: 1 });
  }
  if (p === '/api/admin/menu' && m === 'PUT') {
    const b = await req.json();
    const menu = (Array.isArray(b) ? b : []).slice(0, 200).map(x => ({ id: cl(x.id, 60) || crypto.randomUUID().slice(0, 8), name: cl(x.name, 80), desc: cl(x.desc, 160), price: Math.max(0, Math.round(+x.price) || 0), cat: cl(x.cat, 30), image: cl(x.image, 300), icon: cl(x.icon, 12), available: !!x.available, featured: !!x.featured })).filter(x => x.name);
    await put(env, 'menu', menu); return J({ ok: 1, menu });
  }
  if (p === '/api/admin/settings' && m === 'PUT') {
    const b = await req.json(), S = await get('settings');
    for (const k of Object.keys(S)) {
      if (!(k in b)) continue;
      if (typeof S[k] === 'boolean') S[k] = !!b[k];
      else if (typeof S[k] === 'number') S[k] = Math.max(0, Math.round(+b[k]) || 0);
      else if (Array.isArray(S[k])) S[k] = (Array.isArray(b[k]) ? b[k] : []).map(c => cl(c, 30)).filter(Boolean).slice(0, 12);
      else S[k] = cl(b[k], k === 'hours' || k === 'paymentInstructions' || k === 'deliveryNote' ? 600 : 200).replace(/\r/g, '');
    }
    S.whatsapp = S.whatsapp.replace(/\D/g, '');
    await put(env, 'settings', S); return J({ ok: 1, settings: S });
  }
  if (p === '/api/admin/review' && m === 'POST') {
    const b = await req.json(); let R = await get('reviews');
    if (b.action === 'delete') R = R.filter(r => r.id !== b.id);
    else if (['approved', 'hidden', 'pending'].includes(b.action)) R.forEach(r => { if (r.id === b.id) r.status = b.action });
    await put(env, 'reviews', R); return J({ ok: 1, reviews: R });
  }
  if (p === '/api/admin/upload' && m === 'POST') {
    const ct = req.headers.get('content-type') || '';
    if (!/^image\/(jpeg|png|webp)$/.test(ct)) return J({ error: 'Please use a JPG, PNG or WebP image.' }, 400);
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 3e6) return J({ error: 'Image is too large (max 3 MB).' }, 400);
    const id = hex(crypto.getRandomValues(new Uint8Array(10)));
    await env.DATA.put('img:' + id, buf, { metadata: { ct } });
    return J({ url: '/uploads/' + id });
  }
  if (p === '/api/admin/test' && m === 'POST') {
    const n = await notify(env, '✅ Test alert from your Noor admin panel.'); return J({ sent: n });
  }
  return J({ error: 'Not found' }, 404);
}

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url), p = u.pathname, m = req.method;
    try {
      if (p === '/api/site') {
        const [settings, menu, reviews] = await Promise.all(['settings', 'menu', 'reviews'].map(k => getJ(env, k, u)));
        return J({ settings, menu, reviews: reviews.filter(r => r.status === 'approved').sort((a, b) => b.t - a.t).slice(0, 12) }, 200, { 'cache-control': 'public, max-age=15' });
      }
      if (p === '/api/order' && m === 'POST') return await placeOrder(req, env, ctx, u);
      if (p === '/api/review' && m === 'POST') {
        const b = await req.json();
        if (b.website) return J({ ok: 1 });
        const name = cl(b.name, 40), text = cl(b.text, 400), rating = Math.min(5, Math.max(1, parseInt(b.rating) || 5));
        if (!name || text.length < 10) return J({ error: 'Please add your name and a few words (at least 10 characters).' }, 400);
        const R = await getJ(env, 'reviews', u);
        R.unshift({ id: crypto.randomUUID().slice(0, 8), name, rating, text, status: 'pending', t: Date.now() });
        await put(env, 'reviews', R.slice(0, 300));
        ctx.waitUntil(notify(env, `⭐ New review from ${name} is waiting for approval.`));
        return J({ ok: 1 });
      }
      if (p.startsWith('/uploads/')) {
        const { value, metadata } = await env.DATA.getWithMetadata('img:' + p.slice(9).replace(/[^a-f0-9]/g, ''), 'arrayBuffer');
        if (!value) return new Response('Not found', { status: 404 });
        return new Response(value, { headers: { 'content-type': metadata.ct, 'cache-control': 'public, max-age=31536000, immutable' } });
      }
      if (p === '/api/admin/login' && m === 'POST') {
        const b = await req.json().catch(() => ({}));
        if (!env.ADMIN_PASSWORD) return J({ error: 'Set the ADMIN_PASSWORD variable in Cloudflare first.' }, 500);
        if (!eq(String(b.password || ''), env.ADMIN_PASSWORD)) { await new Promise(r => setTimeout(r, 700)); return J({ error: 'Wrong password.' }, 401); }
        const exp = Date.now() + 14 * 864e5;
        return J({ ok: 1 }, 200, { 'set-cookie': `noor_s=${await sign(env, exp)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${14 * 86400}` });
      }
      if (p === '/api/admin/logout') return J({ ok: 1 }, 200, { 'set-cookie': 'noor_s=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
      if (p.startsWith('/api/admin/')) {
        if (!(await authed(req, env))) return J({ error: 'auth' }, 401);
        return await admin(req, env, u, p);
      }
      return env.ASSETS.fetch(req);
    } catch (e) { return J({ error: 'Server error: ' + (e.message || e) }, 500); }
  }
};

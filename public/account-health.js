/* =========================================================================
   WhaleChat account & bot health — health score, equity growth and rest advice
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.WC_HEALTH) return;
  const H = window.WC_HEALTH = {};
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, n) => (Number(v) || 0).toFixed(n == null ? 2 : n);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function session() {
    try {
      const B = window.WC_BOTS;
      const s = B && B.state && B.state.session;
      return s || null;
    } catch (e) { return null; }
  }

  function botStats(s) {
    if (!s) return null;
    const alloc = Number(s.allocatedCoins) || 0;
    const pool = Number(s.poolCoins) || 0;
    const profit = Math.round((pool - alloc) * 100) / 100;
    const profitPct = alloc ? (profit / alloc) * 100 : 0;
    const trades = (s.trades || []).slice().reverse();
    let peak = alloc;
    let wins = 0, losses = 0, streak = 0;
    trades.forEach((tr) => {
      const p = Number(tr.poolAfter);
      if (Number.isFinite(p)) peak = Math.max(peak, p);
      if (Number(tr.pnlCoins) > 0) wins++;
      else if (Number(tr.pnlCoins) < 0) losses++;
    });
    for (let i = 0; i < (s.trades || []).length; i++) {
      const pnl = Number(s.trades[i].pnlCoins);
      if (pnl < 0) streak++; else if (pnl > 0) break;
    }
    const drawdown = peak > 0 ? Math.max(0, (peak - pool) / peak * 100) : 0;
    const winRate = wins + losses ? (wins / (wins + losses)) * 100 : 50;
    let score = 70;
    score += clamp(profitPct * 2.2, -34, 28);
    score -= clamp(drawdown * 1.6, 0, 32);
    score += (winRate - 50) * 0.22;
    score -= Math.min(12, streak * 3);
    score = Math.round(clamp(score, 0, 100));
    return { alloc, pool, profit, profitPct, peak, drawdown, wins, losses, winRate, streak, score, trades, tradeCount: Number(s.tradeCount) || trades.length };
  }

  function accountStats() {
    try {
      if (typeof LT === 'undefined' || !LT.summary || typeof me !== 'function' || !me()) return null;
      const s = LT.summary(me().id);
      return { value: s.valueCoins, capital: s.capital, pnl: s.pnl, pnlPct: s.capital ? (s.pnl / s.capital) * 100 : 0, pos: s.pos.length };
    } catch (e) { return null; }
  }

  function health(bs, acc) {
    if (bs) return bs.score;
    if (acc && acc.capital > 0) return Math.round(clamp(70 + acc.pnlPct * 2.2, 0, 100));
    return 50;
  }

  function advice(score, bs) {
    if (bs && (score < 50 || bs.drawdown > 18 || bs.streak >= 4)) {
      return { tone: 'down', title: 'Rest recommended', body: 'The bot is under drawdown or on a losing run. Stop the bot to lock the remaining capital, let the market reset, then start a fresh session.' };
    }
    if (score < 72 || (bs && bs.drawdown > 9)) {
      return { tone: 'warn', title: 'Watch closely', body: 'Growth is slowing or drawdown is rising. Consider a short break and restart the bot with a smaller allocation.' };
    }
    return { tone: 'up', title: 'Healthy — keep running', body: 'Equity is growing and drawdown is controlled. The bot can keep trading; review again after the next few trades.' };
  }

  function points(bs, acc) {
    const out = [];
    if (bs && bs.trades.length) {
      out.push({ t: 0, v: bs.alloc });
      bs.trades.forEach((tr) => {
        const v = Number(tr.poolAfter);
        if (Number.isFinite(v)) out.push({ t: Number(tr.at) || 0, v });
      });
      if (!out.length || out[out.length - 1].v !== bs.pool) out.push({ t: Date.now(), v: bs.pool });
    } else if (bs) {
      out.push({ t: 0, v: bs.alloc }, { t: Date.now(), v: bs.pool });
    } else if (acc && acc.capital > 0) {
      out.push({ t: 0, v: acc.capital }, { t: Date.now(), v: acc.capital + acc.pnl });
    }
    return out;
  }

  function chartSVG(bs, acc) {
    const pts = points(bs, acc);
    if (pts.length < 2) return `<div class="inv-empty" style="min-height:90px"><p class="small muted">Run a bot to see its health curve.</p></div>`;
    const W = 380, Hh = 132, pad = 14;
    const vals = pts.map((p) => p.v);
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi - lo < 0.01) { hi += 1; lo -= 1; }
    const padV = (hi - lo) * 0.15; lo -= padV; hi += padV;
    const x = (i) => pad + (i / Math.max(1, pts.length - 1)) * (W - pad * 2);
    const y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (Hh - pad * 2);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');
    const area = line + ` L${x(pts.length - 1).toFixed(1)} ${Hh - pad} L${x(0).toFixed(1)} ${Hh - pad} Z`;
    const rising = vals[vals.length - 1] >= vals[0];
    const color = rising ? '#2fd6a6' : '#ff5f74';
    const startV = vals[0], endV = vals[vals.length - 1];
    return `<svg viewBox="0 0 ${W} ${Hh}" class="health-chart" role="img" aria-label="Account and bot equity health chart">
      <defs><linearGradient id="healthFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity=".28"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#healthFill)"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>
      <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(endV).toFixed(1)}" r="3.4" fill="${color}"/>
      <text x="${pad}" y="12" class="health-axis">start ${num(startV)} WC</text>
      <text x="${W - pad}" y="12" text-anchor="end" class="health-axis">now ${num(endV)} WC</text>
    </svg>`;
  }

  function cardHTML() {
    const bs = botStats(session());
    const acc = accountStats();
    if (!bs && !acc) return '';
    const score = health(bs, acc);
    const adv = advice(score, bs);
    const tone = score >= 72 ? 'up' : score >= 50 ? 'warn' : 'down';
    return `<div class="card health-card" id="accountHealthCard" data-health-sig="${[bs ? [bs.pool, bs.peak, bs.drawdown, bs.tradeCount].join('|') : 'no-bot', acc && acc.pnl, acc && acc.pnlPct, score].join('|')}">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Account health analysis</div>
          <div class="tiny muted">Bot performance, equity growth and rest advice</div></div>
        <span class="health-score ${tone}"><b>${score}</b><span>/100</span></span>
      </div>
      <div class="health-metrics">
        <div><span>Bot equity</span><b>${bs ? num(bs.pool) + ' WC' : '—'}</b></div>
        <div><span>Bot P/L</span><b class="${bs && bs.profit >= 0 ? 'up' : bs ? 'down' : ''}">${bs ? (bs.profit >= 0 ? '+' : '−') + num(Math.abs(bs.profit)) + ' WC' : '—'}</b></div>
        <div><span>Drawdown</span><b class="${bs && bs.drawdown > 9 ? 'down' : ''}">${bs ? num(bs.drawdown, 1) + '%' : '—'}</b></div>
        <div><span>Win rate</span><b>${bs ? num(bs.winRate, 0) + '%' : '—'}</b></div>
        <div><span>Account growth</span><b class="${acc && acc.pnl >= 0 ? 'up' : acc ? 'down' : ''}">${acc ? (acc.pnl >= 0 ? '+' : '−') + num(Math.abs(acc.pnlPct), 1) + '%' : '—'}</b></div>
        <div><span>Open positions</span><b>${acc ? acc.pos : 0}</b></div>
      </div>
      ${chartSVG(bs, acc)}
      <div class="health-advice ${adv.tone}">
        <b>${esc(adv.title)}</b>
        <span>${esc(adv.body)}</span>
      </div>
      ${bs ? `<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        <a class="btn btn-sm btn-ghost" href="#/invest/bots">Open trading bot</a>
        <span class="tiny muted">${bs.tradeCount} trade${bs.tradeCount === 1 ? '' : 's'} this session · ${bs.losses} loss${bs.losses === 1 ? '' : 'es'}${bs.streak ? ' · ' + bs.streak + ' in a row' : ''}</span>
      </div>` : ''}
    </div>`;
  }

  function mount() {
    const onBots = (location.hash || '').startsWith('#/invest/bots');
    const onDash = document.querySelector('.inv-hero') && ((location.hash || '') === '#/invest' || (location.hash || '') === '' || (location.hash || '').startsWith('#/invest?'));
    if (!onBots && !onDash) return;
    const existing = document.getElementById('accountHealthCard');
    const html = cardHTML();
    if (!html) { if (existing) existing.remove(); return; }
    if (existing) {
      const sig = existing.getAttribute('data-health-sig');
      const parsed = html.match(/data-health-sig="([^"]*)"/);
      if (!parsed || parsed[1] !== sig) existing.outerHTML = html;
      return;
    }
    const host = document.createElement('div');
    host.innerHTML = html;
    const marketCard = document.getElementById('botMarketCard');
    const chart = document.querySelector('.inv-chartcard');
    const sessionMount = document.getElementById('botSessionMount');
    if (onBots && marketCard && marketCard.parentNode) marketCard.parentNode.insertBefore(host.firstChild, marketCard);
    else if (onBots && sessionMount && sessionMount.parentNode) sessionMount.parentNode.insertBefore(host.firstChild, sessionMount.nextSibling);
    else if (chart && chart.parentNode) chart.parentNode.insertBefore(host.firstChild, chart.nextSibling);
    else document.getElementById('content') && document.getElementById('content').appendChild(host.firstChild);
  }

  if (typeof AFTER === 'object') {
    const prev = AFTER.invest;
    AFTER.invest = function (parts, params) {
      try { if (prev) prev(parts, params); } catch (e) {}
      setTimeout(mount, 130);
    };
  }
  setInterval(mount, 1500);

  (function styles() {
    if (document.getElementById('wc-health-style')) return;
    const st = document.createElement('style');
    st.id = 'wc-health-style';
    st.textContent = `
    .health-score{display:flex;align-items:baseline;gap:2px;padding:5px 10px;border-radius:12px;font-weight:800;font-variant-numeric:tabular-nums}
    .health-score b{font-size:18px}.health-score span{font-size:10px;opacity:.7}
    .health-score.up{background:rgba(47,214,166,.14);color:var(--success)}
    .health-score.warn{background:rgba(255,176,32,.14);color:var(--warn)}
    .health-score.down{background:rgba(255,95,116,.14);color:var(--danger)}
    .health-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:10px}
    .health-metrics div{display:flex;flex-direction:column;gap:1px;padding:7px 8px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2);min-width:0}
    .health-metrics span{font-size:9px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted-2);font-weight:700}
    .health-metrics b{font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .health-chart{width:100%;height:auto;display:block;margin-top:9px;overflow:visible}
    .health-axis{fill:var(--muted-2);font-size:8px;font-weight:600}
    .health-advice{display:flex;flex-direction:column;gap:3px;margin-top:9px;padding:9px 10px;border-radius:10px;font-size:11.5px;line-height:1.55;border:1px solid var(--border)}
    .health-advice b{font-size:12px}
    .health-advice.up{background:rgba(47,214,166,.10);border-color:rgba(47,214,166,.25);color:var(--text)}
    .health-advice.warn{background:rgba(255,176,32,.10);border-color:rgba(255,176,32,.28)}
    .health-advice.down{background:rgba(255,95,116,.10);border-color:rgba(255,95,116,.28)}
    @media(max-width:520px){.health-metrics{grid-template-columns:repeat(2,1fr)}}
    `;
    document.head.appendChild(st);
  })();
})();

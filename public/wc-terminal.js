/* =========================================================================
   WhaleChat Trade Terminal — whalechat terminal chart (w-c-t / "TradeView")
   -------------------------------------------------------------------------
   A single self-contained module (CSS + engine) that renders a Deriv-style
   dark trading terminal on top of TradingView lightweight-charts v5:

     · asset header (ticker dropdown, live price, net + % change, arrow)
     · gradient area / candle canvas with dynamic green-up / red-down line
     · floating crosshair tooltip (timestamp + price + delta)
     · right price scale with a live price badge that moves each tick
     · bottom time scale with live timestamps
     · floating + / − / ⌖ zoom controls (bottom-left of the canvas)
     · right-hand order panel: Long / Short, amount, take-profit & stop-loss
     · BUY / SELL execution buttons pinned under the chart
     · active trade monitoring: dashed ENTRY / TP / SL price lines and live
       unrealised P&L in the HUD and the panel
     · 5 selectable visual styles: obsidian · aurora · carbon · glass · neon

   Zero-reload streaming: ticks are pushed into the series with series.update()
   — no re-mount, no flicker, no re-fetch while switching symbols.

   Public API
     WC_TERMINAL.mount(hostElement, { ...opts })  -> Terminal
     WC_TERMINAL.themes                           -> ['obsidian', ...]
     WC_TERMINAL.style / .setStyle(name)          -> persist the chosen style
   Adapter (optional) — when present the terminal uses real app data/orders:
     { symbols, price(t), history(t) -> [{time,value}], subscribe(t, cb),
       balance(), position(t), buy({side, amountUsd, tpPrice, slPrice}),
       sell(), onNotify(msg, type) }
   Without an adapter it runs a smooth local simulator so the UI is complete.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.WC_TERMINAL && window.WC_TERMINAL.__v >= 3) return;

  const VERSION = '1.0.0';
  const LWC_VERSION = '5.3.0';
  const LWC_URL = 'https://unpkg.com/lightweight-charts@' + LWC_VERSION + '/dist/lightweight-charts.standalone.production.js';
  const STYLE_KEY = 'wc_terminal_style';

  /* ------------------------------------------------------------------ utils */
  const usd = (v, d) => '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });
  const num = (v, d) => (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  function hhmmss(sec) {
    const d = new Date(sec * 1000);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function hhmm(sec) { const d = new Date(sec * 1000); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

  /* ----------------------------------------------------------------- themes */
  /* Each theme = CSS variables (injected stylesheet) + lightweight-charts options. */
  const THEMES = {
    obsidian: {
      label: 'Obsidian', hint: 'Reference layout · charcoal + steel blue',
      up: '#26a69a', down: '#ef5350', accent: '#4a9eff',
      chart: {
        bg: '#0e0e0e', grid: 'rgba(255,255,255,.035)', gridV: 'rgba(255,255,255,.028)',
        text: '#8b949e', border: 'rgba(255,255,255,.06)', crosshair: 'rgba(255,255,255,.28)',
        crossLabel: '#2a2d33', fontSize: 11, lineWidth: 2, areaAlpha: 0.20, mode: 'line', font: "'Inter', -apple-system, 'Segoe UI', Roboto, sans-serif"
      }
    },
    aurora: {
      label: 'Aurora', hint: 'Neon glass · cyan & magenta glow',
      up: '#00f5a0', down: '#ff2e88', accent: '#4be1ff',
      chart: {
        bg: '#070b14', grid: 'rgba(90,140,255,.05)', gridV: 'rgba(90,140,255,.04)',
        text: '#8ea3c4', border: 'rgba(120,180,255,.10)', crosshair: 'rgba(120,200,255,.45)',
        crossLabel: '#0d2740', fontSize: 11, lineWidth: 3, areaAlpha: 0.34, mode: 'line', font: "'Inter', -apple-system, 'Segoe UI', Roboto, sans-serif"
      }
    },
    carbon: {
      label: 'Carbon Pro', hint: 'Trader desk · candles + volume, dense grid',
      up: '#3ddc84', down: '#ff5d5d', accent: '#f0b90b',
      chart: {
        bg: '#0b0d10', grid: 'rgba(255,255,255,.055)', gridV: 'rgba(255,255,255,.045)',
        text: '#9aa7b4', border: 'rgba(255,255,255,.09)', crosshair: 'rgba(240,185,11,.45)',
        crossLabel: '#23272e', fontSize: 11, lineWidth: 2, areaAlpha: 0.12, mode: 'candle', font: "'JetBrains Mono', 'SFMono-Regular', ui-monospace, Menlo, monospace"
      }
    },
    glass: {
      label: 'Liquid Glass', hint: 'Frosted panels · soft mint & coral',
      up: '#2fd9a8', down: '#ff7a7a', accent: '#7fb2ff',
      chart: {
        bg: '#101318', grid: 'rgba(255,255,255,.03)', gridV: 'rgba(255,255,255,.025)',
        text: '#93a0b0', border: 'rgba(255,255,255,.08)', crosshair: 'rgba(255,255,255,.35)',
        crossLabel: '#26303c', fontSize: 11, lineWidth: 3, areaAlpha: 0.26, mode: 'line', font: "'Inter', -apple-system, 'Segoe UI', Roboto, sans-serif"
      }
    },
    neon: {
      label: 'Neon Terminal', hint: 'Cyber HUD · scanlines, lime & hot red',
      up: '#b6ff3d', down: '#ff3b57', accent: '#00e5ff',
      chart: {
        bg: '#05070a', grid: 'rgba(0,229,255,.06)', gridV: 'rgba(0,229,255,.045)',
        text: '#7fd4e0', border: 'rgba(0,229,255,.12)', crosshair: 'rgba(0,229,255,.5)',
        crossLabel: '#062b33', fontSize: 11, lineWidth: 3, areaAlpha: 0.3, mode: 'line', font: "'JetBrains Mono', 'SFMono-Regular', ui-monospace, Menlo, monospace"
      }
    }
  };
  const THEME_ORDER = ['obsidian', 'aurora', 'carbon', 'glass', 'neon'];

  /* ------------------------------------------------------------------- CSS */
  const CSS = `
.wt{--bg:#0e0e0e;--panel:#131518;--panel2:#171a1e;--line:rgba(255,255,255,.07);--line2:rgba(255,255,255,.11);
 --text:#eef2f7;--dim:#7f8b99;--dim2:#5c6875;--up:#26a69a;--down:#ef5350;--accent:#4a9eff;
 --r:16px;--r-sm:10px;--fs:13px;--font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
 --shadow:0 24px 60px rgba(0,0,0,.55);--glass:none;--btnR:12px;--glow:none;--hud:rgba(20,22,26,.92);
 position:relative;display:grid;grid-template-columns:minmax(0,1fr) 288px;gap:12px;box-sizing:border-box;
 background:var(--bg);color:var(--text);font-family:var(--font);font-size:var(--fs);line-height:1.45;
 border-radius:var(--r);padding:12px;overflow:hidden;letter-spacing:-.005em}
.wt *{box-sizing:border-box}
.wt button{font-family:inherit;font-size:inherit;color:inherit;background:none;border:0;cursor:pointer;letter-spacing:inherit}
.wt input,.wt select{font-family:inherit;font-size:inherit;color:inherit;background:none;border:0;outline:none}
.wt .wt-main{display:flex;flex-direction:column;min-width:0;gap:10px}
.wt .wt-stage{position:relative;flex:1;min-height:320px;border-radius:var(--r-sm);overflow:hidden;
 background:var(--chartbg,transparent);border:1px solid var(--line)}
.wt .wt-chart{position:absolute;inset:0}
/* ---------------------------------------------------------------- header */
.wt .wt-head{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--line);
 border-radius:var(--r-sm);background:var(--panel);flex-wrap:wrap}
.wt .wt-sym{position:relative;display:flex;align-items:center;gap:10px;padding:7px 10px 7px 8px;border-radius:10px;
 border:1px solid var(--line2);background:var(--panel2);cursor:pointer;transition:border-color .16s}
.wt .wt-sym:hover{border-color:var(--accent)}
.wt .wt-logo{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;font-size:11px;font-weight:800;
 color:#08110f;background:linear-gradient(135deg,var(--up),var(--accent));letter-spacing:0}
.wt .wt-symtxt{display:flex;flex-direction:column;line-height:1.15}
.wt .wt-symtxt b{font-size:13.5px;font-weight:700}
.wt .wt-symtxt span{font-size:10.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}
.wt .wt-caret{color:var(--dim);font-size:10px;margin-left:2px}
.wt .wt-sym select{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.wt .wt-price{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.wt .wt-price b{font-size:26px;font-weight:750;letter-spacing:-.03em;transition:color .18s;
 font-variant-numeric:tabular-nums}
.wt .wt-price .wt-chg{font-size:12px;font-weight:650;padding:3px 8px;border-radius:7px;font-variant-numeric:tabular-nums}
.wt .wt-price .wt-chg.up{color:var(--up);background:color-mix(in srgb,var(--up) 14%,transparent)}
.wt .wt-price .wt-chg.down{color:var(--down);background:color-mix(in srgb,var(--down) 14%,transparent)}
.wt .wt-headspacer{flex:1}
.wt .wt-pills{display:flex;gap:4px;padding:3px;border-radius:9px;background:var(--panel2);border:1px solid var(--line)}
.wt .wt-pill{padding:5px 9px;border-radius:7px;font-size:11px;font-weight:600;color:var(--dim);transition:.15s}
.wt .wt-pill:hover{color:var(--text)}
.wt .wt-pill.on{background:var(--line2);color:var(--text)}
.wt .wt-stylewrap{padding:2px 3px}
.wt .wt-style{padding:5px 7px;border-radius:6px;font-size:11px;font-weight:600;color:var(--dim);background:transparent;cursor:pointer}
.wt .wt-style option{background:#14171c;color:#e9edf2}
.wt .wt-live{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:700;letter-spacing:.1em;
 color:var(--up);text-transform:uppercase;padding:5px 9px;border-radius:8px;
 background:color-mix(in srgb,var(--up) 10%,transparent);border:1px solid color-mix(in srgb,var(--up) 26%,transparent)}
.wt .wt-dot{width:6px;height:6px;border-radius:50%;background:var(--up);box-shadow:0 0 0 0 currentColor;animation:wtpulse 1.6s infinite}
@keyframes wtpulse{0%{opacity:1;box-shadow:0 0 0 0 color-mix(in srgb,var(--up) 55%,transparent)}
 70%{opacity:.85;box-shadow:0 0 0 7px transparent}100%{opacity:1;box-shadow:0 0 0 0 transparent}}
/* ------------------------------------------------------------- tooltip */
.wt .wt-tip{position:absolute;z-index:6;pointer-events:none;opacity:0;transform:translateY(4px);
 transition:opacity .12s,transform .12s;padding:8px 10px;border-radius:9px;border:1px solid var(--line2);
 background:var(--hud);backdrop-filter:blur(8px);box-shadow:0 12px 28px rgba(0,0,0,.45);min-width:126px}
.wt .wt-tip.on{opacity:1;transform:translateY(0)}
.wt .wt-tip .t{font-size:10.5px;color:var(--dim);letter-spacing:.02em}
.wt .wt-tip .p{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:2px}
.wt .wt-tip .d{font-size:10.5px;font-weight:600;margin-top:1px}
.wt .wt-tip .w{font-size:10px;color:var(--dim2);margin-top:2px}
/* --------------------------------------------------------------- zoom */
.wt .wt-zoom{position:absolute;left:10px;bottom:26px;z-index:5;display:flex;flex-direction:column;gap:2px;
 border-radius:9px;border:1px solid var(--line2);background:var(--hud);backdrop-filter:blur(8px);overflow:hidden}
.wt .wt-zoom button{width:28px;height:26px;display:grid;place-items:center;font-size:13px;color:var(--dim);transition:.14s}
.wt .wt-zoom button:hover{background:var(--line2);color:var(--text)}
.wt .wt-zoom button svg{width:13px;height:13px}
/* ----------------------------------------------------------------- hud */
.wt .wt-hud{position:absolute;left:10px;top:10px;z-index:5;display:none;align-items:center;gap:9px;padding:7px 11px;
 border-radius:9px;border:1px solid var(--line2);background:var(--hud);backdrop-filter:blur(9px)}
.wt .wt-hud.on{display:flex}
.wt .wt-hud .side{font-size:9.5px;font-weight:800;letter-spacing:.09em;padding:3px 6px;border-radius:5px}
.wt .wt-hud .side.long{color:var(--up);background:color-mix(in srgb,var(--up) 16%,transparent)}
.wt .wt-hud .side.short{color:var(--down);background:color-mix(in srgb,var(--down) 16%,transparent)}
.wt .wt-hud .kv{display:flex;flex-direction:column;line-height:1.15}
.wt .wt-hud .kv span{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)}
.wt .wt-hud .kv b{font-size:12px;font-weight:700;font-variant-numeric:tabular-nums}
.wt .wt-hud .pl{font-variant-numeric:tabular-nums}
.wt .wt-legend{position:absolute;right:100px;top:10px;z-index:4;font-size:10px;color:var(--dim);letter-spacing:.04em;opacity:.75}
/* -------------------------------------------------------- side / orders */
.wt .wt-side{display:flex;flex-direction:column;gap:10px;min-width:0}
.wt .wt-card{border:1px solid var(--line);border-radius:var(--r-sm);background:var(--panel);padding:11px 12px}
.wt .wt-cardhead{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}
.wt .wt-cardhead h4{margin:0;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--dim)}
.wt .wt-seg{display:grid;grid-template-columns:1fr 1fr;gap:3px;padding:3px;border-radius:9px;background:var(--panel2);border:1px solid var(--line)}
.wt .wt-seg button{padding:8px;border-radius:7px;font-size:12px;font-weight:700;color:var(--dim);transition:.15s}
.wt .wt-seg button.on[data-side=long]{background:color-mix(in srgb,var(--up) 18%,transparent);color:var(--up);
 box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--up) 35%,transparent)}
.wt .wt-seg button.on[data-side=short]{background:color-mix(in srgb,var(--down) 18%,transparent);color:var(--down);
 box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--down) 35%,transparent)}
.wt .wt-field{margin-top:10px}
.wt .wt-field label{display:block;font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--dim);margin-bottom:5px}
.wt .wt-input{display:flex;align-items:center;gap:6px;border-radius:9px;border:1px solid var(--line2);
 background:var(--panel2);padding:8px 10px;transition:border-color .15s}
.wt .wt-input:focus-within{border-color:var(--accent)}
.wt .wt-input span{font-size:11px;color:var(--dim);font-weight:600}
.wt .wt-input input{flex:1;min-width:0;font-size:14px;font-weight:650;font-variant-numeric:tabular-nums}
.wt .wt-input input::-webkit-outer-spin-button,.wt .wt-input input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.wt .wt-chips{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-top:7px}
.wt .wt-chips button{padding:6px 0;border-radius:7px;border:1px solid var(--line);font-size:11px;font-weight:600;color:var(--dim);transition:.14s}
.wt .wt-chips button:hover{color:var(--text);border-color:var(--line2);background:var(--panel2)}
.wt .wt-tp{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px;
 padding:9px 10px;border-radius:9px;border:1px solid var(--line);background:var(--panel2);min-height:44px}
.wt .wt-tp .lab{display:flex;align-items:center;gap:7px;font-size:11.5px;font-weight:600;color:var(--dim)}
.wt .wt-tp .sw{width:30px;height:16px;border-radius:20px;background:var(--line2);position:relative;transition:.18s;flex:0 0 auto}
.wt .wt-tp .sw i{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:.18s}
.wt .wt-tp.on .sw{background:color-mix(in srgb,var(--up) 55%,transparent)}
.wt .wt-tp.on .sw i{left:16px}
.wt .wt-tp .val{display:flex;flex-direction:column;align-items:flex-end;gap:1px;min-width:86px}
.wt .wt-tp .inrow{display:flex;align-items:baseline;gap:2px}
.wt .wt-tp input{width:48px;text-align:right;font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--text)}
.wt .wt-tp .pct{font-size:10.5px;color:var(--dim)}
.wt .wt-tp .pxl{font-size:9.5px;color:var(--dim2);display:block;text-align:right;font-variant-numeric:tabular-nums;letter-spacing:.01em}
.wt .wt-go{width:100%;margin-top:11px;padding:13px;border-radius:var(--btnR);font-size:13.5px;font-weight:750;
 letter-spacing:.01em;color:#04120e;background:linear-gradient(135deg,var(--up),color-mix(in srgb,var(--up) 55%,var(--accent)));
 box-shadow:0 10px 24px color-mix(in srgb,var(--up) 22%,transparent);transition:transform .12s,filter .15s}
.wt .wt-go[data-side=short]{color:#1c0606;background:linear-gradient(135deg,var(--down),color-mix(in srgb,var(--down) 55%,#ff9a3d))}
.wt .wt-go:hover{filter:brightness(1.07)}
.wt .wt-go:active{transform:translateY(1px) scale(.995)}
.wt .wt-go:disabled{opacity:.42;cursor:not-allowed;box-shadow:none;filter:saturate(.4)}
.wt .wt-sum{margin-top:10px;display:flex;flex-direction:column;gap:5px}
.wt .wt-sum .row{display:flex;justify-content:space-between;font-size:11.5px;color:var(--dim)}
.wt .wt-sum .row b{color:var(--text);font-weight:650;font-variant-numeric:tabular-nums}
/* position card */
.wt .wt-pos{display:none;flex-direction:column;gap:8px}
.wt .wt-pos.on{display:flex}
.wt .wt-pos .plbig{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.wt .wt-pos .plbig b{font-size:22px;font-weight:750;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.wt .wt-pos .plbig span{font-size:11.5px;font-weight:650}
.wt .wt-pos .rows{display:flex;flex-direction:column;gap:4px;margin-top:2px}
.wt .wt-pos .rows div{display:flex;justify-content:space-between;font-size:11px;color:var(--dim)}
.wt .wt-pos .rows b{color:var(--text);font-weight:650;font-variant-numeric:tabular-nums}
.wt .wt-close{margin-top:4px;padding:10px;border-radius:10px;font-size:12px;font-weight:700;color:var(--text);
 border:1px solid var(--line2);background:var(--panel2);transition:.15s}
.wt .wt-close:hover{background:color-mix(in srgb,var(--down) 18%,var(--panel2));border-color:color-mix(in srgb,var(--down) 45%,transparent)}
.wt .wt-empty{margin:0;font-size:11px;color:var(--dim2);text-align:center;padding:6px 0}
/* execution bar under the chart */
.wt .wt-exec{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.wt .wt-exec button{padding:13px;border-radius:var(--btnR);font-size:13.5px;font-weight:750;transition:.15s;
 border:1px solid transparent;display:flex;align-items:center;justify-content:center;gap:7px}
.wt .wt-buy{color:#04120e;background:linear-gradient(135deg,var(--up),color-mix(in srgb,var(--up) 60%,var(--accent)));
 box-shadow:0 10px 26px color-mix(in srgb,var(--up) 20%,transparent)}
.wt .wt-sell{color:#1a0707;background:linear-gradient(135deg,var(--down),color-mix(in srgb,var(--down) 58%,#ff9a3d));
 box-shadow:0 10px 26px color-mix(in srgb,var(--down) 18%,transparent)}
.wt .wt-exec button:hover{filter:brightness(1.08)}
.wt .wt-exec button:active{transform:translateY(1px)}
.wt .wt-exec button:disabled{opacity:.34;box-shadow:none;filter:saturate(.35);cursor:not-allowed;color:#8b949e}
.wt .wt-foot{display:flex;justify-content:space-between;align-items:center;font-size:10.5px;color:var(--dim2);padding:0 2px}
.wt .wt-foot .bal{color:var(--dim);font-variant-numeric:tabular-nums}
/* -------------------------------------------------------------- variants */
/* AURORA */
.wt.th-aurora{--bg:#05080f;--panel:rgba(14,22,38,.72);--panel2:rgba(20,32,52,.6);--line:rgba(110,170,255,.13);
 --line2:rgba(110,170,255,.22);--dim:#8ba4c8;--dim2:#5f7794;--hud:rgba(9,16,28,.88);--accent:#4be1ff;--r:18px;
 background:radial-gradient(1200px 500px at 8% -10%,rgba(0,245,160,.09),transparent 60%),
            radial-gradient(900px 480px at 95% 8%,rgba(255,46,136,.10),transparent 62%),#05080f;
 box-shadow:inset 0 0 0 1px rgba(90,150,255,.12),0 30px 80px rgba(0,0,0,.6)}
.wt.th-aurora .wt-card,.wt.th-aurora .wt-head{backdrop-filter:blur(14px);box-shadow:0 12px 34px rgba(0,0,0,.35)}
.wt.th-aurora .wt-go,.wt.th-aurora .wt-buy{box-shadow:0 0 0 1px rgba(0,245,160,.35),0 14px 34px rgba(0,245,160,.22)}
.wt.th-aurora .wt-sell{box-shadow:0 0 0 1px rgba(255,46,136,.35),0 14px 34px rgba(255,46,136,.2)}
.wt.th-aurora .wt-stage{box-shadow:inset 0 0 60px rgba(0,120,255,.08)}
/* CARBON */
.wt.th-carbon{--bg:#080a0d;--panel:#0d1013;--panel2:#12161a;--line:rgba(255,255,255,.085);--line2:rgba(255,255,255,.14);
 --dim:#93a1ad;--dim2:#65727e;--accent:#f0b90b;--r:8px;--r-sm:6px;--btnR:6px;--hud:rgba(10,13,16,.94);--fs:12.5px;
 background:repeating-linear-gradient(90deg,rgba(255,255,255,.018) 0 1px,transparent 1px 64px),#080a0d}
.wt.th-carbon .wt-cardhead h4{color:#c9a227;letter-spacing:.14em}
.wt.th-carbon .wt-price b{font-size:24px}
.wt.th-carbon .wt-card{background:linear-gradient(180deg,#0d1013,#0a0d10)}
.wt.th-carbon .wt-go,.wt.th-carbon .wt-buy,.wt.th-carbon .wt-sell{border-radius:6px;box-shadow:none}
/* GLASS */
.wt.th-glass{--bg:#0c0f14;--panel:rgba(255,255,255,.045);--panel2:rgba(255,255,255,.055);--line:rgba(255,255,255,.075);
 --line2:rgba(255,255,255,.13);--dim:#9aa7b6;--dim2:#6b7887;--accent:#7fb2ff;--r:22px;--r-sm:18px;--btnR:16px;
 --hud:rgba(22,27,34,.8);
 background:radial-gradient(900px 420px at 20% -10%,rgba(127,178,255,.14),transparent 60%),
            radial-gradient(700px 420px at 90% 110%,rgba(47,217,168,.10),transparent 60%),#0c0f14}
.wt.th-glass .wt-card,.wt.th-glass .wt-head,.wt.th-glass .wt-stage{backdrop-filter:blur(18px) saturate(1.3);
 box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 18px 44px rgba(0,0,0,.35)}
.wt.th-glass .wt-go,.wt.th-glass .wt-buy,.wt.th-glass .wt-sell{border-radius:16px}
/* NEON */
.wt.th-neon{--bg:#03060a;--panel:rgba(6,18,22,.85);--panel2:rgba(8,24,30,.75);--line:rgba(0,229,255,.16);
 --line2:rgba(0,229,255,.28);--dim:#79c6d4;--dim2:#4d8b9a;--accent:#00e5ff;--r:4px;--r-sm:3px;--btnR:3px;
 --hud:rgba(3,16,20,.92);--text:#dffcff;
 background:repeating-linear-gradient(0deg,rgba(0,229,255,.035) 0 1px,transparent 1px 3px),#03060a}
.wt.th-neon .wt-price b{text-shadow:0 0 18px color-mix(in srgb,var(--accent) 55%,transparent)}
.wt.th-neon .wt-go,.wt.th-neon .wt-buy{box-shadow:0 0 0 1px rgba(182,255,61,.4),0 0 26px rgba(182,255,61,.28)}
.wt.th-neon .wt-sell{box-shadow:0 0 0 1px rgba(255,59,87,.4),0 0 26px rgba(255,59,87,.26)}
.wt.th-neon .wt-stage::after{content:'';position:absolute;inset:0;pointer-events:none;
 background:repeating-linear-gradient(0deg,rgba(0,0,0,.22) 0 1px,transparent 1px 3px);mix-blend-mode:multiply}
.wt.th-neon .wt-cardhead h4{color:var(--accent)}
/* ----------------------------------------------------------- responsive */
@media (max-width:1020px){.wt{grid-template-columns:minmax(0,1fr)}}
@media (max-width:620px){
 .wt{padding:9px;gap:9px;--fs:12.5px}
 .wt .wt-price b{font-size:21px}
 .wt .wt-stage{min-height:300px}
 .wt .wt-pills{order:5}
 .wt .wt-legend{display:none}
}
`;

  function injectCSS() {
    if (document.getElementById('wc-terminal-css')) return;
    const s = document.createElement('style');
    s.id = 'wc-terminal-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------- LWC loader */
  function loadLWC() {
    if (window.LightweightCharts && window.LightweightCharts.createChart) return Promise.resolve(window.LightweightCharts);
    if (loadLWC._p) return loadLWC._p;
    loadLWC._p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LWC_URL; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = () => window.LightweightCharts ? resolve(window.LightweightCharts) : reject(new Error('lightweight-charts failed to initialise'));
      s.onerror = () => reject(new Error('Could not load lightweight-charts v5'));
      document.head.appendChild(s);
    });
    return loadLWC._p;
  }

  /* -------------------------------------------------------- local simulator */
  /* Deterministic-ish walk that keeps the app demo alive when no adapter is given. */
  const UNIVERSE = [
    { ticker: 'AAPL', name: 'Apple Inc.', base: 232.4 },
    { ticker: 'TSLA', name: 'Tesla Motors', base: 341.8 },
    { ticker: 'NVDA', name: 'NVIDIA Corp.', base: 1187.5 },
    { ticker: 'MSFT', name: 'Microsoft', base: 428.9 },
    { ticker: 'AMZN', name: 'Amazon.com', base: 205.6 },
    { ticker: 'COIN', name: 'Coinbase Global', base: 312.4 },
    { ticker: 'BTCUSD', name: 'Bitcoin / USD', base: 96420.0 },
    { ticker: 'SPX', name: 'S&P 500 Index', base: 5987.3 }
  ];

  function seeded(seed) { let a = seed >>> 0; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  function buildHistory(sym, base, seconds, step) {
    /* Ornstein–Uhlenbeck walk around `base`: realistic texture that always
       lands on the live price, so the tape never shows a fake cliff at the end. */
    const rnd = seeded(sym.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0);
    const now = Math.floor(Date.now() / 1000);
    const start = now - seconds;
    const out = [];
    const vol = base * 0.00035;
    const theta = 0.004;
    let p = base * (1 + (rnd() - 0.5) * 0.02);
    let mom = 0;
    for (let t = start; t <= now; t += step) {
      mom = mom * 0.9 + (rnd() - 0.5) * vol;
      p = p + theta * (base - p) + mom + Math.sin(t / 2600) * vol * 0.35;
      out.push({ time: t, value: Math.round(p * 100) / 100 });
    }
    out[out.length - 1].value = Math.round((out[out.length - 1].value + base) / 2 * 100) / 100;
    return out;
  }

  /* ============================================================== Terminal */
  class Terminal {
    constructor(host, opts) {
      this.host = host;
      this.o = Object.assign({
        symbol: 'AAPL', theme: 'obsidian', timeframe: '5m', mode: null,
        symbols: null, adapter: null, simulate: true, balance: 10000,
        showExec: true, compact: false, storage: true, onNotify: null
      }, opts || {});
      this.theme = THEMES[this.o.theme] ? this.o.theme : 'obsidian';
      this.adapter = this.o.adapter || null;
      this.sim = !this.adapter;
      this.symbol = String(this.o.symbol || 'AAPL').toUpperCase();
      this.mode = this.o.mode || THEMES[this.theme].chart.mode;
      this.points = [];
      this.lastPrice = 0;
      this.prevPrice = 0;
      this.sessionOpen = 0;
      this.dir = 1;
      this.position = null;         /* { side, amountUsd, entry, qty, tp, sl, openedAt } */
      this.balance = Number(this.o.balance) || 10000;
      this.destroyed = false;
      this._priceLines = [];
      this._side = 'long';
      this._tpOn = false; this._slOn = false;
      this._build();
      this._bind();
      this._boot();
    }

    /* --------------------------------------------------------------- build */
    _build() {
      injectCSS();
      const t = this.theme;
      const root = el('div', 'wt th-' + t);
      root.setAttribute('data-wt-theme', t);
      const uni = this._universe();
      const active = uni.find((u) => u.ticker === this.symbol) || uni[0];

      root.innerHTML = `
        <div class="wt-main">
          <div class="wt-head">
            <label class="wt-sym" title="Switch asset">
              <i class="wt-logo">${active.ticker.slice(0, 2)}</i>
              <span class="wt-symtxt"><b data-wt="sym">${active.ticker}</b><span data-wt="name">${active.name}</span></span>
              <span class="wt-caret">▾</span>
              <select data-wt="select" aria-label="Select asset">
                ${uni.map((u) => `<option value="${u.ticker}" ${u.ticker === this.symbol ? 'selected' : ''}>${u.ticker} — ${u.name}</option>`).join('')}
              </select>
            </label>
            <div class="wt-price">
              <b data-wt="price">—</b>
              <span class="wt-chg up" data-wt="chg">▲ 0.00%</span>
            </div>
            <div class="wt-headspacer"></div>
            <div class="wt-pills" data-wt="tfpills">
              ${['1m', '5m', '15m', '1H', '1D'].map((x) => `<button class="wt-pill ${x === this.o.timeframe ? 'on' : ''}" data-tf="${x}">${x}</button>`).join('')}
            </div>
            <div class="wt-pills" data-wt="modepills">
              <button class="wt-pill ${this.mode === 'line' ? 'on' : ''}" data-mode="line">Line</button>
              <button class="wt-pill ${this.mode === 'candle' ? 'on' : ''}" data-mode="candle">Candles</button>
            </div>
            ${this.o.stylePicker ? `<div class="wt-pills wt-stylewrap"><select class="wt-style" data-wt="style" title="Chart style">
              ${THEME_ORDER.map((k) => `<option value="${k}" ${k === this.theme ? 'selected' : ''}>${THEMES[k].label}</option>`).join('')}
            </select></div>` : ''}
            <div class="wt-live"><i class="wt-dot"></i><span>Live</span></div>
          </div>

          <div class="wt-stage" data-wt="stage">
            <div class="wt-chart" data-wt="chart"></div>
            <div class="wt-legend" data-wt="legend"></div>
            <div class="wt-hud" data-wt="hud"></div>
            <div class="wt-tip" data-wt="tip"></div>
            <div class="wt-zoom">
              <button data-zoom="in" title="Zoom in">+</button>
              <button data-zoom="out" title="Zoom out">−</button>
              <button data-zoom="fit" title="Center / fit">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>
              </button>
            </div>
          </div>

          ${this.o.showExec ? `<div class="wt-exec">
            <button class="wt-buy" data-wt="buy">▲ Buy / Long</button>
            <button class="wt-sell" data-wt="sell" disabled>▼ Sell / Close</button>
          </div>` : ''}
          <div class="wt-foot">
            <span data-wt="foot">Streaming · lightweight-charts v${LWC_VERSION}</span>
            <span class="bal">Balance <b data-wt="bal">${usd(this.balance)}</b></span>
          </div>
        </div>

        <aside class="wt-side">
          <div class="wt-card">
            <div class="wt-cardhead"><h4>Order ticket</h4><span data-wt="sidehint" style="font-size:10px;color:var(--dim2)">rise / fall</span></div>
            <div class="wt-seg">
              <button data-side="long" class="on">Buy / Long</button>
              <button data-side="short">Buy / Short</button>
            </div>
            <div class="wt-field">
              <label>Amount (USD)</label>
              <div class="wt-input"><span>$</span><input data-wt="amount" type="number" min="1" step="1" value="100" inputmode="decimal"/><span data-wt="qty">0.4300 sh</span></div>
              <div class="wt-chips">${[25, 50, 100, 250].map((v) => `<button data-amt="${v}">$${v}</button>`).join('')}</div>
            </div>
            <div class="wt-tp" data-tp="tp"><span class="lab"><i class="sw"><i></i></i>Take profit</span>
              <span class="val"><span class="inrow"><input data-wt="tp" type="number" min="0" step="0.1" value="1.5"/><span class="pct">%</span></span><small class="pxl" data-wt="tpx">target off</small></span></div>
            <div class="wt-tp" data-tp="sl"><span class="lab"><i class="sw"><i></i></i>Stop loss</span>
              <span class="val"><span class="inrow"><input data-wt="sl" type="number" min="0" step="0.1" value="0.8"/><span class="pct">%</span></span><small class="pxl" data-wt="slx">stop off</small></span></div>
            <button class="wt-go" data-wt="go" data-side="long">Buy / Long ${this.symbol}</button>
            <div class="wt-sum">
              <div class="row"><span>Entry (live)</span><b data-wt="entrypx">—-</b></div>
              <div class="row"><span>Est. fees</span><b data-wt="fee">$0.00</b></div>
              <div class="row"><span>Buying power</span><b data-wt="bp">${usd(this.balance)}</b></div>
            </div>
          </div>

          <div class="wt-card">
            <div class="wt-cardhead"><h4>Active position</h4><span data-wt="postat" style="font-size:10px;color:var(--dim2)">flat</span></div>
            <div class="wt-pos" data-wt="pos">
              <div class="plbig"><b data-wt="pl">$0.00</b><span data-wt="plpct">0.00%</span></div>
              <div class="rows">
                <div><span>Side</span><b data-wt="pside">—</b></div>
                <div><span>Entry</span><b data-wt="pentry">—</b></div>
                <div><span>Size</span><b data-wt="psize">—</b></div>
                <div><span>Take profit</span><b data-wt="ptp">—</b></div>
                <div><span>Stop loss</span><b data-wt="psl">—</b></div>
              </div>
              <button class="wt-close" data-wt="closepos">Close position at market</button>
            </div>
            <p class="wt-empty" data-wt="noPos">No open position on ${this.symbol}. Entry, TP and SL lines appear on the chart once you trade.</p>
          </div>
        </aside>`;

      this.root = root;
      this.host.innerHTML = '';
      this.host.appendChild(root);
      this.$ = (k) => root.querySelector('[data-wt="' + k + '"]');
      this.stage = this.$('stage');
      this.chartHost = this.$('chart');
      this.els = {
        price: this.$('price'), chg: this.$('chg'), sym: this.$('sym'), name: this.$('name'),
        tip: this.$('tip'), hud: this.$('hud'), legend: this.$('legend'),
        amount: this.$('amount'), qty: this.$('qty'), bt: this.$('buy'), sel: this.$('sell'),
        go: this.$('go'), tp: this.$('tp'), sl: this.$('sl'), tpx: this.$('tpx'), slx: this.$('slx'),
        pos: this.$('pos'), noPos: this.$('noPos'), pl: this.$('pl'), plpct: this.$('plpct'),
        pside: this.$('pside'), pentry: this.$('pentry'), psize: this.$('psize'), ptp: this.$('ptp'),
        psl: this.$('psl'), postat: this.$('postat'), bal: this.$('bal'), bp: this.$('bp'),
        entrypx: this.$('entrypx'), fee: this.$('fee'), foot: this.$('foot')
      };
      this._paintChrome();
    }

    _universe() {
      if (this.adapter && Array.isArray(this.adapter.symbols) && this.adapter.symbols.length) {
        return this.adapter.symbols.map((s) => typeof s === 'string' ? { ticker: s, name: s, base: 0 } : s);
      }
      return UNIVERSE;
    }

    /* --------------------------------------------------------------- events */
    _bind() {
      const r = this.root;
      r.addEventListener('click', (e) => {
        const z = e.target.closest('[data-zoom]');
        if (z) { this._zoom(z.getAttribute('data-zoom')); return; }
        const tf = e.target.closest('[data-tf]');
        if (tf) { this._setTimeframe(tf.getAttribute('data-tf')); return; }
        const md = e.target.closest('[data-mode]');
        if (md) { this._setMode(md.getAttribute('data-mode')); return; }
        const side = e.target.closest('[data-side]');
        if (side && side.classList.contains('wt-seg') === false && !side.classList.contains('wt-go') && side.parentNode && side.parentNode.classList.contains('wt-seg')) {
          this._setSide(side.getAttribute('data-side')); return;
        }
        const amt = e.target.closest('[data-amt]');
        if (amt) { this.els.amount.value = amt.getAttribute('data-amt'); this._sync(); return; }
        const tp = e.target.closest('[data-tp]');
        if (tp && !e.target.closest('input')) {
          const k = tp.getAttribute('data-tp');
          if (k === 'tp') this._tpOn = !this._tpOn; else this._slOn = !this._slOn;
          tp.classList.toggle('on', k === 'tp' ? this._tpOn : this._slOn);
          this._sync(); return;
        }
        if (e.target.closest('[data-wt="go"]')) { this._execute(this._side); return; }
        if (e.target.closest('[data-wt="buy"]')) { this._execute(this._side); return; }
        if (e.target.closest('[data-wt="sell"]') || e.target.closest('[data-wt="closepos"]')) { this._close(); return; }
      });
      this.els.amount.addEventListener('input', () => this._sync());
      this.els.tp.addEventListener('input', () => { if (!this._tpOn) { this._tpOn = true; this.root.querySelector('[data-tp="tp"]').classList.add('on'); } this._sync(); });
      this.els.sl.addEventListener('input', () => { if (!this._slOn) { this._slOn = true; this.root.querySelector('[data-tp="sl"]').classList.add('on'); } this._sync(); });
      const sel = this.$('select');
      if (sel) sel.addEventListener('change', () => this.setSymbol(sel.value));
      const styleSel = this.$('style');
      if (styleSel) styleSel.addEventListener('change', () => this.setTheme(styleSel.value));
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(this.stage);
      this.root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === this.els.amount) this._execute(this._side); });
      if (this.o.storage) {
        try {
          const savedStyle = localStorage.getItem(STYLE_KEY);
          if (savedStyle && !this.o.themeLocked && THEMES[savedStyle] && savedStyle !== this.theme) this.setTheme(savedStyle);
        } catch (e) {}
      }
    }

    /* ---------------------------------------------------------------- paint */
    _paintChrome() {
      const th = THEMES[this.theme];
      const root = this.root;
      root.style.setProperty('--up', th.up);
      root.style.setProperty('--down', th.down);
      root.style.setProperty('--accent', th.accent);
      root.style.setProperty('--chartbg', th.chart.bg);
      if (this.els.foot) this.els.foot.textContent = (this.sim ? 'Simulated feed' : 'Live feed') + ' · lightweight-charts v' + LWC_VERSION;
    }

    setTheme(name) {
      if (!THEMES[name] || name === this.theme) return;
      this.theme = name;
      if (!this._modeUserSet && !this.o.modeLocked) {
        const want = THEMES[name].chart.mode;
        if (want !== this.mode) {
          this.mode = want;
          if (this.root) this.root.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-mode') === want));
          this._shouldFit = true;
          if (this.chart) { this._teardownSeries(); this._attachSeries(); this._setData(); this._renderPriceLines(); }
        }
      }
      this.root.className = 'wt th-' + name;
      this.root.setAttribute('data-wt-theme', name);
      this._paintChrome();
      const c = THEMES[name].chart;
      if (this.chart) {
        this.chart.applyOptions(this._chartOptions(c));
        this._applySeriesTheme();
      }
      if (this.o.storage) { try { localStorage.setItem(STYLE_KEY, name); } catch (e) {} }
      if (typeof this.o.onTheme === 'function') { try { this.o.onTheme(name); } catch (e) {} }
    }

    _chartOptions(c, initial) {
      return {
        autoSize: true,
        layout: {
          background: { type: 'solid', color: c.bg },
          textColor: c.text,
          fontSize: c.fontSize,
          fontFamily: c.font,
          attributionLogo: false
        },
        grid: { vertLines: { color: c.gridV }, horzLines: { color: c.grid } },
        rightPriceScale: {
          borderColor: c.border, borderVisible: true,
          scaleMargins: { top: 0.12, bottom: 0.18 },
          entireTextOnly: true
        },
        timeScale: Object.assign({
          borderColor: c.border, borderVisible: true,
          timeVisible: true, secondsVisible: true
        }, initial ? {
          rightOffset: 7, barSpacing: 7, minBarSpacing: 0.5,
          fixLeftEdge: false, lockVisibleTimeRangeOnResize: true
        } : {}),
        crosshair: {
          mode: 0,
          vertLine: { color: c.crosshair, width: 1, style: 3, labelBackgroundColor: c.crossLabel },
          horzLine: { color: c.crosshair, width: 1, style: 3, labelBackgroundColor: c.crossLabel }
        },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
        localization: { locale: 'en-US', priceFormatter: (p) => this._fmtPrice(p) }
      };
    }

    _fmtPrice(p) {
      const v = Number(p);
      if (!isFinite(v)) return '—';
      const d = v >= 1000 ? 2 : v >= 1 ? 2 : 4;
      return usd(v, d);
    }

    _applySeriesTheme() {
      const th = THEMES[this.theme], c = th.chart;
      if (!this.area) return;
      if (this.mode === 'candle' && this.candles) {
        this.candles.applyOptions({ upColor: th.up, downColor: th.down, borderVisible: false, wickUpColor: th.up, wickDownColor: th.down });
        if (this.volume) this.volume.applyOptions({ color: th.up + '33' });
      } else if (this.area) {
        this.area.applyOptions(Object.assign(this._areaColors(), { lineWidth: c.lineWidth }));
      }
      if (this.tailGlow) this.tailGlow.applyOptions({ color: this.dir > 0 ? th.up : th.down, lineWidth: 7 });
      if (this.tailCore) this.tailCore.applyOptions({ color: this.dir > 0 ? th.up : th.down, lineWidth: 2.5 });
      this._renderPriceLines();
    }

    _areaColors() {
      const th = THEMES[this.theme];
      const up = this.dir >= 0;
      const col = up ? th.up : th.down;
      const a = THEMES[this.theme].chart.areaAlpha;
      return {
        lineColor: col,
        topColor: hexA(col, Math.min(0.55, a * 1.9)),
        bottomColor: hexA(col, 0.008),
        crosshairMarkerBackgroundColor: col,
        priceLineColor: col,
        lastValueColor: col
      };
    }

    /* ----------------------------------------------------------------- boot */
    async _boot() {
      try {
        const LWC = await loadLWC();
        if (this.destroyed) return;
        this.LWC = LWC;
        this.chart = LWC.createChart(this.chartHost, this._chartOptions(THEMES[this.theme].chart, true));
        this._attachSeries();
        this._crosshair();
        await this._loadHistory();
        this._startFeed();
        this._resize();
      } catch (e) {
        this.chartHost.innerHTML = '<div style="padding:24px;color:#8b949e;font-size:12px">Chart engine could not load: ' + String(e.message) + '</div>';
      }
    }

    _attachSeries() {
      const LWC = this.LWC;
      const th = THEMES[this.theme], c = th.chart;
      if (this.mode === 'candle') {
        this.candles = this.chart.addSeries(LWC.CandlestickSeries, {
          upColor: th.up, downColor: th.down, borderVisible: false,
          wickUpColor: th.up, wickDownColor: th.down,
          priceLineColor: th.up, lastValueVisible: true, priceLineVisible: true, priceLineStyle: 2, priceLineWidth: 1
        });
        this.volume = this.chart.addSeries(LWC.HistogramSeries, {
          priceScaleId: '', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false
        });
        this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
        this.area = null;
      } else {
        this.area = this.chart.addSeries(LWC.AreaSeries, Object.assign({
          lineWidth: c.lineWidth, priceLineVisible: true, lastValueVisible: true,
          priceLineStyle: 2, priceLineWidth: 1, crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4, crosshairMarkerBorderWidth: 2,
          crosshairMarkerBorderColor: c.bg
        }, this._areaColors()));
        this.area.priceScale().applyOptions({ scaleMargins: { top: 0.13, bottom: 0.15 } });
        /* tail glow — the "active segment" that flips green/red with the tape */
        this.tailGlow = this.chart.addSeries(LWC.LineSeries, {
          color: this.dir > 0 ? th.up : th.down, lineWidth: 6,
          lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false
        });
        this.tailCore = this.chart.addSeries(LWC.LineSeries, {
          color: this.dir > 0 ? th.up : th.down, lineWidth: 2.5,
          lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false
        });
        this.tailGlow.priceScale().applyOptions({ scaleMargins: { top: 0.13, bottom: 0.15 } });
        this.tailCore.priceScale().applyOptions({ scaleMargins: { top: 0.13, bottom: 0.15 } });
      }
    }

    _teardownSeries() {
      try { this._priceLines.forEach((l) => { try { (this.activeSeries() || {}).removePriceLine?.(l); } catch (e) {} }); } catch (e) {}
      this._priceLines = [];
      ['area', 'tailGlow', 'tailCore', 'candles', 'volume'].forEach((k) => {
        if (this[k]) { try { this.chart.removeSeries(this[k]); } catch (e) {} this[k] = null; }
      });
    }

    activeSeries() { return this.mode === 'candle' ? this.candles : this.area; }

    _resize() {
      if (!this.chart || !this.stage) return;
      const w = this.stage.clientWidth, h = this.stage.clientHeight;
      if (w > 0 && h > 0) this.chart.resize(w, h);
    }

    /* ------------------------------------------------------------- history */
    async _loadHistory() {
      const sym = this.symbol;
      const tf = this.o.timeframe;
      let pts = null;
      if (this.adapter && typeof this.adapter.history === 'function') {
        try { pts = await this.adapter.history(sym, tf); } catch (e) { pts = null; }
      }
      if (!pts || !pts.length) {
        const base = (this._universe().find((u) => u.ticker === sym) || {}).base || 100;
        const step = { '1m': 4, '5m': 10, '15m': 20, '1H': 45, '1D': 300 }[tf] || 10;
        pts = buildHistory(sym, base, step * 720, step);
      }
      if (this.destroyed || this.symbol !== sym) return;
      pts = pts.map((p) => ({ time: Number(p.time), value: Number(p.value) })).filter((p) => isFinite(p.time) && isFinite(p.value));
      /* strictly increasing time */
      const clean = [];
      for (const p of pts) { if (!clean.length || p.time > clean[clean.length - 1].time) clean.push(p); else clean[clean.length - 1] = p; }
      this.points = clean;
      this.sessionOpen = clean[0] ? clean[0].value : 0;
      this._stats = null;
      if (this.adapter && typeof this.adapter.stats === 'function') {
        try { this._stats = await this.adapter.stats(sym); } catch (e) { this._stats = null; }
        if (this.destroyed || this.symbol !== sym) return;
        if (this._stats && this._stats.open > 0) this.sessionOpen = this._stats.open;
      }
      this.lastPrice = clean[clean.length - 1] ? clean[clean.length - 1].value : 0;
      this.prevPrice = this.lastPrice;
      this._setData();
      this._paintPrice();
      this._sync();
    }

    _setData() {
      if (!this.chart) return;
      const pts = this.points;
      if (this.mode === 'candle') {
        const bars = toCandles(pts, this._bucket());
        this.candles.setData(bars);
        if (this.volume) {
          const th = THEMES[this.theme];
          this.volume.setData(bars.map((b) => ({ time: b.time, value: Math.abs(b.close - b.open) * 1200 + 500, color: (b.close >= b.open ? th.up : th.down) + '44' })));
        }
      } else {
        this.area.setData(pts.map((p) => ({ time: p.time, value: p.value })));
        this._setTail();
      }
      if (this._shouldFit) { this.chart.timeScale().fitContent(); this._shouldFit = false; }
      else this.chart.timeScale().scrollToRealTime();
    }

    _setTail(n) {
      if (!this.tailGlow) return;
      const tail = this.points.slice(-(n || 42)).map((p) => ({ time: p.time, value: p.value }));
      this.tailGlow.setData(tail);
      this.tailCore.setData(tail);
    }

    /* ------------------------------------------------------------ live feed */
    _startFeed() {
      if (this.adapter && typeof this.adapter.subscribe === 'function') {
        this._unsub = this.adapter.subscribe(this.symbol, (tick) => this.pushTick(tick));
        return;
      }
      if (!this.sim) return;
      let base = this.lastPrice || 100;
      const drift = () => (Math.random() - 0.5) * base * 0.0009 + (Math.random() - 0.5) * base * 0.00025;
      const tickEvery = 520 + Math.random() * 380;
      const loop = () => {
        if (this.destroyed) return;
        base = Math.max(0.5, base + drift() + Math.sin(Date.now() / 9000) * base * 0.00012);
        this.pushTick({ time: Date.now() / 1000, price: Math.round(base * 100) / 100, volume: Math.round(200 + Math.random() * 3000) });
        this._feedTimer = setTimeout(loop, tickEvery);
      };
      this._feedTimer = setTimeout(loop, 600);
    }

    pushTick(tick) {
      if (this.destroyed || !this.chart) return;
      const price = Number(tick && tick.price);
      if (!(price > 0)) return;
      const sec = Math.max(1, Math.floor(Number(tick.time) || Date.now() / 1000));
      this.prevPrice = this.lastPrice || price;
      this.lastPrice = price;
      const dir = price > this.prevPrice ? 1 : price < this.prevPrice ? -1 : this.dir;
      const flipped = dir !== this.dir;
      this.dir = dir;

      const bucket = this.mode === 'candle' ? this._bucket() : 1;
      const barTime = bucket > 1 ? Math.floor(sec / bucket) * bucket : sec;
      const last = this.points[this.points.length - 1];
      if (this.mode === 'candle') {
        if (!this._barTime) this._barTime = barTime;
        const bt = Math.max(this._barTime, barTime);
        const bar = this._bar || { time: bt, open: price, high: price, low: price, close: price };
        if (bt > bar.time) {
          bar.time = bt; bar.open = price; bar.high = price; bar.low = price; bar.close = price;
        } else {
          bar.high = Math.max(bar.high, price);
          bar.low = Math.min(bar.low, price);
          bar.close = price;
        }
        this._bar = bar; this._barTime = bar.time;
        try { this.candles.update(bar); } catch (e) {}
        if (this.volume) {
          const th = THEMES[this.theme];
          try { this.volume.update({ time: bar.time, value: 900, color: (bar.close >= bar.open ? th.up : th.down) + '44' }); } catch (e) {}
        }
        if (this.points.length && bar.time > this.points[this.points.length - 1].time) this.points.push({ time: bar.time, value: price });
        this._paintPrice();
        this._sync();
        if (flipped) { /* candles colour themselves */ }
        return;
      }
      if (last && sec <= last.time && this.mode !== 'candle') {
        /* same second — update in place, no new bar, no flicker */
        last.value = price;
        this.area.update({ time: last.time, value: price });
        if (this.tailCore) {
          const tail = this.points.slice(-42).map((p) => ({ time: p.time, value: p.value }));
          this.tailGlow.setData(tail); this.tailCore.setData(tail);
        }
      } else {
        this.points.push({ time: sec, value: price });
        if (this.points.length > 4000) this.points.splice(0, this.points.length - 4000);
        this.area.update({ time: sec, value: price });
        this._setTail();
        if (this._follow) { try { this.chart.timeScale().scrollToRealTime(); } catch (e) {} }
      }

      if (flipped) {
        if (this.area) this.area.applyOptions(this._areaColors());
        if (this.candles) { /* candles keep their own up/down colours */ }
        if (this.tailGlow) this.tailGlow.applyOptions({ color: dir > 0 ? THEMES[this.theme].up : THEMES[this.theme].down });
        if (this.tailCore) this.tailCore.applyOptions({ color: dir > 0 ? THEMES[this.theme].up : THEMES[this.theme].down });
      }
      this._paintPrice();
      this._sync();
    }

    /* ------------------------------------------------------------ rendering */
    _paintPrice() {
      const p = this.lastPrice;
      const st = this._stats || null;
      const o = (st && Number(st.open) > 0) ? Number(st.open) : (this.sessionOpen || p);
      const d = p - o, pct = o ? (d / o) * 100 : 0;
      const up = d >= 0;
      const th = THEMES[this.theme];
      const E = this.els;
      E.price.textContent = this._fmtPrice(p);
      E.price.style.color = this.dir > 0 ? th.up : this.dir < 0 ? th.down : 'var(--text)';
      E.chg.className = 'wt-chg ' + (up ? 'up' : 'down');
      E.chg.textContent = (up ? '▲ ' : '▼ ') + usd(Math.abs(d)) + ' (' + (up ? '+' : '−') + Math.abs(pct).toFixed(2) + '%)';
      const tc = up ? th.up : th.down;
      E.chg.style.color = tc;
      if (E.entrypx) E.entrypx.textContent = this._fmtPrice(p);
      if (E.legend) E.legend.textContent = '';
      if (this.position) this._paintPosition();
    }

    _renderPriceLines() {
      const s = this.activeSeries();
      if (!s) return;
      this._priceLines.forEach((l) => { try { s.removePriceLine(l); } catch (e) {} });
      this._priceLines = [];
      const th = THEMES[this.theme];
      const p = this.position;
      if (!p) return;
      const add = (price, color, title, style) => {
        if (!(price > 0)) return;
        try {
          this._priceLines.push(s.createPriceLine({
            price, color, lineWidth: 1, lineStyle: style == null ? 2 : style,
            axisLabelVisible: true, title
          }));
        } catch (e) {}
      };
      add(p.entry, th.accent, 'ENTRY', 2);
      if (p.tp) add(p.tp, th.up, 'TP', 1);
      if (p.sl) add(p.sl, th.down, 'SL', 1);
    }

    _paintPosition() {
      const p = this.position, E = this.els;
      const th = THEMES[this.theme];
      if (!p) {
        E.pos.classList.remove('on'); E.noPos.style.display = '';
        E.hud.classList.remove('on');
        E.postat.textContent = 'flat';
        if (E.sel) E.sel.disabled = true;
        return;
      }
      const px = this.lastPrice || p.entry;
      const diff = p.side === 'long' ? px - p.entry : p.entry - px;
      const pl = diff * p.qty;
      const plPct = p.amountUsd ? (pl / p.amountUsd) * 100 : 0;
      const win = pl >= 0;
      const col = win ? th.up : th.down;
      E.pos.classList.add('on'); E.noPos.style.display = 'none';
      E.postat.textContent = p.side === 'long' ? 'long · open' : 'short · open';
      E.pl.textContent = (win ? '+' : '−') + usd(Math.abs(pl));
      E.pl.style.color = col;
      E.plpct.textContent = (win ? '+' : '−') + Math.abs(plPct).toFixed(2) + '%';
      E.plpct.style.color = col;
      E.pside.textContent = p.side === 'long' ? 'LONG' : 'SHORT';
      E.pside.style.color = p.side === 'long' ? th.up : th.down;
      E.pentry.textContent = this._fmtPrice(p.entry);
      E.psize.textContent = usd(p.amountUsd) + ' · ' + p.qty.toFixed(4) + ' sh';
      E.ptp.textContent = p.tp ? this._fmtPrice(p.tp) : '—';
      E.psl.textContent = p.sl ? this._fmtPrice(p.sl) : '—';
      if (E.sel) E.sel.disabled = false;
      if (E.bt) E.bt.disabled = true;
      if (E.go) E.go.disabled = true;

      /* chart HUD */
      E.hud.classList.add('on');
      E.hud.innerHTML =
        '<span class="side ' + p.side + '">' + (p.side === 'long' ? 'LONG' : 'SHORT') + '</span>' +
        '<span class="kv"><span>Entry</span><b>' + this._fmtPrice(p.entry) + '</b></span>' +
        '<span class="kv"><span>Now</span><b style="color:' + col + '">' + this._fmtPrice(px) + '</b></span>' +
        '<span class="kv pl"><span>Unrealised</span><b style="color:' + col + '">' +
        (win ? '+' : '−') + usd(Math.abs(pl)) + ' · ' + (win ? '+' : '−') + Math.abs(plPct).toFixed(2) + '%</b></span>';
    }

    _sync() {
      const amt = Number(this.els.amount.value) || 0;
      const px = this.lastPrice || 0;
      const th = THEMES[this.theme];
      const side = this._side;
      if (this.els.qty) this.els.qty.textContent = px > 0 ? (amt / px).toFixed(4) + ' sh' : '—';
      if (this.els.fee) this.els.fee.textContent = usd(amt * 0.001);
      if (this.els.bp) this.els.bp.textContent = usd(this.balance);
      if (this.els.bal) this.els.bal.textContent = usd(this.balance);
      const tpPct = Number(this.els.tp.value) || 0;
      const slPct = Number(this.els.sl.value) || 0;
      const tpPx = this.position ? (this.position.tp || 0)
        : (px > 0 && this._tpOn ? px * (1 + (side === 'long' ? 1 : -1) * tpPct / 100) : 0);
      const slPx = this.position ? (this.position.sl || 0)
        : (px > 0 && this._slOn ? px * (1 - (side === 'long' ? 1 : -1) * slPct / 100) : 0);
      if (this.els.tpx) this.els.tpx.textContent = tpPx ? 'at ' + this._fmtPrice(tpPx) : 'target off';
      if (this.els.slx) this.els.slx.textContent = slPx ? 'at ' + this._fmtPrice(slPx) : 'stop off';
      if (this.position) {
        this.root.querySelector('[data-tp="tp"]').classList.toggle('on', !!this.position.tp);
        this.root.querySelector('[data-tp="sl"]').classList.toggle('on', !!this.position.sl);
      }
      if (this.els.go) {
        this.els.go.dataset.side = side;
        this.els.go.textContent = side === 'long' ? 'Buy / Long ' + this.symbol : 'Buy / Short ' + this.symbol;
        this.els.go.disabled = !(amt > 0) || !!this.position;
      }
      if (this.els.bt) { this.els.bt.disabled = !(amt > 0) || !!this.position; }
      if (this.position) this._paintPosition();
      /* keep entry line following the tape for the ticket */
      if (this.position) {
        const needRender = this._lastLines !== this.position.entry + ':' + this.position.tp + ':' + this.position.sl;
        if (needRender) { this._lastLines = this.position.entry + ':' + this.position.tp + ':' + this.position.sl; this._renderPriceLines(); }
      }
    }

    /* --------------------------------------------------------------- orders */
    _setSide(side) {
      this._side = side;
      const seg = this.root.querySelector('.wt-seg');
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-side') === side));
      const tpc = this.root.querySelector('[data-tp="tp"]');
      const slc = this.root.querySelector('[data-tp="sl"]');
      if (tpc) tpc.classList.remove('on');
      if (slc) slc.classList.remove('on');
      if (side === 'short') { this._tpOn = false; this._slOn = false; }
      this._sync();
    }

    async _execute(side) {
      if (this.position) return this._notify('Close the open position first', 'err');
      const amountUsd = Number(this.els.amount.value) || 0;
      if (!(amountUsd > 0)) return this._notify('Enter an amount to trade', 'err');
      if (amountUsd > this.balance) return this._notify('Not enough buying power', 'err');
      const px = this.lastPrice;
      if (!(px > 0)) return this._notify('Waiting for a live price…', 'err');
      const tpPct = Number(this.els.tp.value) || 0, slPct = Number(this.els.sl.value) || 0;
      const tp = this._tpOn && tpPct > 0 ? px * (1 + (side === 'long' ? 1 : -1) * tpPct / 100) : 0;
      const sl = this._slOn && slPct > 0 ? px * (1 - (side === 'long' ? 1 : -1) * slPct / 100) : 0;

      if (this.adapter && typeof this.adapter.buy === 'function') {
        this.els.go.disabled = true;
        try {
          const res = await this.adapter.buy({ side, amountUsd, tpPrice: tp || null, slPrice: sl || null, symbol: this.symbol });
          if (res && res.ok === false) throw new Error(res.error || 'Order rejected');
          const fill = (res && (res.entry || res.price)) || px;
          this._open({ side, amountUsd, entry: fill, qty: amountUsd / fill, tp, sl });
        } catch (e) {
          this._notify(String(e.message || e), 'err');
          this.els.go.disabled = false;
        }
        return;
      }
      this.balance -= amountUsd;
      this._open({ side, amountUsd, entry: px, qty: amountUsd / px, tp, sl });
      this._notify((side === 'long' ? 'Long ' : 'Short ') + this.symbol + ' opened at ' + this._fmtPrice(px), 'ok');
    }

    _open(pos) {
      this.position = Object.assign({ openedAt: Date.now() }, pos);
      this._renderPriceLines();
      this._sync();
      this._paintPosition();
    }

    async _close() {
      const p = this.position;
      if (!p) return this._notify('No open position', 'err');
      const px = this.lastPrice || p.entry;
      const pl = (p.side === 'long' ? px - p.entry : p.entry - px) * p.qty;
      if (this.adapter && typeof this.adapter.sell === 'function') {
        try { await this.adapter.sell({ symbol: this.symbol, position: p }); } catch (e) { this._notify(String(e.message || e), 'err'); return; }
      }
      this.balance += p.amountUsd + pl;
      this.position = null;
      this._renderPriceLines();
      this._sync();
      this._paintPosition();
      this.els.hud.classList.remove('on');
      this._notify('Position closed · ' + (pl >= 0 ? '+' : '−') + usd(Math.abs(pl)), pl >= 0 ? 'ok' : 'err');
    }

    _notify(msg, type) {
      if (typeof this.o.onNotify === 'function') { try { this.o.onNotify(msg, type); return; } catch (e) {} }
      if (typeof window.toast === 'function') { try { window.toast(msg, type); return; } catch (e) {} }
      const n = el('div', '', msg);
      n.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;padding:10px 16px;border-radius:10px;' +
        'font:600 12.5px Inter,sans-serif;color:#fff;background:' + (type === 'err' ? '#c0392b' : '#0f7b62') + ';box-shadow:0 12px 30px rgba(0,0,0,.4)';
      document.body.appendChild(n);
      setTimeout(() => n.remove(), 2400);
    }

    /* ------------------------------------------------------------- controls */
    _zoom(kind) {
      if (!this.chart) return;
      const ts = this.chart.timeScale();
      if (kind === 'fit') { ts.fitContent(); this._follow = true; return; }
      const r = ts.getVisibleLogicalRange();
      if (!r) { ts.fitContent(); return; }
      const mid = (r.from + r.to) / 2;
      const half = (r.to - r.from) / 2 * (kind === 'in' ? 0.72 : 1.38);
      ts.setVisibleLogicalRange({ from: mid - half, to: mid + half });
      this._follow = false;
    }

    async _setTimeframe(tf) {
      this.o.timeframe = tf;
      this.root.querySelectorAll('[data-tf]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-tf') === tf));
      this._shouldFit = true;
      this._renderPriceLines();
      await this._loadHistory();
    }

    _bucket() {
      return { '1m': 60, '5m': 300, '15m': 900, '1H': 3600, '1D': 86400 }[this.o.timeframe] || 300;
    }

    _setMode(mode) {
      if (mode === this.mode) return;
      this._modeUserSet = true;
      this.mode = mode;
      this.root.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-mode') === mode));
      this._teardownSeries();
      this._bar = null; this._barTime = 0;
      this._attachSeries();
      this._setData();
      try { this.chart.timeScale().fitContent(); } catch (e) {}
      this._renderPriceLines();
      this._paintPrice();
    }

    async setSymbol(ticker) {
      const sym = String(ticker || '').toUpperCase();
      if (!sym || sym === this.symbol) return;
      if (this.position && this.position.symbol !== sym && !this.o.keepPositionOnSwitch) {
        /* keep the position, just hide its lines for other symbols */
      }
      if (typeof this._unsub === 'function') { try { this._unsub(); } catch (e) {} this._unsub = null; }
      this.symbol = sym;
      const uni = this._universe();
      const meta = uni.find((u) => u.ticker === sym) || { ticker: sym, name: sym };
      this.els.sym.textContent = sym;
      this.els.name.textContent = meta.name || sym;
      const logo = this.root.querySelector('.wt-logo');
      if (logo) logo.textContent = sym.slice(0, 2);
      if (this.els.go) this.els.go.textContent = (this._side === 'long' ? 'Buy / Long ' : 'Buy / Short ') + sym;
      if (this.els.noPos) this.els.noPos.textContent = 'No open position on ' + sym + '. Entry, TP and SL lines appear on the chart once you trade.';
      if (this.position) { this.position = null; this._paintPosition(); }
      this._shouldFit = true;
      this.points = [];
      await this._loadHistory();
      this._startFeed();
      this._renderPriceLines();
    }

    /* ---------------------------------------------------------------- misc */
    setBalance(v) { this.balance = Number(v) || 0; this._sync(); }
    setPosition(p) {
      this.position = p ? Object.assign({}, p) : null;
      this._renderPriceLines(); this._sync(); this._paintPosition();
    }
    setSymbols(list) {
      this.o.symbols = list;
      const sel = this.$('select');
      if (!sel) return;
      const uni = this._universe();
      sel.innerHTML = uni.map((u) => `<option value="${u.ticker}" ${u.ticker === this.symbol ? 'selected' : ''}>${u.ticker} — ${u.name}</option>`).join('');
    }
    destroy() {
      this.destroyed = true;
      clearTimeout(this._feedTimer);
      if (typeof this._unsub === 'function') { try { this._unsub(); } catch (e) {} }
      try { this._ro.disconnect(); } catch (e) {}
      try { if (this.chart) this.chart.remove(); } catch (e) {}
      this.chart = null;
      const i = T.instances.indexOf(this);
      if (i >= 0) T.instances.splice(i, 1);
    }

    /* crosshair tooltip + legend */
    _crosshair() {
      const tip = this.els.tip;
      this.chart.subscribeCrosshairMove((param) => {
        if (!param || !param.point || !param.time || param.point.x < 0 || param.point.y < 0 ||
            param.point.x > this.stage.clientWidth || param.point.y > this.stage.clientHeight) {
          tip.classList.remove('on');
          return;
        }
        const s = this.activeSeries();
        const bar = param.seriesData && param.seriesData.get(s);
        const price = bar ? (bar.close != null ? bar.close : bar.value) : null;
        if (price == null) { tip.classList.remove('on'); return; }
        const sec = typeof param.time === 'number' ? param.time : Math.floor(Date.parse(param.time) / 1000);
        const ref = this.sessionOpen || price;
        const d = price - ref, pct = ref ? (d / ref) * 100 : 0;
        const col = d >= 0 ? THEMES[this.theme].up : THEMES[this.theme].down;
        tip.innerHTML = '<div class="t">' + new Date(sec * 1000).toLocaleDateString('en-US') + ' ' + hhmmss(sec) + '</div>' +
          '<div class="p">' + this._fmtPrice(price) + '</div>' +
          '<div class="d" style="color:' + col + '">' + (d >= 0 ? '+' : '−') + usd(Math.abs(d)) + ' (' + (d >= 0 ? '+' : '−') + Math.abs(pct).toFixed(2) + '%)</div>';
        const w = tip.offsetWidth || 130, h = tip.offsetHeight || 66;
        const x = clamp(param.point.x + 16, 8, this.stage.clientWidth - w - 8);
        const y = clamp(param.point.y - h - 12, 8, this.stage.clientHeight - h - 26);
        tip.style.left = x + 'px'; tip.style.top = y + 'px';
        tip.classList.add('on');
        if (this.els.legend) this.els.legend.textContent = hhmm(sec) + ' · ' + this._fmtPrice(price);
      });
    }
  }

  /* ---------------------------------------------------------------- helpers */
  function hexA(hex, a) {
    const h = String(hex).replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function toCandles(points, bucketSec) {
    const b = Math.max(1, bucketSec || 60);
    const out = [];
    let cur = null;
    for (const p of points) {
      const t = Math.floor(p.time / b) * b;
      if (!cur || cur.time !== t) {
        cur = { time: t, open: p.value, high: p.value, low: p.value, close: p.value };
        out.push(cur);
      } else {
        cur.high = Math.max(cur.high, p.value);
        cur.low = Math.min(cur.low, p.value);
        cur.close = p.value;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------- API */
  const T = window.WC_TERMINAL = {
    __v: 3,
    version: VERSION,
    lwcVersion: LWC_VERSION,
    themes: THEME_ORDER,
    themeMeta: THEMES,
    Terminal: Terminal,
    instances: [],
    mount(host, opts) {
      if (!host) throw new Error('WC_TERMINAL.mount needs a host element');
      const inst = new Terminal(host, opts);
      T.instances.push(inst);
      return inst;
    },
    get style() { try { return localStorage.getItem(STYLE_KEY) || 'obsidian'; } catch (e) { return 'obsidian'; } },
    setStyle(name) {
      if (!THEMES[name]) return;
      try { localStorage.setItem(STYLE_KEY, name); } catch (e) {}
      T.instances.forEach((i) => i.setTheme(name));
    },
    destroyAll() { T.instances.slice().forEach((i) => i.destroy()); }
  };
})();

#!/usr/bin/env python3
"""Worker side of the Servers & API admin space (3.63.0)."""
import os, sys

P = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'cloudflare', 'whalechat-api', 'src', 'index.js')
s = open(P, encoding='utf8').read()
edits = []

# ---------------------------------------------------------------- routes
edits.append((
'''    if (path === "/api/connections")
      return json({ ok: false, error: "connections_disabled" }, 200);''',
'''    if (path === "/api/connections")
      return await this.handleConnections(request, url, body);
    if (path === "/api/connections/test" && request.method === "POST")
      return await this.handleConnectionTest(request, url, body);'''))

# ---------------------------------------------------------------- handlers
HANDLERS = '''  /* ================================================================== *
   * Servers & API — admin panel connection space
   *
   * The admin can connect, from the panel itself:
   *   · one or more WhaleChat app servers (sync servers) — each one is
   *     probed on /api/health before it is accepted, and the first one is
   *     marked primary so the app advertises it as the sync endpoint
   *   · the Brevo email server (API key + verified sender) — used by the
   *     verification codes, test emails and broadcasts
   *
   * Settings live in D1 (app_state → settings.connections), NOT in the
   * synced app database, so a client state re-merge, a redeploy or a new
   * browser can never wipe them.
   * ================================================================== */
  async loadConnections() {
    if (this.connectionsCache) return this.connectionsCache;
    let v = {};
    if (this.env && this.env.DB) {
      try {
        const row = await this.env.DB.prepare("SELECT v FROM app_state WHERE k = ?").bind("settings.connections").first();
        if (row && row.v) v = JSON.parse(row.v) || {};
      } catch (e) {
      }
    }
    if (!v.app) v.app = {};
    if (!Array.isArray(v.app.servers)) v.app.servers = [];
    if (!v.brevo) v.brevo = {};
    this.connectionsCache = v;
    return v;
  }
  async saveConnections(v) {
    v.updatedAt = Date.now();
    this.connectionsCache = v;
    if (this.env && this.env.DB) {
      try {
        await this.env.DB.prepare("INSERT INTO app_state (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind("settings.connections", JSON.stringify(v)).run();
      } catch (e) {
        console.error("[connections] save failed: " + (e && e.message));
      }
    }
    return v;
  }
  /* the key the email engine should actually use: the one the admin saved in
     the panel wins, the Worker secret is the fallback before anything is set */
  effectiveBrevoKey() {
    try {
      const c = this.connectionsCache || {};
      const stored = c.brevo && c.brevo.apiKey ? String(c.brevo.apiKey) : "";
      if (stored) return stored;
    } catch (e) {
    }
    return String((this.env && this.env.BREVO_API_KEY) || "");
  }
  effectiveBrevoSender() {
    let from = "", name = "";
    try {
      const c = this.connectionsCache || {};
      from = (c.brevo && c.brevo.from) || "";
      name = (c.brevo && c.brevo.name) || "";
    } catch (e) {
    }
    const s = brevoSender(this.env || {});
    return { email: from || s.email, name: name || s.name };
  }
  maskKey(k) {
    const v = String(k || "");
    if (!v) return "";
    if (v.length <= 10) return v.slice(0, 2) + "••••";
    return v.slice(0, 7) + "••••••" + v.slice(-4);
  }
  async adminOf(request, b) {
    const row = await this.authUser(request);
    if (row) {
      let u = row;
      try {
        if (row.data) u = Object.assign({}, row, JSON.parse(row.data) || {});
      } catch (e) {
      }
      if (u && u.role === "admin") return u;
    }
    const adminId = String((b && b.adminId) || "");
    if (!adminId) return null;
    return (this.db && this.db.users ? this.db.users : []).find((u) => u && u.id === adminId && u.role === "admin") || null;
  }
  async probeServer(rawUrl) {
    const started = Date.now();
    let target = String(rawUrl || "").trim();
    if (!target) return { ok: false, error: "url_required" };
    if (!/^https?:\\/\\//i.test(target)) target = "https://" + target;
    target = target.replace(/\\/+$/, "");
    if (!/^https?:\\/\\/[^\\s]+$/i.test(target)) return { ok: false, error: "invalid_url" };
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 7000) : null;
    try {
      const res = await fetch(target + "/api/health", { method: "GET", headers: { accept: "application/json" }, signal: ctl ? ctl.signal : undefined });
      const latencyMs = Date.now() - started;
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
      }
      if (timer) clearTimeout(timer);
      if (!res.ok) return { ok: false, url: target, status: res.status, latencyMs, error: "health_http_" + res.status };
      const looksWhalechat = !!(data && (data.app === "whalechat" || data.ok === true || data.version));
      return {
        ok: looksWhalechat,
        url: target,
        status: res.status,
        latencyMs,
        version: (data && (data.version || data.app)) || "",
        rev: (data && Number(data.rev)) || 0,
        users: (data && Number(data.users)) || 0,
        storage: (data && data.storage) || "",
        error: looksWhalechat ? "" : "not_a_whalechat_server"
      };
    } catch (e) {
      if (timer) clearTimeout(timer);
      return { ok: false, url: target, latencyMs: Date.now() - started, error: String((e && e.message) || e).slice(0, 160) };
    }
  }
  async brevoVerify(key) {
    if (!key) return { ok: false, error: "key_required" };
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 8000) : null;
    try {
      const res = await fetch("https://api.brevo.com/v3/account", { method: "GET", headers: { "api-key": key, accept: "application/json" }, signal: ctl ? ctl.signal : undefined });
      if (timer) clearTimeout(timer);
      let d = null;
      try {
        d = await res.json();
      } catch (e) {
      }
      if (res.status === 401 || res.status === 403)
        return { ok: false, status: res.status, error: "key_rejected" };
      if (!res.ok)
        return { ok: false, status: res.status, error: "brevo_" + res.status };
      const senders = [];
      try {
        const sr = await fetch("https://api.brevo.com/v3/senders", { headers: { "api-key": key, accept: "application/json" } });
        const sd = await sr.json();
        (sd && sd.senders ? sd.senders : []).forEach((x) => { if (x && x.email) senders.push(String(x.email)); });
      } catch (e) {
      }
      return { ok: true, status: res.status, company: (d && d.companyName) || "", plan: (d && d.plan && (d.plan.type || "")) || "", senders };
    } catch (e) {
      if (timer) clearTimeout(timer);
      return { ok: false, error: String((e && e.message) || e).slice(0, 160) };
    }
  }
  async connectionsStatus(url) {
    const c = await this.loadConnections();
    const key = this.effectiveBrevoKey();
    const sender = this.effectiveBrevoSender();
    const self = (() => { try { return new URL(url).origin; } catch (e) { return ""; } })();
    const servers = (c.app.servers || []).map((x) => ({
      id: x.id, label: x.label || x.url, url: x.url, primary: !!x.primary,
      addedAt: x.addedAt || 0, checkedAt: x.checkedAt || 0, connected: !!x.connected,
      rev: x.rev || 0, version: x.version || "", latencyMs: x.latencyMs || 0, error: x.error || "",
      isSelf: x.url === self
    }));
    return {
      ok: true,
      app: {
        servers,
        selfUrl: self,
        primaryUrl: (servers.filter((x) => x.primary)[0] || {}).url || "",
        publicUrl: c.app.publicUrl || "",
        connected: servers.some((x) => x.connected)
      },
      brevo: {
        configured: !!key,
        source: (c.brevo && c.brevo.apiKey) ? "admin panel" : (this.env && this.env.BREVO_API_KEY ? "worker secret" : "none"),
        key: this.maskKey(key),
        from: sender.email,
        name: sender.name,
        verifiedAt: (c.brevo && c.brevo.verifiedAt) || 0,
        senders: (c.brevo && c.brevo.senders) || [],
        lastTest: (c.brevo && c.brevo.lastTest) || null
      },
      smtp: { configured: false, note: "Brevo HTTPS API only — no SMTP socket to disconnect" },
      storage: {
        backend: this.env && this.env.DB ? "cloudflare-d1" : "durable-object",
        table: "app_state · settings.connections",
        updatedAt: c.updatedAt || 0
      }
    };
  }
  async handleConnections(request, url, bodyFn) {
    const b = request.method === "POST" ? await bodyFn() : {};
    const admin = await this.adminOf(request, b);
    if (!admin)
      return json({ ok: false, error: "admin_only" }, 403);
    await this.loadConnections();
    if (request.method !== "POST")
      return json(await this.connectionsStatus(url));
    const c = await this.loadConnections();
    const applied = [];

    /* ---- app server ------------------------------------------------- */
    if (b.app && typeof b.app === "object") {
      const a = b.app;
      if (a.remove) {
        c.app.servers = (c.app.servers || []).filter((x) => x.id !== String(a.remove));
        if (!c.app.servers.some((x) => x.primary) && c.app.servers.length) c.app.servers[0].primary = true;
        applied.push("app-server-removed");
      } else if (a.url) {
        const probe = await this.probeServer(a.url);
        if (!probe.ok)
          return json({ ok: false, error: probe.error || "server_unreachable", probe, status: await this.connectionsStatus(url) }, 200);
        const norm = probe.url;
        let rec = (c.app.servers || []).filter((x) => x.url === norm)[0];
        if (!rec) {
          rec = { id: "srv_" + Math.random().toString(36).slice(2, 9), url: norm, addedAt: Date.now() };
          c.app.servers.unshift(rec);
        }
        rec.label = String(a.label || rec.label || norm).slice(0, 60);
        rec.connected = true;
        rec.rev = probe.rev || 0;
        rec.version = probe.version || "";
        rec.latencyMs = probe.latencyMs || 0;
        rec.checkedAt = Date.now();
        rec.error = "";
        if (a.primary === true || !c.app.servers.some((x) => x.primary)) {
          c.app.servers.forEach((x) => { x.primary = false; });
          rec.primary = true;
        }
        applied.push("app-server");
      } else if (a.primary) {
        c.app.servers.forEach((x) => { x.primary = x.id === String(a.primary); });
        applied.push("app-server-primary");
      }
      if (typeof a.publicUrl === "string") c.app.publicUrl = a.publicUrl.trim().slice(0, 300);
    }

    /* ---- brevo email server ---------------------------------------- */
    if (b.brevo && typeof b.brevo === "object") {
      const e = b.brevo;
      if (e.disconnect) {
        c.brevo = { apiKey: "", from: c.brevo.from || "", name: c.brevo.name || "", updatedAt: Date.now() };
        applied.push("brevo-disconnected");
      } else if (e.apiKey || e.from) {
        const key = String(e.apiKey || e.brevo || "").trim();
        if (key) {
          const check = await this.brevoVerify(key);
          if (!check.ok)
            return json({ ok: false, error: check.error === "key_rejected" ? "brevo_key_rejected" : (check.error || "brevo_check_failed"), probe: check, status: await this.connectionsStatus(url) }, 200);
          c.brevo.apiKey = key;
          c.brevo.verifiedAt = Date.now();
          c.brevo.company = check.company || "";
          c.brevo.senders = check.senders || [];
          applied.push("brevo");
        }
        if (typeof e.from === "string" && e.from.trim()) c.brevo.from = e.from.trim().slice(0, 160);
        if (typeof e.name === "string" && e.name.trim()) c.brevo.name = e.name.trim().slice(0, 60);
      }
    }

    await this.saveConnections(c);
    return json({ ok: true, applied, status: await this.connectionsStatus(url) });
  }
  async handleConnectionTest(request, url, bodyFn) {
    const b = await bodyFn();
    const admin = await this.adminOf(request, b);
    if (!admin)
      return json({ ok: false, error: "admin_only" }, 403);
    const c = await this.loadConnections();
    const which = String(b.which || "all");
    const results = {};

    if (which === "app" || which === "all") {
      const list = b.serverId ? (c.app.servers || []).filter((x) => x.id === String(b.serverId)) : (c.app.servers || []);
      const probes = [];
      for (const srv of list) {
        const probe = await this.probeServer(srv.url);
        srv.connected = !!probe.ok;
        srv.rev = probe.rev || srv.rev || 0;
        srv.version = probe.version || srv.version || "";
        srv.latencyMs = probe.latencyMs || 0;
        srv.checkedAt = Date.now();
        srv.error = probe.error || "";
        probes.push({ id: srv.id, url: srv.url, ok: !!probe.ok, latencyMs: probe.latencyMs || 0, error: probe.error || "", version: probe.version || "" });
      }
      if (!list.length) {
        const probe = await this.probeServer(url ? new URL(url).origin : "");
        probes.push({ id: "self", url: probe.url || "", ok: !!probe.ok, latencyMs: probe.latencyMs || 0, error: probe.error || "" });
      }
      await this.saveConnections(c);
      results.app = { ok: probes.some((p) => p.ok), servers: probes };
    }

    if (which === "brevo" || which === "all" || which === "app" && false) {
      const key = this.effectiveBrevoKey();
      const check = await this.brevoVerify(key);
      const out = { configured: !!key, ok: !!check.ok, error: check.error || "", senders: check.senders || [] };
      const to = String(b.to || (admin && admin.email) || "").trim();
      if (check.ok && to) {
        try {
          const sender = this.effectiveBrevoSender();
          const res = await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              sender,
              to: [{ email: to, name: "WhaleChat test" }],
              subject: "WhaleChat email server connected",
              htmlContent: "<div style=\\"font-family:system-ui,Arial,sans-serif\\"><h2 style=\\"color:#0f766e\\">Email server connected ✓</h2><p>This test was sent from Admin → Servers &amp; API. Verification codes and account emails will now send through <b>" + String(sender.email) + "</b>.</p></div>",
              textContent: "WhaleChat email server connected. Test sent to " + to
            })
          });
          out.sent = !!res.ok;
          if (!res.ok) out.sendError = "Brevo " + res.status + ": " + String(await res.text()).slice(0, 160);
          out.to = to;
        } catch (e) {
          out.sent = false;
          out.sendError = String((e && e.message) || e);
        }
      }
      c.brevo.lastTest = { ok: !!(check.ok && (out.sent || !to)), at: Date.now(), to, error: out.error || out.sendError || "" };
      await this.saveConnections(c);
      results.brevo = out;
      results.email = out;
    }

    return json({ ok: true, which, results, status: await this.connectionsStatus(url) });
  }
'''
edits.append(('  async authUser(request) {', HANDLERS + '  async authUser(request) {'))

# ---------------------------------------------------------------- health
edits.append((
'''      const brevoConfigured = !!(this.env && this.env.BREVO_API_KEY);''',
'''      let conns = {};
      try {
        conns = await this.loadConnections();
      } catch (e) {
      }
      const brevoConfigured = !!this.effectiveBrevoKey();'''))

edits.append((
'''publicUrl: null, storage: this.env.DB ? "d1+durable-object" : "durable-object", d1: this.env.DB ? "whalechat_db" : "unbound", email: brevoConfigured, emailProvider: brevoConfigured ? "brevo" : "none", brevoConfigured,''',
'''publicUrl: (conns.app && conns.app.publicUrl) || null, appServers: ((conns.app && conns.app.servers) || []).length, storage: this.env.DB ? "d1+durable-object" : "durable-object", d1: this.env.DB ? "whalechat_db" : "unbound", email: brevoConfigured, emailProvider: brevoConfigured ? "brevo" : "none", brevoConfigured,'''))

# ---------------------------------------------------------------- email status (DO)
edits.append((
'''    if (path === "/api/email/status") {
      const configured = !!(this.env && this.env.BREVO_API_KEY);
      return json({ ok: true, configured, provider: configured ? "brevo" : "none", from: brevoSender(this.env || {}).email, host: "api.brevo.com", port: 443, queued: 0, sent: 0, lastError: "" });
    }''',
'''    if (path === "/api/email/status") {
      try {
        await this.loadConnections();
      } catch (e) {
      }
      const configured = !!this.effectiveBrevoKey();
      return json({ ok: true, configured, provider: configured ? "brevo" : "none", from: this.effectiveBrevoSender().email, host: "api.brevo.com", port: 443, queued: 0, sent: 0, lastError: "" });
    }'''))

# ---------------------------------------------------------------- email status (legacy route)
edits.append((
'''    if (path === "/api/email/status" && request.method === "GET") {
      return json({ ok: true, configured: !!this.env.BREVO_API_KEY, provider: "brevo", from: this.env.MAIL_FROM || "support@whalechat.app" });
    }''',
'''    if (path === "/api/email/status" && request.method === "GET") {
      try {
        await this.loadConnections();
      } catch (e) {
      }
      const sender = this.effectiveBrevoSender();
      return json({ ok: true, configured: !!this.effectiveBrevoKey(), provider: "brevo", from: sender.email });
    }'''))

# ---------------------------------------------------------------- broadcast / test
edits.append((
'''    if ((path === "/api/email/broadcast" || path === "/api/email/test") && request.method === "POST") {
      if (!this.env.BREVO_API_KEY)
        return json({ ok: false, error: "email_not_configured", message: "Add BREVO_API_KEY to the Worker" }, 503);''',
'''    if ((path === "/api/email/broadcast" || path === "/api/email/test") && request.method === "POST") {
      try {
        await this.loadConnections();
      } catch (e) {
      }
      const brevoKey = this.effectiveBrevoKey();
      if (!brevoKey)
        return json({ ok: false, error: "email_not_configured", message: "Connect the email server in Admin → Servers & API" }, 503);'''))

edits.append((
'''      const sender = { email: this.env.MAIL_FROM || "support@whalechat.app", name: this.env.MAIL_FROM_NAME || "WhaleChat" };
      let sent = 0;''',
'''      const sender = this.effectiveBrevoSender();
      let sent = 0;'''))

edits.append((
'''            headers: { "api-key": this.env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ sender, to: [{ email: sender.email, name: sender.name }], bcc: chunk, subject, htmlContent: html })''',
'''            headers: { "api-key": brevoKey, "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ sender, to: [{ email: sender.email, name: sender.name }], bcc: chunk, subject, htmlContent: html })'''))

ok = True
for old, new in edits:
    n = s.count(old)
    if n != 1:
        print('FAIL (%d): %r' % (n, old[:70]))
        ok = False
        continue
    s = s.replace(old, new)
    print('ok: %r' % old[:60])

if ok:
    open(P, 'w', encoding='utf8').write(s)
    print('worker patched')
else:
    print('ABORTED — nothing written')
    sys.exit(1)

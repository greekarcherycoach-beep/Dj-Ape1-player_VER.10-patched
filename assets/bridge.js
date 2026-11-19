/* Dj Ape1 – native bridge (injected before the page scripts).
   Emulates the `window.desktop` API the UI expects. __TOKEN__ is replaced by Rust at start-up. */
(() => {
  if (window.top !== window.self || window.desktop) return;
  const TOKEN = "__TOKEN__";
  const post = (m) => window.ipc.postMessage(JSON.stringify(m));

  /* ---- request/response over wry IPC (window-level operations) ---- */
  let seq = 0;
  const pending = new Map();
  const call = (m, a) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      post({ id, m, a: a === undefined ? null : a });
    });

  /* ---- request/response over the local HTTP server (data operations) ---- */
  const rpc = async (m, a) => {
    const r = await fetch(`/rpc/${TOKEN}/${m}`, {
      method: "POST",
      body: JSON.stringify(a === undefined ? null : a),
    });
    if (!r.ok) throw new Error((await r.text()) || "rpc " + r.status);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
  const b64ToU8 = (s) => {
    const b = atob(s), u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  };

  /* ---- events pushed from Rust ---- */
  const subs = { fullscreen: [], cmd: [], open: [], flush: [], changed: [] };
  const on = (k) => (cb) => { subs[k].push(cb); };
  let startPaths = null;
  window.__dj = {
    res(id, ok, v) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok && v && v.__ref !== undefined) { rpc("takeResult", v.__ref).then(p.res, p.rej); return; }
      ok ? p.res(v) : p.rej(new Error(String(v)));
    },
    emit(k, v) {
      if (k === "flush" && !subs.flush.length) { post({ id: 0, m: "flushDone", a: null }); return; }
      for (const f of subs[k] || []) { try { f(v); } catch (e) { console.error(e); } }
    },
    /* files/folders dropped on the window (Rust has the real paths) */
    async drop(paths, x, y) {
      try {
        const ev = { clientX: x, clientY: y, target: document.elementFromPoint(x, y) };
        const toPlayer = typeof isPlayerDrop === "function" ? !!isPlayerDrop(ev) : false;
        const dz = document.getElementById("dz");
        if (dz) dz.classList.add("hide");
        await openPaths(paths, toPlayer);
      } catch (e) { console.error(e); }
    },
  };

  /* ---- <input type=file> → native dialogs (a webview gives no real paths) ---- */
  const origClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type !== "file") return origClick.call(this);
    const inp = this, accept = inp.accept || "";
    (async () => {
      const list = await call("pickInput", {
        dir: inp.hasAttribute("webkitdirectory"),
        multi: !!inp.multiple,
        json: /json/i.test(accept),
      });
      if (!list || !list.length) return;
      const files = [];
      for (const e of list) {
        let f;
        if (/json/i.test(accept)) {
          const b = await (await fetch(`/f/${TOKEN}/${encodeURIComponent(e.path)}`)).blob();
          f = new File([b], e.name);
        } else {
          f = new File([], e.name);
          Object.defineProperty(f, "size", { value: e.size });
        }
        Object.defineProperty(f, "lastModified", { value: e.mtime });
        Object.defineProperty(f, "__path", { value: e.path });
        if (e.rel) Object.defineProperty(f, "webkitRelativePath", { value: e.rel });
        files.push(f);
      }
      Object.defineProperty(inp, "files", { value: files, configurable: true });
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    })().catch((e) => console.error(e));
  };

  window.desktop = {
    native: {
      pickFolder: () => call("pickFolder"),
      pathFor: (f) => (f && f.__path) || "",
      stat: (p) => rpc("stat", p),
      readdir: (p) => rpc("readdir", p),
      readTags: async (p) => {
        const t = await rpc("readTags", p);
        if (t && t.picture && t.picture.b64) {
          t.picture.data = b64ToU8(t.picture.b64);
          delete t.picture.b64;
        }
        return t;
      },
      libInfo: () => rpc("libInfo"),
      libLoad: async () => {
        const r = await fetch(`/lib/${TOKEN}`);
        if (r.status === 204) return null;
        if (!r.ok) throw new Error(await r.text());
        return { json: await r.text(), from: r.headers.get("X-From") || "" };
      },
      libSave: async (json) => {
        const r = await fetch(`/lib/${TOKEN}`, { method: "PUT", body: json });
        if (!r.ok) throw new Error((await r.text()) || "save " + r.status);
      },
      libBackups: () => rpc("libBackups"),
      libBackup: async (name) => {
        const r = await fetch(`/libbk/${TOKEN}/${encodeURIComponent(name)}`);
        if (!r.ok) throw new Error(await r.text());
        return r.text();
      },
      libBackupNow: () => rpc("libBackupNow"),
      openLibDir: () => rpc("openLibDir"),
      showItem: (p) => rpc("showItem", p),
      watch: (paths) => rpc("watch", paths),
      onChanged: on("changed"),
      fileOpen: (dir, name) => rpc("fileOpen", { dir, name }),
      fileWrite: async (id, data, pos) => {
        const q = pos === null || pos === undefined ? "" : `?pos=${pos}`;
        const r = await fetch(`/w/${TOKEN}/${id}${q}`, { method: "PUT", body: data });
        if (!r.ok) throw new Error((await r.text()) || "write " + r.status);
      },
      fileClose: (id) => rpc("fileClose", id),
    },
    prefs: { get: () => rpc("prefsGet"), set: (p) => rpc("prefsSet", p) },
    toggleFullscreen: () => post({ id: 0, m: "toggleFullscreen", a: null }),
    openLog: () => rpc("openLog"),
    getCrash: () => rpc("getCrash"),
    diag: (name, data) => { rpc("diag", { name, data }).catch(() => {}); },
    onFullscreen: on("fullscreen"),
    onCmd: on("cmd"),
    onOpen: on("open"),
    onFlush: on("flush"),
    flushDone: () => post({ id: 0, m: "flushDone", a: null }),
    state: (s) => post({ id: 0, m: "state", a: s }),
    restart: () => post({ id: 0, m: "restart", a: null }),
    getOpen: async () => { const p = await rpc("getOpen"); return p || []; },
  };

  /* ---- audio settings panel: output devices + WASAPI exclusive ----
     enumerateDevices() hides device ids/labels until a media permission exists; the host starts WebView2
     with auto-accept flags, so one getUserMedia call unlocks the full list of outputs. */
  const isWin = () => /Windows/i.test(navigator.userAgent);
  const unlock = () => {
    try {
      return navigator.mediaDevices.getUserMedia({ audio: true })
        .then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
    } catch (e) { return Promise.resolve(); }
  };
  const refreshDevs = async () => {
    await unlock();
    if (typeof fillDevs === "function") { try { await fillDevs(false); } catch (e) {} }
  };
  const enhance = () => {
    const dev = document.getElementById("a_dev");
    if (dev && !dev.dataset.dj) {
      dev.dataset.dj = "1";
      refreshDevs();
      const pick = document.getElementById("a_pick");
      if (pick) {
        // Chromium has no selectAudioOutput(): "choose device" = refresh the list
        pick.addEventListener("click", (e) => {
          e.stopImmediatePropagation(); e.preventDefault();
          refreshDevs().then(() => { if (typeof toast === "function") toast("Διάλεξε τη συσκευή από τη λίστα «Έξοδος»"); });
        }, true);
      }
      const ref = document.getElementById("a_ref");
      if (ref) ref.addEventListener("click", (e) => { e.stopImmediatePropagation(); refreshDevs(); }, true);
    }
    const hifi = document.getElementById("a_hifi");
    if (isWin() && hifi && !document.getElementById("a_wasapi")) {
      const lab = hifi.closest("label");
      if (!lab) return;
      const anchor = lab.nextElementSibling || lab;
      const box = document.createElement("div");
      box.innerHTML =
        '<hr><label class="row" style="cursor:pointer"><input type="checkbox" id="a_wasapi"><span>⚡ Αποκλειστική λειτουργία WASAPI (πειραματικό)</span></label>' +
        '<div class="mu" style="font-size:12px;padding:0 10px 8px;max-width:300px;white-space:normal">Η συσκευή εξόδου χρησιμοποιείται αποκλειστικά από την εφαρμογή (οι άλλες εφαρμογές δεν θα έχουν ήχο) και μπορεί να μην υποστηρίζεται από όλες τις κάρτες ήχου. Ισχύει μετά από επανεκκίνηση.</div>';
      anchor.after(...Array.from(box.childNodes));
      const cb = document.getElementById("a_wasapi");
      window.desktop.prefs.get().then((p) => { cb.checked = !!p.wasapiExclusive; }).catch(() => {});
      cb.onchange = async () => {
        try { await window.desktop.prefs.set({ wasapiExclusive: cb.checked }); } catch (e) { return; }
        if (confirm("Η αλλαγή ισχύει μετά από επανεκκίνηση. Επανεκκίνηση τώρα;")) window.desktop.restart();
      };
    }
  };
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; try { enhance(); } catch (e) { console.error(e); } });
  };
  const startObs = () => new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) startObs();
  else document.addEventListener("DOMContentLoaded", startObs);
})();

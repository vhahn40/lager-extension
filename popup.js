document.addEventListener("DOMContentLoaded", () => {
  const resultsEl = document.getElementById("results");
  const statusEl = document.getElementById("status");
  const logoutEl = document.getElementById("logout");

  // ---- Konfiguration ----
  const DEFAULT_API_BASE = "https://lager-9ree.onrender.com";
  let API_BASE = DEFAULT_API_BASE;

  const storageGet = (area, key) =>
    new Promise(resolve => chrome.storage[area].get(key, v => resolve(v || {})));
  const storageSet = (area, obj) =>
    new Promise(resolve => chrome.storage[area].set(obj, () => resolve()));

  async function initApiBase() {
    // optionaler Override (z. B. lokal: http://localhost:8000)
    const { apiBase } = await storageGet("sync", "apiBase");
    if (apiBase && typeof apiBase === "string") API_BASE = apiBase.replace(/\/+$/, "");
    // Anzeige für Debug/Vertrauen
    if (statusEl) statusEl.textContent = `API: ${API_BASE}`;
  }

  // Initialisierung: API-Basis setzen, Login-Status prüfen und Warenkorb anfragen
  (async function init() {
    try {
      await initApiBase();
      await restoreLogin();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "REQUEST_CART" });
    } catch (e) {
      console.warn("REQUEST_CART nicht möglich (evtl. kein Content-Script auf dieser Seite):", e);
    }
  })();

  document.getElementById("loginBtn").addEventListener("click", onLogin);
  logoutEl?.addEventListener("click", onLogout);

  async function onLogin() {
    const email = document.getElementById("email").value;
    const password = document.getElementById("password").value;
    try {
      const res = await fetch(`${API_BASE}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, passwort: password })
      });
      if (!res.ok) {
        statusEl && (statusEl.textContent = "❌ Login fehlgeschlagen");
        return;
      }
      const data = await res.json();
      await storageSet("local", { token: data.access_token });
      statusEl && (statusEl.textContent = "✅ Angemeldet");
      logoutEl?.classList.remove("hidden");
    } catch (e) {
      console.error(e);
      statusEl && (statusEl.textContent = "❌ Netzwerkfehler");
    }
  }

  async function onLogout(e) {
    e.preventDefault();
    await chrome.storage.local.remove("token");
    logoutEl?.classList.add("hidden");
    statusEl && (statusEl.textContent = "Abgemeldet");
  }

  async function restoreLogin() {
    const { token } = await storageGet("local", "token");
    if (token) {
      statusEl && (statusEl.textContent = "✅ Angemeldet");
      logoutEl?.classList.remove("hidden");
    }
  }

  // Nachrichten vom Content-Script: sofort Lagerabgleich starten
  chrome.runtime.onMessage.addListener(async (msg) => {
    if (msg?.type === "CART_EXTRACTED") {
      try {
        await checkBulk({ artikelnummern: msg.artikelnummern || [], namen: msg.namen || [] });
      } catch (e) {
        console.error("Bulk-Check Fehler:", e);
        statusEl && (statusEl.textContent = "❌ Bulk-Check fehlgeschlagen");
      }
    }
  });

  async function checkBulk({ artikelnummern = [], namen = [] }) {
    const { token } = await storageGet("local", "token");
    if (!token) {
      statusEl && (statusEl.textContent = "Bitte zuerst einloggen.");
      throw new Error("Kein Token vorhanden");
    }
    const res = await fetch(`${API_BASE}/artikel/bulk-check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      body: JSON.stringify({ artikelnummern, namen })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Bulk-Check fehlgeschlagen: ${res.status} ${text}`);
    }
    const data = await res.json();
    renderResults(data);
    return data;
  }

  function renderResults(data) {
    if (!resultsEl) return;
    if (!data || !Array.isArray(data.hits)) {
      resultsEl.textContent = "Keine Daten.";
      return;
    }
    const hitsHtml = data.hits.map(h => `
      <div class="result">
        <div class="title">${esc(h.name) ?? "(ohne Name)"}</div>
        <div class="meta">Quelle: ${esc(h.quelle)} · Artikelnummer: ${esc(h.artikelnummer) ?? "—"} · Menge: ${h.menge ?? "—"}</div>
        <div class="meta">Position: ${h.position ? `x:${h.position.x}, y:${h.position.y}, z:${h.position.z}` : "—"}</div>
      </div>
    `).join("");
    const nfHtml = (data.not_found || []).map(x => `<li>${esc(String(x))}</li>`).join("");
    resultsEl.innerHTML = `
      <div class="card"><h3>Treffer (${data.hits.length})</h3>${hitsHtml || "<div>Keine Treffer</div>"}</div>
      <div class="card"><h3>Nicht gefunden (${data.not_found?.length || 0})</h3><ul class="plain">${nfHtml}</ul></div>
    `;
  }

  function esc(s){ return s==null ? s : String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
});

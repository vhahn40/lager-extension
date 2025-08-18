document.addEventListener("DOMContentLoaded", () => {
  const resultsEl = document.getElementById("results");
  const statusEl = document.getElementById("status");
  const logoutEl = document.getElementById("logout");
  const loginCard = document.getElementById("loginCard");
  const loginTitle = document.getElementById("loginTitle");
  let currentData = null;

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
        if (statusEl) {
          statusEl.textContent = "Login fehlgeschlagen";
          statusEl.classList.add("error");
        }
        return;
      }
      const data = await res.json();
      await storageSet("local", { token: data.access_token });
      if (statusEl) {
        statusEl.textContent = "";
        statusEl.classList.remove("error");
      }
      loginCard?.classList.add("hidden");
      loginTitle?.classList.add("hidden");
      logoutEl?.classList.remove("hidden");
    } catch (e) {
      console.error(e);
      if (statusEl) {
        statusEl.textContent = "Netzwerkfehler";
        statusEl.classList.add("error");
      }
    }
  }

  async function onLogout(e) {
    e.preventDefault();
    await chrome.storage.local.remove("token");
    logoutEl?.classList.add("hidden");
    loginCard?.classList.remove("hidden");
    loginTitle?.classList.remove("hidden");
    if (statusEl) {
      statusEl.textContent = "";
      statusEl.classList.remove("error");
    }
  }

  async function restoreLogin() {
    const { token } = await storageGet("local", "token");
    if (token) {
      if (statusEl) {
        statusEl.textContent = "";
        statusEl.classList.remove("error");
      }
      loginCard?.classList.add("hidden");
      loginTitle?.classList.add("hidden");
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
        if (statusEl) {
          statusEl.textContent = "Bulk-Check fehlgeschlagen";
          statusEl.classList.add("error");
        }
      }
    }
  });

  async function checkBulk({ artikelnummern = [], namen = [] }) {
    const { token } = await storageGet("local", "token");
    if (!token) {
      if (statusEl) {
        statusEl.textContent = "Bitte zuerst einloggen.";
        statusEl.classList.add("error");
      }
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
      if (statusEl) {
        statusEl.textContent = "Bulk-Check fehlgeschlagen";
        statusEl.classList.add("error");
      }
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
    currentData = data;
    const hits = data.hits || [];
    const notFoundCount = data.not_found?.length || 0;
    const total = hits.length + notFoundCount;
    const inStock = hits.filter(h => Number(h.menge) > 0).length;
    const rows = hits.map((h, i) => `
      <label class="list-item"><input type="checkbox" class="item-check" data-index="${i}" />
        <span>${esc(h.quelle || h.hersteller || "")}</span>
        <span>${esc(h.name) ?? "(ohne Name)"}</span>
        <span>${esc(h.artikelnummer) ?? "—"}</span>
        <span>${h.menge ?? "—"}</span>
      </label>
    `).join("");
    resultsEl.innerHTML = `
      <div class="summary">${total} Artikel im Warenkorb</div>
      <div class="summary">davon ${inStock} im Lager</div>
      <div class="scroll-list">
        <label class="list-item header"><input type="checkbox" id="checkAll" />
          <span>Hersteller</span><span>Name</span><span>Artikelnr.</span><span>Menge</span>
        </label>
        ${rows || "<div>Keine Treffer</div>"}
      </div>
      <button id="reserveBtn">Reservieren</button>
    `;
    const checkAll = document.getElementById("checkAll");
    const itemChecks = Array.from(resultsEl.querySelectorAll(".item-check"));
    checkAll?.addEventListener("change", () => {
      itemChecks.forEach(c => c.checked = checkAll.checked);
    });
    itemChecks.forEach(c => c.addEventListener("change", () => {
      if (!c.checked) checkAll.checked = false;
      else if (itemChecks.every(i => i.checked)) checkAll.checked = true;
    }));
    document.getElementById("reserveBtn")?.addEventListener("click", () => {
      const remaining = hits.filter((_, idx) => !itemChecks[idx]?.checked);
      currentData.hits = remaining;
      renderResults(currentData);
    });
  }

  function esc(s){ return s==null ? s : String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
});

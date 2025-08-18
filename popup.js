document.addEventListener("DOMContentLoaded", () => {
  const resultsEl = document.getElementById("results");
  const statusEl = document.getElementById("status");
  const logoutEl = document.getElementById("logout");
  const loginCard = document.getElementById("loginCard");
  const loginTitle = document.getElementById("loginTitle");
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsPanel = document.getElementById("settingsPanel");
  const backendInput = document.getElementById("backendUrl");
  const tokenInput = document.getElementById("jwtToken");
  const saveSettingsBtn = document.getElementById("saveSettings");
  let currentData = null;

  // ---- Konfiguration ----
  const DEFAULT_API_BASE = "https://lager-9ree.onrender.com";
  let API_BASE = DEFAULT_API_BASE;
  let BACKEND_BASE_URL = "";
  let JWT_TOKEN = "";

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

  async function loadSettings() {
    const { backendUrl, jwtToken } = await storageGet("sync", ["backendUrl", "jwtToken"]);
    BACKEND_BASE_URL = backendUrl || localStorage.getItem("backendUrl") || "";
    JWT_TOKEN = jwtToken || localStorage.getItem("jwtToken") || "";
    if (backendInput) backendInput.value = BACKEND_BASE_URL;
    if (tokenInput) tokenInput.value = JWT_TOKEN;
  }

  async function saveSettings() {
    BACKEND_BASE_URL = backendInput.value.trim();
    JWT_TOKEN = tokenInput.value.trim();
    await storageSet("sync", { backendUrl: BACKEND_BASE_URL, jwtToken: JWT_TOKEN });
    localStorage.setItem("backendUrl", BACKEND_BASE_URL);
    localStorage.setItem("jwtToken", JWT_TOKEN);
    settingsPanel?.classList.add("hidden");
  }

  // Initialisierung: API-Basis setzen, Login-Status prüfen und Warenkorb anfragen
  (async function init() {
    try {
      await loadSettings();
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
  settingsBtn?.addEventListener("click", () => settingsPanel?.classList.toggle("hidden"));
  saveSettingsBtn?.addEventListener("click", saveSettings);

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
      <label class="result item-row">
        <input type="checkbox" class="item-check" data-index="${i}" ${Number(h.menge) > 0 ? "checked" : ""} />
        <div class="info">
          <div class="title">${esc(h.quelle || h.hersteller || "")}</div>
          <div class="title">${esc(h.name) ?? "(ohne Name)"}</div>
          <div class="meta">${esc(h.artikelnummer) ?? "—"} · ${h.menge ?? "—"}</div>
        </div>
        <input type="number" class="item-qty" min="1" max="${h.menge || 1}" value="1" />
      </label>
    `).join("");
    resultsEl.innerHTML = `
      <div class="summary">${total} Artikel im Warenkorb, davon ${inStock} im Lager</div>
      <div class="scroll-list">${rows || "<div>Keine Treffer</div>"}</div>
      <label class="row"><input type="checkbox" id="reloadAfter" checked /> Nach Entfernen Seite neu laden</label>
      <button id="reserveBtn">Reservieren</button>
    `;
    const itemChecks = Array.from(resultsEl.querySelectorAll(".item-check"));
    const qtyInputs = Array.from(resultsEl.querySelectorAll(".item-qty"));
    const reloadChk = document.getElementById("reloadAfter");
    document.getElementById("reserveBtn")?.addEventListener("click", async () => {
      const selected = hits
        .map((h, idx) => ({ sku: h.artikelnummer, qty: Number(qtyInputs[idx]?.value) || 1, checked: itemChecks[idx]?.checked }))
        .filter(x => x.checked && x.sku);
      if (!selected.length) return;
      const payload = {
        name: `Reservierung ${new Date().toISOString().slice(0,16)}`,
        items: selected.map(x => ({ artikelnummer: x.sku, menge: x.qty })),
        hinweis: "von Browser-Extension"
      };
      const reserveBtn = document.getElementById("reserveBtn");
      reserveBtn.disabled = true;
      if (statusEl) {
        statusEl.textContent = "Reserviere...";
        statusEl.classList.remove("error", "success");
      }
      try {
        const res = await fetch(`${BACKEND_BASE_URL}/reservieren`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${JWT_TOKEN}`
          },
          body: JSON.stringify(payload)
        });
        if (res.status === 401 || res.status === 403) {
          if (statusEl) {
            statusEl.textContent = "Bitte Token in den ⚙️-Einstellungen eintragen/erneuern";
            statusEl.classList.add("error");
          }
          return;
        }
        if (!res.ok) throw new Error(await res.text());
        const resp = await res.json();
        const reserved = resp.reserved || [];
        const notRes = resp.not_reserved || [];
        if (statusEl) {
          statusEl.textContent = `Reservierung #${resp.reservierung_id} angelegt (${reserved.length} reserviert, ${notRes.length} nicht)`;
          statusEl.classList.add("success");
        }
        console.info("[RES] reserviert", reserved);
        console.info("[RES] nicht reserviert", notRes);
        if (reserved.length) {
          const reservedSkus = reserved.map(r => r.artikelnummer);
          currentData.hits = hits.filter(h => !reservedSkus.includes(h.artikelnummer));
          renderResults(currentData);
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            chrome.tabs.sendMessage(tab.id, {
              type: "REMOVE_CART_ITEMS",
              items: reserved.map(r => ({ sku: r.artikelnummer, qty: r.menge })),
              reload: reloadChk?.checked !== false
            });
          } catch (e) {
            console.warn("[RES] REMOVE_CART_ITEMS Fehler", e);
          }
        } else {
          console.warn("[RES] reserved leer");
        }
      } catch (e) {
        console.warn("[RES] Fehler", e);
        if (statusEl) {
          statusEl.textContent = "Reservieren fehlgeschlagen";
          statusEl.classList.add("error");
        }
      } finally {
        reserveBtn.disabled = false;
      }
    });
  }

  function esc(s){ return s==null ? s : String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
});

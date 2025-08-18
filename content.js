// content.js
(function () {
  // ---- zentrale Extraktion ----
  async function extractCart() {
    const candidates = new Set();
    const names = new Set();
    const items = [];

    const addItem = (sku, name, qty) => {
      if (sku && /^[A-Za-z0-9\-\/_.]{4,32}$/.test(String(sku).trim())) {
        const s = String(sku).trim();
        candidates.add(s);
        if (name) names.add(String(name).trim());
        items.push({ sku: s, name: name ? String(name).trim() : undefined, qty: qty ?? undefined });
      }
    };

    // 1) JSON-LD nach schema.org/Product
    document.querySelectorAll('script[type="application/ld+json"]').forEach(sc => {
      try {
        const data = JSON.parse(sc.textContent || 'null');
        const arr = Array.isArray(data) ? data : [data];
        arr.forEach(n => {
          if (!n) return;
          const collect = (p) => {
            if (!p) return;
            const sku = p.sku || p.mpn || p.gtin || p.gtin13 || p.gtin14;
            const name = p.name;
            let qty;
            if (p.offers && typeof p.offers === 'object') {
              const oarr = Array.isArray(p.offers) ? p.offers : [p.offers];
              oarr.forEach(o => {
                if (o?.eligibleQuantity?.value) qty = Number(o.eligibleQuantity.value);
              });
            }
            addItem(sku, name, qty);
          };
          if (n['@type'] === 'Product') collect(n);
          if (Array.isArray(n.itemListElement)) n.itemListElement.forEach(el => collect(el?.item || el));
        });
      } catch {}
    });

    // 2) dataLayer (GA/GTMe-Commerce)
    try {
      if (Array.isArray(window.dataLayer)) {
        window.dataLayer.forEach(ev => {
          const cart =
            ev?.ecommerce?.cart ||
            ev?.ecommerce?.items ||
            ev?.ecommerce?.add?.products ||
            ev?.ecommerce?.checkout?.products ||
            ev?.ecommerce?.purchase?.products;
          const itemsArr = cart || ev?.items;
          if (Array.isArray(itemsArr)) {
            itemsArr.forEach(p => addItem(p?.item_id || p?.id || p?.sku, p?.item_name || p?.name, p?.quantity));
          }
        });
      }
    } catch {}

    // 3) Bekannte Shop-States (best effort)
    try {
      // Shopify
      if (window?.__SHOPIFY_STATE__?.cart?.lines) {
        window.__SHOPIFY_STATE__.cart.lines.forEach(l => addItem(l.merchandise?.sku, l.merchandise?.product?.title, l.quantity));
      }
    } catch {}
    try {
      // Next.js / React Stores (häufig)
      const next = window?.__NEXT_DATA__ || window?.__APOLLO_STATE__;
      const json = JSON.stringify(next || {});
      // sehr grob: suche "sku":"..." Vorkommen
      [...json.matchAll(/"sku"\s*:\s*"([^"]{4,32})"/g)].forEach(m => addItem(m[1]));
    } catch {}

    // 4) DOM-Heuristiken (dein bisheriger Ansatz + verfeinert)
    document.querySelectorAll(`
      [data-sku],[data-artikelnummer],[data-product-id],
      .sku,.artikelnummer,.product-sku
    `).forEach(el => {
      const txt = (el.getAttribute('data-sku') || el.getAttribute('data-artikelnummer') || el.textContent || '').trim();
      if (txt) addItem(txt);
    });

    // Warenkorb/Checkout-Bereich
    document.querySelectorAll(`
      [id*="cart"],[class*="cart"],
      [id*="basket"],[class*="basket"],
      [id*="checkout"],[class*="checkout"]
    `).forEach(root => {
      root.querySelectorAll('*').forEach(n => {
        const t = (n.textContent || '').trim();
        if (/^[A-Za-z0-9][A-Za-z0-9\-\/_.]{3,31}$/.test(t)) addItem(t);
      });
    });

    // Ergebnis
    const artikelnummern = [...candidates].slice(0, 50);
    const namen = [...names].slice(0, 50);
    return { artikelnummern, namen, items };
  }

  // beim ersten Laden (falls Popup später kommt, machen wir zusätzlich on-demand)
  extractCart().then(({ artikelnummern, namen }) => {
    if (artikelnummern.length || namen.length) {
      chrome.runtime.sendMessage({ type: "CART_EXTRACTED", artikelnummern, namen });
    }
  });

  // on-demand vom Popup
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg?.type === "REQUEST_CART") {
      extractCart().then(data => {
        chrome.runtime.sendMessage({ type: "CART_EXTRACTED", artikelnummern: data.artikelnummern, namen: data.namen });
        respond(data);
      });
      return true; // async response
    }
    if (msg?.type === "REMOVE_CART_ITEMS") {
      const list = Array.isArray(msg.items) ? msg.items : [];
      (async () => {
        for (const it of list) {
          await removeItemBySku(it.sku);
        }
        if (msg.reload) location.reload();
      })();
    }
  });

  async function removeItemBySku(sku) {
    if (!sku) return;
    const container = findCartItemContainerBySku(sku);
    if (!container) {
      console.warn("[RES] Kein Container für", sku);
      return;
    }
    if (await tryDeleteButton(container)) {
      console.info("[RES] Delete-Button genutzt", sku);
      return;
    }
    if (await setQtyZeroAndUpdate(container)) {
      console.info("[RES] Menge=0 gesetzt", sku);
      return;
    }
    container.style.display = "none";
    console.warn("[RES] Nur versteckt", sku);
  }

  function findCartItemContainerBySku(sku) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.nodeValue && node.nodeValue.includes(sku)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      const el = node.parentElement?.closest("div, li, tr, section, article");
      if (el) return el;
    }
    return null;
  }

  async function tryDeleteButton(container) {
    const delBtn = container.querySelector("button.sagemodul-schnitt__delete-position-button");
    if (delBtn) {
      delBtn.click();
      await wait(500);
      return true;
    }
    return false;
  }

  async function setQtyZeroAndUpdate(container) {
    const qty = container.querySelector("input[type=number]");
    const updateBtn = document.querySelector("button, input[type=submit]");
    if (qty && updateBtn && /aktualisieren/i.test(updateBtn.textContent || updateBtn.value || "")) {
      qty.value = 0;
      qty.dispatchEvent(new Event("input", { bubbles: true }));
      qty.dispatchEvent(new Event("change", { bubbles: true }));
      updateBtn.click();
      await wait(500);
      return true;
    }
    return false;
  }

  function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
})();


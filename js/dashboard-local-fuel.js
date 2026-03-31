/**
 * Dashboard + profile: fuel card suppliers.
 * Persists: localStorage per user id; syncs to server dashboard.localFuel when not dev session.
 * Each card optional userPricePence = B7 diesel ex-VAT p/l (matches comparison when VAT toggle is Off; ×1.2 when On).
 */
(function () {
  "use strict";

  var FUEL_CARD_BLOCKS = [
    { list: "dash-fuel-cards", empty: "dash-fuelcards-empty", openBtn: "dash-open-fuel-provider" },
    {
      list: "profile-fuel-cards",
      empty: "profile-fuelcards-empty",
      openBtn: "profile-open-fuel-provider",
    },
  ];

  /** Truncate toward zero (never rounds up). */
  function truncTowardZero2dp(n) {
    if (!Number.isFinite(n)) return n;
    return Math.trunc(n * 100) / 100;
  }

  /** Truncate to 1 decimal place toward zero (for display next to GOV figures). */
  function truncTowardZero1dp(n) {
    if (!Number.isFinite(n)) return n;
    return Math.trunc(n * 10) / 10;
  }

  function formatStoredPriceForInput(v) {
    if (v == null || !Number.isFinite(Number(v))) return "";
    var t = truncTowardZero2dp(Number(v));
    return t.toFixed(2).replace(/\.?0+$/, "").replace(/\.$/, "");
  }

  /** Diff vs average: truncate toward zero, never round up. */
  function formatDeltaPence(diff) {
    var t = truncTowardZero2dp(diff);
    if (Object.is(t, -0)) t = 0;
    var s = Math.abs(t).toFixed(2).replace(/\.?0+$/, "").replace(/\.$/, "");
    return (t > 0 ? "+" : t < 0 ? "-" : "") + s + "p";
  }

  function penceDisplayNoRoundUp(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return "-";
    var t = truncTowardZero1dp(n);
    return t.toFixed(1) + "p/l";
  }

  function normalizeCard(c) {
    if (!c || typeof c !== "object") return null;
    var up = c.userPricePence;
    var n = null;
    if (up != null && up !== "") {
      var num = Number(up);
      if (Number.isFinite(num) && num >= 0 && num <= 999.99) {
        n = truncTowardZero2dp(num);
      }
    }
    return {
      id: c.id != null ? String(c.id) : newId(),
      label: String(c.label || "").trim(),
      network: String(c.network || c.label || "Supplier").trim() || "Supplier",
      userPricePence: n,
    };
  }

  function normalize(raw) {
    var arr = Array.isArray(raw && raw.fuelCards) ? raw.fuelCards : [];
    return {
      fuelCards: arr.map(normalizeCard).filter(function (x) {
        return x != null;
      }),
    };
  }

  function sampleDefaults() {
    return normalize(window.FUEL_LOCAL_SAMPLE || { fuelCards: [] });
  }

  function storageKey(userId) {
    return "fuel_local_fuel_" + String(userId || "anon");
  }

  function newId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9);
  }

  function isDevUser(user) {
    return user && String(user.id) === "fuel-dev-local";
  }

  /** UK VAT rate on road fuel (display adjustment only; GOV.UK figures treated as VAT-inclusive). */
  var UK_FUEL_VAT_RATE = 0.2;

  /** Dashboard metrics are road diesel B7 only (matches GOV snapshot / cohort logic). */
  var DASH_FUEL_PRODUCT_LABEL = "B7 diesel";

  function pence(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return "-";
    return (Math.round(n * 10) / 10).toFixed(1) + "p/l";
  }

  /** GOV API price_last_updated (ISO) → display string */
  function formatApiPriceDate(iso) {
    if (!iso || typeof iso !== "string") return "";
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
    } catch (e) {
      return "";
    }
  }

  function vatStorageKey(userId) {
    return "fuel_dashboard_vat_" + String(userId || "anon");
  }

  function loadVatOn(userId) {
    try {
      return localStorage.getItem(vatStorageKey(userId)) === "1";
    } catch (e) {
      return false;
    }
  }

  function saveVatOn(userId, on) {
    try {
      localStorage.setItem(vatStorageKey(userId), on ? "1" : "0");
    } catch (e) {}
  }

  function adjustMetricRowForVat(row, vatOn) {
    if (!row || typeof row !== "object") return {};
    var out = { stationCount: row.stationCount };
    ["averagePrice", "lowestPrice", "highestPrice"].forEach(function (k) {
      var v = row[k];
      if (v == null || !Number.isFinite(Number(v))) {
        out[k] = v;
        return;
      }
      var n = Number(v);
      out[k] = vatOn ? n : n / (1 + UK_FUEL_VAT_RATE);
    });
    if (row.lowestStation && typeof row.lowestStation === "object") {
      out.lowestStation = Object.assign({}, row.lowestStation);
      var rp = row.lowestStation.pricePence;
      if (rp != null && Number.isFinite(Number(rp))) {
        var raw = Number(rp);
        out.lowestStation.displayPrice = vatOn ? raw : raw / (1 + UK_FUEL_VAT_RATE);
      }
    }
    if (Array.isArray(row.topCheapestStations)) {
      out.topCheapestStations = row.topCheapestStations.map(function (st) {
        var o = Object.assign({}, st);
        var pp = o.pricePence;
        if (pp != null && Number.isFinite(Number(pp))) {
          var r = Number(pp);
          o.displayPrice = vatOn ? r : r / (1 + UK_FUEL_VAT_RATE);
        }
        return o;
      });
    }
    return out;
  }

  function loadState(user) {
    var sample = sampleDefaults();
    var fromServer =
      user.dashboard &&
      user.dashboard.localFuel &&
      typeof user.dashboard.localFuel === "object"
        ? normalize(user.dashboard.localFuel)
        : null;
    if (fromServer && fromServer.fuelCards.length > 0) {
      return fromServer;
    }
    try {
      var raw = localStorage.getItem(storageKey(user.id));
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) {}
    return sample;
  }

  function persistLocal(userId, state) {
    try {
      localStorage.setItem(storageKey(userId), JSON.stringify(state));
    } catch (e) {}
  }

  function persist(user, state) {
    persistLocal(user.id, state);
    if (
      isDevUser(user) ||
      typeof window.FuelAuth === "undefined" ||
      typeof window.FuelAuth.patchProfile !== "function"
    ) {
      return Promise.resolve();
    }
    return window.FuelAuth.patchProfile({ dashboard: { localFuel: state } })
      .then(function (u) {
        if (u && window.__FUEL_USER__) window.__FUEL_USER__ = u;
      })
      .catch(function (err) {
        console.warn("Fuel: could not sync dashboard to profile", err);
      });
  }

  window.initDashboardLocalFuel = function (user) {
    if (!user) return;
    var root = document.getElementById("dashboard-root");
    if (!root) return;

    var state = loadState(user);
    /** Per card id: benchmark section expanded (not persisted). Omitted = expanded. */
    var fuelCardExpandedById = Object.create(null);

    var metricsStatusEl = document.getElementById("dash-fuel-metrics-status");
    var metricsCardsEl = document.getElementById("dash-fuel-metrics-cards");
    var apiPingBtn = document.getElementById("dash-api-ping-btn");
    var apiPingResultEl = document.getElementById("dash-api-ping-result");
    var vatOffBtn = document.getElementById("dash-fuel-vat-off");
    var vatOnBtn = document.getElementById("dash-fuel-vat-on");
    var vatHintEl = document.getElementById("dash-vat-hint");
    var lastMetricsPayload = null;
    var vatOn = loadVatOn(user.id);

    /** User-entered fuel card price is ex-VAT p/l; match GOV totals (same VAT toggle). */
    function userCardPriceToDisplayUnits(storedExVat) {
      if (storedExVat == null || !Number.isFinite(Number(storedExVat))) return null;
      var ex = Number(storedExVat);
      return vatOn ? ex * (1 + UK_FUEL_VAT_RATE) : ex;
    }

    function syncVatButtons() {
      if (vatOffBtn) {
        vatOffBtn.classList.toggle("is-active", !vatOn);
        vatOffBtn.setAttribute("aria-pressed", !vatOn ? "true" : "false");
      }
      if (vatOnBtn) {
        vatOnBtn.classList.toggle("is-active", vatOn);
        vatOnBtn.setAttribute("aria-pressed", vatOn ? "true" : "false");
      }
      if (vatHintEl) {
        vatHintEl.textContent = vatOn
          ? "Prices include VAT (20%)."
          : "Prices ex-VAT (20%) — default.";
      }
    }

    function setVatOn(on) {
      vatOn = Boolean(on);
      saveVatOn(user.id, vatOn);
      syncVatButtons();
      renderMetricsFromPayload();
      renderFuelCardBlocks();
    }

    if (vatOffBtn) {
      vatOffBtn.addEventListener("click", function () {
        setVatOn(false);
      });
    }
    if (vatOnBtn) {
      vatOnBtn.addEventListener("click", function () {
        setVatOn(true);
      });
    }
    syncVatButtons();

    function runDashboardApiPing() {
      if (typeof window.fuelPingBackendHealth !== "function") return;
      if (apiPingBtn) apiPingBtn.disabled = true;
      if (apiPingResultEl) {
        apiPingResultEl.textContent = "Checking…";
        apiPingResultEl.className = "dash-api-ping-result";
      }
      window
        .fuelPingBackendHealth()
        .then(function (r) {
          if (!apiPingResultEl) return;
          apiPingResultEl.textContent = r.message || (r.ok ? "OK" : "Failed");
          apiPingResultEl.className =
            "dash-api-ping-result " + (r.ok ? "dash-api-ping-result--ok" : "dash-api-ping-result--err");
        })
        .finally(function () {
          if (apiPingBtn) apiPingBtn.disabled = false;
        });
    }
    if (apiPingBtn) {
      apiPingBtn.addEventListener("click", function (ev) {
        ev.preventDefault();
        runDashboardApiPing();
      });
    }

    function escapeHtml(s) {
      var d = document.createElement("div");
      d.textContent = s;
      return d.innerHTML;
    }

    function benchmarkNum(v) {
      if (v == null || !Number.isFinite(Number(v))) return null;
      return Number(v);
    }

    function buildHorizontalBenchmarkChart(titleText, ariaLabel, rows) {
      var vals = [];
      rows.forEach(function (r) {
        if (r.value != null && Number.isFinite(r.value)) vals.push(r.value);
      });
      var scale = vals.length ? Math.max.apply(null, vals) * 1.02 : 1;
      if (!Number.isFinite(scale) || scale <= 0) scale = 1;

      var wrap = document.createElement("div");
      wrap.className = "dash-fuelcard-chart";
      wrap.setAttribute("role", "group");
      wrap.setAttribute("aria-label", ariaLabel);

      var title = document.createElement("div");
      title.className = "dash-fuelcard-chart__title";
      title.textContent = titleText;
      wrap.appendChild(title);

      rows.forEach(function (r) {
        var n = r.value != null && Number.isFinite(r.value) ? r.value : null;
        var row = document.createElement("div");
        row.className = "dash-fuelcard-chart__row";
        if (r.isYou) row.classList.add("dash-fuelcard-chart__row--you");
        if (r.tone) row.classList.add("dash-fuelcard-chart__row--" + String(r.tone));

        var lab = document.createElement("span");
        lab.className = "dash-fuelcard-chart__label";
        lab.textContent = r.label;

        var track = document.createElement("div");
        track.className = "dash-fuelcard-chart__track";
        track.setAttribute("aria-hidden", "true");

        var fill = document.createElement("div");
        fill.className = "dash-fuelcard-chart__fill";
        if (n != null) {
          var pct = Math.min(100, Math.max(0, (n / scale) * 100));
          fill.style.width = pct + "%";
        } else {
          fill.classList.add("dash-fuelcard-chart__fill--empty");
          fill.style.width = "0%";
        }
        track.appendChild(fill);

        var valEl = document.createElement("span");
        valEl.className = "dash-fuelcard-chart__value";
        valEl.textContent = n != null ? penceDisplayNoRoundUp(n) : "—";

        row.appendChild(lab);
        row.appendChild(track);
        row.appendChild(valEl);
        wrap.appendChild(row);
      });

      return wrap;
    }

    function adjustedLocalTotals(vatEnabled) {
      return lastMetricsPayload && lastMetricsPayload.totals
        ? adjustMetricRowForVat(lastMetricsPayload.totals, Boolean(vatEnabled))
        : {};
    }

    function adjustedNationalTotals(vatEnabled) {
      return lastNationalPayload && lastNationalPayload.totals
        ? adjustMetricRowForVat(lastNationalPayload.totals, Boolean(vatEnabled))
        : {};
    }

    /**
     * Horizontal bars: your card vs local 30 km low/avg and England low/avg (always ex-VAT).
     */
    function createFuelCardBenchmarkChart(storedExVatPence) {
      var ud = benchmarkNum(storedExVatPence);
      if (ud == null || !Number.isFinite(ud)) return null;

      var localTot = adjustedLocalTotals(false);
      var natTot = adjustedNationalTotals(false);
      var localLow = benchmarkNum(localTot.lowestPrice);
      var localAvg = benchmarkNum(localTot.averagePrice);
      var yourTone = null;
      if (localAvg != null && ud > localAvg) {
        yourTone = "danger";
      } else if (localLow != null && ud > localLow) {
        yourTone = "warn";
      }

      var rows = [
        { label: "Your card", value: ud, isYou: true, tone: yourTone },
        { label: "Local 30 km · low", value: benchmarkNum(localTot.lowestPrice) },
        { label: "Local 30 km · avg", value: benchmarkNum(localTot.averagePrice) },
        { label: "England · low", value: benchmarkNum(natTot.lowestPrice) },
        { label: "England · avg", value: benchmarkNum(natTot.averagePrice) },
      ];

      return buildHorizontalBenchmarkChart(
        "Compared to benchmarks (ex-VAT)",
        "Ex VAT price comparison: your card versus local 30 km and England benchmarks",
        rows
      );
    }

    function renderFuelCardBlocks() {
      FUEL_CARD_BLOCKS.forEach(function (blk) {
        var listEl = document.getElementById(blk.list);
        var emptyEl = document.getElementById(blk.empty);
        if (!listEl) return;
        listEl.innerHTML = "";
        state.fuelCards.forEach(function (row) {
          var li = document.createElement("li");
          li.className = "dash-list__item dash-list__item--fuelcard";

          var main = document.createElement("div");
          main.className = "dash-list__main";
          var supplier = String(row.network || row.label || "Supplier").trim();
          var labelEl = document.createElement("span");
          labelEl.className = "dash-list__label";
          labelEl.textContent = supplier;
          main.appendChild(labelEl);
          var alias =
            row.label &&
            String(row.label).trim() &&
            String(row.label).trim() !== supplier
              ? String(row.label).trim()
              : "";
          if (alias) {
            var metaEl = document.createElement("span");
            metaEl.className = "dash-list__meta";
            metaEl.textContent = alias;
            main.appendChild(metaEl);
          }

          var rm = document.createElement("button");
          rm.type = "button";
          rm.className = "dash-list__remove";
          rm.setAttribute("aria-label", "Remove supplier");
          rm.textContent = "×";
          rm.addEventListener("click", function () {
            delete fuelCardExpandedById[row.id];
            state.fuelCards = state.fuelCards.filter(function (x) {
              return x.id !== row.id;
            });
            persist(user, state);
            render();
          });

          var safeDomId = String(row.id).replace(/[^a-zA-Z0-9_-]/g, "-");
          var detailsId = "fuelcard-details-" + safeDomId;
          var up = row.userPricePence;
          var hasBenchmarkSection =
            up != null && Number.isFinite(Number(up));
          var benchmarkExpanded = fuelCardExpandedById[row.id] !== false;

          var top = document.createElement("div");
          top.className = "dash-fuelcard-top";
          top.appendChild(main);

          var topActions = document.createElement("div");
          topActions.className = "dash-fuelcard-top__actions";

          if (hasBenchmarkSection) {
            var expandBtn = document.createElement("button");
            expandBtn.type = "button";
            expandBtn.className = "dash-fuelcard-expand";
            expandBtn.setAttribute("aria-expanded", benchmarkExpanded ? "true" : "false");
            expandBtn.setAttribute("aria-controls", detailsId);
            expandBtn.setAttribute(
              "aria-label",
              benchmarkExpanded ? "Hide benchmark comparison for " + supplier : "Show benchmark comparison for " + supplier
            );
            var chev = document.createElement("span");
            chev.className = "dash-fuelcard-expand__chev";
            chev.setAttribute("aria-hidden", "true");
            chev.textContent = "▼";
            expandBtn.appendChild(chev);
            expandBtn.addEventListener("click", function () {
              if (fuelCardExpandedById[row.id] === false) {
                delete fuelCardExpandedById[row.id];
              } else {
                fuelCardExpandedById[row.id] = false;
              }
              renderFuelCardBlocks();
            });
            topActions.appendChild(expandBtn);
          }

          topActions.appendChild(rm);
          top.appendChild(topActions);

          var priceRow = document.createElement("div");
          priceRow.className = "dash-fuelcard-price";
          var priceLabel = document.createElement("label");
          var inputId = "fuelcard-price-" + String(row.id).replace(/[^a-zA-Z0-9_-]/g, "-");
          priceLabel.className = "dash-fuelcard-price__label";
          priceLabel.setAttribute("for", inputId);
          priceLabel.textContent = "Your " + DASH_FUEL_PRODUCT_LABEL + " (p/l, ex-VAT)";
          var input = document.createElement("input");
          input.type = "number";
          input.id = inputId;
          input.className = "dash-fuelcard-price__input";
          input.setAttribute("inputmode", "decimal");
          input.setAttribute("min", "0");
          input.setAttribute("max", "999.99");
          input.setAttribute("step", "any");
          input.setAttribute("placeholder", "e.g. 165.9");
          input.setAttribute(
            "aria-label",
            "Your " + DASH_FUEL_PRODUCT_LABEL + " price for " + supplier + ", pence per litre excluding VAT"
          );
          if (row.userPricePence != null && Number.isFinite(Number(row.userPricePence))) {
            input.value = formatStoredPriceForInput(row.userPricePence);
          }
          input.addEventListener("change", function () {
            var raw = String(input.value || "").trim();
            var card = state.fuelCards.filter(function (x) {
              return x.id === row.id;
            })[0];
            if (!card) return;
            if (raw === "") {
              card.userPricePence = null;
            } else {
              var num = Number(raw);
              if (Number.isFinite(num) && num >= 0 && num <= 999.99) {
                card.userPricePence = truncTowardZero2dp(num);
                input.value = formatStoredPriceForInput(card.userPricePence);
              } else {
                card.userPricePence = null;
                input.value = "";
              }
            }
            persist(user, state);
            renderFuelCardBlocks();
          });
          input.addEventListener("keydown", function (e) {
            if (e.key === "Enter") {
              e.preventDefault();
              input.blur();
            }
          });
          priceRow.appendChild(priceLabel);
          priceRow.appendChild(input);

          li.appendChild(top);
          li.appendChild(priceRow);

          if (hasBenchmarkSection) {
            var detailsEl = document.createElement("div");
            detailsEl.className = "dash-fuelcard-details";
            detailsEl.id = detailsId;
            if (!benchmarkExpanded) detailsEl.hidden = true;

            var compareEl = document.createElement("div");
            compareEl.className = "dash-fuelcard-compare";
            var avg = null;
            if (lastMetricsPayload && lastMetricsPayload.totals) {
              var adjTot = adjustMetricRowForVat(lastMetricsPayload.totals, false);
              if (adjTot.averagePrice != null && Number.isFinite(Number(adjTot.averagePrice))) {
                avg = Number(adjTot.averagePrice);
              }
            }
            var ud = benchmarkNum(up);
            if (ud != null && avg != null) {
              var diff = ud - avg;
              var span = document.createElement("span");
              span.className = "dash-fuelcard-compare__diff";
              if (diff <= 0.05) {
                span.classList.add("dash-fuelcard-compare__diff--better");
              } else {
                span.classList.add("dash-fuelcard-compare__diff--higher");
              }
              span.textContent =
                "vs local 30 km avg (ex-VAT) " + penceDisplayNoRoundUp(avg) + ": " + formatDeltaPence(diff);
              compareEl.appendChild(span);
            } else {
              compareEl.classList.add("dash-fuelcard-compare--muted");
              compareEl.textContent =
                "Set your operation postcode and load local metrics below to compare with the 30 km snapshot average.";
            }
            detailsEl.appendChild(compareEl);

            var chartEl = createFuelCardBenchmarkChart(up);
            if (chartEl) detailsEl.appendChild(chartEl);

            li.appendChild(detailsEl);
          }

          listEl.appendChild(li);
        });
        if (emptyEl) {
          emptyEl.hidden = state.fuelCards.length > 0;
        }
      });
    }

    function render() {
      renderFuelCardBlocks();
    }

    var metricRowsByPrefix = {};

    function lowestStationId(st) {
      if (!st || typeof st !== "object") return "";
      var raw = st.stationId != null ? st.stationId : st.station_id;
      return String(raw || "").trim();
    }

    var LIST_TOP5_BTN_LABEL = "List";

    /**
     * @param {string} [prefix] — supermarket | motorway | independent | total
     * @param {string|null} [categoryTitle] — from data-metric-title; null = all-stations (total) view
     */
    function openTopFiveDialog(prefix, categoryTitle) {
      var key = prefix || "total";
      var r = metricRowsByPrefix[key] || {};
      var stations = Array.isArray(r.topCheapestStations) ? r.topCheapestStations : [];
      var dlg = document.getElementById("dash-top5-cheapest-dialog");
      var listEl = document.getElementById("dash-top5-list");
      var leadEl = document.getElementById("dash-top5-dialog-lead");
      var titleEl = document.getElementById("dash-top5-dialog-title");
      if (!dlg || !listEl) return;
      if (titleEl) {
        if (categoryTitle) {
          titleEl.textContent =
            "Top 5 lowest prices — " + categoryTitle + " — " + DASH_FUEL_PRODUCT_LABEL;
        } else {
          titleEl.textContent =
            "Top 5 lowest prices — " + DASH_FUEL_PRODUCT_LABEL + " (30 km)";
        }
      }
      if (leadEl) {
        leadEl.textContent = categoryTitle
          ? DASH_FUEL_PRODUCT_LABEL +
            " · lowest price first · " +
            categoryTitle +
            " stations within your 30 km cohort."
          : DASH_FUEL_PRODUCT_LABEL +
            " · lowest price first · all stations within 30 km of your operation base.";
      }
      listEl.innerHTML = "";
      if (stations.length === 0) {
        var emptyLi = document.createElement("li");
        emptyLi.className = "dash-top5__empty-msg";
        emptyLi.textContent = categoryTitle
          ? "No priced stations in this category yet. Try another category or check your snapshot."
          : "No priced stations in this list yet. Set your operation postcode on the profile page and ensure the fuel snapshot has loaded.";
        listEl.appendChild(emptyLi);
      } else {
      stations.forEach(function (st, idx) {
        var li = document.createElement("li");
        li.className = "dash-top5__item";
        var showP = null;
        if (st.displayPrice != null && Number.isFinite(Number(st.displayPrice))) {
          showP = Number(st.displayPrice);
        } else if (st.pricePence != null && Number.isFinite(Number(st.pricePence))) {
          showP = Number(st.pricePence);
        }
        var rank = document.createElement("span");
        rank.className = "dash-top5__rank";
        rank.textContent = String(idx + 1);
        var body = document.createElement("div");
        body.className = "dash-top5__body";
        var nameEl = document.createElement("div");
        nameEl.className = "dash-top5__name";
        nameEl.textContent = String(st.name || "Station").trim() || "Station";
        var meta = document.createElement("div");
        meta.className = "dash-top5__meta";
        var ap = [];
        if (st.address) ap.push(String(st.address));
        if (st.postcode) ap.push(String(st.postcode));
        meta.textContent = ap.join(" · ") || "—";
        var updatedIso = st.priceLastUpdated != null ? st.priceLastUpdated : st.lastUpdated;
        var updatedStr = formatApiPriceDate(
          typeof updatedIso === "string" ? updatedIso : ""
        );
        var upd = null;
        if (updatedStr) {
          upd = document.createElement("div");
          upd.className = "dash-top5__updated";
          upd.textContent = "API price date: " + updatedStr;
        }
        var row = document.createElement("div");
        row.className = "dash-top5__row";
        var priceSpan = document.createElement("span");
        priceSpan.className = "dash-top5__price";
        priceSpan.textContent = showP != null ? pence(showP) : "—";
        row.appendChild(priceSpan);
        if (st.distanceKm != null && Number.isFinite(Number(st.distanceKm))) {
          row.appendChild(document.createTextNode(" · "));
          var distSpan = document.createElement("span");
          distSpan.className = "dash-top5__dist";
          distSpan.textContent = Number(st.distanceKm).toFixed(1) + " km";
          row.appendChild(distSpan);
        }
        body.appendChild(nameEl);
        body.appendChild(meta);
        if (upd) body.appendChild(upd);
        body.appendChild(row);
        li.appendChild(rank);
        li.appendChild(body);
        listEl.appendChild(li);
      });
      }
      try {
        if (dlg.open) dlg.close();
      } catch (e0) {}
      try {
        if (typeof dlg.showModal === "function") {
          dlg.showModal();
        } else if (typeof dlg.show === "function") {
          dlg.show();
        } else {
          dlg.setAttribute("open", "");
        }
      } catch (e1) {
        try {
          if (typeof dlg.show === "function") dlg.show();
          else dlg.setAttribute("open", "");
        } catch (e2) {}
      }
    }

    function metricSet(prefix, row) {
      var r = row && typeof row === "object" ? row : {};
      metricRowsByPrefix[prefix] = r;
      var countEl = document.getElementById("dash-metric-" + prefix + "-count");
      var avgEl = document.getElementById("dash-metric-" + prefix + "-avg");
      var lowBtn = document.getElementById("dash-metric-" + prefix + "-low-btn");
      var lowProductEl = document.getElementById("dash-metric-" + prefix + "-low-product");
      var highEl = document.getElementById("dash-metric-" + prefix + "-high");
      if (countEl) countEl.textContent = String(Number(r.stationCount) || 0);
      if (avgEl) avgEl.textContent = pence(r.averagePrice);
      if (lowBtn) {
        lowBtn.textContent = pence(r.lowestPrice);
        var hasLow = !!(r.lowestStation && lowestStationId(r.lowestStation));
        lowBtn.disabled = !hasLow;
        lowBtn.setAttribute("aria-disabled", hasLow ? "false" : "true");
        var rawCat = lowBtn.getAttribute("data-metric-title");
        var catTitle =
          rawCat != null && String(rawCat).trim() ? String(rawCat).trim() : null;
        lowBtn.onclick = function (ev) {
          ev.preventDefault();
          if (lowBtn.disabled) return;
          loadDashboardMetrics().then(function (r) {
            if (r && r.ok) openTopFiveDialog(prefix, catTitle);
          });
        };
        if (lowProductEl) {
          var showProduct =
            hasLow && r.lowestPrice != null && Number.isFinite(Number(r.lowestPrice));
          lowProductEl.textContent = showProduct ? DASH_FUEL_PRODUCT_LABEL : "";
          lowProductEl.hidden = !showProduct;
          lowProductEl.setAttribute("aria-hidden", "true");
        }
      }
      if (highEl) highEl.textContent = pence(r.highestPrice);
    }

    var top5Dlg = document.getElementById("dash-top5-cheapest-dialog");
    if (top5Dlg && !top5Dlg.dataset.bound) {
      top5Dlg.dataset.bound = "1";
      var t5c = document.getElementById("dash-top5-dialog-close");
      if (t5c) {
        t5c.addEventListener("click", function () {
          top5Dlg.close();
        });
      }
      top5Dlg.addEventListener("click", function (e) {
        if (e.target === top5Dlg) top5Dlg.close();
      });
    }

    function syncStaleSnapshotBanner() {
      var el = document.getElementById("dash-snapshot-stale-banner");
      if (!el) return;
      var snap = lastMetricsPayload && lastMetricsPayload.snapshot;
      if (snap && snap.staleFallback === true) {
        el.hidden = false;
        el.textContent =
          "Showing last saved GOV snapshot — live refresh failed or was rate-limited. Figures may be slightly older. Use Dev → Refresh fuel snapshot when the API is quiet.";
      } else {
        el.hidden = true;
        el.textContent = "";
      }
    }

    function renderMetricsFromPayload() {
      if (!lastMetricsPayload) {
        syncStaleSnapshotBanner();
        renderFuelCardBlocks();
        return;
      }
      var cats = lastMetricsPayload.categories || {};
      metricSet("supermarket", adjustMetricRowForVat(cats.supermarket || {}, vatOn));
      metricSet("motorway", adjustMetricRowForVat(cats.motorway || {}, vatOn));
      metricSet("independent", adjustMetricRowForVat(cats.independent || {}, vatOn));
      metricSet("total", adjustMetricRowForVat(lastMetricsPayload.totals || {}, vatOn));
      syncStaleSnapshotBanner();
      renderFuelCardBlocks();
    }

    async function loadDashboardMetrics() {
      if (!metricsStatusEl || !metricsCardsEl) return { ok: false };
      var base = String(window.FUEL_FINDER_PROXY_BASE || "").replace(/\/$/, "");
      if (!base) {
        metricsStatusEl.textContent = "No API URL. Start the backend on port 8787.";
        metricsCardsEl.hidden = false;
        return { ok: false };
      }
      var headers = { Accept: "application/json" };
      if (window.FuelAuth && typeof window.FuelAuth.authHeaders === "function") {
        headers = window.FuelAuth.authHeaders();
      }
      metricsStatusEl.textContent = "Loading local metrics…";
      try {
        var res = await fetch(base + "/dashboard/fuel-metrics?_=" + String(Date.now()), {
          headers: headers,
          cache: "no-store",
        });
        var data = await res.json().catch(function () {
          return {};
        });
        if (!res.ok) {
          throw new Error(data.error || "Could not load dashboard metrics");
        }
        lastMetricsPayload = data;
        renderMetricsFromPayload();
        var hours =
          data.priceFreshnessMaxAgeHours != null &&
          Number.isFinite(Number(data.priceFreshnessMaxAgeHours))
            ? Number(data.priceFreshnessMaxAgeHours)
            : 72;
        if (data.snapshotCatalogStale) {
          metricsStatusEl.textContent =
            "Saved GOV snapshot is older than " +
            hours +
            " h. Refresh it (Dev → Refresh fuel snapshot, or server: npm run refresh-snapshot) to load recent data.";
        } else {
          var cap = data.capturedAt || (data.snapshot && data.snapshot.capturedAt) || "";
          if (cap) {
            var d = new Date(cap);
            var line =
              "Snapshot: " + (isNaN(d.getTime()) ? cap : d.toLocaleString("en-GB"));
            var tot = data.totals && typeof data.totals === "object" ? data.totals : {};
            var nFresh = Number(tot.stationCount);
            if (!Number.isFinite(nFresh) || nFresh === 0) {
              line +=
                " — No B7 prices with a GOV update within the last " +
                hours +
                " h for stations in your cohort. Try Dev → Refresh fuel snapshot when the API is quiet.";
            }
            metricsStatusEl.textContent = line;
          } else {
            metricsStatusEl.textContent = "No snapshot yet. Metrics will appear after refresh.";
          }
        }
        return { ok: true };
      } catch (err) {
        metricsStatusEl.textContent =
          (err && err.message ? err.message : "Could not load dashboard metrics") + ".";
        metricsCardsEl.hidden = false;
        var staleEl = document.getElementById("dash-snapshot-stale-banner");
        if (staleEl) {
          staleEl.hidden = true;
          staleEl.textContent = "";
        }
        return { ok: false };
      }
    }

    var top5BtnEl = document.getElementById("dash-top5-cheapest-btn");
    if (top5BtnEl) {
      top5BtnEl.textContent = LIST_TOP5_BTN_LABEL;
      top5BtnEl.addEventListener("click", function (ev) {
        ev.preventDefault();
        top5BtnEl.disabled = true;
        top5BtnEl.textContent = "Loading…";
        loadDashboardMetrics()
          .then(function (r) {
            if (r && r.ok) openTopFiveDialog("total", null);
          })
          .finally(function () {
            top5BtnEl.disabled = false;
            top5BtnEl.textContent = LIST_TOP5_BTN_LABEL;
          });
      });
    }

    var providerDialog = document.getElementById("fuel-provider-dialog");

    function showProviderStep(step) {
      var listEl = document.getElementById("fuel-provider-step-list");
      var otherEl = document.getElementById("fuel-provider-step-other");
      if (listEl) listEl.hidden = step !== "list";
      if (otherEl) otherEl.hidden = step !== "other";
      var title = document.getElementById("fuel-provider-dialog-title");
      if (title) {
        if (step === "list") title.textContent = "Add supplier";
        else title.textContent = "Other supplier";
      }
    }

    function resetProviderDialog() {
      var oi = document.getElementById("fuel-provider-other-input");
      if (oi) oi.value = "";
      showProviderStep("list");
    }

    function addFuelSupplier(name) {
      var supplier = String(name || "").trim().slice(0, 80);
      if (!supplier) return;
      state.fuelCards.push({
        id: newId(),
        label: supplier,
        network: supplier,
        userPricePence: null,
      });
      persist(user, state);
      render();
      if (providerDialog && typeof providerDialog.close === "function") providerDialog.close();
    }

    function buildProviderListOnce() {
      var listEl = document.getElementById("fuel-provider-list");
      if (!listEl || listEl.dataset.fuelProviderBuilt === "1") return;
      listEl.dataset.fuelProviderBuilt = "1";
      var opts = window.FUEL_CARD_NETWORK_OPTIONS;
      if (!Array.isArray(opts)) return;
      opts.forEach(function (name) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "fuel-provider-list__item";
        btn.setAttribute("role", "option");
        btn.textContent = name;
        btn.addEventListener("click", function () {
          addFuelSupplier(name);
        });
        listEl.appendChild(btn);
      });
    }

    function openProviderDialog() {
      buildProviderListOnce();
      resetProviderDialog();
      if (providerDialog && typeof providerDialog.showModal === "function") {
        providerDialog.showModal();
      }
    }

    function bindFuelProviderDialog() {
      if (!providerDialog || providerDialog.dataset.fuelProviderBound === "1") return;
      providerDialog.dataset.fuelProviderBound = "1";

      providerDialog.addEventListener("click", function (e) {
        if (e.target === providerDialog) providerDialog.close();
      });
      providerDialog.addEventListener("close", function () {
        resetProviderDialog();
      });

      var closeBtn = document.getElementById("fuel-provider-dialog-close");
      if (closeBtn) {
        closeBtn.addEventListener("click", function () {
          providerDialog.close();
        });
      }

      var btnOther = document.getElementById("fuel-provider-btn-other");
      if (btnOther) {
        btnOther.addEventListener("click", function () {
          showProviderStep("other");
          var oi = document.getElementById("fuel-provider-other-input");
          if (oi) oi.focus();
        });
      }

      var otherBack = document.getElementById("fuel-provider-other-back");
      if (otherBack) {
        otherBack.addEventListener("click", function () {
          showProviderStep("list");
        });
      }

      function continueFromOtherProvider() {
        var oi = document.getElementById("fuel-provider-other-input");
        var raw = String((oi && oi.value) || "").trim().slice(0, 80);
        if (!raw) return;
        addFuelSupplier(raw);
      }

      var otherContinue = document.getElementById("fuel-provider-other-continue");
      if (otherContinue) {
        otherContinue.addEventListener("click", continueFromOtherProvider);
      }

      var otherInput = document.getElementById("fuel-provider-other-input");
      if (otherInput) {
        otherInput.addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            continueFromOtherProvider();
          }
        });
      }

      FUEL_CARD_BLOCKS.forEach(function (blk) {
        var openEl = document.getElementById(blk.openBtn);
        if (!openEl) return;
        openEl.addEventListener("click", openProviderDialog);
      });
    }

    bindFuelProviderDialog();

    /* ──────────────────────────────────────────────
     * National (England) metrics — same layout, different endpoint
     * ────────────────────────────────────────────── */

    var nationalStatusEl = document.getElementById("dash-national-metrics-status");
    var nationalCardsEl = document.getElementById("dash-national-metrics-cards");
    var nationalStaleBanner = document.getElementById("dash-national-stale-banner");
    var lastNationalPayload = null;
    var nationalRowsByPrefix = {};

    function nationalMetricSet(prefix, row) {
      var r = row && typeof row === "object" ? row : {};
      nationalRowsByPrefix[prefix] = r;
      var countEl = document.getElementById("dash-national-" + prefix + "-count");
      var avgEl = document.getElementById("dash-national-" + prefix + "-avg");
      var lowBtn = document.getElementById("dash-national-" + prefix + "-low-btn");
      var lowProductEl = document.getElementById("dash-national-" + prefix + "-low-product");
      var highEl = document.getElementById("dash-national-" + prefix + "-high");
      if (countEl) countEl.textContent = String(Number(r.stationCount) || 0);
      if (avgEl) avgEl.textContent = pence(r.averagePrice);
      if (lowBtn) {
        lowBtn.textContent = pence(r.lowestPrice);
        var hasLow = !!(r.lowestStation && lowestStationId(r.lowestStation));
        lowBtn.disabled = !hasLow;
        lowBtn.setAttribute("aria-disabled", hasLow ? "false" : "true");
        var rawCat = lowBtn.getAttribute("data-metric-title");
        var catTitle = rawCat != null && String(rawCat).trim() ? String(rawCat).trim() : null;
        lowBtn.onclick = function (ev) {
          ev.preventDefault();
          if (lowBtn.disabled) return;
          loadNationalMetrics().then(function (r) {
            if (r && r.ok) openNationalTopFive(prefix, catTitle);
          });
        };
        if (lowProductEl) {
          var showProduct = hasLow && r.lowestPrice != null && Number.isFinite(Number(r.lowestPrice));
          lowProductEl.textContent = showProduct ? DASH_FUEL_PRODUCT_LABEL : "";
          lowProductEl.hidden = !showProduct;
          lowProductEl.setAttribute("aria-hidden", "true");
        }
      }
      if (highEl) highEl.textContent = pence(r.highestPrice);
    }

    function openNationalTopFive(prefix, categoryTitle) {
      var key = prefix || "total";
      var r = nationalRowsByPrefix[key] || {};
      var stations = Array.isArray(r.topCheapestStations) ? r.topCheapestStations : [];
      var scope = categoryTitle
        ? "England — " + categoryTitle
        : "England — all stations";
      openTopFiveDialog._nationalRows = nationalRowsByPrefix;
      var dlg = document.getElementById("dash-top5-cheapest-dialog");
      var listEl = document.getElementById("dash-top5-list");
      var leadEl = document.getElementById("dash-top5-dialog-lead");
      var titleEl = document.getElementById("dash-top5-dialog-title");
      if (!dlg || !listEl) return;
      if (titleEl) {
        titleEl.textContent = "Top 5 lowest prices — " + scope + " — " + DASH_FUEL_PRODUCT_LABEL;
      }
      if (leadEl) {
        leadEl.textContent =
          DASH_FUEL_PRODUCT_LABEL + " · lowest price first · " + scope + ".";
      }
      listEl.innerHTML = "";
      if (stations.length === 0) {
        var emptyLi = document.createElement("li");
        emptyLi.className = "dash-top5__empty-msg";
        emptyLi.textContent = "No priced stations in this category yet.";
        listEl.appendChild(emptyLi);
      } else {
        stations.forEach(function (st, idx) {
          var li = document.createElement("li");
          li.className = "dash-top5__item";
          var showP = null;
          if (st.displayPrice != null && Number.isFinite(Number(st.displayPrice))) {
            showP = Number(st.displayPrice);
          } else if (st.pricePence != null && Number.isFinite(Number(st.pricePence))) {
            showP = Number(st.pricePence);
          }
          var rank = document.createElement("span");
          rank.className = "dash-top5__rank";
          rank.textContent = String(idx + 1);
          var body = document.createElement("div");
          body.className = "dash-top5__body";
          var nameEl = document.createElement("div");
          nameEl.className = "dash-top5__name";
          nameEl.textContent = String(st.name || "Station").trim() || "Station";
          var meta = document.createElement("div");
          meta.className = "dash-top5__meta";
          var ap = [];
          if (st.address) ap.push(String(st.address));
          if (st.postcode) ap.push(String(st.postcode));
          meta.textContent = ap.join(" · ") || "—";
          var updatedIso = st.priceLastUpdated != null ? st.priceLastUpdated : st.lastUpdated;
          var updatedStr = formatApiPriceDate(typeof updatedIso === "string" ? updatedIso : "");
          var upd = null;
          if (updatedStr) {
            upd = document.createElement("div");
            upd.className = "dash-top5__updated";
            upd.textContent = "API price date: " + updatedStr;
          }
          var row = document.createElement("div");
          row.className = "dash-top5__row";
          var priceSpan = document.createElement("span");
          priceSpan.className = "dash-top5__price";
          priceSpan.textContent = showP != null ? pence(showP) : "—";
          row.appendChild(priceSpan);
          if (st.postcode) {
            row.appendChild(document.createTextNode(" · "));
            var pcSpan = document.createElement("span");
            pcSpan.className = "dash-top5__dist";
            pcSpan.textContent = String(st.postcode);
            row.appendChild(pcSpan);
          }
          body.appendChild(nameEl);
          body.appendChild(meta);
          if (upd) body.appendChild(upd);
          body.appendChild(row);
          li.appendChild(rank);
          li.appendChild(body);
          listEl.appendChild(li);
        });
      }
      try { if (dlg.open) dlg.close(); } catch (e0) {}
      try {
        if (typeof dlg.showModal === "function") dlg.showModal();
        else if (typeof dlg.show === "function") dlg.show();
        else dlg.setAttribute("open", "");
      } catch (e1) {
        try { if (typeof dlg.show === "function") dlg.show(); else dlg.setAttribute("open", ""); } catch (e2) {}
      }
    }

    function renderNationalFromPayload() {
      if (lastNationalPayload) {
        var cats = lastNationalPayload.categories || {};
        nationalMetricSet("supermarket", adjustMetricRowForVat(cats.supermarket || {}, vatOn));
        nationalMetricSet("motorway", adjustMetricRowForVat(cats.motorway || {}, vatOn));
        nationalMetricSet("independent", adjustMetricRowForVat(cats.independent || {}, vatOn));
        nationalMetricSet("total", adjustMetricRowForVat(lastNationalPayload.totals || {}, vatOn));
        if (nationalStaleBanner) {
          var snap = lastNationalPayload.snapshot;
          if (snap && snap.staleFallback === true) {
            nationalStaleBanner.hidden = false;
            nationalStaleBanner.textContent =
              "Showing last saved GOV snapshot — live refresh failed or was rate-limited.";
          } else {
            nationalStaleBanner.hidden = true;
            nationalStaleBanner.textContent = "";
          }
        }
      }
      renderFuelCardBlocks();
    }

    async function loadNationalMetrics() {
      if (!nationalStatusEl || !nationalCardsEl) return { ok: false };
      var base = String(window.FUEL_FINDER_PROXY_BASE || "").replace(/\/$/, "");
      if (!base) {
        nationalStatusEl.textContent = "No API URL.";
        return { ok: false };
      }
      var headers = { Accept: "application/json" };
      if (window.FuelAuth && typeof window.FuelAuth.authHeaders === "function") {
        headers = window.FuelAuth.authHeaders();
      }
      nationalStatusEl.textContent = "Loading national metrics…";
      try {
        var res = await fetch(base + "/dashboard/fuel-metrics/national?_=" + String(Date.now()), {
          headers: headers,
          cache: "no-store",
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || "Could not load national metrics");
        lastNationalPayload = data;
        renderNationalFromPayload();
        var hours =
          data.priceFreshnessMaxAgeHours != null && Number.isFinite(Number(data.priceFreshnessMaxAgeHours))
            ? Number(data.priceFreshnessMaxAgeHours) : 96;
        if (data.snapshotCatalogStale) {
          nationalStatusEl.textContent =
            "Saved GOV snapshot is older than " + hours + " h. Refresh to load recent data.";
        } else {
          var cap = data.capturedAt || (data.snapshot && data.snapshot.capturedAt) || "";
          if (cap) {
            var d = new Date(cap);
            var tot = data.totals && typeof data.totals === "object" ? data.totals : {};
            var nFresh = Number(tot.stationCount);
            var line = "Snapshot: " + (isNaN(d.getTime()) ? cap : d.toLocaleString("en-GB"));
            line += " · " + (Number.isFinite(nFresh) ? nFresh : 0) + " stations with fresh B7 prices";
            nationalStatusEl.textContent = line;
          } else {
            nationalStatusEl.textContent = "No snapshot yet.";
          }
        }
        return { ok: true };
      } catch (err) {
        nationalStatusEl.textContent =
          (err && err.message ? err.message : "Could not load national metrics") + ".";
        return { ok: false };
      }
    }

    var nationalTop5Btn = document.getElementById("dash-national-top5-btn");
    if (nationalTop5Btn) {
      nationalTop5Btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        nationalTop5Btn.disabled = true;
        nationalTop5Btn.textContent = "Loading…";
        loadNationalMetrics()
          .then(function (r) {
            if (r && r.ok) openNationalTopFive("total", null);
          })
          .finally(function () {
            nationalTop5Btn.disabled = false;
            nationalTop5Btn.textContent = LIST_TOP5_BTN_LABEL;
          });
      });
    }

    var origSetVatOn = setVatOn;
    setVatOn = function (on) {
      origSetVatOn(on);
      renderNationalFromPayload();
    };

    /* ────────────────────────────────────────────── */

    window.refuelReloadFromUser = function () {
      var u = window.__FUEL_USER__;
      if (!u) return;
      var incoming = loadState(u);
      state.fuelCards = incoming.fuelCards;
      render();
      loadDashboardMetrics();
      loadNationalMetrics();
      if (typeof window.refuelProfileLocalStations === "function") {
        window.refuelProfileLocalStations();
      }
    };

    window.refuelDashboardMetrics = loadDashboardMetrics;
    window.refuelNationalMetrics = loadNationalMetrics;

    render();
    loadDashboardMetrics();
    loadNationalMetrics();
  };
})();

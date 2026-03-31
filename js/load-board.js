(function () {
  "use strict";

  function apiBase() {
    return String(window.FUEL_FINDER_PROXY_BASE || "").replace(/\/$/, "");
  }

  function authHeaders() {
    var token = window.FuelAuth && typeof window.FuelAuth.getToken === "function"
      ? window.FuelAuth.getToken()
      : "";
    var headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (token) headers.Authorization = "Bearer " + token;
    return headers;
  }

  /** One retry after refresh so expired Supabase sessions still work with the load-board API. */
  async function fetchWithAuthRetry(url, options) {
    var opts = options || {};
    var res = await fetch(url, opts);
    if (
      res.status === 401 &&
      window.FuelAuth &&
      typeof window.FuelAuth.tryRefresh === "function"
    ) {
      var ok = await window.FuelAuth.tryRefresh();
      if (ok) {
        var merged = Object.assign({}, opts, { headers: authHeaders() });
        res = await fetch(url, merged);
      }
    }
    return res;
  }

  function status(el, message, isError) {
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || "";
    el.classList.toggle("profile-status--error", Boolean(isError));
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString();
  }

  function normalizePostcode(input) {
    return String(input || "").trim().toUpperCase();
  }

  function routeLabelWithPostcode(label, postcode) {
    var p = normalizePostcode(postcode);
    if (!label) return p;
    if (!p) return label;
    if (String(label).toUpperCase().indexOf(p) >= 0) return label;
    return label + " (" + p + ")";
  }

  function tailLiftDisplayLine(item) {
    var labels = {
      none: "No tail lift needed",
      standard: "Standard tail lift",
      heavy: "Heavy-duty tail lift",
      platform: "Full platform lift",
      pallet_truck: "Pallet truck only (no vehicle tail lift)",
      tbc: "To be confirmed with site",
      other: "Other (see notes)",
    };
    var key = item && item.tailLiftOption ? String(item.tailLiftOption).trim() : "";
    if (key) return "Tail lift: " + (labels[key] || key);
    if (item.tailLiftRequired === true) return "Tail lift: Required";
    if (item.tailLiftRequired === false) return "Tail lift: Not required";
    return "";
  }

  function escapeHtml(input) {
    return String(input || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Miles for display: new field or legacy km converted. */
  function mileageMilesForDisplay(item) {
    if (!item) return null;
    if (item.mileageMiles != null && !Number.isNaN(Number(item.mileageMiles))) return Number(item.mileageMiles);
    if (item.mileageKm != null && !Number.isNaN(Number(item.mileageKm))) return Number(item.mileageKm) * 0.621371;
    return null;
  }

  function formatMiles(value) {
    var n = Number(value);
    if (Number.isNaN(n)) return null;
    var rounded = Math.round(n * 10) / 10;
    return rounded % 1 === 0 ? String(Math.round(rounded)) : String(rounded);
  }

  var LOAD_SAVED_IDS_KEY = "fuelLoadBoardSavedIds";
  var LOAD_DRAFT_KEY = "fuelLoadBoardPostDraft";

  function normalizeLoadId(id) {
    return id == null ? "" : String(id).trim();
  }

  function normalizeIdsArray(ids) {
    if (!Array.isArray(ids)) return [];
    var out = [];
    var seen = {};
    for (var i = 0; i < ids.length; i++) {
      var id = normalizeLoadId(ids[i]);
      if (!id || seen[id]) continue;
      seen[id] = true;
      out.push(id);
    }
    return out;
  }

  function readSavedIdsFromLocal() {
    try {
      var raw = localStorage.getItem(LOAD_SAVED_IDS_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return normalizeIdsArray(parsed);
    } catch (e) {
      return [];
    }
  }

  function writeSavedIdsToLocal(ids) {
    try {
      localStorage.setItem(LOAD_SAVED_IDS_KEY, JSON.stringify(ids));
      return true;
    } catch (e) {
      return false;
    }
  }

  function savedIdSetFromIds(ids) {
    var o = {};
    for (var i = 0; i < ids.length; i++) o[ids[i]] = true;
    return o;
  }

  function readFormDraftLocal() {
    try {
      var raw = localStorage.getItem(LOAD_DRAFT_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      if (Object.keys(parsed).length === 0) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  /** @returns {boolean} */
  function writeFormDraftLocal(draft) {
    try {
      if (!draft || typeof draft !== "object" || Array.isArray(draft)) return false;
      if (Object.keys(draft).length === 0) return false;
      localStorage.setItem(LOAD_DRAFT_KEY, JSON.stringify(draft));
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearFormDraftLocal() {
    try {
      localStorage.removeItem(LOAD_DRAFT_KEY);
    } catch (e) {}
  }

  function snapshotForm(form) {
    var out = {};
    if (!form || !form.elements) return out;
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el || !el.name || el.disabled) return;
      var tag = String(el.tagName || "").toLowerCase();
      var type = String(el.type || "").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") return;
      if (type === "checkbox") {
        out[el.name] = el.checked ? "1" : "";
        return;
      }
      if (type === "radio") {
        if (el.checked) out[el.name] = el.value;
        return;
      }
      if (tag === "select" || tag === "textarea" || tag === "input") {
        out[el.name] = String(el.value || "");
      }
    });
    return out;
  }

  function applyFormSnapshot(form, data) {
    if (!form || !form.elements || !data || typeof data !== "object" || Array.isArray(data)) return;
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el || !el.name || !Object.prototype.hasOwnProperty.call(data, el.name)) return;
      var type = String(el.type || "").toLowerCase();
      if (type === "checkbox") {
        el.checked = String(data[el.name] || "") === "1";
        return;
      }
      if (type === "radio") {
        el.checked = String(data[el.name] || "") === String(el.value || "");
        return;
      }
      el.value = String(data[el.name] || "");
    });
  }

  function loadMatchesSearchFilters(item, q) {
    var c = normalizePostcode(q.collection || "");
    var d = normalizePostcode(q.delivery || "");
    var r = String(q.ref || "").trim().toLowerCase();
    if (c && String(item.originPostcode || "").toUpperCase().indexOf(c) < 0) return false;
    if (d && String(item.destinationPostcode || "").toUpperCase().indexOf(d) < 0) return false;
    if (r && String(item.referenceNo || "").toLowerCase().indexOf(r) < 0) return false;
    return true;
  }

  /** Server requires `pickupDate`; derive from schedule fields. */
  function assignPickupDateForPayload(payload) {
    if (!payload || typeof payload !== "object") return;
    if (payload.pickupScheduleType === "by") {
      payload.pickupDate = payload.pickupByDate || "";
    } else if (payload.pickupScheduleType === "on") {
      payload.pickupDate = payload.pickupOnDate || "";
    } else {
      payload.pickupDate = payload.pickupDateFrom || payload.pickupDateTo || "";
    }
  }

  function loadBelongsToUser(item, user) {
    if (!item || !user) return false;
    var postedBy = item.postedBy || {};
    var userId = String(user.id || "").trim();
    var userEmail = String(user.email || "").trim().toLowerCase();
    if (userId && String(postedBy.userId || "").trim() === userId) return true;
    if (userEmail && String(postedBy.email || "").trim().toLowerCase() === userEmail) return true;
    return false;
  }

  function renderLoad(item, ctx) {
    ctx = ctx || {};
    var showSaveToggle = ctx.showSaveToggle !== false;
    var savedIdSet = ctx.savedIdSet || {};
    var saveBtn = "";
    if (showSaveToggle && item && item.id) {
      var isSaved = !!savedIdSet[item.id];
      saveBtn =
        '<p class="load-board-card__actions"><button type="button" class="btn btn-ghost load-board__toggle-save" data-load-id="' +
        escapeHtml(item.id) +
        '" aria-pressed="' +
        (isSaved ? "true" : "false") +
        '">' +
        (isSaved ? "Saved" : "Save load") +
        "</button></p>";
    }
    var postedBy = item && item.postedBy ? item.postedBy : {};
    var originLabel = routeLabelWithPostcode(item.origin || "", item.originPostcode);
    var destinationLabel = routeLabelWithPostcode(item.destination || "", item.destinationPostcode);
    var pickupLine = "";
    if (item.pickupScheduleType === "by") {
      pickupLine = "Pickup by: " + [item.pickupByDate || item.pickupDateTo || item.pickupDateFrom || item.pickupDate, item.pickupByTime || ""].join(" ").trim();
    } else if (item.pickupScheduleType === "on") {
      pickupLine = "Pickup on: " + [item.pickupOnDate || item.pickupDateFrom || item.pickupDateTo || "", item.pickupOnTime || ""].join(" ").trim();
    } else {
      var pickupDateRange = "";
      if (item.pickupDateFrom || item.pickupDateTo) {
        pickupDateRange = (item.pickupDateFrom || "?") + " to " + (item.pickupDateTo || "?");
      } else {
        pickupDateRange = item.pickupDate || "";
      }
      pickupLine =
        "Pickup window: " +
        [pickupDateRange, (item.pickupTimeFrom || "--:--") + " - " + (item.pickupTimeTo || "--:--")]
          .join(" ")
          .trim();
    }
    var deliveryLine = "";
    if (item.deliveryScheduleType === "asap") {
      deliveryLine = "Delivery: ASAP / Direct";
    } else if (item.deliveryScheduleType === "by") {
      deliveryLine = "Deliver by: " + [item.deliveryByDate || item.deliveryDate || "", item.deliveryByTime || ""].join(" ").trim();
    } else if (item.deliveryScheduleType === "on") {
      deliveryLine = "Deliver on: " + [item.deliveryOnDate || item.deliveryDate || "", item.deliveryOnTime || ""].join(" ").trim();
    } else if (item.deliveryDate || item.deliveryTimeFrom || item.deliveryTimeTo) {
      deliveryLine =
        "Delivery window: " +
        [item.deliveryDate || "", (item.deliveryTimeFrom || "--:--") + " - " + (item.deliveryTimeTo || "--:--")]
          .join(" ")
          .trim();
    }
    return [
      '<li class="dash-list__item">',
      '<p><strong>' + escapeHtml(originLabel) + "</strong> → <strong>" + escapeHtml(destinationLabel) + "</strong></p>",
      '<p class="profile-local-hint">' + escapeHtml(pickupLine || ("Pickup: " + (item.pickupDate || "N/A"))) + "</p>",
      (item.collectionVehicleType ? '<p class="profile-local-hint">Collection vehicle: ' + escapeHtml(item.collectionVehicleType) + "</p>" : ""),
      (item.collectionBodyType ? '<p class="profile-local-hint">Body type: ' + escapeHtml(item.collectionBodyType) + "</p>" : ""),
      (function () {
        var tl = tailLiftDisplayLine(item);
        return tl ? '<p class="profile-local-hint">' + escapeHtml(tl) + "</p>" : "";
      })(),
      (item.tailLiftTuckUnder === true
        ? '<p class="profile-local-hint">' + escapeHtml("Tail lift: Must be tuck-under") + "</p>"
        : ""),
      (item.tailLiftHandrails === true
        ? '<p class="profile-local-hint">' + escapeHtml("Tail lift: Must have handrails") + "</p>"
        : ""),
      (deliveryLine ? '<p class="profile-local-hint">' + escapeHtml(deliveryLine) + "</p>" : ""),
      '<p class="profile-local-hint">Type: ' + escapeHtml(item.loadType || "Not specified") + "</p>",
      (item.loadSize ? '<p class="profile-local-hint">Load size: ' + escapeHtml(item.loadSize) + "</p>" : ""),
      (item.weightKg != null ? '<p class="profile-local-hint">Weight: ' + escapeHtml(item.weightKg) + " kg</p>" : ""),
      (item.volumeM3 != null ? '<p class="profile-local-hint">Volume: ' + escapeHtml(item.volumeM3) + " m3</p>" : ""),
      (item.lengthM != null ? '<p class="profile-local-hint">Length: ' + escapeHtml(item.lengthM) + " m</p>" : ""),
      (item.pallets != null ? '<p class="profile-local-hint">Pallets: ' + escapeHtml(item.pallets) + "</p>" : ""),
      (function () {
        var mi = mileageMilesForDisplay(item);
        if (mi == null) return "";
        var s = formatMiles(mi);
        return s ? '<p class="profile-local-hint">Mileage: ' + escapeHtml(s) + " miles</p>" : "";
      })(),
      (item.pricingMode === "bids"
        ? '<p class="profile-local-hint">Pricing: Accepting bids</p>'
        : item.rateAmount != null
          ? '<p class="profile-local-hint">Rate (ex VAT): ' + escapeHtml(item.currency || "GBP") + " " + escapeHtml(item.rateAmount) + "</p>"
          : ""),
      (item.referenceNo ? '<p class="profile-local-hint">Ref: ' + escapeHtml(item.referenceNo) + "</p>" : ""),
      (item.notes ? '<p class="profile-local-hint">Notes: ' + escapeHtml(item.notes) + "</p>" : ""),
      saveBtn,
      '<p class="profile-local-hint">Posted by: ' + escapeHtml(postedBy.name || postedBy.email || "Unknown") + " · " + escapeHtml(fmtDate(item.createdAt)) + "</p>",
      "</li>",
    ].join("");
  }

  async function fetchLoads() {
    var res = await fetchWithAuthRetry(apiBase() + "/load-board/loads", {
      method: "GET",
      headers: authHeaders(),
    });
    var data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) throw new Error(data.error || "Could not load board");
    return Array.isArray(data.loads) ? data.loads : [];
  }

  async function postLoad(payload) {
    var res = await fetchWithAuthRetry(apiBase() + "/load-board/loads", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    var data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) throw new Error(data.error || "Could not post load");
    return data.load || null;
  }

  async function lookupPostcode(postcode) {
    var code = normalizePostcode(postcode);
    if (!code) return null;
    var res = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(code), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    var data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok || data.status !== 200 || !data.result) {
      throw new Error("Postcode lookup failed");
    }
    return data.result;
  }

  function localityLabel(result, fallbackPostcode) {
    if (!result || typeof result !== "object") return normalizePostcode(fallbackPostcode);
    var town = String(result.post_town || "").trim();
    var district = String(result.admin_district || "").trim();
    var postcode = normalizePostcode(result.postcode || fallbackPostcode);
    var pieces = [];
    if (town) pieces.push(town);
    if (district && district.toLowerCase() !== town.toLowerCase()) pieces.push(district);
    if (postcode) pieces.push(postcode);
    return pieces.join(", ");
  }

  function valuesFromForm(form) {
    var fd = new FormData(form);
    var o = {
      origin: "",
      destination: "",
      originPostcode: normalizePostcode(fd.get("originPostcode") || ""),
      destinationPostcode: normalizePostcode(fd.get("destinationPostcode") || ""),
      pickupDate: "",
      pickupDateFrom: String(fd.get("pickupDateFrom") || "").trim(),
      pickupDateTo: String(fd.get("pickupDateTo") || "").trim(),
      pickupTimeFrom: String(fd.get("pickupTimeFrom") || "").trim(),
      pickupTimeTo: String(fd.get("pickupTimeTo") || "").trim(),
      pickupScheduleType: String(fd.get("pickupScheduleType") || "between").trim(),
      pickupByDate: String(fd.get("pickupByDate") || "").trim(),
      pickupByTime: String(fd.get("pickupByTime") || "").trim(),
      pickupOnDate: String(fd.get("pickupOnDate") || "").trim(),
      pickupOnTime: String(fd.get("pickupOnTime") || "").trim(),
      collectionVehicleType: String(fd.get("collectionVehicleType") || "").trim(),
      collectionBodyType: String(fd.get("collectionBodyType") || "").trim(),
      tailLiftOption: String(fd.get("tailLiftOption") || "none").trim(),
      tailLiftTuckUnder: fd.get("tailLiftTuckUnder") === "1" || fd.get("tailLiftTuckUnder") === "on",
      tailLiftHandrails: fd.get("tailLiftHandrails") === "1" || fd.get("tailLiftHandrails") === "on",
      deliveryDate: String(fd.get("deliveryDate") || "").trim(),
      deliveryTimeFrom: String(fd.get("deliveryTimeFrom") || "").trim(),
      deliveryTimeTo: String(fd.get("deliveryTimeTo") || "").trim(),
      deliveryScheduleType: String(fd.get("deliveryScheduleType") || "between").trim(),
      deliveryByDate: String(fd.get("deliveryByDate") || "").trim(),
      deliveryByTime: String(fd.get("deliveryByTime") || "").trim(),
      deliveryOnDate: String(fd.get("deliveryOnDate") || "").trim(),
      deliveryOnTime: String(fd.get("deliveryOnTime") || "").trim(),
      loadType: String(fd.get("loadType") || "").trim(),
      loadSize: String(fd.get("loadSize") || "").trim(),
      weightKg: fd.get("weightKg") !== "" ? Number(fd.get("weightKg")) : null,
      volumeM3: fd.get("volumeM3") !== "" ? Number(fd.get("volumeM3")) : null,
      lengthM: fd.get("lengthM") !== "" ? Number(fd.get("lengthM")) : null,
      pallets: fd.get("pallets") !== "" ? Number(fd.get("pallets")) : null,
      mileageMiles: fd.get("mileageMiles") !== "" ? Number(fd.get("mileageMiles")) : null,
      pricingMode: (function () {
        var m = String(fd.get("pricingMode") || "fixed").trim().toLowerCase();
        return m === "bids" ? "bids" : "fixed";
      })(),
      rateAmount: fd.get("rateAmount") !== "" ? Number(fd.get("rateAmount")) : null,
      currency: String(fd.get("currency") || "").trim().toUpperCase(),
      referenceNo: String(fd.get("referenceNo") || "").trim(),
      notes: String(fd.get("notes") || "").trim(),
    };
    if (o.pricingMode === "bids") {
      o.rateAmount = null;
      o.currency = "";
    }
    return o;
  }

  function bind() {
    var form = document.getElementById("load-board-form");
    var list = document.getElementById("load-board-list");
    var empty = document.getElementById("load-board-empty");
    var noMatchEl = document.getElementById("load-board-search-no-match");
    var searchStatusEl = document.getElementById("load-board-search-status");
    var savedListEl = document.getElementById("load-board-saved-list");
    var savedEmptyEl = document.getElementById("load-board-saved-empty");
    var mineListEl = document.getElementById("load-board-mine-list");
    var mineEmptyEl = document.getElementById("load-board-mine-empty");
    var panelPost = document.getElementById("load-panel-post");
    var panelSearch = document.getElementById("load-panel-search");
    var panelSaved = document.getElementById("load-panel-saved");
    var panelMine = document.getElementById("load-panel-mine");
    var tabButtons = document.querySelectorAll("[data-load-tab]");
    var searchCollectionInput = document.getElementById("load-search-collection");
    var searchDeliveryInput = document.getElementById("load-search-delivery");
    var searchRefInput = document.getElementById("load-search-ref");
    var statusEl = document.getElementById("load-board-status");
    var submitBtn = document.getElementById("load-board-submit");
    var submitSavePostBtn = document.getElementById("load-board-submit-save-post");
    var saveDraftBtn = document.getElementById("load-board-save-draft");
    var originPostcodeInput = document.getElementById("load-origin-postcode");
    var destinationPostcodeInput = document.getElementById("load-destination-postcode");
    var originLookupStatus = document.getElementById("load-origin-lookup-status");
    var destinationLookupStatus = document.getElementById("load-destination-lookup-status");
    var pickupScheduleTypeSel = document.getElementById("load-pickup-schedule-type");
    var deliveryScheduleTypeSel = document.getElementById("load-delivery-schedule-type");
    var pickupDateFromField = document.getElementById("pickup-date-from-field");
    var pickupDateToField = document.getElementById("pickup-date-to-field");
    var pickupTimeFromField = document.getElementById("pickup-time-from-field");
    var pickupTimeToField = document.getElementById("pickup-time-to-field");
    var pickupByDateField = document.getElementById("pickup-by-date-field");
    var pickupByTimeField = document.getElementById("pickup-by-time-field");
    var pickupOnDateField = document.getElementById("pickup-on-date-field");
    var pickupOnTimeField = document.getElementById("pickup-on-time-field");
    var deliveryDateField = document.getElementById("delivery-date-field");
    var deliveryTimeFromField = document.getElementById("delivery-time-from-field");
    var deliveryTimeToField = document.getElementById("delivery-time-to-field");
    var deliveryByDateField = document.getElementById("delivery-by-date-field");
    var deliveryByTimeField = document.getElementById("delivery-by-time-field");
    var deliveryOnDateField = document.getElementById("delivery-on-date-field");
    var deliveryOnTimeField = document.getElementById("delivery-on-time-field");
    var collectionVehicleInput = document.getElementById("load-collection-vehicle-type");
    var pricingModeSel = document.getElementById("load-pricing-mode");
    var rateFieldsWrap = document.getElementById("load-rate-fields");
    var vehicleGroupTabs = document.querySelectorAll(".load-vehicle-picker__tab[data-vehicle-group]");
    var vehicleOptions = document.querySelectorAll(".load-vehicle-option[data-vehicle-group][data-vehicle-value]");
    if (!form || !list) return;

    var savedIdsCache = readSavedIdsFromLocal();
    var useRemotePrefs = false;

    async function runHydrateOnce() {
      var wasRemote = useRemotePrefs;
      var token = window.FuelAuth && typeof window.FuelAuth.getToken === "function" ? window.FuelAuth.getToken() : "";
      if (!token) {
        useRemotePrefs = false;
        return;
      }
      try {
        var res = await fetchWithAuthRetry(apiBase() + "/load-board/saved-ids", {
          method: "GET",
          headers: authHeaders(),
        });
        if (res.status === 200) {
          var data = await res.json();
          if (Array.isArray(data.ids)) {
            var serverIds = normalizeIdsArray(data.ids);
            if (!wasRemote) {
              var merged = normalizeIdsArray(serverIds.concat(savedIdsCache));
              savedIdsCache = merged;
              useRemotePrefs = true;
              var same =
                merged.length === serverIds.length &&
                merged.every(function (id, idx) {
                  return id === serverIds[idx];
                });
              if (!same) {
                var putRes = await fetchWithAuthRetry(apiBase() + "/load-board/saved-ids", {
                  method: "PUT",
                  headers: authHeaders(),
                  body: JSON.stringify({ ids: savedIdsCache }),
                });
                if (!putRes.ok) {
                  writeSavedIdsToLocal(savedIdsCache);
                }
              }
              return;
            }
            savedIdsCache = serverIds;
            useRemotePrefs = true;
            return;
          }
        }
        if (res.status === 501) {
          useRemotePrefs = false;
          return;
        }
      } catch (e) {}
      useRemotePrefs = false;
    }

    var prefsReady = runHydrateOnce();

    async function retryHydrateRemote() {
      await prefsReady;
      if (useRemotePrefs) return;
      var tok = window.FuelAuth && window.FuelAuth.getToken ? window.FuelAuth.getToken() : "";
      if (!tok) return;
      await runHydrateOnce();
    }

    function readSavedIds() {
      return savedIdsCache.slice();
    }

    async function writeSavedIds(ids) {
      await prefsReady;
      savedIdsCache = normalizeIdsArray(ids);
      if (!useRemotePrefs) {
        writeSavedIdsToLocal(savedIdsCache);
        return;
      }
      var res = await fetchWithAuthRetry(apiBase() + "/load-board/saved-ids", {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ ids: savedIdsCache }),
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) throw new Error(data.error || "Could not save saved loads");
    }

    async function toggleSavedId(id) {
      id = normalizeLoadId(id);
      if (!id) return;
      var ids = savedIdsCache.slice();
      var idx = ids.indexOf(id);
      if (idx >= 0) ids.splice(idx, 1);
      else ids.push(id);
      await writeSavedIds(ids);
    }

    async function addSavedId(id) {
      id = normalizeLoadId(id);
      if (!id) return;
      if (savedIdsCache.indexOf(id) >= 0) return;
      await writeSavedIds(savedIdsCache.concat([id]));
    }

    async function getDraftForRestore() {
      await prefsReady;
      if (useRemotePrefs) {
        try {
          var res = await fetchWithAuthRetry(apiBase() + "/load-board/post-draft", {
            method: "GET",
            headers: authHeaders(),
          });
          if (res.status === 200) {
            var data = await res.json();
            var d = data && data.draft;
            if (d && typeof d === "object" && !Array.isArray(d) && Object.keys(d).length > 0) {
              return d;
            }
          }
        } catch (e) {}
        return readFormDraftLocal();
      }
      return readFormDraftLocal();
    }

    async function clearDraft() {
      await prefsReady;
      if (useRemotePrefs) {
        try {
          var delRes = await fetchWithAuthRetry(apiBase() + "/load-board/post-draft", {
            method: "DELETE",
            headers: authHeaders(),
          });
          void delRes;
        } catch (e) {}
      }
      clearFormDraftLocal();
    }

    async function persistDraft(snap) {
      await prefsReady;
      if (useRemotePrefs) {
        var res = await fetchWithAuthRetry(apiBase() + "/load-board/post-draft", {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify({ draft: snap }),
        });
        var data = await res.json().catch(function () {
          return {};
        });
        if (!res.ok) throw new Error(data.error || "Could not save draft");
        return;
      }
      if (!writeFormDraftLocal(snap)) {
        throw new Error("Could not save draft locally");
      }
    }

    var allLoads = [];
    var currentUser = window.__FUEL_USER__ || null;

    var geoCache = {
      originPostcode: "",
      originLat: null,
      originLng: null,
      destinationPostcode: "",
      destinationLat: null,
      destinationLng: null,
    };

    function setHint(el, message, isError) {
      if (!el) return;
      el.hidden = !message;
      el.textContent = message || "";
      el.classList.toggle("profile-status--error", Boolean(isError));
    }

    function showField(el, on) {
      if (!el) return;
      el.style.display = on ? "" : "none";
    }

    function setVehicleGroup(group) {
      vehicleGroupTabs.forEach(function (tab) {
        tab.classList.toggle("is-active", tab.getAttribute("data-vehicle-group") === group);
      });
      vehicleOptions.forEach(function (opt) {
        var same = opt.getAttribute("data-vehicle-group") === group;
        opt.hidden = !same;
      });
    }

    function setVehicleValue(value) {
      if (collectionVehicleInput) collectionVehicleInput.value = value || "";
      vehicleOptions.forEach(function (opt) {
        opt.classList.toggle("is-selected", opt.getAttribute("data-vehicle-value") === value);
      });
    }

    function vehicleGroupForValue(value) {
      var found = "van";
      vehicleOptions.forEach(function (opt) {
        if (opt.getAttribute("data-vehicle-value") === value) {
          found = opt.getAttribute("data-vehicle-group") || "van";
        }
      });
      return found;
    }

    function updatePricingFields() {
      var fixed = !pricingModeSel || pricingModeSel.value === "fixed";
      showField(rateFieldsWrap, fixed);
    }

    function updateScheduleFields() {
      var pickupType = pickupScheduleTypeSel ? pickupScheduleTypeSel.value : "between";
      var pickupBy = pickupType === "by";
      var pickupOn = pickupType === "on";
      var pickupBetween = !pickupBy && !pickupOn;
      showField(pickupDateFromField, pickupBetween);
      showField(pickupDateToField, pickupBetween);
      showField(pickupTimeFromField, pickupBetween);
      showField(pickupTimeToField, pickupBetween);
      showField(pickupByDateField, pickupBy);
      showField(pickupByTimeField, pickupBy);
      showField(pickupOnDateField, pickupOn);
      showField(pickupOnTimeField, pickupOn);

      var deliveryType = deliveryScheduleTypeSel ? deliveryScheduleTypeSel.value : "between";
      var deliveryBy = deliveryType === "by";
      var deliveryOn = deliveryType === "on";
      var deliveryAsap = deliveryType === "asap";
      var deliveryBetween = !deliveryBy && !deliveryOn && !deliveryAsap;
      showField(deliveryDateField, deliveryBetween);
      showField(deliveryTimeFromField, deliveryBetween);
      showField(deliveryTimeToField, deliveryBetween);
      showField(deliveryByDateField, deliveryBy);
      showField(deliveryByTimeField, deliveryBy);
      showField(deliveryOnDateField, deliveryOn);
      showField(deliveryOnTimeField, deliveryOn);
    }

    async function applyLookup(kind) {
      var isOrigin = kind === "origin";
      var pcInput = isOrigin ? originPostcodeInput : destinationPostcodeInput;
      var hintEl = isOrigin ? originLookupStatus : destinationLookupStatus;
      if (!pcInput) return;

      var code = normalizePostcode(pcInput.value);
      if (!code) {
        if (isOrigin) {
          geoCache.originPostcode = "";
          geoCache.originLat = null;
          geoCache.originLng = null;
        } else {
          geoCache.destinationPostcode = "";
          geoCache.destinationLat = null;
          geoCache.destinationLng = null;
        }
        setHint(hintEl, "");
        return;
      }

      setHint(hintEl, "Looking up postcode...");
      try {
        var result = await lookupPostcode(code);
        var label = localityLabel(result, code);
        pcInput.value = normalizePostcode(result.postcode || code);
        if (isOrigin) {
          geoCache.originPostcode = normalizePostcode(result.postcode || code);
          geoCache.originLat = Number(result.latitude);
          geoCache.originLng = Number(result.longitude);
        } else {
          geoCache.destinationPostcode = normalizePostcode(result.postcode || code);
          geoCache.destinationLat = Number(result.latitude);
          geoCache.destinationLng = Number(result.longitude);
        }
        setHint(hintEl, "Matched: " + label);
      } catch (err) {
        if (isOrigin) {
          geoCache.originPostcode = "";
          geoCache.originLat = null;
          geoCache.originLng = null;
        } else {
          geoCache.destinationPostcode = "";
          geoCache.destinationLat = null;
          geoCache.destinationLng = null;
        }
        setHint(hintEl, "Postcode not found. Check and try again.", true);
      }
    }

    if (originPostcodeInput) {
      originPostcodeInput.addEventListener("blur", function () {
        applyLookup("origin");
      });
    }
    if (destinationPostcodeInput) {
      destinationPostcodeInput.addEventListener("blur", function () {
        applyLookup("destination");
      });
    }
    if (pickupScheduleTypeSel) {
      pickupScheduleTypeSel.addEventListener("change", updateScheduleFields);
    }
    if (deliveryScheduleTypeSel) {
      deliveryScheduleTypeSel.addEventListener("change", updateScheduleFields);
    }
    if (pricingModeSel) {
      pricingModeSel.addEventListener("change", updatePricingFields);
    }
    vehicleGroupTabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        setVehicleGroup(tab.getAttribute("data-vehicle-group") || "van");
      });
    });
    vehicleOptions.forEach(function (opt) {
      opt.addEventListener("click", function () {
        var group = opt.getAttribute("data-vehicle-group") || "van";
        var value = opt.getAttribute("data-vehicle-value") || "";
        setVehicleGroup(group);
        setVehicleValue(value);
      });
    });
    setVehicleGroup("van");
    setVehicleValue(collectionVehicleInput ? collectionVehicleInput.value : "");
    updateScheduleFields();
    updatePricingFields();

    function getSearchQuery() {
      return {
        collection: searchCollectionInput ? String(searchCollectionInput.value || "").trim() : "",
        delivery: searchDeliveryInput ? String(searchDeliveryInput.value || "").trim() : "",
        ref: searchRefInput ? String(searchRefInput.value || "").trim() : "",
      };
    }

    function renderSearchResults() {
      var q = getSearchQuery();
      var filtered = allLoads.filter(function (item) {
        return loadMatchesSearchFilters(item, q);
      });
      var savedIds = readSavedIds();
      var set = savedIdSetFromIds(savedIds);
      list.innerHTML = filtered
        .map(function (item) {
          return renderLoad(item, { showSaveToggle: true, savedIdSet: set });
        })
        .join("");
      if (empty) empty.hidden = allLoads.length > 0;
      if (noMatchEl) noMatchEl.hidden = !(allLoads.length > 0 && filtered.length === 0);
    }

    async function renderSavedResults() {
      var savedIds = readSavedIds();
      var byId = {};
      allLoads.forEach(function (L) {
        if (L && L.id != null) {
          byId[normalizeLoadId(L.id)] = L;
        }
      });
      var keptIds = [];
      var savedLoads = [];
      for (var i = 0; i < savedIds.length; i++) {
        var sid = savedIds[i];
        var L = byId[sid];
        if (L) {
          savedLoads.push(L);
          keptIds.push(sid);
        }
      }
      if (keptIds.length !== savedIds.length) {
        try {
          await writeSavedIds(keptIds);
        } catch (e) {}
      }
      var set = savedIdSetFromIds(keptIds);
      if (savedListEl) {
        savedListEl.innerHTML = savedLoads
          .map(function (item) {
            return renderLoad(item, { showSaveToggle: true, savedIdSet: set });
          })
          .join("");
      }
      if (savedEmptyEl) {
        savedEmptyEl.hidden = savedLoads.length > 0;
        if (savedLoads.length === 0) {
          if (savedIds.length > 0 && keptIds.length === 0) {
            savedEmptyEl.textContent =
              "Saved references could not be found (loads may have been removed). Save again from Search.";
          } else {
            savedEmptyEl.textContent = "No saved loads yet.";
          }
        } else {
          savedEmptyEl.textContent = "No saved loads yet.";
        }
      }
    }

    function renderMyPostedResults() {
      var mine = allLoads.filter(function (item) {
        return loadBelongsToUser(item, currentUser);
      });
      var savedSet = savedIdSetFromIds(readSavedIds());
      if (mineListEl) {
        mineListEl.innerHTML = mine
          .map(function (item) {
            return renderLoad(item, { showSaveToggle: true, savedIdSet: savedSet });
          })
          .join("");
      }
      if (mineEmptyEl) mineEmptyEl.hidden = mine.length > 0;
    }

    function setActiveTab(tab) {
      tabButtons.forEach(function (btn) {
        var t = btn.getAttribute("data-load-tab");
        var active = t === tab;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
        btn.tabIndex = active ? 0 : -1;
      });
      if (panelPost) panelPost.hidden = tab !== "post";
      if (panelSearch) panelSearch.hidden = tab !== "search";
      if (panelSaved) panelSaved.hidden = tab !== "saved";
      if (panelMine) panelMine.hidden = tab !== "mine";
    }

    tabButtons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var tab = btn.getAttribute("data-load-tab");
        if (!tab) return;
        setActiveTab(tab);
        if (tab === "saved") {
          void renderSavedResults();
        }
      });
    });

    function onSearchInput() {
      renderSearchResults();
    }
    if (searchCollectionInput) searchCollectionInput.addEventListener("input", onSearchInput);
    if (searchDeliveryInput) searchDeliveryInput.addEventListener("input", onSearchInput);
    if (searchRefInput) searchRefInput.addEventListener("input", onSearchInput);

    function bindSaveToggles(root) {
      if (!root) return;
      root.addEventListener("click", function (e) {
        var btn = e.target.closest && e.target.closest(".load-board__toggle-save");
        if (!btn) return;
        var id = btn.getAttribute("data-load-id");
        if (!id) return;
        e.preventDefault();
        void (async function () {
          try {
            await toggleSavedId(id);
            renderSearchResults();
            await renderSavedResults();
            renderMyPostedResults();
          } catch (err) {
            if (searchStatusEl) {
              status(searchStatusEl, err && err.message ? err.message : "Could not update saved loads", true);
            }
          }
        })();
      });
    }
    bindSaveToggles(list);
    bindSaveToggles(savedListEl);
    bindSaveToggles(mineListEl);

    if (saveDraftBtn) {
      saveDraftBtn.addEventListener("click", function () {
        var snap = snapshotForm(form);
        if (Object.keys(snap).length === 0) {
          status(statusEl, "Nothing to save yet — fill some fields first.", true);
          return;
        }
        setActiveTab("post");
        void (async function () {
          try {
            await persistDraft(snap);
            status(statusEl, "Draft saved for future use.");
          } catch (err) {
            status(statusEl, err && err.message ? err.message : "Could not save draft.", true);
          }
        })();
      });
    }

    async function refresh() {
      if (searchStatusEl) status(searchStatusEl, "Loading loads...");
      try {
        await retryHydrateRemote();
        if (!currentUser && window.FuelAuth && typeof window.FuelAuth.me === "function") {
          var u = await window.FuelAuth.me();
          if (u) currentUser = u;
          else if (u === undefined) currentUser = window.__FUEL_USER__ || currentUser;
        }
        allLoads = await fetchLoads();
        if (searchStatusEl) status(searchStatusEl, "");
        renderSearchResults();
        await renderSavedResults();
        renderMyPostedResults();
      } catch (err) {
        if (searchStatusEl) status(searchStatusEl, err && err.message ? err.message : "Could not load board", true);
      }
    }

    async function initLoadBoard() {
      await prefsReady;
      await retryHydrateRemote();
      var existingDraft = await getDraftForRestore();
      if (existingDraft) {
        setActiveTab("post");
        applyFormSnapshot(form, existingDraft);
        setVehicleGroup(vehicleGroupForValue(collectionVehicleInput ? collectionVehicleInput.value : ""));
        setVehicleValue(collectionVehicleInput ? collectionVehicleInput.value : "");
        window.setTimeout(function () {
          updateScheduleFields();
          updatePricingFields();
        }, 0);
        status(statusEl, "Draft restored.");
      }
      await refresh();
    }

    void initLoadBoard();

    async function runLoadPost(saveAfterPost) {
      if (submitBtn) submitBtn.disabled = true;
      if (submitSavePostBtn) submitSavePostBtn.disabled = true;
      status(statusEl, "Posting load...");
      try {
        var payload = valuesFromForm(form);
        if (
          payload.originPostcode &&
          normalizePostcode(payload.originPostcode) !== normalizePostcode(geoCache.originPostcode)
        ) {
          await applyLookup("origin");
        }
        if (
          payload.destinationPostcode &&
          normalizePostcode(payload.destinationPostcode) !== normalizePostcode(geoCache.destinationPostcode)
        ) {
          await applyLookup("destination");
        }

        payload = valuesFromForm(form);
        if (payload.pickupScheduleType === "by") {
          if (!payload.pickupByDate) throw new Error("Please set Pickup by date.");
        } else if (payload.pickupScheduleType === "on") {
          if (!payload.pickupOnDate) throw new Error("Please set Pickup on date.");
        } else if (!payload.pickupDateFrom && !payload.pickupDateTo) {
          throw new Error("Please set Pickup date from/to.");
        }
        if (payload.deliveryScheduleType === "by") {
          if (!payload.deliveryByDate) throw new Error("Please set Deliver by date.");
        } else if (payload.deliveryScheduleType === "on") {
          if (!payload.deliveryOnDate) throw new Error("Please set Deliver on date.");
        }
        if (!payload.originPostcode) {
          throw new Error("Collection postcode is required.");
        }
        if (!payload.destinationPostcode) {
          throw new Error("Delivery postcode is required.");
        }
        assignPickupDateForPayload(payload);
        payload.originLat = geoCache.originLat;
        payload.originLng = geoCache.originLng;
        payload.destinationLat = geoCache.destinationLat;
        payload.destinationLng = geoCache.destinationLng;

        var created = await postLoad(payload);
        if (saveAfterPost && created) {
          var newId = normalizeLoadId(created.id);
          if (newId) await addSavedId(newId);
        }
        await clearDraft();
        form.reset();
        geoCache.originPostcode = "";
        geoCache.originLat = null;
        geoCache.originLng = null;
        geoCache.destinationPostcode = "";
        geoCache.destinationLat = null;
        geoCache.destinationLng = null;
        setHint(originLookupStatus, "");
        setHint(destinationLookupStatus, "");
        setVehicleGroup("van");
        setVehicleValue("");
        updateScheduleFields();
        updatePricingFields();
        status(statusEl, "");
        await refresh();
        setActiveTab(saveAfterPost ? "saved" : "search");
        if (searchStatusEl) {
          status(searchStatusEl, saveAfterPost ? "Load posted and saved." : "Load posted.");
        }
      } catch (err) {
        status(statusEl, err && err.message ? err.message : "Could not post load", true);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
        if (submitSavePostBtn) submitSavePostBtn.disabled = false;
      }
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      runLoadPost(false);
    });

    if (submitSavePostBtn) {
      submitSavePostBtn.addEventListener("click", function () {
        runLoadPost(true);
      });
    }
  }

  document.addEventListener("DOMContentLoaded", bind);
})();

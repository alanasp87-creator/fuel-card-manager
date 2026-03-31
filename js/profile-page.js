/**
 * Profile view — name + read-only email, save via PATCH /auth/profile.
 * Local fuel stations: dashboard.localStations from the server cohort only
 * (savedSource autoRadius — all forecourts within 30 km of operation postcode).
 */
(function () {
  "use strict";

  /** Max total saved stations (large radius can return many forecourts). */
  var MAX_LOCAL_STATIONS = 500;
  /** Operation cohort radius in km (server-owned). */
  var AUTO_RADIUS_KM = 30;

  function formatMemberSince(iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    } catch (e) {
      return "";
    }
  }

  window.initProfilePage = function (user) {
    var form = document.getElementById("profile-form");
    var nameInput = document.getElementById("profile-name");
    var companyInput = document.getElementById("profile-company");
    var emailInput = document.getElementById("profile-email");
    var postcodeInput = document.getElementById("profile-postcode");
    var meta = document.getElementById("profile-meta");
    var status = document.getElementById("profile-status");
    if (!form || !nameInput || !emailInput) return;

    function setStatus(msg, kind) {
      if (!status) return;
      if (!msg) {
        status.hidden = true;
        status.textContent = "";
        return;
      }
      status.textContent = msg;
      status.hidden = false;
      status.className = "profile-status" + (kind ? " profile-status--" + kind : "");
    }

    function dash(u) {
      return u.dashboard && typeof u.dashboard === "object" ? u.dashboard : {};
    }

    function escapeHtml(s) {
      var d = document.createElement("div");
      d.textContent = s;
      return d.innerHTML;
    }

    function stationKindLabel(k) {
      if (k === "supermarket") return "Supermarket";
      if (k === "motorway") return "Motorway";
      if (k === "independent") return "Independent";
      return "";
    }

    function stationKindBadgeHtml(row) {
      var k = row && row.stationKind;
      if (k !== "supermarket" && k !== "motorway" && k !== "independent") return "";
      var lab = stationKindLabel(k);
      if (!lab) return "";
      return (
        '<span class="station-kind station-kind--' +
        escapeHtml(k) +
        '">' +
        escapeHtml(lab) +
        "</span> "
      );
    }

    function normalizeLocalStations(d, ignoreMemory) {
      if (!ignoreMemory && Array.isArray(window.__FUEL_LOCAL_STATIONS__)) {
        d = { localStations: window.__FUEL_LOCAL_STATIONS__ };
      }
      var raw = d && Array.isArray(d.localStations) ? d.localStations : [];
      var out = [];
      var seen = {};
      raw.forEach(function (row) {
        if (!row || typeof row !== "object") return;
        var id = stationKeyFromRow(row);
        if (!id || seen[id]) return;
        seen[id] = true;
        var sk = row.stationKind;
        if (sk !== "supermarket" && sk !== "motorway" && sk !== "independent") {
          sk =
            typeof window.fuelInferStationKind === "function"
              ? window.fuelInferStationKind(row)
              : "independent";
        }
        var src = row.savedSource;
        out.push({
          stationId: id,
          name: String(row.name || "Station").trim().slice(0, 200),
          postcode: String(row.postcode || "").trim().slice(0, 16),
          address: String(row.address || "").trim().slice(0, 300),
          stationKind: sk,
          savedSource: src === "autoRadius" || src === "manual" ? src : undefined,
          distanceKm:
            row.distanceKm != null && Number.isFinite(Number(row.distanceKm))
              ? Number(row.distanceKm)
              : null,
        });
      });
      return out.slice(0, MAX_LOCAL_STATIONS);
    }

    function stationKeyFromRow(row) {
      if (!row || typeof row !== "object") return "";
      var explicit =
        row.stationId != null && String(row.stationId).trim()
          ? String(row.stationId).trim()
          : row.id != null && String(row.id).trim()
            ? String(row.id).trim()
            : "";
      if (explicit) return explicit;
      var name = String(row.name || "").trim().toLowerCase();
      var pc = String(row.postcode || "").replace(/\s+/g, "").toLowerCase();
      return name && pc ? name + ":" + pc : name || pc || "";
    }

    /** Exclude legacy manual adds — UI is auto 30 km cohort only. */
    function onlyAutoStations(rows) {
      if (!rows || !rows.length) return [];
      return rows.filter(function (s) {
        return s.savedSource !== "manual";
      });
    }

    function autoPopulate25MileFromPostcode(pc, statusWhenDone) {
      var clean = String(pc || "")
        .trim()
        .replace(/\s+/g, "")
        .toUpperCase();
      if (!clean) return Promise.resolve(0);
      if (
        typeof window.FuelAuth === "undefined" ||
        typeof window.FuelAuth.patchProfile !== "function"
      ) {
        return Promise.reject(new Error("Auth is not available."));
      }
      setSearchStatus("Refreshing stations within " + AUTO_RADIUS_KM + " km…", false);
      return window.FuelAuth
        .patchProfile({ dashboard: { operationPostcode: clean } })
        .then(function (u) {
          if (u) {
            window.__FUEL_USER__ = u;
            fill(u);
            renderSavedList(u);
          }
          var n = onlyAutoStations(
            normalizeLocalStations(dash(window.__FUEL_USER__ || user), true)
          ).length;
          if (statusWhenDone !== false) {
            setSearchStatus(
              statusWhenDone ||
                "Saved " +
                  n +
                  " station" +
                  (n === 1 ? "" : "s") +
                  " within " +
                  AUTO_RADIUS_KM +
                  " km.",
              false
            );
          }
          return n;
        });
    }

    function fill(u) {
      nameInput.value = u.name || "";
      emailInput.value = u.email || "";
      if (companyInput) {
        companyInput.value = String(dash(u).companyName || "").trim();
      }
      if (postcodeInput) {
        postcodeInput.value = String(dash(u).operationPostcode || "").trim();
      }
      if (meta) {
        var parts = [];
        var co = String(dash(u).companyName || "").trim();
        if (co) parts.push(co);
        var ms = formatMemberSince(u.createdAt);
        if (ms) parts.push("Member since " + ms);
        if (u.isAdmin) parts.push("Administrator");
        meta.textContent = parts.join(" · ");
      }
    }

    fill(user);

    var localSearchStatus = document.getElementById("profile-local-search-status");
    var localSavedList = document.getElementById("profile-local-stations-list");
    var localEmpty = document.getElementById("profile-local-stations-empty");
    var profileKindFilterEl = document.getElementById("profile-local-kind-filter");
    var profileStationKindFilter = "all";

    function updateProfileKindButtons() {
      if (!profileKindFilterEl) return;
      profileKindFilterEl.querySelectorAll("[data-station-kind]").forEach(function (btn) {
        var active = btn.getAttribute("data-station-kind") === profileStationKindFilter;
        btn.classList.toggle("is-active", active);
      });
    }

    function filterProfileRows(rows) {
      if (!rows || !rows.length) return [];
      if (profileStationKindFilter === "all") return rows;
      return rows.filter(function (r) {
        return r.stationKind === profileStationKindFilter;
      });
    }

    function setSearchStatus(msg, isErr) {
      if (!localSearchStatus) return;
      if (!msg) {
        localSearchStatus.hidden = true;
        localSearchStatus.textContent = "";
        localSearchStatus.className = "profile-local-hint";
        return;
      }
      localSearchStatus.textContent = msg;
      localSearchStatus.hidden = false;
      localSearchStatus.className =
        "profile-local-hint" + (isErr ? " profile-local-hint--err" : "");
    }

    function persistLocalStations(next, searchStatusMsg) {
      window.__FUEL_LOCAL_STATIONS__ = next.slice(0, MAX_LOCAL_STATIONS);
      renderSavedList(window.__FUEL_USER__ || user);
      if (searchStatusMsg !== false) {
        setSearchStatus(
          searchStatusMsg != null ? searchStatusMsg : "Saved to your local stations.",
          false
        );
      }

      if (
        typeof window.FuelAuth === "undefined" ||
        typeof window.FuelAuth.patchProfile !== "function"
      ) {
        return Promise.resolve();
      }

      return window.FuelAuth
        .patchProfile({ dashboard: { localStations: next.slice(0, MAX_LOCAL_STATIONS) } })
        .then(function (u) {
          if (u) {
            window.__FUEL_USER__ = u;
            fill(u);
          }
        })
        .catch(function () {});
    }

    var DEFAULT_SAVED_EMPTY =
      "No stations yet — enter your operation postcode above and save your profile to load forecourts within 30 km.";
    var FILTER_EMPTY_SAVED =
      "No stations in this category — switch to All to see every station.";

    function renderSavedList(u) {
      if (!localSavedList || !localEmpty) return;
      var stations = normalizeLocalStations(dash(u));
      if (Array.isArray(window.__FUEL_LOCAL_STATIONS__)) {
        stations = normalizeLocalStations({ localStations: window.__FUEL_LOCAL_STATIONS__ });
      }
      var allSaved = onlyAutoStations(stations);
      if (profileKindFilterEl) {
        profileKindFilterEl.hidden = allSaved.length === 0;
      }
      localSavedList.innerHTML = "";
      if (!allSaved.length) {
        localEmpty.textContent = DEFAULT_SAVED_EMPTY;
        localEmpty.hidden = false;
        setSearchStatus("", false);
        return;
      }
      var toShow = filterProfileRows(allSaved);
      if (!toShow.length) {
        localEmpty.textContent = FILTER_EMPTY_SAVED;
        localEmpty.hidden = false;
        return;
      }
      localEmpty.hidden = true;
      toShow.forEach(function (row) {
        var li = document.createElement("li");
        li.className = "dash-list__item";
        var parts = [];
        if (row.postcode) parts.push(row.postcode);
        if (row.distanceKm != null && Number.isFinite(Number(row.distanceKm))) {
          parts.push(Number(row.distanceKm).toFixed(1) + " km");
        }
        var metaLine = parts.join(" · ");
        var srcHint =
          '<span class="profile-local-src" title="Within 30 km of your operation postcode">30 km</span> ';
        li.innerHTML =
          '<div class="dash-list__main">' +
          '<span class="dash-list__label">' +
          stationKindBadgeHtml(row) +
          srcHint +
          escapeHtml(row.name || "Station") +
          "</span>" +
          (metaLine
            ? '<span class="dash-list__meta">' + escapeHtml(metaLine) + "</span>"
            : "") +
          (row.address
            ? '<span class="dash-list__meta">' + escapeHtml(row.address) + "</span>"
            : "") +
          "</div>" +
          '<button type="button" class="dash-list__remove profile-local-remove" aria-label="Remove station">×</button>';
        li.querySelector(".profile-local-remove").addEventListener("click", function () {
          var next = allSaved.filter(function (s) {
            return s.stationId !== row.stationId;
          });
          persistLocalStations(next).catch(function () {});
        });
        localSavedList.appendChild(li);
      });
    }

    if (profileKindFilterEl) {
      profileKindFilterEl.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-station-kind]");
        if (!btn) return;
        profileStationKindFilter = btn.getAttribute("data-station-kind") || "all";
        updateProfileKindButtons();
        renderSavedList(window.__FUEL_USER__ || user);
      });
    }

    renderSavedList(user);

    window.refuelProfileLocalStations = function () {
      renderSavedList(window.__FUEL_USER__ || user);
    };

    var refresh25Btn = document.getElementById("profile-local-refresh-25mi");
    if (refresh25Btn && postcodeInput) {
      refresh25Btn.addEventListener("click", function () {
        var pc = postcodeInput.value.trim();
        if (!pc) {
          setSearchStatus("Set your operation postcode in the profile form above first.", true);
          return;
        }
        autoPopulate25MileFromPostcode(pc)
          .catch(function (err) {
            setSearchStatus(err && err.message ? err.message : "Could not refresh station list.", true);
          });
      });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      setStatus("");
      var name = nameInput.value.trim();
      var companyName = companyInput ? companyInput.value.trim().slice(0, 120) : "";
      var operationPostcode = postcodeInput ? postcodeInput.value.trim().toUpperCase().slice(0, 12) : "";
      if (typeof window.FuelAuth === "undefined" || typeof window.FuelAuth.patchProfile !== "function") {
        setStatus("Cannot save — auth not available.", "err");
        return;
      }
      var btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      window.FuelAuth.patchProfile({
        name: name,
        dashboard: { companyName: companyName, operationPostcode: operationPostcode },
      })
        .then(function (u) {
          if (u) {
            window.__FUEL_USER__ = u;
            fill(u);
            var label = document.getElementById("app-user-label");
            if (label) {
              label.textContent = u.name ? u.name + " · " + u.email : u.email;
            }
            if (typeof window.refuelReloadFromUser === "function") {
              window.refuelReloadFromUser();
            }
          }
          if (!operationPostcode) {
            setStatus("Saved.", "ok");
            renderSavedList(window.__FUEL_USER__ || user);
            return;
          }
          var n = onlyAutoStations(
            normalizeLocalStations(dash(window.__FUEL_USER__ || user), true)
          ).length;
          setStatus(
            "Saved. " +
              n +
              " station(s) are stored within " +
              AUTO_RADIUS_KM +
              " km of your operation postcode.",
            "ok"
          );
          renderSavedList(window.__FUEL_USER__ || user);
        })
        .catch(function (err) {
          setStatus(err.message || "Could not save.", "err");
        })
        .finally(function () {
          if (btn) btn.disabled = false;
        });
    });
  };
})();

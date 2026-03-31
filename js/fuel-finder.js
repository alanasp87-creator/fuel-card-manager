(function () {
  "use strict";

  var PAGINATED_MODES = ["brand", "fuel-type", "prices", "stations"];

  var tabButtons = document.querySelectorAll("#fuel-mode-tabs .fuel-mode");
  var form = document.getElementById("fuel-finder-form");
  var statusEl = document.getElementById("fuel-finder-status");
  var errorEl = document.getElementById("fuel-finder-error");
  var resultsEl = document.getElementById("fuel-results");
  var nearMeBtn = document.getElementById("fuel-near-me");
  var postcodeInput = document.getElementById("fuel-postcode");
  var radiusSelect = document.getElementById("fuel-radius");
  var brandSelect = document.getElementById("fuel-brand");
  var fuelTypeSel = document.getElementById("fuel-type-sel");
  var priceMin = document.getElementById("fuel-price-min");
  var priceMax = document.getElementById("fuel-price-max");
  var pageInput = document.getElementById("fuel-page");
  var limitSelect = document.getElementById("fuel-limit");
  var paginationFields = document.getElementById("fields-pagination");

  var currentMode = "nearby";
  var geoCoords = null;

  function getFieldPanel(mode) {
    return document.getElementById("fields-" + mode);
  }

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function showError(msg) {
    if (msg) {
      errorEl.textContent = msg;
      errorEl.removeAttribute("hidden");
    } else {
      errorEl.textContent = "";
      errorEl.setAttribute("hidden", "");
    }
  }

  function clearResults() {
    resultsEl.innerHTML = "";
    resultsEl.setAttribute("hidden", "");
  }

  function showResults(html) {
    resultsEl.innerHTML = html;
    if (html) {
      resultsEl.removeAttribute("hidden");
    } else {
      resultsEl.setAttribute("hidden", "");
    }
  }

  function switchMode(mode) {
    currentMode = mode;

    tabButtons.forEach(function (btn) {
      var active = btn.getAttribute("data-mode") === mode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });

    var allPanels = document.querySelectorAll(".fuel-fields");
    allPanels.forEach(function (panel) {
      panel.setAttribute("hidden", "");
    });

    var activePanel = getFieldPanel(mode);
    if (activePanel) {
      activePanel.removeAttribute("hidden");
    }

    var isPaginated = PAGINATED_MODES.indexOf(mode) !== -1;
    if (isPaginated) {
      paginationFields.removeAttribute("hidden");
      if (pageInput) pageInput.value = "1";
    } else {
      paginationFields.setAttribute("hidden", "");
    }

    clearResults();
    showError(null);
    setStatus("");
  }

  tabButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      switchMode(btn.getAttribute("data-mode"));
    });
  });

  switchMode("nearby");

  if (nearMeBtn) {
    nearMeBtn.addEventListener("click", function () {
      if (!navigator.geolocation) {
        showError("Geolocation is not supported by your browser.");
        return;
      }
      setStatus("Getting your location\u2026");
      showError(null);
      nearMeBtn.disabled = true;
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          geoCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          if (postcodeInput) postcodeInput.value = "";
          setStatus(
            "Location set: " +
              geoCoords.lat.toFixed(4) +
              ", " +
              geoCoords.lng.toFixed(4) +
              ". Press Search."
          );
          nearMeBtn.disabled = false;
        },
        function (err) {
          showError("Could not get location: " + err.message);
          setStatus("");
          nearMeBtn.disabled = false;
        }
      );
    });
  }

  function renderStation(s, index) {
    var name = s.name || "Station";
    var address = s.address || "";
    var dist =
      s.distanceKm != null ? s.distanceKm.toFixed(1) + "\u00a0km" : "";
    var diesel =
      s.dieselPence != null ? s.dieselPence.toFixed(1) + "p" : null;
    var petrol =
      s.petrolPence != null ? s.petrolPence.toFixed(1) + "p" : null;
    var kind = s.stationKind || "";

    var priceStr = "";
    if (diesel) priceStr += "Diesel: " + diesel + " ";
    if (petrol) priceStr += "Petrol: " + petrol;
    if (!priceStr && s.prices && typeof s.prices === "object") {
      var parts = [];
      Object.keys(s.prices).forEach(function (k) {
        if (s.prices[k] != null) {
          parts.push(k + ": " + Number(s.prices[k]).toFixed(1) + "p");
        }
      });
      priceStr = parts.join(" \u00b7 ");
    }

    var meta = [dist, kind].filter(Boolean).join(" \u00b7 ");

    return (
      "<li class=\"fuel-result\">" +
      "<span class=\"fuel-result__name\">" + escHtml(name) + "</span>" +
      (address ? "<span class=\"fuel-result__address\">" + escHtml(address) + "</span>" : "") +
      (meta ? "<span class=\"fuel-result__meta\">" + escHtml(meta) + "</span>" : "") +
      (priceStr ? "<span class=\"fuel-result__price\">" + escHtml(priceStr.trim()) + "</span>" : "") +
      "</li>"
    );
  }

  function renderStations(data) {
    var stations = data.stations || [];
    var hint = data.hint || "";
    if (!stations.length) {
      showResults("");
      setStatus(hint || "No stations found.");
      return;
    }
    var html = stations.map(renderStation).join("");
    showResults(html);
    var countMsg = stations.length + " station" + (stations.length !== 1 ? "s" : "") + " found.";
    if (hint) countMsg += " " + hint;
    setStatus(countMsg);
  }

  function renderJson(data) {
    var html =
      "<li class=\"fuel-result fuel-result--json\"><pre>" +
      escHtml(JSON.stringify(data, null, 2)) +
      "</pre></li>";
    showResults(html);
    setStatus("Done.");
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function getPage() {
    var v = pageInput ? parseInt(pageInput.value, 10) : 1;
    return isNaN(v) || v < 1 ? 1 : v;
  }

  function getLimit() {
    var v = limitSelect ? parseInt(limitSelect.value, 10) : 20;
    return isNaN(v) || v < 1 ? 20 : v;
  }

  async function doSearch() {
    setStatus("Searching\u2026");
    showError(null);
    clearResults();

    var mode = currentMode;

    try {
      var data;
      if (mode === "nearby") {
        var opts = { radiusKm: radiusSelect ? parseInt(radiusSelect.value, 10) : 10 };
        if (geoCoords) {
          opts.lat = geoCoords.lat;
          opts.lng = geoCoords.lng;
        } else {
          var pc = postcodeInput ? postcodeInput.value.trim() : "";
          if (!pc) {
            showError("Enter a UK postcode or use the Near me button.");
            setStatus("");
            return;
          }
          opts.postcode = pc;
        }
        data = await window.fuelFinderSearch(opts);
        renderStations(data);
      } else if (mode === "brand") {
        var brand = brandSelect ? brandSelect.value : "";
        data = await window.fuelApiBrand(brand, getPage(), getLimit());
        renderStations(data);
      } else if (mode === "fuel-type") {
        var fuelType = fuelTypeSel ? fuelTypeSel.value : "";
        data = await window.fuelApiFuelType(fuelType, getPage(), getLimit());
        renderStations(data);
      } else if (mode === "prices") {
        var min = priceMin ? priceMin.value : "";
        var max = priceMax ? priceMax.value : "";
        data = await window.fuelApiPrices(min, max, getPage(), getLimit());
        renderStations(data);
      } else if (mode === "stations") {
        data = await window.fuelApiStations(getPage(), getLimit());
        renderStations(data);
      } else if (mode === "status") {
        data = await window.fuelApiStatus();
        renderJson(data);
      } else if (mode === "updates") {
        data = await window.fuelApiUpdates();
        renderJson(data);
      }
    } catch (err) {
      showError(err && err.message ? err.message : String(err));
      setStatus("");
    }
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    doSearch();
  });

})();

(function () {
  "use strict";

  function initAdminPanel(user) {
    if (!user || !user.isAdmin) return;

    var refreshBtn = document.getElementById("admin-refresh-btn");
    var userList = document.getElementById("admin-user-list");

    if (!refreshBtn || !userList) return;

    async function fetchUsers() {
      userList.innerHTML = '<tr><td colspan="5" class="admin-table__empty">Loading users...</td></tr>';
      try {
        var token = window.FuelAuth ? window.FuelAuth.getToken() : null;
        var res = await fetch(window.FUEL_FINDER_PROXY_BASE + "/admin/users", {
          headers: {
            "Authorization": "Bearer " + token,
            "Accept": "application/json"
          }
        });
        if (!res.ok) {
           var errData = {};
           try { errData = await res.json(); } catch(e){}
           throw new Error(errData.error || "Failed to fetch users (HTTP " + res.status + ")");
        }
        var data = await res.json();
        renderUsers(data.users || []);
      } catch (err) {
        userList.innerHTML = '<tr><td colspan="5" class="admin-table__empty">Error: ' + err.message + '</td></tr>';
      }
    }

    function renderUsers(users) {
      if (!users.length) {
        userList.innerHTML = '<tr><td colspan="5" class="admin-table__empty">No users found.</td></tr>';
        return;
      }

      userList.innerHTML = "";
      users.forEach(function (u) {
        var tr = document.createElement("tr");
        
        var name = u.name || "—";
        var email = u.email || "—";
        var joined = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—";
        var adminBadge = u.isAdmin 
          ? '<span class="admin-badge-yes">YES</span>' 
          : '<span class="admin-badge-no">NO</span>';

        tr.innerHTML = 
          '<td>' + escapeHtml(name) + '</td>' +
          '<td>' + escapeHtml(email) + '</td>' +
          '<td>' + joined + '</td>' +
          '<td>' + adminBadge + '</td>' +
          '<td class="admin-actions">' +
            '<button type="button" class="btn btn-ghost admin-btn-delete" data-user-id="' + u.id + '" title="Delete user">Delete</button>' +
          '</td>';
        
        var delBtn = tr.querySelector(".admin-btn-delete");
        delBtn.addEventListener("click", function() {
          if (confirm("Are you sure you want to delete user " + email + "? This cannot be undone.")) {
            deleteUser(u.id, tr);
          }
        });

        userList.appendChild(tr);
      });
    }

    async function deleteUser(userId, rowEl) {
      try {
        var token = window.FuelAuth ? window.FuelAuth.getToken() : null;
        var res = await fetch(window.FUEL_FINDER_PROXY_BASE + "/admin/users/" + userId, {
          method: "DELETE",
          headers: {
            "Authorization": "Bearer " + token,
            "Accept": "application/json"
          }
        });
        if (!res.ok) {
           var errData = {};
           try { errData = await res.json(); } catch(e){}
           throw new Error(errData.error || "Failed to delete user (HTTP " + res.status + ")");
        }
        rowEl.remove();
        if (userList.children.length === 0) {
          userList.innerHTML = '<tr><td colspan="5" class="admin-table__empty">No users found.</td></tr>';
        }
      } catch (err) {
        alert("Error deleting user: " + err.message);
      }
    }

    function escapeHtml(str) {
      var div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    refreshBtn.addEventListener("click", fetchUsers);

    // Initial fetch if view is active
    var observer = new MutationObserver(function(mutations) {
      mutations.forEach(function(mutation) {
        if (mutation.attributeName === "class") {
          var view = document.getElementById("view-admin");
          if (view && view.classList.contains("is-active")) {
            fetchUsers();
          }
        }
      });
    });
    
    var viewAdmin = document.getElementById("view-admin");
    if (viewAdmin) {
        observer.observe(viewAdmin, { attributes: true });
        if (viewAdmin.classList.contains("is-active")) {
            fetchUsers();
        }
    }
  }

  window.initAdminPanel = initAdminPanel;
})();

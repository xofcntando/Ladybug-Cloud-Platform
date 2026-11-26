// Registers the service worker, offers an "Install app" button, and prompts when a new
// version of the app shell is available so the installed app always has every feature.
(function () {
  var isStandalone = function () {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: window-controls-overlay)').matches ||
      window.navigator.standalone === true
    );
  };

  function toast(msg, actionLabel, onAction) {
    var el = document.createElement('div');
    el.className = 'pwa-toast';
    el.setAttribute('role', 'status');
    var span = document.createElement('span');
    span.textContent = msg;
    el.appendChild(span);
    if (actionLabel) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = actionLabel;
      b.onclick = function () {
        el.remove();
        onAction();
      };
      el.appendChild(b);
    }
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'pwa-toast-x';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '\u00d7';
    x.onclick = function () {
      el.remove();
    };
    el.appendChild(x);
    document.body.appendChild(el);
    if (!actionLabel) setTimeout(function () { el.remove(); }, 6000);
    return el;
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker
        .register('/sw.js', { updateViaCache: 'none' })
        .then(function (reg) {
          // If a worker is already waiting, a newer shell is ready.
          if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg);

          reg.addEventListener('updatefound', function () {
            var sw = reg.installing;
            if (!sw) return;
            sw.addEventListener('statechange', function () {
              if (sw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(reg);
            });
          });

          // Check for a new build when the app regains focus (installed apps rarely reload).
          document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') reg.update().catch(function () {});
          });
        })
        .catch(function () {});

      navigator.serviceWorker.addEventListener('controllerchange', function () {
        // A new worker took over: reload once so every module comes from the new cache.
        if (window.__lbSwReloading) return;
        window.__lbSwReloading = true;
        location.reload();
      });
    });
  }

  function offerUpdate(reg) {
    if (window.__lbUpdateShown) return;
    window.__lbUpdateShown = true;
    toast('A new version of Ladybug Cloud is ready.', 'Reload', function () {
      if (reg.waiting) reg.waiting.postMessage('skip-waiting');
      else location.reload();
    });
  }

  var deferred = null;
  var btn = null;

  function makeButton() {
    if (btn || isStandalone()) return;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pwa-install';
    btn.textContent = '\ud83d\udcf2 Install app';
    btn.setAttribute('aria-label', 'Install Ladybug Cloud as an app');
    btn.onclick = function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.finally(function () {
        deferred = null;
        if (btn) btn.remove();
        btn = null;
      });
    };
    document.body.appendChild(btn);
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    makeButton();
  });
  window.addEventListener('appinstalled', function () {
    if (btn) btn.remove();
    btn = null;
    deferred = null;
  });
})();

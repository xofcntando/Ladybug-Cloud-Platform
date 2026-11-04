// Registers the service worker and shows an "Install app" button when the browser allows it.
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }

  var deferred = null;
  var btn = null;

  function makeButton() {
    btn = document.createElement('button');
    btn.textContent = '📲 Install app';
    btn.setAttribute('aria-label', 'Install Ladybug Cloud as an app');
    btn.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;padding:12px 18px;border:0;' +
      'border-radius:999px;background:#25d366;color:#04210f;font:600 14px system-ui,sans-serif;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.4);cursor:pointer';
    btn.onclick = function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.finally(function () { deferred = null; btn.remove(); });
    };
    document.body.appendChild(btn);
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    if (!window.matchMedia('(display-mode: standalone)').matches) makeButton();
  });
  window.addEventListener('appinstalled', function () { if (btn) btn.remove(); });
})();

/* Ladybug Cloud — plans, usage meter and invoices.
 *
 * Three surfaces, one module:
 *   LBPLANS.mount()        a compact strip on the dashboard (plan + this month's usage)
 *   LBPLANS.render()       the full #/plans page (plan cards, meters, invoices)
 *   LBPLANS.receipt(id)    a printable receipt for one payment
 *
 * Talks to /api/plans, /api/billing/usage, /api/billing/invoices, /api/billing/plan.
 * Loaded after app.js so it can use api(), toast(), esc(), openModal().
 */
(function () {
  'use strict';

  var esc = window.esc || function (s) { return String(s == null ? '' : s); };
  var api = window.api;
  var money = function (n) { return '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); };
  var num = function (n) { return Number(n || 0).toLocaleString('en-US'); };

  function bar(m) {
    var tone = m.over ? 'over' : m.warn ? 'warn' : 'ok';
    var cap = m.cap == null ? 'unlimited' : num(m.cap);
    return '' +
      '<div class="usage-meter">' +
        '<div class="usage-top"><span>' + esc(m.label) + '</span>' +
          '<b>' + num(m.used) + ' <small>/ ' + cap + '</small></b></div>' +
        '<div class="meter ' + tone + '"><span style="width:' + (m.cap == null ? 6 : m.pct) + '%"></span></div>' +
        '<div class="usage-foot">' + (m.cap == null ? 'No monthly cap on this plan.' :
          m.over ? 'Limit reached — upgrade to keep going.' :
          m.warn ? 'Over 80% used. ' + num(m.left) + ' left this month.' :
          num(m.left) + ' left this month') + '</div>' +
      '</div>';
  }

  /* ------------------------------------------------------------ dashboard strip */
  async function mount() {
    var el = document.getElementById('planPanel');
    if (!el) return;
    var u;
    try { u = await api('/api/billing/usage'); } catch (e) { el.innerHTML = ''; return; }
    var grace = u.grace && u.grace.active;
    el.innerHTML = '' +
      '<div class="plan-strip' + (grace ? ' grace' : '') + '">' +
        '<div class="plan-strip-main">' +
          '<div class="k">Plan</div>' +
          '<div class="plan-strip-name">' + esc(u.plan.name) +
            '<span class="plan-tag">' + (u.plan.usd ? money(u.plan.usd) + '/mo' : 'free') + '</span></div>' +
          (grace ? '<p class="plan-warn">Your plan ended — bots keep running for ' + u.grace.daysLeft +
            ' more day' + (u.grace.daysLeft === 1 ? '' : 's') + '. Renew to avoid a pause.</p>' : '') +
          '<div class="plan-strip-meters">' +
            bar({ label: 'Messages', used: u.meters.messages.used, cap: u.meters.messages.cap, pct: u.meters.messages.pct, left: u.meters.messages.left, over: u.meters.messages.over, warn: u.meters.messages.warn }) +
            bar({ label: 'AI replies', used: u.meters.ai.used, cap: u.meters.ai.cap, pct: u.meters.ai.pct, left: u.meters.ai.left, over: u.meters.ai.over, warn: u.meters.ai.warn }) +
          '</div>' +
        '</div>' +
        '<div class="plan-strip-side">' +
          '<div class="plan-mini"><b>' + u.bots.used + '</b><span>of ' + u.bots.cap + ' bots</span></div>' +
          '<div class="plan-mini"><b>' + u.bots.running + '</b><span>running</span></div>' +
          '<a class="btn btn-sm" href="#/plans">Plans &amp; invoices</a>' +
        '</div>' +
      '</div>';
  }

  /* ------------------------------------------------------------ full page */
  function planCard(p, current) {
    var isCur = current === p.key;
    var cta = isCur
      ? '<button class="btn btn-sm" disabled>Current plan</button>'
      : p.usd === 0
        ? '<button class="btn btn-sm" disabled>Free</button>'
        : '<button class="btn btn-sm btn-primary" data-buy="' + esc(p.key) + '">Choose ' + esc(p.name) + '</button>';
    return '' +
      '<div class="plan-card' + (isCur ? ' current' : '') + '">' +
        '<div class="plan-card-head"><h3>' + esc(p.name) + '</h3>' +
          (isCur ? '<span class="plan-tag on">yours</span>' : '') + '</div>' +
        '<div class="plan-price">' + (p.usd ? money(p.usd) + '<small>/month</small>' : 'Free<small>trial</small>') + '</div>' +
        '<p class="plan-blurb">' + esc(p.blurb) + '</p>' +
        '<ul class="plan-list">' +
          '<li>' + p.bots + ' bot' + (p.bots > 1 ? 's' : '') + '</li>' +
          '<li>' + num(p.messages) + ' messages / month</li>' +
          '<li>' + num(p.ai) + ' AI replies / month</li>' +
          '<li>' + p.historyDays + '-day chat history</li>' +
          '<li>' + (p.api ? 'API Pass included' : 'API Pass not included') + '</li>' +
        '</ul>' +
        cta +
      '</div>';
  }

  function invoiceRow(i) {
    var tone = i.status === 'approved' ? 'ok' : i.status === 'pending' ? 'pending' : 'bad';
    return '<tr>' +
      '<td><b>' + esc(i.number) + '</b><br><span class="hint" style="margin:0">' + esc(i.date) + '</span></td>' +
      '<td>' + esc(i.itemName) + (i.qty > 1 ? ' ×' + i.qty : '') + '</td>' +
      '<td>' + esc(i.currency) + ' ' + esc(i.amount) + '</td>' +
      '<td><span class="pstatus ' + tone + '">' + esc(i.status) + '</span></td>' +
      '<td><button class="btn btn-sm btn-ghost" data-receipt="' + esc(i.id) + '">Receipt</button></td>' +
    '</tr>';
  }

  async function render() {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="app"><div class="wrap"><div class="wallet skeleton" style="height:180px"></div></div></div>';
    var data;
    try {
      data = await Promise.all([api('/api/billing/usage'), api('/api/billing/invoices'), api('/api/plans')]);
    } catch (e) {
      view.innerHTML = '<div class="app"><div class="wrap"><div class="empty"><h3>Could not load your plan</h3><p>' + esc(e.message) + '</p></div></div></div>';
      return;
    }
    var u = data[0], inv = data[1], plansData = data[2];
    var cur = plansData.current || { key: u.plan.key };
    var history = (u.history || []).slice().reverse();
    var peak = Math.max(1, Math.max.apply(null, history.map(function (h) { return h.messages; })));

    view.innerHTML = '' +
      '<div class="app"><div class="wrap">' +
        '<div class="app-head"><div><h1>Plan &amp; usage</h1>' +
          '<p>What you pay for, what you have used this month, and every receipt in one place.</p></div>' +
          '<div class="app-head-actions"><a class="btn btn-sm" href="#/dashboard">Back to dashboard</a>' +
          '<a class="btn btn-sm btn-primary" href="#/pay">Pay / top up</a></div></div>' +

        (u.grace && u.grace.active ? '<div class="notice warn"><b>Grace period.</b> Your plan ended but your bots keep running for ' +
          u.grace.daysLeft + ' more day' + (u.grace.daysLeft === 1 ? '' : 's') + '. Renew below to avoid a pause.</div>' : '') +

        '<div class="usage-grid">' +
          '<div class="card usage-card">' +
            '<div class="card-head"><h3>This month</h3><span class="pill">' + esc(u.monthLabel) + '</span></div>' +
            bar({ label: 'Messages sent', used: u.meters.messages.used, cap: u.meters.messages.cap, pct: u.meters.messages.pct, left: u.meters.messages.left, over: u.meters.messages.over, warn: u.meters.messages.warn }) +
            bar({ label: 'AI replies', used: u.meters.ai.used, cap: u.meters.ai.cap, pct: u.meters.ai.pct, left: u.meters.ai.left, over: u.meters.ai.over, warn: u.meters.ai.warn }) +
            '<div class="usage-facts">' +
              '<div><b>' + u.bots.used + '</b><span>bots of ' + u.bots.cap + '</span></div>' +
              '<div><b>' + num(u.counters.commands) + '</b><span>commands run</span></div>' +
              '<div><b>' + num(u.counters.botStarts) + '</b><span>starts</span></div>' +
              '<div><b>' + num(u.counters.claims) + '</b><span>coin claims</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="card usage-card">' +
            '<div class="card-head"><h3>Six-month trend</h3><span class="hint" style="margin:0">messages / month</span></div>' +
            '<div class="trend">' + history.map(function (h) {
              var pct = Math.round((h.messages / peak) * 100);
              return '<div class="trend-col" title="' + esc(h.month) + ': ' + num(h.messages) + ' messages">' +
                '<div class="trend-bar" style="height:' + Math.max(2, pct) + '%"></div>' +
                '<span>' + esc(h.month.slice(5)) + '</span></div>';
            }).join('') + '</div>' +
          '</div>' +
        '</div>' +

        '<h2 class="section-title">Plans</h2>' +
        '<div class="plan-grid">' + (plansData.plans || []).map(function (p) { return planCard(p, cur.key); }).join('') + '</div>' +

        '<h2 class="section-title">Invoices</h2>' +
        '<div class="invoice-totals">' +
          '<div><b>' + money(inv.paidUsd) + '</b><span>paid</span></div>' +
          '<div><b>' + money(inv.pendingUsd) + '</b><span>waiting for approval</span></div>' +
          '<div><b>' + inv.count + '</b><span>receipts</span></div>' +
        '</div>' +
        (inv.items.length
          ? '<div class="table-wrap"><table><thead><tr><th>Receipt</th><th>What</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>' +
            inv.items.map(invoiceRow).join('') + '</tbody></table></div>'
          : '<div class="empty"><h3>No payments yet</h3><p>Every payment you submit gets a receipt here, approved or not.</p><a class="btn btn-primary" href="#/pay">See payment details</a></div>') +
      '</div></div>';

    view.querySelectorAll('[data-buy]').forEach(function (b) {
      b.onclick = function () { buy(b.getAttribute('data-buy'), b); };
    });
    view.querySelectorAll('[data-receipt]').forEach(function (b) {
      b.onclick = function () { receipt(b.getAttribute('data-receipt')); };
    });
  }

  async function buy(key, btn) {
    var original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>';
    try {
      var r = await api('/api/billing/plan', { method: 'POST', body: { key: key } });
      if (r.url) { window.open(r.url, '_blank', 'noopener'); toast('Finish the payment to switch plans.', 'ok'); }
      else { toast(r.message || 'Plan requested.', 'ok'); location.hash = '#/pay'; }
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  /* ------------------------------------------------------------ receipt */
  async function receipt(id) {
    var r;
    try { r = await api('/api/billing/invoices/' + encodeURIComponent(id)); }
    catch (e) { return toast(e.message, 'err'); }
    var i = r.invoice;
    var tone = i.status === 'approved' ? 'ok' : i.status === 'pending' ? 'pending' : 'bad';
    openModal('' +
      '<div class="receipt" id="receiptSheet">' +
        '<div class="receipt-head"><div><b>Ladybug Cloud</b><span>by Ntandomods</span></div>' +
          '<div class="receipt-no"><span>Receipt</span><b>' + esc(i.number) + '</b></div></div>' +
        '<div class="receipt-meta">' +
          '<div><span>Billed to</span><b>' + esc(r.account.username) + '</b>' + (r.account.email ? '<small>' + esc(r.account.email) + '</small>' : '') + '</div>' +
          '<div><span>Date</span><b>' + esc(i.date) + '</b></div>' +
          '<div><span>Plan</span><b>' + esc(r.plan.name) + '</b></div>' +
          '<div><span>Status</span><b class="pstatus ' + tone + '">' + esc(i.status) + '</b></div>' +
        '</div>' +
        '<table class="receipt-table"><tbody><tr>' +
          '<td>' + esc(i.itemName) + (i.qty > 1 ? ' ×' + i.qty : '') + '<br><span class="hint" style="margin:0">ref ' + esc(i.reference || '—') + '</span></td>' +
          '<td class="right">' + esc(i.currency) + ' ' + esc(i.amount) + '</td></tr>' +
          '<tr class="total"><td>Total</td><td class="right">' + esc(i.currency) + ' ' + esc(i.amount) + ' <small>(' + money(i.amountUsd) + ')</small></td></tr>' +
        '</tbody></table>' +
        '<p class="receipt-note">' + (i.status === 'approved'
          ? 'Paid and activated. Thank you for hosting with Ladybug Cloud.'
          : i.status === 'pending'
            ? 'We have your payment reference and are confirming it. This receipt becomes final once approved.'
            : 'This payment could not be confirmed.' + (i.reason ? ' Reason: ' + esc(i.reason) : '')) + '</p>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn" id="rcClose">Close</button>' +
        '<button class="btn btn-primary" id="rcPrint">Print / save PDF</button></div>');
    document.getElementById('rcClose').onclick = closeModal;
    document.getElementById('rcPrint').onclick = function () { window.print(); };
  }

  window.LBPLANS = { mount: mount, render: render, receipt: receipt };
})();

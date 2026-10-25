// Good Faith site: progressive enhancement only. Every word is already in the HTML; this adds the requirements
// checklist result, the "I want to…" tabs and the loan explorer. Every figure is read from the page's data-launch
// spans (checked against scripts/launch.json by `npm run site-check`), never from a copy here.
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  /** A launch figure as stored in launch.json: percent spans hold bps / 100, years spans hold days / 365. */
  function fig(key) {
    const el = $(`[data-launch="${key}"]`);
    if (!el) throw new Error(`missing figure ${key}`);
    const v = Number(el.textContent.replace(/,/g, ""));
    const unit = el.dataset.unit;
    return unit === "percent" ? Math.round(v * 100) : unit === "years" ? Math.round(v * 365) : v;
  }
  const usdc = (n) => `${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 6 })} USDC`;
  const days = (d) => (d % 365 === 0 ? `${d / 365} year${d === 365 ? "" : "s"}` : `${d} days`);
  const date = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  // ---------- requirements checklist ----------
  function checklist() {
    const list = $("[data-checklist]");
    const out = $("[data-checklist-result]");
    if (!list || !out) return;
    const NAMES = { texas: "living in Texas", adult: "18 or older", id: "the ID check", wallet: "an email", cosigner: "a co-signer" };
    const HINT = {
      texas: "Good Faith is only for Texas residents 18 or older, for now. Anyone can still give to the fund.",
      adult: "Good Faith is only for Texas residents 18 or older, for now. Anyone can still give to the fund.",
      id: "Joining needs the one-time ID check: it is how one person holds one membership.",
      wallet: "Joining needs an email address you can read: you sign in with it, and notices about your membership go there.",
      cosigner: "Without a co-signer you can still join, co-sign for a friend or give. To borrow, you'll need one.",
    };
    const update = () => {
      const boxes = $$("input[data-req]", list);
      const missing = boxes.filter((i) => !i.checked).map((i) => i.dataset.req);
      const none = missing.length === boxes.length;
      // The live region stays in the page (never [hidden]) so its changes are announced politely.
      out.className = `result ${none ? "empty" : missing.length ? "almost" : "yes"}`;
      out.textContent = none
        ? ""
        : missing.length
          ? `Not ticked yet: ${missing.map((k) => NAMES[k]).join(", ")}. ${HINT[missing[0]]}`
          : "You can join and borrow. The app opens here when it leaves the test network.";
    };
    out.hidden = false;
    out.setAttribute("role", "status");
    out.setAttribute("aria-live", "polite");
    out.setAttribute("aria-atomic", "true");
    list.addEventListener("change", update);
    update();
  }

  // ---------- "I want to…" tabs ----------
  function tabs() {
    const list = $(".tablist");
    if (!list) return;
    const buttons = $$('[role="tab"]', list);
    const panels = buttons.map((b) => document.getElementById(b.getAttribute("aria-controls")));
    list.hidden = false;
    document.documentElement.classList.add("has-tabs");
    const select = (i, focus) => {
      buttons.forEach((b, j) => {
        const on = i === j;
        b.setAttribute("aria-selected", String(on));
        b.tabIndex = on ? 0 : -1;
        panels[j].hidden = !on;
      });
      if (focus) buttons[i].focus();
    };
    panels.forEach((p) => p.setAttribute("tabindex", "0")); // lets keyboard users reach the panel after its tab
    buttons.forEach((b, i) => {
      b.addEventListener("click", () => select(i, false));
      b.addEventListener("keydown", (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const n = buttons.length;
        const k = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1 + n, ArrowUp: i - 1 + n, Home: 0, End: n - 1 }[e.key];
        if (k === undefined) return;
        e.preventDefault();
        select(k % n, true);
      });
    });
    const fromHash = () => {
      const i = panels.findIndex((p) => `#${p.id}` === location.hash);
      if (i >= 0) select(i, false);
    };
    window.addEventListener("hashchange", fromHash);
    select(0, false);
    fromHash();
  }

  // ---------- loan explorer ----------
  function explorer() {
    const live = $("[data-explorer]");
    if (!live) return;
    const F = {
      first: fig("firstLoanCap"), step: fig("loanCapStep"), max: fig("maxLoan"), term: fig("maxTermDays"),
      grace: fig("graceDays"), bps: fig("cosignerEscrowBps"), seasoning: fig("seasoningDays"),
      late: fig("lateBanDays"), def: fig("defaultBanDays"), cos: fig("cosignerBanDays"),
    };
    const MG_TEST_FEE = 3; // MoneyGram's sandbox quote; production fees are still to confirm
    const amount = $("#amount"), loans = $("#loans"), term = $("#term");
    loans.max = String(Math.ceil((F.max - F.first) / F.step));
    term.max = String(F.term);
    let outcome = "ontime";
    const cap = (n) => Math.min(F.first + F.step * n, F.max);

    const render = () => {
      const c = cap(Number(loans.value));
      amount.max = String(c);
      if (Number(amount.value) > c) amount.value = String(c);
      const a = Number(amount.value);
      const t = Number(term.value);
      // The program's formula: escrow = ceil(amount × bps / 10000), in the token's base units (6 decimals).
      const d = Math.ceil((Math.round(a * 1e6) * F.bps) / 10000) / 1e6;
      const due = new Date(Date.now() + t * 864e5);
      const cutoff = new Date(due.getTime() + F.grace * 864e5);
      $("#amount-out").value = String(a);
      $("#loans-out").value = loans.value;
      $("#term-out").value = String(t);
      $("#x-cap").textContent = usdc(c);
      $("#x-repay").textContent = usdc(a);
      $("#x-deposit").textContent = usdc(d);
      $("#x-due").textContent = date(due);
      $("#x-cutoff").textContent = date(cutoff);
      $("#x-cash").innerHTML = a > MG_TEST_FEE ? `about ${(a - MG_TEST_FEE).toLocaleString("en-US")} USD <small>test quote</small>` : "—";
      const next = cap(Number(loans.value) + 1);
      const text = {
        ontime: [
          `You repay ${usdc(a)} by ${date(cutoff)}, in any amounts. ` +
            (t >= F.seasoning
              ? next > c ? `Your limit can rise to ${usdc(next)} for the next loan.` : `You are at the highest limit.`
              : `A loan shorter than ${days(F.seasoning)} doesn't raise your limit.`),
          `Gets the ${usdc(d)} deposit back in full.`,
        ],
        late: [
          `The loan is settled at the cutoff. When you pay back the full ${usdc(a)}, you can't take new loans for ${days(F.late)} from that day, and your limit goes back to ${usdc(F.first)}. No interest or fee is added.`,
          `The ${usdc(d)} deposit covers part of the loan at the cutoff. When you pay back, the fund is paid first, then your co-signer gets the ${usdc(d)} back, and any bar on them ends.`,
        ],
        never: [
          `You can't take new loans for ${days(F.def)}, and your limit goes back to ${usdc(F.first)}. No interest or fee is added.`,
          `Loses the ${usdc(d)} deposit, which covers part of the loss` +
            (a > d ? ` (the fund still loses ${usdc(Math.round((a - d) * 1e6) / 1e6)}), and can't borrow or co-sign for ${days(F.cos)}` : "") +
            `, unless you pay back later.`,
        ],
      }[outcome];
      $("#x-borrower").textContent = text[0];
      $("#x-cosigner").textContent = text[1];
    };

    // Radio group pattern: one tab stop (the checked radio), arrows move and check, Home/End jump.
    const radios = $$("[data-outcome]", live);
    const choose = (i, focus) => {
      radios.forEach((x, j) => {
        x.setAttribute("aria-checked", String(i === j));
        x.tabIndex = i === j ? 0 : -1;
      });
      outcome = radios[i].dataset.outcome;
      if (focus) radios[i].focus();
      render();
    };
    radios.forEach((b, i) => {
      b.addEventListener("click", () => choose(i, false));
      b.addEventListener("keydown", (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const n = radios.length;
        const k = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1 + n, ArrowUp: i - 1 + n, Home: 0, End: n - 1 }[e.key];
        if (k === undefined) return;
        e.preventDefault();
        choose(k % n, true);
      });
    });
    radios.forEach((x, j) => (x.tabIndex = x.getAttribute("aria-checked") === "true" ? 0 : -1));
    // Sliders already announce their own value; keep the figures grid quiet and announce only the outcome text.
    const figures = $(".figures", live);
    if (figures) figures.setAttribute("aria-live", "off");
    [amount, loans, term].forEach((i) => i.addEventListener("input", render));
    live.hidden = false;
    const worked = $("[data-worked]");
    if (worked) worked.hidden = true;
    render();
  }

  // Print: open every question so the answers are on paper.
  window.addEventListener("beforeprint", () => $$(".faq details").forEach((d) => (d.open = true)));

  const start = () => {
    for (const f of [checklist, tabs, explorer]) {
      try {
        f();
      } catch (e) {
        console.error(e); // the static page stays readable if one part fails
      }
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();

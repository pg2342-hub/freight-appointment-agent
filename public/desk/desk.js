// Appointment desk console. Recorded threads come from data.js (Claude's graded gate runs);
// live numbers, releases and the visitor's own threads come from the Worker's API.
(() => {
  const D = window.DESK;
  const main = document.getElementById("main");
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (id) => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: keep it in memory only */ } },
  };

  // ---------- vocabulary ----------
  const TZ = { "America/New_York": "ET", "America/Indiana/Indianapolis": "ET", "America/Chicago": "CT", "America/Denver": "MT", "America/Phoenix": "MST", "America/Los_Angeles": "PT" };
  const OFFSET_TZ = { "-05:00": "ET", "-06:00": "CT", "-07:00": "MT", "-08:00": "PT" };
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const TIER = { T1: "Clean", T2: "Messy", T3: "Judgment", T4: "Out of scope" };
  const REASON = {
    load_not_found: "Load not found", no_slot_in_window: "No slot in the customer window", date_conflict: "Date conflicts with the TMS",
    late_to_receiver: "Truck would be late to the receiver", facility_question: "Facility asked a question", competing_loads: "Two loads compete for one slot",
    po_not_found: "Receiver can't find the PO", counter_offer_infeasible: "Counter-offer won't work", hazmat: "Hazmat load",
    changes_load: "Changes the load itself", out_of_scope: "Not an appointment request",
  };
  const TO = { coordinator: "Coordinator", ae: "Account executive" };
  const TOOL = {
    find_load: "Find the load", get_facility: "Read the facility's rules", estimate_arrival: "Estimate arrival", get_open_slots: "Find open slots",
    request_appointment: "Request the appointment", record_existing_appointment: "Record the customer's booking", record_fcfs: "Mark first come, first served",
    notify: "Notify", hand_off: "Hand to a person",
  };
  const SENDERS = { "harborline-foods": "Harborline Foods", "bluemesa-transport": "Blue Mesa Transport" };

  const fac = (id) => D.facilities.find((f) => f.id === id);
  const load = (no) => D.loads.find((l) => l.load_no === no);
  const weekday = (date) => WD[new Date(`${date}T12:00:00Z`).getUTCDay()];
  const md = (date) => `${+date.slice(5, 7)}/${+date.slice(8, 10)}`;
  const fmtLocal = (local, tz) => (local ? `${weekday(local.slice(0, 10))} ${md(local)} ${local.slice(11, 16)}${tz ? " " + (TZ[tz] ?? "") : ""}` : "");
  const fmtRecv = (iso) => `${weekday(iso.slice(0, 10))} ${md(iso)} ${iso.slice(11, 16)} ${OFFSET_TZ[iso.slice(16)] ?? ""}`.trim();
  const usd = (n, d = 2) => `$${Number(n || 0).toFixed(d)}`;
  const sender = (addr) => {
    const m = /^(?:.*<)?([^@<\s]+)@([^>\s]+?)>?$/.exec(String(addr).trim());
    if (!m) return { name: String(addr || "Unknown sender"), mailbox: "" };
    const org = m[2].replace(/\.(example|com|net|org|io|dev)$/i, "");
    const name = SENDERS[org] ?? org.split(/[-.]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    return { name, mailbox: `${m[1]}@${m[2]}` };
  };
  const md2html = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // ---------- state ----------
  const S = {
    run: 0,
    source: "recorded",
    filter: "all",
    q: "",
    fac: null,
    gateSuite: "dev",
    live: null, releases: null, health: null,
    mine: store.get("desk.mine", []),
    liveCache: new Map(),
  };

  const out = (t, run = S.run) => t.runs[run]?.output ?? {};
  function outcome(o) {
    switch (o.action) {
      case "book": return { label: "Booked", cls: "done", short: "booked" };
      case "enter_existing": return { label: "Recorded", cls: "done", short: "recorded" };
      case "record_fcfs": return { label: "First come, first served", cls: "done", short: "fcfs" };
      case "handoff": return { label: "Handed off", cls: "hot", short: "handoff" };
      default: return { label: "Answered", cls: "", short: "other" };
    }
  }
  const facilityOf = (o) => o.appointments?.[0]?.facility ?? o.facility ?? load(o.load)?.delivery?.facility ?? null;

  // ---------- live data ----------
  async function getJSON(url) {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  }
  async function loadLive() {
    const [live, rel, health] = await Promise.allSettled([getJSON("/api/desk/live"), getJSON("/api/releases"), getJSON("/api/health")]);
    S.live = live.status === "fulfilled" ? live.value : { error: true };
    S.releases = rel.status === "fulfilled" ? rel.value : { error: true };
    S.health = health.status === "fulfilled" ? health.value : null;
    paintStatus();
    if (["overview", "releases"].includes(route().name)) render();
  }
  function paintStatus() {
    const v = S.health?.version ?? S.releases?.current;
    $("#st-version").textContent = v ?? "offline";
    const top = S.releases?.stages?.find((s) => s.version === v);
    $("#st-serving").textContent = top ? `${top.stage}%` : S.health ? "Live" : "Offline";
    const spent = S.live?.spend_today_usd ?? 0, cap = S.live?.budget_usd ?? 5;
    $("#st-spend").textContent = `${usd(spent)} of ${usd(cap, 0)}`;
    const m = $("#st-meter");
    m.setAttribute("aria-valuenow", spent.toFixed(2));
    m.setAttribute("aria-valuemax", String(cap));
    m.classList.toggle("is-high", spent / cap > 0.8);
    m.firstElementChild.style.width = `${Math.min(100, (spent / cap) * 100)}%`;
  }

  // ---------- routing ----------
  function route() {
    const [name = "overview", arg] = location.hash.replace(/^#\/?/, "").split("/");
    return { name: ["overview", "inbox", "handoffs", "docks", "releases"].includes(name) ? name : "overview", arg: arg ? decodeURIComponent(arg) : null };
  }
  function render() {
    const r = route();
    document.querySelectorAll("[data-route]").forEach((a) => { if (a.dataset.route === r.name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    const view = { overview, inbox, handoffs, docks, releases }[r.name];
    main.innerHTML = `<div class="view">${view(r.arg)}</div>`;
    document.title = `${{ overview: "Overview", inbox: "Inbox", handoffs: "Hand-offs", docks: "Dock calendars", releases: "Releases" }[r.name]} · Lanternfly appointment desk`;
    after[r.name]?.(r.arg);
    closeNav();
  }
  const after = {};

  // shared bits
  const seg = (name, opts, cur, label) =>
    `<div class="seg" role="radiogroup" aria-label="${esc(label)}">${opts.map(([v, t]) => `<button type="button" role="radio" data-seg="${name}" data-v="${v}" aria-checked="${v === cur}">${esc(t)}</button>`).join("")}</div>`;
  const runSeg = () => seg("run", [["0", "Run 1"], ["1", "Run 2"], ["2", "Run 3"]], String(S.run), "Graded run");
  const metric = (k, v, d, opt = {}) =>
    `<${opt.href ? `a href="${opt.href}"` : "div"} class="metric${opt.hot ? " metric--hot" : ""}"><span class="metric__k">${k}</span><span class="metric__v num">${v}</span><span class="metric__d">${d}</span></${opt.href ? "a" : "div"}>`;
  const bars = (items, max) =>
    `<ul class="bars">${items.map((i) => `<li><span class="lbl">${esc(i.label)}</span><span class="val">${i.val}</span><span class="track" aria-hidden="true">${i.parts.map((p) => `<span class="fill${p.hot ? " fill--hot" : ""}" style="width:${(p.n / max) * 100}%"></span>`).join("")}</span></li>`).join("")}</ul>`;

  // ---------- overview ----------
  function overview() {
    const head = `<div class="head"><div><h1>Overview</h1><p>${S.source === "recorded"
      ? "The 40 recorded threads: 25 written with the agent's instructions and 15 held out until the instructions were frozen. Claude ran each one three times; every run was graded on six checks."
      : "Live traffic from the last 7 days: emails to appointments@pranavgudise.dev and threads sent from this console. Counts only; no one's email is shown here."}</p></div>
      <div class="head__tools">${S.source === "recorded" ? runSeg() : ""}${seg("source", [["recorded", "Recorded"], ["live", "Live"]], S.source, "Data source")}</div></div>`;
    return head + (S.source === "recorded" ? overviewRecorded() : overviewLive());
  }

  function overviewRecorded() {
    const T = D.threads;
    const os = T.map((t) => out(t));
    const done = os.filter((o) => ["book", "enter_existing", "record_fcfs"].includes(o.action)).length;
    const hand = T.filter((t) => out(t).action === "handoff");
    const passed = T.filter((t) => t.runs[S.run]?.passed).length;
    const cost = T.reduce((a, t) => a + (t.runs[S.run]?.cost_usd ?? 0), 0);
    const lat = T.reduce((a, t) => a + (t.runs[S.run]?.latency_s ?? 0), 0) / T.length;
    const retries = os.reduce((a, o) => a + Math.max(0, (o.attempts?.length ?? 0) - 1), 0);
    const dev = T.filter((t) => t.suite === "dev").length;

    const reasons = count(hand.map((t) => out(t).reason));
    const rmax = Math.max(1, ...reasons.map((r) => r.n));
    const tiers = Object.keys(TIER).map((k) => {
      const ts = T.filter((t) => t.tier === k);
      const b = ts.filter((t) => out(t).action !== "handoff").length;
      return { label: TIER[k], val: `${b} done · <span class="${ts.length - b ? "hot" : ""}">${ts.length - b} handed off</span>`, parts: [{ n: b }, { n: ts.length - b, hot: true }], n: ts.length };
    });
    const tmax = Math.max(...tiers.map((t) => t.n));
    const booked = T.filter((t) => out(t).action === "book").slice(0, 6);

    return `<section class="metrics" aria-label="Recorded threads, run ${S.run + 1}">
        ${metric("Threads handled", T.length, `${dev} written with the instructions, ${T.length - dev} held out`, { href: "#/inbox" })}
        ${metric("Booked or recorded", done, "Confirmed through the facility's own channel, or entered as given", { href: "#/docks" })}
        ${metric("Handed to a person", hand.length, "Hazmat, conflicts, no slot, questions, and anything not an appointment", { href: "#/handoffs", hot: true })}
        ${metric("Graded right", `${passed}<small>/ ${T.length}</small>`, "Six checks per thread; a wrong appointment or a missed hand-off is critical", { href: "#/releases", hot: passed < T.length })}
      </section>
      <p class="facts"><span><b>${usd(cost / T.length, 3)}</b>per thread</span><span><b>${lat.toFixed(1)} s</b>mean time</span><span><b>${retries}</b>retried requests</span><span><b>${usd(cost)}</b>for all ${T.length} threads</span><span><b>claude-opus-5-5</b>model</span></p>
      <div class="grid2">
        <section class="panel"><div class="panel__head"><h2>Hand-offs by reason</h2><a class="panel__more" href="#/handoffs">Queue${icon("chevron")}</a></div>
          <div class="panel__body">${reasons.length ? bars(reasons.map((r) => ({ label: REASON[r.key] ?? r.key, val: r.n, parts: [{ n: r.n }] })), rmax) : `<p class="panel__empty">No hand-offs in this run.</p>`}</div></section>
        <section class="panel"><div class="panel__head"><h2>Outcome by thread type</h2><a class="panel__more" href="#/inbox">Inbox${icon("chevron")}</a></div>
          <div class="panel__body">${bars(tiers, tmax)}<div class="legend"><span><i></i>Booked, recorded or answered</span><span><i class="hot"></i>Handed to a person</span></div></div></section>
        <section class="panel"><div class="panel__head"><h2>Waiting on a person</h2><a class="panel__more" href="#/handoffs">View all ${hand.length}${icon("chevron")}</a></div>
          <ul class="rows">${hand.slice(0, 5).map((t) => threadRow(t, `<span class="pill pill--hot">${esc(TO[out(t).to] ?? out(t).to)}</span>`, REASON[out(t).reason])).join("")}</ul></section>
        <section class="panel"><div class="panel__head"><h2>Latest bookings</h2><a class="panel__more" href="#/docks">Dock calendars${icon("chevron")}</a></div>
          <ul class="rows">${booked.map((t) => { const o = out(t), a = o.appointments?.[0]; return threadRow(t, `<span class="mono num">${esc(o.confirmation ?? "")}</span>`, `${a?.facility}: ${fmtLocal(a?.local, fac(a?.facility)?.tz)}`); }).join("")}</ul></section>
      </div>`;
  }

  function overviewLive() {
    const L = S.live;
    if (!L) return `<section class="panel"><p class="panel__empty">Loading live numbers.</p></section>`;
    if (L.error) return `<section class="panel"><p class="panel__empty">The live numbers did not load. The recorded threads still work; switch to Recorded above.</p></section>`;
    const errs = L.tools.reduce((a, t) => a + t.errors, 0);
    const dmax = Math.max(1, ...L.by_day.map((d) => d.threads));
    const tmax = Math.max(1, ...L.tools.map((t) => t.calls));
    const hmax = Math.max(1, ...L.handoffs.map((h) => h.n));
    return `<section class="metrics" aria-label="Live, last 7 days">
        ${metric("Threads", L.threads, `${L.turns} emails answered in ${L.days} days`)}
        ${metric("Booked or recorded", L.booked + L.recorded, `${L.booked} confirmed with a facility`)}
        ${metric("Handed to a person", L.handed_off, "Sent to a coordinator or account executive", { hot: L.handed_off > 0 })}
        ${metric("Tool errors", errs, "Refused or failed tool calls the agent recovered from or reported", { hot: errs > 0 })}
      </section>
      <p class="facts"><span><b>${usd(L.spend_today_usd)}</b>spent today of the ${usd(L.budget_usd, 0)} cap</span><span><b>${usd(L.cost_usd)}</b>in ${L.days} days</span><span><b>${L.mean_ms ? (L.mean_ms / 1000).toFixed(1) + " s" : "none"}</b>mean time per email</span><span><b>${esc(L.version)}</b>serving</span></p>
      <div class="grid2">
        <section class="panel"><div class="panel__head"><h2>Threads per day</h2></div><div class="panel__body">
          <div class="days">${L.by_day.map((d) => `<div><b>${d.threads}</b><span class="b${d.threads ? "" : " zero"}" style="height:${(d.threads / dmax) * 100}%"></span><span>${weekday(d.date)} ${md(d.date)}</span></div>`).join("")}</div></div></section>
        <section class="panel"><div class="panel__head"><h2>Tool calls</h2></div><div class="panel__body">
          ${L.tools.length ? bars(L.tools.map((t) => ({ label: TOOL[t.name] ?? t.name, val: `${t.calls}${t.errors ? ` · <span class="hot">${t.errors} failed</span>` : ""}`, parts: [{ n: t.calls - t.errors }, { n: t.errors, hot: true }] })), tmax) : `<p class="panel__empty">No live threads in the last 7 days. Use Email the desk to start one.</p>`}
        </div></section>
        <section class="panel"><div class="panel__head"><h2>Hand-offs by reason</h2></div><div class="panel__body">
          ${L.handoffs.length ? bars(L.handoffs.map((h) => ({ label: REASON[h.reason] ?? h.reason, val: h.n, parts: [{ n: h.n }] })), hmax) : `<p class="panel__empty">Nothing went to a person this week.</p>`}
        </div></section>
        <section class="panel"><div class="panel__head"><h2>Your threads</h2><a class="panel__more" href="#/inbox">Inbox${icon("chevron")}</a></div>
          ${S.mine.length ? `<ul class="rows">${S.mine.slice(0, 5).map(mineRow).join("")}</ul>` : `<p class="panel__empty">Threads you send from this console show up here, and only in your browser.</p>`}</section>
      </div>`;
  }
  const count = (arr) => Object.entries(arr.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {})).map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
  const threadRow = (t, end, sub) => {
    const s = sender(t.emails[0].from);
    return `<li><a class="row" href="#/inbox/${t.id}"><span class="row__t">${esc(t.title)}</span><span class="row__s">${esc(sub ?? s.name)}</span><span class="row__end">${end}</span></a></li>`;
  };
  const mineRow = (m) => `<li><a class="row" href="#/inbox/${m.id}"><span class="row__t">${esc(m.subject || "Your thread")}</span><span class="row__s">${esc(sender(m.from).name)} · ${esc(m.at?.slice(0, 16).replace("T", " "))} UTC</span><span class="row__end"><span class="pill${m.status === "handoff" ? " pill--hot" : m.status ? " pill--done" : ""}">${esc(statusLabel(m.status))}</span></span></a></li>`;
  const statusLabel = (s) => ({ book: "Booked", handoff: "Handed off", enter_existing: "Recorded", record_fcfs: "FCFS" })[s] ?? "Answered";

  // ---------- inbox ----------
  function inbox(id) {
    const T = D.threads.filter((t) => {
      const a = outcome(out(t)).short;
      if (S.filter === "done" && !["booked", "recorded", "fcfs"].includes(a)) return false;
      if (S.filter === "handoff" && a !== "handoff") return false;
      if (!S.q) return true;
      const o = out(t);
      return [t.title, t.id, o.load, facilityOf(o), ...t.emails.map((e) => e.from + " " + e.body)].join(" ").toLowerCase().includes(S.q.toLowerCase());
    });
    const mine = S.q || S.filter !== "all" ? [] : S.mine;
    const list = `<div class="list">
        <div class="list__tools">
          <label class="search">${icon("search")}<input type="search" id="q" placeholder="Search PO, load, facility, sender" value="${esc(S.q)}" aria-label="Search threads"></label>
          ${seg("filter", [["all", "All"], ["done", "Done"], ["handoff", "Hand-offs"]], S.filter, "Show threads")}
        </div>
        <div class="list__scroll" id="list-scroll">
          ${mine.length ? `<div class="list__group"><span>Yours</span><span>${mine.length}</span></div>${mine.map((m) => mineItem(m, id)).join("")}` : ""}
          <div class="list__group"><span>Recorded threads</span><span>${T.length}</span></div>
          ${T.length ? T.map((t) => threadItem(t, id)).join("") : `<p class="list__none">No thread matches.</p>`}
        </div></div>`;
    const detail = id ? `<div class="detail" id="detail">${D.threads.find((t) => t.id === id) ? recordedDetail(D.threads.find((t) => t.id === id)) : liveDetailShell(id)}</div>`
      : `<div class="detail"><div class="detail__empty"><b>Pick a thread</b><span>Each one shows the emails, Claude's reply, every step it took and how its three runs were graded.</span></div></div>`;
    return `<div class="head"><div><h1>Inbox</h1><p>Every thread the desk handled. Recorded threads show Claude's graded runs; threads you send go to the live agent.</p></div><div class="head__tools">${runSeg()}</div></div>
      <div class="inbox${id ? " has-detail" : ""}">${list}${detail}</div>`;
  }
  function threadItem(t, cur) {
    const o = out(t), oc = outcome(o), s = sender(t.emails[0].from);
    const f = facilityOf(o);
    return `<a class="thr" href="#/inbox/${t.id}"${t.id === cur ? ' aria-current="true"' : ""}>
      <span class="thr__dot ${oc.cls}" aria-hidden="true"></span>
      <span class="thr__from">${esc(s.name)}</span><span class="thr__time">${esc(fmtRecv(t.received_at))}</span>
      <span class="thr__t">${esc(t.title)}</span>
      <span class="thr__meta"><span class="${oc.cls === "hot" ? "hot" : ""}">${esc(oc.label)}</span>${o.load ? `<span>${esc(o.load)}</span>` : ""}${f ? `<span>${esc(f)}</span>` : ""}<span>${t.suite === "holdout" ? "held out" : esc(t.id)}</span></span></a>`;
  }
  function mineItem(m, cur) {
    const oc = m.status === "handoff" ? "hot" : m.status ? "done" : "";
    return `<a class="thr" href="#/inbox/${m.id}"${m.id === cur ? ' aria-current="true"' : ""}>
      <span class="thr__dot ${oc}" aria-hidden="true"></span>
      <span class="thr__from">${esc(sender(m.from).name)}</span><span class="thr__time">${esc((m.at ?? "").slice(5, 16).replace("T", " "))}</span>
      <span class="thr__t">${esc(m.subject || "Your thread")}</span>
      <span class="thr__meta"><span class="${oc === "hot" ? "hot" : ""}">${esc(statusLabel(m.status))}</span><span>live</span></span></a>`;
  }

  function recordedDetail(t) {
    const run = t.runs[S.run], o = run.output, oc = outcome(o), s = sender(t.emails[0].from);
    const fId = facilityOf(o), f = fac(fId);
    const mails = t.emails.map((e, i) => mail(e.from, "appointments@pranavgudise.dev", i === 0 ? fmtRecv(t.received_at) : "", esc(e.body))).join("")
      + (t.facility_response ? `<article class="mail mail--sys"><div class="mail__head"><b>Simulated facility</b><span>How ${esc(fId ?? "the facility")} answers in this thread</span></div><div class="mail__body">${esc(facilityResponseText(t.facility_response, f))}</div></article>` : "")
      + (o.reply ? mail("Lanternfly appointment desk", s.mailbox, "Claude's reply", md2html(o.reply), true) : "");
    return `<div class="detail__head">
        <a class="btn detail__back" href="#/inbox">${icon("back")}Inbox</a>
        <h2>${esc(t.title)}</h2>
        <div class="detail__meta"><span class="pill ${oc.cls === "hot" ? "pill--hot" : oc.cls ? "pill--done" : ""}">${esc(oc.label)}</span><span>${esc(s.name)}</span><span class="mono">${esc(t.id)}</span><span>${t.suite === "holdout" ? "Held out until the instructions were frozen" : "Written with the instructions"}</span><span>${esc(TIER[t.tier])}</span></div>
      </div>
      <div class="detail__body">
        <div class="mails">${mails}</div>
        <aside class="work" aria-label="What the agent did">
          ${outcomeCard(o, f)}
          <section><h3>What the agent did</h3>${recordedSteps(t, o)}</section>
          <section><h3>Graded runs</h3>${runsPicker(t)}${checksList(run)}</section>
          ${o.appointments?.length && f ? `<section><h3>Dock calendar at ${esc(f.id)}</h3>${miniCal(f, o.appointments[0].local)}</section>` : ""}
        </aside>
      </div>`;
  }
  const mail = (from, to, when, bodyHtml, outbound) =>
    `<article class="mail${outbound ? " mail--out" : ""}"><div class="mail__head"><span><b>${esc(from)}</b> to ${esc(to)}</span><span class="mono">${esc(when)}</span></div><div class="mail__body">${bodyHtml}</div></article>`;
  function facilityResponseText(r, f) {
    if (r.portal_errors) return `The scheduling portal returns an error the first ${r.portal_errors} times it is used. Nothing is booked when it fails.`;
    if (r.counter_offer) return `Can't take the first slot requested; offers ${fmtLocal(r.counter_offer, f?.tz)} instead.`;
    if (r.question) return `Answers the request with a question: "${r.question}"`;
    if (r.po_not_found) return "Replies that the PO is not in its system.";
    return JSON.stringify(r);
  }
  function outcomeCard(o, f) {
    const oc = outcome(o), a = o.appointments?.[0];
    let big = "", rows = [];
    if (o.action === "handoff") {
      big = REASON[o.reason] ?? o.reason;
      rows = [["To", TO[o.to] ?? o.to], ["Load", o.load ?? "none matched"]];
    } else if (a) {
      big = fmtLocal(a.local, f?.tz);
      rows = [["Facility", f ? `${f.id}, ${f.name}` : a.facility], ["Confirmation", o.confirmation ?? "none"], ["Booked by", o.channel ?? (o.action === "enter_existing" ? "the customer" : "")], ["Load", o.load]];
    } else if (o.action === "record_fcfs") {
      big = "No appointment needed";
      rows = [["Facility", f ? `${f.id}, ${f.name}` : o.facility], ["Load", o.load]];
    } else big = "Replied";
    if (o.notify?.length) rows.push(["Notified", o.notify.map((n) => (n === "ae" ? "account executive" : n)).join(", ")]);
    if (o.flags?.length) rows.push(["Flags", o.flags.join(", ")]);
    return `<div class="outcome"><div class="outcome__top"><h3 style="margin:0">Outcome</h3><span class="pill ${oc.cls === "hot" ? "pill--hot" : "pill--done"}">${esc(oc.label)}</span></div>
      <div class="outcome__big">${esc(big)}</div>
      <dl class="kv">${rows.filter((r) => r[1]).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      ${o.action === "handoff" && typeof o.log === "string" ? `<div class="note"><b>Note for the ${esc((TO[o.to] ?? "person").toLowerCase())}:</b> ${esc(o.log)}</div>` : ""}</div>`;
  }
  function recordedSteps(t, o) {
    const run = t.runs[S.run];
    if (run.steps) return traceSteps(run.steps);
    if (!Array.isArray(o.log)) {
      return `<ol class="steps">${stepLi("hot", "handoff", "Hand to a person", `${TO[o.to] ?? o.to}: ${REASON[o.reason] ?? o.reason}`)}${stepLi("done", "check", "Wrote the reply", "Told the sender a person will follow up")}</ol>
        <p class="step__d" style="margin:10px 0 0">This run recorded the hand-off and its note, not each tool call before it.</p>`;
    }
    const f = fac(facilityOf(o)), L = load(o.load), fr = t.facility_response ?? {};
    let ai = 0, ni = 0;
    const att = o.attempts ?? [];
    const items = o.log.map((name) => {
      if (name.startsWith("stopped")) return stepLi("done", "check", "Wrote the reply", name === "stopped: answered" ? "Sent in the same thread" : name.replace("stopped: ", "Stopped: "));
      switch (name) {
        case "find_load": return stepLi("", "search", TOOL[name], L ? `${L.load_no}, ${L.po}: ${L.pickup.facility} to ${L.delivery.facility}${L.hazmat ? ", hazmat" : ""}` : "Matched the PO with the facility");
        case "get_facility": return stepLi("", "calendar", TOOL[name], f ? `${f.id} books by ${f.channel}; open ${f.open} to ${f.close} ${TZ[f.tz] ?? ""}${f.notice_hours ? `; ${f.notice_hours} h notice` : ""}` : "Hours, channel and notice rules");
        case "estimate_arrival": return stepLi("", "send", TOOL[name], L ? `${L.miles} miles from ${L.pickup.facility}, converted to the receiver's time zone` : "Pickup time plus transit");
        case "get_open_slots": return stepLi("", "calendar", TOOL[name], f ? `At ${f.id}, inside the customer window and after the notice period` : "Inside the customer window");
        case "request_appointment": {
          const i = ai++, ch = att[i] ?? o.channel, last = i === att.length - 1;
          if (last && o.action === "book") {
            const fell = i > 0 && att[i - 1] !== ch;
            return stepLi("done", "check", `${TOOL[name]} by ${ch}`, `Confirmed ${o.confirmation ?? ""}${fell ? ` after the ${att[i - 1]} failed` : ""}`);
          }
          if (fr.portal_errors && ch === "portal") return stepLi("hot", "retry", `${TOOL[name]} by portal`, "Portal returned an error (HTTP 503); nothing booked, tried again");
          if (fr.counter_offer) return stepLi("hot", "retry", `${TOOL[name]} by ${ch}`, `Facility offered ${fmtLocal(fr.counter_offer, f?.tz)} instead; it fits the window`);
          if (fr.question) return stepLi("hot", "alert", `${TOOL[name]} by ${ch}`, `Facility asked: "${fr.question}"`);
          if (fr.po_not_found) return stepLi("hot", "alert", `${TOOL[name]} by ${ch}`, "Receiver says the PO is not in its system");
          return stepLi("hot", "retry", `${TOOL[name]} by ${ch}`, "Not confirmed; tried again");
        }
        case "record_existing_appointment": return stepLi("done", "check", TOOL[name], `Entered ${o.confirmation ?? "the customer's appointment"} without booking a second one`);
        case "record_fcfs": return stepLi("done", "check", TOOL[name], `${o.facility ?? ""} takes trucks in arrival order; nothing to book`);
        case "notify": { const who = o.notify?.[ni++]; return stepLi("", "mail", who === "ae" ? "Flag the account executive" : "Notify the carrier", who === "ae" ? "The appointment moved; the AE hears first" : L?.carrier ? `${L.carrier} gets the appointment` : "Carrier gets the appointment"); }
        default: return stepLi("", "chevron", TOOL[name] ?? name, "");
      }
    });
    return `<ol class="steps">${items.join("")}</ol>`;
  }
  const stepLi = (cls, ic, title, d, extra = "", meta = "") =>
    `<li class="step${cls ? " step--" + cls : ""}"><span class="step__icon">${icon(ic)}</span><div><div class="step__t"><span>${esc(title)}</span>${meta ? `<span class="mono">${esc(meta)}</span>` : ""}</div>${d ? `<div class="step__d">${esc(d)}</div>` : ""}${extra}</div></li>`;

  function traceSteps(steps) {
    const tools = steps.filter((s) => s.kind === "tool");
    const models = steps.filter((s) => s.kind === "model");
    const cost = models.reduce((a, m) => a + m.cost_usd, 0);
    const items = tools.map((s) => {
      const o = s.output ?? {};
      let cls = s.ok ? "" : "hot", ic = s.ok ? "chevron" : "alert", d = s.ok ? "" : s.error ?? "Failed";
      if (s.ok && s.name === "request_appointment") {
        if (o.status === "confirmed") { cls = "done"; ic = "check"; d = `Confirmed ${o.confirmation} by ${o.channel}, ${o.local}`; }
        else { cls = "hot"; ic = "retry"; d = o.message ?? o.question ?? o.status; }
      } else if (s.ok && s.name === "hand_off") { cls = "hot"; ic = "handoff"; d = `${TO[s.input?.to] ?? s.input?.to ?? ""}: ${REASON[s.input?.reason] ?? s.input?.reason ?? ""}`; }
      else if (s.ok && ["record_existing_appointment", "record_fcfs"].includes(s.name)) { cls = "done"; ic = "check"; d = "Recorded"; }
      else if (s.ok && s.name === "notify") { ic = "mail"; d = `${s.input?.to ?? ""}`; }
      else if (s.ok) d = summarizeInput(s.input);
      const extra = `<details><summary>Input and output</summary><pre>${esc(JSON.stringify(s.input, null, 1))}</pre><pre>${esc(s.ok ? JSON.stringify(s.output, null, 1).slice(0, 2000) : s.error)}</pre></details>`;
      return stepLi(cls, ic, TOOL[s.name] ?? s.name, d, extra, `${s.ms} ms`);
    });
    items.push(stepLi("done", "check", "Wrote the reply", `${models.length} Claude calls, ${usd(cost, 3)}`));
    return `<ol class="steps">${items.join("")}</ol>`;
  }
  const summarizeInput = (i) => Object.entries(i ?? {}).filter(([, v]) => typeof v !== "object").map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ").slice(0, 140);

  function runsPicker(t) {
    return `<div class="runs" role="group" aria-label="Pick a graded run">${t.runs.map((r, i) => `<button type="button" data-run="${i}" aria-pressed="${i === S.run}"><b class="${r.passed ? "" : "hot"}">Run ${r.run} · ${r.passed ? "pass" : "fail"}</b><span>${usd(r.cost_usd, 3)}</span><span>${Math.round(r.latency_s)} s</span></button>`).join("")}</div>`;
  }
  function checksList(run) {
    return `<ul class="checks">${D.checks.map((c) => { const bad = run.failed.includes(c.id); return `<li class="${bad ? "fail" : ""}"><span class="mono">${c.id}</span><span>${esc(c.text)}${c.critical ? " <span class=\"mono\">critical</span>" : ""}</span>${icon(bad ? "x" : "check")}</li>`; }).join("")}</ul>`;
  }

  // live threads
  function liveDetailShell(id) {
    return `<div class="detail__head"><a class="btn detail__back" href="#/inbox">${icon("back")}Inbox</a><h2>Loading the thread</h2></div><div class="detail__empty"><span class="spin" aria-hidden="true"></span></div>`;
  }
  after.inbox = async (id) => {
    const q = $("#q");
    if (q) q.addEventListener("input", () => { S.q = q.value; const pos = q.selectionStart; render(); const n = $("#q"); n.focus(); n.setSelectionRange(pos, pos); });
    const cur = $(".thr[aria-current]");
    if (cur && !isVisible(cur)) { const box = $("#list-scroll"); box.scrollTop += cur.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 2 + cur.offsetHeight / 2; }
    if (!id || D.threads.some((t) => t.id === id)) return;
    try {
      const th = S.liveCache.get(id) ?? (await getJSON(`/api/desk/thread/${encodeURIComponent(id)}`));
      S.liveCache.set(id, th);
      if (!S.mine.some((m) => m.id === id)) remember({ id, from: th.sender?.replace(/^(web|email): /, ""), subject: firstLine(th.turns[0]?.user_text), at: th.created_at, status: statusOf(th) });
      if (route().arg === id) $("#detail").innerHTML = liveDetail(th);
      wireReply(id);
    } catch {
      $("#detail").innerHTML = `<div class="detail__head"><a class="btn detail__back" href="#/inbox">${icon("back")}Inbox</a><h2>Thread not found</h2></div><div class="detail__empty"><span>This thread is not on this desk any more, or the link is incomplete.</span></div>`;
    }
  };
  const isVisible = (el) => { const r = el.getBoundingClientRect(), p = el.parentElement.getBoundingClientRect(); return r.top >= p.top && r.bottom <= p.bottom; };
  const firstLine = (s) => String(s ?? "").replace(/^Subject:\s*/i, "").split("\n").find((l) => l.trim())?.trim().slice(0, 90) ?? "";
  function statusOf(th) {
    const steps = th.turns.flatMap((t) => t.steps).filter((s) => s.kind === "tool" && s.ok);
    if (steps.some((s) => s.name === "hand_off")) return "handoff";
    if (steps.some((s) => s.name === "request_appointment" && s.output?.status === "confirmed")) return "book";
    if (steps.some((s) => s.name === "record_existing_appointment")) return "enter_existing";
    if (steps.some((s) => s.name === "record_fcfs")) return "record_fcfs";
    return "";
  }
  function remember(m) {
    S.mine = [m, ...S.mine.filter((x) => x.id !== m.id)].slice(0, 20);
    store.set("desk.mine", S.mine);
    $("#n-inbox").textContent = D.threads.length + S.mine.length;
  }
  function liveDetail(th) {
    const status = statusOf(th), from = th.sender?.replace(/^(web|email): /, "") ?? "", s = sender(from);
    const last = th.turns.at(-1);
    const conf = th.turns.flatMap((t) => t.steps).filter((x) => x.kind === "tool" && x.ok && x.name === "request_appointment" && x.output?.status === "confirmed").at(-1);
    const ho = th.turns.flatMap((t) => t.steps).filter((x) => x.kind === "tool" && x.ok && x.name === "hand_off").at(-1);
    const f = conf ? fac(conf.output.facility) : null;
    const mails = th.turns.map((t) => mail(from || "You", "appointments@pranavgudise.dev", t.created_at.slice(0, 16).replace("T", " ") + " UTC", esc(t.user_text)) + mail("Lanternfly appointment desk", s.mailbox || from, `${(t.ms / 1000).toFixed(1)} s · ${usd(t.cost_usd, 3)}`, esc(t.reply), true)).join("");
    const oc = status === "handoff" ? { label: "Handed off", cls: "hot" } : status ? { label: statusLabel(status), cls: "done" } : { label: "Answered", cls: "" };
    return `<div class="detail__head"><a class="btn detail__back" href="#/inbox">${icon("back")}Inbox</a>
        <h2>${esc(firstLine(th.turns[0]?.user_text) || "Your thread")}</h2>
        <div class="detail__meta"><span class="pill ${oc.cls === "hot" ? "pill--hot" : oc.cls ? "pill--done" : ""}">${esc(oc.label)}</span><span>${esc(s.name)}</span><span>Live, version ${esc(th.version)}</span><span class="mono">${usd(th.cost_usd, 3)}</span><a href="/trace/${esc(th.id)}">Full trace</a></div></div>
      <div class="detail__body">
        <div class="mails">${mails}
          <form class="reply" id="reply-form"><label for="reply-msg" class="mono" style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3)">Reply in this thread</label>
            <textarea id="reply-msg" required placeholder="Answer the desk's question, or ask for a change"></textarea>
            <div class="reply__foot"><span>Goes to the live agent</span><button class="btn btn--ink" type="submit">Send${icon("send")}</button></div>
            <p class="drawer__error" id="reply-error" role="alert" hidden></p></form></div>
        <aside class="work" aria-label="What the agent did">
          <div class="outcome"><div class="outcome__top"><h3 style="margin:0">Outcome</h3><span class="pill ${oc.cls === "hot" ? "pill--hot" : "pill--done"}">${esc(oc.label)}</span></div>
            <div class="outcome__big">${conf ? esc(fmtLocal(conf.output.local, f?.tz)) : ho ? esc(REASON[ho.input.reason] ?? ho.input.reason) : "Replied"}</div>
            <dl class="kv">${conf ? `<dt>Facility</dt><dd>${esc(f ? `${f.id}, ${f.name}` : conf.output.facility)}</dd><dt>Confirmation</dt><dd>${esc(conf.output.confirmation)}</dd><dt>Booked by</dt><dd>${esc(conf.output.channel)}</dd>` : ""}${ho ? `<dt>To</dt><dd>${esc(TO[ho.input.to] ?? ho.input.to)}</dd>` : ""}<dt>Emails</dt><dd>${th.turns.length}</dd></dl>
            ${ho?.input?.note ? `<div class="note"><b>Note:</b> ${esc(ho.input.note)}</div>` : ""}</div>
          <section><h3>What the agent did${th.turns.length > 1 ? `, last email` : ""}</h3>${traceSteps(last.steps)}</section>
          ${conf && f ? `<section><h3>Dock calendar at ${esc(f.id)}</h3>${miniCal(f, conf.output.local)}</section>` : ""}
        </aside></div>`;
  }
  function wireReply(id) {
    const form = $("#reply-form");
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $("#reply-msg").value.trim();
      if (!msg) return;
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true; btn.innerHTML = `<span class="spin"></span>Working`;
      try {
        await send({ conversation_id: id, message: msg });
        S.liveCache.delete(id);
        render();
      } catch (err) {
        const el = $("#reply-error"); el.hidden = false; el.textContent = err.message;
        btn.disabled = false; btn.innerHTML = `Send${icon("send")}`;
      }
    });
  }
  async function send(body) {
    const r = await fetch("/api/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `The desk did not answer (HTTP ${r.status}). Try again in a minute.`);
    return j;
  }

  // ---------- hand-offs ----------
  function handoffs() {
    const H = D.threads.filter((t) => out(t).action === "handoff");
    const by = count(H.map((t) => out(t).to));
    return `<div class="head"><div><h1>Hand-offs</h1><p>${H.length} of ${D.threads.length} threads went to a person in run ${S.run + 1}: ${by.map((b) => `${b.n} to ${b.key === "ae" ? "an account executive" : "a coordinator"}`).join(" and ")}. The agent leaves a note with what it already found, so nobody starts from zero.</p></div><div class="head__tools">${runSeg()}</div></div>
      <section class="panel"><ul class="queue">${H.map((t) => { const o = out(t), s = sender(t.emails[0].from); return `<li><a href="#/inbox/${t.id}">
        <div><div class="queue__t">${esc(t.title)}</div><div class="queue__s">${esc(s.name)} · <span class="mono">${esc(o.load ?? "no load matched")}</span> · ${esc(fmtRecv(t.received_at))}</div>
          <div class="queue__tags"><span class="pill pill--hot">${esc(REASON[o.reason] ?? o.reason)}</span><span class="pill">${esc(TO[o.to] ?? o.to)}</span></div></div>
        <p class="queue__note" style="margin:0">${esc(typeof o.log === "string" ? o.log : "")}</p></a></li>`; }).join("")}</ul></section>`;
  }

  // ---------- dock calendars ----------
  const DATES = (() => { const out = []; for (let d = Date.parse("2026-12-07T00:00:00Z"); out.length < 5; d += 86400_000) out.push(new Date(d).toISOString().slice(0, 10)); return out; })();
  function docks(id) {
    const booked = new Map();
    for (const t of D.threads) for (const a of out(t).appointments ?? []) {
      const k = `${a.facility}|${a.local}`;
      booked.set(k, [...(booked.get(k) ?? []), t]);
    }
    const perFac = (fid) => [...booked.keys()].filter((k) => k.startsWith(fid + "|")).reduce((n, k) => n + booked.get(k).length, 0);
    const cur = fac(id) ?? D.facilities.slice().sort((a, b) => perFac(b.id) - perFac(a.id))[0];
    const marks = [...booked].filter(([k]) => k.startsWith(cur.id + "|")).map(([k, ts]) => ({ local: k.split("|")[1], ts }));
    const extraDates = marks.map((m) => m.local.slice(0, 10)).filter((d) => !DATES.includes(d));
    const dates = [...DATES, ...new Set(extraDates)].sort();
    return `<div class="head"><div><h1>Dock calendars</h1><p>Each facility's dock hours and booked slots from the seed, with the appointments Claude wrote in run ${S.run + 1}. Every recorded thread ran on its own copy of the calendars, so two threads can land on the same slot.</p></div><div class="head__tools">${runSeg()}</div></div>
      <div class="docks">
        <section class="panel"><ul class="fac">${D.facilities.map((f) => `<li><a href="#/docks/${f.id}"${f.id === cur.id ? ' aria-current="true"' : ""}><b>${esc(f.id)}</b><span>${esc(f.name)}</span><em>${perFac(f.id) || ""}</em></a></li>`).join("")}</ul></section>
        <section class="panel"><div class="panel__head"><h2>${esc(cur.id)} · ${esc(cur.name)}</h2></div><div class="panel__body">
          <div class="fac__facts"><span>Books by <b>${esc(cur.fcfs ? "first come, first served" : cur.channel)}</b></span><span>Open <b>${cur.open} to ${cur.close}</b> ${esc(TZ[cur.tz] ?? cur.tz)}</span><span>Notice <b>${cur.notice_hours ? cur.notice_hours + " hours" : "none"}</b></span>${cur.holidays.length ? `<span>Closed <b>${cur.holidays.map(md).join(", ")}</b></span>` : ""}</div>
          ${calendar(cur, dates, marks)}
          <div class="legend"><span><i class="open"></i>Dock open</span><span><i class="taken"></i>Already taken</span><span><i></i>Booked by the agent</span></div>
        </div></section>
      </div>`;
  }
  const H0 = 4, H1 = 20, SPAN = (H1 - H0) * 60;
  const pct = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return Math.max(0, Math.min(100, ((h * 60 + m - H0 * 60) / SPAN) * 100)); };
  const slotW = (60 / SPAN) * 100;
  function calendar(f, dates, marks, mini = false) {
    const ticks = [4, 8, 12, 16, 20].map((h) => `<span style="left:${((h - H0) / (H1 - H0)) * 100}%">${String(h).padStart(2, "0")}:00</span>`).join("");
    const rows = dates.map((d) => {
      const wd = (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7;
      const closed = f.holidays.includes(d) ? "Holiday" : f.days.includes(wd) ? "" : "Weekend";
      const taken = f.booked.filter((b) => b.startsWith(d)).map((b) => `<span class="cal__taken" style="left:${pct(b.slice(11, 16))}%;width:${slotW}%" title="Taken ${b.slice(11, 16)}"></span>`).join("");
      const ms = marks.filter((m) => m.local.startsWith(d)).map((m) => {
        const n = m.ts?.length ?? 1, tip = m.ts ? m.ts.map((t) => t.id).join(", ") : "This thread";
        return `<a class="cal__appt${m.me ? " cal__appt--me" : ""}" href="${m.ts ? `#/inbox/${m.ts[0].id}` : "#"}" style="left:${pct(m.local.slice(11, 16))}%;width:${slotW}%" title="${esc(`${m.local.slice(11, 16)} ${TZ[f.tz] ?? ""}: ${tip}`)}" aria-label="${esc(`Appointment ${fmtLocal(m.local, f.tz)}${n > 1 ? `, ${n} threads` : ""}`)}">${n > 1 ? `<b>${n}</b>` : ""}</a>`;
      }).join("");
      return `<div class="cal__row"><span class="cal__day">${weekday(d)} ${md(d)}${!mini && marks.some((m) => m.local.startsWith(d)) ? `<small>${marks.filter((m) => m.local.startsWith(d)).reduce((a, m) => a + (m.ts?.length ?? 1), 0)} booked</small>` : ""}</span>
        <div class="cal__track">${closed ? `<span class="cal__closed">${closed}</span>` : `<span class="cal__open" style="left:${pct(f.open)}%;width:${pct(f.close) - pct(f.open)}%"></span>`}${taken}${ms}</div></div>`;
    }).join("");
    return `<div class="cal${mini ? " cal--mini" : ""}"><div class="cal__hours"><span></span><div class="cal__ticks">${ticks}</div></div>${rows}</div>`;
  }
  function miniCal(f, local) {
    const d0 = Date.parse(`${local.slice(0, 10)}T00:00:00Z`);
    const dates = [-1, 0, 1].map((k) => new Date(d0 + k * 86400_000).toISOString().slice(0, 10));
    return calendar(f, dates, [{ local, me: true }], true);
  }

  // ---------- releases ----------
  function releases() {
    const R = S.releases;
    const gate = D.gate[S.gateSuite];
    const gateHtml = `<section class="panel panel--wide"><div class="panel__head"><h2>Go-live gate, recorded</h2>${seg("gate", [["dev", "25 threads"], ["holdout", "15 held out"]], S.gateSuite, "Gate suite")}</div>
      <div class="gate">${gate.map((g) => { const min = Math.min(...g.by_run.map((r) => r.passed)), tot = g.by_run[0].total; return `<div class="gate__row"><div class="gate__name"><b>${esc(g.name)}</b><span>${esc(g.what)}</span></div>
        <div class="gate__runs">${g.by_run.map((r) => `<span class="${r.passed < r.total || r.critical ? "hot" : ""}">Run ${r.run}: ${r.passed}/${r.total}${r.critical ? `, ${r.critical} critical` : ""}</span>`).join("")}<span>${usd(g.cost_usd)}</span></div>
        <span class="pill ${g.decision === "go" ? "pill--done" : "pill--hot"}">${g.decision === "go" ? "GO" : "NO-GO"} · ${min}/${tot}</span></div>`; }).join("")}</div>
      <div class="panel__body" style="border-top:1px solid var(--line);font-size:12.5px;color:var(--ink-2)">Go-live needs ${S.gateSuite === "dev" ? "24 of 25" : "14 of 15"} on every run and no critical failures. The two scripted setups check the plumbing and show what the gate catches.</div></section>`;
    if (!R) return head() + `<section class="panel"><p class="panel__empty">Loading releases.</p></section>` + gateHtml;
    if (R.error || !R.stages?.length) return head() + `<section class="panel"><p class="panel__empty">The release history did not load.</p></section>` + gateHtml;
    const byV = new Map();
    for (const s of R.stages) byV.set(s.version, [...(byV.get(s.version) ?? []), s]);
    const cur = byV.get(R.current) ?? [...byV.values()][0];
    const st = (pct) => cur.filter((s) => s.stage === pct).at(0);
    const stages = [[0, "Uploaded", "No traffic"], [10, "10% of traffic", "Held-out gate"], [50, "50% of traffic", "25-thread gate"], [100, "All traffic", "Health check"]];
    return head() + `<section class="panel"><div class="panel__head"><h2>${esc(cur[0].version)}, the version serving now</h2><a class="panel__more" href="${esc(cur[0].run_url ?? "#")}">CI run${icon("arrow")}</a></div>
        <div class="pipe">${stages.map(([p, k, what]) => { const s = st(p); return `<div class="pipe__stage${s ? "" : " is-off"}"><span class="pipe__k">${k}</span><span class="pipe__pct">${p}%</span>${s ? `<span class="pill ${/go/i.test(s.decision) && !/no/i.test(s.decision) || s.decision === "uploaded" ? "pill--done" : "pill--hot"}">${esc(s.decision)}</span><span class="pipe__d">${esc(s.detail)}</span><span class="pipe__d mono">${esc(s.at)} UTC</span>` : `<span class="pipe__d">${esc(what)}: not run</span>`}</div>`; }).join("")}</div></section>
      ${gateHtml}<section class="panel panel--wide"><div class="panel__head"><h2>Every stage</h2><span class="mono" style="font-size:12px;color:var(--ink-3)">${byV.size} versions</span></div><div class="tablewrap"><table class="table">
        <thead><tr><th>Version</th><th>Stage</th><th>Decision</th><th>Detail</th><th>When (UTC)</th><th></th></tr></thead>
        <tbody>${R.stages.filter((s) => S.allStages || [...byV.keys()].slice(0, 2).includes(s.version)).map((s) => `<tr><td class="mono">${esc(s.version)}</td><td class="mono num">${s.stage}%</td><td><span class="pill ${/no-go|rolled/i.test(s.decision) ? "pill--hot" : ""}">${esc(s.decision)}</span></td><td>${esc(s.detail)}</td><td class="mono">${esc(s.at)}</td><td>${s.run_url ? `<a href="${esc(s.run_url)}">CI</a>` : ""}</td></tr>`).join("")}</tbody></table></div>${!S.allStages && byV.size > 2 ? `<div class="more-rows"><button class="btn" type="button" data-all-stages>Show all ${byV.size} versions</button></div>` : ""}</section>`;
    function head() { return `<div class="head"><div><h1>Releases</h1><p>Every push uploads a new version with no traffic. It gets 10% and must pass the held-out gate, then 50% and the 25-thread gate, then 100%. A failed stage puts the previous version back.</p></div></div>`; }
  }

  // ---------- events ----------
  main.addEventListener("click", (e) => {
    const b = e.target.closest("[data-seg]");
    if (b) {
      const { seg: name, v } = b.dataset;
      if (name === "run") S.run = +v;
      if (name === "source") S.source = v;
      if (name === "filter") S.filter = v;
      if (name === "gate") S.gateSuite = v;
      render();
      return;
    }
    if (e.target.closest("[data-all-stages]")) { S.allStages = true; render(); return; }
    const r = e.target.closest("[data-run]");
    if (r) { S.run = +r.dataset.run; render(); }
  });
  main.addEventListener("keydown", (e) => {
    const b = e.target.closest("[role=radio]");
    if (!b || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const all = [...b.parentElement.children], i = all.indexOf(b) + (e.key === "ArrowRight" ? 1 : -1);
    const n = all[(i + all.length) % all.length];
    n.click();
    requestAnimationFrame(() => document.querySelector(`[data-seg="${n.dataset.seg}"][data-v="${n.dataset.v}"]`)?.focus());
  });

  // theme
  const themeBtn = $("#theme");
  const isDark = () => (document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
  const paintTheme = () => { themeBtn.innerHTML = icon(isDark() ? "sun" : "moon"); themeBtn.setAttribute("aria-label", isDark() ? "Switch to light theme" : "Switch to dark theme"); };
  themeBtn.addEventListener("click", () => { const t = isDark() ? "light" : "dark"; document.documentElement.dataset.theme = t; store.set("desk.theme", t); try { localStorage.setItem("desk.theme", t); } catch {} paintTheme(); });
  paintTheme();

  // mobile nav
  const nav = $("#nav");
  const closeNav = () => nav.classList.remove("is-open");
  $("#open-nav").addEventListener("click", () => { nav.classList.add("is-open"); nav.querySelector("a")?.focus(); });
  document.querySelectorAll("[data-close-nav]").forEach((el) => el.addEventListener("click", closeNav));

  // compose
  const drawer = $("#compose"), form = $("#compose-form");
  const senders = [...new Set(D.threads.flatMap((t) => t.emails.map((e) => e.from)))];
  $("#compose-from").innerHTML = senders.map((s) => `<option value="${esc(s)}">${esc(sender(s).name)}: ${esc(s)}</option>`).join("");
  const examples = [["f01", "Book a delivery"], ["f11", "Carrier running late"], ["f13", "Portal fails"], ["f25", "Hazmat load"]];
  $("#compose-examples").innerHTML = examples.map(([id, l]) => `<button type="button" data-ex="${id}">${esc(l)}</button>`).join("");
  $("#compose-examples").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ex]"); if (!b) return;
    const t = D.threads.find((x) => x.id === b.dataset.ex);
    $("#compose-msg").value = t.emails[0].body; $("#compose-from").value = t.emails[0].from;
  });
  let lastFocus = null;
  const openCompose = () => { lastFocus = document.activeElement; drawer.hidden = false; if (!$("#compose-msg").value) $("#compose-examples button").click(); $("#compose-msg").focus(); };
  const closeCompose = () => { drawer.hidden = true; lastFocus?.focus?.(); };
  $("#compose-open").addEventListener("click", openCompose);
  drawer.querySelectorAll("[data-close-compose]").forEach((el) => el.addEventListener("click", closeCompose));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !drawer.hidden) closeCompose();
    if (e.key === "Escape" && nav.classList.contains("is-open")) closeNav();
    if (e.key === "Tab" && !drawer.hidden) {
      const f = [...form.querySelectorAll("button, select, textarea, a[href]")].filter((x) => !x.disabled);
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#compose-send"), err = $("#compose-error");
    const from = $("#compose-from").value, message = $("#compose-msg").value.trim();
    if (!message) return;
    err.hidden = true; btn.disabled = true; btn.innerHTML = `<span class="spin" aria-hidden="true"></span><span>The agent is working</span>`;
    try {
      const j = await send({ from, message });
      remember({ id: j.conversation_id, from, subject: firstLine(message), at: new Date().toISOString(), status: j.result?.action === "handoff" ? "handoff" : j.result?.action ?? "" });
      $("#compose-msg").value = "";
      closeCompose();
      location.hash = `#/inbox/${j.conversation_id}`;
      loadLive();
    } catch (x) {
      err.hidden = false; err.textContent = x.message;
    } finally {
      btn.disabled = false; btn.innerHTML = `<span>Send to the agent</span>${icon("send")}`;
    }
  });

  // counts and start
  $("#n-inbox").textContent = D.threads.length + S.mine.length;
  $("#n-handoffs").textContent = D.threads.filter((t) => out(t, 0).action === "handoff").length;
  window.addEventListener("hashchange", () => { render(); main.focus({ preventScroll: true }); window.scrollTo(0, 0); });
  render();
  loadLive();
})();

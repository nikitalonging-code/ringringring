const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor("#111315");
  tg.setBackgroundColor("#111315");
}

const socket = io({ transports: ["websocket", "polling"], reconnection: true, reconnectionAttempts: Infinity, timeout: 8000 });
const $ = (s) => document.querySelector(s);
const initData = tg?.initData || "";
const user = tg?.initDataUnsafe?.user || null;
const queryParams = new URLSearchParams(location.search);
const startParam = tg?.initDataUnsafe?.start_param || queryParams.get("ref") || "";
const raffleFromUrl = queryParams.get("raffle") || (startParam.match(/^rg_([0-9a-f-]{36})_\d+$/i)?.[1] || startParam.match(/^raffle_([0-9a-f-]{36})$/i)?.[1] || "");

let lastWinner = null;
let lastSpinTarget = null;
let currentState = null;
let previousStatus = null;
let currentBalance = 0;
let isAdmin = false;

const betModal = $("#betModal");
const topupModal = $("#topupModal");
const withdrawModal = $("#withdrawModal");
let withdrawCurrency = "STAR";
let topupCurrency = "STAR";
let GRAM_USD_PER_STAR = Number(window.__RING_GRAM_USD_PER_STAR || 0.015);
let tonConnectUI = null;
let tonWalletAddress = "";

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}
function openModal(el) { el.classList.remove("hidden"); }
function closeModal(el) { el.classList.add("hidden"); }

function authHeaders(extra = {}) {
  return { ...extra, "X-Telegram-Init-Data": initData };
}

function setBalance(value) {
  currentBalance = Number(value || 0);
  $("#balance").textContent = currentBalance.toFixed(2);
  $("#modalBalance").textContent = currentBalance.toFixed(2) + " ⭐";
}

function handleNotTelegram() {
  if (!tg || !initData) {
    toast("Откройте Mini App из Telegram.");
  }
}

$("#betBtn").onclick = () => {
  if (!initData) return handleNotTelegram();
  if (currentState?.status === "SPINNING" || currentState?.status === "RESULT") return toast("Ставки уже закрыты.");
  if (currentState?.players?.some(p => p.id === String(user?.id) && p.bet > 0)) return toast("Вы уже сделали ставку в этом раунде.");
  $("#betAmount").value = "";
  $("#modalBalance").textContent = currentBalance.toFixed(2) + " ⭐";
  openModal(betModal);
};

$("#modalClose").onclick = () => closeModal(betModal);
$("#topupBtn").onclick = () => {
  if (!initData) return handleNotTelegram();
  openModal(topupModal);
};
$("#topupClose").onclick = () => closeModal(topupModal);

function updateGramConversion(inputSelector, outputSelector) {
  const amount = Number($(inputSelector)?.value || 0);
  const dollars = Math.max(0, amount) * GRAM_USD_PER_STAR;
  $(outputSelector).textContent = `Эквивалент GRAM: ≈ $${dollars.toFixed(2)}`;
}

function setTopupCurrency(currency) {
  topupCurrency = String(currency).toUpperCase() === "GRAM" ? "GRAM" : "STAR";
  $("#topupCurrencyStar").classList.toggle("active", topupCurrency === "STAR");
  $("#topupCurrencyGram").classList.toggle("active", topupCurrency === "GRAM");
  $("#starsTopupPanel").classList.toggle("hidden", topupCurrency !== "STAR");
  $("#gramTopupPanel").classList.toggle("hidden", topupCurrency !== "GRAM");
  updateGramConversion("#gramTopupAmount", "#gramTopupConvert");
}

function setWithdrawCurrency(currency) {
  withdrawCurrency = String(currency).toUpperCase() === "GRAM" ? "GRAM" : "STAR";
  $("#withdrawCurrencyStar").classList.toggle("active", withdrawCurrency === "STAR");
  $("#withdrawCurrencyGram").classList.toggle("active", withdrawCurrency === "GRAM");
  $("#withdrawConvert").classList.toggle("hidden", withdrawCurrency !== "GRAM");
  $("#withdrawWalletRow").classList.toggle("hidden", withdrawCurrency !== "GRAM");
  $("#withdrawAmount").placeholder = "Сумма в Stars…";
  updateGramConversion("#withdrawAmount", "#withdrawConvert");
}

$("#gramTopupAmount").addEventListener("input", () => updateGramConversion("#gramTopupAmount", "#gramTopupConvert"));
$("#withdrawAmount").addEventListener("input", () => updateGramConversion("#withdrawAmount", "#withdrawConvert"));

async function initTonConnect() {
  const fallback = $("#tonConnectFallback");
  const status = $("#tonWalletStatus");
  const root = $("#tonConnectButton");
  if (fallback) fallback.onclick = async () => {
    try {
      if (!tonConnectUI) await initTonConnect(true);
      if (!tonConnectUI) throw new Error("TON Connect не инициализирован.");
      await tonConnectUI.openModal();
    } catch (e) {
      toast(e.message || "Не удалось открыть TON Connect.");
    }
  };

  if (!window.TON_CONNECT_UI) {
    if (status) status.textContent = "TON Connect не загрузился";
    return null;
  }

  try {
    const cfgRes = await fetch("/api/tonconnect/config", { headers: authHeaders() });
    const cfg = await cfgRes.json().catch(() => ({}));
    if (!cfgRes.ok) throw new Error(cfg.error || "TON Connect не настроен.");

    if (tonConnectUI) return tonConnectUI;
    tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
      manifestUrl: cfg.manifestUrl,
      buttonRootId: "tonConnectButton",
      uiPreferences: {
        theme: "DARK",
        borderRadius: "m"
      }
    });

    if (fallback) fallback.textContent = "Подключить TON Connect";
    tonConnectUI.onStatusChange(wallet => {
      tonWalletAddress = wallet?.account?.address || "";
      if (status) status.textContent = tonWalletAddress
        ? `Подключён: ${tonWalletAddress.slice(0, 6)}…${tonWalletAddress.slice(-6)}`
        : "Кошелёк не подключён";
      if (fallback) fallback.classList.toggle("hidden", !!tonWalletAddress);
    });
    if (typeof tonConnectUI.connectionRestored === "object" && tonConnectUI.connectionRestored?.then) {
      await tonConnectUI.connectionRestored;
    }
    return tonConnectUI;
  } catch (e) {
    console.warn("TON Connect init failed:", e);
    if (status) status.textContent = `Ошибка TON Connect: ${e.message || "unknown"}`;
    return null;
  }
}

$("#topupCurrencyStar").onclick = () => setTopupCurrency("STAR");
$("#topupCurrencyGram").onclick = () => setTopupCurrency("GRAM");
$("#withdrawCurrencyStar").onclick = () => setWithdrawCurrency("STAR");
$("#withdrawCurrencyGram").onclick = () => setWithdrawCurrency("GRAM");

$("#withdrawBtn").onclick = () => {
  if (!initData) return handleNotTelegram();
  $("#withdrawAmount").value = "";
  $("#withdrawWallet").value = "";
  setWithdrawCurrency("STAR");
  $("#withdrawModalBalance").textContent = currentBalance.toFixed(2) + " ⭐";
  openModal(withdrawModal);
};
$("#withdrawClose").onclick = () => closeModal(withdrawModal);

$("#confirmWithdraw").onclick = async () => {
  const amount = Number($("#withdrawAmount").value);
  if (!Number.isInteger(amount) || amount <= 0) return toast("Введите целую сумму Stars больше 0.");
  if (amount > currentBalance) return toast("Недостаточно Stars на балансе.");
  const wallet = $("#withdrawWallet").value.trim();
  if (withdrawCurrency === "GRAM" && !wallet) return toast("Укажите GRAM / TON кошелёк.");
  try {
    const r = await fetch("/api/profile/withdraw", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ amount, currency: withdrawCurrency, wallet })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось отправить заявку.");
    setBalance(data.balance);
    closeModal(withdrawModal);
    toast("Заявка на вывод отправлена администратору.");
  } catch (e) { toast(e.message); }
};

$("#createGramTopup").onclick = async () => {
  const amount = Number($("#gramTopupAmount").value);
  if (!Number.isInteger(amount) || amount <= 0) return toast("Введите целую сумму Stars больше 0.");
  if (!tonConnectUI) await initTonConnect(true);
  if (!tonConnectUI || !tonWalletAddress) return toast("Сначала подключите TON Connect.");
  try {
    const cfgR = await fetch("/api/gram/topup-config", { headers: authHeaders() });
    const cfg = await cfgR.json().catch(() => ({}));
    if (!cfgR.ok) throw new Error(cfg.error || "GRAM пополнение не настроено.");
    const nanoTon = String(Math.round(amount * Number(cfg.tonPerStar || 0) * 1e9));
    if (!nanoTon || nanoTon === "0") throw new Error("Не задан курс TON/Star на Render.");
    await tonConnectUI.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 600,
      messages: [{ address: cfg.recipient, amount: nanoTon }]
    });
    const r = await fetch("/api/gram/topup-request", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ amount, wallet: tonWalletAddress })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Транзакция отправлена, но заявку создать не удалось.");
    closeModal(topupModal);
    toast("Транзакция отправлена. Заявка поступила администратору.");
  } catch (e) { toast(e.message || "Не удалось выполнить GRAM пополнение."); }
};

$("#topupBtn").onclick = () => {
  if (!initData) return handleNotTelegram();
  $("#topupAmount").value = "";
  $("#gramTopupAmount").value = "";
  setTopupCurrency("STAR");
  openModal(topupModal);
};
$("#topupClose").onclick = () => closeModal(topupModal);

$("#createInvoice").onclick = async () => {
  const amount = Number($("#topupAmount").value);
  if (!Number.isInteger(amount) || amount <= 0) return toast("Введите сумму Stars.");
  try {
    const r = await fetch("/api/stars/create-invoice", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ amount })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Ошибка создания счёта.");
    if (tg?.openInvoice) {
      tg.openInvoice(data.invoiceUrl, status => {
        if (status === "paid") toast("Платёж принят. Баланс обновится автоматически.");
        else if (status === "cancelled") toast("Оплата отменена.");
        else if (status === "failed") toast("Telegram не подтвердил оплату.");
      });
    } else toast("Счёт создан только для Telegram Mini App.");
  } catch (e) { toast(e.message); }
};

$("#confirmBet").onclick = () => {
  const amount = Number($("#betAmount").value);
  if (!Number.isInteger(amount) || amount <= 0) return toast("Введите целое число Stars.");
  if (amount > currentBalance) return toast("Недостаточно Stars на балансе.");
  socket.emit("place_bet", { amount });
};

$("#betAmount").addEventListener("keydown", e => {
  if (e.key === "Enter") $("#confirmBet").click();
});

$("#createInvoice").onclick = async () => {
  const amount = Number($("#topupAmount").value);
  if (!Number.isInteger(amount) || amount <= 0) return toast("Введите сумму Stars.");
  try {
    const r = await fetch("/api/stars/create-invoice", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ amount })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Ошибка создания счёта.");
    if (tg?.openInvoice) {
      tg.openInvoice(data.invoiceUrl, status => {
        if (status === "paid") toast("Платёж принят. Баланс обновится автоматически.");
        else if (status === "cancelled") toast("Оплата отменена.");
        else if (status === "failed") toast("Telegram не подтвердил оплату.");
      });
    } else {
      toast("Счёт создан только для Telegram Mini App.");
    }
  } catch (e) { toast(e.message); }
};

socket.on("connect", () => {
  socket.emit("join_room", { initData, referralCode: startParam });
});

socket.on("joined", data => {
  setBalance(data.balance);
  isAdmin = !!data.isAdmin;
  if (isAdmin) {
    $("#adminPanel").classList.remove("hidden");
    scheduleAdminRefresh();
  }
  if (raffleFromUrl) { setView("raffles"); }
});

// Start loading the balance immediately, in parallel with Socket.IO.
// This removes the visible wait for a socket handshake before showing the balance.
(async function bootstrap() {
  if (!initData) return handleNotTelegram();
  try {
    const r = await fetch("/api/bootstrap", { headers: authHeaders(), cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось загрузить приложение.");
    setBalance(data.user?.balance);
    if (Number.isFinite(Number(data.gramUsdPerStar))) {
      GRAM_USD_PER_STAR = Number(data.gramUsdPerStar);
    }
    isAdmin = !!data.isAdmin;
    if (isAdmin) {
      $("#adminPanel").classList.remove("hidden");
      scheduleAdminRefresh();
    }
    if (data.state) render(data.state);
    if (raffleFromUrl) { setView("raffles"); }
  } catch (e) {
    // Socket join may still succeed; don't block the app on this request.
    console.warn("Bootstrap failed:", e.message);
  }
})();

socket.on("balance_updated", data => setBalance(data.balance));
socket.on("force_banned", () => {
  toast("Ваш аккаунт заблокирован администратором.");
  $("#betBtn").disabled = true;
  $("#topupBtn").disabled = true;
  closeModal(betModal);
  closeModal(topupModal);
  closeModal(withdrawModal);
});
socket.on("unbanned", () => {
  toast("Блокировка снята.");
  $("#betBtn").disabled = false;
  $("#topupBtn").disabled = false;
});
socket.on("error_message", message => toast(message));
socket.on("bet_accepted", data => {
  setBalance(data.balance);
  closeModal(betModal);
  toast(`Ставка ${data.bet} ⭐ принята`);
});
socket.on("room_state", render);

socket.on("new_round", data => {
  lastWinner = null;
  previousStatus = null;
  closeModal($("#winnerOverlay"));
  socket.emit("join_room", { initData, referralCode: startParam });
  toast("Новый раунд запущен.");
});

function formatTimer(endAt) {
  if (!endAt) return "—";
  const seconds = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
  return "00:" + String(seconds).padStart(2, "0");
}

function render(s) {
  currentState = s;
  $("#bank").innerHTML = `${Number(s.bank || 0).toFixed(2)} <span>⭐</span>`;

  if (s.status === "WAITING") {
    $("#statusLabel").textContent = s.players.length === 0 ? "ОЖИДАЕМ ИГРОКА" : "ОЖИДАЕМ СОПЕРНИКА";
    $("#timer").textContent = "—";
  } else if (s.status === "COUNTDOWN") {
    $("#statusLabel").textContent = "ВЫБИРАЕМ ПОБЕДИТЕЛЯ";
    $("#timer").textContent = formatTimer(s.countdownEndsAt);
  } else if (s.status === "SPINNING") {
    $("#statusLabel").textContent = "СТРЕЛКА ВРАЩАЕТСЯ";
    $("#timer").textContent = "•••";
  } else if (s.status === "RESULT") {
    $("#statusLabel").textContent = "РАУНД ЗАВЕРШЁН";
    $("#timer").textContent = "🏆";
  }

  renderPlayers(s.players || []);
  renderWinnerCard(s);
  renderWheel(s);

  if (previousStatus !== s.status && s.status === "COUNTDOWN") toast("Второй игрок вошёл — старт 20 секунд!");
  if (previousStatus !== s.status && s.status === "RESULT") toast("Стрелка остановилась — победитель определён!");
  previousStatus = s.status;
}

function avatarMarkup(avatar, name, className = "avatar-small") {
  if (avatar) {
    return `<img class="${className}" src="${escapeHtml(avatar)}" alt="" loading="lazy">`;
  }
  const letter = escapeHtml(String(name || "И").trim().charAt(0).toUpperCase() || "И");
  return `<div class="${className} avatar-fallback">${letter}</div>`;
}

function renderPlayers(players) {
  const root = $("#players");
  root.innerHTML = "";

  const fundedPlayers = players.filter(p => Number(p.bet || 0) > 0);
  $("#emptyPlayers").style.display = fundedPlayers.length ? "none" : "block";

  for (const p of fundedPlayers) {
    const el = document.createElement("div");
    el.className = "player";
    const status = p.status === "winner"
      ? `<div class="status-win">🏆 ПОБЕДИТЕЛЬ</div>`
      : p.status === "lost"
        ? `<div class="status-loss">ПРОИГРАЛ</div>`
        : `<div class="meta">Шанс: ${Number(p.percentage).toFixed(2)}%</div>`;

    el.innerHTML = `
      <div class="player-visual">
        ${avatarMarkup(p.avatar, p.name)}
        <span class="player-color" style="background:${p.color};box-shadow:0 0 12px ${p.color}"></span>
      </div>
      <div>
        <div class="pname">${escapeHtml(p.name)}</div>
        <div class="meta">Ставка: <b>${Number(p.bet || 0).toFixed(2)} ⭐</b></div>
      </div>
      <div style="text-align:right">${status}</div>
    `;
    root.appendChild(el);
  }
}
function renderWinnerCard(s) {
  const overlay = $("#winnerOverlay");
  if (s.status === "RESULT" && s.winner) {
    const w = s.winner;
    $("#winnerAvatar").innerHTML = w.avatar
      ? `<img src="${escapeHtml(w.avatar)}" alt="" loading="lazy">`
      : `<div class="winner-fallback">${escapeHtml(String(w.name || "И").trim().charAt(0).toUpperCase() || "И")}</div>`;
    $("#winnerName").textContent = w.name || "Игрок";
    $("#winnerPayout").textContent = `${Number(w.payout || 0).toFixed(2)} ⭐`;
    $("#winnerBetDetail").textContent = `Ставка: ${Number(w.bet || 0).toFixed(2)} ⭐`;
    openModal(overlay);
  } else {
    closeModal(overlay);
  }
}

function renderWheel(s) {
  const wheel = $("#wheel");
  const pointerOrbit = $("#pointerOrbit");
  const players = Array.isArray(s.players) ? s.players : [];
  const fundedPlayers = players.filter(p => Number(p.bet) > 0);

  if (!fundedPlayers.length || Number(s.bank) <= 0) {
    wheel.classList.add("empty");
    wheel.style.background = "#66686b";
    wheel.style.transform = "rotate(0deg)";
    wheel.style.transition = "transform .35s ease";
    if (pointerOrbit) {
      pointerOrbit.style.transition = "transform .35s ease";
      pointerOrbit.style.transform = "rotate(0deg)";
    }
    lastWinner = null;
    lastSpinTarget = null;
    return;
  }

  wheel.classList.remove("empty");

  const total = fundedPlayers.reduce((sum, p) => sum + Number(p.bet), 0);
  const segments = fundedPlayers.map(p => ({
    p,
    raw: Number(p.bet) / total * 100
  }));

  const stops = [];
  let cursor = 0;
  segments.forEach((segment, index) => {
    const start = cursor;
    const end = index === segments.length - 1 ? 100 : cursor + segment.raw;
    cursor = end;
    stops.push(`${segment.p.color} ${start}% ${end}%`);
  });

  // The wheel stays completely still. Only the pointer orbit rotates.
  wheel.style.background = `conic-gradient(${stops.join(",")})`;
  wheel.style.transform = "rotate(0deg)";

  if (s.status === "SPINNING" && s.spinTargetAngle != null) {
    const targetAngle = Number(s.spinTargetAngle);
    if (pointerOrbit && Number.isFinite(targetAngle) && lastSpinTarget !== targetAngle) {
      pointerOrbit.style.transition = "transform 6.2s cubic-bezier(.10,.72,.12,1)";
      pointerOrbit.style.transform = `rotate(${360 * 6 + targetAngle}deg)`;
      lastSpinTarget = targetAngle;
    }
  }

  if (s.status === "WAITING" || s.status === "COUNTDOWN") {
    lastWinner = null;
    lastSpinTarget = null;
    if (pointerOrbit) {
      pointerOrbit.style.transition = "transform .35s ease";
      pointerOrbit.style.transform = "rotate(0deg)";
    }
  }

  // RESULT intentionally leaves the pointer untouched, so it remains at the exact stop angle.
}

function setView(view) {
  const views = { pvp: $("#pvpView"), raffles: $("#rafflesView"), games: $("#gamesView"), profile: $("#profileView") };
  const activeKey = views[view] ? view : "pvp";

  Object.values(views).forEach(el => el.classList.add("hidden"));
  views[activeKey].classList.remove("hidden");

  if (activeKey === "profile") loadProfile();
  if (activeKey === "raffles") loadRaffles();

  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === activeKey);
  });
  const topupBtn = $("#topupBtn");
  if (topupBtn) topupBtn.style.display = activeKey === "games" ? "none" : "";
}

document.querySelectorAll(".nav-item").forEach(btn => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

async function loadProfile() {
  if (!initData) return handleNotTelegram();
  try {
    const r = await fetch("/api/profile", { headers: authHeaders() });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось загрузить профиль.");

    const u = data.user || {};
    const st = data.stats || {};
    const ref = data.referral || {};
    if (isAdmin) refreshAdmin();

    $("#profileName").textContent = u.first_name || "Игрок";
    $("#profileUsername").textContent = u.username ? "@" + u.username.replace(/^@/, "") : "Без username";
    $("#profileId").textContent = u.id || "—";
    $("#profileBalance").textContent = `${Number(u.balance || 0).toFixed(2)} ⭐`;

    const avatar = $("#profileAvatar");
    avatar.innerHTML = u.avatar_url
      ? `<img src="${escapeHtml(u.avatar_url)}" alt="" loading="lazy">`
      : `<div class="avatar-fallback profile-fallback">${escapeHtml(String(u.first_name || "И").charAt(0).toUpperCase())}</div>`;

    $("#gamesPlayed").textContent = st.gamesPlayed || 0;
    $("#gamesWon").textContent = st.gamesWon || 0;
    $("#winrate").textContent = `${Number(st.winrate || 0).toFixed(2)}%`;
    $("#totalWagered").textContent = `${Number(st.totalWagered || 0).toFixed(2)} ⭐`;

    $("#refPending").textContent = `${Number(ref.pending || 0).toFixed(2)} ⭐`;
    $("#refTotal").textContent = `${Number(ref.totalEarned || 0).toFixed(2)} ⭐`;
    $("#refInvited").textContent = ref.invited || 0;
    $("#referralLink").value = ref.link || "Укажи TELEGRAM_BOT_USERNAME на Render";

    const claim = $("#claimReferral");
    claim.disabled = Number(ref.pending || 0) <= 0;
  } catch (e) {
    toast(e.message);
  }
}

$("#copyReferral").onclick = async () => {
  const value = $("#referralLink").value;
  if (!value || value.startsWith("Укажи")) return toast("Сначала укажи TELEGRAM_BOT_USERNAME на Render.");
  try {
    await navigator.clipboard.writeText(value);
    toast("Реферальная ссылка скопирована.");
  } catch {
    $("#referralLink").select();
    document.execCommand("copy");
    toast("Ссылка скопирована.");
  }
};

$("#claimReferral").onclick = async () => {
  try {
    const r = await fetch("/api/profile/referrals/claim", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось забрать начисления.");
    setBalance(data.balance);
    toast(`Зачислено ${Number(data.amount).toFixed(2)} ⭐`);
    loadProfile();
  } catch (e) {
    toast(e.message);
  }
};

// ---------- RAFFLES ----------
let raffleType = "free";
let rafflesLoaded = false;
let currentRaffleId = raffleFromUrl || "";

function formatRaffleCountdown(endAt) {
  const ms = Math.max(0, Number(endAt || 0) - Date.now());
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м ${total % 60}с`;
}

function formatRaffleDate(endAt) {
  if (!endAt) return "—";
  const d = new Date(endAt);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

function setDefaultRaffleEnd() {
  const dt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset());
  $("#raffleEndsAt").value = dt.toISOString().slice(0,16);
}

function updateRaffleType(type) {
  raffleType = type;
  document.querySelectorAll(".raffle-type-option").forEach(btn => btn.classList.toggle("active", btn.dataset.type === type));
  $("#paidTicketField").classList.toggle("hidden", type !== "paid");
}

document.querySelectorAll(".raffle-type-option").forEach(btn => btn.addEventListener("click", () => updateRaffleType(btn.dataset.type)));
$("#rafflePrizePool").addEventListener("input", updateEachPreview);
$("#raffleWinners").addEventListener("input", updateEachPreview);
function updateEachPreview() {
  const pool = Number($("#rafflePrizePool").value);
  const winners = Number($("#raffleWinners").value);
  $("#raffleEachPreview").textContent = Number.isFinite(pool) && winners > 0 ? `Каждому: ≈ ${(pool / winners).toFixed(2)} ⭐` : "Каждому: — ⭐";
}

$("#openCreateRaffle").onclick = () => {
  if (!initData) return handleNotTelegram();
  updateRaffleType("free");
  $("#rafflePrizeTitle").value = "";
  $("#rafflePrizePool").value = "";
  $("#raffleWinners").value = "";
  $("#raffleTicketPrice").value = "";
  $("#raffleChannel").value = "";
  setDefaultRaffleEnd();
  updateEachPreview();
  openModal($("#raffleCreateModal"));
};
$("#raffleCreateClose").onclick = () => closeModal($("#raffleCreateModal"));
$("#raffleDetailClose").onclick = () => closeModal($("#raffleDetailModal"));

function openTopupWithAmount(amount) {
  $("#topupAmount").value = String(Math.max(1, Math.ceil(Number(amount || 1))));
  closeModal($("#raffleCreateModal"));
  closeModal($("#raffleDetailModal"));
  openModal(topupModal);
}

async function loadRaffles() {
  if (!initData) return handleNotTelegram();
  try {
    const r = await fetch("/api/raffles", { headers: authHeaders(), cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось загрузить розыгрыши.");
    renderRaffles(data.raffles || []);
    rafflesLoaded = true;
    if (currentRaffleId) {
      const still = (data.raffles || []).some(x => String(x.id) === String(currentRaffleId));
      if (still || raffleFromUrl) openRaffleDetail(currentRaffleId);
    }
  } catch(e) { toast(e.message); }
}

function renderRaffles(items) {
  const root = $("#raffleCards");
  root.innerHTML = "";
  const active = items.filter(x => x.status === "active");
  const finished = items.filter(x => x.status !== "active");
  const ordered = [...active, ...finished];
  $("#raffleEmpty").classList.toggle("hidden", ordered.length > 0);
  for (const r of ordered) {
    const el = document.createElement("button");
    el.className = `raffle-card ${r.status !== "active" ? "finished" : ""}`;
    el.innerHTML = `
      <div class="raffle-card-glow"></div>
      <div class="raffle-card-top"><span>Winners: ${Number(r.winnersCount)}</span><span class="raffle-status">${r.status === "active" ? "Active" : "Inactive"}</span></div>
      <div class="raffle-card-top" style="margin-top:6px"><span>Name: ${escapeHtml(r.prizeTitle || "Stars")}</span><span>${r.status === "active" ? formatRaffleCountdown(r.endsAt) : "Results: " + formatRaffleDate(r.endsAt)}</span></div>
      <div class="raffle-card-prize">Prize:</div>
      <div class="raffle-card-amount">${Number(r.prizePool).toFixed(2)} ⭐</div>
      <div class="raffle-card-bottom"><span>👥 ${Number(r.participants || 0)} участников · 🎟 ${Number(r.totalTickets || 0)} билетов</span><span class="raffle-arrow">›</span></div>
    `;
    el.onclick = () => openRaffleDetail(r.id);
    root.appendChild(el);
  }
}

async function openRaffleDetail(id) {
  currentRaffleId = String(id);
  try {
    const r = await fetch(`/api/raffles/${encodeURIComponent(id)}`, { headers: authHeaders({"X-Raffle-Ref": startParam}), cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось открыть розыгрыш.");
    renderRaffleDetail(data);
    openModal($("#raffleDetailModal"));
  } catch(e) { toast(e.message); }
}

function renderRaffleDetail(data) {
  const r = data.raffle;
  const mine = data.mine;
  const each = r.winnersCount ? r.prizePool / r.winnersCount : 0;
  const ended = r.status !== "active";
  const root = $("#raffleDetailRoot");
  root.innerHTML = `
    <div class="raffle-detail-banner ${ended ? 'finished' : ''}">
      <div class="raffle-detail-prize">${escapeHtml(r.prizeTitle || 'Stars')}</div>
      <div class="raffle-detail-badge" style="margin-top:8px">${ended ? 'Inactive' : 'Active'}</div>
      <div class="raffle-detail-fund" style="margin-top:14px">Results: ${formatRaffleDate(r.endsAt)}</div>
    </div>
    <div class="raffle-detail-grid">
      <div><span>Prize</span><b>${Number(r.prizePool).toFixed(2)} ⭐</b></div>
      <div><span>Winners</span><b>${r.winnersCount}</b></div>
      <div><span>Participants</span><b>${Number(r.participants || 0)}</b></div>
      <div><span>Билет</span><b>${r.type === 'paid' ? Number(r.ticketPrice).toFixed(2) + ' ⭐' : 'Бесплатно'}</b></div>
    </div>
    <div class="raffle-detail-each">Каждому победителю ≈ ${each.toFixed(2)} ⭐ · ${ended ? '—' : formatRaffleCountdown(r.endsAt)}</div>
    <div class="raffle-channel-row"><a href="${escapeHtml(data.channelUrl)}" target="_blank" rel="noreferrer">📣 ${escapeHtml(r.channelTitle || r.channelUsername)}</a></div>
    ${mine ? `<div class="raffle-your-ticket"><b>Твои билеты: ${mine.tickets}</b><span>Оплачено: ${Number(mine.paidAmount).toFixed(2)} ⭐</span></div>` : ''}
    <div class="raffle-detail-actions">
      ${ended ? '' : (!data.subscribed ? `<button class="confirm" id="raffleSubscribeBtn">📣 ПОДПИСАТЬСЯ НА КАНАЛ</button><button class="raffle-secondary-btn" id="raffleCheckSubscription">✅ Я ПОДПИСАЛСЯ — ПРОВЕРИТЬ</button>` : `<button class="confirm" id="raffleJoinBtn" ${mine ? 'disabled' : ''}>${mine ? 'ТЫ УЖЕ УЧАСТВУЕШЬ' : (r.type === 'paid' ? `Join · ${Number(r.ticketPrice).toFixed(2)} ⭐` : 'Join')}</button>`)}
      ${ended ? '' : (Number(data.boostCount || 0) > 0 || localStorage.getItem(`raffle_boost_pending_${r.id}`) === '1'
        ? `<button class="raffle-secondary-btn" id="checkRaffleBoost">ПРОВЕРИТЬ БУСТ${data.boostCount ? ` · ${data.boostCount}` : ''}</button>`
        : `<a class="raffle-secondary-btn" id="giveRaffleBoost" href="${escapeHtml(data.boostUrl)}" target="_blank" rel="noreferrer">🚀 Дать буст каналу</a>`)}
      ${data.referralLink ? `<div class="raffle-ref-box"><input id="raffleRefLink" readonly value="${escapeHtml(data.referralLink)}"><button id="copyRaffleRef">ПРИГЛАСИТЬ</button></div><div class="raffle-ref-hint">Пригласи друга по своей ссылке — получишь +1 билет.</div>` : ''}
    </div>
    <div class="raffle-winners-list">${(data.winners || []).length ? '<div class="raffle-section-title">ПОБЕДИТЕЛИ</div>' + data.winners.map(w => `<div class="raffle-winner-row"><span>#${w.place} ${escapeHtml(w.name)}</span><b>${Number(w.payout).toFixed(2)} ⭐</b></div>`).join('') : ''}</div>
  `;
  const subscribe = $("#raffleSubscribeBtn");
  if (subscribe) subscribe.onclick = () => {
    if (tg?.openTelegramLink) tg.openTelegramLink(data.channelUrl);
    else window.open(data.channelUrl, '_blank', 'noopener,noreferrer');
  };
  const checkSubscription = $("#raffleCheckSubscription");
  if (checkSubscription) checkSubscription.onclick = () => checkRaffleSubscription(r.id);
  const join = $("#raffleJoinBtn");
  if (join && !mine) join.onclick = () => joinRaffle(r.id);
  const boost = $("#checkRaffleBoost");
  if (boost) boost.onclick = () => checkBoost(r.id);
  const giveBoost = $("#giveRaffleBoost");
  if (giveBoost) giveBoost.onclick = () => { localStorage.setItem(`raffle_boost_pending_${r.id}`, '1'); };
  const copy = $("#copyRaffleRef");
  if (copy) copy.onclick = async () => {
    const input = $("#raffleRefLink");
    try { await navigator.clipboard.writeText(input.value); toast("Личная ссылка скопирована."); } catch { input.select(); document.execCommand('copy'); toast("Ссылка скопирована."); }
  };
}

async function checkRaffleSubscription(id) {
  const btn = $("#raffleCheckSubscription");
  if (btn) { btn.disabled = true; btn.textContent = 'ПРОВЕРЯЕМ…'; }
  try {
    const r = await fetch(`/api/raffles/${encodeURIComponent(id)}/subscription`, { headers: authHeaders(), cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Не удалось проверить подписку.');
    if (!data.subscribed) {
      toast('Подпишись на канал и нажми проверку ещё раз.');
      if (btn) { btn.disabled = false; btn.textContent = '✅ Я ПОДПИСАЛСЯ — ПРОВЕРИТЬ'; }
      return;
    }
    toast('Подписка подтверждена!');
    await openRaffleDetail(id);
  } catch (e) {
    toast(e.message);
    if (btn) { btn.disabled = false; btn.textContent = '✅ Я ПОДПИСАЛСЯ — ПРОВЕРИТЬ'; }
  }
}

async function joinRaffle(id) {
  try {
    const r = await fetch(`/api/raffles/${encodeURIComponent(id)}/join`, { method:'POST', headers:authHeaders({'Content-Type':'application/json'}), body:JSON.stringify({startParam}) });
    const data = await r.json().catch(() => ({}));
    if (data.code === 'RAFFLE_SUBSCRIPTION_REQUIRED') {
      toast('Сначала подпишись на канал розыгрыша.');
      await openRaffleDetail(id);
      return;
    }
    if (r.status === 402 || data.code === 'INSUFFICIENT_FUNDS') {
      toast(`Не хватает ${Number(data.missing || 0).toFixed(2)} ⭐`);
      openTopupWithAmount(data.missing || 1);
      return;
    }
    if (!r.ok) throw new Error(data.error || 'Не удалось принять участие.');
    setBalance(data.balance);
    toast('Ты участвуешь в розыгрыше!');
    renderRaffleDetail(data.detail);
  } catch(e) { toast(e.message); }
}

async function checkBoost(id) {
  const btn = $("#checkRaffleBoost");
  if (btn) { btn.disabled = true; btn.textContent = 'ПРОВЕРЯЕМ…'; }
  try {
    const r = await fetch(`/api/raffles/${encodeURIComponent(id)}/check-boost`, {method:'POST',headers:authHeaders({'Content-Type':'application/json'})});
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Не удалось проверить буст.');
    toast(data.newTickets > 0 ? `Начислено +${data.newTickets} билет${data.newTickets === 1 ? '' : 'а'}!` : `Бустов найдено: ${data.boosts}. Новых билетов нет.`);
    renderRaffleDetail(data.detail);
  } catch(e) { toast(e.message); if (btn) btn.disabled = false; }
}

$("#createRaffleBtn").onclick = async () => {
  const prizePool = Number($("#rafflePrizePool").value);
  const winnersCount = Number($("#raffleWinners").value);
  const ticketPrice = Number($("#raffleTicketPrice").value);
  const prizeTitle = $("#rafflePrizeTitle").value.trim() || 'Stars';
  const channel = $("#raffleChannel").value.trim();
  const endsAtValue = $("#raffleEndsAt").value;
  const endsAt = endsAtValue ? new Date(endsAtValue).toISOString() : '';
  if (!Number.isFinite(prizePool) || prizePool <= 0) return toast('Укажи сумму приза.');
  if (!Number.isInteger(winnersCount) || winnersCount <= 0) return toast('Укажи количество победителей.');
  if (raffleType === 'paid' && (!Number.isFinite(ticketPrice) || ticketPrice <= 0)) return toast('Укажи цену билета.');
  if (!channel) return toast('Укажи канал.');
  if (!endsAtValue) return toast('Укажи время окончания.');
  const btn = $("#createRaffleBtn");
  btn.disabled = true; btn.textContent = 'СОЗДАЁМ…';
  try {
    const r = await fetch('/api/raffles', {method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({type:raffleType,ticketPrice: raffleType==='paid'?ticketPrice:0,prizePool,winnersCount,prizeTitle,channel,endsAt})});
    const data = await r.json().catch(() => ({}));
    if (r.status === 402 || data.code === 'INSUFFICIENT_FUNDS') {
      toast(`Не хватает ${Number(data.missing || 0).toFixed(2)} ⭐ для создания.`);
      openTopupWithAmount(data.missing || 1);
      return;
    }
    if (!r.ok) throw new Error(data.error || 'Не удалось создать розыгрыш.');
    setBalance(data.balance);
    closeModal($("#raffleCreateModal"));
    toast('Розыгрыш создан и опубликован в канале.');
    setView('raffles');
    await loadRaffles();
    await openRaffleDetail(data.raffle.id);
  } catch(e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = 'СОЗДАТЬ РОЗЫГРЫШ'; }
};

setInterval(() => {
  const cards = document.querySelectorAll('.raffle-card');
  if (!cards.length) return;
  // Refresh only the labels without hitting the API every second.
  document.querySelectorAll('.raffle-card').forEach((card, idx) => {
    const items = window.__rafflesCache || [];
    const r = items[idx];
    const meta = card.querySelector('.raffle-card-meta span:last-child');
    if (r && meta && r.status === 'active') meta.textContent = formatRaffleCountdown(r.endsAt);
  });
}, 1000);

const _renderRaffles = renderRaffles;
renderRaffles = function(items) { window.__rafflesCache = items; _renderRaffles(items); };

// ---------- ADMIN ----------
async function adminFetch(url, options = {}) {
  const r = await fetch(url, { ...options, headers: authHeaders(options.headers || {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Ошибка админ-панели");
  return data;
}

let adminRefreshTimer = null;
let adminRefreshInFlight = false;
function scheduleAdminRefresh(delay = 50) {
  if (!isAdmin) return;
  clearTimeout(adminRefreshTimer);
  adminRefreshTimer = setTimeout(() => refreshAdmin(), delay);
}

async function refreshAdmin() {
  if (adminRefreshInFlight) return;
  adminRefreshInFlight = true;
  if (!isAdmin) return;
  try {
    const [stats, users, promos] = await Promise.all([
      adminFetch("/api/admin/stats"),
      adminFetch("/api/admin/users?q=" + encodeURIComponent($("#adminSearch").value.trim())),
      adminFetch("/api/admin/promos")
    ]);
    renderAdminStats(stats);
    renderAdminPromos(promos.promos || []);
    renderAdminUsers(users.users || []);
  } catch (e) {
    toast(e.message);
  } finally {
    adminRefreshInFlight = false;
  }
}

const ADMIN_SUMMARY_TABS = { topups: "adminSummaryTopups", bets: "adminSummaryBets", withdrawals: "adminSummaryWithdrawals", referrals: "adminSummaryReferrals" };
const adminSummaryLoaded = new Set();

function renderAdminSummary(elId, data) {
  const unit = "⭐";
  const methods = (data.byMethod || []).map(m => `
    <div class="admin-summary-method">
      <div><b>${escapeHtml(m.method)}</b><span>${m.count} шт.</span></div>
      <div class="admin-summary-amount">${Number(m.amount).toFixed(2)} ${unit}</div>
    </div>`).join("") || `<div class="empty-players">Пока пусто</div>`;
  const recent = (data.recent || []).map(r => `
    <div class="admin-summary-row">
      <div><b>${escapeHtml(r.name || "Игрок")}${r.username ? " · @" + escapeHtml(r.username) : ""}</b><span>${escapeHtml(r.method)}${r.status ? " · " + escapeHtml(r.status) : ""} · ${formatHistoryDateTime(r.createdAt)}</span></div>
      <div class="admin-summary-amount">${Number(r.amount).toFixed(2)} ${unit}</div>
    </div>`).join("") || `<div class="empty-players">Пока пусто</div>`;
  $(elId).innerHTML = `
    <div class="admin-summary-total">За всё время: <b>${Number(data.totalAmount).toFixed(2)} ${unit}</b> · ${Number(data.count)} шт.</div>
    <div class="admin-summary-title">По способу</div>
    <div class="admin-summary-methods">${methods}</div>
    <div class="admin-summary-title">Последние</div>
    <div class="admin-summary-recent">${recent}</div>
  `;
}

async function loadAdminSummary(category, force = false) {
  if (!force && adminSummaryLoaded.has(category)) return;
  try {
    const data = await adminFetch(`/api/admin/summary/${encodeURIComponent(category)}`);
    renderAdminSummary("#" + ADMIN_SUMMARY_TABS[category], data);
    adminSummaryLoaded.add(category);
  } catch (e) {
    toast(e.message);
  }
}

document.querySelectorAll(".admin-tab").forEach(btn => {
  btn.onclick = () => {
    const tab = btn.dataset.adminTab;
    document.querySelectorAll(".admin-tab").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".admin-tab-panel").forEach(p => p.classList.add("hidden"));
    const panelId = tab === "users" ? "adminTabUsers" : tab === "promos" ? "adminTabPromos" : "adminTab" + tab[0].toUpperCase() + tab.slice(1);
    $("#" + panelId).classList.remove("hidden");
    if (ADMIN_SUMMARY_TABS[tab]) loadAdminSummary(tab);
  };
});

function renderAdminStats(s) {
  $("#adminStats").innerHTML = `
    <div class="admin-stat"><b>${s.users}</b><span>Пользователи</span></div>
    <div class="admin-stat"><b>${s.banned}</b><span>В бане</span></div>
    <div class="admin-stat"><b>${Number(s.total_balance).toFixed(2)} ⭐</b><span>Баланс</span></div>
  `;
}

function renderAdminPromos(promos) {
  const root = $("#adminPromos");
  root.innerHTML = "";
  if (!promos.length) {
    root.innerHTML = `<div class="empty-players promo-empty">Промокодов пока нет</div>`;
    return;
  }
  for (const p of promos) {
    const el = document.createElement("div");
    el.className = "admin-promo";
    const active = !!p.active;
    el.innerHTML = `
      <div>
        <div class="admin-promo-code">${escapeHtml(p.code)}</div>
        <div class="admin-promo-meta">+${Number(p.bonus).toFixed(0)} ⭐ · ${Number(p.uses_count)}/${Number(p.max_uses)} активаций${Number(p.wager) > 0 ? ` · вагер x${Number(p.wager)}` : ""}</div>
      </div>
      <button class="promo-toggle ${active ? "active" : ""}">${active ? "ВКЛ" : "ВЫКЛ"}</button>
    `;
    el.querySelector(".promo-toggle").onclick = async () => {
      try {
        await adminFetch(`/api/admin/promos/${encodeURIComponent(p.id)}/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: !active })
        });
        toast(active ? "Промокод отключён." : "Промокод включён.");
        refreshAdmin();
      } catch (e) { toast(e.message); }
    };
    root.appendChild(el);
  }
}

function renderAdminUsers(users) {
  const root = $("#adminUsers");
  root.innerHTML = "";
  if (!users.length) {
    root.innerHTML = `<div class="empty-players">Пользователи не найдены</div>`;
    return;
  }

  for (const u of users) {
    const el = document.createElement("div");
    el.className = "admin-user";
    const title = escapeHtml(u.username ? "@" + u.username : u.first_name);
    el.innerHTML = `
      <div class="admin-user-head">
        <div>
          <div class="admin-user-name">${title}</div>
          <div class="admin-user-id">ID: ${escapeHtml(u.telegram_id)}</div>
        </div>
        <div>${u.banned ? "🔴 БАН" : "🟢 ОК"}</div>
      </div>
      <div class="admin-balance">${Number(u.balance).toFixed(2)} ⭐</div>
      <div class="admin-actions">
        <input class="admin-amount" type="number" step="1" min="1" placeholder="Stars">
        <button class="add-btn">ВЫДАТЬ</button>
        <button class="remove-btn">ЗАБРАТЬ</button>
        <button class="ban-btn ${u.banned ? "unban" : ""}">${u.banned ? "РАЗБАНИТЬ" : "ЗАБАНИТЬ"}</button>
      </div>
    `;

    const amountInput = el.querySelector(".admin-amount");
    el.querySelector(".add-btn").onclick = async () => {
      const amount = Number(amountInput.value);
      if (!Number.isInteger(amount) || amount <= 0) return toast("Введите целое количество Stars.");
      await adminAdjust(u.telegram_id, amount);
    };
    el.querySelector(".remove-btn").onclick = async () => {
      const amount = Number(amountInput.value);
      if (!Number.isInteger(amount) || amount <= 0) return toast("Введите целое количество Stars.");
      await adminAdjust(u.telegram_id, -amount);
    };
    el.querySelector(".ban-btn").onclick = async () => {
      try {
        await adminFetch(`/api/admin/users/${encodeURIComponent(u.telegram_id)}/ban`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ banned: !u.banned })
        });
        toast(u.banned ? "Пользователь разбанен." : "Пользователь заблокирован.");
        refreshAdmin();
      } catch (e) { toast(e.message); }
    };
    root.appendChild(el);
  }
}

async function adminAdjust(id, delta) {
  try {
    await adminFetch(`/api/admin/users/${encodeURIComponent(id)}/adjust-balance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta, description: delta > 0 ? "Выдача Stars администратором" : "Списание Stars администратором" })
    });
    toast(delta > 0 ? "Stars выданы." : "Stars списаны.");
    refreshAdmin();
  } catch (e) { toast(e.message); }
}

$("#adminRefresh").onclick = refreshAdmin;
let searchTimer;
$("#adminSearch").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refreshAdmin, 250);
});

async function activatePromo() {
  const input = $("#promoCode");
  const code = input.value.trim();
  if (!code) return toast("Введите промокод.");
  try {
    const r = await fetch("/api/profile/promo/redeem", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ code })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Не удалось активировать промокод.");
    setBalance(data.balance);
    input.value = "";
    toast(data.wager > 0
      ? `Промокод активирован: +${Number(data.bonus).toFixed(0)} ⭐. Нужно поставить ${(Number(data.bonus) * Number(data.wager)).toFixed(0)} ⭐ перед выводом.`
      : `Промокод активирован: +${Number(data.bonus).toFixed(0)} ⭐`);
    loadProfile();
  } catch (e) { toast(e.message); }
}

$("#activatePromo").onclick = activatePromo;
$("#promoCode").addEventListener("keydown", e => {
  if (e.key === "Enter") activatePromo();
});

$("#createPromo").onclick = async () => {
  const code = $("#adminPromoCode").value.trim();
  const bonus = Number($("#adminPromoBonus").value);
  const maxUses = Number($("#adminPromoUses").value);
  const wagerInput = $("#adminPromoWager");
  const wager = wagerInput && wagerInput.value.trim() !== "" ? Number(wagerInput.value) : 0;
  if (!code) return toast("Введите код промокода.");
  if (!Number.isInteger(bonus) || bonus <= 0) return toast("Введите целый бонус.");
  if (!Number.isInteger(maxUses) || maxUses <= 0) return toast("Введите лимит активаций.");
  if (!Number.isFinite(wager) || wager < 0) return toast("Вагер должен быть числом от 0 и выше.");
  try {
    await adminFetch("/api/admin/promos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, bonus, maxUses, wager })
    });
    $("#adminPromoCode").value = "";
    $("#adminPromoBonus").value = "";
    $("#adminPromoUses").value = "";
    if (wagerInput) wagerInput.value = "";
    toast("Промокод создан.");
    refreshAdmin();
  } catch (e) { toast(e.message); }
};

// ---------- UPGRADE (solo game) ----------
let upgradeSpinning = false;
let upgradeAccumDeg = 0;

function upgradeChance() {
  const bet = Number($("#upgradeBet").value);
  const target = Number($("#upgradeTarget").value);
  const valid = Number.isFinite(bet) && Number.isFinite(target) && bet > 0 && target > bet;
  return { bet, target, valid, chance: valid ? (bet / target) * 100 : 0 };
}

function renderUpgradeWheel() {
  const { valid, chance } = upgradeChance();
  const pct = valid ? chance : 0;
  $("#upgradeWheel").style.background = `conic-gradient(from 0deg at 50% 50%, #ffc915 0%, #ffc915 ${pct}%, #141517 ${pct}%, #141517 100%)`;
  $("#upgradeChanceValue").textContent = pct.toFixed(2) + "%";
  // The colored arc just changed shape (new bet/target), so a pointer left
  // over from a previous spin no longer points at anything meaningful for
  // THIS arc — hide it until the next spin actually resolves. Otherwise the
  // old arrow can visually sit on the "wrong" color for the newly-typed
  // numbers, even though that old spin's result was computed correctly.
  if (!upgradeSpinning) {
    $("#upgradePointerOrbit").style.opacity = "0";
  }
}

$("#upgradeBet").addEventListener("input", renderUpgradeWheel);
$("#upgradeTarget").addEventListener("input", renderUpgradeWheel);

function openUpgrade() {
  if (!initData) return handleNotTelegram();
  $("#gamesList").classList.add("hidden");
  $("#upgradeGame").classList.remove("hidden");
  renderUpgradeWheel();
}

function closeUpgrade() {
  if (upgradeSpinning) return toast("Дождитесь окончания прокрутки.");
  $("#upgradeGame").classList.add("hidden");
  $("#gamesList").classList.remove("hidden");
}

$("#openUpgrade").onclick = openUpgrade;
$("#upgradeBack").onclick = closeUpgrade;

function setUpgradeControlsDisabled(disabled) {
  $("#upgradeSpinBtn").disabled = disabled;
  $("#upgradeBet").disabled = disabled;
  $("#upgradeTarget").disabled = disabled;
}

function upgradeSecureRandom() {
  if (window.crypto?.getRandomValues) {
    const buf = new Uint32Array(1);
    window.crypto.getRandomValues(buf);
    return buf[0] / 4294967296;
  }
  return Math.random();
}

function spinUpgradePointer(data) {
  const pointerOrbit = $("#upgradePointerOrbit");
  const current = upgradeAccumDeg % 360;
  const chance = Math.max(0, Math.min(100, Number(data?.chance) || 0));

  // Redraw the wheel using the SERVER's own chance value right before we
  // animate, so the yellow/gray boundary the player sees can never drift out
  // of sync with the boundary the server used to judge the roll (e.g. if the
  // bet/target inputs changed between placing the bet and the result coming
  // back, a wheel drawn from stale local input values would no longer match
  // what the server actually rolled against).
  $("#upgradeWheel").style.background = `conic-gradient(from 0deg at 50% 50%, #ffc915 0%, #ffc915 ${chance}%, #141517 ${chance}%, #141517 100%)`;

  // The result IS where the pointer lands — not the other way around. The
  // server rolls one real random number (0–100) and derives both the win
  // flag and this exact landing percentage from it, so the pointer must be
  // taken to this precise position, not nudged to the "safe" middle of
  // whichever zone the server says is correct. If it stops on yellow, that's
  // a win because it's on yellow; if it stops on gray, that's a loss because
  // it's on gray — the color under the pointer is the single source of truth.
  let landingPercent = Number(data?.rollPercent);
  if (!Number.isFinite(landingPercent)) landingPercent = data?.win ? chance / 2 : chance + (100 - chance) / 2;
  landingPercent = Math.max(0, Math.min(99.999999, landingPercent));

  const targetAngle = landingPercent * 3.6;
  pointerOrbit.style.opacity = "1";
  pointerOrbit.style.transition = "none";
  pointerOrbit.style.transform = `rotate(${current}deg)`;
  void pointerOrbit.offsetWidth;

  const next = current + 360 * 6 + targetAngle;
  pointerOrbit.style.transition = "transform 6.2s cubic-bezier(.10,.72,.12,1)";
  pointerOrbit.style.transform = `rotate(${next}deg)`;
  upgradeAccumDeg = next;
}

$("#upgradeSpinBtn").onclick = () => {
  if (!initData) return handleNotTelegram();
  if (upgradeSpinning) return;

  const { bet, target } = upgradeChance();
  if (!Number.isInteger(bet) || bet <= 0) return toast("Введите целую ставку в Stars.");
  if (!Number.isInteger(target) || target <= bet) return toast("Цель должна быть целым числом и больше ставки.");
  if (bet > currentBalance) return toast("Недостаточно Stars на балансе.");

  upgradeSpinning = true;
  setUpgradeControlsDisabled(true);
  socket.emit("upgrade_spin", { bet, target });
};

function showUpgradeBanner(data) {
  const isWin = data?.win === true;
  const card = $("#upgradeBannerCard");
  card.classList.toggle("win", isWin);
  card.classList.toggle("lose", !isWin);
  $("#upgradeBannerIcon").textContent = isWin ? "👑" : "💥";
  $("#upgradeBannerTitle").textContent = isWin ? "УДАЧНЫЙ АПГРЕЙД!" : "АПГРЕЙД НЕ УДАЛСЯ";
  $("#upgradeBannerAmount").textContent = (isWin ? "+" : "-") + Number(isWin ? data.payout : data.bet).toFixed(2) + " ⭐";
  $("#upgradeBannerDetail").textContent = `Ставка ${Number(data.bet).toFixed(2)} ⭐ → Цель ${Number(data.target).toFixed(2)} ⭐ · Шанс ${Number(data.chance).toFixed(2)}%`;
  openModal($("#upgradeBanner"));
}
$("#upgradeBannerClose").onclick = () => {
  closeModal($("#upgradeBanner"));
  // Once the result is acknowledged, the arrow has done its job — hide it
  // so nothing is left resting in the background for the next round.
  $("#upgradePointerOrbit").style.opacity = "0";
};

$("#upgradeBannerX").onclick = () => $("#upgradeBannerClose").click();

socket.on("upgrade_result", data => {
  spinUpgradePointer(data);
  setTimeout(() => {
    upgradeSpinning = false;
    setUpgradeControlsDisabled(false);
    showUpgradeBanner(data);
  }, 6350);
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
  }[ch]));
}

setInterval(() => {
  if (currentState?.status === "COUNTDOWN") $("#timer").textContent = formatTimer(currentState.countdownEndsAt);
}, 250);

// If the page is opened outside Telegram, the server will reject the session.
if (!initData) setTimeout(handleNotTelegram, 500);

// ---------- Design pass: profile shortcut + top-up/withdraw tab switching ----------
const profileTopupBtn = $("#profileTopupBtn");
if (profileTopupBtn) profileTopupBtn.onclick = () => $("#topupBtn").click();

function switchToTopup() { closeModal(withdrawModal); $("#topupBtn").click(); }
function switchToWithdraw() { closeModal(topupModal); $("#withdrawBtn").click(); }
["tabGoWithdraw1", "tabGoWithdraw2"].forEach(id => { const b = $("#" + id); if (b) b.onclick = switchToWithdraw; });
["tabGoTopup", "tabGoTopup2"].forEach(id => { const b = $("#" + id); if (b) b.onclick = switchToTopup; });

// PVP card inside the Games grid jumps back to the PVP wheel view.
document.querySelectorAll('.game-card[data-view]').forEach(btn => {
  btn.onclick = () => setView(btn.dataset.view);
});

setTopupCurrency("STAR");
setWithdrawCurrency("STAR");
window.addEventListener("load", () => initTonConnect());

// ---------- PVP round history ----------
const historyModal = $("#historyModal");
const historyDetailModal = $("#historyDetailModal");
let historySearchTimer = null;

function formatHistoryDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const date = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${date} • ${time}`;
}

function shortenMiddle(value, head = 6, tail = 6) {
  const s = String(value || "");
  return s.length > head + tail + 3 ? `${s.slice(0, head)}...${s.slice(-tail)}` : s;
}

async function loadHistory(q = "") {
  const list = $("#historyList");
  const empty = $("#historyEmpty");
  try {
    const r = await fetch(`/api/pvp/history?q=${encodeURIComponent(q)}`, { cache: "no-store" });
    const data = await r.json();
    const rounds = Array.isArray(data.rounds) ? data.rounds : [];
    empty.classList.toggle("hidden", rounds.length > 0);
    list.innerHTML = rounds.map(round => {
      const w = round.winner;
      return `
        <button class="history-round" data-round="${round.roundNumber}">
          <div class="history-round-top">
            <span class="history-round-tag">
              <svg viewBox="0 0 23 23" fill="currentColor"><path d="M0.463147 0.087302C0.22178 0.205418 0.0317684 0.472461 0.00609109 0.73437C-0.0144507 0.924382 0.124207 1.30954 1.17184 3.9543C1.82918 5.60278 2.39921 7.00476 2.43516 7.06125C2.47111 7.11774 3.64713 8.18078 5.04397 9.42356C6.44082 10.6663 7.58089 11.6986 7.57575 11.7191C7.57062 11.7397 7.32412 12.0221 7.0314 12.3508L6.50244 12.9465L6.15837 12.6127C5.93241 12.397 5.7424 12.2635 5.60374 12.2224C5.07479 12.0632 4.56124 12.4432 4.56124 12.9927C4.56124 13.27 4.64854 13.4189 5.0183 13.7887C5.1929 13.9582 5.33156 14.1174 5.33156 14.143C5.33156 14.1739 4.22744 15.3088 2.87168 16.6646C0.155019 19.3915 0.16529 19.3761 0.0317684 20.1669C-0.235275 21.7743 1.22319 23.2328 2.83059 22.9658C3.62145 22.8322 3.60605 22.8425 6.33297 20.1259C7.68873 18.7701 8.82367 17.666 8.85448 17.666C8.88016 17.666 9.03936 17.8046 9.20883 17.9792C9.60939 18.3798 9.74805 18.4517 10.0819 18.426C10.4003 18.4003 10.5851 18.2771 10.7238 17.9946C10.9189 17.5992 10.8265 17.2859 10.3592 16.8135L10.051 16.5002L10.7443 15.8788C11.1244 15.5348 11.4633 15.2523 11.4941 15.2523C11.5249 15.2523 11.8639 15.5348 12.2439 15.8788L12.9372 16.5002L12.629 16.8135C12.1617 17.2859 12.0693 17.5992 12.2644 17.9946C12.4031 18.2771 12.588 18.4003 12.9064 18.426C13.2402 18.4517 13.3788 18.3798 13.7794 17.9792C13.9489 17.8046 14.1081 17.666 14.1337 17.666C14.1645 17.666 15.2995 18.7701 16.6552 20.1259C19.3822 22.8425 19.3668 22.8322 20.1576 22.9658C21.7753 23.2379 23.2389 21.7589 22.9513 20.1413C22.8127 19.3555 22.8332 19.3812 20.1165 16.6646C18.7659 15.3088 17.6567 14.1739 17.6567 14.143C17.6567 14.1174 17.7953 13.9582 17.9699 13.7887C18.3705 13.3881 18.4424 13.2495 18.4167 12.9157C18.391 12.5973 18.2678 12.4124 17.9853 12.2737C17.5745 12.0683 17.3023 12.1556 16.8042 12.6435L16.4909 12.9465L16.0903 12.4946C15.8695 12.2481 15.6179 11.9707 15.5357 11.8834L15.3868 11.7191L17.8723 9.50573C19.2384 8.28349 20.4144 7.21532 20.4863 7.12288C20.6558 6.91746 22.9975 1.03736 22.9975 0.816537C22.9975 0.605983 22.8229 0.287585 22.6329 0.154063C22.2734 -0.10271 22.3196 -0.118116 19.0432 1.18115C17.3896 1.83849 15.9774 2.42393 15.9003 2.48556C15.8233 2.54205 14.8116 3.65644 13.651 4.95572C12.4904 6.25499 11.5198 7.31803 11.4941 7.31803C11.4684 7.31803 10.5132 6.26526 9.36289 4.98139C8.21769 3.69753 7.206 2.58313 7.11356 2.5061C6.90301 2.3315 1.02805 -7.3352e-07 0.796951 -7.3352e-07C0.704513 -7.3352e-07 0.555585 0.0410829 0.463147 0.087302Z"/></svg>
              Ролл
            </span>
            <span>#${round.roundNumber} • ${formatHistoryDateTime(round.createdAt)}</span>
          </div>
          <div class="history-round-body">
            <div class="history-round-winner">
              ${avatarMarkup(w?.avatar, w?.name)}
              <div class="history-round-winner-info">
                <div class="history-round-name">${escapeHtml(w?.name || "Игрок")}</div>
                <div class="history-round-pct">${Number(w?.percentage || 0).toFixed(2)}%</div>
              </div>
            </div>
            <div class="history-round-right">
              <div class="history-round-amount">+${Number(round.payout).toFixed(2)} ⭐</div>
              <div class="history-round-mult">${round.multiplier}x</div>
            </div>
          </div>
        </button>`;
    }).join("");
    list.querySelectorAll(".history-round").forEach(btn => {
      btn.onclick = () => openHistoryDetail(btn.dataset.round);
    });
  } catch {
    empty.classList.remove("hidden");
    list.innerHTML = "";
  }
}

async function openHistoryDetail(roundNumber) {
  try {
    const r = await fetch(`/api/pvp/history/${encodeURIComponent(roundNumber)}`, { cache: "no-store" });
    if (!r.ok) throw new Error();
    const data = await r.json();
    $("#historyDetailTitle").textContent = `Ролл #${data.roundNumber}`;
    $("#historyDetailDate").textContent = formatHistoryDateTime(data.createdAt);
    $("#historyHashValue").textContent = shortenMiddle(data.hash);
    $("#historyHashRow").dataset.copy = data.hash || "";
    $("#historySeedValue").textContent = shortenMiddle(data.seed);
    $("#historySeedRow").dataset.copy = data.seed || "";
    $("#historyDetailPlayers").innerHTML = (data.players || []).map(p => `
      <div class="history-player-row">
        ${avatarMarkup(p.avatar, p.name)}
        <div>
          <div class="history-player-name">${escapeHtml(p.name || "Игрок")}</div>
          <div class="history-player-pct">${Number(p.percentage || 0).toFixed(2)}%</div>
        </div>
        <div class="history-player-bet">${Number(p.bet).toFixed(2)} ⭐</div>
      </div>`).join("");
    openModal(historyDetailModal);
  } catch {
    toast("Не удалось загрузить игру.");
  }
}

const openHistoryBtn = $("#openHistoryBtn");
if (openHistoryBtn) openHistoryBtn.onclick = () => { openModal(historyModal); loadHistory($("#historySearch").value.trim()); };
const historyCloseBtn = $("#historyClose");
if (historyCloseBtn) historyCloseBtn.onclick = () => closeModal(historyModal);
const historyDetailCloseBtn = $("#historyDetailClose");
if (historyDetailCloseBtn) historyDetailCloseBtn.onclick = () => closeModal(historyDetailModal);

const historySearchInput = $("#historySearch");
if (historySearchInput) {
  historySearchInput.addEventListener("input", () => {
    clearTimeout(historySearchTimer);
    historySearchTimer = setTimeout(() => loadHistory(historySearchInput.value.trim()), 250);
  });
}

[$("#historyHashRow"), $("#historySeedRow")].forEach(btn => {
  if (!btn) return;
  btn.onclick = () => {
    const value = btn.dataset.copy;
    if (!value || !navigator.clipboard) return;
    navigator.clipboard.writeText(value).then(() => toast("Скопировано"));
  };
});

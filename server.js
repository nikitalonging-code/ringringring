const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const { beginCell } = require("@ton/core");

const PORT = Number(process.env.PORT || 10000);
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: false }));
app.get("/tonconnect-manifest.json", (req, res) => {
  const base = String(process.env.APP_PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  res.json({
    url: base,
    name: "RING",
    iconUrl: `${base}/assets/group-6-nav.svg`
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/tonconnect/config", async (req, res) => {
  try {
    await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const base = String(process.env.APP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    const rawTonConnect = String(process.env.TON_CONNECT || "").trim();
    const manifestUrl = String(
      process.env.TON_CONNECT_MANIFEST_URL ||
      process.env.TON_CONNECT_MANIFEST ||
      process.env.TON_CONNECT_URL ||
      (rawTonConnect.startsWith("http://") || rawTonConnect.startsWith("https://") ? rawTonConnect : "") ||
      `${base}/tonconnect-manifest.json`
    ).trim();
    if (!manifestUrl) return res.status(503).json({ error: "Укажите TON_CONNECT_MANIFEST_URL на Render." });
    res.json({ manifestUrl });
  } catch (e) {
    res.status(401).json({ error: e.message || "Авторизация не выполнена." });
  }
});


const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 15,
      min: 1,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    })
  : null;

// Short-lived caches remove duplicate PostgreSQL round trips when the Mini App opens.
const USER_CACHE_TTL = 15000;
const userCache = new Map();
const adminAuthCache = new Map();

function getCachedUser(userId) {
  const key = String(userId);
  const hit = userCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > USER_CACHE_TTL) {
    userCache.delete(key);
    return null;
  }
  return hit.user;
}

function cacheUser(user) {
  if (user?.telegram_id) userCache.set(String(user.telegram_id), { user, at: Date.now() });
  return user;
}

function invalidateUserCache(userId) {
  userCache.delete(String(userId));
}

const COLORS = [
  "#19e58f", "#ff19b9", "#ffd11a", "#32a8ff", "#a95cff",
  "#ff7a18", "#00d9ff", "#ff4d6d", "#8dff3f", "#b7a2ff",
  "#ff5ce1", "#35e0d0", "#ffb347", "#5b7cfa", "#e6ff4f",
  "#7dffce", "#f15cff", "#ffde59", "#6ca7ff", "#ff8d6b"
];

const state = {
  roomId: crypto.randomUUID(),
  status: "WAITING",
  countdownEndsAt: null,
  players: new Map(),
  winnerId: null,
  commission: 0,
  payout: 0,
  spinTargetAngle: 0
};

let timerHandle = null;

function safeName(name) {
  const s = String(name || "").trim();
  return s ? s.slice(0, 32) : "Игрок";
}

function getAdminIds() {
  return String(process.env.ADMIN_TELEGRAM_IDS || "")
    .split(/[\s,;]+/)
    .map(v => v.trim())
    .filter(Boolean);
}

function isAdmin(userId) {
  return getAdminIds().includes(String(userId));
}

function requireDatabase() {
  if (!pool) throw new Error("DATABASE_URL не настроен на Render.");
}

function availableColor() {
  const used = new Set([...state.players.values()].map(p => p.color));
  return COLORS.find(c => !used.has(c)) || null;
}

function totalBank() {
  return Number([...state.players.values()]
    .reduce((sum, p) => sum + Number(p.bet || 0), 0)
    .toFixed(2));
}

function publicState() {
  const bank = totalBank();
  const rawPlayers = [...state.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    color: p.color,
    bet: p.bet,
    percentage: bank ? Number(((p.bet / bank) * 100).toFixed(4)) : 0,
    status: p.status || "active"
  }));

  const revealWinner = state.status === "RESULT";
  const players = revealWinner
    ? rawPlayers
    : rawPlayers.map(p => ({ ...p, status: "active" }));

  const winnerPlayer = revealWinner && state.winnerId
    ? state.players.get(state.winnerId)
    : null;

  const winner = winnerPlayer ? {
    id: winnerPlayer.id,
    name: winnerPlayer.name,
    avatar: winnerPlayer.avatar,
    color: winnerPlayer.color,
    bet: Number(winnerPlayer.bet || 0),
    percentage: bank ? Number(((winnerPlayer.bet / bank) * 100).toFixed(4)) : 0,
    payout: Number(state.payout || 0)
  } : null;

  return {
    roomId: state.roomId,
    status: state.status,
    countdownEndsAt: state.countdownEndsAt,
    bank,
    players,
    // Winner is not exposed until the pointer has stopped and RESULT is active.
    winnerId: revealWinner ? state.winnerId : null,
    winner,
    // Only the pointer's target angle is sent during SPINNING.
    spinTargetAngle: state.status === "SPINNING" ? Number(state.spinTargetAngle || 0) : null,
    commission: revealWinner ? state.commission : 0,
    payout: revealWinner ? state.payout : 0
  };
}
function broadcast() {
  io.emit("room_state", publicState());
}

// Turns a server seed (+ a purpose "salt") into a deterministic float in
// [0,1). Reusing the same seed with different salts for the winner pick and
// the spin angle keeps both derived from one committed value, so the whole
// round can be re-derived and checked later from the seed alone.
function seededFloat(seed, salt) {
  const h = crypto.createHash("sha256").update(`${seed}:${salt}`).digest();
  return h.readUInt32BE(0) / 0x100000000;
}

function weightedWinner(players, target) {
  const funded = players.filter(p => Number(p.bet) > 0);
  const bank = funded.reduce((sum, p) => sum + Number(p.bet), 0);
  if (!bank) return null;

  let cumulative = 0;
  for (const p of funded) {
    cumulative += Number(p.bet) / bank;
    if (target < cumulative) return p;
  }
  return funded[funded.length - 1];
}

function validateTelegramInitData(initData) {
  if (!initData) return { ok: false, reason: "missing" };
  if (!process.env.TELEGRAM_BOT_TOKEN) return { ok: false, reason: "bot_token_missing" };

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { ok: false, reason: "hash_missing" };

    const pairs = [];
    for (const [key, value] of params.entries()) {
      if (key !== "hash") pairs.push([key, value]);
    }
    pairs.sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(process.env.TELEGRAM_BOT_TOKEN)
      .digest();

    const calculated = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    const a = Buffer.from(calculated, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: "hash_invalid" };
    }

    const authDate = Number(params.get("auth_date") || 0);
    const maxAge = Number(process.env.TELEGRAM_INIT_DATA_MAX_AGE || 86400);
    if (!authDate || Math.floor(Date.now() / 1000) - authDate > maxAge) {
      return { ok: false, reason: "expired" };
    }

    const user = JSON.parse(params.get("user") || "{}");
    if (!user.id) return { ok: false, reason: "user_missing" };

    return {
      ok: true,
      user: {
        id: String(user.id),
        first_name: safeName(user.first_name || "Игрок"),
        last_name: safeName(user.last_name || ""),
        username: String(user.username || ""),
        photo_url: String(user.photo_url || "")
      }
    };
  } catch (e) {
    return { ok: false, reason: "parse_error" };
  }
}

function telegramUserFromRequest(req) {
  const raw = req.headers["x-telegram-init-data"];
  return validateTelegramInitData(raw);
}

async function initDb() {
  requireDatabase();

  // Each statement runs as its own query instead of one giant batch, so a
  // failure partway through (e.g. an index that can't be created) can't
  // silently roll back migrations that already succeeded, such as the
  // ALTER TABLE ... ADD COLUMN statements further down.
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      first_name TEXT NOT NULL DEFAULT 'Игрок',
      avatar_url TEXT NOT NULL DEFAULT '',
      balance NUMERIC(20,2) NOT NULL DEFAULT 0,
      banned BOOLEAN NOT NULL DEFAULT FALSE,
      referred_by TEXT,
      games_played INTEGER NOT NULL DEFAULT 0,
      games_won INTEGER NOT NULL DEFAULT 0,
      total_wagered NUMERIC(20,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS payments (
      telegram_payment_charge_id TEXT PRIMARY KEY,
      telegram_user_id TEXT NOT NULL,
      amount NUMERIC(20,2) NOT NULL,
      payload TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS balance_transactions (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount NUMERIC(20,2) NOT NULL,
      balance_after NUMERIC(20,2) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      admin_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS pvp_rounds (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      bank NUMERIC(20,2) NOT NULL,
      winner_id TEXT,
      winner_bet NUMERIC(20,2),
      payout NUMERIC(20,2),
      commission NUMERIC(20,2),
      players JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS referral_earnings (
      id BIGSERIAL PRIMARY KEY,
      referrer_id TEXT NOT NULL,
      referred_user_id TEXT NOT NULL,
      telegram_payment_charge_id TEXT UNIQUE NOT NULL,
      deposit_amount NUMERIC(20,2) NOT NULL,
      reward_amount NUMERIC(20,2) NOT NULL,
      claimed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS promo_codes (
      id BIGSERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      bonus NUMERIC(20,2) NOT NULL CHECK (bonus > 0),
      max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
      uses_count INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS promo_redemptions (
      promo_code_id BIGINT NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      bonus NUMERIC(20,2) NOT NULL,
      redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (promo_code_id, telegram_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS raffles (
      id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      raffle_type TEXT NOT NULL CHECK (raffle_type IN ('free','paid')),
      ticket_price NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (ticket_price >= 0),
      prize_pool NUMERIC(20,2) NOT NULL CHECK (prize_pool > 0),
      prize_title TEXT NOT NULL DEFAULT 'Stars',
      winners_count INTEGER NOT NULL CHECK (winners_count > 0),
      ends_at TIMESTAMPTZ NOT NULL,
      channel_id TEXT NOT NULL,
      channel_username TEXT NOT NULL,
      channel_title TEXT NOT NULL DEFAULT '',
      post_message_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','settling','finished','cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS raffle_entries (
      raffle_id TEXT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      tickets INTEGER NOT NULL DEFAULT 0 CHECK (tickets >= 0),
      paid_amount NUMERIC(20,2) NOT NULL DEFAULT 0,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (raffle_id, telegram_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS raffle_referrals (
      raffle_id TEXT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      referrer_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      referred_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (raffle_id, referred_user_id),
      UNIQUE (raffle_id, referrer_id, referred_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS raffle_boost_claims (
      raffle_id TEXT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      boost_count INTEGER NOT NULL DEFAULT 0,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (raffle_id, telegram_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS raffle_winners (
      raffle_id TEXT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      place INTEGER NOT NULL,
      payout NUMERIC(20,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (raffle_id, place),
      UNIQUE (raffle_id, telegram_user_id)
    )`,
    `CREATE INDEX IF NOT EXISTS raffles_active_idx ON raffles(status, ends_at)`,
    `CREATE INDEX IF NOT EXISTS raffle_entries_user_idx ON raffle_entries(telegram_user_id, joined_at DESC)`,
    `CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      currency TEXT NOT NULL CHECK (currency IN ('STAR','GRAM','TON')),
      amount NUMERIC(20,2) NOT NULL CHECK (amount > 0),
      wallet_address TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS ton_topup_intents (
      id UUID PRIMARY KEY,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      expected_nano_ton NUMERIC(30,0) NOT NULL,
      stars INTEGER NOT NULL CHECK (stars > 0),
      comment TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      transaction_hash TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      credited_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY,
      created_by TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      task_type TEXT NOT NULL CHECK (task_type IN ('channel_subscription','bot_start')),
      target_username TEXT NOT NULL,
      target_chat_id TEXT NOT NULL DEFAULT '',
      reward NUMERIC(20,2) NOT NULL CHECK (reward > 0),
      max_activations INTEGER NOT NULL CHECK (max_activations > 0),
      completions INTEGER NOT NULL DEFAULT 0,
      price NUMERIC(20,2) NOT NULL CHECK (price > 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS task_completions (
      task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (task_id, telegram_user_id)
    )`,

    // Migrate an already-existing database without wiping users.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS games_won INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS total_wagered NUMERIC(20,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS wager_remaining NUMERIC(20,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS wager NUMERIC(10,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS wallet_address TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`,
    `ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS reviewed_by TEXT`,
    `ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS decline_reason TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE pvp_rounds ADD COLUMN IF NOT EXISTS round_number SERIAL`,
    `ALTER TABLE pvp_rounds ADD COLUMN IF NOT EXISTS server_seed TEXT`,
    `ALTER TABLE pvp_rounds ADD COLUMN IF NOT EXISTS server_seed_hash TEXT`,

    `CREATE INDEX IF NOT EXISTS promo_codes_active_idx ON promo_codes(active, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS promo_redemptions_user_idx ON promo_redemptions(telegram_user_id, redeemed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS users_username_idx ON users(username)`,
    `CREATE INDEX IF NOT EXISTS users_referred_by_idx ON users(referred_by)`,
    `CREATE INDEX IF NOT EXISTS tx_user_idx ON balance_transactions(telegram_user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS referral_referrer_idx ON referral_earnings(referrer_id, claimed, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS withdrawal_requests_user_idx ON withdrawal_requests(telegram_user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS withdrawal_requests_status_idx ON withdrawal_requests(status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ton_topup_intents_pending_idx ON ton_topup_intents(status, created_at)`,
    `CREATE INDEX IF NOT EXISTS tasks_active_idx ON tasks(status, created_at DESC)`,
    `DO $$ BEGIN
       ALTER TABLE withdrawal_requests DROP CONSTRAINT IF EXISTS withdrawal_requests_currency_check;
       ALTER TABLE withdrawal_requests ADD CONSTRAINT withdrawal_requests_currency_check CHECK (currency IN ('STAR','GRAM','TON'));
     EXCEPTION WHEN duplicate_object THEN NULL; END $$`
  ];

  for (const sql of statements) {
    try {
      await pool.query(sql);
    } catch (e) {
      console.error("DB migration statement failed:", e.message, "\nSQL:", sql.split("\n")[0].trim());
    }
  }
}

async function getUser(userId, { fresh = false } = {}) {
  requireDatabase();
  if (!fresh) {
    const cached = getCachedUser(userId);
    if (cached) return cached;
  }
  const r = await pool.query(
    `SELECT telegram_id, username, first_name, avatar_url, balance::float AS balance,
            banned, referred_by, games_played, games_won,
            total_wagered::float AS total_wagered, created_at, updated_at
     FROM users WHERE telegram_id=$1`,
    [String(userId)]
  );
  return cacheUser(r.rows[0] || null);
}

async function upsertUser(user, referralCode = null) {
  requireDatabase();
  const referral = String(referralCode || '').trim().replace(/^ref_/i, '');
  const referralOwner = (/^\d+$/.test(referral) && referral !== String(user.id)) ? referral : null;
  const r = await pool.query(
    `INSERT INTO users (telegram_id, username, first_name, avatar_url, referred_by)
     VALUES ($1,$2,$3,$4, CASE WHEN $5::text IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE telegram_id=$5) THEN $5 ELSE NULL END)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username=EXCLUDED.username,
       first_name=EXCLUDED.first_name,
       avatar_url=EXCLUDED.avatar_url,
       referred_by=COALESCE(users.referred_by, EXCLUDED.referred_by),
       updated_at=NOW()
     RETURNING telegram_id, username, first_name, avatar_url, balance::float AS balance,
               banned, referred_by, games_played, games_won,
               total_wagered::float AS total_wagered, created_at, updated_at`,
    [user.id, user.username || '', user.first_name || 'Игрок', user.photo_url || '', referralOwner]
  );
  return cacheUser(r.rows[0]);
}

async function getBalance(userId) {
  const u = await getUser(userId);
  return u ? Number(u.balance) : 0;
}

async function debitBalance(userId, amount, meta = {}) {
  requireDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `UPDATE users
       SET balance = balance - $2, updated_at=NOW()
       WHERE telegram_id=$1 AND banned=false AND balance >= $2
       RETURNING balance::float AS balance`,
      [String(userId), amount]
    );
    if (!r.rowCount) {
      await client.query("ROLLBACK");
      throw new Error("Недостаточно Stars на балансе.");
    }
    const balanceAfter = Number(r.rows[0].balance);

    // Wagering: a real bet (PVP or Upgrade) works off any outstanding promo
    // wager requirement, stake-for-stake, win or lose. If the balance is
    // fully drained while a requirement is still open, the requirement is
    // cleared right away — there's nothing left of the bonus to protect,
    // and leaving it open would otherwise trap the player's later, unrelated
    // deposits behind a stale requirement.
    if (meta.countsAsWager) {
      await client.query(
        `UPDATE users SET wager_remaining = GREATEST(0, wager_remaining - $2) WHERE telegram_id=$1`,
        [String(userId), amount]
      );
      if (balanceAfter <= 0) {
        await client.query(`UPDATE users SET wager_remaining=0 WHERE telegram_id=$1`, [String(userId)]);
      }
    }

    await client.query(
      `INSERT INTO balance_transactions
       (telegram_user_id, type, amount, balance_after, description)
       VALUES ($1,$2,$3,$4,$5)`,
      [String(userId), meta.type || "pvp_bet", -amount, balanceAfter, meta.description || "Ставка PVP"]
    );
    await client.query("COMMIT");
    invalidateUserCache(userId);
    cacheUser(await getUser(userId, { fresh: true }));
    return balanceAfter;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function creditBalance(userId, amount, client = pool, meta = {}) {
  if (!client) throw new Error("DATABASE_URL не настроен.");
  const r = await client.query(
    `UPDATE users SET balance = balance + $2, updated_at=NOW() WHERE telegram_id=$1 RETURNING balance::float AS balance`,
    [String(userId), amount]
  );
  if (!r.rowCount) throw new Error("Пользователь не найден.");
  const balanceAfter = Number(r.rows[0].balance);
  await client.query(
    `INSERT INTO balance_transactions
     (telegram_user_id, type, amount, balance_after, description, admin_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [String(userId), meta.type || "credit", amount, balanceAfter, meta.description || "", meta.adminId || null]
  );
  invalidateUserCache(userId);
  return balanceAfter;
}

async function adjustAdminBalance(targetId, delta, adminId, description) {
  requireDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT balance::float AS balance, banned FROM users WHERE telegram_id=$1 FOR UPDATE`,
      [String(targetId)]
    );
    if (!current.rowCount) throw new Error("Пользователь не найден.");
    const before = Number(current.rows[0].balance);
    const after = before + Number(delta);
    if (after < 0) throw new Error("Нельзя списать больше текущего баланса.");

    const updated = await client.query(
      `UPDATE users SET balance=$2, updated_at=NOW() WHERE telegram_id=$1 RETURNING balance::float AS balance`,
      [String(targetId), after]
    );
    const balanceAfter = Number(updated.rows[0].balance);
    await client.query(
      `INSERT INTO balance_transactions
       (telegram_user_id, type, amount, balance_after, description, admin_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [String(targetId), delta >= 0 ? "admin_credit" : "admin_debit", Number(delta), balanceAfter, description || "Изменение администратором", String(adminId)]
    );
    await client.query("COMMIT");
    invalidateUserCache(targetId);
    return balanceAfter;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function setBanned(targetId, banned, adminId) {
  requireDatabase();
  const r = await pool.query(
    `UPDATE users SET banned=$2, updated_at=NOW() WHERE telegram_id=$1 RETURNING telegram_id, banned`,
    [String(targetId), !!banned]
  );
  if (!r.rowCount) throw new Error("Пользователь не найден.");
  await pool.query(
    `INSERT INTO balance_transactions
     (telegram_user_id, type, amount, balance_after, description, admin_id)
     SELECT telegram_id, $2, 0, balance, $3, $4 FROM users WHERE telegram_id=$1`,
    [String(targetId), banned ? "admin_ban" : "admin_unban", banned ? "Бан администратором" : "Разбан администратором", String(adminId)]
  );
  if (banned) io.to(`user:${targetId}`).emit("force_banned");
  else io.to(`user:${targetId}`).emit("unbanned");
  return r.rows[0];
}

async function finishRound() {
  if (state.status !== "COUNTDOWN") return;
  state.status = "SPINNING";
  state.countdownEndsAt = null;

  const players = [...state.players.values()];

  // Provably-fair round seed: everything random about this round (who wins,
  // exactly where the pointer stops) is derived from this one seed, so the
  // seed + hash shown afterwards in the round history are enough for anyone
  // to recompute the exact same result.
  const roundSeed = crypto.randomBytes(16).toString("hex");
  const roundSeedHash = crypto.createHash("sha256").update(roundSeed).digest("hex");

  const winner = weightedWinner(players, seededFloat(roundSeed, "winner"));
  if (!winner) {
    state.status = "WAITING";
    broadcast();
    return;
  }

  state.winnerId = winner.id;
  let winnerBalanceAfter = null;
  const bank = totalBank();

  // The server settles the outcome, but the UI will not reveal the winner
  // until the pointer animation has fully stopped.
  let sectorStart = 0;
  for (const p of players) {
    const share = bank > 0 ? (Number(p.bet) / bank) * 100 : 0;
    if (p.id === winner.id) {
      // Stop at a random point INSIDE the winner's sector, not at its
      // center, so repeated wins land at different positions. Derived from
      // the same round seed as the winner pick (different salt).
      const edge = Math.min(0.75, share / 4);
      const usableStart = sectorStart + edge;
      const usableEnd = sectorStart + share - edge;
      const fraction = usableEnd > usableStart
        ? usableStart + seededFloat(roundSeed, "angle") * (usableEnd - usableStart)
        : sectorStart + share / 2;
      state.spinTargetAngle = fraction * 3.6;
      break;
    }
    sectorStart += share;
  }

  // Telegram Stars are whole Stars, so production payout is rounded down.
  // The winner still can never receive less than their original stake.
  const normalPayout = Math.floor(bank * 0.92);
  const payout = Math.max(Number(winner.bet), normalPayout);
  const commission = Math.max(0, Number((bank - payout).toFixed(2)));

  state.payout = payout;
  state.commission = commission;
  winner.status = "winner";
  for (const p of players) if (p.id !== winner.id) p.status = "lost";

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Winner's stake has already been debited when it was placed.
      const r = await client.query(
        `UPDATE users SET balance=balance+$2, updated_at=NOW()
         WHERE telegram_id=$1 RETURNING balance::float AS balance`,
        [String(winner.id), payout]
      );
      if (!r.rowCount) throw new Error("Победитель не найден при расчёте.");
      const balanceAfter = Number(r.rows[0].balance);
      await client.query(
        `INSERT INTO balance_transactions
         (telegram_user_id, type, amount, balance_after, description)
         VALUES ($1,'pvp_win',$2,$3,$4)`,
        [String(winner.id), payout, balanceAfter, `Победа PVP, раунд ${state.roomId}`]
      );

      // Update per-player profile statistics for every funded participant.
      for (const p of players) {
        await client.query(
          `UPDATE users
           SET games_played = games_played + 1,
               games_won = games_won + $2,
               total_wagered = total_wagered + $3,
               updated_at = NOW()
           WHERE telegram_id=$1`,
          [String(p.id), p.id === winner.id ? 1 : 0, Number(p.bet)]
        );
      }

      await client.query(
        `INSERT INTO pvp_rounds (id, bank, winner_id, winner_bet, payout, commission, players, server_seed, server_seed_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [state.roomId, bank, winner.id, winner.bet, payout, commission, JSON.stringify(publicState().players), roundSeed, roundSeedHash]
      );
      await client.query("COMMIT");
      winnerBalanceAfter = balanceAfter;
      invalidateUserCache(winner.id);
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      console.error("Round settlement error:", e.message);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("Round settlement database error:", e.message);
  }

  broadcast();

  // Keep the final result on screen after the arrow animation completes.
  setTimeout(() => {
    if (state.status === "SPINNING") {
      state.status = "RESULT";
      broadcast();
      // Do not reveal the winner via their balance while the arrow is still
      // moving. Everyone receives this update only after the visible result.
      if (winnerBalanceAfter != null) {
        io.to(`user:${winner.id}`).emit("balance_updated", { balance: winnerBalanceAfter });
      }
    }
  }, 6350);

  setTimeout(resetRound, 11500);
}

function startCountdownIfNeeded() {
  const fundedPlayers = [...state.players.values()].filter(p => Number(p.bet) > 0);
  if (state.status === "WAITING" && fundedPlayers.length >= 2) {
    state.status = "COUNTDOWN";
    state.countdownEndsAt = Date.now() + 20000;
    broadcast();
    clearTimeout(timerHandle);
    timerHandle = setTimeout(finishRound, 20050);
  }
}

function resetRound() {
  clearTimeout(timerHandle);
  state.roomId = crypto.randomUUID();
  state.status = "WAITING";
  state.countdownEndsAt = null;
  state.players.clear();
  state.winnerId = null;
  state.commission = 0;
  state.payout = 0;

  // Tell all still-open Mini Apps to register themselves in the new room.
  io.emit("new_round", { roomId: state.roomId });
  broadcast();
}

function addOrUpdatePlayer({ id, name, avatar }) {
  const existing = state.players.get(id);
  if (existing) return existing;
  const color = availableColor();
  if (!color) throw new Error("В этой комнате закончились цвета.");
  const player = { id, name: safeName(name), avatar: avatar || "", color, bet: 0, status: "active", betLocked: false };
  state.players.set(id, player);
  return player;
}

async function placeBet(playerId, amount) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Ставка должна быть целым числом Stars больше 0.");
  if (state.status !== "WAITING" && state.status !== "COUNTDOWN") throw new Error("Ставки сейчас закрыты.");
  if (state.status === "COUNTDOWN" && state.countdownEndsAt && Date.now() >= state.countdownEndsAt) throw new Error("Время ставок закончилось.");

  let p = state.players.get(playerId);

  // A connected socket can survive the previous round while the in-memory
  // room is reset. Recreate that player's room record automatically instead
  // of returning the confusing "Игрок не найден" error.
  if (!p) {
    const dbUser = await getUser(playerId);
    if (!dbUser) throw new Error("Пользователь не найден в базе данных.");
    if (dbUser.banned) throw new Error("Ваш аккаунт заблокирован в приложении.");

    p = addOrUpdatePlayer({
      id: playerId,
      name: dbUser.username ? "@" + dbUser.username : dbUser.first_name,
      avatar: dbUser.avatar_url
    });
  }

  if (p.betLocked) throw new Error("Предыдущая ставка ещё обрабатывается.");

  p.betLocked = true;
  try {
    const balance = await debitBalance(playerId, amount, { countsAsWager: true });
    p.bet += amount;
    p.betLocked = false;
    broadcast();
    startCountdownIfNeeded();
    return { player: p, balance };
  } catch (e) {
    p.betLocked = false;
    throw e;
  }
}

// ---------- UPGRADE (solo game) ----------
// Player picks a stake and a target amount (target > stake). The chance of
// success is exactly stake/target — the same ratio that sizes the yellow
// slice of the wheel. Win: balance receives `target`. Loss: the stake
// (already debited) is simply gone. No extra commission is taken; the odds
// themselves are the house edge.
async function playUpgrade(playerId, bet, target) {
  if (!Number.isInteger(bet) || bet <= 0) throw new Error("Ставка должна быть целым числом Stars больше 0.");
  if (!Number.isInteger(target) || target <= bet) throw new Error("Цель должна быть целым числом Stars больше ставки.");

  const dbUser = await getUser(playerId);
  if (!dbUser) throw new Error("Пользователь не найден в базе данных.");
  if (dbUser.banned) throw new Error("Ваш аккаунт заблокирован в приложении.");

  const chance = (bet / target) * 100;

  let balance = await debitBalance(playerId, bet, {
    type: "upgrade_bet",
    description: `Апгрейд ${bet} → ${target} ⭐`,
    countsAsWager: true
  });

  // The random value is the position where the arrow will stop around the
  // circle. Yellow occupies [0, chance), therefore the result is determined
  // exclusively by the sector under that final arrow position.
  const max = 1_000_000_000;
  const r = Number(BigInt("0x" + crypto.randomBytes(8).toString("hex")) % BigInt(max));
  const rollPercent = Number(((r / max) * 100).toFixed(6));
  const win = rollPercent < chance;

  // The server is authoritative about both the outcome and the exact visual
  // landing point. The client uses this same roll percentage, so the pointer
  // can never land in yellow for a loss or in gray for a win.
  if (win) {
    try {
      balance = await creditBalance(playerId, target, pool, {
        type: "upgrade_win",
        description: `Выигрыш апгрейда ${bet} → ${target} ⭐`
      });
    } catch (e) {
      console.error("Upgrade payout error:", e.message);
    }
  }

  try {
    await pool.query(
      `UPDATE users
       SET games_played = games_played + 1,
           games_won = games_won + $2,
           total_wagered = total_wagered + $3,
           updated_at = NOW()
       WHERE telegram_id=$1`,
      [String(playerId), win ? 1 : 0, bet]
    );
    invalidateUserCache(playerId);
  } catch (e) {
    console.error("Upgrade stats update error:", e.message);
  }

  return {
    win,
    chance: Number(chance.toFixed(4)),
    bet,
    target,
    rollPercent,
    payout: win ? target : 0,
    balance
  };
}

async function authenticatedUserFromInitData(initData, referralCode = null) {
  const checked = validateTelegramInitData(initData);
  if (!checked.ok) {
    const messages = {
      missing: "Откройте приложение через Telegram Mini App.",
      bot_token_missing: "TELEGRAM_BOT_TOKEN не настроен на Render.",
      hash_missing: "Telegram initData не содержит hash.",
      hash_invalid: "Авторизация Telegram недействительна. Проверьте TELEGRAM_BOT_TOKEN и URL Mini App.",
      expired: "Сессия Telegram устарела. Закройте и снова откройте Mini App.",
      user_missing: "Не удалось определить пользователя Telegram.",
      parse_error: "Не удалось прочитать данные Telegram."
    };
    throw new Error(messages[checked.reason] || "Авторизация Telegram не выполнена.");
  }
  const user = await upsertUser(checked.user, referralCode);
  if (user.banned) throw new Error("Ваш аккаунт заблокирован в приложении.");
  return { telegram: checked.user, db: user };
}

async function requireAdminRequest(req) {
  const raw = req.headers["x-telegram-init-data"] || "";
  const cacheKey = raw;
  const hit = adminAuthCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 30000) return hit.user;

  const checked = validateTelegramInitData(raw);
  if (!checked.ok) throw new Error("Авторизация Telegram не выполнена.");
  const id = String(checked.user.id);
  if (!isAdmin(id)) throw new Error("Нет доступа к админ-панели.");
  adminAuthCache.set(cacheKey, { user: checked.user, at: Date.now() });
  return checked.user;
}

io.on("connection", socket => {
  socket.on("join_room", async data => {
    try {
      const session = await authenticatedUserFromInitData(data?.initData, data?.referralCode);
      const tgUser = session.telegram;
      const p = addOrUpdatePlayer({
        id: tgUser.id,
        name: tgUser.username ? "@" + tgUser.username : tgUser.first_name,
        avatar: tgUser.photo_url
      });
      socket.data.playerId = p.id;
      socket.join(`user:${p.id}`);
      socket.emit("joined", {
        playerId: p.id,
        color: p.color,
        balance: session.db.balance,
        user: tgUser,
        isAdmin: isAdmin(p.id)
      });
      socket.emit("room_state", publicState());
      broadcast();
    } catch (e) {
      socket.emit("error_message", e.message);
    }
  });

  socket.on("new_round_ack", () => {
    // Kept for client compatibility; server state is already reset.
  });

  socket.on("place_bet", async data => {
    try {
      const id = socket.data.playerId;
      if (!id) throw new Error("Авторизация Telegram не выполнена.");
      const dbUser = await getUser(id);
      if (!dbUser || dbUser.banned) throw new Error("Ваш аккаунт заблокирован в приложении.");
      const amount = Number(data?.amount);
      const result = await placeBet(id, amount);
      socket.emit("bet_accepted", { bet: result.player.bet, balance: result.balance });
      socket.emit("balance_updated", { balance: result.balance });
      broadcast();
    } catch (e) { socket.emit("error_message", e.message); }
  });

  socket.on("upgrade_spin", async data => {
    try {
      const id = socket.data.playerId;
      if (!id) throw new Error("Авторизация Telegram не выполнена.");
      const bet = Number(data?.bet);
      const target = Number(data?.target);
      const result = await playUpgrade(id, bet, target);
      socket.emit("upgrade_result", result);
      // The balance itself reveals the result, so keep it hidden until the
      // arrow has visibly stopped on its yellow or gray sector.
      setTimeout(() => socket.emit("balance_updated", { balance: result.balance }), 6350);
    } catch (e) { socket.emit("error_message", e.message); }
  });

  socket.on("request_state", () => socket.emit("room_state", publicState()));

  socket.on("disconnect", () => {
    const id = socket.data.playerId;
    if (id && state.status === "WAITING") {
      const p = state.players.get(id);
      if (p && p.bet === 0 && !p.betLocked) state.players.delete(id);
      broadcast();
    }
  });
});

app.get("/api/me", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    res.json({ user: session.telegram, balance: session.db.balance, isAdmin: isAdmin(session.telegram.id), banned: session.db.banned });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.get("/api/telegram/webhook-status", async (req, res) => {
  try {
    const checked = validateTelegramInitData(req.headers["x-telegram-init-data"]);
    if (!checked.ok || !isAdmin(checked.user.id)) return res.status(403).json({ error: "Нет доступа." });
    const info = await telegramApi("getWebhookInfo", {});
    res.json({ ok: true, url: info.url || "", pending: info.pending_update_count || 0, last_error: info.last_error_message || null, last_error_date: info.last_error_date || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/telegram/status", async (req, res) => {
  const checked = validateTelegramInitData(req.headers["x-telegram-init-data"]);
  res.json({
    telegramConfigured: !!process.env.TELEGRAM_BOT_TOKEN,
    initDataReceived: !!req.headers["x-telegram-init-data"],
    authorized: checked.ok,
    reason: checked.ok ? null : checked.reason,
    databaseConfigured: !!pool
  });
});

app.post("/api/stars/create-invoice", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const amount = Number(req.body?.amount);
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: "Неверная сумма Stars." });
    // Telegram's XTR invoice API accepts at most 2,500 Stars per invoice.
    if (amount > 2500) return res.status(400).json({ error: "За один платёж можно пополнить не более 2500 Stars." });
    if (!process.env.TELEGRAM_BOT_TOKEN) return res.status(503).json({ error: "TELEGRAM_BOT_TOKEN не настроен." });

    const payload = JSON.stringify({
      type: "balance_topup",
      amount,
      userId: session.telegram.id,
      nonce: crypto.randomUUID()
    });

    const tg = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Пополнение баланса",
        description: `Пополнение на ${amount} Telegram Stars`,
        payload,
        currency: "XTR",
        prices: [{ label: "Stars", amount }]
      })
    });
    const data = await tg.json();
    if (!data.ok) return res.status(502).json({ error: data.description || "Telegram API error" });
    res.json({ invoiceUrl: data.result });
  } catch (e) {
    res.status(401).json({ error: e.message || "Не удалось создать счёт." });
  }
});


// ---------------- TELEGRAM BOT ----------------
function telegramApiUrl(method) {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function telegramApi(method, body) {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN не настроен.");
  }
  const response = await fetch(telegramApiUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data.result;
}

// Sends a plain-text DM to every configured admin. Failures for one admin
// (blocked bot, never started a chat with it, etc.) never stop the others.
async function notifyAdmins(text) {
  const ids = getAdminIds();
  if (!ids.length || !process.env.TELEGRAM_BOT_TOKEN) return;
  await Promise.all(ids.map(id =>
    telegramApi("sendMessage", { chat_id: id, text }).catch(e =>
      console.error(`Admin notify error (${id}):`, e.message)
    )
  ));
}

function withdrawalButtons(requestId) {
  return {
    inline_keyboard: [[
      { text: "✅ Принять", callback_data: `withdraw:approve:${requestId}` },
      { text: "❌ Отклонить", callback_data: `withdraw:decline:${requestId}` }
    ]]
  };
}

async function notifyWithdrawalAdmins(text, requestId) {
  const ids = getAdminIds();
  if (!ids.length || !process.env.TELEGRAM_BOT_TOKEN) return;
  await Promise.all(ids.map(id =>
    telegramApi("sendMessage", { chat_id: id, text, reply_markup: withdrawalButtons(requestId) }).catch(e =>
      console.error(`Withdrawal notify error (${id}):`, e.message)
    )
  ));
}

async function answerCallbackQuery(id, text) {
  if (!id) return;
  await telegramApi("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }).catch(e =>
    console.error("Telegram callback answer error:", e.message)
  );
}

async function completeWithdrawal(requestId, adminId) {
  requireDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE withdrawal_requests
       SET status='approved', reviewed_at=NOW(), reviewed_by=$2
       WHERE id=$1 AND status='pending'
       RETURNING id, telegram_user_id, amount::float AS amount, currency`,
      [requestId, String(adminId)]
    );
    if (!result.rowCount) throw new Error("Заявка уже обработана другим администратором.");
    await client.query("COMMIT");
    return result.rows[0];
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function requestWithdrawalDeclineReason(requestId, adminId) {
  requireDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pending = await client.query(
      `SELECT id FROM withdrawal_requests
       WHERE status='decline_reason_pending' AND reviewed_by=$1 FOR UPDATE`,
      [String(adminId)]
    );
    if (pending.rowCount) throw new Error("Сначала укажите причину для предыдущей заявки.");
    const result = await client.query(
      `UPDATE withdrawal_requests SET status='decline_reason_pending', reviewed_by=$2
       WHERE id=$1 AND status='pending'
       RETURNING id`,
      [requestId, String(adminId)]
    );
    if (!result.rowCount) throw new Error("Заявка уже обработана другим администратором.");
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function rejectWithdrawal(requestId, adminId, reason = "") {
  requireDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const request = await client.query(
      `SELECT id, telegram_user_id, amount::float AS amount, currency
       FROM withdrawal_requests
       WHERE id=$1 AND status='decline_reason_pending' AND reviewed_by=$2 FOR UPDATE`,
      [Number(requestId), String(adminId)]
    );
    if (!request.rowCount) throw new Error("Заявка уже обработана или ожидает другого администратора.");
    const withdrawal = request.rows[0];
    const cleanReason = String(reason || "").trim().slice(0, 700);
    const balance = await creditBalance(withdrawal.telegram_user_id, withdrawal.amount, client, {
      type: "withdraw_rejected",
      description: `Возврат по отклонённой заявке на вывод №${withdrawal.id}`,
      adminId
    });
    await client.query(
      `UPDATE withdrawal_requests
       SET status='rejected', reviewed_at=NOW(), reviewed_by=$2, decline_reason=$3
       WHERE id=$1`,
      [Number(requestId), String(adminId), cleanReason]
    );
    await client.query("COMMIT");
    return { ...withdrawal, balance, reason: cleanReason };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function notifyWithdrawalCompleted(withdrawal) {
  await telegramApi("sendMessage", {
    chat_id: withdrawal.telegram_user_id,
    text: `✅ Ваша заявка на вывод №${withdrawal.id} выполнена.\nСумма: ${Number(withdrawal.amount).toFixed(2)} ⭐.`
  }).catch(e => console.error("Withdrawal completion notify error:", e.message));
}

async function notifyWithdrawalRejected(withdrawal) {
  const reason = withdrawal.reason ? `\nПричина: ${withdrawal.reason}` : "";
  await telegramApi("sendMessage", {
    chat_id: withdrawal.telegram_user_id,
    text: `❌ Ваша заявка на вывод №${withdrawal.id} отклонена.${reason}\nСредства возвращены на баланс.`
  }).catch(e => console.error("Withdrawal rejection notify error:", e.message));
  io.to(`user:${withdrawal.telegram_user_id}`).emit("balance_updated", { balance: withdrawal.balance });
}


// ---------------- RAFFLES ----------------
let botInfoCache = null;
let botInfoCacheAt = 0;

async function getBotInfoCached() {
  if (botInfoCache && Date.now() - botInfoCacheAt < 60 * 60 * 1000) return botInfoCache;
  botInfoCache = await telegramApi("getMe", {});
  botInfoCacheAt = Date.now();
  return botInfoCache;
}

function normalizeChannelRef(value) {
  const raw = String(value || '').trim();
  const username = raw.replace(/^https?:\/\/(?:t\.me\/|telegram\.me\/)?/i, '').replace(/^@/, '').split(/[/?#\s]/)[0];
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error('Укажи публичный канал в формате @channel.');
  return { username, chatId: '@' + username };
}

function parseRaffleStartParam(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^rg_([0-9a-f-]{36})_(\d+)$/i);
  return m ? { raffleId: m[1], referrerId: m[2] } : null;
}

async function verifyRaffleChannel(channelRef, creatorId) {
  const channel = normalizeChannelRef(channelRef);
  const chat = await telegramApi('getChat', { chat_id: channel.chatId });
  if (chat.type !== 'channel') throw new Error('Нужен именно Telegram-канал, а не группа.');

  const creatorMember = await telegramApi('getChatMember', { chat_id: chat.id, user_id: Number(creatorId) });
  const creatorOk = ['creator', 'administrator'].includes(String(creatorMember.status));
  if (!creatorOk) throw new Error('Создатель розыгрыша должен быть администратором этого канала.');

  const bot = await getBotInfoCached();
  const botMember = await telegramApi('getChatMember', { chat_id: chat.id, user_id: bot.id });
  const botOk = ['creator', 'administrator'].includes(String(botMember.status));
  if (!botOk || (botMember.can_post_messages === false)) {
    throw new Error('Сначала добавь бота в администраторы канала с правом публикации сообщений.');
  }

  const username = String(chat.username || channel.username);
  if (!username) throw new Error('Для розыгрыша нужен публичный канал с @username, чтобы участники могли его открыть и бустить.');

  return { chat, username };
}

function rafflePublicRow(row) {
  return {
    id: String(row.id),
    creatorId: String(row.creator_id),
    type: row.raffle_type,
    ticketPrice: Number(row.ticket_price || 0),
    prizePool: Number(row.prize_pool || 0),
    prizeTitle: row.prize_title || 'Stars',
    winnersCount: Number(row.winners_count),
    endsAt: new Date(row.ends_at).getTime(),
    channelId: String(row.channel_id),
    channelUsername: row.channel_username,
    channelTitle: row.channel_title || row.channel_username,
    postMessageId: row.post_message_id ? Number(row.post_message_id) : null,
    status: row.status,
    createdAt: new Date(row.created_at).getTime(),
    finishedAt: row.finished_at ? new Date(row.finished_at).getTime() : null
  };
}

function botChannelLink(username) {
  return `https://t.me/${String(username || '').replace(/^@/, '')}`;
}
function botBoostLink(username) {
  return `https://t.me/boost/${String(username || '').replace(/^@/, '')}`;
}

function normalizeBotUsername(username) {
  return String(username || '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/t\.me\//i, '')
    .split(/[/?#\s]/)[0];
}

function buildTelegramMiniAppLink(botUsername, startParam = '') {
  const username = normalizeBotUsername(botUsername);
  if (!username || !/^[A-Za-z0-9_]{5,32}$/.test(username)) return '';

  const start = String(startParam || '').trim();
  const shortName = String(process.env.TELEGRAM_MINI_APP_SHORT_NAME || '')
    .trim()
    .replace(/^\//, '')
    .split(/[?#\s]/)[0];

  // A named Direct Mini App link works from channel posts and does not require
  // sending the user through the bot chat first. Configure the short name in BotFather.
  if (shortName) {
    return `https://t.me/${username}/${encodeURIComponent(shortName)}${start ? `?startapp=${encodeURIComponent(start)}` : ''}`;
  }

  // Otherwise use the bot's Main Mini App deep link. This also opens the app
  // directly, but only when a Main Mini App is configured for this bot in BotFather.
  return `https://t.me/${username}${start ? `?startapp=${encodeURIComponent(start)}` : '?startapp'}`;
}

async function getRaffleById(raffleId) {
  const r = await pool.query(
    `SELECT r.*, u.first_name AS creator_first_name, u.username AS creator_username
     FROM raffles r JOIN users u ON u.telegram_id=r.creator_id WHERE r.id=$1`,
    [String(raffleId)]
  );
  return r.rows[0] || null;
}

async function isRaffleChannelSubscribed(raffle, userId) {
  try {
    const member = await telegramApi('getChatMember', {
      chat_id: raffle.channel_id,
      user_id: Number(userId)
    });
    const status = String(member?.status || '').toLowerCase();
    if (['creator', 'administrator', 'member'].includes(status)) return true;
    if (status === 'restricted') return member?.is_member === true;
    return false;
  } catch (e) {
    // The bot must be an administrator to reliably check arbitrary users.
    console.error('Raffle subscription check error:', e.message);
    return false;
  }
}

async function getRaffleDetails(raffleId, userId = null) {
  const row = await getRaffleById(raffleId);
  if (!row) throw new Error('Розыгрыш не найден.');
  const entries = await pool.query(
    `SELECT e.telegram_user_id, e.tickets, e.paid_amount, u.first_name, u.username
     FROM raffle_entries e JOIN users u ON u.telegram_id=e.telegram_user_id
     WHERE e.raffle_id=$1 ORDER BY e.tickets DESC, e.joined_at ASC`,
    [String(raffleId)]
  );
  const winners = await pool.query(
    `SELECT w.place, w.telegram_user_id, w.payout, u.first_name, u.username
     FROM raffle_winners w JOIN users u ON u.telegram_id=w.telegram_user_id
     WHERE w.raffle_id=$1 ORDER BY w.place`,
    [String(raffleId)]
  );
  let mine = null;
  let boostCount = 0;
  let referralLink = '';
  let subscribed = false;
  if (userId) {
    const me = entries.rows.find(e => String(e.telegram_user_id) === String(userId));
    mine = me ? { tickets: Number(me.tickets), paidAmount: Number(me.paid_amount) } : null;
    subscribed = await isRaffleChannelSubscribed(row, userId);
    const bc = await pool.query(`SELECT boost_count FROM raffle_boost_claims WHERE raffle_id=$1 AND telegram_user_id=$2`, [String(raffleId), String(userId)]);
    boostCount = bc.rowCount ? Number(bc.rows[0].boost_count) : 0;
    const bot = await getBotInfoCached().catch(() => null);
    if (bot?.username) referralLink = buildTelegramMiniAppLink(bot.username, `rg_${raffleId}_${userId}`);
  }
  return {
    raffle: rafflePublicRow(row),
    creator: { id: String(row.creator_id), name: row.creator_username ? '@' + row.creator_username : row.creator_first_name },
    entries: entries.rows.map(e => ({ id: String(e.telegram_user_id), name: e.username ? '@' + e.username : e.first_name, tickets: Number(e.tickets), paidAmount: Number(e.paid_amount) })),
    winners: winners.rows.map(w => ({ place: Number(w.place), id: String(w.telegram_user_id), name: w.username ? '@' + w.username : w.first_name, payout: Number(w.payout) })),
    mine,
    boostCount,
    boostUrl: botBoostLink(row.channel_username),
    channelUrl: botChannelLink(row.channel_username),
    subscriptionRequired: true,
    subscribed,
    referralLink
  };
}

function randomWeightedPick(items) {
  const total = items.reduce((s, x) => s + Number(x.tickets || 0), 0);
  if (!total) return null;
  const max = 1_000_000_000;
  const r = Number(BigInt('0x' + crypto.randomBytes(8).toString('hex')) % BigInt(max)) / max;
  let cumulative = 0;
  for (const item of items) {
    cumulative += Number(item.tickets || 0) / total;
    if (r < cumulative) return item;
  }
  return items[items.length - 1];
}

async function finishRaffle(row) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT * FROM raffles WHERE id=$1 FOR UPDATE`, [row.id]);
    if (!current.rowCount || current.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return false;
    }
    const raffle = current.rows[0];
    await client.query(`UPDATE raffles SET status='settling' WHERE id=$1`, [raffle.id]);
    const entries = await client.query(`SELECT telegram_user_id, tickets FROM raffle_entries WHERE raffle_id=$1 AND tickets>0`, [raffle.id]);
    let poolPrize = Number(raffle.prize_pool);
    const available = entries.rows.map(e => ({ id: String(e.telegram_user_id), tickets: Number(e.tickets) }));
    const winnerCount = Math.min(Number(raffle.winners_count), available.length);
    if (!winnerCount) {
      await client.query(`UPDATE users SET balance=(balance+$2::numeric), updated_at=NOW() WHERE telegram_id=$1`, [String(raffle.creator_id), poolPrize]);
      await client.query(`INSERT INTO balance_transactions (telegram_user_id,type,amount,balance_after,description) SELECT telegram_id,'raffle_refund',$2,balance,'Возврат приза: в розыгрыше нет участников' FROM users WHERE telegram_id=$1`, [String(raffle.creator_id), poolPrize]);
      const finalR = await client.query(`SELECT balance::float AS balance FROM users WHERE telegram_id=$1`, [String(raffle.creator_id)]);
      await client.query(`UPDATE raffles SET status='finished', finished_at=NOW() WHERE id=$1`, [raffle.id]);
      await client.query('COMMIT');
      invalidateUserCache(raffle.creator_id);
      io.to(`user:${raffle.creator_id}`).emit('balance_updated', { balance: Number(finalR.rows[0].balance) });
      return true;
    }

    const winners = [];
    for (let place=1; place<=winnerCount; place++) {
      const chosen = randomWeightedPick(available);
      if (!chosen) break;
      available.splice(available.indexOf(chosen), 1);
      winners.push({ id: chosen.id, place });
    }
    const base = Math.floor((poolPrize / winners.length) * 100) / 100;
    let distributed = 0;
    for (let i=0; i<winners.length; i++) {
      const payout = i === winners.length - 1 ? Number((poolPrize - distributed).toFixed(2)) : base;
      distributed = Number((distributed + payout).toFixed(2));
      const updated = await client.query(`UPDATE users SET balance=balance+$2, games_won=games_won, updated_at=NOW() WHERE telegram_id=$1 RETURNING balance::float AS balance`, [winners[i].id, payout]);
      await client.query(`INSERT INTO balance_transactions (telegram_user_id,type,amount,balance_after,description) VALUES ($1,'raffle_prize',$2,$3,$4)`, [winners[i].id,payout,Number(updated.rows[0].balance),`Выигрыш в розыгрыше ${raffle.id}`]);
      await client.query(`INSERT INTO raffle_winners (raffle_id,telegram_user_id,place,payout) VALUES ($1,$2,$3,$4)`, [raffle.id,winners[i].id,winners[i].place,payout]);
      invalidateUserCache(winners[i].id);
    }
    await client.query(`UPDATE raffles SET status='finished', finished_at=NOW() WHERE id=$1`, [raffle.id]);
    await client.query('COMMIT');
    for (const w of winners) {
      const u = await getUser(w.id, { fresh: true }).catch(() => null);
      if (u) io.to(`user:${w.id}`).emit('balance_updated', { balance: Number(u.balance) });
    }

    const publicPrize = Number(raffle.prize_pool);
    const text = `🎁 РОЗЫГРЫШ ЗАВЕРШЁН\n\n🏆 ${raffle.prize_title || 'Stars'} — ${publicPrize.toFixed(2)} ⭐\n👥 Победителей: ${winners.length}`;
    await telegramApi('sendMessage', { chat_id: raffle.channel_id, text }).catch(e => console.error('Raffle result post error:', e.message));
    return true;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('finishRaffle error:', e.message);
    return false;
  } finally {
    client.release();
  }
}

let raffleSettleInFlight = false;
async function settleExpiredRaffles() {
  if (!pool || raffleSettleInFlight) return;
  raffleSettleInFlight = true;
  try {
    const r = await pool.query(`SELECT * FROM raffles WHERE status='active' AND ends_at <= NOW() ORDER BY ends_at ASC LIMIT 10`);
    for (const row of r.rows) await finishRaffle(row);
  } catch (e) {
    console.error('raffle scheduler error:', e.message);
  } finally {
    raffleSettleInFlight = false;
  }
}

async function buildRafflePost(raffle, detailsUrl) {
  const each = raffle.winnersCount > 0 ? Number(raffle.prizePool / raffle.winnersCount) : 0;
  const ticketLine = raffle.type === 'paid' ? `${raffle.ticketPrice.toFixed(2)} ⭐` : 'Бесплатно';
  return [
    '🎁 <b>РОЗЫГРЫШ ПОДАРКОВ</b>',
    '',
    `🏆 Приз: <b>${String(raffle.prizeTitle || 'Stars')}</b>`,
    `💰 Призовой фонд: <b>${raffle.prizePool.toFixed(2)} ⭐</b>`,
    `👥 Победителей: <b>${raffle.winnersCount}</b>`,
    `💎 Каждому: <b>≈ ${each.toFixed(2)} ⭐</b>`,
    `🎟 Билет: <b>${ticketLine}</b>`,
    `⏰ Итоги: <b>${new Date(raffle.endsAt).toLocaleString('ru-RU')}</b>`,
    '',
    'Нажми кнопку ниже, чтобы участвовать.'
  ].join('\n');
}

async function createRaffleForUser(userId, body) {
  requireDatabase();
  const type = body?.type === 'paid' ? 'paid' : 'free';
  const ticketPrice = type === 'paid' ? Number(body?.ticketPrice) : 0;
  const prizePool = Number(body?.prizePool);
  const winnersCount = Number(body?.winnersCount);
  const prizeTitle = String(body?.prizeTitle || 'Stars').trim().slice(0, 100) || 'Stars';
  const endsAt = new Date(body?.endsAt);

  if (!Number.isFinite(prizePool) || prizePool <= 0) throw new Error('Укажи сумму приза больше 0.');
  if (!Number.isInteger(winnersCount) || winnersCount <= 0 || winnersCount > 1000) throw new Error('Укажи количество победителей от 1 до 1000.');
  if (type === 'paid' && (!Number.isFinite(ticketPrice) || ticketPrice <= 0)) throw new Error('Укажи цену билета больше 0.');
  if (!(endsAt instanceof Date) || Number.isNaN(endsAt.getTime()) || endsAt.getTime() < Date.now() + 60_000) throw new Error('Время окончания должно быть минимум через 1 минуту.');
  if (prizePool > 1_000_000_000 || ticketPrice > 1_000_000_000) throw new Error('Слишком большая сумма.');

  const verified = await verifyRaffleChannel(body?.channel, userId);
  const creator = await getUser(userId, { fresh: true });
  if (!creator) throw new Error('Пользователь не найден.');

  const client = await pool.connect();
  let raffle;
  try {
    await client.query('BEGIN');
    const debit = await client.query(`UPDATE users SET balance=(balance-$2::numeric), updated_at=NOW() WHERE telegram_id=$1 AND banned=false AND balance >= $2::numeric RETURNING balance::float AS balance`, [String(userId), prizePool]);
    if (!debit.rowCount) {
      const missing = Math.max(0, Number((prizePool - Number(creator.balance)).toFixed(2)));
      throw Object.assign(new Error('Недостаточно Stars на балансе.'), { code: 'INSUFFICIENT_FUNDS', missing, balance: Number(creator.balance) });
    }
    const id = crypto.randomUUID();
    const balanceAfter = Number(debit.rows[0].balance);
    await client.query(`INSERT INTO balance_transactions (telegram_user_id,type,amount,balance_after,description) VALUES ($1,'raffle_create',$2,$3,$4)`, [String(userId), -prizePool, balanceAfter, `Создание розыгрыша ${id}`]);
    const r = await client.query(
      `INSERT INTO raffles (id,creator_id,raffle_type,ticket_price,prize_pool,prize_title,winners_count,ends_at,channel_id,channel_username,channel_title)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id,String(userId),type,ticketPrice,prizePool,prizeTitle,winnersCount,endsAt, String(verified.chat.id), verified.username, verified.chat.title || verified.username]
    );
    raffle = r.rows[0];
    await client.query('COMMIT');
    invalidateUserCache(userId);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally { client.release(); }

  const pub = rafflePublicRow(raffle);
  try {
    const base = String(process.env.APP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
    if (!base) throw new Error('APP_PUBLIC_URL/RENDER_EXTERNAL_URL не настроен.');
    const bot = await getBotInfoCached();
    const detailsUrl = `${base}/?raffle=${encodeURIComponent(raffle.id)}`;
    const miniAppLink = bot?.username ? buildTelegramMiniAppLink(bot.username, `raffle_${raffle.id}`) : detailsUrl;
    const text = await buildRafflePost(pub, detailsUrl);
    const sent = await telegramApi('sendMessage', {
      chat_id: verified.chat.id,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '🎁 УЧАСТВОВАТЬ', url: miniAppLink }]] }
    });
    await pool.query(`UPDATE raffles SET post_message_id=$2 WHERE id=$1`, [raffle.id, Number(sent.message_id)]);
    pub.postMessageId = Number(sent.message_id);
  } catch (e) {
    // If posting failed, refund the locked prize pool so a broken Telegram permission never burns the creator's balance.
    const refund = await pool.connect();
    try {
      await refund.query('BEGIN');
      const rr = await refund.query(`UPDATE users SET balance=(balance+$2::numeric), updated_at=NOW() WHERE telegram_id=$1 RETURNING balance::float AS balance`, [String(userId), prizePool]);
      if (rr.rowCount) {
        await refund.query(`INSERT INTO balance_transactions (telegram_user_id,type,amount,balance_after,description) VALUES ($1,'raffle_refund',$2,$3,$4)`, [String(userId),prizePool,Number(rr.rows[0].balance),`Возврат: не удалось опубликовать розыгрыш ${raffle.id}`]);
      }
      await refund.query(`UPDATE raffles SET status='cancelled' WHERE id=$1`, [raffle.id]);
      await refund.query('COMMIT');
      invalidateUserCache(userId);
    } catch (refundError) { try { await refund.query('ROLLBACK'); } catch {} console.error('Raffle refund error:', refundError.message); }
    finally { refund.release(); }
    throw new Error(`Не удалось опубликовать розыгрыш в канале: ${e.message}`);
  }

  return { raffle: pub, balance: await getBalance(userId) };
}

async function requireRaffleSubscription(userId, raffle) {
  const subscribed = await isRaffleChannelSubscribed(raffle, userId);
  if (!subscribed) {
    throw Object.assign(new Error('Сначала подпишись на канал розыгрыша.'), { code: 'RAFFLE_SUBSCRIPTION_REQUIRED' });
  }
}

async function joinRaffle(userId, raffleId, startParam = '') {
  requireDatabase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rr = await client.query(`SELECT * FROM raffles WHERE id=$1 FOR UPDATE`, [String(raffleId)]);
    if (!rr.rowCount) throw new Error('Розыгрыш не найден.');
    const raffle = rr.rows[0];
    if (raffle.status !== 'active' || new Date(raffle.ends_at).getTime() <= Date.now()) throw new Error('Розыгрыш уже завершён.');
    await requireRaffleSubscription(userId, raffle);
    const existing = await client.query(`SELECT tickets, paid_amount FROM raffle_entries WHERE raffle_id=$1 AND telegram_user_id=$2 FOR UPDATE`, [String(raffleId),String(userId)]);
    if (existing.rowCount) throw new Error('Ты уже участвуешь в этом розыгрыше.');
    let paid = 0;
    if (raffle.raffle_type === 'paid') {
      paid = Number(raffle.ticket_price);
      const deb = await client.query(`UPDATE users SET balance=(balance-$2::numeric), updated_at=NOW() WHERE telegram_id=$1 AND banned=false AND balance >= $2::numeric RETURNING balance::float AS balance`, [String(userId),paid]);
      if (!deb.rowCount) {
        const u = await client.query(`SELECT balance::float AS balance FROM users WHERE telegram_id=$1`, [String(userId)]);
        const current = u.rowCount ? Number(u.rows[0].balance) : 0;
        const missing = Math.max(0, Number((paid-current).toFixed(2)));
        throw Object.assign(new Error('Недостаточно Stars для билета.'), { code:'INSUFFICIENT_FUNDS', missing, balance: current });
      }
      await client.query(`INSERT INTO balance_transactions (telegram_user_id,type,amount,balance_after,description) SELECT $1,'raffle_ticket',-$2,balance,$3 FROM users WHERE telegram_id=$1`, [String(userId),paid,`Билет в розыгрыш ${raffleId}`]);
      const creatorCredit = await client.query(`UPDATE users SET balance=(balance+$2::numeric), updated_at=NOW() WHERE telegram_id=$1 RETURNING balance::float AS balance`, [String(raffle.creator_id),paid]);
      if (creatorCredit.rowCount) {
        await client.query(`INSERT INTO balance_transactions (telegram_user_id,type,amount,balance_after,description) VALUES ($1,'raffle_ticket_income',$2,$3,$4)`, [String(raffle.creator_id),paid,Number(creatorCredit.rows[0].balance),`Оплата билета в розыгрыше ${raffleId}`]);
      }
    }
    await client.query(`INSERT INTO raffle_entries (raffle_id,telegram_user_id,tickets,paid_amount) VALUES ($1,$2,1,$3)`, [String(raffleId),String(userId),paid]);

    const ref = parseRaffleStartParam(startParam);
    if (ref && ref.raffleId === String(raffleId) && ref.referrerId !== String(userId)) {
      const refExists = await client.query(`SELECT 1 FROM raffle_referrals WHERE raffle_id=$1 AND referred_user_id=$2`, [String(raffleId),String(userId)]);
      if (!refExists.rowCount) {
        const refOwner = await client.query(`SELECT 1 FROM users WHERE telegram_id=$1`, [String(ref.referrerId)]);
        if (refOwner.rowCount) {
          await client.query(`INSERT INTO raffle_referrals (raffle_id,referrer_id,referred_user_id) VALUES ($1,$2,$3)`, [String(raffleId),String(ref.referrerId),String(userId)]);
          await client.query(`INSERT INTO raffle_entries (raffle_id,telegram_user_id,tickets,paid_amount) VALUES ($1,$2,1,0) ON CONFLICT (raffle_id,telegram_user_id) DO UPDATE SET tickets=(raffle_entries.tickets+1::integer)`, [String(raffleId),String(ref.referrerId)]);
        }
      }
    }

    await client.query('COMMIT');
    invalidateUserCache(userId);
    const userRow = await getUser(userId,{fresh:true});
    if (userRow) io.to(`user:${userId}`).emit('balance_updated', { balance: Number(userRow.balance) });
    return { balance: userRow ? Number(userRow.balance) : 0 };
  } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
  finally { client.release(); }
}

async function checkRaffleBoost(userId, raffleId) {
  const raffle = await getRaffleById(raffleId);
  if (!raffle) throw new Error('Розыгрыш не найден.');
  if (raffle.status !== 'active') throw new Error('Розыгрыш уже завершён.');
  try {
    const result = await telegramApi('getUserChatBoosts', { chat_id: raffle.channel_id, user_id: Number(userId) });
    const boosts = Array.isArray(result?.boosts) ? result.boosts : [];
    const now = Math.floor(Date.now()/1000);
    const activeBoosts = boosts.filter(b => !b.expires || Number(b.expires) > now);
    const count = activeBoosts.length;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const old = await client.query(`SELECT boost_count FROM raffle_boost_claims WHERE raffle_id=$1 AND telegram_user_id=$2 FOR UPDATE`, [String(raffleId),String(userId)]);
      const claimed = old.rowCount ? Number(old.rows[0].boost_count) : 0;
      const delta = Math.max(0, count - claimed);
      if (delta > 0) {
        await client.query(`INSERT INTO raffle_entries (raffle_id,telegram_user_id,tickets,paid_amount) VALUES ($1,$2,$3,0) ON CONFLICT (raffle_id,telegram_user_id) DO UPDATE SET tickets=(raffle_entries.tickets+$3::integer)`, [String(raffleId),String(userId),delta]);
      }
      await client.query(`INSERT INTO raffle_boost_claims (raffle_id,telegram_user_id,boost_count) VALUES ($1,$2,$3) ON CONFLICT (raffle_id,telegram_user_id) DO UPDATE SET boost_count=EXCLUDED.boost_count, claimed_at=NOW()`, [String(raffleId),String(userId),count]);
      await client.query('COMMIT');
      return { boosts: count, newTickets: delta };
    } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; } finally { client.release(); }
  } catch (e) {
    if (/CHAT_ADMIN_REQUIRED|FORBIDDEN|not enough rights/i.test(e.message || '')) throw new Error('Бот должен быть администратором канала с правом управления бустами.');
    throw new Error(`Не удалось проверить буст: ${e.message}`);
  }
}

function buildMiniAppOpenUrl(refCode = "") {
  const base = String(process.env.APP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  if (!base) return "";
  const ref = String(refCode || "").trim();
  return ref ? `${base}/?ref=${encodeURIComponent(ref)}` : base;
}

async function configureTelegramBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn("Telegram bot is not configured: TELEGRAM_BOT_TOKEN is missing.");
    return;
  }

  let botInfo = null;
  try {
    botInfo = await getBotInfoCached();
    console.log(`Telegram bot connected: @${normalizeBotUsername(botInfo?.username) || 'UNKNOWN'}`);
    if (!normalizeBotUsername(botInfo?.username)) {
      console.warn('Telegram getMe returned no valid username; Mini App deep links cannot be generated.');
    }
  } catch (e) {
    console.error('Telegram getMe error:', e.message);
  }

  const appUrl = buildMiniAppOpenUrl();
  if (!appUrl) {
    console.warn("Telegram webhook is not configured: APP_PUBLIC_URL/RENDER_EXTERNAL_URL is missing.");
    return;
  }

  const webhookUrl = `${appUrl}/api/telegram/webhook`;
  const rawSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || "");
  // Telegram only accepts 1-256 chars of A-Z a-z 0-9 _ - in secret_token.
  // An invalid value used to make the whole setup call throw, which also
  // skipped registering /start and the menu button below.
  const secret = activeWebhookSecret();
  if (rawSecret && !secret) {
    console.warn("TELEGRAM_WEBHOOK_SECRET содержит недопустимые символы (разрешены A-Z a-z 0-9 _ -); вебхук будет настроен без secret_token.");
  }

  try {
    await telegramApi("setWebhook", {
      url: webhookUrl,
      ...(secret ? { secret_token: secret } : {}),
      allowed_updates: ["message", "pre_checkout_query", "callback_query"],
      drop_pending_updates: false
    });

    await telegramApi("setMyCommands", {
      commands: [
        { command: "start", description: "Открыть приложение" },
        { command: "help", description: "Помощь" }
      ]
    });

    await telegramApi("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "Розыгрыши",
        web_app: { url: appUrl }
      }
    });

    console.log(`Telegram webhook configured: ${webhookUrl}`);
  } catch (e) {
    console.error("Telegram setup error:", e.message);
  }
}

async function verifyTelegramWebhook() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  try {
    const info = await telegramApi("getWebhookInfo", {});
    console.log(`Telegram webhook: ${info.url || "NOT_SET"}${info.last_error_message ? ` | last error: ${info.last_error_message}` : ""}`);
  } catch (e) {
    console.error("Telegram webhook check error:", e.message);
  }
}

async function handleTelegramStart(message) {
  if (!message?.chat?.id) return;

  const text = String(message.text || "").trim();
  const match = text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  const parameter = match?.[1] ? String(match[1]).trim() : "";
  const appUrl = buildMiniAppOpenUrl(parameter);

  // Reply to /start first. A slow DB operation must never make the bot look dead.
  try {
    await telegramApi("sendMessage", {
      chat_id: message.chat.id,
      text: appUrl
        ? "🎮 Добро пожаловать в RING PVP!\n\nНажми кнопку ниже, чтобы открыть игру."
        : "🎮 Добро пожаловать в RING PVP!\n\nПриложение пока не настроено: администратору нужно указать APP_PUBLIC_URL на Render.",
      reply_markup: appUrl ? {
        inline_keyboard: [[{
          text: "🚀 ЗАЙТИ В ПРИЛОЖЕНИЕ",
          web_app: { url: appUrl }
        }]]
      } : undefined
    });
  } catch (e) {
    console.error("Telegram /start reply error:", e.message);
  }

  // Track the user after the reply so referral/database problems do not block /start.
  if (message.from?.id) {
    try {
      await upsertUser({
        id: String(message.from.id),
        username: String(message.from.username || ""),
        first_name: safeName(message.from.first_name || "Игрок"),
        photo_url: ""
      }, parameter);
    } catch (e) {
      console.error("Telegram /start user sync error:", e.message);
    }
  }
}

async function handleTelegramHelp(message) {
  if (!message?.chat?.id) return;
  const appUrl = buildMiniAppOpenUrl();
  await telegramApi("sendMessage", {
    chat_id: message.chat.id,
    text: "🎮 RING PVP\n\nОткрывай приложение кнопкой ниже.",
    reply_markup: appUrl ? {
      inline_keyboard: [[{
        text: "🚀 ЗАЙТИ В ПРИЛОЖЕНИЕ",
        web_app: { url: appUrl }
      }]]
    } : undefined
  });
}

function activeWebhookSecret() {
  const raw = String(process.env.TELEGRAM_WEBHOOK_SECRET || "");
  return /^[A-Za-z0-9_-]{1,256}$/.test(raw) ? raw : "";
}

async function handleWithdrawalCallback(callback) {
  const adminId = String(callback?.from?.id || "");
  const match = String(callback?.data || "").match(/^withdraw:(approve|decline|reject-empty):(\d+)$/);
  if (!match) return false;
  if (!isAdmin(adminId)) {
    await answerCallbackQuery(callback.id, "Нет доступа.");
    return true;
  }

  const [, action, requestId] = match;
  try {
    if (action === "approve") {
      const withdrawal = await completeWithdrawal(requestId, adminId);
      await notifyWithdrawalCompleted(withdrawal);
      await answerCallbackQuery(callback.id, "Вывод подтверждён.");
      await telegramApi("editMessageReplyMarkup", {
        chat_id: callback.message?.chat?.id,
        message_id: callback.message?.message_id,
        reply_markup: { inline_keyboard: [] }
      }).catch(() => {});
      return true;
    }

    if (action === "decline") {
      await requestWithdrawalDeclineReason(requestId, adminId);
      await answerCallbackQuery(callback.id, "Укажите причину отказа.");
      await telegramApi("sendMessage", {
        chat_id: adminId,
        text: `Напишите причину отклонения заявки №${requestId} одним сообщением.`,
        reply_markup: {
          inline_keyboard: [[{
            text: "Отклонить без объяснения причин",
            callback_data: `withdraw:reject-empty:${requestId}`
          }]]
        }
      });
      return true;
    }

    const withdrawal = await rejectWithdrawal(requestId, adminId);
    await notifyWithdrawalRejected(withdrawal);
    await answerCallbackQuery(callback.id, "Заявка отклонена, средства возвращены.");
    return true;
  } catch (e) {
    await answerCallbackQuery(callback.id, e.message || "Не удалось обработать заявку.");
    return true;
  }
}

async function handleWithdrawalDeclineReason(message) {
  const adminId = String(message?.from?.id || "");
  const text = String(message?.text || "").trim();
  if (!isAdmin(adminId) || !text || text.startsWith("/")) return false;
  requireDatabase();
  const pending = await pool.query(
    `SELECT id FROM withdrawal_requests
     WHERE status='decline_reason_pending' AND reviewed_by=$1
     ORDER BY created_at DESC LIMIT 1`,
    [adminId]
  );
  if (!pending.rowCount) return false;

  const withdrawal = await rejectWithdrawal(pending.rows[0].id, adminId, text);
  await notifyWithdrawalRejected(withdrawal);
  await telegramApi("sendMessage", {
    chat_id: adminId,
    text: `Заявка №${withdrawal.id} отклонена. Средства возвращены пользователю.`
  });
  return true;
}

app.post("/api/telegram/webhook", async (req, res) => {
  const expectedSecret = activeWebhookSecret();
  if (expectedSecret && req.headers["x-telegram-bot-api-secret-token"] !== expectedSecret) {
    return res.status(401).end();
  }
  if (!process.env.TELEGRAM_BOT_TOKEN) return res.status(503).json({ ok: false });

  try {
    const update = req.body || {};

    if (update.callback_query) {
      res.json({ ok: true, handled: "callback" });
      setImmediate(() => handleWithdrawalCallback(update.callback_query).catch(e => console.error("Withdrawal callback error:", e.message)));
      return;
    }

    const incomingMessage = update.message;
    const incomingText = String(incomingMessage?.text || "").trim();

    if (/^\/start(?:@\w+)?(?:\s+.+)?$/i.test(incomingText)) {
      res.json({ ok: true, handled: "start" });
      setImmediate(() => handleTelegramStart(incomingMessage).catch(e => console.error("Telegram /start async error:", e.message)));
      return;
    }

    if (/^\/help(?:@\w+)?$/i.test(incomingText)) {
      res.json({ ok: true, handled: "help" });
      setImmediate(() => handleTelegramHelp(incomingMessage).catch(e => console.error("Telegram /help async error:", e.message)));
      return;
    }

    if (incomingMessage?.text && isAdmin(incomingMessage.from?.id)) {
      const handled = await handleWithdrawalDeclineReason(incomingMessage);
      if (handled) return res.json({ ok: true, handled: "withdrawal_decline_reason" });
    }

    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      let ok = false;
      try {
        const payload = JSON.parse(q.invoice_payload || "{}");
        ok = payload.type === "balance_topup"
          && String(payload.userId) === String(q.from?.id)
          && Number(payload.amount) === Number(q.total_amount)
          && q.currency === "XTR";
      } catch {}

      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerPreCheckoutQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pre_checkout_query_id: q.id,
          ok,
          ...(ok ? {} : { error_message: "Платёж недействителен." })
        })
      });
      return res.json({ ok: true });
    }

    const payment = update.message?.successful_payment;
    const tgUser = update.message?.from;
    if (payment && tgUser) {
      let payload;
      try { payload = JSON.parse(payment.invoice_payload || "{}"); }
      catch { return res.status(400).json({ ok: false }); }

      if (payload.type !== "balance_topup"
        || String(payload.userId) !== String(tgUser.id)
        || payment.currency !== "XTR") {
        return res.status(400).json({ ok: false });
      }

      requireDatabase();
      const chargeId = payment.telegram_payment_charge_id;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const exists = await client.query(`SELECT 1 FROM payments WHERE telegram_payment_charge_id=$1 FOR UPDATE`, [chargeId]);
        if (!exists.rowCount) {
          await client.query(
            `INSERT INTO users (telegram_id, username, first_name)
             VALUES ($1,$2,$3) ON CONFLICT (telegram_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, updated_at=NOW()`,
            [String(tgUser.id), tgUser.username || "", tgUser.first_name || "Игрок"]
          );
          const r = await client.query(
            `UPDATE users SET balance=(balance+$2::numeric), updated_at=NOW() WHERE telegram_id=$1 RETURNING balance::float AS balance`,
            [String(tgUser.id), Number(payment.total_amount)]
          );
          const balanceAfter = Number(r.rows[0].balance);
          await client.query(
            `INSERT INTO balance_transactions
             (telegram_user_id, type, amount, balance_after, description)
             VALUES ($1,'stars_topup',$2,$3,$4)`,
            [String(tgUser.id), Number(payment.total_amount), balanceAfter, `Пополнение Telegram Stars, ${chargeId}`]
          );
          await client.query(
            `INSERT INTO payments (telegram_payment_charge_id, telegram_user_id, amount, payload)
             VALUES ($1,$2,$3,$4)`,
            [chargeId, String(tgUser.id), Number(payment.total_amount), payment.invoice_payload]
          );
          // Referral reward is accrued as PENDING and is not added to the referrer's
          // spendable balance until they press "ЗАБРАТЬ".
          const refRow = await client.query(
            `SELECT referred_by FROM users WHERE telegram_id=$1`,
            [String(tgUser.id)]
          );
          const referrerId = refRow.rows[0]?.referred_by ? String(refRow.rows[0].referred_by) : null;
          if (referrerId && referrerId !== String(tgUser.id)) {
            const reward = Number((Number(payment.total_amount) * 0.10).toFixed(2));
            await client.query(
              `INSERT INTO referral_earnings
               (referrer_id, referred_user_id, telegram_payment_charge_id, deposit_amount, reward_amount)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (telegram_payment_charge_id) DO NOTHING`,
              [referrerId, String(tgUser.id), chargeId, Number(payment.total_amount), reward]
            );
          }
          await client.query("COMMIT");
          io.to(`user:${tgUser.id}`).emit("balance_updated", { balance: balanceAfter });
          return res.json({ ok: true, credited: true });
        }
        await client.query("COMMIT");
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch {}
        throw e;
      } finally {
        client.release();
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("Telegram webhook error:", e.message);
    res.status(500).json({ ok: false });
  }
});


// Fast initial bootstrap: one authenticated DB read for balance + profile basics.
app.get("/api/bootstrap", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    res.json({
      user: session.db,
      isAdmin: isAdmin(session.telegram.id),
      state: publicState(),
      gramUsdPerStar: Number(process.env.GRAM_USD_PER_STAR || 0.015)
    });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// ---------------- PROFILE / REFERRALS ----------------
function appPublicUrl() {
  return String(process.env.APP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
}

function buildReferralLink(userId) {
  const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "").trim();
  if (!botUsername) return "";

  // Referral links always open the private chat with the bot.
  // The bot receives /start ref_<userId>, then sends the user a button
  // that opens the Mini App. This guarantees the referral is registered
  // before the user enters the app.
  return `https://t.me/${botUsername}?start=ref_${encodeURIComponent(String(userId))}`;
}

app.get("/api/profile", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const user = session.db;
    const r = await pool.query(
      `SELECT
         COUNT(DISTINCT referred_user_id)::int AS invited,
         COALESCE(SUM(reward_amount),0)::float AS total_earned,
         COALESCE(SUM(reward_amount) FILTER (WHERE claimed=false),0)::float AS pending,
         COALESCE(SUM(reward_amount) FILTER (WHERE claimed=true),0)::float AS claimed
       FROM referral_earnings
       WHERE referrer_id=$1`,
      [String(user.telegram_id)]
    );
    const s = r.rows[0] || {};
    const gamesPlayed = Number(user.games_played || 0);
    const gamesWon = Number(user.games_won || 0);
    res.json({
      user: { id: user.telegram_id, username: user.username, first_name: user.first_name, avatar_url: user.avatar_url, balance: Number(user.balance || 0) },
      stats: { gamesPlayed, gamesWon, winrate: gamesPlayed ? Number(((gamesWon / gamesPlayed) * 100).toFixed(2)) : 0, totalWagered: Number(user.total_wagered || 0) },
      referral: {
        invited: Number(s.invited || 0), totalEarned: Number(s.total_earned || 0), pending: Number(s.pending || 0), claimed: Number(s.claimed || 0), percent: 10, link: buildReferralLink(user.telegram_id)
      }
    });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.post("/api/profile/promo/redeem", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const result = await redeemPromoCode(session.telegram.id, req.body?.code);
    io.to(`user:${session.telegram.id}`).emit("balance_updated", { balance: result.balance });
    res.json({ ok: true, code: result.code, bonus: result.bonus, wager: result.wager, balance: result.balance });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/gram/topup-config", async (req, res) => {
  try {
    await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const recipient = String(
      process.env.TON_TOPUP_WALLET_ADDRESS ||
      process.env.TON_CONNECT_WALLET_ADDRESS ||
      (!String(process.env.TON_CONNECT || "").trim().startsWith("http") ? String(process.env.TON_CONNECT || "") : "")
    ).trim();
    // Accept "0,001" as well as "0.001" (a common paste mistake), and ignore
    // stray surrounding whitespace/newlines from copy-pasting into Render.
    const tonPerStarRaw = String(process.env.TON_PER_STAR || "").trim().replace(",", ".");
    const tonPerStar = Number(tonPerStarRaw);
    if (!recipient && (!tonPerStarRaw || !(tonPerStar > 0))) {
      return res.status(503).json({ error: "На Render не заданы TON_TOPUP_WALLET_ADDRESS и TON_PER_STAR (или сервис не передеплоен после их добавления)." });
    }
    if (!recipient) {
      return res.status(503).json({ error: "На Render не задан TON_TOPUP_WALLET_ADDRESS (или сервис не передеплоен после его добавления)." });
    }
    if (!tonPerStarRaw || !(tonPerStar > 0)) {
      return res.status(503).json({ error: "TON_PER_STAR на Render пуст или не является числом больше нуля (проверьте, не запятая ли вместо точки)." });
    }
    res.json({ recipient, tonPerStar });
  } catch (e) {
    res.status(401).json({ error: e.message || "Авторизация не выполнена." });
  }
});

app.post("/api/gram/topup-intent", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const amount = Number(req.body?.amount);
    const tonPerStar = Number(String(process.env.TON_PER_STAR || "").trim().replace(",", "."));
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Введите целую сумму Stars больше 0.");
    if (!(tonPerStar > 0)) throw new Error("TON_PER_STAR не настроен.");

    const id = crypto.randomUUID();
    const comment = `RING:${id}`;
    const expectedNanoTon = Math.round(amount * tonPerStar * 1e9);
    if (!Number.isSafeInteger(expectedNanoTon) || expectedNanoTon <= 0) throw new Error("Сумма TON некорректна.");
    await pool.query(
      `INSERT INTO ton_topup_intents (id, telegram_user_id, expected_nano_ton, stars, comment)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, String(session.telegram.id), String(expectedNanoTon), amount, comment]
    );
    const payload = beginCell().storeUint(0, 32).storeStringTail(comment).endCell().toBoc().toString("base64");
    res.json({ ok: true, payload, comment });
  } catch (e) {
    res.status(400).json({ error: e.message || "Не удалось подготовить TON-пополнение." });
  }
});

function tonMessageComment(message) {
  const decoded = message?.message_content?.decoded || message?.decoded || {};
  return String(decoded.text || decoded.comment || "").trim();
}

async function settleTonTopups() {
  if (!pool || !process.env.TONAPI_KEY) return;
  const recipient = String(process.env.TON_TOPUP_WALLET_ADDRESS || process.env.TON_CONNECT_WALLET_ADDRESS || "").trim();
  if (!recipient) return;
  try {
    const response = await fetch(`https://tonapi.io/v2/blockchain/accounts/${encodeURIComponent(recipient)}/transactions?limit=50`, {
      headers: { Authorization: `Bearer ${process.env.TONAPI_KEY}` }
    });
    if (!response.ok) throw new Error(`TonAPI ${response.status}`);
    const data = await response.json();
    for (const transaction of data.transactions || []) {
      const comment = tonMessageComment(transaction.in_msg);
      if (!/^RING:[0-9a-f-]{36}$/i.test(comment)) continue;
      const hash = String(transaction.hash || transaction.transaction_id?.hash || "");
      const value = BigInt(String(transaction.in_msg?.value || "0"));
      if (!hash || value <= 0n) continue;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const intent = await client.query(
          `SELECT * FROM ton_topup_intents WHERE comment=$1 AND status='pending' FOR UPDATE`,
          [comment]
        );
        if (!intent.rowCount || value < BigInt(intent.rows[0].expected_nano_ton)) {
          await client.query("ROLLBACK");
          continue;
        }
        const row = intent.rows[0];
        const balance = await creditBalance(row.telegram_user_id, Number(row.stars), client, {
          type: "ton_topup",
          description: `Автопополнение TON, транзакция ${hash}`
        });
        await client.query(
          `UPDATE ton_topup_intents SET status='credited', transaction_hash=$2, credited_at=NOW() WHERE id=$1`,
          [row.id, hash]
        );
        await client.query("COMMIT");
        io.to(`user:${row.telegram_user_id}`).emit("balance_updated", { balance });
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch {}
        console.error("TON top-up settlement error:", e.message);
      } finally {
        client.release();
      }
    }
  } catch (e) {
    console.error("TON top-up polling error:", e.message);
  }
}

// ---------------------------------------------------------------------------
// TODO: AUTOMATIC TON TOP-UPS (currently manual — admin approves by hand)
// ---------------------------------------------------------------------------
// Right now this endpoint only WRITES a 'topup_pending' request row and pings
// the admin in Telegram — a human has to see the on-chain payment and credit
// the user manually. To make this fully automatic, add a background poller
// that watches TON_TOPUP_WALLET_ADDRESS for incoming transactions and credits
// balances itself, no admin step needed. Rough plan:
//
// 1. Give every user a way to be identified from their transaction alone.
//    TON lets you attach a short text "comment" to a transfer. When a user
//    starts a top-up, generate/show them a comment to paste, e.g. their own
//    telegram_id ("UID12345678"), OR (cleaner) have the TonConnect transfer
//    include that comment automatically in its payload — no manual typing.
//
// 2. Add a small table to remember which on-chain transactions we already
//    credited, so we never double-credit on a re-poll:
//      CREATE TABLE IF NOT EXISTS ton_deposits (
//        tx_hash TEXT PRIMARY KEY,
//        telegram_user_id TEXT NOT NULL,
//        amount_ton NUMERIC NOT NULL,
//        stars_credited INTEGER NOT NULL,
//        created_at TIMESTAMPTZ DEFAULT NOW()
//      );
//
// 3. Every N seconds (setInterval, e.g. 20–30s), call a TON indexer API for
//    TON_TOPUP_WALLET_ADDRESS's recent incoming transactions — e.g.
//    TonCenter: GET https://toncenter.com/api/v2/getTransactions?address=...
//    or TonAPI:  GET https://tonapi.io/v2/blockchain/accounts/{address}/transactions
//    (both need a free API key for reasonable rate limits — add as
//    TONCENTER_API_KEY / TONAPI_KEY env vars).
//
// 4. For each NEW incoming transaction (hash not yet in ton_deposits):
//      - Read the TON amount and the attached comment.
//      - Extract the telegram_user_id from the comment (parse "UID<digits>").
//      - If no match, skip it (leave for manual review — could be a stray
//        transfer) and maybe notifyAdmins() so nothing silently gets lost.
//      - stars = amount_ton / tonPerStar  (tonPerStar = TON_PER_STAR env var,
//        same conversion rate already used above for the manual flow).
//      - Insert the tx_hash into ton_deposits FIRST (or in the same DB
//        transaction as the credit) so a crash/restart mid-poll can't
//        double-credit the same transaction on the next poll.
//      - await creditBalance(telegram_user_id, Math.floor(stars), pool, {
//          type: "ton_topup", description: `TON пополнение ${amount_ton} TON`
//        });
//      - Optionally io.to(`user:${telegram_user_id}`).emit("balance_updated", ...)
//        so the app updates live without a page refresh.
//
// 5. Start the poller once at server boot (near the bottom of this file,
//    alongside the other setInterval-based background jobs), guarded so it
//    only runs when TON_TOPUP_WALLET_ADDRESS/TON_PER_STAR are actually set.
//
// This is a genuine integration (needs a real TON API key + live testing
// against real transactions), so it's left as this outline rather than an
// unverified implementation — ask and it can be built out for real.
// ---------------------------------------------------------------------------
app.post("/api/gram/topup-request", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const userId = session.telegram.id;
    const amount = Number(req.body?.amount);
    const wallet = String(req.body?.wallet || "").trim();
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Введите целую сумму Stars больше 0.");
    if (!wallet) throw new Error("TON Connect кошелёк не найден.");

    const gramUsdPerStar = Number(process.env.GRAM_USD_PER_STAR || 0.015);
    const usd = amount * gramUsdPerStar;
    await pool.query(
      `INSERT INTO withdrawal_requests (telegram_user_id, currency, amount, wallet_address, status)
       VALUES ($1,'GRAM',$2,$3,'topup_pending')`,
      [String(userId), amount, wallet]
    );

    const displayName = session.telegram.username ? `@${session.telegram.username}` : session.telegram.first_name;
    notifyAdmins(
      `💎 Новая заявка на пополнение GRAM\n` +
      `Пользователь: ${displayName} (ID: ${userId})\n` +
      `Сумма заявки: ${amount} ⭐\n` +
      `Эквивалент: ≈ $${usd.toFixed(2)}\n` +
      `TON кошелёк: ${wallet}`
    ).catch(() => {});

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || "Не удалось создать заявку." });
  }
});

app.post("/api/profile/withdraw", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const userId = session.telegram.id;
    const currency = String(req.body?.currency || "STAR").trim().toUpperCase();
    const amount = Number(req.body?.amount);
    const wallet = String(req.body?.wallet || "").trim();

    if (!["STAR", "GRAM"].includes(currency)) throw new Error("Вывод доступен только в Stars или GRAM.");
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Введите целую сумму Stars больше 0.");
    if (amount < 100) throw new Error("Вывод доступен от 100 звёзд.");
    if (currency === "GRAM" && !wallet) throw new Error("Для вывода GRAM укажите кошелёк.");

    // A promo bonus with a wager requirement locks withdrawals until the
    // player has staked (bet, win or lose — PVP and/or Upgrade) that much
    // total volume. It's cleared automatically once the balance hits 0.
    const wagerRow = await pool.query(`SELECT wager_remaining::float AS w FROM users WHERE telegram_id=$1`, [String(userId)]);
    const wagerRemaining = Number(wagerRow.rows[0]?.w || 0);
    if (wagerRemaining > 0) {
      throw new Error(`Сначала нужно отыграть бонус по промокоду: осталось поставить ${wagerRemaining.toFixed(2)} ⭐.`);
    }

    const gramUsdPerStar = Number(process.env.GRAM_USD_PER_STAR || 0.015);
    const gramUsd = currency === "GRAM" ? amount * gramUsdPerStar : null;
    const description = currency === "GRAM"
      ? `Заявка на вывод ${amount} ⭐ → GRAM (≈ $${gramUsd.toFixed(2)}), кошелёк ${wallet}`
      : `Заявка на вывод ${amount} ⭐ → Telegram Stars`;

    const balanceAfter = await debitBalance(userId, amount, {
      type: "withdraw_request",
      description
    });

    const ins = await pool.query(
      `INSERT INTO withdrawal_requests (telegram_user_id, currency, amount, wallet_address)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [String(userId), currency, amount, wallet]
    );

    const displayName = session.telegram.username
      ? `@${session.telegram.username}`
      : session.telegram.first_name;

    notifyWithdrawalAdmins(
      `📤 Новая заявка на вывод\n` +
      `Пользователь: ${displayName} (ID: ${userId})\n` +
      `Направление: ${currency === "GRAM" ? "GRAM" : "Telegram Stars"}\n` +
      `Сумма списания: ${amount} ⭐\n` +
      (currency === "GRAM" ? `Эквивалент: ≈ $${gramUsd.toFixed(2)}\nTON / GRAM кошелёк: ${wallet}\n` : "") +
      `Заявка №${ins.rows[0].id}`,
      ins.rows[0].id
    ).catch(() => {});

    io.to(`user:${userId}`).emit("balance_updated", { balance: balanceAfter });
    res.json({ ok: true, balance: balanceAfter, requestId: ins.rows[0].id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/profile/referrals/claim", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const userId = String(session.telegram.id);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const rows = await client.query(
        `SELECT id, reward_amount::float AS reward_amount
         FROM referral_earnings
         WHERE referrer_id=$1 AND claimed=false
         ORDER BY id
         FOR UPDATE`,
        [userId]
      );

      const amount = Number(rows.rows.reduce((sum, r) => sum + Number(r.reward_amount || 0), 0).toFixed(2));
      if (amount <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Пока нет доступных реферальных начислений." });
      }

      const userRow = await client.query(
        `UPDATE users
         SET balance=balance+$2, updated_at=NOW()
         WHERE telegram_id=$1 AND banned=false
         RETURNING balance::float AS balance`,
        [userId, amount]
      );
      if (!userRow.rowCount) throw new Error("Пользователь не найден или заблокирован.");

      const balanceAfter = Number(userRow.rows[0].balance);
      await client.query(
        `INSERT INTO balance_transactions
         (telegram_user_id, type, amount, balance_after, description)
         VALUES ($1,'referral_claim',$2,$3,$4)`,
        [userId, amount, balanceAfter, "Получение реферального вознаграждения"]
      );

      await client.query(
        `UPDATE referral_earnings
         SET claimed=true, claimed_at=NOW()
         WHERE referrer_id=$1 AND claimed=false`,
        [userId]
      );

      await client.query("COMMIT");
      io.to(`user:${userId}`).emit("balance_updated", { balance: balanceAfter });
      res.json({ ok: true, amount, balance: balanceAfter });
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------- PROMO CODES ----------------
function normalizePromoCode(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

async function redeemPromoCode(userId, rawCode) {
  requireDatabase();
  const code = normalizePromoCode(rawCode);
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw new Error("Промокод должен содержать 3–32 символа: A-Z, 0-9, _ или -.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const promo = await client.query(
      `SELECT id, code, bonus::float AS bonus, wager::float AS wager, max_uses, uses_count, active
       FROM promo_codes WHERE code=$1 FOR UPDATE`,
      [code]
    );
    if (!promo.rowCount) throw new Error("Промокод не найден.");
    const p = promo.rows[0];
    if (!p.active) throw new Error("Этот промокод отключён.");
    if (Number(p.uses_count) >= Number(p.max_uses)) throw new Error("Лимит активаций промокода исчерпан.");

    const already = await client.query(
      `SELECT 1 FROM promo_redemptions WHERE promo_code_id=$1 AND telegram_user_id=$2`,
      [p.id, String(userId)]
    );
    if (already.rowCount) throw new Error("Вы уже активировали этот промокод.");

    const balanceAfter = await creditBalance(userId, Number(p.bonus), client, {
      type: "promo_code",
      description: `Активация промокода ${p.code}`
    });

    // A promo with a wager multiplier adds bonus*wager to the amount the
    // player must stake (in PVP and/or Upgrade, win or lose) before they can
    // withdraw again. Multiple such promos stack on top of each other.
    const wagerMultiplier = Number(p.wager || 0);
    if (wagerMultiplier > 0) {
      await client.query(
        `UPDATE users SET wager_remaining = wager_remaining + $2 WHERE telegram_id=$1`,
        [String(userId), Number(p.bonus) * wagerMultiplier]
      );
    }

    await client.query(
      `INSERT INTO promo_redemptions (promo_code_id, telegram_user_id, bonus) VALUES ($1,$2,$3)`,
      [p.id, String(userId), Number(p.bonus)]
    );
    await client.query(
      `UPDATE promo_codes SET uses_count=uses_count+1 WHERE id=$1`,
      [p.id]
    );
    await client.query("COMMIT");
    return { code: p.code, bonus: Number(p.bonus), wager: wagerMultiplier, balance: balanceAfter };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function createPromoCode(adminId, rawCode, bonus, maxUses, wager) {
  requireDatabase();
  const code = normalizePromoCode(rawCode);
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw new Error("Промокод должен содержать 3–32 символа: A-Z, 0-9, _ или -.");
  const amount = Number(bonus);
  const uses = Number(maxUses);
  const wagerMultiplier = wager === undefined || wager === null || wager === "" ? 0 : Number(wager);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) throw new Error("Бонус должен быть целым числом от 1 до 1 000 000 000.");
  if (!Number.isInteger(uses) || uses <= 0 || uses > 1_000_000_000) throw new Error("Количество активаций должно быть от 1 до 1 000 000 000.");
  if (!Number.isFinite(wagerMultiplier) || wagerMultiplier < 0 || wagerMultiplier > 1000) throw new Error("Вагер должен быть числом от 0 до 1000 (0 — без вагера).");

  try {
    const r = await pool.query(
      `INSERT INTO promo_codes (code, bonus, max_uses, created_by, wager) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, code, bonus::float AS bonus, wager::float AS wager, max_uses, uses_count, active, created_at`,
      [code, amount, uses, String(adminId), wagerMultiplier]
    );
    return r.rows[0];
  } catch (e) {
    if (e.code === "23505") throw new Error("Такой промокод уже существует.");
    throw e;
  }
}

// ---------------- RAFFLE API ----------------
app.get('/api/raffles', async (req,res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers['x-telegram-init-data'], req.headers['x-raffle-ref'] || '');
    const r = await pool.query(`
      SELECT r.id,r.creator_id,r.raffle_type,r.ticket_price::float AS ticket_price,r.prize_pool::float AS prize_pool,r.prize_title,r.winners_count,r.ends_at,r.channel_id,r.channel_username,r.channel_title,r.post_message_id,r.status,r.created_at,r.finished_at,
             u.username AS creator_username,u.first_name AS creator_first_name,
             COALESCE((SELECT SUM(e.tickets) FROM raffle_entries e WHERE e.raffle_id=r.id),0)::int AS total_tickets,
             COALESCE((SELECT COUNT(*) FROM raffle_entries e WHERE e.raffle_id=r.id),0)::int AS participants
      FROM raffles r JOIN users u ON u.telegram_id=r.creator_id
      WHERE r.status IN ('active','finished') ORDER BY CASE WHEN r.status='active' THEN 0 ELSE 1 END, r.ends_at DESC LIMIT 100`);
    const items = r.rows.map(x => ({ ...rafflePublicRow(x), totalTickets:Number(x.total_tickets), participants:Number(x.participants), creator:x.creator_username?'@'+x.creator_username:x.creator_first_name }));
    res.json({ raffles: items, me: String(session.db.telegram_id) });
  } catch(e) { res.status(401).json({error:e.message}); }
});

app.get('/api/raffles/:id', async (req,res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers['x-telegram-init-data'], req.headers['x-raffle-ref'] || '');
    res.json(await getRaffleDetails(req.params.id, session.telegram.id));
  } catch(e) { res.status(400).json({error:e.message}); }
});

app.post('/api/raffles', async (req,res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers['x-telegram-init-data'], '');
    const result = await createRaffleForUser(session.telegram.id, req.body || {});
    res.json({ok:true,...result});
  } catch(e) {
    const code = e.code === 'INSUFFICIENT_FUNDS' ? 402 : 400;
    res.status(code).json({error:e.message, code:e.code || null, missing:Number(e.missing || 0), balance:Number(e.balance || 0)});
  }
});

app.get('/api/raffles/:id/subscription', async (req,res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers['x-telegram-init-data'], '');
    const raffle = await getRaffleById(req.params.id);
    if (!raffle) return res.status(404).json({ error: 'Розыгрыш не найден.' });
    const subscribed = await isRaffleChannelSubscribed(raffle, session.telegram.id);
    res.json({ ok: true, required: true, subscribed, channelUrl: botChannelLink(raffle.channel_username) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/raffles/:id/join', async (req,res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers['x-telegram-init-data'], req.body?.startParam || '');
    const result = await joinRaffle(session.telegram.id, req.params.id, req.body?.startParam || '');
    res.json({ok:true,...result, detail: await getRaffleDetails(req.params.id, session.telegram.id)});
  } catch(e) {
    const code = e.code === 'INSUFFICIENT_FUNDS' ? 402 : 400;
    res.status(code).json({error:e.message, code:e.code || null, missing:Number(e.missing || 0), balance:Number(e.balance || 0)});
  }
});

app.post('/api/raffles/:id/check-boost', async (req,res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers['x-telegram-init-data'], '');
    const result = await checkRaffleBoost(session.telegram.id, req.params.id);
    res.json({ok:true,...result,detail:await getRaffleDetails(req.params.id,session.telegram.id)});
  } catch(e) { res.status(400).json({error:e.message}); }
});

// ---------------- TASKS ----------------
async function verifyTaskChannel(channelUsername, userId = null) {
  const username = normalizeChannelRef(channelUsername);
  if (!username) throw new Error("Укажите username канала, например @my_channel.");
  const chat = await telegramApi("getChat", { chat_id: `@${username}` });
  const bot = await getBotInfoCached();
  const botMember = await telegramApi("getChatMember", { chat_id: chat.id, user_id: Number(bot.id) });
  if (!["creator", "administrator"].includes(String(botMember.status))) throw new Error("Добавьте бота администратором канала, чтобы он мог проверять подписку.");
  if (userId != null) {
    const member = await telegramApi("getChatMember", { chat_id: chat.id, user_id: Number(userId) });
    const joined = ["creator", "administrator", "member"].includes(String(member.status)) || (String(member.status) === "restricted" && member.is_member === true);
    if (!joined) throw new Error("Сначала подпишитесь на канал, затем повторите проверку.");
  }
  return { id: String(chat.id), username: `@${username}` };
}

function taskPrice(reward, activations) { return Number((Number(reward) * Number(activations) * 1.5).toFixed(2)); }

app.get("/api/tasks", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const result = await pool.query(
      `SELECT t.id, t.task_type, t.target_username, t.reward::float AS reward, t.max_activations, t.completions,
              EXISTS(SELECT 1 FROM task_completions c WHERE c.task_id=t.id AND c.telegram_user_id=$1) AS completed
       FROM tasks t WHERE t.status='active' ORDER BY t.created_at DESC`, [String(session.telegram.id)]
    );
    res.json({ tasks: result.rows });
  } catch (e) { res.status(400).json({ error: e.message || "Не удалось загрузить задания." }); }
});

app.post("/api/tasks/:id/complete", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const taskId = String(req.params.id);
    const preview = await pool.query(`SELECT * FROM tasks WHERE id=$1 AND status='active'`, [taskId]);
    if (!preview.rowCount) throw new Error("Задание недоступно.");
    if (preview.rows[0].task_type !== "channel_subscription") throw new Error("Этот вид задания пока недоступен.");
    await verifyTaskChannel(preview.rows[0].target_username, session.telegram.id);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(`SELECT * FROM tasks WHERE id=$1 AND status='active' FOR UPDATE`, [taskId]);
      if (!locked.rowCount || Number(locked.rows[0].completions) >= Number(locked.rows[0].max_activations)) throw new Error("Лимит активаций задания исчерпан.");
      const inserted = await client.query(`INSERT INTO task_completions (task_id, telegram_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING task_id`, [taskId, String(session.telegram.id)]);
      if (!inserted.rowCount) throw new Error("Вы уже получили награду за это задание.");
      const balance = await creditBalance(session.telegram.id, Number(locked.rows[0].reward), client, { type: "task_reward", description: `Награда за задание ${taskId}` });
      await client.query(`UPDATE tasks SET completions=completions+1, status=CASE WHEN completions+1 >= max_activations THEN 'finished' ELSE 'active' END WHERE id=$1`, [taskId]);
      await client.query("COMMIT");
      io.to(`user:${session.telegram.id}`).emit("balance_updated", { balance });
      res.json({ ok: true, balance });
    } catch (e) { try { await client.query("ROLLBACK"); } catch {} throw e; } finally { client.release(); }
  } catch (e) { res.status(400).json({ error: e.message || "Не удалось выполнить задание." }); }
});

app.post("/api/admin/tasks", async (req, res) => {
  try {
    const admin = await requireAdminRequest(req);
    const reward = Number(req.body?.reward);
    const activations = Number(req.body?.activations);
    if (!Number.isFinite(reward) || reward <= 0 || !Number.isInteger(activations) || activations <= 0) throw new Error("Укажите награду и целое количество активаций.");
    const channel = await verifyTaskChannel(req.body?.channel);
    const price = taskPrice(reward, activations);
    const id = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const debited = await client.query(`UPDATE users SET balance=balance-$2, updated_at=NOW() WHERE telegram_id=$1 AND banned=false AND balance >= $2 RETURNING balance::float AS balance`, [String(admin.id), price]);
      if (!debited.rowCount) throw new Error("Недостаточно Stars на балансе для оплаты задания.");
      const balance = Number(debited.rows[0].balance);
      await client.query(`INSERT INTO balance_transactions (telegram_user_id,type,amount,balance_after,description) VALUES ($1,'task_purchase',$2,$3,$4)`, [String(admin.id), -price, balance, `Создание задания ${channel.username}`]);
      await client.query(`INSERT INTO tasks (id, created_by, task_type, target_username, target_chat_id, reward, max_activations, price) VALUES ($1,$2,'channel_subscription',$3,$4,$5,$6,$7)`, [id, String(admin.id), channel.username, channel.id, reward, activations, price]);
      await client.query("COMMIT");
      invalidateUserCache(admin.id);
      res.json({ ok: true, id, price, balance });
    } catch (e) { try { await client.query("ROLLBACK"); } catch {} throw e; } finally { client.release(); }
  } catch (e) { res.status(400).json({ error: e.message || "Не удалось создать задание." }); }
});

// ---------------- ADMIN API ----------------

app.get("/api/admin/stats", async (req, res) => {
  try {
    await requireAdminRequest(req);
    const r = await pool.query(`
      SELECT
        COUNT(*)::int AS users,
        COUNT(*) FILTER (WHERE banned=true)::int AS banned,
        COALESCE(SUM(balance),0)::float AS total_balance
      FROM users
    `);
    res.json({ ...r.rows[0], onlinePvpPlayers: state.players.size, roundStatus: state.status, roomBank: totalBank() });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.get("/api/admin/users", async (req, res) => {
  try {
    await requireAdminRequest(req);
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 250);
    const values = [];
    let where = "";
    if (q) {
      values.push(`%${q}%`);
      where = `WHERE telegram_id ILIKE $${values.length} OR username ILIKE $${values.length} OR first_name ILIKE $${values.length}`;
    }
    values.push(limit);
    const r = await pool.query(
      `SELECT telegram_id, username, first_name, balance::float AS balance, banned, created_at
       FROM users ${where} ORDER BY created_at DESC LIMIT $${values.length}`,
      values
    );
    res.json({ users: r.rows });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.get("/api/admin/transactions", async (req, res) => {
  try {
    await requireAdminRequest(req);
    const target = req.query.userId ? String(req.query.userId) : null;
    const r = target
      ? await pool.query(`SELECT * FROM balance_transactions WHERE telegram_user_id=$1 ORDER BY created_at DESC LIMIT 100`, [target])
      : await pool.query(`SELECT * FROM balance_transactions ORDER BY created_at DESC LIMIT 100`);
    res.json({ transactions: r.rows });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

// One summary shape (total + count, breakdown "by method", recent list)
// reused across the Пополнения/Ставки/Выводы/Рефералы admin tabs, in the
// spirit of the "Статистика" screen the client asked to match.
const ADMIN_SUMMARY_METHOD_LABELS = {
  balance_topup: "Stars", ton_topup: "TON / GRAM",
  pvp_bet: "PVP", upgrade_bet: "Upgrade",
  STAR: "Stars", GRAM: "GRAM", TON: "TON",
  true: "Выплачено", false: "Не выплачено"
};

app.get("/api/admin/summary/:category", async (req, res) => {
  try {
    await requireAdminRequest(req);
    const category = String(req.params.category);
    let rows;
    if (category === "topups") {
      rows = (await pool.query(
        `SELECT t.type AS method, t.amount::float AS amount, t.created_at,
                COALESCE(NULLIF(u.username,''), u.first_name) AS name, u.username
         FROM balance_transactions t JOIN users u ON u.telegram_id=t.telegram_user_id
         WHERE t.type IN ('balance_topup','ton_topup') ORDER BY t.created_at DESC LIMIT 500`
      )).rows;
    } else if (category === "bets") {
      rows = (await pool.query(
        `SELECT t.type AS method, ABS(t.amount::float) AS amount, t.created_at,
                COALESCE(NULLIF(u.username,''), u.first_name) AS name, u.username
         FROM balance_transactions t JOIN users u ON u.telegram_id=t.telegram_user_id
         WHERE t.type IN ('pvp_bet','upgrade_bet') ORDER BY t.created_at DESC LIMIT 500`
      )).rows;
    } else if (category === "withdrawals") {
      rows = (await pool.query(
        `SELECT w.currency AS method, w.amount::float AS amount, w.status, w.created_at,
                COALESCE(NULLIF(u.username,''), u.first_name) AS name, u.username
         FROM withdrawal_requests w JOIN users u ON u.telegram_id=w.telegram_user_id
         ORDER BY w.created_at DESC LIMIT 500`
      )).rows;
    } else if (category === "referrals") {
      rows = (await pool.query(
        `SELECT r.claimed AS method, r.reward_amount::float AS amount, r.created_at,
                COALESCE(NULLIF(u.username,''), u.first_name) AS name, u.username
         FROM referral_earnings r JOIN users u ON u.telegram_id=r.referrer_id
         ORDER BY r.created_at DESC LIMIT 500`
      )).rows;
    } else {
      throw new Error("Неизвестная категория статистики.");
    }

    const byMethod = {};
    let totalAmount = 0;
    for (const row of rows) {
      const key = String(row.method);
      if (!byMethod[key]) byMethod[key] = { method: ADMIN_SUMMARY_METHOD_LABELS[key] || key, count: 0, amount: 0 };
      byMethod[key].count += 1;
      byMethod[key].amount += Number(row.amount);
      totalAmount += Number(row.amount);
    }

    res.json({
      totalAmount,
      count: rows.length,
      byMethod: Object.values(byMethod),
      recent: rows.slice(0, 30).map(row => ({
        name: row.name,
        username: row.username || null,
        method: ADMIN_SUMMARY_METHOD_LABELS[String(row.method)] || String(row.method),
        status: row.status || null,
        amount: Number(row.amount),
        createdAt: row.created_at
      }))
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/admin/promos", async (req, res) => {
  try {
    await requireAdminRequest(req);
    const r = await pool.query(
      `SELECT id, code, bonus::float AS bonus, wager::float AS wager, max_uses, uses_count, active, created_by, created_at
       FROM promo_codes ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ promos: r.rows });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.post("/api/admin/promos", async (req, res) => {
  try {
    const admin = await requireAdminRequest(req);
    const promo = await createPromoCode(admin.id, req.body?.code, req.body?.bonus, req.body?.maxUses, req.body?.wager);
    res.json({ ok: true, promo });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/admin/promos/:id/toggle", async (req, res) => {
  try {
    await requireAdminRequest(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Некорректный промокод." });
    const active = Boolean(req.body?.active);
    const r = await pool.query(
      `UPDATE promo_codes SET active=$2 WHERE id=$1 RETURNING id, code, bonus::float AS bonus, max_uses, uses_count, active, created_at`,
      [id, active]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Промокод не найден." });
    res.json({ ok: true, promo: r.rows[0] });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.post("/api/admin/users/:id/adjust-balance", async (req, res) => {
  try {
    const admin = await requireAdminRequest(req);
    const delta = Number(req.body?.delta);
    if (!Number.isInteger(delta) || delta === 0) return res.status(400).json({ error: "delta должен быть целым числом и не равен 0." });
    if (Math.abs(delta) > 1_000_000_000) return res.status(400).json({ error: "Слишком большая сумма." });
    const balance = await adjustAdminBalance(String(req.params.id), delta, admin.id, String(req.body?.description || "Изменение баланса администратором").slice(0, 180));
    io.to(`user:${String(req.params.id)}`).emit("balance_updated", { balance });
    res.json({ ok: true, balance });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.post("/api/admin/users/:id/ban", async (req, res) => {
  try {
    const admin = await requireAdminRequest(req);
    const banned = Boolean(req.body?.banned);
    const result = await setBanned(String(req.params.id), banned, admin.id);
    res.json({ ok: true, user: result });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "telegram-stars-pvp-wheel",
    status: state.status,
    players: state.players.size,
    database: !!pool,
    telegram: !!process.env.TELEGRAM_BOT_TOKEN,
    telegramWebhookConfigured: !!process.env.TELEGRAM_WEBHOOK_SECRET && !!process.env.APP_PUBLIC_URL,
    adminsConfigured: getAdminIds().length
  });
});

// History list: round number, winner, payout/multiplier, timestamp. Search
// by round number when ?q= is a plain number, otherwise returns the most
// recent rounds.
app.get("/api/pvp/history", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 100);
    const values = [];
    let where = "";
    if (q && /^\d+$/.test(q)) {
      values.push(q);
      where = `WHERE round_number::text LIKE $${values.length} || '%'`;
    }
    values.push(limit);
    const r = await pool.query(
      `SELECT round_number, id, bank, winner_id, winner_bet, payout, players, created_at
       FROM pvp_rounds ${where} ORDER BY round_number DESC LIMIT $${values.length}`,
      values
    );
    const rounds = r.rows.map(row => {
      const players = Array.isArray(row.players) ? row.players : [];
      const winner = players.find(p => p.id === row.winner_id) || null;
      const winnerBet = Number(row.winner_bet || 0);
      const payout = Number(row.payout || 0);
      return {
        roundNumber: row.round_number,
        createdAt: row.created_at,
        bank: Number(row.bank),
        winner: winner ? {
          id: winner.id,
          name: winner.name,
          avatar: winner.avatar,
          percentage: winner.percentage
        } : null,
        payout,
        multiplier: winnerBet > 0 ? Number((payout / winnerBet).toFixed(2)) : 0
      };
    });
    res.json({ rounds });
  } catch (e) {
    res.status(400).json({ error: e.message || "Не удалось загрузить историю." });
  }
});

// Full breakdown of one round: every participant + the provably-fair seed.
app.get("/api/pvp/history/:roundNumber", async (req, res) => {
  try {
    const roundNumber = Number(req.params.roundNumber);
    if (!Number.isInteger(roundNumber) || roundNumber <= 0) throw new Error("Некорректный номер игры.");
    const r = await pool.query(
      `SELECT round_number, id, bank, winner_id, winner_bet, payout, commission, players,
              server_seed, server_seed_hash, created_at
       FROM pvp_rounds WHERE round_number=$1`,
      [roundNumber]
    );
    if (!r.rowCount) throw new Error("Игра не найдена.");
    const row = r.rows[0];
    const players = Array.isArray(row.players) ? row.players : [];
    const winnerBet = Number(row.winner_bet || 0);
    const payout = Number(row.payout || 0);
    res.json({
      roundNumber: row.round_number,
      createdAt: row.created_at,
      bank: Number(row.bank),
      winnerId: row.winner_id,
      payout,
      multiplier: winnerBet > 0 ? Number((payout / winnerBet).toFixed(2)) : 0,
      players: players
        .map(p => ({ id: p.id, name: p.name, avatar: p.avatar, bet: Number(p.bet || 0), percentage: p.percentage }))
        .sort((a, b) => b.bet - a.bet),
      // Provably fair: server_seed_hash was fixed before the round settled;
      // server_seed is only revealed here, afterwards, so anyone can hash it
      // themselves and confirm it matches — the seed could not have been
      // chosen after seeing the bets.
      hash: row.server_seed_hash,
      seed: row.server_seed
    });
  } catch (e) {
    res.status(400).json({ error: e.message || "Не удалось загрузить игру." });
  }
});

app.get("/api/state", (req, res) => res.json(publicState()));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

async function start() {
  await initDb();
  await settleExpiredRaffles();
  setInterval(settleExpiredRaffles, 5000).unref();
  await settleTonTopups();
  setInterval(settleTonTopups, 20000).unref();

  server.listen(PORT, "0.0.0.0", async () => {
    console.log(`PVP wheel listening on ${PORT}`);
    await configureTelegramBot();
    await verifyTelegramWebhook();
    setInterval(verifyTelegramWebhook, 10 * 60 * 1000).unref();
  });
}

start().catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});

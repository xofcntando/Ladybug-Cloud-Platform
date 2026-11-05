/**
 * Bomb Game - Number guessing (free) + Mines-style betting
 * Free: {prefix}bomb
 * Bet:  {prefix}bomb <amount> or {prefix}bet <amount>  |  cashout mid-game
 */

const config = require('../../config');
const path = require('path');
const fs = require('fs');
const economy = require('../../utils/economy');
const {
  deductWallet,
  adjustWallet,
  fmtCoins,
  getUserData,
} = economy;
const { withOwner, isButtonOwner, isGameButtonId } = require('../../utils/gameButtons');
let sendButtons;
let sendInteractiveMessage;
try {
  ({ sendButtons, sendInteractiveMessage } = require('gifted-btns'));
} catch {
  sendButtons = null;
  sendInteractiveMessage = null;
}

const gameState = new Map();

const TIMEOUT_MS = 180000;
const MIN_BET = 50;
const MAX_BET = 50000;
/** High stakes (5L / 15L / 20L) — only modes 6 & 7 */
const HIGH_BET_TIERS = [500000, 1500000, 2000000];
const HIGH_RISK_MODES = new Set([6, 7]);
const EXTREME_MODE = 8;
const MIN_EXTREME_BET = 500;
const MAX_EXTREME_BET = 1000000000000; // 1 trillion
const MAX_DAILY_BET_TURNS =
  typeof economy.MAX_BOMB_BET_TURNS === 'number' ? economy.MAX_BOMB_BET_TURNS : 15;

const SELECT_TIMEOUT_MS = 60000;
/** Mode key = bomb count. mult[safeOpened] = win payout. lossMult = total stake lost on 💣 (1 = stake only). */
const BOMB_CONFIGS = {
  1: { bombs: 1, mult: [1, 1.2, 1.5, 2, 3, 5, 8, 12, 20], lossMult: 1, label: '1 Bomb' },
  2: { bombs: 2, mult: [1, 1.8, 2.5, 3.5, 5, 7, 10, 14], lossMult: 1, label: '2 Bombs' },
  3: { bombs: 3, mult: [1, 3, 4.5, 6.5, 9, 13, 18], lossMult: 1, label: '3 Bombs' },
  4: { bombs: 4, mult: [1, 4, 6.5, 10, 16, 28], lossMult: 1, label: '4 Bombs' },
  5: { bombs: 5, mult: [1, 5.5, 10, 18, 35], lossMult: 1.2, label: '5 Bombs' },
  6: { bombs: 6, mult: [1, 8, 16, 40], lossMult: 3, label: '6 Bombs' },
  7: { bombs: 7, mult: [1, 12, 45], lossMult: 4, label: '7 Bombs' },
  8: { bombs: 8, mult: [1, 70], lossMult: 30, label: '1 Mine (8 Bombs)', extreme: true },
};

const ECO_DB_PATH = path.join(process.env.BOT_DATA_DIR || path.join(__dirname, '..', '..', 'database'), 'economy.json');

function px() {
  return config.prefix;
}

function bombBetDayKey() {
  return new Date().toISOString().slice(0, 10);
}

/** Persist turns in economy.json even if host has an older economy.js. */
function readWriteBombTurns(groupId, userId, consume) {
  let db = {};
  try {
    if (fs.existsSync(ECO_DB_PATH)) {
      db = JSON.parse(fs.readFileSync(ECO_DB_PATH, 'utf-8') || '{}');
    }
  } catch {
    db = {};
  }
  if (!db[groupId] || typeof db[groupId] !== 'object') db[groupId] = {};
  if (!db[groupId][userId] || typeof db[groupId][userId] !== 'object') {
    db[groupId][userId] = {};
  }
  const user = db[groupId][userId];
  const day = bombBetDayKey();
  if (user.bombBetDay !== day) {
    user.bombBetDay = day;
    user.bombBetTurns = 0;
  }
  if (consume) {
    user.bombBetTurns = (Number(user.bombBetTurns) || 0) + 1;
  }
  const turns = Number(user.bombBetTurns) || 0;
  try {
    fs.mkdirSync(path.dirname(ECO_DB_PATH), { recursive: true });
    fs.writeFileSync(ECO_DB_PATH, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('[bomb] failed to save bet turns:', e.message);
  }
  return {
    turns,
    remaining: Math.max(0, MAX_DAILY_BET_TURNS - turns),
    max: MAX_DAILY_BET_TURNS,
  };
}

function getBetTurnInfo(groupId, userId) {
  if (typeof economy.getBombBetTurns === 'function') {
    const info = economy.getBombBetTurns(groupId, userId);
    return { turns: info.turns, remaining: info.remaining, max: info.max || MAX_DAILY_BET_TURNS };
  }
  return readWriteBombTurns(groupId, userId, false);
}

function consumeBetTurn(groupId, userId) {
  if (typeof economy.consumeBombBetTurn === 'function') {
    return economy.consumeBombBetTurn(groupId, userId);
  }
  return readWriteBombTurns(groupId, userId, true).turns;
}

function isHighStake(amount) {
  return HIGH_BET_TIERS.includes(amount);
}

function isNormalStake(amount) {
  return Number.isInteger(amount) && amount >= MIN_BET && amount <= MAX_BET;
}

function isExtremeEligible(amount) {
  return Number.isInteger(amount) && amount >= MIN_EXTREME_BET && amount <= MAX_EXTREME_BET;
}

/** Amounts that can ONLY use mode 8 (not 50k cap, not 5L/15L/20L tiers). */
function isExtremeOnly(amount) {
  return isExtremeEligible(amount) && !isNormalStake(amount) && !isHighStake(amount);
}

/** Allowed bet: normal ≤50k, exact high tiers 5L/15L/20L, or any 500–1T for 1-mine mode. */
function validateBetAmount(amount) {
  if (!Number.isInteger(amount) || amount < MIN_BET) {
    return { ok: false, error: 'min' };
  }
  if (isNormalStake(amount)) return { ok: true, high: false, extreme: isExtremeEligible(amount) };
  if (isHighStake(amount)) return { ok: true, high: true, extreme: true };
  if (isExtremeOnly(amount)) return { ok: true, high: false, extreme: true, extremeOnly: true };
  if (amount > MAX_EXTREME_BET) return { ok: false, error: 'max' };
  return { ok: false, error: 'tier' };
}

function modesForAmount(amount) {
  if (isExtremeOnly(amount)) return [String(EXTREME_MODE)];
  if (isHighStake(amount)) {
    return Object.keys(BOMB_CONFIGS).filter(
      (k) => HIGH_RISK_MODES.has(parseInt(k, 10)) || parseInt(k, 10) === EXTREME_MODE
    );
  }
  if (isNormalStake(amount) && isExtremeEligible(amount)) {
    return Object.keys(BOMB_CONFIGS);
  }
  return Object.keys(BOMB_CONFIGS).filter((k) => parseInt(k, 10) !== EXTREME_MODE);
}

function requiredWalletForMode(amount, mode) {
  const cfg = BOMB_CONFIGS[mode] || BOMB_CONFIGS[1];
  return Math.ceil(amount * (cfg.lossMult || 1));
}

function payoutFor(bet, safeOpened, mult = BOMB_CONFIGS[1].mult) {
  const m = mult[Math.min(Math.max(safeOpened, 0), mult.length - 1)];
  return Math.floor(bet * m);
}

/** Total coins lost on 💣 (stake already deducted counts as 1×). Returns { total, extra, lossMult }. */
function bombLossInfo(bet, lossMult = 1) {
  const lm = Math.max(1, Number(lossMult) || 1);
  const total = Math.floor(bet * lm);
  const extra = Math.max(0, total - bet);
  return { total, extra, lossMult: lm };
}

/** Deduct extra loss beyond locked stake. */
function applyExtraBombLoss(groupId, userId, bet, lossMult) {
  const info = bombLossInfo(bet, lossMult);
  if (info.extra > 0) {
    adjustWallet(groupId, userId, -info.extra);
  }
  return info;
}

function boardText(array) {
  let teks = '';
  for (let i = 0; i < array.length; i += 3) {
    teks += array.slice(i, i + 3).map((v) => (v.state ? v.emot : v.number)).join('') + '\n';
  }
  return teks;
}

function revealBoard(array) {
  let teks = '';
  for (let i = 0; i < array.length; i += 3) {
    teks += array.slice(i, i + 3).map((v) => v.emot).join('') + '\n';
  }
  return teks;
}

function makeBoard(bombCount = 1) {
  const b = Math.max(1, Math.min(8, parseInt(bombCount, 10) || 1));
  const bom = Array.from({ length: b }, () => '💣')
    .concat(Array.from({ length: 9 - b }, () => '💎'))
    .sort(() => Math.random() - 0.5);
  const number = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
  return bom.map((v, i) => ({
    emot: v,
    number: number[i],
    position: i + 1,
    state: false,
  }));
}

function clearGame(sender) {
  const game = gameState.get(sender);
  if (game?.timeoutId) clearTimeout(game.timeoutId);
  gameState.delete(sender);
}

function betStatusLine(game) {
  if (!game.bet) return '';
  const multArr = game.mult || BOMB_CONFIGS[1].mult;
  const cash = payoutFor(game.bet, game.safeOpened, multArr);
  const mult = multArr[Math.min(game.safeOpened, multArr.length - 1)];
  const bombLabel = game.bombs ? ` | Mode: *${game.bombs}💣*` : '';
  return (
    `\n💰 Bet: *${fmtCoins(game.bet)}* 🪙${bombLabel} | Mult: *${mult}×* | Cashout: *${fmtCoins(cash)}* 🪙\n` +
    `Type *cashout* to take winnings to wallet.\n`
  );
}

function selectedButtonId(msg) {
  const seen = new Set();
  const queue = [msg.message || {}];

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    const fromButtons = node?.buttonsResponseMessage?.selectedButtonId;
    const fromButtonText = node?.buttonsResponseMessage?.selectedDisplayText;
    if (fromButtons && fromButtonText) return `${String(fromButtons)} ${String(fromButtonText)}`;
    if (fromButtons) return String(fromButtons);
    if (fromButtonText) return String(fromButtonText);

    const fromList = node?.listResponseMessage?.singleSelectReply?.selectedRowId;
    if (fromList) return String(fromList);

    const interactive = node?.interactiveResponseMessage;
    if (interactive) {
      const paramsJson =
        interactive?.nativeFlowResponseMessage?.paramsJson ||
        interactive?.native_flow_response_message?.paramsJson;
      if (paramsJson) {
        try {
          const parsed = typeof paramsJson === 'string' ? JSON.parse(paramsJson) : paramsJson;
          const id = String(
            parsed?.id ||
              parsed?.selectedId ||
              parsed?.rowId ||
              parsed?.display_text ||
              parsed?.title ||
              ''
          );
          if (id) return id;
        } catch {
          // ignore invalid json
        }
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return '';
}

function parseModePick(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (/\b(1\s*mine|mine|extreme|70x?)\b/.test(s) || /bombcfg[^0-9]*8/i.test(s)) return EXTREME_MODE;
  const byId = s.match(/bombcfg[^0-9]*([1-8])/i);
  if (byId) return parseInt(byId[1], 10);
  if (/^[1-8]$/.test(s)) return parseInt(s, 10);
  const byLabel = s.match(/(?:^|[^0-9])([1-8])\s*bombs?\b/i);
  if (byLabel) return parseInt(byLabel[1], 10);
  const byX = s.match(/(?:^|[^0-9])([1-8])\s*x\b/i);
  if (byX) return parseInt(byX[1], 10);
  return 0;
}

function extractButtonDebug(msg) {
  const out = [];
  const seen = new Set();
  const queue = [{ node: msg.message || {}, path: 'message' }];

  while (queue.length && out.length < 20) {
    const { node, path } = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    const hasButtonsResponse = !!node?.buttonsResponseMessage;
    const hasListResponse = !!node?.listResponseMessage;
    const hasInteractiveResponse = !!node?.interactiveResponseMessage;
    if (hasButtonsResponse || hasListResponse || hasInteractiveResponse) {
      out.push({
        path,
        hasButtonsResponse,
        hasListResponse,
        hasInteractiveResponse,
        selectedButtonId: node?.buttonsResponseMessage?.selectedButtonId || null,
        selectedDisplayText: node?.buttonsResponseMessage?.selectedDisplayText || null,
        selectedRowId: node?.listResponseMessage?.singleSelectReply?.selectedRowId || null,
        paramsJson:
          node?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
          node?.interactiveResponseMessage?.native_flow_response_message?.paramsJson ||
          null,
      });
    }

    for (const [k, value] of Object.entries(node)) {
      if (value && typeof value === 'object') queue.push({ node: value, path: `${path}.${k}` });
    }
  }

  return out;
}

async function sendModeSelection(sock, extra, msg, amount) {
  const p = px();
  const { turns, remaining } = getBetTurnInfo(extra.from, extra.sender);
  const high = isHighStake(amount);
  const extremeOnly = isExtremeOnly(amount);
  const modeKeys = modesForAmount(amount);
  const modeLines = modeKeys
    .map((k) => {
      const cfg = BOMB_CONFIGS[k];
      const start = cfg.mult[1];
      const loss =
        cfg.lossMult > 1 ? ` · lose *${cfg.lossMult}×* on 💣` : '';
      if (cfg.extreme) {
        return `• *8* / 1 mine: find the *1* 💎 — win *70×* · lose *30×*`;
      }
      return `• ${k}💣: starts *${start}×*${loss}`;
    })
    .join('\n');

  let intro;
  if (extremeOnly) {
    intro = `⚡ *1 MINE MODE* — 8 bombs, 1 gem. Win *70×* · lose *30×*.\n`;
  } else if (high) {
    intro = `High stake — *6* / *7* bombs, or *8* (1 mine, 70× / 30×):\n`;
  } else {
    intro = `Choose bomb mode:\n`;
  }

  const text =
    `💰 *Bomb Bet Setup*\n\n` +
    `Stake: *${fmtCoins(amount)}* coins` +
    (extremeOnly ? ` ⚡ *1 MINE*` : high ? ` ⚡ *HIGH STAKE*` : '') +
    `\n\n` +
    intro +
    `${modeLines}\n\n` +
    `🎟️ Daily bet turns: *${turns}/${MAX_DAILY_BET_TURNS}* (remaining: ${Math.max(remaining, 0)})\n\n` +
    (extremeOnly
      ? `Reply *8* or *mine* if buttons don't show. Wallet must cover *30×* stake.`
      : `Mode *5*: 1.2× loss · *6–7*: extra loss · *8*: 70× / 30× (min ${fmtCoins(MIN_EXTREME_BET)}).\nReply *1*–*8* if buttons don't show.`);

  const rows = modeKeys.map((k) => {
    const cfg = BOMB_CONFIGS[k];
    const start = cfg.mult[1];
    if (cfg.extreme) {
      return {
        id: withOwner(`bombcfg_${k}`, extra.sender),
        title: '1 Mine 70x / 30x',
        description: '8💣 · 1💎 · any stake 500+',
      };
    }
    const lossNote = cfg.lossMult > 1 ? ` · ${cfg.lossMult}× loss` : '';
    return {
      id: withOwner(`bombcfg_${k}`, extra.sender),
      title: `${k} Bomb${k === '1' ? '' : 's'} (${start}x)`,
      description: `${cfg.bombs}💣 · ${9 - cfg.bombs} safe${lossNote}`,
    };
  });

  if (typeof sendInteractiveMessage === 'function') {
    try {
      return await sendInteractiveMessage(
        sock,
        extra.from,
        {
          text,
          footer: `Use ${p}bet <amount> again to restart`,
          interactiveButtons: [
            {
              name: 'single_select',
              buttonParamsJson: JSON.stringify({
                title: 'Choose Bomb Mode',
                sections: [
                  {
                    title: extremeOnly
                      ? '1 Mine (70× / 30×)'
                      : high
                        ? 'High risk + 1 Mine'
                        : 'Bomb Modes',
                    rows,
                  },
                ],
              }),
            },
          ],
        },
        { quoted: msg }
      );
    } catch (e) {
      console.error('[bomb] sendInteractiveMessage failed:', e.message);
    }
  }
  if (typeof sendButtons === 'function') {
    try {
      return await sendButtons(
        sock,
        extra.from,
        {
          title: '',
          text,
          footer: `Use ${p}bet <amount> again to restart`,
          buttons: rows.map((r) => ({ id: r.id, text: r.title })),
        },
        { quoted: msg }
      );
    } catch (e) {
      console.error('[bomb] sendButtons failed:', e.message);
    }
  }
  return await sock.sendMessage(extra.from, { text }, { quoted: msg });
}

async function startBombRound(sock, msg, extra, sender, bet, mode, turn = null) {
  const p = px();
  const cfg = BOMB_CONFIGS[mode] || BOMB_CONFIGS[1];
  const array = makeBoard(cfg.bombs);

  let teks = `乂  *B O M B*\n\n`;
  if (bet) {
    teks += `💰 Stake locked: *${fmtCoins(bet)}* coins\n`;
    teks += `🎯 Mode: *${cfg.label}* (win ${cfg.mult[1]}×)\n`;
    if (cfg.extreme) {
      teks += `💎 Find the *1* mine. 8 boxes are bombs.\n`;
    }
    if (cfg.lossMult > 1) {
      teks += `⚠️ Hit 💣 = *${cfg.lossMult}×* loss (*${fmtCoins(Math.floor(bet * cfg.lossMult))}* total)\n`;
    }
    if (Number.isInteger(turn)) {
      teks += `🎟️ Turn: *${turn}/${MAX_DAILY_BET_TURNS}*\n`;
    }
    teks += cfg.extreme
      ? `Pick the *1* 💎 to win *70×*. Hit 💣 and you lose *30×*.\n\n`
      : `Open safe boxes to raise multiplier, then *cashout* to wallet.\n\n`;
  }
  teks += `Send number *1* - *9* to open the boxes:\n\n`;
  teks += boardText(array);
  teks += `\nTimeout : [ *${TIMEOUT_MS / 60000} minutes* ]\n`;
  teks += bet
    ? cfg.extreme
      ? `Find the gem for *70×*. 💣 = *30×* loss. *suren* forfeits stake only.`
      : cfg.lossMult > 1
        ? `Hit 💣 = lose *${cfg.lossMult}×* stake. Type *cashout* after 1 safe tile. *suren* forfeits stake only.`
        : `Hit 💣 = lose stake. Type *cashout* anytime after 1 safe tile. *suren* forfeits.`
    : `If you hit the bomb, game over. Type *suren* to surrender.`;

  const gameMsg = await sock.sendMessage(
    extra.from,
    {
      text: teks,
      contextInfo: {
        externalAdReply: {
          title: bet ? 'Bomb Bet (Mines)' : 'Bomb Game',
          body: bet ? `Stake: ${bet} coins | ${cfg.label}` : 'Avoid the bomb!',
          sourceUrl: '',
          mediaType: 1,
        },
      },
    },
    { quoted: msg }
  );

  const timeoutId = setTimeout(() => {
    if (!gameState.has(sender)) return;
    const game = gameState.get(sender);
    const bombBox = game.array.find((v) => v.emot === '💣');
    let t = `*Time's up!* ⏰\n\nThe bomb was in box number ${bombBox.number}.`;
    if (game.bet) t += `\n\n💸 Stake lost: *${fmtCoins(game.bet)}* coins.`;
    sock.sendMessage(extra.from, { text: t }, { quoted: game.msg });
    clearGame(sender);
  }, TIMEOUT_MS);

  gameState.set(sender, {
    msg: gameMsg,
    array,
    timeoutId,
    bet,
    safeOpened: 0,
    groupId: extra.from,
    owner: sender,
    bombs: cfg.bombs,
    mult: cfg.mult,
    lossMult: cfg.lossMult || 1,
  });
}

/** Command word the user actually typed, e.g. "bomb" or "bet" */
function invokedName(msg) {
  const body = (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    ''
  ).trim();
  if (!body.startsWith(config.prefix)) return '';
  return body.slice(config.prefix.length).trim().split(/\s+/)[0].toLowerCase();
}

function betHelp(p) {
  const tiers = HIGH_BET_TIERS.map((t) => fmtCoins(t)).join(' / ');
  return (
    `💰 *Bomb Bet (Mines)*\n\n` +
    `\`${p}bomb <amount>\` or \`${p}bet <amount>\`\n` +
    `Normal: *${fmtCoins(MIN_BET)}* – *${fmtCoins(MAX_BET)}* (modes 1–7)\n` +
    `High stake: *${tiers}* — *6 or 7 bombs*\n` +
    `1 Mine: *${fmtCoins(MIN_EXTREME_BET)}* – *${fmtCoins(MAX_EXTREME_BET)}* — mode *8*\n` +
    `  8 bombs + 1 gem · win *70×* · lose *30×*\n` +
    `Daily bet turns: *${MAX_DAILY_BET_TURNS}* per user\n\n` +
    `Open safe tiles to raise multiplier, then type *cashout*.\n` +
    `Free play (no coins): \`${p}bomb\``
  );
}

module.exports = {
  gameState,
  name: 'bomb',
  aliases: ['bom', 'bet'],
  category: 'fun',
  description: 'Bomb/mines game — free play or bet coins',
  get usage() {
    const p = config.prefix;
    return `${p}bomb | ${p}bomb <amount> | ${p}bet <amount>`;
  },

  async execute(sock, msg, args, extra) {
    try {
      const sender = extra.sender;
      const p = px();
      const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        ''
      ).trim();
      const lower = text.toLowerCase();

      // —— Active game handling ——
      if (gameState.has(sender)) {
        const game = gameState.get(sender);
        if (game.owner && game.owner !== sender) {
          return extra.reply('❌ Only the player who started this bomb can play.');
        }
        const buttonId = String(extra.buttonHint || selectedButtonId(msg) || '').trim();
        if (buttonId && isGameButtonId(buttonId) && !isButtonOwner(buttonId, sender)) {
          return extra.reply('❌ That’s not your game button.');
        }
        if (game.pendingBet) {
          const pickRaw = buttonId || lower;
          if (['suren', 'surrender', 'cancel'].includes(pickRaw)) {
            clearGame(sender);
            return extra.reply('❌ Bet setup cancelled.');
          }
          const mode = parseModePick(pickRaw);
          if (!mode || !BOMB_CONFIGS[mode]) return;

          const amount = game.betAmount;
          if (isExtremeOnly(amount) && mode !== EXTREME_MODE) {
            return extra.reply(
              `❌ Stake *${fmtCoins(amount)}* is 1-mine only.\nPick *8* / *mine*, or cancel.`
            );
          }
          if (mode === EXTREME_MODE && !isExtremeEligible(amount)) {
            return extra.reply(
              `❌ 1-mine mode needs a stake of *${fmtCoins(MIN_EXTREME_BET)}* – *${fmtCoins(MAX_EXTREME_BET)}*.`
            );
          }
          if (isHighStake(amount) && !HIGH_RISK_MODES.has(mode) && mode !== EXTREME_MODE) {
            return extra.reply(
              `❌ High stakes (*${fmtCoins(amount)}*) only on *6*, *7*, or *8* (1 mine).\n` +
                `Pick one of those, or cancel.`
            );
          }
          if (!isHighStake(amount) && !isExtremeOnly(amount) && amount > MAX_BET) {
            clearGame(sender);
            return extra.reply('❌ Invalid stake. Bet cancelled.');
          }

          const need = requiredWalletForMode(amount, mode);
          const userCheck = getUserData(extra.from, sender);
          if ((userCheck?.wallet || 0) < need) {
            return extra.reply(
              `❌ Need *${fmtCoins(need)}* in wallet for this mode ` +
                `(stake + possible *${BOMB_CONFIGS[mode].lossMult}×* loss).\n` +
                `Wallet: *${fmtCoins(userCheck?.wallet || 0)}* 🪙`
            );
          }

          const deducted = deductWallet(extra.from, sender, amount);
          if (!deducted.ok) {
            clearGame(sender);
            return extra.reply(
              `❌ Not enough coins in wallet.\nWallet: *${fmtCoins(deducted.user?.wallet || 0)}* 🪙`
            );
          }
          const turn = consumeBetTurn(extra.from, sender);
          await startBombRound(sock, msg, extra, sender, amount, mode, turn);
          return;
        }

        if (lower === 'suren' || lower === 'surrender') {
          const bombBox = game.array.find((v) => v.emot === '💣');
          let reply = `*You surrendered!* 💣\n\nThe bomb was in box number ${bombBox.number}.`;
          if (game.bet) {
            reply += `\n\n💸 Lost stake: *${fmtCoins(game.bet)}* coins (already deducted).`;
          }
          await extra.reply(reply, { quoted: game.msg });
          clearGame(sender);
          return;
        }

        if (lower === 'cashout' || lower === 'cash out') {
          if (!game.bet) {
            return extra.reply(
              `Cashout is only for bet games. Use \`${p}bomb <amount>\` next time.`
            );
          }
          if (game.safeOpened < 1) {
            return extra.reply('Open at least *1* safe box before cashing out.');
          }
          const win = payoutFor(game.bet, game.safeOpened, game.mult);
          const result = adjustWallet(extra.from, sender, win);
          const multArr = game.mult || BOMB_CONFIGS[1].mult;
          await sock.sendMessage(
            extra.from,
            {
              text:
                `💵 *CASHOUT!*\n\n` +
                `Safe tiles: *${game.safeOpened}* | Mult: *${multArr[game.safeOpened]}×*\n` +
                `+${fmtCoins(win)} coins → wallet\n` +
                `Wallet: *${fmtCoins(result.user.wallet)}* 🪙\n\n` +
                `*Board:*\n${revealBoard(game.array)}`,
            },
            { quoted: game.msg }
          );
          clearGame(sender);
          return;
        }

        const moveRaw = buttonId || text;
        const fromCellBtn = /^bombcell_([1-9])$/i.exec(moveRaw);
        const number = fromCellBtn ? parseInt(fromCellBtn[1], 10) : parseInt(moveRaw, 10);
        if (isNaN(number) || number < 1 || number > 9) {
          return;
        }

        const selectedBox = game.array.find((v) => v.position === number);
        if (!selectedBox || selectedBox.state) {
          return;
        }

        selectedBox.state = true;

        if (selectedBox.emot === '💣') {
          let teks = `💣 *B O M B  E X P L O D E D!*\n\n`;
          teks += `You selected box number ${selectedBox.number} and...\n\n💣 *BOOM!* 💣\n\n`;
          if (game.bet) {
            const loss = applyExtraBombLoss(
              extra.from,
              sender,
              game.bet,
              game.lossMult || 1
            );
            if (loss.lossMult > 1) {
              teks +=
                `💸 Loss: *${loss.lossMult}×* stake = *${fmtCoins(loss.total)}* coins\n` +
                `(stake *${fmtCoins(game.bet)}* locked` +
                (loss.extra > 0
                  ? `; extra *${fmtCoins(loss.extra)}* taken from wallet)\n\n`
                  : ')\n\n');
            } else {
              teks += `💸 Lost stake: *${fmtCoins(game.bet)}* coins\n\n`;
            }
          } else {
            teks += `Game Over!\n\n`;
          }
          teks += `*Final Result:*\n${revealBoard(game.array)}`;
          await sock.sendMessage(extra.from, { text: teks }, { quoted: game.msg });
          clearGame(sender);
          return;
        }

        game.safeOpened = (game.safeOpened || 0) + 1;

        const safeBoxes = game.array.filter((v) => v.emot === '💎');
        const openedSafe = safeBoxes.filter((v) => v.state);

        if (openedSafe.length === safeBoxes.length) {
          let teks = `🎉 *YOU WIN!*\n\nAll safe boxes cleared!\n\n`;
          if (game.bet) {
            const win = payoutFor(game.bet, game.safeOpened, game.mult);
            const result = adjustWallet(extra.from, sender, win);
            const multArr = game.mult || BOMB_CONFIGS[1].mult;
            teks += `💰 Payout: *+${fmtCoins(win)}* coins (×${multArr[game.safeOpened]})\n`;
            teks += `Wallet: *${fmtCoins(result.user.wallet)}* 🪙\n\n`;
          }
          teks += `*Final Result:*\n${revealBoard(game.array)}`;
          await sock.sendMessage(extra.from, { text: teks }, { quoted: game.msg });
          clearGame(sender);
          return;
        }

        let teks = `乂  *B O M B*\n\n`;
        teks += `Box ${selectedBox.number} opened: ${selectedBox.emot}\n`;
        teks += betStatusLine(game);
        teks += `\nSend number *1* - *9* to open a box:\n\n`;
        teks += boardText(game.array);
        teks += `\nTimeout : [ *${TIMEOUT_MS / 60000} minutes* ]\n`;
        teks += game.bet
          ? `Type *cashout* to take winnings, or *suren* to forfeit.`
          : `Type *suren* to surrender.`;

        await sock.sendMessage(extra.from, { text: teks }, { quoted: game.msg });
        return;
      }

      // —— Start new game ——
      const sub = (args[0] || '').toLowerCase();
      const wantsBet = sub === 'bet' || sub === 'mines';
      const amountArg = wantsBet ? args[1] : args[0];
      const amount = parseInt(amountArg, 10);
      const hasAmount = /^\d+$/.test(String(amountArg || ''));
      const calledAsBet = invokedName(msg) === 'bet';
      let bet = 0;

      if (hasAmount || wantsBet || calledAsBet) {
        if (extra.isGroup === false) {
          return extra.reply(
            `💰 Betting works in groups only. Use \`${p}bomb\` for free play here.`
          );
        }
        if (!hasAmount || !Number.isInteger(amount) || amount < MIN_BET) {
          return extra.reply(betHelp(p));
        }
        const check = validateBetAmount(amount);
        if (!check.ok) {
          if (check.error === 'max') {
            return extra.reply(
              `❌ Max 1-mine stake is *${fmtCoins(MAX_EXTREME_BET)}* coins.`
            );
          }
          if (check.error === 'tier') {
            return extra.reply(
              `❌ Above *${fmtCoins(MAX_BET)}*, use:\n` +
                `• High stake: *${HIGH_BET_TIERS.map(fmtCoins).join('* / *')}* (modes 6–7)\n` +
                `• 1 Mine: any amount *${fmtCoins(MIN_EXTREME_BET)}* – *${fmtCoins(MAX_EXTREME_BET)}* (mode 8)\n\n` +
                betHelp(p)
            );
          }
          return extra.reply(betHelp(p));
        }
        const { turns, remaining } = getBetTurnInfo(extra.from, sender);
        if (remaining <= 0) {
          return extra.reply(
            `🎟️ You've used all *${MAX_DAILY_BET_TURNS}* bomb bets today.\n` +
            `Current: *${turns}/${MAX_DAILY_BET_TURNS}*\nCome back tomorrow!`
          );
        }
        const user = getUserData(extra.from, sender);
        const minNeed = check.extremeOnly
          ? Math.ceil(amount * (BOMB_CONFIGS[EXTREME_MODE].lossMult || 30))
          : check.high
            ? Math.ceil(amount * 1.5)
            : amount;
        if ((user?.wallet || 0) < minNeed) {
          return extra.reply(
            `❌ Not enough coins in wallet.\n` +
              (check.extremeOnly
                ? `1-mine needs *${fmtCoins(minNeed)}* (30× cover).\n`
                : check.high
                  ? `High stake needs *${fmtCoins(minNeed)}* cover.\n`
                  : '') +
              `Wallet: *${fmtCoins(user?.wallet || 0)}* 🪙`
          );
        }
        const selectMsg = await sendModeSelection(sock, extra, msg, amount);
        const timeoutId = setTimeout(() => {
          const g = gameState.get(sender);
          if (!g?.pendingBet) return;
          clearGame(sender);
          sock.sendMessage(extra.from, { text: '⌛ Bet mode selection timed out.' }, { quoted: selectMsg });
        }, SELECT_TIMEOUT_MS);
        gameState.set(sender, {
          pendingBet: true,
          betAmount: amount,
          groupId: extra.from,
          owner: sender,
          msg: selectMsg,
          timeoutId,
        });
        return;
      } else if (sub && sub !== 'start' && sub !== 'play') {
        return extra.reply(
          `💣 *Bomb*\n\n` +
            `\`${p}bomb\` — free play\n` +
            `\`${p}bomb <amount>\` or \`${p}bet <amount>\` — stake coins (6h cooldown)\n` +
            `During bet game: type *cashout* or *suren*`
        );
      }

      await startBombRound(sock, msg, extra, sender, bet, 1);
    } catch (error) {
      console.error('Error in bomb command:', error);
      return extra.reply('❌ Error: ' + (error.message || 'Unknown error occurred'));
    }
  },
};

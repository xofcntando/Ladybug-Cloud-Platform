/**
 * Weekly Song Drop — `.weekly`
 * Made under Ntandomods
 *
 * One song a week, out of the box. The catalog, the rotation and the
 * subscriptions all live in utils/weeklySongs.js; this file is only the part
 * that talks to WhatsApp.
 *
 * `.weekly on` is what makes it a *weekly* thing: from then on the bot posts the
 * new pick to that chat by itself, once the ISO week turns over, with no cron
 * entry and no dashboard visit.
 */

const theme = require('../../utils/ladybugTheme');
const weekly = require('../../utils/weeklySongs');

const MAX_CATEGORIES_SHOWN = 12;

function whenNext() {
  // Next Monday, 00:00 local time — the moment the ISO week changes.
  const now = new Date();
  const day = now.getDay() || 7; // Sunday -> 7
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (8 - day), 0, 0, 5);
  const hours = Math.max(1, Math.round((next - now) / 3600000));
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function categoryMenu() {
  let out = `${theme.header('Weekly song')}\n`;
  out += `${theme.line('One song a week, picked for you. Ask for a category any time.')}\n`;
  out += `${theme.divider()}\n`;
  for (const c of weekly.categories().slice(0, MAX_CATEGORIES_SHOWN)) {
    out += `${theme.row(c.emoji, c.label, `.weekly ${c.key}`)}\n`;
  }
  out += `${theme.divider()}\n`;
  out += `${theme.row(theme.ICON.clock, 'Next week', `.weekly next`)}\n`;
  out += `${theme.row(theme.ICON.sparkle, 'Every week here', `.weekly on`)}\n`;
  out += `${theme.row(theme.ICON.cross, 'Stop the weekly drop', `.weekly off`)}\n`;
  out += theme.footer('Songs are cards with links — *.song <title>* sends the audio.');
  return out;
}

function pickFor(input) {
  const wanted = String(input || '').trim();
  if (!wanted) return weekly.pick('');
  return weekly.pick(wanted);
}

module.exports = {
  name: 'weekly',
  aliases: ['songoftheweek', 'weeklysong', 'drop', 'sotw'],
  category: 'general',
  description: 'One song a week — love, zim, gospel, amapiano and more',
  usage: '.weekly | .weekly love | .weekly zim | .weekly next | .weekly on|off',

  async execute(sock, msg, args, extra) {
    const first = String(args[0] || '').toLowerCase();
    const rest = args.slice(1).join(' ').trim();
    const chatId = extra.from;

    try {
      /* ---- subscribe this chat to the automatic drop ---- */
      if (['on', 'subscribe', 'start'].includes(first)) {
        if (extra.isGroup && !extra.isAdmin && !extra.isOwner) {
          return extra.reply(`${theme.ICON.cross} *Only a group admin can turn the weekly drop on here.*`);
        }
        const row = weekly.subscribe(chatId, extra.isGroup ? 'group' : extra.pushName || '');
        const p = weekly.pick('');
        let out = `${theme.ICON.ok} *Weekly song drop is on for this chat.*\n`;
        out += `${theme.line(`Every Monday one new song lands here. Next one in about ${whenNext()}.`)}\n`;
        out += `${theme.divider()}\n`;
        out += `${theme.line(`This week: *${p.song.title}* — ${p.song.artist}`)}\n`;
        out += `${theme.line('*.weekly off* to stop it.')}\n`;
        if (row.already) out = `${theme.ICON.ok} *This chat is already on the weekly drop.*\n${theme.line(`Next one in about ${whenNext()}.`)}`;
        return extra.reply(out);
      }

      /* ---- unsubscribe ---- */
      if (['off', 'stop', 'unsubscribe'].includes(first)) {
        if (extra.isGroup && !extra.isAdmin && !extra.isOwner) {
          return extra.reply(`${theme.ICON.cross} *Only a group admin can turn the weekly drop off here.*`);
        }
        const had = weekly.unsubscribe(chatId);
        return extra.reply(
          had
            ? `${theme.ICON.ok} *Weekly song drop is off for this chat.* You can still ask with *.weekly*.`
            : `${theme.ICON.leaf} *This chat was not on the weekly drop.*`
        );
      }

      /* ---- what is coming ---- */
      if (['next', 'upcoming', 'preview'].includes(first)) {
        const p = weekly.nextPick(rest || '');
        if (!p) return extra.reply(`${theme.ICON.cross} *No category called "${rest}".* Try *.weekly* to see them.`);
        return extra.reply(
          `${theme.header('Next week')}\n` +
          `${theme.row(p.emoji, p.song.title, `${p.song.artist} · ${p.song.year}`)}\n` +
          `${theme.line(`_${p.label} · week ${p.week}_`)}\n` +
          theme.footer(`Ask for it early: *.weekly ${p.key}*`)
        );
      }

      /* ---- owner: who is subscribed, and force a send ---- */
      if (['status', 'subs', 'who'].includes(first)) {
        if (!extra.isOwner) return extra.reply(`${theme.ICON.cross} *Owner only.*`);
        const s = weekly.status();
        const rows = weekly.subscribers().slice(0, 10);
        let out = `${theme.header('Weekly drop')}\n`;
        out += `${theme.row(theme.ICON.chart, 'This week', s.week)}\n`;
        out += `${theme.row(theme.ICON.leaf, 'Chats following', `${s.subscribers} / ${s.maxSubscribers}`)}\n`;
        out += `${theme.row(theme.ICON.ok, 'Delivered', String(s.deliveredThisWeek))}\n`;
        out += `${theme.row(theme.ICON.clock, 'Timer', s.running ? 'running' : 'not running')}\n`;
        if (rows.length) {
          out += `${theme.divider()}\n`;
          for (const r of rows) {
            out += `${theme.line(`• ${r.name || 'chat'} · ${String(r.jid).split('@')[0]}`)}\n`;
          }
        }
        if (s.lastError) out += `${theme.line(`${theme.ICON.warn} ${s.lastError}`)}\n`;
        out += theme.footer('*.weekly send* delivers this week\'s song now.');
        return extra.reply(out);
      }

      if (['send', 'broadcast'].includes(first)) {
        if (!extra.isOwner) return extra.reply(`${theme.ICON.cross} *Owner only.*`);
        const res = await weekly.deliver(sock, { force: true });
        return extra.reply(
          `${theme.ICON.ok} *Weekly drop sent.*\n` +
          `${theme.line(`Week ${res.week} · ${res.sent} sent · ${res.failed} failed · ${res.skipped} left for the timer`)}`
        );
      }

      /* ---- the catalog ---- */
      if (['all', 'list', 'categories', 'menu'].includes(first)) {
        return extra.reply(categoryMenu());
      }

      /* ---- a song ---- */
      const p = pickFor(args.join(' '));
      if (!p) {
        return extra.reply(
          `${theme.ICON.cross} *No category called "${args.join(' ')}".*\n` +
          `${theme.line(`Try: ${weekly.categories().map((c) => c.key).join(', ')}`)}`
        );
      }

      const subscribed = weekly.isSubscribed(chatId);
      let out = weekly.card(p, { footer: false });
      out += `\n────────────────────\n`;
      out += `💡 *.song ${p.song.title}* sends the audio here\n`;
      out += subscribed
        ? `🔔 Weekly drop is on · *.weekly off* to stop\n`
        : `🔔 *.weekly on* gets one every week\n`;
      out += `> ${theme.ICON.bug} *Ladybug Mini* · Ntandomods`;

      if (extra.react) {
        try { await extra.react(p.emoji); } catch (e) { /* cosmetic */ }
      }
      await extra.reply(out);
    } catch (error) {
      await extra.reply(`${theme.ICON.cross} *Could not pick a song:* ${error.message}`);
    }
  },
};

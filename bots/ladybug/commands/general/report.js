/**
 * Report Command — `.bug`, `.feature`, `.feedback`
 * Made under Ntandomods
 *
 * A bot that cannot be complained to is a bot nobody trusts. These three
 * commands give anyone in any chat a single, obvious way to say "this is
 * broken" or "please add this", and give the owner a reference number to quote
 * back. Everything lands in the owner's Activity feed in the web console and in
 * a local file the bot can list with `.reports`.
 *
 * Note: `.bug` used to print a random ladybug fact. That moved to
 * `.ladybugfact` — a fact command and a complaint command cannot share a name.
 */

const theme = require('../../utils/ladybugTheme');
const reports = require('../../utils/reports');

const MAX_WORDS = 1200;

/** Pull the text of the message being replied to, if there is one. */
function quotedText(msg) {
  const ctx = msg && msg.message && msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo;
  const q = ctx && ctx.quotedMessage;
  if (!q) return '';
  const body =
    q.conversation ||
    (q.extendedTextMessage && q.extendedTextMessage.text) ||
    (q.imageMessage && q.imageMessage.caption) ||
    (q.videoMessage && q.videoMessage.caption) ||
    '';
  return reports.clean(body, 300);
}

function describe(kind) {
  if (kind === 'feature') {
    return {
      title: 'Feature request',
      noun: 'idea',
      hint: 'Tell me what you wish the bot could do.',
      example: '.feature add a command that converts voice notes to text',
      thanks: 'Noted — that is a good idea to put in front of the owner.',
    };
  }
  if (kind === 'feedback') {
    return {
      title: 'Feedback',
      noun: 'feedback',
      hint: 'Tell me how the bot is doing — good or bad.',
      example: '.feedback the menu is clear, but replies are slow at night',
      thanks: 'Thank you — honest feedback is how this gets better.',
    };
  }
  return {
    title: 'Bug report',
    noun: 'bug',
    hint: 'Tell me what went wrong, and what you expected instead.',
    example: '.bug .sticker fails on videos longer than 10 seconds',
    thanks: 'Sorry about that — the owner will see this.',
  };
}

function build(kind, { msg, args, extra }) {
  const info = describe(kind);
  const text = reports.clean(args.join(' '), MAX_WORDS);
  const quoted = quotedText(msg);

  if (!text && !quoted) {
    let out = `${theme.header(info.title)}\n`;
    out += `${theme.line(`${theme.ICON.bug} ${info.hint}`)}\n`;
    out += `${theme.divider()}\n`;
    out += `${theme.row(theme.ICON.leaf, 'Example', info.example)}\n`;
    out += `${theme.row(theme.ICON.chart, 'Tip', 'reply to the message that broke, then send the command')}\n`;
    out += theme.footer();
    return extra.reply(out);
  }

  const body = quoted && text ? `${text}\n\n(about: "${quoted}")` : text || `(about: "${quoted}")`;

  let saved;
  try {
    saved = reports.add({
      kind,
      text: body,
      from: extra.from,
      sender: extra.sender,
      name: extra.pushName || '',
      group: extra.isGroup && extra.groupMetadata ? extra.groupMetadata.subject : '',
    });
  } catch (e) {
    return extra.reply(`${theme.ICON.cross} *Could not save that:* ${e.message}`);
  }

  if (extra.react) {
    const emoji = kind === 'bug' ? '🐞' : kind === 'feature' ? '💡' : '💬';
    Promise.resolve(extra.react(emoji)).catch(() => {});
  }

  let out = `${theme.header(info.title)}\n`;
  out += `${theme.line(`${theme.ICON.ok} ${info.thanks}`)}\n`;
  out += `${theme.divider()}\n`;
  out += `${theme.row(theme.ICON.tag, 'Reference', `*${saved.id}*`)}\n`;
  out += `${theme.row(theme.ICON.chart, 'Status', saved.sent ? 'delivered to the owner' : 'saved on this bot')}\n`;
  out += `${theme.row(theme.ICON.clock, 'When', new Date(saved.at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC')}\n`;
  out += `${theme.divider()}\n`;
  out += `${theme.line(`Quote *${saved.id}* if you want to follow up.`)}\n`;
  out += theme.footer();
  return extra.reply(out);
}

module.exports = [
  {
    name: 'bug',
    aliases: ['reportbug', 'report', 'issue', 'broken'],
    category: 'general',
    description: 'Report a bug to the bot owner',
    usage: '.bug <what went wrong>',
    async execute(sock, msg, args, extra) {
      try {
        await build('bug', { msg, args, extra });
      } catch (error) {
        await extra.reply(`${theme.ICON.cross} *Could not file that report:* ${error.message}`);
      }
    },
  },
  {
    name: 'feature',
    aliases: ['suggest', 'idea', 'request', 'featurerequest', 'wish'],
    category: 'general',
    description: 'Request a new feature',
    usage: '.feature <your idea>',
    async execute(sock, msg, args, extra) {
      try {
        await build('feature', { msg, args, extra });
      } catch (error) {
        await extra.reply(`${theme.ICON.cross} *Could not file that request:* ${error.message}`);
      }
    },
  },
  {
    name: 'feedback',
    aliases: ['rate', 'review'],
    category: 'general',
    description: 'Send feedback about the bot',
    usage: '.feedback <your thoughts>',
    async execute(sock, msg, args, extra) {
      try {
        await build('feedback', { msg, args, extra });
      } catch (error) {
        await extra.reply(`${theme.ICON.cross} *Could not send that feedback:* ${error.message}`);
      }
    },
  },
];

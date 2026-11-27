/**
 * Poll Command — `.poll Question | option one | option two`
 * Made under Ntandomods
 *
 * WhatsApp's own poll message, which is far better than the "react 1 or 2"
 * workaround people use in groups. Native polls also survive in chat history
 * and show live counts, so this is a genuine upgrade for any group admin.
 */

const theme = require('../../utils/ladybugTheme');

const MAX_OPTIONS = 12;
const MAX_LABEL = 100;
const MAX_QUESTION = 255;

/** Split on "|" so options can contain spaces. */
function parse(input) {
  const parts = String(input || '')
    .split('|')
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return { question: parts[0] || '', options: parts.slice(1) };
}

module.exports = {
  parse,
  name: 'poll',
  aliases: ['vote', 'survey'],
  category: 'general',
  description: 'Create a native WhatsApp poll',
  usage: '.poll Question | option 1 | option 2 | ...',

  async execute(sock, msg, args, extra) {
    try {
      const { question, options } = parse(args.join(' '));

      if (!question || options.length < 2) {
        let out = `${theme.header('Poll')}\n`;
        out += `${theme.line(`${theme.ICON.chart} Separate the question and each option with *|*.`)}\n`;
        out += `${theme.divider()}\n`;
        out += `${theme.row(theme.ICON.leaf, 'Usage', '.poll Question | option 1 | option 2')}\n`;
        out += `${theme.row(theme.ICON.sparkle, 'Example', '.poll Where should we meet? | Harare CBD | Avondale | Borrowdale')}\n`;
        out += `${theme.row(theme.ICON.tag, 'Limits', `${MAX_OPTIONS} options, ${MAX_LABEL} characters each`)}\n`;
        out += theme.footer();
        return extra.reply(out);
      }

      if (options.length > MAX_OPTIONS) {
        return extra.reply(`${theme.ICON.cross} *Too many options:* ${options.length}. WhatsApp allows ${MAX_OPTIONS}.`);
      }

      const values = options.map((o) => o.slice(0, MAX_LABEL));
      await sock.sendMessage(extra.from, {
        poll: {
          name: question.slice(0, MAX_QUESTION),
          values,
          selectableCount: 1,
        },
      }, { quoted: msg });

      if (extra.react) {
        try { await extra.react('📊'); } catch (e) { /* cosmetic */ }
      }
    } catch (error) {
      await extra.reply(`${theme.ICON.cross} *Could not create the poll:* ${error.message}`);
    }
  },
};

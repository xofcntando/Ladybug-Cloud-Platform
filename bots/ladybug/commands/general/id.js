/**
 * ID Command — `.id`
 * Made under Ntandomods
 *
 * Every "how do I whitelist this group" or "why is the bot ignoring this chat"
 * question ends in the same place: someone needs the JID. This prints it,
 * plainly, with the parts that actually matter for admin commands.
 */

const theme = require('../../utils/ladybugTheme');

function number(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

module.exports = {
  name: 'id',
  aliases: ['jid', 'chatid', 'whoami'],
  category: 'general',
  description: 'Show the JIDs for this chat and sender',
  usage: '.id (or reply to someone)',

  async execute(sock, msg, args, extra) {
    try {
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const quoted = ctx?.participant || ctx?.remoteJid || '';

      let out = `${theme.header('Identifiers')}\n`;
      out += `${theme.row(theme.ICON.chart, 'Chat', extra.from)}\n`;
      out += `${theme.row(theme.ICON.leaf, 'Chat type', extra.isGroup ? 'group' : 'private chat')}\n`;
      out += `${theme.row(theme.ICON.bug, 'You', extra.sender)}\n`;
      out += `${theme.row(theme.ICON.tag, 'Your number', `+${number(extra.sender)}`)}\n`;

      if (extra.isGroup && extra.groupMetadata) {
        out += `${theme.row(theme.ICON.sparkle, 'Group name', extra.groupMetadata.subject || 'unnamed')}\n`;
        out += `${theme.row(theme.ICON.chart, 'Members', String((extra.groupMetadata.participants || []).length))}\n`;
      }
      if (quoted) {
        out += `${theme.divider()}\n`;
        out += `${theme.row(theme.ICON.spot, 'Replied to', quoted)}\n`;
      }

      out += `${theme.divider()}\n`;
      out += `${theme.line('*Copy the whole JID* — the part after @ matters.')}\n`;
      out += theme.footer();
      await extra.reply(out);
    } catch (error) {
      await extra.reply(`${theme.ICON.cross} *Could not read that:* ${error.message}`);
    }
  },
};

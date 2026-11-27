/**
 * Reports Command — `.reports`
 * Made under Ntandomods
 *
 * The other half of `.bug` and `.feature`: the owner needs to read what came in
 * without opening a laptop. Owner-only, and it reads the same local file the
 * report commands write, so it works on a bare self-hosted bot too.
 */

const theme = require('../../utils/ladybugTheme');
const reports = require('../../utils/reports');

const MAX_SHOW = 8;

function when(ts) {
  const mins = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function who(row) {
  const name = row.name ? `${row.name} ` : '';
  const num = String(row.sender || '').split('@')[0];
  const where = row.group ? ` in ${row.group}` : '';
  return `${name}${num ? '+' + num : 'unknown'}${where}`.trim();
}

module.exports = {
  name: 'reports',
  aliases: ['bugs', 'requests', 'inbox'],
  category: 'owner',
  description: 'Read bug reports and feature requests',
  usage: '.reports [bug|feature|feedback] | .reports clear [kind]',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const first = String(args[0] || '').toLowerCase();
      const counts = reports.counts();

      if (first === 'clear') {
        const kind = String(args[1] || '').toLowerCase();
        const removed = reports.clear(kind || '');
        return extra.reply(
          `${theme.ICON.ok} *Cleared ${removed} ${kind ? kind + ' ' : ''}report${removed === 1 ? '' : 's'}.*`
        );
      }

      const filter = ['bug', 'feature', 'feedback'].includes(first) ? first : '';
      const rows = reports.list({ kind: filter, limit: MAX_SHOW });

      let out = `${theme.header(filter ? filter + ' reports' : 'Report inbox')}\n`;
      out += `${theme.row(theme.ICON.bug, 'Bugs', String(counts.bug))}\n`;
      out += `${theme.row(theme.ICON.sparkle, 'Requests', String(counts.feature))}\n`;
      out += `${theme.row(theme.ICON.leaf, 'Feedback', String(counts.feedback))}\n`;

      if (!rows.length) {
        out += `${theme.divider()}\n`;
        out += `${theme.line('Nothing here yet. People can file one with *.bug* or *.feature*.')}\n`;
        out += theme.footer();
        return extra.reply(out);
      }

      for (const row of rows) {
        out += `${theme.divider()}\n`;
        out += `${theme.line(`*${row.id}* · ${when(row.at)}`)}\n`;
        out += `${theme.line(row.text)}\n`;
        out += `${theme.line(`_${who(row)}_`)}\n`;
      }

      out += `${theme.divider()}\n`;
      out += `${theme.line(`Showing ${rows.length} of ${counts.total}.`)}\n`;
      out += `${theme.line('*.reports bug* to filter · *.reports clear* to empty')}\n`;
      out += theme.footer();
      await extra.reply(out);
    } catch (error) {
      await extra.reply(`${theme.ICON.cross} *Could not read the inbox:* ${error.message}`);
    }
  },
};

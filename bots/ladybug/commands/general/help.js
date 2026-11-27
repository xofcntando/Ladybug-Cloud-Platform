/**
 * Help Command — `.help <command>`
 * Made under Ntandomods
 *
 * The menu has always ended with "Type .help <command> for more info", but
 * `.help` was only an alias of the menu itself, so that promise was never kept.
 * This keeps it: one command, one page, usage, aliases and category.
 */

const config = require('../../config');
const theme = require('../../utils/ladybugTheme');
const { loadCommands } = require('../../utils/commandLoader');

/** Cheap edit distance — enough to suggest ".sticker" when someone types ".stiker". */
function distance(a, b) {
  const s = String(a);
  const t = String(b);
  const rows = s.length + 1;
  const cols = t.length + 1;
  const grid = Array.from({ length: rows }, (_, i) => {
    const row = new Array(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j += 1) grid[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      grid[i][j] = Math.min(grid[i - 1][j] + 1, grid[i][j - 1] + 1, grid[i - 1][j - 1] + cost);
    }
  }
  return grid[rows - 1][cols - 1];
}

/** Command names (not aliases) closest to what the user typed. */
function suggest(all, needle) {
  const names = [...new Set([...all.values()].map((c) => c && c.name).filter(Boolean))];
  return names
    .map((n) => ({ n, d: distance(n, needle) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(needle.length / 2)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.n);
}

module.exports = {
  name: 'help',
  aliases: ['h', 'howto'],
  category: 'general',
  description: 'Show detailed help for one command',
  usage: '.help <command>',

  async execute(sock, msg, args, extra) {
    try {
      const all = loadCommands();
      const prefix = config.prefix || '.';
      const needle = String(args[0] || '').trim().toLowerCase().replace(/^[./!#]/, '');

      // No argument: the menu is the right answer, and it is already built.
      if (!needle) {
        const menu = all.get('menu');
        if (menu) return menu.execute(sock, msg, [], extra);
        return extra.reply(`${theme.ICON.bug} Type ${prefix}list to see every command.`);
      }

      const cmd = all.get(needle);
      if (!cmd) {
        const near = suggest(all, needle);
        let out = `${theme.header('Help')}\n`;
        out += `${theme.line(`${theme.ICON.cross} There is no command called *${needle}*.`)}\n`;
        if (near.length) {
          out += `${theme.divider()}\n`;
          out += `${theme.line('*Did you mean:*')}\n`;
          for (const n of near) out += `${theme.line(`• ${prefix}${n}`)}\n`;
        }
        out += `${theme.divider()}\n`;
        out += `${theme.row(theme.ICON.leaf, 'All commands', `${prefix}list`)}\n`;
        out += theme.footer();
        return extra.reply(out);
      }

      const aliases = (cmd.aliases || []).filter(Boolean);
      let out = `${theme.header(cmd.name)}\n`;
      out += `${theme.line(`${theme.ICON.sparkle} ${cmd.description || 'No description yet.'}`)}\n`;
      out += `${theme.divider()}\n`;
      out += `${theme.row(theme.ICON.leaf, 'Usage', cmd.usage || `${prefix}${cmd.name}`)}\n`;
      out += `${theme.row(theme.ICON.tag, 'Category', cmd.category || 'general')}\n`;
      if (aliases.length) {
        out += `${theme.row(theme.ICON.chart, 'Also called', aliases.map((a) => prefix + a).join(', '))}\n`;
      }
      if (cmd.ownerOnly) out += `${theme.row(theme.ICON.crown, 'Who', 'bot owner only')}\n`;
      else if (cmd.adminOnly) out += `${theme.row(theme.ICON.crown, 'Who', 'group admins only')}\n`;
      else out += `${theme.row(theme.ICON.crown, 'Who', 'everyone')}\n`;
      out += `${theme.divider()}\n`;
      out += `${theme.line(`Prefix is *${prefix}* — change it with ${prefix}setprefix`)}\n`;
      out += theme.footer();
      return extra.reply(out);
    } catch (error) {
      await extra.reply(`${theme.ICON.cross} *Help failed:* ${error.message}`);
    }
  },
};

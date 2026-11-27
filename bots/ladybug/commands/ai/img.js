/**
 * Image Command — `.img <what you want to see>`
 * Made under Ntandomods
 *
 * One image command for the whole bot. It replaces the old `.imagine` (which
 * was hard-wired to a single third-party key) with a provider chain in
 * utils/imageGen.js: your own endpoint first if you configured one, then a
 * key-free public service so the command works out of the box.
 */

const theme = require('../../utils/ladybugTheme');
const imageGen = require('../../utils/imageGen');

const EXAMPLES = [
  'a ladybug on a dew-covered leaf, macro photo',
  'a neon cyberpunk street in Harare at night',
  'a logo for a coffee shop called Morning Bug, flat vector',
  'a watercolour painting of a baobab tree at sunset',
];

module.exports = {
  name: 'img',
  aliases: ['image', 'imagine', 'draw', 'art', 'pic', 'gen', 'magic', 'aiimage', 'generate'],
  category: 'ai',
  description: 'Generate an image from a text prompt',
  usage: '.img <prompt> [--wide|--tall|--square] [--seed=123]',

  async execute(sock, msg, args, extra) {
    const opts = imageGen.parseArgs(args);

    if (!opts.prompt) {
      let text = `${theme.header('Image')}\n`;
      text += `${theme.line(`${theme.ICON.sparkle} Describe the picture and I will draw it.`)}\n`;
      text += `${theme.divider()}\n`;
      text += `${theme.row(theme.ICON.leaf, 'Usage', '.img <prompt>')}\n`;
      text += `${theme.row(theme.ICON.chart, 'Shape', 'add --wide or --tall (default square)')}\n`;
      text += `${theme.row(theme.ICON.spot, 'Repeat', 'add --seed=42 to reproduce a result')}\n`;
      text += `${theme.divider()}\n`;
      text += `${theme.line('*Try one of these:*')}\n`;
      for (const ex of EXAMPLES) text += `${theme.line(`• ${ex}`)}\n`;
      text += theme.footer();
      return extra.reply(text);
    }

    const started = Date.now();
    let note = null;
    try {
      if (extra.react) await extra.react('🎨');
      // A short acknowledgement matters: generation can take 10-30 seconds and
      // silence makes people send the command again.
      note = await extra.reply(`${theme.ICON.sparkle} *Painting that now…* (this can take a few seconds)`);

      const out = await imageGen.generate(opts.prompt, { size: opts.size, seed: opts.seed });
      const size = imageGen.SIZES[opts.size] || imageGen.SIZES.square;

      const caption =
        `${theme.ICON.sparkle} *${opts.prompt}*\n\n` +
        `${theme.ICON.chart} ${size.label} • ${theme.humanMs(Date.now() - started)}\n` +
        theme.signature();

      await sock.sendMessage(extra.from, { image: out.buffer, mimetype: out.mime, caption }, { quoted: msg });

      // Remove the "painting now" placeholder so the chat stays clean.
      if (note && note.key) {
        try { await sock.sendMessage(extra.from, { delete: note.key }); } catch (e) { /* not fatal */ }
      }
      if (extra.react) await extra.react('✅');
    } catch (error) {
      if (extra.react) await extra.react('❌');
      if (note && note.key) {
        try { await sock.sendMessage(extra.from, { delete: note.key }); } catch (e) { /* not fatal */ }
      }

      let text = `${theme.header('Image failed')}\n`;
      text += `${theme.line(`${theme.ICON.cross} ${error.message}`)}\n`;
      text += `${theme.divider()}\n`;
      text += `${theme.line('*What to try:*')}\n`;
      text += `${theme.line('• Send it again — free services are flaky.')}\n`;
      text += `${theme.line('• Simpler words usually work better than a paragraph.')}\n`;
      text += `${theme.line('• Owners: set LADYBUG_IMG_URL + LADYBUG_IMG_KEY for a reliable provider.')}\n`;
      text += theme.footer();
      await extra.reply(text);
    }
  },
};

/**
 * Wiki Command — `.wiki <topic>`
 * Made under Ntandomods
 *
 * Wikipedia's REST summary endpoint needs no key and returns one clean
 * paragraph, which is exactly the right shape for a chat reply. No scraping, no
 * HTML to strip, no API bill.
 */

const axios = require('axios');
const theme = require('../../utils/ladybugTheme');

const MAX_CHARS = 900;

/** Wikipedia wants underscores, and it 404s on punctuation-heavy titles. */
function slug(input) {
  return String(input || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[?#]/g, '');
}

function shorten(text, max = MAX_CHARS) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return stop > 200 ? cut.slice(0, stop + 1) : cut.trimEnd() + '…';
}

module.exports = {
  name: 'wiki',
  aliases: ['wikipedia', 'wik'],
  category: 'general',
  description: 'Look up a topic on Wikipedia',
  usage: '.wiki <topic>',

  async execute(sock, msg, args, extra) {
    const topic = args.join(' ').trim();
    if (!topic) {
      return extra.reply(`${theme.ICON.bug} *Usage:* .wiki <topic>\n\nExample: .wiki Zimbabwe`);
    }

    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug(topic))}`;
      const { data } = await axios.get(url, {
        timeout: 12000,
        headers: {
          'User-Agent': 'LadybugMini/2.0 (+https://github.com/xfntando/Ladybug-Cloud-Platform)',
          Accept: 'application/json',
        },
        validateStatus: (s) => s >= 200 && s < 300,
      });

      if (!data || data.type === 'disambiguation' || !data.extract) {
        return extra.reply(`${theme.ICON.cross} *"${topic}"* is ambiguous on Wikipedia. Try a more specific name.`);
      }

      let out = `${theme.header(data.title || topic)}\n`;
      out += `${theme.line(shorten(data.extract))}\n`;
      out += `${theme.divider()}\n`;
      if (data.description) out += `${theme.row(theme.ICON.tag, 'In short', data.description)}\n`;
      const link = (data.content_urls && data.content_urls.mobile && data.content_urls.mobile.page) ||
        (data.content_urls && data.content_urls.desktop && data.content_urls.desktop.page) || '';
      if (link) out += `${theme.row(theme.ICON.leaf, 'Read more', link)}\n`;
      out += theme.footer();
      await extra.reply(out);
    } catch (error) {
      const status = error.response && error.response.status;
      if (status === 404) {
        return extra.reply(`${theme.ICON.cross} Nothing on Wikipedia for *${topic}*. Check the spelling?`);
      }
      await extra.reply(`${theme.ICON.cross} *Wikipedia lookup failed:* ${error.message}`);
    }
  },
};

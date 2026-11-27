/**
 * Define Command — `.define <word>`
 * Made under Ntandomods
 *
 * Wiktionary's REST API is free, key-less and — unlike dictionaryapi.dev, which now
 * sits behind a Cloudflare challenge — reachable from a plain server. It returns the
 * same useful things: parts of speech, definitions and example sentences. The text
 * arrives as HTML fragments, so tags are stripped before anything is sent to a chat.
 */

const axios = require('axios');
const theme = require('../../utils/ladybugTheme');

const MAX_DEFS = 3;
const MAX_CHARS = 320;
const API = 'https://en.wiktionary.org/api/rest_v1/page/definition/';

/** Wiktionary returns HTML; a chat bubble wants plain text. */
function plain(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tidy(text, max = MAX_CHARS) {
  const t = plain(text);
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
}

module.exports = {
  plain,
  tidy,
  name: 'define',
  aliases: ['dict', 'meaning', 'dictionary'],
  category: 'general',
  description: 'Look up a word in the dictionary',
  usage: '.define <word>',

  async execute(sock, msg, args, extra) {
    const word = args.join(' ').trim().toLowerCase();
    if (!word) {
      return extra.reply(`${theme.ICON.bug} *Usage:* .define <word>\n\nExample: .define serendipity`);
    }

    try {
      const { data } = await axios.get(API + encodeURIComponent(word), {
        timeout: 12000,
        headers: { 'User-Agent': 'LadybugMini/2.0 (+https://github.com/xfntando/Ladybug-Cloud-Platform)', Accept: 'application/json' },
        validateStatus: (s) => s >= 200 && s < 300,
      });

      // Wiktionary groups by language; English is what a `.define` caller means.
      const groups = Array.isArray(data && data.en) ? data.en : [];
      if (!groups.length) {
        return extra.reply(`${theme.ICON.cross} I could not find *${word}*. Check the spelling?`);
      }

      let out = `${theme.header(word)}\n`;
      let shown = 0;
      for (const group of groups) {
        for (const def of group.definitions || []) {
          if (shown >= MAX_DEFS) break;
          const body = tidy(def.definition);
          if (!body) continue;
          out += `${theme.divider()}\n`;
          out += `${theme.row(theme.ICON.tag, group.partOfSpeech || 'word', body)}\n`;
          const example = def.parsedExamples && def.parsedExamples[0] && def.parsedExamples[0].example;
          if (example) out += `${theme.line(`${theme.ICON.leaf} _"${tidy(example, 160)}"_`)}\n`;
          shown += 1;
        }
        if (shown >= MAX_DEFS) break;
      }

      if (!shown) {
        return extra.reply(`${theme.ICON.cross} *${word}* has no definitions listed.`);
      }
      out += theme.footer();
      await extra.reply(out);
    } catch (error) {
      const status = error.response && error.response.status;
      if (status === 404) {
        return extra.reply(`${theme.ICON.cross} *${word}* is not in the dictionary. Check the spelling?`);
      }
      await extra.reply(`${theme.ICON.cross} *Dictionary lookup failed:* ${error.message}`);
    }
  },
};

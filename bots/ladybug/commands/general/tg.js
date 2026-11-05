/**
 * Telegram sticker pack → WhatsApp stickers
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('../../utils/ffmpeg').getFfmpegPath() || 'ffmpeg';
const config = require('../../config');
const { writeExifImg } = require('../../utils/exif');
const { tgsToWebp } = require('../../utils/tgsToWebp');
const { getTempDir, deleteTempFile } = require('../../utils/tempManager');

const tgApi = (token, method, params) =>
  axios.get(`https://api.telegram.org/bot${token}/${method}`, { params, timeout: 30000 });

function parseStickerNumbers(parts) {
  if (!parts.length) return null;
  const nums = [];
  for (const bit of parts.join(' ').split(/[\s,]+/)) {
    const n = parseInt(bit, 10);
    if (Number.isInteger(n) && n > 0) nums.push(n);
  }
  return nums.length ? [...new Set(nums)].sort((a, b) => a - b) : null;
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args);
    const err = [];
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(Buffer.concat(err).toString().slice(0, 300)))));
  });
}

async function downloadTelegramFile(token, fileId) {
  const { data } = await tgApi(token, 'getFile', { file_id: fileId });
  const filePath = data.result?.file_path;
  if (!filePath) throw new Error('Could not get file path');
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return { buffer: Buffer.from(res.data), ext: path.extname(filePath).toLowerCase() };
}

async function toWhatsAppSticker(rawBuffer, ext, tempDir, tag) {
  const packname = config.packname || 'Ladybug Mini';
  const inp = path.join(tempDir, `${tag}_in${ext || '.bin'}`);
  const out = path.join(tempDir, `${tag}.webp`);

  try {
    if (ext === '.webp') {
      return writeExifImg(rawBuffer, { packname });
    }

    if (ext === '.tgs') {
      await tgsToWebp(rawBuffer, out, tempDir, tag);
      if (!fs.existsSync(out)) throw new Error('Animated WebP conversion failed');
      return writeExifImg(fs.readFileSync(out), { packname });
    }

    fs.writeFileSync(inp, rawBuffer);

    const animated = ext === '.webm' || ext === '.mp4';
    const vf = animated
      ? 'scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000'
      : 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000';

    await ffmpeg([
      '-y', '-i', inp,
      '-vf', vf,
      '-c:v', 'libwebp',
      '-loop', '0',
      '-vsync', '0',
      '-pix_fmt', 'yuva420p',
      '-quality', '75',
      '-compression_level', '6',
      out,
    ]);

    return writeExifImg(fs.readFileSync(out), { packname });
  } finally {
    deleteTempFile(inp);
    deleteTempFile(out);
  }
}

module.exports = {
  name: 'tgsticker',
  aliases: ['tg', 'tgs', 'telegramsticker'],
  category: 'general',
  description: 'Download Telegram sticker pack (all or by number)',
  usage: '.tg <url> [numbers]',

  async execute(sock, msg, args, extra) {
    try {
      const text = msg.message?.conversation?.trim()
        || msg.message?.extendedTextMessage?.text?.trim()
        || '';
      const urlArgs = text.split(/\s+/).slice(1);

      if (!urlArgs[0]) {
        return extra.reply(
          '⚠️ `.tg <url>` — all\n`.tg <url> 23` — one\n`.tg <url> 4,35,78` — pick numbers'
        );
      }

      if (!urlArgs[0].includes('t.me/addstickers/')) {
        return extra.reply('❌ Use a link like https://t.me/addstickers/PackName');
      }

      const packName = urlArgs[0].replace(/^https:\/\/t\.me\/addstickers\//i, '').trim();
      const BOT_TOKEN = String(config.apiKeys.telegram || '').trim();
      if (!BOT_TOKEN) {
        return extra.reply('❌ Set apiKeys.telegram in config.js (@BotFather)');
      }

      const { data: apiData } = await tgApi(BOT_TOKEN, 'getStickerSet', { name: packName });
      if (!apiData?.ok || !apiData.result?.stickers?.length) {
        throw new Error(apiData?.description || 'Sticker pack not found');
      }

      const stickers = apiData.result.stickers;
      const pickNums = parseStickerNumbers(urlArgs.slice(1));
      let indices;

      if (pickNums) {
        const bad = pickNums.filter((n) => n > stickers.length);
        if (bad.length) {
          return extra.reply(`❌ Invalid: ${bad.join(', ')}. Pack has ${stickers.length} stickers.`);
        }
        indices = pickNums.map((n) => n - 1);
      } else {
        indices = stickers.map((_, i) => i);
      }

      const label = pickNums ? `#${pickNums.join(', #')}` : `${indices.length} stickers`;
      if (indices.length === 1) {
        await extra.react('⏳');
      } else {
        await extra.reply(`📦 ${label} — downloading...`);
      }

      const tempDir = getTempDir();
      let ok = 0;

      for (const i of indices) {
        try {
          const sticker = stickers[i];
          const { buffer, ext } = await downloadTelegramFile(BOT_TOKEN, sticker.file_id);
          const finalBuffer = await toWhatsAppSticker(buffer, ext, tempDir, `tg_${Date.now()}_${i}`);
          await sock.sendMessage(extra.from, { sticker: finalBuffer });
          ok++;
          if (indices.length > 1) await new Promise((r) => setTimeout(r, 400));
        } catch (err) {
          console.error(`[tg] sticker ${i + 1}:`, err.message);
        }
      }

      if (ok && indices.length === 1) {
        await extra.react('✅');
      } else if (!ok) {
        await extra.reply('❌ Could not convert any sticker');
      }
    } catch (error) {
      console.error('[tg]', error.message);
      const msg = error?.response?.status === 401
        ? 'Invalid Telegram token — fix apiKeys.telegram in config.js'
        : (error.message || 'Failed');
      await extra.reply(`❌ ${msg}`);
    }
  },
};

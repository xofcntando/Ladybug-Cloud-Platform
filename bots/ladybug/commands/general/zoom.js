/**
 * Zoom a sticker in from all four sides.
 * Each run zooms a bit more. Output stays a 512x512 sticker.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const webp = require('node-webpmux');
const sharp = require('sharp');
const ffmpegPath = require('../../utils/ffmpeg').getFfmpegPath() || 'ffmpeg';
const config = require('../../config');
const { getTempDir, deleteTempFile } = require('../../utils/tempManager');

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const INSET = 0.08;

function zoomBox(width, height) {
  const left = Math.floor(width * INSET);
  const top = Math.floor(height * INSET);
  let boxW = width - (left * 2);
  let boxH = height - (top * 2);
  const evenLeft = left - (left % 2);
  const evenTop = top - (top % 2);
  boxW -= boxW % 2;
  boxH -= boxH % 2;
  if (boxW < 8 || boxH < 8) return null;
  return { left: evenLeft, top: evenTop, width: boxW, height: boxH };
}

async function zoomStill(buffer) {
  const meta = await sharp(buffer, { animated: false, pages: 1 }).rotate().metadata();
  const box = zoomBox(meta.width, meta.height);
  let pipeline = sharp(buffer, { animated: false, pages: 1 }).rotate();
  if (box) pipeline = pipeline.extract(box);
  return pipeline.resize(512, 512, { fit: 'fill' }).webp({ quality: 80 }).toBuffer();
}

async function zoomAnimated(buffer, tempOutput, tempFiles, tmpDir, stamp) {
  const meta = await sharp(buffer, { animated: true }).metadata();
  const pages = Math.max(1, Math.min(meta.pages || 1, 80));
  const framesDir = path.join(tmpDir, `zoomframes_${stamp}`);
  fs.mkdirSync(framesDir, { recursive: true });
  const first = await sharp(buffer, { page: 0 }).metadata();
  const box = zoomBox(first.width, first.height);

  for (let i = 0; i < pages; i++) {
    let pipeline = sharp(buffer, { page: i });
    if (box) pipeline = pipeline.extract(box);
    const framePath = path.join(framesDir, `frame_${String(i).padStart(4, '0')}.png`);
    await pipeline.resize(512, 512, { fit: 'fill' }).png().toFile(framePath);
    tempFiles.push(framePath);
  }

  const delays = Array.isArray(meta.delay) ? meta.delay.filter((n) => n > 0) : [];
  const avgMs = delays.length ? delays.reduce((sum, n) => sum + n, 0) / delays.length : 80;
  const fps = String(Math.max(4, Math.min(20, Math.round(1000 / avgMs))));

  await runFfmpeg([
    '-y',
    '-framerate', fps,
    '-i', path.join(framesDir, 'frame_%04d.png'),
    '-c:v', 'libwebp',
    '-loop', '0',
    '-pix_fmt', 'yuva420p',
    '-quality', '45',
    '-an',
    tempOutput,
  ]);

  try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch { /* already gone */ }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args, { windowsHide: true });
    const logs = [];
    ff.stderr.on('data', (chunk) => logs.push(chunk));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(logs).toString().slice(-600) || `ffmpeg exited ${code}`));
    });
  });
}

const getQuotedMessage = (message) =>
  message.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
  message.message?.buttonsResponseMessage?.contextInfo?.quotedMessage ||
  message.message?.listResponseMessage?.contextInfo?.quotedMessage ||
  null;

const resolveMedia = (message) => {
  const messageType = Object.keys(message.message || {})[0];
  if (messageType === 'imageMessage' || messageType === 'stickerMessage' || messageType === 'videoMessage') {
    return { type: messageType, media: message.message[messageType] };
  }
  const quoted = getQuotedMessage(message);
  if (!quoted) return null;
  const quotedType = Object.keys(quoted || {})[0];
  if (quotedType === 'imageMessage' || quotedType === 'stickerMessage' || quotedType === 'videoMessage') {
    return { type: quotedType, media: quoted[quotedType] };
  }
  return null;
};

module.exports = {
  name: 'zoom',
  aliases: ['zoomin'],
  description: 'Zoom a sticker in from all four sides. Run it again to zoom further. Stays 512x512.',
  usage: ',zoom (reply to a sticker)',
  category: 'general',

  async execute(sock, msg, args, extra) {
    const tmpDir = getTempDir();
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tempInput = path.join(tmpDir, `zoom_in_${stamp}`);
    const tempOutput = path.join(tmpDir, `zoom_out_${stamp}.webp`);
    const tempFiles = [tempInput, tempOutput];

    try {
      let targetMessage = msg;
      if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
        const quotedInfo = msg.message.extendedTextMessage.contextInfo;
        targetMessage = {
          key: {
            remoteJid: extra.from,
            id: quotedInfo.stanzaId,
            participant: quotedInfo.participant
          },
          message: quotedInfo.quotedMessage
        };
      }

      const mediaInfo = resolveMedia(targetMessage);
      if (!mediaInfo) {
        return extra.reply('🔍 Reply to a *sticker* (or image) with ,zoom.');
      }

      const mediaBuffer = await downloadMediaMessage(
        targetMessage,
        'buffer',
        {},
        { logger: undefined, reuploadRequest: sock.updateMediaMessage }
      );
      if (!mediaBuffer) return extra.reply('❌ Failed to download that sticker.');
      if (mediaBuffer.length > MAX_FILE_SIZE) {
        return extra.reply('❌ File is too large to zoom.');
      }

      const isVideo = mediaInfo.type === 'videoMessage';
      let webpBuffer;

      if (!isVideo) {
        let frameCount = 0;
        try {
          const probe = new webp.Image();
          await probe.load(mediaBuffer);
          frameCount = probe.frames?.length || 0;
        } catch { /* static image */ }

        const animated = mediaInfo.type === 'stickerMessage' && (
          mediaInfo.media?.isAnimated ||
          mediaInfo.media?.mimetype?.includes('animated') ||
          frameCount > 1
        );

        if (animated) {
          await zoomAnimated(mediaBuffer, tempOutput, tempFiles, tmpDir, stamp);
          webpBuffer = fs.readFileSync(tempOutput);
        } else {
          webpBuffer = await zoomStill(mediaBuffer);
        }
      } else {
        const inputPath = `${tempInput}.mp4`;
        tempFiles.push(inputPath);
        fs.writeFileSync(inputPath, mediaBuffer);
        await runFfmpeg([
          '-y', '-i', inputPath, '-t', '3',
          '-vf', 'crop=trunc(iw*0.84/2)*2:trunc(ih*0.84/2)*2:(iw-ow)/2:(ih-oh)/2,scale=512:512',
          '-c:v', 'libwebp', '-loop', '0', '-an', '-pix_fmt', 'yuva420p', '-quality', '50',
          tempOutput,
        ]);
        webpBuffer = fs.readFileSync(tempOutput);
      }

      const img = new webp.Image();
      await img.load(webpBuffer);
      const json = {
        'sticker-pack-id': crypto.randomBytes(32).toString('hex'),
        'sticker-pack-name': config.packname || 'Made by',
        'emojis': ['🔍']
      };
      const exifAttr = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
      const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
      const exif = Buffer.concat([exifAttr, jsonBuffer]);
      exif.writeUIntLE(jsonBuffer.length, 14, 4);
      img.exif = exif;

      await sock.sendMessage(extra.from, {
        sticker: await img.save(null)
      }, { quoted: msg });
    } catch (error) {
      console.error('Zoom command error:', error);
      await extra.reply('❌ Failed to zoom that sticker.');
    } finally {
      tempFiles.forEach((file) => deleteTempFile(file));
    }
  }
};

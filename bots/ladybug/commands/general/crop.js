/**
 * Crop Command
 * Crop any sticker/image/video into a perfect square sticker (animated for videos)
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

// Max file size: 50MB
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const getQuotedMessage = (message) =>
  message.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
  message.message?.buttonsResponseMessage?.contextInfo?.quotedMessage ||
  message.message?.listResponseMessage?.contextInfo?.quotedMessage ||
  null;

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

/** Pixels that are transparent or near-black are padding, not the picture. */
async function contentBox(frameBuffer) {
  const { data, info } = await sharp(frameBuffer, { animated: false, pages: 1 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = channels > 3 ? data[i + 3] : 255;
      if (a < 20 || (r < 40 && g < 40 && b < 40)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX) return null;

  let left = minX - (minX % 2);
  let top = minY - (minY % 2);
  let right = maxX + 1;
  let bottom = maxY + 1;
  if ((right - left) % 2) right += 1;
  if ((bottom - top) % 2) bottom += 1;
  if (right > width) right = width - (width % 2);
  if (bottom > height) bottom = height - (height % 2);
  const boxW = right - left;
  const boxH = bottom - top;
  if (boxW < 8 || boxH < 8) return null;
  if (boxW >= width - 4 && boxH >= height - 4) return null;
  return { left, top, width: boxW, height: boxH };
}

async function coverStill(buffer, { trimPadding = false } = {}) {
  let pipeline = sharp(buffer, { animated: false, pages: 1 }).rotate();
  if (trimPadding) {
    const box = await contentBox(buffer);
    if (box) pipeline = pipeline.extract(box);
  }
  return pipeline.resize(512, 512, { fit: 'cover', position: 'centre' }).webp({ quality: 80 }).toBuffer();
}

async function animatedStickerToWebp(mediaBuffer, tempOutput, tempFiles, tmpDir, stamp) {
  const meta = await sharp(mediaBuffer, { animated: true }).metadata();
  const pages = Math.min(meta.pages || 1, 24);
  const framesDir = path.join(tmpDir, `cropframes_${stamp}`);
  fs.mkdirSync(framesDir, { recursive: true });

  const first = await sharp(mediaBuffer, { page: 0 }).png().toBuffer();
  const box = await contentBox(first);

  for (let i = 0; i < pages; i++) {
    let pipeline = sharp(mediaBuffer, { page: i });
    if (box) pipeline = pipeline.extract(box);
    const framePath = path.join(framesDir, `frame_${String(i).padStart(4, '0')}.png`);
    await pipeline.resize(512, 512, { fit: 'cover', position: 'centre' }).png().toFile(framePath);
    tempFiles.push(framePath);
  }

  await runFfmpeg([
    '-y',
    '-framerate', '12',
    '-i', path.join(framesDir, 'frame_%04d.png'),
    '-c:v', 'libwebp',
    '-loop', '0',
    '-pix_fmt', 'yuva420p',
    '-quality', '45',
    '-an',
    tempOutput,
  ]);

  try { fs.rmdirSync(framesDir); } catch { /* frames already removed */ }
}

const resolveMedia = (message) => {
  const messageType = Object.keys(message.message || {})[0];
  if (messageType === 'imageMessage' || messageType === 'stickerMessage' || messageType === 'videoMessage' || messageType === 'documentMessage') {
    return { type: messageType, media: message.message[messageType] };
  }
  const quoted = getQuotedMessage(message);
  if (!quoted) return null;
  const quotedType = Object.keys(quoted || {})[0];
  if (quotedType === 'imageMessage' || quotedType === 'stickerMessage' || quotedType === 'videoMessage' || quotedType === 'documentMessage') {
    return { type: quotedType, media: quoted[quotedType] };
  }
  return null;
};

module.exports = {
  name: 'crop',
  aliases: ['square', 'cropper'],
  description: 'Crop sticker/image/video to a perfect square sticker (animated for videos)',
  usage: '.crop (reply to sticker/image/video)',
  category: 'general',
  
  async execute(sock, msg, args, extra) {
    const tmpDir = getTempDir();
    const stamp = Date.now();
    const tempOutput = path.join(tmpDir, `crop_${stamp}.webp`);
    const tempFiles = [tempOutput];
    let tempInput = path.join(tmpDir, `temp_${stamp}`);
    
    try {
      // The message that will be quoted in the reply
      const messageToQuote = msg;
      
      // The message object that contains the media to be downloaded
      let targetMessage = msg;

      // If the message is a reply, the target media is in the quoted message
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
        return extra.reply('✂️ Reply to a *sticker*, *image*, or *video* that you want to crop.');
      }

      const { type, media } = mediaInfo;
      const mediaMessage = media;

      if (!mediaMessage) {
        return extra.reply('✂️ Please reply to an image/video/sticker with .crop, or send an image/video/sticker with .crop as the caption.');
      }

      // Download media
      const mediaBuffer = await downloadMediaMessage(
        targetMessage,
        'buffer',
        {},
        { logger: undefined, reuploadRequest: sock.updateMediaMessage }
      );

      if (!mediaBuffer) {
        return extra.reply('❌ Failed to download media. Please try again.');
      }

      // Check file size
      if (mediaBuffer.length > MAX_FILE_SIZE) {
        return extra.reply(`❌ File too large: ${(mediaBuffer.length / 1024 / 1024).toFixed(2)}MB (max: ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
      }

      const isVideo = type === 'videoMessage' ||
        mediaMessage.mimetype?.includes('gif') ||
        mediaMessage.mimetype?.includes('video') ||
        mediaMessage.seconds > 0;

      if (type === 'stickerMessage') {
        let frameCount = 0;
        try {
          const probe = new webp.Image();
          await probe.load(mediaBuffer);
          frameCount = probe.frames?.length || 0;
        } catch { /* static sticker */ }

        const animatedSticker = !!(
          mediaMessage.isAnimated ||
          mediaMessage.mimetype?.includes('animated') ||
          frameCount > 1
        );

        if (animatedSticker) {
          await animatedStickerToWebp(mediaBuffer, tempOutput, tempFiles, tmpDir, stamp);
        } else {
          fs.writeFileSync(tempOutput, await coverStill(mediaBuffer, { trimPadding: true }));
        }
      } else if (!isVideo) {
        // Portrait photos were staying full height while WhatsApp padded the sides black.
        fs.writeFileSync(tempOutput, await coverStill(mediaBuffer));
      } else {
        tempInput = path.join(tmpDir, `temp_${stamp}.mp4`);
        tempFiles.push(tempInput);
        fs.writeFileSync(tempInput, mediaBuffer);
        const seconds = mediaBuffer.length > 5 * 1024 * 1024 ? '2' : '3';
        const fps = mediaBuffer.length > 5 * 1024 * 1024 ? '8' : '12';
        await runFfmpeg([
          '-y',
          '-i', tempInput,
          '-t', seconds,
          '-vf', `scale=512:512:force_original_aspect_ratio=increase,crop=512:512,fps=${fps}`,
          '-c:v', 'libwebp',
          '-loop', '0',
          '-an',
          '-pix_fmt', 'yuva420p',
          '-quality', '50',
          tempOutput,
        ]);
      }

      // Check if output file exists and has content
      if (!fs.existsSync(tempOutput)) {
        throw new Error('FFmpeg failed to create output file');
      }

      const outputStats = fs.statSync(tempOutput);
      if (outputStats.size === 0) {
        throw new Error('FFmpeg created empty output file');
      }

      // Read the WebP file
      let webpBuffer = fs.readFileSync(tempOutput);
      
      // Check final file size
      const finalSizeKB = webpBuffer.length / 1024;
      console.log(`Final sticker size: ${Math.round(finalSizeKB)} KB`);
      
      // If still too large, we'll send it anyway but log a warning
      if (finalSizeKB > 1000) { // 1MB limit for WhatsApp stickers
        console.log(`⚠️ Warning: Sticker size (${Math.round(finalSizeKB)} KB) exceeds recommended limit but will be sent anyway`);
      }

      // Add metadata using webpmux
      const img = new webp.Image();
      await img.load(webpBuffer);

      // Create metadata
      const json = {
        'sticker-pack-id': crypto.randomBytes(32).toString('hex'),
        'sticker-pack-name': config.packname || 'Made by',
        'emojis': ['✂️']
      };

      // Create exif buffer
      const exifAttr = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
      const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
      const exif = Buffer.concat([exifAttr, jsonBuffer]);
      exif.writeUIntLE(jsonBuffer.length, 14, 4);

      // Set the exif data
      img.exif = exif;

      // Get the final buffer with metadata
      const finalBuffer = await img.save(null);

      // Send the sticker
      await sock.sendMessage(extra.from, { 
        sticker: finalBuffer
      }, { quoted: messageToQuote });

    } catch (error) {
      console.error('Crop command error:', error);
      await extra.reply('❌ Failed to crop sticker! Try with an image or video.');
    } finally {
      // Always cleanup temp files
      tempFiles.forEach(file => deleteTempFile(file));
    }
  }
};

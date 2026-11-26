/**
 * Waifu Command - Get random waifu anime images
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getTempDir, deleteTempFile } = require('../../utils/tempManager');
const { fitWhatsAppImage } = require('../../utils/fitImage');
const config = require('../../config');

const animeApi = require('../../utils/animeApi');

module.exports = {
  name: 'waifu',
  aliases: ['waifusfw'],
  category: 'anime',
  desc: 'Get random waifu SFW anime images',
  usage: 'waifu',
  execute: async (sock, msg, args, extra) => {
    try {
      // Fetch JSON from API to get image URL (current /v1 API, legacy fallback)
      const result = await animeApi.get('/v1/anime/image', '/api/anime/waifu', { category: 'waifu' });
      const imageUrl = typeof result === 'string' ? result : (result?.url || result?.image);
      
      if (!imageUrl || typeof imageUrl !== 'string') {
        throw new Error('Invalid image URL in API response');
      }
      
      // Download image from the URL
      const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'LadybugMini/1.0',
          'Accept': 'image/*'
        },
        timeout: 30000
      });
      
      let imageBuffer = Buffer.from(imageResponse.data);
      
      // Verify buffer is valid
      if (!imageBuffer || imageBuffer.length === 0) {
        throw new Error('Empty image response');
      }

      imageBuffer = await fitWhatsAppImage(imageBuffer);
      
      // Determine file extension from URL or content type
      const contentType = imageResponse.headers['content-type'] || '';
      let extension = 'jpg';
      if (contentType.includes('png')) {
        extension = 'png';
      } else if (contentType.includes('jpeg')) {
        extension = 'jpg';
      } else if (imageUrl.match(/\.(png|jpg|jpeg)$/i)) {
        const match = imageUrl.match(/\.(png|jpg|jpeg)$/i);
        extension = match[1].toLowerCase();
      }
      
      // Write to temp file first, then read back to ensure buffer is valid
      const tempDir = getTempDir();
      const timestamp = Date.now();
      const tempImagePath = path.join(tempDir, `waifu_${timestamp}.${extension}`);
      
      let finalBuffer = null;
      
      try {
        // Write buffer to temp file
        fs.writeFileSync(tempImagePath, imageBuffer);
        
        // Read back from file to ensure buffer is properly formed
        finalBuffer = fs.readFileSync(tempImagePath);
        
        if (!finalBuffer || finalBuffer.length === 0) {
          throw new Error('Failed to read image from temp file');
        }
        
        // Send the image
        await sock.sendMessage(extra.from, {
          image: finalBuffer
        }, { quoted: msg });
        
      } finally {
        // Cleanup temp file
        try {
          deleteTempFile(tempImagePath);
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
      }
      
    } catch (error) {
      const status = error.response?.status;
      const reason = error.response?.data?.result?.error
        || error.response?.data?.message
        || error.message;
      console.error(`[waifu] ${status || error.code || 'error'}: ${reason}`);

      if (status === 404) {
        await extra.reply('❌ Image not found. Try again.');
      } else if (status === 429) {
        await extra.reply('❌ Ladybug API limit reached. Try again in a minute.');
      } else if (error.code === 'ECONNABORTED' || String(error.message).includes('timeout')) {
        await extra.reply('❌ Request timed out. Try again.');
      } else {
        await extra.reply(`❌ Could not fetch waifu image. ${reason}`);
      }
    }
  }
};


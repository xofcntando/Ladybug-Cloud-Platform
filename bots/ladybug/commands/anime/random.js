/**
 * Random Command - Get random anime data
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getTempDir, deleteTempFile } = require('../../utils/tempManager');
const { fitWhatsAppImage } = require('../../utils/fitImage');
const config = require('../../config');

const animeApi = require('../../utils/animeApi');

module.exports = {
  name: 'random',
  aliases: ['animerandom', 'randomanime'],
  category: 'anime',
  desc: 'Get random anime data',
  usage: 'random',
  execute: async (sock, msg, args, extra) => {
    try {
      const result = await animeApi.get('/v1/anime/random', '/api/anime/random');
      if (!result) {
        throw new Error('Invalid API response: missing anime data');
      }

      // Image-style payload (same shape as neko/waifu) has no title
      const directUrl = typeof result === 'string' ? result : (result.url || result.image);
      const animeData = typeof result === 'string'
        ? { thumbnail: result }
        : { ...result, thumbnail: result.thumbnail || result.image || result.url };

      if (directUrl && !animeData.title && !animeData.synopsis && !animeData.episodes) {
        const imageResponse = await axios.get(directUrl, {
          responseType: 'arraybuffer',
          headers: { 'User-Agent': 'LadybugMini/1.0', 'Accept': 'image/*' },
          timeout: 30000
        });
        let imageBuffer = Buffer.from(imageResponse.data);
        if (!imageBuffer.length) throw new Error('Empty image response');
        imageBuffer = await fitWhatsAppImage(imageBuffer);
        await sock.sendMessage(extra.from, { image: imageBuffer }, { quoted: msg });
        return;
      }
      
      // Download thumbnail image
      let imageBuffer = null;
      if (animeData.thumbnail) {
        try {
          const imageResponse = await axios.get(animeData.thumbnail, {
            responseType: 'arraybuffer',
            headers: {
              'User-Agent': 'LadybugMini/1.0',
              'Accept': 'image/*'
            },
            timeout: 30000
          });
          
          imageBuffer = Buffer.from(imageResponse.data);
          if (imageBuffer && imageBuffer.length > 0) {
            imageBuffer = await fitWhatsAppImage(imageBuffer);
          }
        } catch (imgError) {
          console.error('Error downloading thumbnail:', imgError);
          imageBuffer = null;
        }
      }
      
      // Build caption with anime info
      let caption = `*${animeData.title || 'Unknown'}*\n\n`;
      
      if (animeData.episodes) {
        caption += `📺 Episodes: ${animeData.episodes}\n`;
      }
      
      if (animeData.status) {
        caption += `📊 Status: ${animeData.status}\n`;
      }
      
      if (animeData.synopsis) {
        caption += `\n📝 ${animeData.synopsis}\n`;
      }
      
      if (animeData.link) {
        caption += `\n🔗 ${animeData.link}`;
      }
      
      // Send with image if available
      if (imageBuffer) {
        const contentType = 'image/jpeg';
        let extension = 'jpg';
        if (animeData.thumbnail.match(/\.(png|jpg|jpeg)$/i)) {
          const match = animeData.thumbnail.match(/\.(png|jpg|jpeg)$/i);
          extension = match[1].toLowerCase();
        }
        
        const tempDir = getTempDir();
        const timestamp = Date.now();
        const tempImagePath = path.join(tempDir, `anime_${timestamp}.${extension}`);
        
        try {
          fs.writeFileSync(tempImagePath, imageBuffer);
          const finalBuffer = fs.readFileSync(tempImagePath);
          
          await sock.sendMessage(extra.from, {
            image: finalBuffer,
            caption: caption
          }, { quoted: msg });
          
        } finally {
          try {
            deleteTempFile(tempImagePath);
          } catch (cleanupError) {
          }
        }
      } else {
        // Send text only if no image
        await sock.sendMessage(extra.from, {
          text: caption
        }, { quoted: msg });
      }
      
    } catch (error) {
      const status = error.response?.status;
      const reason = error.response?.data?.result?.error
        || error.response?.data?.message
        || error.message;
      console.error(`[random] ${status || error.code || 'error'}: ${reason}`);

      if (status === 404) {
        await extra.reply('❌ Anime not found. Try again.');
      } else if (status === 429) {
        await extra.reply('❌ Ladybug API limit reached. Try again in a minute.');
      } else if (error.code === 'ECONNABORTED' || String(error.message).includes('timeout')) {
        await extra.reply('❌ Request timed out. Try again.');
      } else {
        await extra.reply(`❌ Could not fetch anime. ${reason}`);
      }
    }
  }
};


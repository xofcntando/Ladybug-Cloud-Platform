/**
 * Menu Command - Display all available commands
 */

const config = require('../../config');
const database = require('../../database');
const { loadCommands } = require('../../utils/commandLoader');

module.exports = {
  name: 'menu',
  // `.help` belongs to commands/general/help.js, which falls back to this menu
  // when it is called with no argument.
  aliases: ['commands', 'cmds'],
  category: 'general',
  description: 'Show all available commands',
  usage: '.menu',
  
  async execute(sock, msg, args, extra) {
    try {
      const commands = loadCommands();
      const categories = {};
      
      // Group commands by category
      commands.forEach((cmd, name) => {
        if (cmd.name === name) { // Only count main command names, not aliases
          if (!categories[cmd.category]) {
            categories[cmd.category] = [];
          }
          categories[cmd.category].push(cmd);
        }
      });
      
      const ownerNames = Array.isArray(config.ownerName) ? config.ownerName : [config.ownerName];
      const displayOwner = ownerNames[0] || config.ownerName || 'Bot Owner';
      
      let menuText = `╭───「 🐞 *${config.botName}* 」───╮\n\n`;
      menuText += `│ 👋 Hello @${extra.sender.split('@')[0]}!\n`;
      menuText += `│ 🐞 The garden is open.\n\n`;
      menuText += `│ ⚡ *Prefix:* ${config.prefix}\n`;
      menuText += `│ 📦 *Commands:* ${commands.size}\n`;
      menuText += `│ 👑 *Owner:* ${displayOwner}\n`;
      menuText += `│ 🏷️ *Brand:* ${config.brand || 'Ntandomods'}\n`;
      menuText += `│ ⏱️ *Awake:* ${Math.floor(process.uptime() / 60)}m\n\n`;
      
      // General Commands
      if (categories.general) {
        menuText += `┏━━━━━━━━━━━━━━━━━\n`;
        menuText += `┃ 🧭 GENERAL COMMAND\n`;
        menuText += `┗━━━━━━━━━━━━━━━━━\n`;
        categories.general.forEach(cmd => {
          menuText += `│ ➜ ${config.prefix}${cmd.name}\n`;
        });
        menuText += `\n`;
      }
      
      // AI Commands
      if (categories.ai) {
        menuText += `┏━━━━━━━━━━━━━━━━━\n`;
        menuText += `┃ 🤖 AI COMMAND\n`;
        menuText += `┗━━━━━━━━━━━━━━━━━\n`;
        categories.ai.forEach(cmd => {
          menuText += `│ ➜ ${config.prefix}${cmd.name}\n`;
        });
        menuText += `\n`;
      }
      
      // Group Commands
      if (categories.group) {
        menuText += `┏━━━━━━━━━━━━━━━━━\n`;
        menuText += `┃ 🔵 GROUP COMMAND\n`;
        menuText += `┗━━━━━━━━━━━━━━━━━\n`;
        categories.group.forEach(cmd => {
          menuText += `│ ➜ ${config.prefix}${cmd.name}\n`;
        });
        menuText += `\n`;
      }
      
      // Admin Commands
      if (categories.admin) {
        menuText += `┏━━━━━━━━━━━━━━━━━\n`;
        menuText += `┃ 🛡️ ADMIN COMMAND\n`;
        menuText += `┗━━━━━━━━━━━━━━━━━\n`;
        categories.admin.forEach(cmd => {
          menuText += `│ ➜ ${config.prefix}${cmd.name}\n`;
        });
        menuText += `\n`;
      }
      
      // Owner Commands
      if (categories.owner) {
        menuText += `┏━━━━━━━━━━━━━━━━━\n`;
        menuText += `┃ 👑 OWNER COMMAND\n`;
        menuText += `┗━━━━━━━━━━━━━━━━━\n`;
        categories.owner.forEach(cmd => {
          menuText += `│ ➜ ${config.prefix}${cmd.name}\n`;
        });
        menuText += `\n`;
      }
      
      // Media Commands
      if (categories.media) {
        menuText += `┏━━━━━━━━━━━━━━━━━\n`;
        menuText += `┃ 🎞️ MEDIA COMMAND\n`;
        menuText += `┗━━━━━━━━━━━━━━━━━\n`;
        categories.media.forEach(cmd => {
          menuText += `│ ➜ ${config.prefix}${cmd.name}\n`;
        });
        menuText += `\n`;
      }
      
      // Fun Commands (exclude economy/betting games — those go under GAMES)
      const FUN_HIDE = new Set([
        'bomb', 'horse', 'slots', 'coinflip', 'rps', 'tictactoe',
      ]);
      if (categories.fun) {
        const funCmds = categories.fun.filter((cmd) => !FUN_HIDE.has(cmd.name));
        if (funCmds.length) {
          menuText += `┏━━━━━━━━━━━━━━━━━\n`;
          menuText += `┃ 🎭 FUN COMMAND\n`;
          menuText += `┗━━━━━━━━━━━━━━━━━\n`;
          funCmds.forEach(cmd => {
            menuText += `│ ➜ ${config.prefix}${cmd.name}\n`;
          });
          menuText += `\n`;
        }
      }

      // Games — horse, slots, coinflip, rps, tictactoe, etc.
      const GAME_MENU_NAMES = [
        'bomb',
        'bet',
        'horse',
        'slots',
        'coinflip',
        'rps',
        'tictactoe',
        'fish',
        'hunt',
        'chop',
        'forage',
        'rpg',
      ];
      const gameLines = [];
      const gameSeen = new Set();
      for (const name of GAME_MENU_NAMES) {
        if (!commands.has(name) || gameSeen.has(name)) continue;
        gameSeen.add(name);
        gameLines.push(name);
      }
      if (categories.games) {
        for (const cmd of categories.games) {
          if (gameSeen.has(cmd.name)) continue;
          gameSeen.add(cmd.name);
          gameLines.push(cmd.name);
        }
      }
      if (gameLines.length) {
        menuText += `┏━━━━━━━━━━━━━━━━━\n`;
        menuText += `┃ 🎮 GAMES COMMAND\n`;
        menuText += `┗━━━━━━━━━━━━━━━━━\n`;
        gameLines.forEach((name) => {
          menuText += `│ ➜ ${config.prefix}${name}\n`;
        });
        menuText += `\n`;
      }

      // Economy Commands
      if (categories.economy) {
        const economyCmds = categories.economy.filter(
          (cmd) => !cmd.ownerOnly || extra.isOwner
        );
        if (economyCmds.length) {
          menuText += `┏━━━━━━━━━━━━━━━━━\n`;
          menuText += `┃ 💰 ECONOMY COMMAND\n`;
          menuText += `┗━━━━━━━━━━━━━━━━━\n`;
          economyCmds.forEach(cmd => {
            menuText += `│ ➜ ${config.prefix}${cmd.name}\n`;
          });
          menuText += `\n`;
        }
      }
      
      // Utility Commands
      if (categories.utility) {
        menuText += `┏━━━━━━━━━━━━━━━━━\n`;
        menuText += `┃ 🔧 UTILITY COMMAND\n`;
        menuText += `┗━━━━━━━━━━━━━━━━━\n`;
        categories.utility.forEach(cmd => {
          menuText += `│ ➜ ${config.prefix}${cmd.name}\n`;
        });
        menuText += `\n`;
      }

       // Anime Commands
       if (categories.anime) {
        menuText += `┏━━━━━━━━━━━━━━━━━\n`;
        menuText += `┃ 👾 ANIME COMMAND\n`;
        menuText += `┗━━━━━━━━━━━━━━━━━\n`;
        categories.anime.forEach(cmd => {
          menuText += `│ ➜ ${config.prefix}${cmd.name}\n`;
        });
        menuText += `\n`;
      }

       // Textmaker Commands
       if (categories.textmaker) {
        menuText += `┏━━━━━━━━━━━━━━━━━\n`;
        menuText += `┃ 🖋️ TEXTMAKER COMMAND\n`;
        menuText += `┗━━━━━━━━━━━━━━━━━\n`;
        categories.textmaker.forEach(cmd => {
          menuText += `│ ➜ ${config.prefix}${cmd.name}\n`;
        });
        menuText += `\n`;
      }
      
      // Ladybug Commands (themed core commands)
      if (categories.ladybug) {
        menuText += `┏─────────────────\n`;
        menuText += `┃ 🐞 LADYBUG COMMAND\n`;
        menuText += `┗─────────────────\n`;
        categories.ladybug.forEach(cmd => {
          menuText += `│ ➜ ${config.prefix}${cmd.name}\n`;
        });
        menuText += `\n`;
      }

      menuText += `╰━━━━━━━━━━━━━━━━━\n\n`;
      menuText += `💡 Type ${config.prefix}help <command> for more info\n`;
      menuText += `> 🐞 *${config.botName}* v2.0.0 • ${config.brand || 'Ntandomods'}\n`;
      
      // Send menu with image
      const fs = require('fs');
      const path = require('path');
      const imagePath = path.join(__dirname, '../../utils/bot_image.jpg');
      
      if (fs.existsSync(imagePath)) {
        // Send image with newsletter forwarding context
        const imageBuffer = fs.readFileSync(imagePath);
        await sock.sendMessage(extra.from, {
          image: imageBuffer,
          caption: menuText,
          mentions: [extra.sender],
          contextInfo: {
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
              newsletterJid: config.newsletterJid || '120363161513685998@newsletter',
              newsletterName: config.botName,
              serverMessageId: -1
            }
          }
        }, { quoted: msg });
      } else {
        await sock.sendMessage(extra.from, {
          text: menuText,
          mentions: [extra.sender]
        }, { quoted: msg });
      }
      
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};

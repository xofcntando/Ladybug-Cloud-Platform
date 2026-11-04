/**
 * Global Configuration for Ladybug Mini — a WhatsApp MD Bot
 * Made under Ntandomods
 */

module.exports = {
    // Bot Owner Configuration
    ownerNumber: process.env.OWNER_NUMBER ? process.env.OWNER_NUMBER.split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean) : ['9876543210'], // Add your number without + or spaces (e.g., 919876543210)
    ownerName: ['Ntandomods'], // Owner names corresponding to ownerNumber array

    // Bot Configuration
    botName: 'Ladybug Mini',
    brand: 'Ntandomods',
    prefix: process.env.PREFIX || '.',
    sessionName: process.env.SESSION_NAME || 'session', // the platform gives every bot its own folder
    sessionID: process.env.SESSION_ID || '', //Paste your session here
    newsletterJid: '120363161513685998@newsletter', // Newsletter JID for menu forwarding
    updateZipUrl: 'https://github.com/kids-codentando/Ladybug-Mini/archive/refs/heads/main.zip', // URL to latest code zip for .update command

        // Sticker Configuration
        packname: 'Ladybug Mini',

        // Bot Behavior
        selfMode: /^(1|true|yes|on)$/i.test(process.env.SELF_MODE || ''), // Private mode - only owner can use commands
        autoRead: false,
        autoTyping: false,
        autoBio: false,
        autoSticker: false,
        autoReact: false,
        autoReactMode: 'bot',
        autoDownload: false,

        // Group Settings Defaults
        defaultGroupSettings: {
          antilink: false,
          antilinkAction: 'delete', // 'delete', 'kick', 'warn'
          antitag: false,
          antitagAction: 'delete',
          antiall: false, // Owner only - blocks all messages from non-admins
          antiviewonce: false,
          antibot: false,
          antibotAction: 'warn', // 'warn' | 'kick'
          anticall: false, // Anti-call feature
          antigroupmention: false, // Anti-group mention feature
          antigroupmentionAction: 'delete', // 'delete', 'kick'
          antigroupstatus: false, // Block group status posts
          antigroupstatusAction: 'delete', // 'delete', 'kick'
          antisticker: false, // Stickers not allowed in group
          antistickerAction: 'delete', // 'delete', 'kick'
          antibadword: false, // Block bad words in group
          antibadwordAction: 'delete', // 'delete', 'kick', 'warn'
          welcome: false,
          welcomeMessage: '\u256d\u257c\u2501\u226a\u2022\ud835\ude7d\ud835\ude74\ud835\ude86 \ud835\ude7c\ud835\ude74\ud835\ude7c\ud835\ude71\ud835\ude74\ud835\ude81\u2022\u226b\u2501\u257e\u256e\\n\u2503\ud835\ude86\ud835\ude74\ud835\ude7b\ud835\ude72\ud835\ude7e\ud835\ude7c\ud835\ude74: @user \ud83d\udc4b\\n\u2503Member count: #memberCount\\n\u2503\ud835\ude83\ud835\ude78\ud835\ude7c\ud835\ude74: time\u23f0\\n\u2570\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u256f\\n\\n*@user* Welcome to *@group*! \ud83c\udf89\\n*Group \ud835\ude73\ud835\ude74\ud835\ude82\ud835\ude72\ud835\ude81\ud835\ude78\ud835\ude7f\ud835\ude83\ud835\ude78\ud835\ude7e\ud835\ude7d*\\ngroupDesc\\n\\n> *\u1d18\u1d0f\u1d21\u1d07\u0280\u1d07\u1d05 \u0299\u028f botName*',
          goodbye: false,
          goodbyeMessage: 'Goodbye @user \ud83d\udc4b We will never miss you!',
          antiSpam: false,
          antiSpamAction: 'warn', // 'warn' | 'kick'
          antidelete: false,
          detect: false,
          chatbot: false,
          suppress: false, // Members get no command reply; owner and admins still can
          autosticker: false // Auto-convert images/videos to stickers
        },

    // API Keys (add your own)
    apiKeys: {
      // Add API keys here if needed
      openai: '',
      deepai: '',
      remove_bg: ''
    },

      // Ladybug Mini media API (song/video/tiktok/facebook/instagram downloaders)
    // Change once here — all media commands read from this.
    mediaApiUrl: (process.env.YT_API_URL || 'https://api-xgp2.onrender.com').replace(/\/$/, ''),
    mediaApiKey: process.env.YT_API_KEY || 'knight',
    // Ladybug public API (reactions GIFs, etc.) — powered by Ntandomods
    ladybugApiUrl: (process.env.LADYBUG_API_URL || 'https://knightbotapi.stream').replace(/\/$/, ''),
    ladybugApiKey: process.env.LADYBUG_API_KEY || 'knight',
    // Backward-compatible aliases (older modules may still read these keys)
    knightApiUrl: (process.env.LADYBUG_API_URL || 'https://knightbotapi.stream').replace(/\/$/, ''),
    knightApiKey: process.env.LADYBUG_API_KEY || 'knight',
    princeApiUrl: (process.env.PRINCE_API_URL || 'https://api.princetechn.com').replace(/\/$/, ''),
    princeApiKey: process.env.PRINCE_API_KEY || 'prince',

    // Message Configuration
    messages: {
      wait: '\u23f3 Please wait...',
      success: '\u2705 Success!',
      error: '\u274c Error occurred!',
      ownerOnly: '\ud83d\udc51 This command is only for bot owner!',
      adminOnly: '\ud83d\udee1\ufe0f This command is only for group admins!',
      groupOnly: '\ud83d\udc65 This command can only be used in groups!',
      privateOnly: '\ud83d\udcac This command can only be used in private chat!',
      botAdminNeeded: '\ud83e\udd16 Bot needs to be admin to execute this command!',
      invalidCommand: '\u2753 Invalid command! Type .menu for help'
    },

    // Timezone
    timezone: 'Asia/Kolkata',

    // Limits
    maxWarnings: 3,

    // Social Links (optional)
    social: {
      github: 'https://github.com/Ntandomods',
      instagram: 'https://instagram.com/ntandomods',
      youtube: 'https://youtube.com/@ntandomods'
    }
};

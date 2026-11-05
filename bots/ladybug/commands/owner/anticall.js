/**
 * Anti-Call Command - Enable or disable anti-call system
 */

module.exports = {
  name: 'anticall',
  category: 'owner',
  ownerOnly: true,
  description: 'Enable or disable anti-call system',
  usage: '.anticall on/off',

  async execute(sock, msg, args, extra) {
    if (!args[0]) {
      return extra.reply('Usage: .anticall on/off');
    }

    const option = args[0].toLowerCase();

    if (!['on', 'off'].includes(option)) {
      return extra.reply('Usage: .anticall on/off');
    }

    const enabled = option === 'on';

    // Update the default setting in config
    const fs = require('fs');
    const path = require('path');
    const __rc = require('../../utils/runtimeConfig');
      const __next = option === 'on';
      __rc.set('anticall', __next);
      config.anticall = __next;
    try {
      
      // Clear the config cache so the next require gets the updated version
      delete require.cache[require.resolve('../../config')];
      
      await extra.reply(
        enabled
          ? '✅ Anti-call enabled. Calls will be auto-rejected & blocked.'
          : '❌ Anti-call disabled.'
      );
    } catch (err) {
      console.error('[anticall cmd] error:', err);
      extra.reply('❌ Error updating anti-call setting.');
    }
  }
};
/**
 * Ladybug Fact Command — Random ladybug facts
 * Made under Ntandomods
 *
 * This used to be `.bug`. `.bug` is now the bug-report command, which is the
 * more useful meaning of the word in a bot people rely on, so the facts live
 * here under a name that says what it does.
 */

const theme = require('../../utils/ladybugTheme');

// Real, checkable facts about Coccinellidae. Keeping them accurate matters:
// a bot that invents facts about its own mascot is just embarrassing.
const FACTS = [
  'A ladybug can eat up to 5,000 aphids in its lifetime.',
  'There are over 5,000 species of ladybug worldwide.',
  'Ladybugs are beetles, not bugs — order Coleoptera.',
  'Their bright red colour is a warning: "I taste terrible."',
  'When threatened, a ladybug can play dead and leak a bitter fluid from its leg joints.',
  'A ladybug beats its wings about 85 times per second in flight.',
  'Ladybugs can fly up to 60 km in a single journey.',
  'The spots fade with age — old ladybugs look washed out.',
  'Not all ladybugs are red; some are orange, yellow, black or even pink.',
  'Ladybugs hibernate in large clusters, sometimes thousands together.',
  'A newly hatched larva looks nothing like an adult — it resembles a tiny crocodile.',
  'Ladybugs taste with their feet.',
  'The seven-spot ladybird is the most common species in Europe.',
  'A ladybug can live for 2 to 3 years in the wild.',
  'Farmers release ladybugs as natural pest control instead of pesticides.',
  'Ladybugs bleed from their knees when stressed — the fluid is called hemolymph.',
  'The name "ladybug" comes from the Virgin Mary, "Our Lady".',
  'Ladybug larvae eat even more aphids than the adults do.',
  'They navigate using the sun and can be thrown off by artificial light.',
  'A ladybug folds its wings under hard covers called elytra.',
];

module.exports = {
  name: 'ladybugfact',
  aliases: ['bugfact', 'ladybugfacts', 'fact'],
  category: 'ladybug',
  description: 'Get a random ladybug fact',
  usage: '.ladybugfact',

  async execute(sock, msg, args, extra) {
    try {
      const fact = theme.pick(FACTS);
      const index = FACTS.indexOf(fact) + 1;

      let text = `${theme.header('Ladybug Fact')}\n`;
      text += `${theme.line(`${theme.ICON.bug} ${fact}`)}\n`;
      text += `${theme.divider()}\n`;
      text += `${theme.row(theme.ICON.chart, 'Fact', `${index} of ${FACTS.length}`)}\n`;
      text += theme.footer();

      await extra.reply(text);
    } catch (error) {
      await extra.reply(`${theme.ICON.cross} *Could not fetch a fact:* ${error.message}`);
    }
  },
};

/**
 * strategies/index.mjs — registry of selectable sim strategies.
 * Each strategy: { name, seedPolicy, qualifyNames, confirmEntry, exitParams }.
 */
import pullback from './pullback.mjs';
import openingRange from './opening-range.mjs';
import reversal from './reversal.mjs';
import breakout from './breakout.mjs';
import regimeSwitch from './regime-switch.mjs';

export const STRATEGIES = {
  [pullback.name]:    pullback,
  [openingRange.name]: openingRange,
  [reversal.name]:    reversal,
  [breakout.name]:    breakout,
  [regimeSwitch.name]: regimeSwitch,
};

export function getStrategy(name = 'pullback') {
  const s = STRATEGIES[name];
  if (!s) throw new Error(`unknown strategy "${name}" (have: ${Object.keys(STRATEGIES).join(', ')})`);
  return s;
}

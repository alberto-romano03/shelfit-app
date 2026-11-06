// Time told the way you'd say it: how long is left in a series, and when a film would end
// if you pressed play now. Settings, General tab, turns all of it off.

import { getPref } from './prefs.js';
import { t, locale } from './i18n.js';

export function timeHintsOn() {
  return getPref('timeHints');
}

// 157 → "2h 37m", 45 → "45m".
export function hoursAndMinutes(min) {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  if (!h) return `${m}m`;
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

// A rough figure, for a whole series: "about 19 hours left", then days past three of them.
export function roughlyLeft(min) {
  const hours = Math.round(min / 60);
  if (hours >= 72) return t('time.leftDays', { n: Math.round(hours / 24) });
  if (hours >= 2) return t('time.leftHours', { n: hours });
  if (hours === 1) return t('time.leftHour');
  return t('time.leftMinutes', { n: Math.max(1, Math.round(min)) });
}

export function endsAt(min) {
  return new Date(Date.now() + min * 60000).toLocaleTimeString(locale('en-GB'), {
    hour: '2-digit',
    minute: '2-digit',
  });
}

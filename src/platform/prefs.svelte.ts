/**
 * Language and theme, remembered between visits.
 *
 * Theme has three states, not two. "system" is the default and must stay a
 * real state: stamping data-theme on <html> for it would freeze whatever the OS
 * happened to be at first paint, and the page would stop following the OS when
 * it changes. So "system" removes the attribute and lets the media query win.
 */
import { STRINGS, fill, type StringKey } from './i18n';
import type { Locale } from '../tools/types';

export type ThemeChoice = 'light' | 'dark' | 'system';

const LOCALE_KEY = 'simplepdf.locale';
const THEME_KEY = 'simplepdf.theme';

function readLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved === 'th' || saved === 'en') return saved;
  } catch {
    /* private mode — fall through to the default */
  }
  // Thai always, until someone chooses otherwise. Sniffing navigator.language
  // sounds helpful but gets it wrong for the people this is actually for: a
  // Thai team on machines that ship with an en-US locale.
  return 'th';
}

function readTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    /* private mode — fall through */
  }
  return 'system';
}

class Prefs {
  locale = $state<Locale>(readLocale());
  theme = $state<ThemeChoice>(readTheme());

  constructor() {
    this.applyTheme();
  }

  setLocale(next: Locale) {
    this.locale = next;
    document.documentElement.lang = next;
    try {
      localStorage.setItem(LOCALE_KEY, next);
    } catch {
      /* nothing to do — the choice still holds for this session */
    }
  }

  toggleLocale() {
    this.setLocale(this.locale === 'th' ? 'en' : 'th');
  }

  setTheme(next: ThemeChoice) {
    this.theme = next;
    this.applyTheme();
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* as above */
    }
  }

  /** Steps light → dark → system, so one button reaches all three. */
  cycleTheme() {
    this.setTheme(this.theme === 'light' ? 'dark' : this.theme === 'dark' ? 'system' : 'light');
  }

  private applyTheme() {
    const root = document.documentElement;
    if (this.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', this.theme);
  }

  /** Look up an interface string in the current language. */
  t = (key: StringKey, params?: Record<string, string | number>): string =>
    fill(STRINGS[this.locale][key], params, this.locale);

  /** Pick the current language out of a { th, en } pair carried by tool metadata. */
  pick = (s: { th: string; en: string } | null | undefined): string => (s ? s[this.locale] : '');

  formatNumber = (n: number): string =>
    new Intl.NumberFormat(this.locale === 'th' ? 'th-TH' : 'en-US').format(n);
}

export const prefs = new Prefs();

<script lang="ts">
  import VersionBadge from '../../components/VersionBadge.svelte';
  import { prefs } from '../prefs.svelte';
  import { router } from '../router.svelte';

  interface Props {
    /** Shown in the middle when a tool is open. */
    title?: string;
    onback?: () => void;
  }
  let { title = '', onback }: Props = $props();

  const THEME_ICON = { light: '☀', dark: '☾', system: '◐' } as const;
</script>

<header>
  <button
    class="brand"
    onclick={() => router.home()}
    aria-label={prefs.t('home')}
  >
    <span class="mark" aria-hidden="true">◈</span>
    <span class="name">{prefs.t('brand')}</span>
  </button>

  {#if onback}
    <button class="ghost back" onclick={onback}>‹ {prefs.t('back')}</button>
  {/if}

  <span class="title">{title}</span>

  <VersionBadge />

  <button
    class="ghost pill"
    onclick={() => prefs.toggleLocale()}
    aria-label={prefs.t('language')}
    title={prefs.t('language')}
  >
    {prefs.locale === 'th' ? 'ไทย' : 'EN'}
  </button>

  <button
    class="ghost pill"
    onclick={() => prefs.cycleTheme()}
    aria-label="{prefs.t('theme')}: {prefs.t(
      prefs.theme === 'light' ? 'themeLight' : prefs.theme === 'dark' ? 'themeDark' : 'themeSystem',
    )}"
    title="{prefs.t('theme')}: {prefs.t(
      prefs.theme === 'light' ? 'themeLight' : prefs.theme === 'dark' ? 'themeDark' : 'themeSystem',
    )}"
  >
    <span aria-hidden="true">{THEME_ICON[prefs.theme]}</span>
  </button>
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-5);
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    min-height: 56px;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    border: none;
    background: none;
    /* 44px is the smallest thing a thumb reliably hits; the header controls
       were 34px tall and as narrow as 27px. */
    min-height: 44px;
    padding: var(--space-2) var(--space-3);
    color: var(--text);
    font-weight: 600;
    font-size: var(--fs-3);
  }
  .brand:hover { background: var(--surface-2); }
  .mark { color: var(--accent); font-size: var(--fs-3); }

  .back { flex: none; min-height: 44px; }

  .title {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    font-size: var(--fs-3);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pill {
    flex: none;
    min-width: 44px;
    min-height: 44px;
    padding: var(--space-2) var(--space-3);
    font-size: var(--fs-2);
    font-weight: 600;
    border: 1px solid var(--border);
  }

  @media (max-width: 640px) {
    header { gap: var(--space-2); padding: var(--space-2) var(--space-3); }
    .brand .name { display: none; }
    .title { font-size: var(--fs-2); }
  }
</style>

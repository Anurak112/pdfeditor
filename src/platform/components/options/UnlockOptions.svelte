<script lang="ts">
  /**
   * Settings for Unlock — which is one field, and a promise about it.
   *
   * The promise is the reason the note is on screen rather than in a help page.
   * Typing a password into a website is a thing people are right to hesitate
   * over, and every other site that offers this receives both the file and the
   * password on a server. Here neither leaves the tab, and saying so at the
   * moment of hesitation is worth more than saying it on the front page.
   *
   * Nothing stores it: no localStorage, no defaults carried between runs, and
   * the field starts empty every time the tool is opened.
   */
  import { prefs } from '../../prefs.svelte';
  import { session } from '../../session.svelte';
  import type { UnlockOptions } from '../../../tools/options';

  const o = $derived(session.options as UnlockOptions);
  let visible = $state(false);

  function set(password: string) {
    session.setOptions({ password });
  }
</script>

<div class="panel">
  <div class="field">
    <label for="unlock-password">{prefs.t('unlockPassword')}</label>
    <div class="entry">
      <!-- svelte-ignore a11y_autofocus -->
      {#if visible}
        <input
          id="unlock-password"
          type="text"
          autocomplete="off"
          spellcheck="false"
          value={o.password}
          placeholder={prefs.t('unlockPasswordPlaceholder')}
          oninput={(e) => set((e.currentTarget as HTMLInputElement).value)}
        />
      {:else}
        <input
          id="unlock-password"
          type="password"
          autocomplete="off"
          value={o.password}
          placeholder={prefs.t('unlockPasswordPlaceholder')}
          oninput={(e) => set((e.currentTarget as HTMLInputElement).value)}
        />
      {/if}
      <button
        class="ghost reveal"
        type="button"
        aria-pressed={visible}
        onclick={() => (visible = !visible)}
      >
        {visible ? prefs.t('unlockHide') : prefs.t('unlockShow')}
      </button>
    </div>
    <p class="hint">{prefs.t('unlockEmptyHint')}</p>
  </div>

  <p class="note">
    <span class="lock" aria-hidden="true">🔒</span>
    {prefs.t('unlockPrivacy')}
  </p>

  <p class="hint">{prefs.t('unlockScope')}</p>
</div>

<style>
  .panel { display: flex; flex-direction: column; gap: var(--space-4); }

  .field { display: flex; flex-direction: column; gap: var(--space-1); }
  .field label { font-size: var(--fs-1); font-weight: 600; color: var(--text-muted); }

  .entry { display: flex; gap: var(--space-2); }
  .entry input { flex: 1; min-width: 0; padding: var(--space-2) var(--space-3); font-size: var(--fs-2); }
  .reveal { flex: none; padding: var(--space-1) var(--space-3); font-size: var(--fs-1); }

  .note {
    margin: 0;
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    font-size: var(--fs-2);
    color: var(--text);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    line-height: 1.5;
  }
  .lock { flex: none; }

  .hint { margin: var(--space-1) 0 0; font-size: var(--fs-1); color: var(--text-faint); line-height: 1.5; }
</style>

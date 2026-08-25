<script lang="ts">
  /**
   * "A new version is ready" — and nothing happens until they say so.
   *
   * In the normal flow at the top of the page rather than floating over it.
   * The run bar is already pinned to the bottom of the screen on a phone, and a
   * second floating element would either cover it or fight it for the same
   * corner. This one pushes the page down instead, which cannot collide with
   * anything and cannot hide a control.
   *
   * The hint says the open file is cleared, because it is: reloading drops
   * everything in memory, and finding that out afterwards is a bad way to find
   * it out.
   */
  import { prefs } from '../prefs.svelte';
  import { updates } from '../updates.svelte';
</script>

{#if updates.available}
  <div class="banner" role="status">
    <div class="text">
      <strong>{prefs.t('updateTitle')}</strong>
      <span>{prefs.t('updateHint')}</span>
    </div>
    <div class="actions">
      <button class="ghost" onclick={() => updates.dismiss()} disabled={updates.applying}>
        {prefs.t('updateLater')}
      </button>
      <button class="primary" onclick={() => updates.apply()} disabled={updates.applying}>
        {updates.applying ? prefs.t('updateApplying') : prefs.t('updateApply')}
      </button>
    </div>
  </div>
{/if}

<style>
  .banner {
    /* Sits inside a flex column in both routes; without this it gets squeezed
       instead of pushing the page down. */
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3) var(--space-5);
    padding: var(--space-3) var(--space-6);
    background: var(--accent-soft);
    border-bottom: 1px solid var(--accent-line);
    font-size: var(--fs-2);
  }

  .text {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-3);
    min-width: 0;
  }
  .text strong { color: var(--text); font-weight: 600; }
  .text span { color: var(--text-muted); }

  .actions { display: flex; gap: var(--space-2); flex: none; }
  .actions button { padding: var(--space-2) var(--space-4); font-size: var(--fs-2); }

  @media (max-width: 599px) {
    .banner { padding: var(--space-3) var(--space-4); }
    /* Buttons to their own row, full width each, rather than a squeeze that
       puts a 40px tap target next to the edge of the screen. */
    .actions { width: 100%; }
    .actions button { flex: 1; }
  }
</style>

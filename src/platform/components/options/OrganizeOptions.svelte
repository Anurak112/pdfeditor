<script lang="ts">
  /**
   * Settings for Organize.
   *
   * Almost everything happens on the grid itself, so this panel is mostly a
   * mirror: what you have changed so far, and the way back out of it. Undo
   * matters more here than in any other tool — deleting pages is the one action
   * where a mis-click silently costs you something.
   */
  import { prefs } from '../../prefs.svelte';
  import { session } from '../../session.svelte';
  import { finalOrder } from '../../../engine/operations/organize';
  import type { OrganizeOptions, Quarter } from '../../../engine/operations/organize';

  const o = $derived(session.options as OrganizeOptions);
  const pageCount = $derived(session.files[0]?.pageCount ?? 0);
  const kept = $derived(finalOrder(pageCount, o).length);

  const rotatedCount = $derived(Object.values(o.rotations ?? {}).filter((r) => r % 360 !== 0).length);
  const moved = $derived(
    o.order.length > 0 && o.order.some((page, at) => page !== at),
  );
  const touched = $derived(rotatedCount > 0 || (o.deleted?.length ?? 0) > 0 || moved);

  function set(patch: Partial<OrganizeOptions>) {
    session.setOptions(patch);
  }

  function rotateAll(delta: 90 | -90) {
    const next: Record<number, Quarter> = { ...o.rotations };
    for (let i = 0; i < pageCount; i++) {
      next[i] = ((((next[i] ?? 0) + delta) % 360 + 360) % 360) as Quarter;
    }
    set({ rotations: next });
  }

  function reset() {
    set({ order: [], rotations: {}, deleted: [] });
  }
</script>

<div class="panel">
  <p class="hint">{prefs.t('organizeHint')}</p>

  <div class="state" aria-live="polite">
    {#if touched}
      <ul>
        {#if (o.deleted?.length ?? 0) > 0}
          <li>{prefs.t('organizeDeleted', { n: o.deleted.length })}</li>
        {/if}
        {#if rotatedCount > 0}
          <li>{prefs.t('organizeRotated', { n: rotatedCount })}</li>
        {/if}
        {#if moved}
          <li>{prefs.t('organizeMoved')}</li>
        {/if}
      </ul>
    {:else}
      <p class="quiet">{prefs.t('organizeNothing')}</p>
    {/if}
  </div>

  <div class="row">
    <span class="label">{prefs.t('organizeRotateAll')}</span>
    <span class="buttons">
      <button class="ghost tiny" onclick={() => rotateAll(-90)} aria-label={prefs.t('rotateLeft')}>↺</button>
      <button class="ghost tiny" onclick={() => rotateAll(90)} aria-label={prefs.t('rotateRight')}>↻</button>
    </span>
  </div>

  <div class="field">
    <label for="organize-name">{prefs.t('organizeOutputName')}</label>
    <input
      id="organize-name"
      type="text"
      value={o.outputName}
      placeholder={session.files[0] ? session.files[0].name.replace(/\.pdf$/i, '') + '-จัดหน้าแล้ว.pdf' : ''}
      oninput={(e) => set({ outputName: (e.currentTarget as HTMLInputElement).value })}
    />
  </div>

  <button class="ghost undo" disabled={!touched} onclick={reset}>{prefs.t('organizeReset')}</button>

  <p class="summary tnum">{prefs.t('organizeSummary', { n: kept })}</p>
</div>

<style>
  .panel { display: flex; flex-direction: column; gap: var(--space-3); }

  .hint { margin: 0; font-size: var(--fs-1); color: var(--text-muted); line-height: 1.55; }

  .state {
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
  }
  .state ul { margin: 0; padding-inline-start: var(--space-5); display: grid; gap: var(--space-1); }
  .state li { font-size: var(--fs-2); color: var(--text); }
  .quiet { margin: 0; font-size: var(--fs-1); color: var(--text-faint); }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .label { font-size: var(--fs-1); font-weight: 600; color: var(--text-muted); }
  .buttons { display: flex; gap: var(--space-1); }
  .tiny { padding: var(--space-1) var(--space-3); font-size: var(--fs-2); line-height: 1.2; border: 1px solid var(--border); }

  .field { display: flex; flex-direction: column; gap: var(--space-1); }
  .field label { font-size: var(--fs-1); font-weight: 600; color: var(--text-muted); }

  .undo { align-self: flex-start; padding: var(--space-1) var(--space-3); font-size: var(--fs-2); border: 1px solid var(--border); }

  .summary {
    margin: 0;
    font-size: var(--fs-2);
    font-weight: 600;
    color: var(--text);
    border-top: 1px solid var(--border);
    padding-top: var(--space-3);
  }
</style>

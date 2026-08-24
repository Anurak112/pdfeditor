<script lang="ts">
  /**
   * Settings for Edit.
   *
   * The count is the point of this panel. "Replace all" with no idea how many
   * "all" is means finding out by doing it, and on an invoice that is not a
   * cheap way to find out. The worker already has the text layer cached, so the
   * number arrives while you are still typing.
   */
  import { prefs } from '../../prefs.svelte';
  import { session } from '../../session.svelte';
  import type { EditOptions } from '../../../engine/operations/edit';

  const o = $derived(session.options as EditOptions);
  const renderer = $derived(session.thumbs);
  const matches = $derived(renderer?.matches ?? null);
  const batch = $derived(session.files.length > 1);

  function set(patch: Partial<EditOptions>) {
    session.setOptions(patch);
  }

  /**
   * Count as they type, but not on every keystroke.
   *
   * Only for a single file: with a batch the count would describe the first
   * document and quietly imply it spoke for all of them.
   */
  let debounce = 0;
  $effect(() => {
    const needle = o.find;
    const r = renderer;
    if (!r || batch) return;

    clearTimeout(debounce);
    debounce = setTimeout(() => r.countMatches(needle), 250) as unknown as number;
    return () => clearTimeout(debounce);
  });

  const countLine = $derived.by(() => {
    if (batch || !o.find) return null;
    if (renderer?.matchesLoading) return prefs.t('editCounting');
    if (!matches || matches.needle !== o.find) return null;
    if (matches.scanned) return prefs.t('editScanned');
    if (matches.total === 0) return prefs.t('editNoMatch');
    return prefs.t('editFoundN', { n: matches.total, pages: matches.pages.length });
  });

  const countTone = $derived.by(() => {
    if (batch || !o.find || renderer?.matchesLoading) return 'muted';
    if (matches?.scanned || matches?.total === 0) return 'warn';
    return 'ok';
  });
</script>

<div class="panel">
  <div class="field">
    <label for="edit-find">{prefs.t('editFind')}</label>
    <input
      id="edit-find"
      type="text"
      value={o.find}
      placeholder={prefs.t('editFindHint')}
      oninput={(e) => set({ find: (e.currentTarget as HTMLInputElement).value })}
    />
    {#if countLine}
      <p class="match-count {countTone}" aria-live="polite">{countLine}</p>
    {/if}
  </div>

  <div class="field">
    <label for="edit-replace">{prefs.t('editReplace')}</label>
    <input
      id="edit-replace"
      type="text"
      value={o.replace}
      placeholder={prefs.t('editReplaceHint')}
      oninput={(e) => set({ replace: (e.currentTarget as HTMLInputElement).value })}
    />
  </div>

  {#if !batch}
    <div class="field">
      <label for="edit-scope">{prefs.t('editScope')}</label>
      <select
        id="edit-scope"
        value={o.scope}
        onchange={(e) => set({ scope: (e.currentTarget as HTMLSelectElement).value as EditOptions['scope'] })}
      >
        <option value="all-pages">{prefs.t('editAllPages')}</option>
        <option value="this-page">{prefs.t('editThisPage')}</option>
      </select>
    </div>

    {#if o.scope === 'this-page'}
      <div class="field">
        <label for="edit-page">{prefs.t('pageNumber')}</label>
        <input
          id="edit-page"
          type="number"
          min="1"
          max={renderer?.pageCount ?? 1}
          value={o.page}
          oninput={(e) => set({ page: parseInt((e.currentTarget as HTMLInputElement).value, 10) || 1 })}
        />
      </div>
    {/if}
  {:else}
    <p class="note">{prefs.t('editBatchNote', { n: session.files.length })}</p>
  {/if}

  <fieldset class="field">
    <legend>{prefs.t('editFit')}</legend>
    <div class="choices">
      <label class="choice">
        <input
          type="radio"
          name="edit-fit"
          checked={o.fit === 'squeeze'}
          onchange={() => set({ fit: 'squeeze' })}
        />
        <span>
          <span class="choice-label">{prefs.t('editSqueeze')}</span>
          <span class="choice-hint">{prefs.t('editSqueezeHint')}</span>
        </span>
      </label>
      <label class="choice">
        <input
          type="radio"
          name="edit-fit"
          checked={o.fit === 'push'}
          onchange={() => set({ fit: 'push' })}
        />
        <span>
          <span class="choice-label">{prefs.t('editPush')}</span>
          <span class="choice-hint">{prefs.t('editPushHint')}</span>
        </span>
      </label>
    </div>
  </fieldset>

  <p class="claim">{prefs.t('editRealClaim')}</p>
</div>

<style>
  .panel { display: flex; flex-direction: column; gap: var(--space-4); }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    border: none;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  .field label,
  .field legend {
    font-size: var(--fs-1);
    font-weight: 600;
    color: var(--text-muted);
    padding: 0;
  }

  /* Not `.count`: the workspace header already uses that for the file count,
     and two different numbers under one class name is a trap for whoever reads
     this next. */
  .match-count { margin: var(--space-1) 0 0; font-size: var(--fs-1); line-height: 1.5; }
  .match-count.ok { color: var(--ok); }
  .match-count.warn { color: var(--warn); }
  .match-count.muted { color: var(--text-faint); }

  .note {
    margin: 0;
    font-size: var(--fs-1);
    color: var(--text-muted);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    line-height: 1.5;
  }

  .choices { display: flex; flex-direction: column; gap: var(--space-2); }
  .choice { display: flex; align-items: flex-start; gap: var(--space-2); cursor: pointer; }
  .choice input { margin-top: var(--space-1); flex: none; accent-color: var(--accent); }
  .choice span { display: flex; flex-direction: column; }
  .choice-label { font-size: var(--fs-2); color: var(--text); }
  .choice-hint { font-size: var(--fs-1); color: var(--text-muted); line-height: 1.45; }

  .claim {
    margin: 0;
    font-size: var(--fs-1);
    color: var(--text-muted);
    border-top: 1px solid var(--border);
    padding-top: var(--space-3);
    line-height: 1.55;
  }
</style>

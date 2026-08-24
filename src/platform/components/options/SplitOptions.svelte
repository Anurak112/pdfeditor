<script lang="ts">
  /**
   * Settings for Split.
   *
   * Only the control the chosen mode actually uses is shown. Five modes with
   * every field visible at once means four of them are always irrelevant, and
   * the reader has to work out which — the mode already said which.
   */
  import { prefs } from '../../prefs.svelte';
  import { session } from '../../session.svelte';
  import { splitPlan } from '../../../engine/operations/split';
  import type { SplitMode, SplitOptions } from '../../../engine/operations/split';

  const o = $derived(session.options as SplitOptions);
  const pageCount = $derived(session.files[0]?.pageCount ?? 0);
  const plan = $derived(splitPlan(pageCount, o));

  /** Which modes read the grid selection, so the hint only appears when true. */
  const usesSelection = $derived(
    o.mode === 'extract-merged' || o.mode === 'extract-separate' || o.mode === 'remove',
  );

  const MODES: { value: SplitMode; label: () => string; hint: () => string }[] = [
    { value: 'extract-merged', label: () => prefs.t('splitExtractMerged'), hint: () => prefs.t('splitExtractMergedHint') },
    { value: 'extract-separate', label: () => prefs.t('splitExtractSeparate'), hint: () => prefs.t('splitExtractSeparateHint') },
    { value: 'every-n', label: () => prefs.t('splitEveryN'), hint: () => prefs.t('splitEveryNHint') },
    { value: 'ranges', label: () => prefs.t('splitRanges'), hint: () => prefs.t('splitRangesHint') },
    { value: 'remove', label: () => prefs.t('splitRemove'), hint: () => prefs.t('splitRemoveHint') },
  ];

  function set(patch: Partial<SplitOptions>) {
    session.setOptions(patch);
  }
</script>

<div class="panel">
  <fieldset class="field">
    <legend>{prefs.t('splitMode')}</legend>
    <div class="choices">
      {#each MODES as mode (mode.value)}
        <label class="choice">
          <input
            type="radio"
            name="split-mode"
            checked={o.mode === mode.value}
            onchange={() => set({ mode: mode.value })}
          />
          <span>
            <span class="choice-label">{mode.label()}</span>
            <span class="choice-hint">{mode.hint()}</span>
          </span>
        </label>
      {/each}
    </div>
  </fieldset>

  {#if usesSelection}
    <p class="note" class:warn={o.pages.length === 0}>
      {o.pages.length === 0
        ? prefs.t('splitPickInGrid')
        : prefs.t('pagesSelected', { n: o.pages.length })}
    </p>
  {/if}

  {#if o.mode === 'every-n'}
    <div class="field">
      <label for="split-n">{prefs.t('splitEveryNLabel')}</label>
      <input
        id="split-n"
        type="number"
        min="1"
        max={Math.max(1, pageCount)}
        value={o.everyN}
        oninput={(e) => set({ everyN: Math.max(1, parseInt((e.currentTarget as HTMLInputElement).value, 10) || 1) })}
      />
    </div>
  {/if}

  {#if o.mode === 'ranges'}
    <div class="field">
      <label for="split-ranges">{prefs.t('splitRangesLabel')}</label>
      <input
        id="split-ranges"
        type="text"
        value={o.ranges}
        placeholder="1-5, 6-12, 13-"
        oninput={(e) => set({ ranges: (e.currentTarget as HTMLInputElement).value })}
      />
      <p class="hint">{prefs.t('splitRangesExample', { n: pageCount })}</p>
    </div>
  {/if}

  {#if plan.groups.length > 1}
    <label class="check">
      <input
        type="checkbox"
        checked={o.zipWhenMultiple}
        onchange={(e) => set({ zipWhenMultiple: (e.currentTarget as HTMLInputElement).checked })}
      />
      <span>
        <span class="check-label">{prefs.t('splitZip')}</span>
        <span class="check-hint">{prefs.t('splitZipHint')}</span>
      </span>
    </label>

    <div class="field">
      <label for="split-pattern">{prefs.t('splitPattern')}</label>
      <input
        id="split-pattern"
        type="text"
        value={o.namePattern}
        oninput={(e) => set({ namePattern: (e.currentTarget as HTMLInputElement).value })}
      />
      <p class="hint">{prefs.t('splitPatternHint')}</p>
    </div>
  {/if}
</div>

<style>
  .panel { display: flex; flex-direction: column; gap: var(--space-3); }

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

  .choices { display: flex; flex-direction: column; gap: var(--space-2); }
  .choice { display: flex; align-items: flex-start; gap: var(--space-2); cursor: pointer; }
  .choice input { margin-top: var(--space-1); flex: none; accent-color: var(--accent); }
  .choice span { display: flex; flex-direction: column; }
  .choice-label { font-size: var(--fs-2); color: var(--text); }
  .choice-hint { font-size: var(--fs-1); color: var(--text-muted); line-height: 1.45; }

  .check { display: flex; align-items: flex-start; gap: var(--space-2); cursor: pointer; }
  .check input { margin-top: var(--space-1); flex: none; width: 16px; height: 16px; accent-color: var(--accent); }
  .check span { display: flex; flex-direction: column; }
  .check-label { font-size: var(--fs-2); color: var(--text); }
  .check-hint { font-size: var(--fs-1); color: var(--text-muted); line-height: 1.45; }

  .note {
    margin: 0;
    font-size: var(--fs-2);
    color: var(--text);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
  }
  .note.warn { color: var(--warn); background: var(--warn-soft); }

  .hint { margin: var(--space-1) 0 0; font-size: var(--fs-1); color: var(--text-faint); line-height: 1.5; }
</style>

<script lang="ts">
  /**
   * Settings for Compress.
   *
   * Three levels, not a percentage slider. A slider makes people ask whether 63
   * is better than 61, which has no answer, and it implies the result is a
   * dial when it is really a property of the document: a text-only file will
   * not move at any setting, and a page of photographs will halve at all three.
   *
   * The caveat about what re-encoding costs is stated here, before the run,
   * rather than as a warning after it — a warning that fires on every
   * successful run is not a warning, it is a footer.
   */
  import { prefs } from '../../prefs.svelte';
  import { session } from '../../session.svelte';
  import { COMPRESS_PRESETS } from '../../../tools/options';
  import type { CompressLevel, CompressOptions } from '../../../tools/options';

  const o = $derived(session.options as CompressOptions);

  const LEVELS: { value: CompressLevel; label: () => string; hint: () => string }[] = [
    {
      value: 'high-quality',
      label: () => prefs.t('compressHigh'),
      hint: () => prefs.t('compressHighHint'),
    },
    {
      value: 'recommended',
      label: () => prefs.t('compressRecommended'),
      hint: () => prefs.t('compressRecommendedHint'),
    },
    {
      value: 'extreme',
      label: () => prefs.t('compressExtreme'),
      hint: () => prefs.t('compressExtremeHint'),
    },
  ];

  const preset = $derived(COMPRESS_PRESETS[o.level]);

  function set(patch: Partial<CompressOptions>) {
    session.setOptions(patch);
  }
</script>

<div class="panel">
  <fieldset class="field">
    <legend>{prefs.t('compressLevel')}</legend>
    <div class="choices">
      {#each LEVELS as level (level.value)}
        <label class="choice">
          <input
            type="radio"
            name="compress-level"
            checked={o.level === level.value}
            onchange={() => set({ level: level.value })}
          />
          <span>
            <span class="choice-label">{level.label()}</span>
            <span class="choice-hint">{level.hint()}</span>
          </span>
        </label>
      {/each}
    </div>
  </fieldset>

  <p class="note">{prefs.t('compressHowItWorks', { dpi: preset.dpi })}</p>

  <label class="check">
    <input
      type="checkbox"
      checked={o.stripMetadata}
      onchange={(e) => set({ stripMetadata: (e.currentTarget as HTMLInputElement).checked })}
    />
    <span>
      <span class="check-label">{prefs.t('compressStripMetadata')}</span>
      <span class="check-hint">{prefs.t('compressStripMetadataHint')}</span>
    </span>
  </label>

  <p class="hint">{prefs.t('compressNeverGrow')}</p>
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
    line-height: 1.5;
  }

  .hint { margin: var(--space-1) 0 0; font-size: var(--fs-1); color: var(--text-faint); line-height: 1.5; }
</style>

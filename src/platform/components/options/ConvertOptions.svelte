<script lang="ts">
  /**
   * Settings for Convert.
   *
   * The direction is read off the files, not asked for. Someone who has just
   * dropped three JPGs does not need a menu offering "PDF to text" — the
   * question is what to turn them into, and there is only one sensible answer.
   * Showing the impossible options and then refusing them is a slower way of
   * saying the same thing.
   */
  import { prefs } from '../../prefs.svelte';
  import { session } from '../../session.svelte';
  import { directionOf, targetsFor } from '../../../engine/operations/convert';
  import type { ConvertOptions, ConvertTarget } from '../../../engine/operations/convert';

  const o = $derived(session.options as ConvertOptions);
  const direction = $derived(directionOf(session.files));
  const targets = $derived(targetsFor(direction));
  const pages = $derived(session.totalPages);

  const LABEL: Record<ConvertTarget, () => string> = {
    jpg: () => 'JPG',
    png: () => 'PNG',
    txt: () => prefs.t('convertPlainText'),
    pdf: () => 'PDF',
  };

  function set(patch: Partial<ConvertOptions>) {
    session.setOptions(patch);
  }

  /**
   * Keep the target reachable.
   *
   * Loading images while "to JPG" is selected would otherwise leave a setting
   * the engine has to refuse. Correcting it here means the refusal never
   * happens.
   */
  $effect(() => {
    const list = targets;
    if (list.length > 0 && !list.includes(o.to)) set({ to: list[0] });
  });

  const raster = $derived(o.to === 'jpg' || o.to === 'png');
</script>

<div class="panel">
  <div class="direction">
    <span class="from">{direction === 'pdf-out' ? prefs.t('convertFromImages') : 'PDF'}</span>
    <span class="arrow" aria-hidden="true">→</span>
    {#if targets.length > 1}
      <select
        aria-label={prefs.t('convertTo')}
        value={o.to}
        onchange={(e) => set({ to: (e.currentTarget as HTMLSelectElement).value as ConvertTarget })}
      >
        {#each targets as target (target)}
          <option value={target}>{LABEL[target]()}</option>
        {/each}
      </select>
    {:else if targets.length === 1}
      <span class="to">{LABEL[targets[0]]()}</span>
    {:else}
      <span class="to unknown">—</span>
    {/if}
  </div>

  {#if direction === null && session.files.length > 0}
    <p class="note warn">{prefs.t('convertMixed')}</p>
  {/if}

  {#if raster}
    <div class="field">
      <label for="convert-dpi">{prefs.t('convertDpi')}</label>
      <select
        id="convert-dpi"
        value={String(o.dpi)}
        onchange={(e) => set({ dpi: Number((e.currentTarget as HTMLSelectElement).value) as 72 | 150 | 300 })}
      >
        <option value="72">72 — {prefs.t('convertDpiScreen')}</option>
        <option value="150">150 — {prefs.t('convertDpiNormal')}</option>
        <option value="300">300 — {prefs.t('convertDpiPrint')}</option>
      </select>
      {#if o.dpi === 300 && pages > 20}
        <p class="note warn">{prefs.t('convertDpiHeavy', { n: pages })}</p>
      {/if}
    </div>
  {/if}

  {#if o.to === 'jpg'}
    <div class="field">
      <label for="convert-quality">{prefs.t('convertQuality')} — {Math.round(o.quality * 100)}%</label>
      <input
        id="convert-quality"
        type="range"
        min="0.4"
        max="1"
        step="0.05"
        value={o.quality}
        oninput={(e) => set({ quality: Number((e.currentTarget as HTMLInputElement).value) })}
      />
    </div>
  {/if}

  {#if o.to === 'png'}
    <label class="check">
      <input
        type="checkbox"
        checked={o.transparent}
        onchange={(e) => set({ transparent: (e.currentTarget as HTMLInputElement).checked })}
      />
      <span>
        <span class="check-label">{prefs.t('convertTransparent')}</span>
        <span class="check-hint">{prefs.t('convertTransparentHint')}</span>
      </span>
    </label>
  {/if}

  {#if o.to === 'txt'}
    <div class="field">
      <label for="convert-flow">{prefs.t('convertTextFlow')}</label>
      <select
        id="convert-flow"
        value={o.textFlow}
        onchange={(e) => set({ textFlow: (e.currentTarget as HTMLSelectElement).value as ConvertOptions['textFlow'] })}
      >
        <option value="keep-lines">{prefs.t('convertKeepLines')}</option>
        <option value="paragraphs">{prefs.t('convertParagraphs')}</option>
      </select>
    </div>
    <label class="check">
      <input
        type="checkbox"
        checked={o.pageSeparator}
        onchange={(e) => set({ pageSeparator: (e.currentTarget as HTMLInputElement).checked })}
      />
      <span><span class="check-label">{prefs.t('convertPageMarks')}</span></span>
    </label>
    <p class="note">{prefs.t('convertTextLimit')}</p>
  {/if}

  {#if o.to === 'pdf'}
    <div class="field">
      <label for="convert-pagesize">{prefs.t('convertPageSize')}</label>
      <select
        id="convert-pagesize"
        value={o.imagePageSize}
        onchange={(e) =>
          set({ imagePageSize: (e.currentTarget as HTMLSelectElement).value as ConvertOptions['imagePageSize'] })}
      >
        <option value="fit-image">{prefs.t('convertFitImage')}</option>
        <option value="a4">A4</option>
        <option value="letter">Letter</option>
      </select>
    </div>
    <div class="field">
      <label for="convert-margin">{prefs.t('convertMargin')}</label>
      <input
        id="convert-margin"
        type="number"
        min="0"
        max="50"
        value={o.imageMarginMm}
        oninput={(e) => set({ imageMarginMm: Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0) })}
      />
    </div>
  {/if}

  {#if raster && pages > 1}
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
  {/if}
</div>

<style>
  .panel { display: flex; flex-direction: column; gap: var(--space-3); }

  .direction {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
  }
  .from,
  .to {
    font-weight: 600;
    font-size: var(--fs-2);
    color: var(--text);
  }
  .to.unknown { color: var(--text-faint); }
  .arrow { color: var(--text-muted); }
  .direction select { flex: 1; padding: var(--space-2); font-size: var(--fs-2); }

  .field { display: flex; flex-direction: column; gap: var(--space-1); }
  .field label { font-size: var(--fs-1); font-weight: 600; color: var(--text-muted); }
  .field input[type='range'] { accent-color: var(--accent); padding: 0; }

  .check { display: flex; align-items: flex-start; gap: var(--space-2); cursor: pointer; }
  .check input { margin-top: var(--space-1); flex: none; width: 16px; height: 16px; accent-color: var(--accent); }
  .check span { display: flex; flex-direction: column; }
  .check-label { font-size: var(--fs-2); color: var(--text); }
  .check-hint { font-size: var(--fs-1); color: var(--text-muted); line-height: 1.45; }

  .note {
    margin: 0;
    font-size: var(--fs-1);
    color: var(--text-muted);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    line-height: 1.5;
  }
  .note.warn { color: var(--warn); background: var(--warn-soft); }
</style>

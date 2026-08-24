<script lang="ts">
  /**
   * Settings for Merge.
   *
   * The order is not here on purpose — it is the file list on the left, where
   * the files themselves are. Two places to change the same thing is how a
   * reordered list and a stale order array end up disagreeing.
   */
  import { prefs } from '../../prefs.svelte';
  import { session } from '../../session.svelte';
  import type { MergeOptions } from '../../../tools/options';

  const o = $derived(session.options as MergeOptions);
  let showAdvanced = $state(false);

  const anyRange = $derived(Object.values(o.pageRanges ?? {}).some((v) => v.trim().length > 0));

  function set(patch: Partial<MergeOptions>) {
    session.setOptions(patch);
  }

  function setRange(fileId: string, spec: string) {
    set({ pageRanges: { ...o.pageRanges, [fileId]: spec } });
  }
</script>

<div class="panel">
  <p class="note">{prefs.t('mergeReorderHint')}</p>

  <label class="check">
    <input
      type="checkbox"
      checked={o.addBookmarks}
      onchange={(e) => set({ addBookmarks: (e.currentTarget as HTMLInputElement).checked })}
    />
    <span>
      <span class="check-label">{prefs.t('mergeBookmarks')}</span>
      <span class="check-hint">{prefs.t('mergeBookmarksHint')}</span>
    </span>
  </label>

  <div class="field">
    <label for="merge-size">{prefs.t('mergePageSize')}</label>
    <select
      id="merge-size"
      value={o.pageSize}
      onchange={(e) => set({ pageSize: (e.currentTarget as HTMLSelectElement).value as MergeOptions['pageSize'] })}
    >
      <option value="keep">{prefs.t('mergeSizeKeep')}</option>
      <option value="first">{prefs.t('mergeSizeFirst')}</option>
      <option value="a4">{prefs.t('mergeSizeA4')}</option>
    </select>
    {#if o.pageSize !== 'keep'}
      <p class="warn">{prefs.t('mergeSizeWarn')}</p>
    {/if}
  </div>

  <div class="field">
    <label for="merge-meta">{prefs.t('mergeMetadata')}</label>
    <select
      id="merge-meta"
      value={o.keepMetadata}
      onchange={(e) =>
        set({ keepMetadata: (e.currentTarget as HTMLSelectElement).value as MergeOptions['keepMetadata'] })}
    >
      <option value="first">{prefs.t('mergeMetaFirst')}</option>
      <option value="none">{prefs.t('mergeMetaNone')}</option>
    </select>
  </div>

  <div class="field">
    <label for="merge-name">{prefs.t('mergeOutputName')}</label>
    <input
      id="merge-name"
      type="text"
      value={o.outputName}
      placeholder={session.files[0] ? session.files[0].name.replace(/\.pdf$/i, '') + '-รวม.pdf' : ''}
      oninput={(e) => set({ outputName: (e.currentTarget as HTMLInputElement).value })}
    />
  </div>

  <div class="advanced">
    <button
      class="ghost disclose"
      aria-expanded={showAdvanced}
      onclick={() => (showAdvanced = !showAdvanced)}
    >
      <span aria-hidden="true">{showAdvanced ? '▾' : '▸'}</span>
      {prefs.t('mergeAdvanced')}
      {#if anyRange && !showAdvanced}<span class="dot" aria-hidden="true">•</span>{/if}
    </button>

    {#if showAdvanced}
      <p class="hint">{prefs.t('mergeRangeHint')}</p>
      <div class="ranges">
        {#each session.files as file (file.id)}
          <label class="range-row">
            <span class="range-name" title={file.name}>{file.name}</span>
            <input
              type="text"
              inputmode="numeric"
              value={o.pageRanges?.[file.id] ?? ''}
              placeholder="1-{file.pageCount}"
              oninput={(e) => setRange(file.id, (e.currentTarget as HTMLInputElement).value)}
            />
          </label>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .panel { display: flex; flex-direction: column; gap: var(--space-4); }

  .note {
    margin: 0;
    font-size: var(--fs-1);
    color: var(--text-muted);
    line-height: 1.5;
  }

  .check {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    cursor: pointer;
  }
  .check input { margin-top: var(--space-1); flex: none; width: 16px; height: 16px; accent-color: var(--accent); }
  .check span { display: flex; flex-direction: column; }
  .check-label { font-size: var(--fs-2); color: var(--text); }
  .check-hint { font-size: var(--fs-1); color: var(--text-muted); line-height: 1.45; }

  .field { display: flex; flex-direction: column; gap: var(--space-1); }
  .field label { font-size: var(--fs-1); font-weight: 600; color: var(--text-muted); }

  .warn {
    margin: 0;
    font-size: var(--fs-1);
    color: var(--warn);
    background: var(--warn-soft);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    line-height: 1.45;
  }

  .advanced {
    border-top: 1px solid var(--border);
    padding-top: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .disclose {
    align-self: flex-start;
    padding: var(--space-1) var(--space-2);
    font-size: var(--fs-1);
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .dot { color: var(--accent); font-size: var(--fs-3); line-height: 1; }

  .hint { margin: 0; font-size: var(--fs-1); color: var(--text-faint); }

  .ranges { display: flex; flex-direction: column; gap: var(--space-2); }
  .range-row {
    display: grid;
    grid-template-columns: 1fr 96px;
    align-items: center;
    gap: var(--space-2);
  }
  .range-name {
    font-size: var(--fs-1);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .range-row input { padding: var(--space-2); font-size: var(--fs-1); }
</style>

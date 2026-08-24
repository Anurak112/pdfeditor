<script lang="ts">
  /**
   * The loaded files, in the order they will be used.
   *
   * Reordering has arrow buttons as well as the eventual drag handle, because
   * dragging a list item is the control most likely to be unreachable — on a
   * touchscreen, with a trackpad, or with a keyboard.
   */
  import { prefs } from '../prefs.svelte';
  import { formatBytes } from '../download';
  import type { LoadedFile } from '../../tools/types';

  interface Props {
    files: LoadedFile[];
    reorderable?: boolean;
    onremove: (id: string) => void;
    onmove?: (id: string, direction: -1 | 1) => void;
  }
  let { files, reorderable = false, onremove, onmove }: Props = $props();
</script>

<ol class="list">
  {#each files as file, i (file.id)}
    <li class="row">
      <span class="index tnum">{String(i + 1).padStart(2, '0')}</span>

      <span class="body">
        <span class="name" title={file.name}>{file.name}</span>
        <span class="meta tnum">
          {formatBytes(file.sizeBytes)}
          {#if file.pageCount > 0}
            · {prefs.formatNumber(file.pageCount)} {prefs.t('pages')}
          {/if}
          {#if file.isEncrypted}
            · <span class="locked">🔒</span>
          {/if}
        </span>
      </span>

      {#if reorderable && onmove}
        <span class="moves">
          <button
            class="ghost tiny"
            disabled={i === 0}
            onclick={() => onmove(file.id, -1)}
            aria-label="{prefs.t('moveUp')}: {file.name}"
          >↑</button>
          <button
            class="ghost tiny"
            disabled={i === files.length - 1}
            onclick={() => onmove(file.id, 1)}
            aria-label="{prefs.t('moveDown')}: {file.name}"
          >↓</button>
        </span>
      {/if}

      <button
        class="ghost tiny remove"
        onclick={() => onremove(file.id)}
        aria-label="{prefs.t('removeFile')}: {file.name}"
      >✕</button>
    </li>
  {/each}
</ol>

<style>
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }

  .index {
    font-family: var(--mono);
    font-size: var(--fs-1);
    color: var(--text-faint);
    flex: none;
  }

  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .name {
    font-size: var(--fs-2);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta { font-size: var(--fs-1); color: var(--text-muted); }
  .locked { font-size: var(--fs-1); }

  .moves { display: flex; gap: var(--space-1); flex: none; }

  .tiny {
    padding: var(--space-1) var(--space-2);
    font-size: var(--fs-1);
    line-height: 1.2;
    min-width: 32px;
  }
  .remove:hover:not(:disabled) { color: var(--danger); background: var(--danger-soft); }
</style>

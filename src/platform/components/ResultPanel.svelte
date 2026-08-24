<script lang="ts">
  /**
   * The result, and the next move.
   *
   * "What next" is the part a server-backed site cannot offer: the output bytes
   * are already here, so handing them to another tool costs nothing. Elsewhere
   * the user has to download and re-upload between every step.
   */
  import { prefs } from '../prefs.svelte';
  import { downloadBytes, formatBytes } from '../download';
  import { TOOLS } from '../../tools/registry';
  import type { OutputFile, RunStats, ToolId } from '../../tools/types';
  import type { AppError } from '../../engine/errors';

  interface Props {
    outputs: OutputFile[];
    stats: RunStats | null;
    warnings: AppError[];
    currentToolId: string | null;
    onchain: (toolId: string) => void;
    onreset: () => void;
  }
  let { outputs, stats, warnings, currentToolId, onchain, onreset }: Props = $props();

  const totalBytes = $derived(outputs.reduce((n, o) => n + o.bytes.byteLength, 0));

  /** Only offer the next steps that make sense for what came out. */
  const nextTools = $derived(
    TOOLS.filter(
      (t) =>
        t.id !== currentToolId &&
        t.status === 'ready' &&
        outputs.every((o) => t.acceptedInputs.includes(o.mimeType)),
    ).slice(0, 3),
  );
</script>

<div class="panel">
  <div class="head">
    <span class="tick" aria-hidden="true">✓</span>
    <div>
      <p class="title">{prefs.t('done')}</p>
      <p class="sub tnum">
        {#if outputs.length === 1}
          {formatBytes(totalBytes)}
        {:else}
          {prefs.t('filesCreated', { n: outputs.length })} · {formatBytes(totalBytes)}
        {/if}
        {#if stats?.savedPercent !== undefined}
          · −{Math.round(stats.savedPercent)}%
        {/if}
      </p>
    </div>
  </div>

  {#each warnings as warning (warning.code)}
    <p class="warning">{prefs.pick(warning.message)}</p>
  {/each}

  <ul class="outputs">
    {#each outputs as out (out.name)}
      <li>
        <span class="name" title={out.name}>{out.name}</span>
        <span class="size tnum">{formatBytes(out.bytes.byteLength)}</span>
        <button class="ghost" onclick={() => downloadBytes(out.bytes, out.name, out.mimeType)}>
          {prefs.t('download')}
        </button>
      </li>
    {/each}
  </ul>

  {#if nextTools.length > 0}
    <div class="next">
      <p class="next-label">{prefs.t('whatNext')}</p>
      <div class="next-row">
        {#each nextTools as tool (tool.id)}
          <button onclick={() => onchain(tool.id as ToolId)}>{prefs.pick(tool.name)}</button>
        {/each}
      </div>
    </div>
  {/if}

  <button class="ghost start-over" onclick={onreset}>{prefs.t('startOver')}</button>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-5);
    border: 1px solid var(--ok);
    border-radius: var(--radius);
    background: var(--ok-soft);
  }

  .head { display: flex; align-items: center; gap: var(--space-3); }

  .tick {
    flex: none;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--ok);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
  }

  .title { margin: 0; font-weight: 600; font-size: var(--fs-3); }
  .sub { margin: 0; font-size: var(--fs-2); color: var(--text-muted); }

  .warning {
    margin: 0;
    font-size: var(--fs-2);
    color: var(--warn);
    background: var(--warn-soft);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
  }

  .outputs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .outputs li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  }
  .outputs .name {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .outputs .size { font-size: var(--fs-1); color: var(--text-muted); flex: none; }
  .outputs button { padding: var(--space-2) var(--space-3); font-size: var(--fs-2); }

  .next {
    border-top: 1px solid var(--border);
    padding-top: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .next-label { margin: 0; font-size: var(--fs-1); color: var(--text-muted); font-weight: 600; }
  .next-row { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .next-row button { padding: var(--space-2) var(--space-3); font-size: var(--fs-2); }

  .start-over { align-self: flex-start; padding: var(--space-2) var(--space-3); font-size: var(--fs-2); }
</style>

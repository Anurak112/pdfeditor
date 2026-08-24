<script lang="ts">
  /**
   * What is happening, right now.
   *
   * The bar is determinate because the percentage comes from work actually
   * finished — a fake animated bar teaches people that the number means
   * nothing. Cancel is always present and always real: it aborts the run rather
   * than hiding this panel.
   */
  import { prefs } from '../prefs.svelte';
  import type { Progress } from '../session.svelte';

  interface Props {
    progress: Progress | null;
    oncancel: () => void;
  }
  let { progress, oncancel }: Props = $props();

  const percent = $derived(Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0))));
</script>

<div class="panel" role="status" aria-live="polite">
  <div class="head">
    <span class="label">{prefs.t('working')}</span>
    <span class="percent tnum">{percent}%</span>
  </div>

  <div
    class="track"
    role="progressbar"
    aria-valuenow={percent}
    aria-valuemin="0"
    aria-valuemax="100"
  >
    <div class="fill" style="width: {percent}%"></div>
  </div>

  <div class="foot">
    <span class="message">{prefs.pick(progress?.message)}</span>
    <button class="ghost" onclick={oncancel}>{prefs.t('cancel')}</button>
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .label { font-weight: 600; font-size: var(--fs-2); }
  .percent { font-family: var(--mono); font-size: var(--fs-2); color: var(--accent); font-weight: 600; }

  .track {
    height: 8px;
    border-radius: 999px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    border-radius: 999px;
    transition: width 0.2s ease-out;
  }

  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .message { font-size: var(--fs-1); color: var(--text-muted); }
</style>

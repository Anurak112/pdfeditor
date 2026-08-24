<script lang="ts">
  /**
   * Something went wrong, and here is what to do about it.
   *
   * No code, no stack trace, and never fewer than one button — an error with no
   * way forward leaves the user stuck on a screen they cannot leave. The
   * technical detail goes to the console, where it is useful to us and invisible
   * to them.
   */
  import { prefs } from '../prefs.svelte';
  import type { AppError, RecoveryAction } from '../../engine/errors';

  interface Props {
    error: AppError;
    onaction: (action: RecoveryAction) => void;
  }
  let { error, onaction }: Props = $props();

  // Read off the error itself rather than a prop: a caller that passes the
  // wrong tone paints a failure as a friendly note, and nothing catches it.
  const tone = $derived(error.severity === 'warning' ? 'notice' : 'error');
</script>

<div class="panel {tone}" role={tone === 'error' ? 'alert' : 'status'}>
  <span class="glyph" aria-hidden="true">{tone === 'error' ? '!' : 'i'}</span>

  <div class="body">
    <p class="message">{prefs.pick(error.message)}</p>
    {#if error.hint}
      <p class="hint">{prefs.pick(error.hint)}</p>
    {/if}

    <div class="actions">
      {#each error.actions as action (action.kind + (action.toolId ?? ''))}
        <button class:primary={action === error.actions[0]} onclick={() => onaction(action)}>
          {prefs.pick(action.label)}
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .panel {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-4);
    border-radius: var(--radius);
    border: 1px solid var(--border);
  }
  .panel.error { background: var(--danger-soft); border-color: var(--danger); }
  .panel.notice { background: var(--warn-soft); border-color: var(--warn); }

  .glyph {
    flex: none;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: var(--fs-1);
    color: #fff;
  }
  .error .glyph { background: var(--danger); }
  .notice .glyph { background: var(--warn); }

  .body { display: flex; flex-direction: column; gap: var(--space-2); flex: 1; min-width: 0; }

  .message { margin: 0; font-weight: 600; font-size: var(--fs-2); color: var(--text); }
  .hint { margin: 0; font-size: var(--fs-2); color: var(--text-muted); line-height: 1.55; }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-1);
  }
  .actions button { padding: var(--space-2) var(--space-3); font-size: var(--fs-2); }
</style>

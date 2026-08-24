<script lang="ts">
  /**
   * The button, and the sentence above it.
   *
   * The prediction line is not decoration: pressing a button to find out what it
   * does is the failure mode of every "process" screen. If a tool can say "you
   * will get 3 files, about 240 KB" before it runs, it says it here.
   *
   * Three different reasons the button can be off, kept apart because they ask
   * different things of the reader — fix something, wait for us, or nothing.
   */
  import { prefs } from '../prefs.svelte';
  import type { LocalizedString } from '../../tools/types';

  interface Props {
    label: string;
    prediction: LocalizedString | null;
    blockedReason: LocalizedString | null;
    notBuilt?: boolean;
    disabled: boolean;
    onrun: () => void;
  }
  let { label, prediction, blockedReason, notBuilt = false, disabled, onrun }: Props = $props();
</script>

<div class="bar">
  {#if prediction}
    <p class="line predict">{prefs.pick(prediction)}</p>
  {/if}

  {#if blockedReason}
    <p class="line blocked">{prefs.pick(blockedReason)}</p>
  {/if}

  <button class="primary run" {disabled} onclick={onrun}>{label}</button>

  {#if notBuilt}
    <p class="line planned">{prefs.t('plannedNote')}</p>
  {/if}
</div>

<style>
  .bar {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }

  .line {
    margin: 0;
    font-size: var(--fs-2);
    line-height: 1.5;
  }
  .predict { color: var(--text-muted); }
  .blocked { color: var(--warn); }
  .planned { color: var(--text-faint); text-align: center; font-size: var(--fs-1); }

  .run {
    width: 100%;
    padding: var(--space-3) var(--space-4);
    font-size: var(--fs-3);
  }
</style>

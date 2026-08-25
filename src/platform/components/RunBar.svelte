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

  /*
   * On a phone the settings panel stops being a sidebar and stacks under the
   * page grid, which put this button 1,464px down an 832px screen: you loaded a
   * file, and the thing that does the work was two screens below the fold with
   * nothing on screen to suggest it was there.
   *
   * Below the sidebar breakpoint it becomes what every phone app uses for a
   * primary action — a bar pinned to the bottom edge. Workspace adds matching
   * bottom padding so the last row of the grid still scrolls clear of it; the
   * two are a pair, and each says so.
   */
  @media (max-width: 1023px) {
    .bar {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 20;
      padding: var(--space-3) var(--space-5);
      /* Clears the home indicator on an iPhone; zero everywhere else. */
      padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
      background: var(--surface);
      box-shadow: 0 -2px 14px rgb(0 0 0 / 0.1);
    }
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

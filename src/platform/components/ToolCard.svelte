<script lang="ts">
  import Icon from './Icon.svelte';
  import LaneBadge from './LaneBadge.svelte';
  import { prefs } from '../prefs.svelte';
  import type { AnyTool } from '../../tools/types';

  interface Props {
    tool: AnyTool;
    /** True when the files already loaded are not something this tool accepts. */
    incompatible?: boolean;
    featured?: boolean;
    onpick: (toolId: string) => void;
  }
  let { tool, incompatible = false, featured = false, onpick }: Props = $props();
</script>

<button
  class="card"
  class:incompatible
  class:featured
  disabled={incompatible}
  onclick={() => onpick(tool.id)}
>
  <span class="top">
    <span class="icon" aria-hidden="true"><Icon path={tool.icon} /></span>
    {#if tool.status === 'planned'}
      <span class="planned">{prefs.t('statusPlanned')}</span>
    {/if}
  </span>

  <span class="name">{prefs.pick(tool.name)}</span>
  <span class="blurb">{prefs.pick(tool.blurb)}</span>

  <span class="foot">
    <LaneBadge lane={tool.lane} compact />
  </span>
</button>

<style>
  .card {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-2);
    text-align: start;
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    min-height: 148px;
    transition: border-color 0.12s, box-shadow 0.12s, transform 0.12s;
  }
  .card:hover:not(:disabled) {
    border-color: var(--accent);
    box-shadow: var(--shadow);
    background: var(--surface);
    transform: translateY(-1px);
  }
  /* The one thing here no free competitor can do, so it does not look like
     just another card in the second row. */
  .card.featured { border-color: var(--accent); box-shadow: var(--shadow); }

  .card.incompatible { opacity: 0.42; }

  .top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    color: var(--accent);
    flex: none;
  }

  .planned {
    font-size: var(--fs-1);
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--warn);
    background: var(--warn-soft);
    border-radius: var(--radius-sm);
    padding: var(--space-1) var(--space-2);
    white-space: nowrap;
    align-self: flex-start;
  }

  .name { font-weight: 600; font-size: var(--fs-3); color: var(--text); }

  .blurb {
    font-size: var(--fs-2);
    color: var(--text-muted);
    line-height: 1.5;
    text-wrap: balance;
    flex: 1;
  }

  .foot { display: flex; }
</style>

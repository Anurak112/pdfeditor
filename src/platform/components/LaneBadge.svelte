<script lang="ts">
  /**
   * Where a tool does its work.
   *
   * This is the most decision-relevant thing about a tool — whether the file
   * leaves the machine — so it is shown on every card rather than buried in a
   * privacy page. The dot carries the same meaning as the colour, so the badge
   * still reads for anyone who cannot separate the hues.
   */
  import { prefs } from '../prefs.svelte';
  import type { Lane } from '../../tools/types';

  interface Props {
    lane: Lane;
    /** Small on cards, regular in the workspace header. */
    compact?: boolean;
  }
  let { lane, compact = false }: Props = $props();

  const LABEL = { client: 'laneClient', limited: 'laneLimited', server: 'laneServer' } as const;
  const WHY = { client: 'laneClientWhy', limited: 'laneLimitedWhy', server: 'laneServerWhy' } as const;
</script>

<span class="badge {lane}" class:compact title={prefs.t(WHY[lane])}>
  <span class="dot" aria-hidden="true"></span>
  {prefs.t(LABEL[lane])}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--fs-1);
    font-weight: 600;
    line-height: 1.5;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }
  /* Compact loses the padding, not the type size — 12px is the smallest step
     there is, and a badge below it stops being readable in Thai. */
  .badge.compact { padding: 0 var(--space-1); }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  }

  .client { color: var(--lane-client); background: var(--lane-client-soft); }
  .limited { color: var(--lane-limited); background: var(--lane-limited-soft); }
  .server { color: var(--lane-server); background: var(--lane-server-soft); }
</style>

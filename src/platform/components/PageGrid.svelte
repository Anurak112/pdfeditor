<script lang="ts">
  /**
   * The pages of a document, as things you can point at.
   *
   * This is the piece Split, Organize, Convert-to-image and any future
   * page-level tool all sit on, which is why it is worth more care than a
   * single tool would justify. Typing "1-5, 8" into a box asks the reader to
   * already know what is on those pages; a grid does not.
   *
   * Three things it must survive: a 900-page document, a keyboard with no
   * mouse, and a screen 375px wide.
   */
  import { prefs } from '../prefs.svelte';
  import type { Thumb } from '../renderer.svelte';

  interface Props {
    thumbs: Thumb[];
    selected: Set<number>;
    /** Extra rotation the user applied on top of what the page already had. */
    rotations?: Record<number, number>;
    deleted?: Set<number>;
    onselect: (next: Set<number>) => void;
    /** Provide to show the rotate controls. Organize does; Split does not. */
    onrotate?: (index: number, delta: 90 | -90) => void;
    /** Provide to show the delete control. */
    ondelete?: (index: number) => void;
    /** Provide to let a tile open in the single-page view. */
    onopen?: (index: number) => void;
    /** Display order as source indices. Absent means the document's own order. */
    order?: number[];
    /** Provide to allow reordering — shows drag handles and move buttons. */
    onreorder?: (order: number[]) => void;
    /** The grid says which pages are near the viewport; the caller draws them. */
    onwant: (indices: number[]) => void;
  }

  let {
    thumbs,
    selected,
    rotations = {},
    deleted = new Set<number>(),
    onselect,
    onrotate,
    ondelete,
    onopen,
    order,
    onreorder,
    onwant,
  }: Props = $props();

  /**
   * What to draw, in what order.
   *
   * Tiles stay keyed by source index whatever the order, so a rotation or a
   * deletion follows the page rather than the slot it happens to sit in.
   */
  const shown = $derived(
    (order && order.length > 0 ? order : thumbs.map((t) => t.index))
      .map((i) => thumbs[i])
      .filter(Boolean),
  );

  let dragFrom = $state<number | null>(null);
  let dropAt = $state<number | null>(null);

  /** Moves one page to a new slot, leaving everything else in sequence. */
  function moveTo(sourceIndex: number, slot: number) {
    if (!onreorder) return;
    const current = shown.map((t) => t.index);
    const from = current.indexOf(sourceIndex);
    if (from < 0) return;
    const next = [...current];
    next.splice(from, 1);
    next.splice(Math.max(0, Math.min(next.length, slot)), 0, sourceIndex);
    onreorder(next);
  }

  function nudge(sourceIndex: number, delta: -1 | 1) {
    const current = shown.map((t) => t.index);
    const at = current.indexOf(sourceIndex);
    if (at < 0) return;
    moveTo(sourceIndex, at + delta + (delta > 0 ? 0 : 0));
  }

  let gridEl = $state<HTMLDivElement | undefined>();
  let focusIndex = $state(0);
  /** Where a shift-click measures from. */
  let anchor = $state(0);

  const total = $derived(thumbs.length);
  const selectedCount = $derived(selected.size);

  // ---- lazy drawing -------------------------------------------------------
  //
  // Asking for every page up front is a minute of rasterising for pictures
  // nobody scrolled to. The observer collects what came into view and hands it
  // over in one batch per frame, so a fast scroll does not fire 900 requests.
  let pending: number[] = [];
  let flushHandle = 0;

  function requestSoon(index: number) {
    pending.push(index);
    if (flushHandle) return;
    flushHandle = requestAnimationFrame(() => {
      flushHandle = 0;
      const batch = pending;
      pending = [];
      if (batch.length > 0) onwant(batch);
    });
  }

  $effect(() => {
    const root = gridEl;
    if (!root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = Number((entry.target as HTMLElement).dataset.index);
          if (Number.isFinite(index)) requestSoon(index);
        }
      },
      // A screen ahead, so tiles are drawn by the time they arrive.
      { root: null, rootMargin: '600px 0px', threshold: 0 },
    );

    for (const tile of root.querySelectorAll<HTMLElement>('[data-index]')) observer.observe(tile);
    return () => {
      observer.disconnect();
      if (flushHandle) cancelAnimationFrame(flushHandle);
      flushHandle = 0;
    };
  });

  // ---- selection ----------------------------------------------------------

  function emit(next: Set<number>) {
    onselect(next);
  }

  function toggle(index: number, event?: MouseEvent | KeyboardEvent) {
    const next = new Set(selected);

    if (event?.shiftKey) {
      const [from, to] = anchor <= index ? [anchor, index] : [index, anchor];
      for (let i = from; i <= to; i++) next.add(i);
      emit(next);
      return;
    }

    if (next.has(index)) next.delete(index);
    else next.add(index);
    anchor = index;
    emit(next);
  }

  const all = () => emit(new Set(thumbs.map((t) => t.index)));
  const clear = () => emit(new Set());
  const odd = () => emit(new Set(thumbs.filter((t) => t.index % 2 === 0).map((t) => t.index)));
  const even = () => emit(new Set(thumbs.filter((t) => t.index % 2 === 1).map((t) => t.index)));
  const invert = () => emit(new Set(thumbs.filter((t) => !selected.has(t.index)).map((t) => t.index)));

  // ---- keyboard -----------------------------------------------------------

  /** Read the real column count rather than guessing — the grid is auto-fill. */
  function columns(): number {
    if (!gridEl) return 1;
    const template = getComputedStyle(gridEl).gridTemplateColumns;
    return Math.max(1, template.split(' ').filter(Boolean).length);
  }

  function focusTile(index: number) {
    const clamped = Math.max(0, Math.min(total - 1, index));
    focusIndex = clamped;
    gridEl?.querySelector<HTMLElement>(`[data-index="${clamped}"]`)?.focus();
  }

  function onKeydown(event: KeyboardEvent) {
    const cols = columns();
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: cols,
      ArrowUp: -cols,
    };

    if (event.key in step) {
      event.preventDefault();
      const target = focusIndex + step[event.key];
      if (event.shiftKey) {
        const next = new Set(selected);
        const [from, to] = anchor <= target ? [anchor, target] : [target, anchor];
        for (let i = Math.max(0, from); i <= Math.min(total - 1, to); i++) next.add(i);
        emit(next);
      }
      focusTile(target);
      return;
    }

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusTile(event.key === 'Home' ? 0 : total - 1);
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      toggle(focusIndex, event);
      return;
    }
    // Enter opens rather than selects: two verbs on one key is how people end
    // up somewhere they did not ask to be.
    if (event.key === 'Enter') {
      event.preventDefault();
      if (onopen) onopen(focusIndex);
      else toggle(focusIndex, event);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      all();
      return;
    }
    if (ondelete && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault();
      ondelete(focusIndex);
      return;
    }
    if (onrotate && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      onrotate(focusIndex, event.shiftKey ? -90 : 90);
    }
  }
</script>

<div class="wrap">
  <div class="toolbar">
    <span class="count tnum">
      {#if selectedCount > 0}
        {prefs.t('pagesSelected', { n: selectedCount })}
      {:else}
        {prefs.t('pagesTotal', { n: total })}
      {/if}
    </span>

    <div class="quick">
      <button class="ghost tiny" onclick={all}>{prefs.t('selectAll')}</button>
      <button class="ghost tiny" onclick={clear} disabled={selectedCount === 0}>{prefs.t('selectNone')}</button>
      <button class="ghost tiny" onclick={odd}>{prefs.t('selectOdd')}</button>
      <button class="ghost tiny" onclick={even}>{prefs.t('selectEven')}</button>
      <button class="ghost tiny" onclick={invert}>{prefs.t('selectInvert')}</button>
    </div>
  </div>

  <div
    class="grid"
    bind:this={gridEl}
    role="listbox"
    aria-multiselectable="true"
    aria-label={prefs.t('pageGridLabel')}
    tabindex="-1"
    onkeydown={onKeydown}
  >
    {#each shown as thumb, slot (thumb.index)}
      {@const isSelected = selected.has(thumb.index)}
      {@const isDeleted = deleted.has(thumb.index)}
      {@const spin = (thumb.rotation + (rotations[thumb.index] ?? 0)) % 360}
      <!-- Keyboard handling lives on the listbox, which is the roving-tabindex
           pattern: only the focused tile is tabbable and its key events bubble
           up to the one handler. A second handler per tile would be dead code. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="tile"
        class:selected={isSelected}
        class:deleted={isDeleted}
        class:dragging={dragFrom === thumb.index}
        class:dropbefore={dropAt === slot && dragFrom !== null}
        data-index={thumb.index}
        draggable={onreorder ? 'true' : 'false'}
        ondragstart={(e) => {
          dragFrom = thumb.index;
          e.dataTransfer?.setData('text/plain', String(thumb.index));
        }}
        ondragover={(e) => {
          if (dragFrom === null) return;
          e.preventDefault();
          dropAt = slot;
        }}
        ondrop={(e) => {
          if (dragFrom === null) return;
          e.preventDefault();
          moveTo(dragFrom, slot);
          dragFrom = null;
          dropAt = null;
        }}
        ondragend={() => {
          dragFrom = null;
          dropAt = null;
        }}
        role="option"
        aria-selected={isSelected}
        aria-label={prefs.t('pageN', { n: thumb.index + 1 })}
        tabindex={thumb.index === focusIndex ? 0 : -1}
        onclick={(e) => toggle(thumb.index, e)}
        onfocus={() => (focusIndex = thumb.index)}
      >
        <div class="sheet">
          {#if thumb.url}
            <img src={thumb.url} alt="" style="--spin: {spin}deg" loading="lazy" />
          {:else}
            <div class="placeholder" aria-hidden="true"></div>
          {/if}

          <!-- The tick is not decoration: selection must not be colour alone. -->
          {#if isSelected}
            <span class="tick" aria-hidden="true">✓</span>
          {/if}

          {#if onrotate || ondelete || onopen}
            <div class="controls">
              {#if onopen}
                <button
                  class="chip"
                  title={prefs.t('viewPage')}
                  aria-label="{prefs.t('viewPage')} — {prefs.t('pageN', { n: thumb.index + 1 })}"
                  onclick={(e) => { e.stopPropagation(); onopen(thumb.index); }}
                >⤢</button>
              {/if}
              {#if onrotate}
                <button
                  class="chip"
                  title={prefs.t('rotateLeft')}
                  aria-label="{prefs.t('rotateLeft')} — {prefs.t('pageN', { n: thumb.index + 1 })}"
                  onclick={(e) => { e.stopPropagation(); onrotate(thumb.index, -90); }}
                >↺</button>
                <button
                  class="chip"
                  title={prefs.t('rotateRight')}
                  aria-label="{prefs.t('rotateRight')} — {prefs.t('pageN', { n: thumb.index + 1 })}"
                  onclick={(e) => { e.stopPropagation(); onrotate(thumb.index, 90); }}
                >↻</button>
              {/if}
              {#if ondelete}
                <button
                  class="chip danger"
                  title={isDeleted ? prefs.t('restorePage') : prefs.t('deletePage')}
                  aria-label="{isDeleted ? prefs.t('restorePage') : prefs.t('deletePage')} — {prefs.t('pageN', { n: thumb.index + 1 })}"
                  onclick={(e) => { e.stopPropagation(); ondelete(thumb.index); }}
                >{isDeleted ? '↺' : '✕'}</button>
              {/if}
            </div>
          {/if}
        </div>

        <span class="num tnum">{thumb.index + 1}</span>

        {#if onreorder}
          <!-- Drag is the fast way; these are the reachable one. A grid that
               can only be rearranged by dragging cannot be rearranged at all
               with a keyboard or on a touchscreen. -->
          <span class="moves">
            <button
              class="chip"
              disabled={slot === 0}
              aria-label="{prefs.t('moveEarlier')} — {prefs.t('pageN', { n: thumb.index + 1 })}"
              onclick={(e) => { e.stopPropagation(); nudge(thumb.index, -1); }}
            >◀</button>
            <button
              class="chip"
              disabled={slot === shown.length - 1}
              aria-label="{prefs.t('moveLater')} — {prefs.t('pageN', { n: thumb.index + 1 })}"
              onclick={(e) => { e.stopPropagation(); nudge(thumb.index, 1); }}
            >▶</button>
          </span>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .count { font-size: var(--fs-1); color: var(--text-muted); font-weight: 600; }
  .quick { display: flex; flex-wrap: wrap; gap: var(--space-1); }
  .tiny { padding: var(--space-1) var(--space-2); font-size: var(--fs-1); }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: var(--space-3);
    outline: none;
  }
  @media (min-width: 1280px) {
    .grid { grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); }
  }
  @media (max-width: 520px) {
    .grid { grid-template-columns: repeat(2, 1fr); gap: var(--space-3); }
  }

  .tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    cursor: pointer;
    border-radius: var(--radius-sm);
    padding: var(--space-1);
    /* The browser's own windowing: tiles outside the viewport are not laid out
       or painted, which is what keeps a 900-page grid scrollable. The intrinsic
       size keeps the scrollbar from jumping as they come and go. */
    content-visibility: auto;
    contain-intrinsic-size: auto 170px;
  }
  .tile:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  .sheet {
    position: relative;
    width: 100%;
    aspect-ratio: 1 / 1.35;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: var(--shadow-sm);
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  .tile:hover .sheet { border-color: var(--accent); }

  .selected .sheet {
    border-color: var(--accent);
    border-width: 2px;
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .deleted .sheet { opacity: 0.32; }
  .deleted .num { text-decoration: line-through; }

  img {
    max-width: 100%;
    max-height: 100%;
    display: block;
    transform: rotate(var(--spin, 0deg));
    transition: transform 0.15s;
  }

  .placeholder {
    width: 100%;
    height: 100%;
    background: linear-gradient(100deg, var(--surface-2) 30%, var(--surface-3) 50%, var(--surface-2) 70%);
    background-size: 220% 100%;
    animation: shimmer 1.1s linear infinite;
  }
  @keyframes shimmer {
    to { background-position: -120% 0; }
  }

  .tick {
    position: absolute;
    top: var(--space-1);
    inset-inline-start: var(--space-1);
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    font-size: var(--fs-1);
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    /* The tick lands on whatever the page happens to have in its corner. A
       ring keeps it legible over a dark banner as well as over white paper. */
    box-shadow: 0 0 0 2px var(--surface), 0 1px 2px rgba(0, 0, 0, 0.3);
  }

  .controls {
    position: absolute;
    inset-inline-end: var(--space-1);
    top: var(--space-1);
    display: flex;
    gap: var(--space-1);
    opacity: 0;
    transition: opacity 0.12s;
  }
  .tile:hover .controls,
  .tile:focus-within .controls { opacity: 1; }

  .chip {
    width: 24px;
    height: 24px;
    padding: 0;
    font-size: var(--fs-1);
    line-height: 1;
    border-radius: var(--radius-sm);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .chip.danger:hover { color: var(--danger); border-color: var(--danger); }

  .num { font-size: var(--fs-1); color: var(--text-muted); }
  .selected .num { color: var(--accent); font-weight: 600; }

  .tile.dragging { opacity: 0.4; }
  .tile.dropbefore .sheet {
    box-shadow: -3px 0 0 0 var(--accent), var(--shadow-sm);
  }

  .moves {
    display: flex;
    gap: var(--space-1);
    opacity: 0;
    transition: opacity 0.12s;
  }
  .tile:hover .moves,
  .tile:focus-within .moves { opacity: 1; }
  .moves .chip { width: 24px; height: 24px; }
</style>

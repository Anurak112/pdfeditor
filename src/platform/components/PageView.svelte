<script lang="ts">
  /**
   * One page, at a size you chose.
   *
   * The grid answers "which pages"; this answers "what is actually on this
   * one". Edit needs it to show the text being replaced, Compress to compare
   * before and after, and anyone at all to check a page before committing to
   * an operation on it.
   *
   * Rendering happens in the worker, so zooming a 40-megabyte scan does not
   * freeze the tab. The previous picture stays on screen while the next one is
   * drawn: blanking the page on every zoom step is what makes a viewer feel
   * broken even when it is fast.
   */
  import { prefs } from '../prefs.svelte';
  import type { PageRenderer } from '../renderer.svelte';

  interface Props {
    renderer: PageRenderer;
    index: number;
    onindex: (next: number) => void;
    /** Shown as a way back when the grid is the caller. */
    onclose?: () => void;
  }
  let { renderer, index, onindex, onclose }: Props = $props();

  type Fit = 'width' | 'page' | 'free';

  const STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

  let fit = $state<Fit>('width');
  let zoom = $state(1);
  let viewport = $state<HTMLDivElement | undefined>();
  let box = $state({ w: 0, h: 0 });

  const total = $derived(renderer.pageCount);
  const page = $derived(renderer.page);

  /** Natural page size — from this render if we have one, else from the thumbnail metadata. */
  const natural = $derived.by(() => {
    if (page && page.index === index) return { w: page.width, h: page.height };
    const thumb = renderer.thumbs[index];
    if (thumb?.width) return { w: thumb.width, h: thumb.height };
    // A4 as a stand-in only until the first render answers for real.
    return { w: 595, h: 842 };
  });

  /** Space the page may occupy, minus the breathing room the padding gives it. */
  const PAD = 32;

  const effectiveZoom = $derived.by(() => {
    if (box.w === 0) return zoom;
    if (fit === 'width') return (box.w - PAD) / natural.w;
    if (fit === 'page') return Math.min((box.w - PAD) / natural.w, (box.h - PAD) / natural.h);
    return zoom;
  });

  const displayWidth = $derived(Math.max(48, natural.w * effectiveZoom));
  const displayHeight = $derived(Math.max(48, natural.h * effectiveZoom));

  $effect(() => {
    const el = viewport;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      box = { w: entry.contentRect.width, h: entry.contentRect.height };
    });
    observer.observe(el);
    box = { w: el.clientWidth, h: el.clientHeight };
    return () => observer.disconnect();
  });

  /**
   * Ask for a redraw when the page or its size changes.
   *
   * Debounced because a resize or a held zoom key fires many times, and each
   * one would otherwise queue a full-page rasterise. Device pixel ratio is
   * capped at 2: past that the file gets much bigger and nobody can see it.
   */
  let redrawTimer = 0;
  $effect(() => {
    const targetWidth = displayWidth * Math.min(window.devicePixelRatio || 1, 2);
    const wanted = index;
    if (box.w === 0) return;

    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => renderer.showPage(wanted, targetWidth), 120) as unknown as number;
    return () => clearTimeout(redrawTimer);
  });

  function step(direction: 1 | -1) {
    const current = effectiveZoom;
    const next =
      direction === 1
        ? STEPS.find((s) => s > current + 0.001)
        : [...STEPS].reverse().find((s) => s < current - 0.001);
    if (next) {
      zoom = next;
      fit = 'free';
    }
  }

  function go(to: number) {
    onindex(Math.max(0, Math.min(total - 1, to)));
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement) return;
    const k = event.key;
    if (k === 'ArrowRight' || k === 'PageDown') { event.preventDefault(); go(index + 1); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { event.preventDefault(); go(index - 1); }
    else if (k === 'Home') { event.preventDefault(); go(0); }
    else if (k === 'End') { event.preventDefault(); go(total - 1); }
    else if (k === '+' || k === '=') { event.preventDefault(); step(1); }
    else if (k === '-') { event.preventDefault(); step(-1); }
    else if (k === '0') { event.preventDefault(); fit = 'width'; }
    else if (k === '9') { event.preventDefault(); fit = 'page'; }
  }

  /** The number box accepts a typed page, but only commits something real. */
  function commitPageInput(value: string) {
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) go(n - 1);
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="viewer">
  <div class="toolbar">
    {#if onclose}
      <button class="ghost tiny" onclick={onclose}>‹ {prefs.t('backToGrid')}</button>
    {/if}

    <div class="nav">
      <button
        class="ghost tiny"
        onclick={() => go(index - 1)}
        disabled={index === 0}
        aria-label={prefs.t('prevPage')}
      >‹</button>

      <label class="jump">
        <span class="sr-only">{prefs.t('pageNumber')}</span>
        <input
          type="number"
          min="1"
          max={total}
          value={index + 1}
          onchange={(e) => commitPageInput((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <span class="of tnum">/ {prefs.formatNumber(total)}</span>

      <button
        class="ghost tiny"
        onclick={() => go(index + 1)}
        disabled={index >= total - 1}
        aria-label={prefs.t('nextPage')}
      >›</button>
    </div>

    <div class="zoom">
      <button class="ghost tiny" onclick={() => step(-1)} aria-label={prefs.t('zoomOut')}>−</button>
      <span class="level tnum" aria-live="polite">{Math.round(effectiveZoom * 100)}%</span>
      <button class="ghost tiny" onclick={() => step(1)} aria-label={prefs.t('zoomIn')}>+</button>

      <button
        class="ghost tiny fitbtn"
        class:on={fit === 'width'}
        onclick={() => (fit = 'width')}
      >{prefs.t('fitWidth')}</button>
      <button
        class="ghost tiny fitbtn"
        class:on={fit === 'page'}
        onclick={() => (fit = 'page')}
      >{prefs.t('fitPage')}</button>
    </div>
  </div>

  <div class="viewport" bind:this={viewport}>
    <div class="sheet" style="width: {displayWidth}px; height: {displayHeight}px">
      {#if page && page.index === index}
        <img src={page.url} alt={prefs.t('pageN', { n: index + 1 })} />
      {:else if renderer.failed}
        <div class="state error">
          <p>{prefs.t('thumbsFailed')}</p>
        </div>
      {:else}
        <div class="state" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <p>{prefs.t('renderingPage')}</p>
        </div>
      {/if}

      <!-- Redrawing at a new zoom keeps the old picture underneath, so the page
           never blanks; this only marks that a sharper one is on its way. -->
      {#if renderer.pageLoading && page && page.index === index}
        <span class="refreshing" aria-hidden="true"></span>
      {/if}
    </div>
  </div>
</div>

<style>
  .viewer {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
    height: 100%;
  }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3) var(--space-4);
    flex-wrap: wrap;
  }

  .nav,
  .zoom {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .tiny { padding: var(--space-1) var(--space-2); font-size: var(--fs-1); min-width: 32px; }

  .jump { display: inline-flex; }
  .jump input {
    width: 64px;
    padding: var(--space-1) var(--space-2);
    font-size: var(--fs-1);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .of { font-size: var(--fs-1); color: var(--text-muted); margin-inline-end: var(--space-1); }

  .level {
    font-size: var(--fs-1);
    color: var(--text-muted);
    min-width: 48px;
    text-align: center;
  }

  .fitbtn { border: 1px solid var(--border); }
  .fitbtn.on {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-soft);
    font-weight: 600;
  }

  .viewport {
    flex: 1;
    min-height: 340px;
    max-height: 74vh;
    overflow: auto;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-4);
    display: flex;
    justify-content: center;
    align-items: flex-start;
  }

  .sheet {
    position: relative;
    flex: none;
    background: #fff;
    box-shadow: var(--shadow);
    border-radius: 2px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: contain;
  }

  .state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    color: var(--text-muted);
    font-size: var(--fs-2);
    padding: var(--space-5);
    text-align: center;
  }
  .state p { margin: 0; }
  .state.error { color: var(--danger); }

  .spinner {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .refreshing {
    position: absolute;
    top: var(--space-2);
    inset-inline-end: var(--space-2);
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid rgba(0, 0, 0, 0.15);
    border-top-color: var(--accent);
    animation: spin 0.7s linear infinite;
  }

  @media (max-width: 640px) {
    .toolbar { gap: var(--space-2); }
    .viewport { padding: var(--space-3); max-height: 62vh; }
    .fitbtn { font-size: var(--fs-1); padding: var(--space-1) var(--space-2); }
  }
</style>

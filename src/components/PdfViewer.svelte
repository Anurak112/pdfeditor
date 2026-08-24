<script lang="ts">
  import { renderPage, type RenderedPage } from '../lib/pdf/render';
  import type { PageText, TextHit } from '../lib/pdf/textExtract';
  import type { PdfDocument } from '../lib/pdf/pdfjs';

  interface Props {
    doc: PdfDocument | null;
    pageNumber: number;
    pageText: PageText | undefined;
    hits: TextHit[];
    appliedHits: TextHit[];
    selectedHit: number;
    zoom: number;
    onrendered?: (r: RenderedPage) => void;
    onpicktext?: (text: string) => void;
    onselecthit?: (index: number) => void;
  }

  let {
    doc,
    pageNumber,
    pageText,
    hits,
    appliedHits,
    selectedHit,
    zoom,
    onrendered,
    onpicktext,
    onselecthit,
  }: Props = $props();

  let host: HTMLDivElement;
  let textLayer: HTMLDivElement | undefined = $state();
  let rendered = $state<RenderedPage | null>(null);
  let failed = $state('');
  let renderToken = 0;

  $effect(() => {
    const currentDoc = doc;
    const n = pageNumber;
    const z = zoom;
    if (!currentDoc) return;

    const token = ++renderToken;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderPage(currentDoc, n, z * dpr)
      .then((r) => {
        if (token !== renderToken) return;
        failed = '';
        rendered = r;
        host?.replaceChildren(r.canvas);
        r.canvas.style.width = r.width * z + 'px';
        r.canvas.style.height = r.height * z + 'px';
        r.canvas.style.display = 'block';
        onrendered?.(r);
      })
      .catch((e) => {
        if (token !== renderToken) return;
        failed = e instanceof Error ? e.message : 'แสดงหน้า PDF ไม่สำเร็จ';
      });
  });

  // pdf.js-style horizontal fit: measure the rendered span, squeeze it onto the
  // advance width the PDF actually used, so selection lines up with the ink
  $effect(() => {
    void pageText;
    void zoom;
    if (!textLayer) return;
    requestAnimationFrame(() => {
      for (const el of Array.from(textLayer!.children) as HTMLElement[]) {
        const target = Number(el.dataset.w);
        if (!target) continue;
        el.style.transform = '';
        const actual = el.getBoundingClientRect().width;
        if (actual > 0) el.style.transform = `scaleX(${target / actual})`;
      }
    });
  });

  const pageHeight = $derived(pageText ? pageText.height : 0);

  function boxOf(hit: TextHit) {
    const size = hit.item.fontSize;
    return {
      left: hit.x * zoom,
      top: (pageHeight - hit.item.y - hit.item.ascent * size) * zoom,
      width: Math.max(hit.width, 1) * zoom,
      height: (hit.item.ascent - hit.item.descent) * size * zoom,
    };
  }
</script>

<div class="viewer">
  {#if failed}
    <p class="failed">{failed}</p>
  {/if}

  <div class="stage" style="width:{(pageText?.width ?? 0) * zoom}px; height:{pageHeight * zoom}px">
    <div class="canvas-host" bind:this={host}></div>

    {#if pageText}
      <div class="text-layer" bind:this={textLayer}>
        {#each pageText.items as item (item.index)}
          {#if item.text.trim()}
            <span
              role="button"
              tabindex="-1"
              data-w={item.width * zoom}
              title="คลิกเพื่อใช้ข้อความนี้ในช่องค้นหา"
              style="
                left:{item.x * zoom}px;
                top:{(pageHeight - item.y - item.ascent * item.fontSize) * zoom}px;
                font-size:{item.fontSize * zoom}px;
                line-height:{(item.ascent - item.descent) * item.fontSize * zoom}px;
              "
              onclick={() => onpicktext?.(item.text.trim())}
              onkeydown={(e) => e.key === 'Enter' && onpicktext?.(item.text.trim())}
            >{item.text}</span>
          {/if}
        {/each}
      </div>

      {#each appliedHits as hit, i (i)}
        {@const b = boxOf(hit)}
        <div class="mark applied" style="left:{b.left}px; top:{b.top}px; width:{b.width}px; height:{b.height}px"></div>
      {/each}

      {#each hits as hit, i (i)}
        {@const b = boxOf(hit)}
        <button
          class="mark hit"
          class:selected={selectedHit === i}
          style="left:{b.left}px; top:{b.top}px; width:{b.width}px; height:{b.height}px"
          title={`จุดที่ ${i + 1} — คลิกเพื่อเลือกเฉพาะจุดนี้`}
          onclick={() => onselecthit?.(selectedHit === i ? -1 : i)}
          aria-label={`เลือกจุดที่ ${i + 1}`}
        ></button>
      {/each}
    {/if}
  </div>
</div>

<style>
  .viewer {
    flex: 1;
    min-width: 0;
    overflow: auto;
    padding: var(--space-6);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    background: var(--bg);
  }
  .stage {
    position: relative;
    background: #fff;
    box-shadow: var(--shadow);
    border-radius: 3px;
    flex: none;
  }
  .canvas-host { position: absolute; inset: 0; }

  .text-layer {
    position: absolute;
    inset: 0;
    overflow: hidden;
    line-height: 1;
  }
  .text-layer span {
    position: absolute;
    white-space: pre;
    color: transparent;
    transform-origin: 0 0;
    cursor: pointer;
    border-radius: 2px;
  }
  .text-layer span:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); }
  .text-layer span::selection { background: color-mix(in srgb, var(--accent) 35%, transparent); }

  .mark {
    position: absolute;
    border-radius: 2px;
    pointer-events: none;
    padding: 0;
  }
  .mark.hit {
    background: var(--highlight);
    border: 1px solid var(--highlight-line);
    pointer-events: auto;
    cursor: pointer;
    animation: pop 0.35s ease-out;
  }
  .mark.hit.selected {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .mark.applied {
    background: var(--applied);
    border: 1px solid var(--applied-line);
  }
  @keyframes pop {
    from { opacity: 0; transform: scale(1.35); }
    to { opacity: 1; transform: scale(1); }
  }
  .failed {
    color: var(--danger);
    background: var(--danger-soft);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
  }
</style>

<script lang="ts">
  import { EditorSession } from './lib/editor/session.svelte';
  import { BatchSession } from './lib/editor/batchSession.svelte';
  import UploadScreen from './components/UploadScreen.svelte';
  import VersionBadge from './components/VersionBadge.svelte';
  import BatchScreen from './components/BatchScreen.svelte';
  import PdfViewer from './components/PdfViewer.svelte';
  import EditPanel from './components/EditPanel.svelte';
  import { formatBytes } from './lib/utils/file';

  const session = new EditorSession();
  const batch = new BatchSession();
  /** Batch is a separate screen, not a mode of the editor: nothing is previewed there. */
  let batchMode = $state(false);
  let zoom = $state(1.4);

  function startBatch(files: File[]) {
    batch.findText = session.findText;
    batch.replaceText = session.replaceText;
    batch.add(files);
    batchMode = true;
  }

  const ZOOMS = [0.75, 1, 1.25, 1.4, 1.75, 2, 2.5];

  function stepZoom(dir: 1 | -1) {
    const i = ZOOMS.findIndex((z) => z >= zoom - 0.001);
    const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + dir))];
    if (next) zoom = next;
  }

  function onKey(e: KeyboardEvent) {
    if (session.stage !== 'editor') return;
    const typing = e.target instanceof HTMLInputElement;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      session.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      session.download();
    } else if (e.key === 'Enter' && typing) {
      session.apply();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if session.stage === 'editor'}
  <div class="app">
    <header>
      <button class="ghost" onclick={() => session.reset()} title="เปิดไฟล์อื่น">← กลับ</button>
      <div class="title">
        <span class="name">{session.fileName}</span>
        <span class="meta">
          {formatBytes(session.fileSize)} · {session.pageCount} หน้า
          {#if session.dirty}<span class="dot">•</span><span class="edited">แก้แล้ว {session.replacements.length} จุด</span>{/if}
        </span>
      </div>

      <VersionBadge />

      <div class="zoom">
        <button class="ghost" onclick={() => stepZoom(-1)} disabled={zoom <= ZOOMS[0]} aria-label="ย่อ">−</button>
        <span class="level">{Math.round(zoom * 100)}%</span>
        <button class="ghost" onclick={() => stepZoom(1)} disabled={zoom >= ZOOMS[ZOOMS.length - 1]} aria-label="ขยาย">+</button>
      </div>

      <button class="primary" onclick={() => session.download()}>⬇ ดาวน์โหลด PDF</button>
    </header>

    <div class="body">
      {#if session.pageCount > 1}
        <nav class="pages">
          {#each Array(session.pageCount) as _, i (i)}
            <button
              class="page-chip"
              class:active={session.currentPage === i + 1}
              onclick={() => { session.currentPage = i + 1; session.selectedHit = -1; }}
            >
              หน้า {i + 1}
            </button>
          {/each}
        </nav>
      {/if}

      <PdfViewer
        doc={session.previewDoc}
        pageNumber={session.currentPage}
        pageText={session.pages.find((p) => p.page === session.currentPage)}
        hits={session.hits}
        appliedHits={session.appliedHits}
        selectedHit={session.selectedHit}
        {zoom}
        onrendered={(r) => (session.rendered = r)}
        onpicktext={(t) => { session.findText = t; session.selectedHit = -1; }}
        onselecthit={(i) => (session.selectedHit = i)}
      />

      <EditPanel {session} />
    </div>
  </div>
{:else if batchMode}
  <BatchScreen {batch} onexit={() => (batchMode = false)} />
{:else}
  <UploadScreen
    error={session.error}
    busy={session.stage === 'loading'}
    onpick={(f) => session.open(f)}
    onpickmany={startBatch}
  />
{/if}

<style>
  .app { height: 100%; display: flex; flex-direction: column; }

  header {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .title { min-width: 0; display: flex; flex-direction: column; line-height: 1.3; }
  .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { font-size: var(--fs-1); color: var(--text-faint); }
  .dot { margin: 0 var(--space-2); }
  .edited { color: var(--ok); font-weight: 600; }

  header :global(.version-badge) { margin-left: auto; padding-right: var(--space-1); }

  .zoom { margin-left: auto; display: flex; align-items: center; gap: var(--space-1); }
  .zoom button { padding: var(--space-1) var(--space-3); font-size: var(--fs-3); line-height: 1; }
  .level { font-size: var(--fs-1); color: var(--text-muted); width: 44px; text-align: center; font-variant-numeric: tabular-nums; }

  .body { flex: 1; display: flex; min-height: 0; }

  .pages {
    width: 116px;
    flex: none;
    border-right: 1px solid var(--border);
    background: var(--surface);
    padding: var(--space-3);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .page-chip { width: 100%; font-size: var(--fs-1); padding: var(--space-2); }
  .page-chip.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }

  @media (max-width: 900px) {
    .body { flex-direction: column; }
    :global(.panel) { width: 100% !important; border-left: none !important; border-top: 1px solid var(--border); }
  }
</style>

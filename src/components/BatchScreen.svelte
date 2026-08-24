<script lang="ts">
  import VersionBadge from './VersionBadge.svelte';
  import type { BatchSession, BatchRow } from '../lib/editor/batchSession.svelte';
  import type { EditMethod } from '../lib/pdf/exporter';
  import { formatBytes } from '../lib/utils/file';

  interface Props {
    batch: BatchSession;
    onexit: () => void;
  }
  let { batch, onexit }: Props = $props();

  let dragging = $state(false);
  let input: HTMLInputElement;

  const METHOD_LABEL: Record<EditMethod, { text: string; tone: 'ok' | 'warn' }> = {
    native: { text: 'แก้ในไฟล์ตรง ๆ', tone: 'ok' },
    erase: { text: 'ลบเดิม + วาดใหม่', tone: 'ok' },
    overlay: { text: 'ทับแล้ววาดใหม่', tone: 'warn' },
  };

  function take(files: FileList | null | undefined) {
    if (files && files.length) batch.add([...files]);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    take(e.dataTransfer?.files);
  }

  function statusText(row: BatchRow): string {
    switch (row.state) {
      case 'waiting': return 'รอคิว';
      case 'working': return 'กำลังแก้…';
      case 'done': return `แก้แล้ว ${row.hits} จุด`;
      case 'empty': return row.message;
      case 'failed': return row.message;
    }
  }
</script>

<div class="screen">
  <header>
    <button class="ghost" onclick={onexit}>← ไฟล์เดียว</button>
    <div class="title">
      <span class="name">แก้ทีละหลายไฟล์</span>
      <span class="meta">ค้นหา/แทนที่ชุดเดียว ใช้กับทุกไฟล์ที่ใส่เข้ามา · ทำงานในเครื่อง 100%</span>
    </div>
    <VersionBadge />

    {#if batch.edited.length > 0}
      <button class="primary" onclick={() => batch.downloadAll()}>
        ⬇ ดาวน์โหลด {batch.edited.length > 1 ? `ZIP (${batch.edited.length} ไฟล์)` : 'ไฟล์ที่แก้แล้ว'}
      </button>
    {/if}
  </header>

  <div class="body">
    <section class="controls">
      <div class="fields">
        <label class="field">
          <span>ค้นหา</span>
          <input type="text" class="mono" bind:value={batch.findText} placeholder="246/8" spellcheck="false" />
        </label>
        <label class="field">
          <span>แทนที่ด้วย</span>
          <input type="text" class="mono" bind:value={batch.replaceText} placeholder="135/7" spellcheck="false" />
        </label>
      </div>

      <div class="overflow-choice">
        <span class="choice-label">ถ้าข้อความใหม่ยาวกว่าเดิม</span>
        <div class="segmented" role="group" aria-label="วิธีจัดการข้อความที่ยาวกว่าเดิม">
          <button class:on={batch.overflow === 'squeeze'} onclick={() => (batch.overflow = 'squeeze')}>บีบให้พอดี</button>
          <button class:on={batch.overflow === 'push'} onclick={() => (batch.overflow = 'push')}>ดันข้อความถัดไป</button>
        </div>
      </div>

      <button class="primary wide" disabled={!batch.canRun} onclick={() => batch.run()}>
        {#if batch.running}
          กำลังแก้ {batch.progress}/{batch.total} ไฟล์…
        {:else}
          แก้ทั้งหมด {batch.total} ไฟล์
        {/if}
      </button>

      {#if batch.ran && !batch.running}
        <div class="summary">
          <p>
            แก้แล้ว <strong>{batch.edited.length}</strong> ไฟล์ ·
            รวม <strong>{batch.totalHits}</strong> จุด
          </p>
          {#if batch.untouched.length}
            <p class="muted">ไม่พบข้อความใน {batch.untouched.length} ไฟล์</p>
          {/if}
          {#if batch.failed.length}
            <p class="bad">แก้ไม่สำเร็จ {batch.failed.length} ไฟล์</p>
          {/if}
          {#if batch.anyOverlay}
            <p class="warn">มีไฟล์ที่ต้องใช้วิธี "ทับแล้ววาดใหม่" — ข้อความเดิมยังค้นหาได้จาก text layer</p>
          {/if}
        </div>
      {/if}

      {#if batch.error}
        <p class="error" role="alert">{batch.error}</p>
      {/if}

      <p class="hint">
        เปิดทีละไฟล์เพื่อดูตัวอย่างก่อนได้ที่โหมด "ไฟล์เดียว" — โหมดนี้ไม่แสดงตัวอย่าง แต่รายงานทุกไฟล์ว่าใช้วิธีไหน
      </p>
    </section>

    <section class="list">
      <button
        class="drop"
        class:dragging
        ondragover={(e) => { e.preventDefault(); dragging = true; }}
        ondragleave={() => (dragging = false)}
        ondrop={onDrop}
        onclick={() => input.click()}
      >
        <span class="icon">📄</span>
        <span>ลากไฟล์ PDF มาวาง (หลายไฟล์ได้) หรือคลิกเพื่อเลือก</span>
      </button>
      <input
        class="sr-only"
        type="file"
        accept="application/pdf,.pdf"
        multiple
        bind:this={input}
        onchange={(e) => { take((e.currentTarget as HTMLInputElement).files); (e.currentTarget as HTMLInputElement).value = ''; }}
      />

      {#if batch.rows.length === 0}
        <p class="empty">ยังไม่มีไฟล์ในรายการ</p>
      {:else}
        <table>
          <thead>
            <tr>
              <th class="col-name">ไฟล์</th>
              <th class="col-state">สถานะ</th>
              <th class="col-method">วิธี</th>
              <th class="col-act"></th>
            </tr>
          </thead>
          <tbody>
            {#each batch.rows as row (row.id)}
              <tr class:working={row.state === 'working'}>
                <td class="col-name">
                  <span class="file">{row.name}</span>
                  <span class="size">{formatBytes(row.size)}</span>
                </td>
                <td class="col-state">
                  <span class="state {row.state}">{statusText(row)}</span>
                </td>
                <td class="col-method">
                  {#if row.method}
                    <span class="tag {METHOD_LABEL[row.method].tone}">{METHOD_LABEL[row.method].text}</span>
                    {#if !row.clean}<span class="tag warn">เหลือของเดิมใน text layer</span>{/if}
                  {:else}
                    <span class="muted">—</span>
                  {/if}
                </td>
                <td class="col-act">
                  {#if row.bytes}
                    <button class="ghost tiny" onclick={() => batch.downloadOne(row.id)}>⬇</button>
                  {/if}
                  {#if !batch.running}
                    <button class="ghost tiny" onclick={() => batch.remove(row.id)} aria-label="เอาออก">✕</button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>

        {#if !batch.running}
          <button class="ghost tiny clear" onclick={() => batch.clear()}>ล้างรายการทั้งหมด</button>
        {/if}
      {/if}
    </section>
  </div>
</div>

<style>
  .screen { height: 100%; display: flex; flex-direction: column; }

  header {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .title { min-width: 0; display: flex; flex-direction: column; line-height: 1.35; }
  .name { font-weight: 600; }
  .meta { font-size: var(--fs-1); color: var(--text-faint); }
  header .primary { margin-left: auto; }
  header :global(.version-badge) { margin-left: auto; }
  header .primary + :global(.version-badge) { margin-left: 0; }

  .body { flex: 1; display: flex; min-height: 0; }

  .controls {
    width: 330px;
    flex: none;
    border-right: 1px solid var(--border);
    background: var(--surface);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    overflow-y: auto;
  }
  .fields { display: flex; flex-direction: column; gap: var(--space-3); }
  .field { display: flex; flex-direction: column; gap: var(--space-1); }
  .field span { font-size: var(--fs-1); color: var(--text-muted); font-weight: 500; }
  .wide { width: 100%; }

  .overflow-choice { display: flex; flex-direction: column; gap: var(--space-2); }
  .choice-label { font-size: var(--fs-1); color: var(--text-muted); font-weight: 500; }
  .segmented {
    display: flex;
    gap: var(--space-1);
    padding: var(--space-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
  }
  .segmented button {
    flex: 1;
    padding: var(--space-2);
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    font-size: var(--fs-2);
    color: var(--text-muted);
    cursor: pointer;
  }
  .segmented button.on {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
  }

  .summary { display: flex; flex-direction: column; gap: var(--space-1); font-size: var(--fs-2); }
  .summary p { margin: 0; }
  .muted { color: var(--text-faint); }
  .warn { color: var(--warn); background: var(--warn-soft); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); }
  .bad { color: var(--danger); }
  .hint { margin: 0; font-size: var(--fs-1); color: var(--text-faint); }
  .error {
    margin: 0;
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--danger-soft);
    color: var(--danger);
    font-size: var(--fs-2);
  }

  .list { flex: 1; padding: var(--space-5); overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-4); }

  .drop {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-5);
    border: 2px dashed var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface);
    color: var(--text-muted);
    font-size: var(--fs-2);
    width: 100%;
  }
  .drop:hover, .drop.dragging { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
  .icon { font-size: var(--fs-4); }

  .empty { margin: 0; text-align: center; color: var(--text-faint); font-size: var(--fs-1); }

  table { width: 100%; border-collapse: collapse; font-size: var(--fs-2); }
  th {
    text-align: left;
    font-size: var(--fs-1);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    font-weight: 700;
    padding: 0 var(--space-3) var(--space-2);
  }
  td { padding: var(--space-2) var(--space-3); border-top: 1px solid var(--border); vertical-align: middle; }
  tr.working td { background: var(--accent-soft); }

  .col-name { min-width: 0; }
  .file { display: block; word-break: break-all; }
  .size { font-size: var(--fs-1); color: var(--text-faint); }
  .col-state { width: 150px; }
  .col-method { width: 210px; }
  .col-act { width: 70px; text-align: right; white-space: nowrap; }

  .state.done { color: var(--ok); font-weight: 600; }
  .state.empty { color: var(--text-faint); }
  .state.failed { color: var(--danger); }
  .state.working { color: var(--accent); }

  .tag {
    display: inline-block;
    font-size: var(--fs-1);
    font-weight: 600;
    padding: 0 var(--space-2);
    border-radius: 999px;
    margin-right: var(--space-1);
  }
  .tag.ok { background: var(--ok-soft); color: var(--ok); }
  .tag.warn { background: var(--warn-soft); color: var(--warn); }

  .tiny { padding: var(--space-1) var(--space-2); font-size: var(--fs-1); }
  .clear { align-self: flex-start; }

  @media (max-width: 900px) {
    .body { flex-direction: column; }
    .controls { width: 100%; border-right: none; border-bottom: 1px solid var(--border); }
  }
</style>

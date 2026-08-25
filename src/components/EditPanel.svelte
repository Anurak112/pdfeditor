<script lang="ts">
  import type { EditorSession } from '../lib/editor/session.svelte';
  import type { EditMethod } from '../lib/pdf/exporter';

  interface Props { session: EditorSession }
  let { session }: Props = $props();

  const METHOD: Record<EditMethod, { label: string; tone: 'ok' | 'warn'; blurb: string }> = {
    native: {
      label: 'แก้ในไฟล์ตรง ๆ',
      tone: 'ok',
      blurb: 'เปลี่ยนตัวอักษรในไฟล์เดิม ใช้ฟอนต์เดิม ไม่มีกล่องทับ และไม่เหลือของเก่าใน text layer',
    },
    erase: {
      label: 'ลบของเดิม + วาดใหม่',
      tone: 'ok',
      blurb: 'ลบตัวอักษรเดิมออกจากไฟล์ แล้ววาดข้อความใหม่ทับตำแหน่งเดิม ไม่เหลือของเก่าใน text layer',
    },
    overlay: {
      label: 'ทับแล้ววาดใหม่',
      tone: 'warn',
      blurb: 'ทับพื้นหลังแล้ววาดใหม่ — ภาพถูกต้อง แต่ข้อความเดิมยังค้นหา/ก๊อปได้จาก text layer',
    },
  };

  const canApply = $derived(
    !session.busy && session.targetCount > 0 && session.replaceText.trim().length > 0 && session.replaceText !== session.findText,
  );
</script>

<aside class="panel">
  <section class="block">
    <h2>แก้ไขข้อความ</h2>

    <label class="field">
      <span>ค้นหา</span>
      <input type="text" class="mono" bind:value={session.findText} placeholder="123/45" spellcheck="false" />
    </label>

    <label class="field">
      <span>แทนที่ด้วย</span>
      <input type="text" class="mono" bind:value={session.replaceText} placeholder="678/90" spellcheck="false" />
    </label>

    {#if session.findText}
      {#if session.pageCount > 1 || session.totalHits > session.hits.length}
        <div class="segmented" role="group" aria-label="ขอบเขตการแก้">
          <button
            class:on={session.scope === 'page'}
            onclick={() => (session.scope = 'page')}
          >หน้านี้ <span class="count">{session.hits.length}</span></button>
          <button
            class:on={session.scope === 'all'}
            onclick={() => (session.scope = 'all')}
          >ทุกหน้า <span class="count">{session.totalHits}</span></button>
        </div>
      {/if}

      {#if session.targetCount > 0}
        <p class="found">
          จะแก้ <strong>{session.targetCount}</strong> จุด
          {#if session.selectedHit >= 0}
            <span class="muted">— เฉพาะจุดที่เลือกไว้</span>
            <button class="ghost tiny" onclick={() => (session.selectedHit = -1)}>แก้ทุกจุด</button>
          {:else if session.scope === 'all' && session.pageCount > 1}
            <span class="muted">ทั้งไฟล์ ({session.pageCount} หน้า)</span>
          {:else}
            <span class="muted">ในหน้า {session.currentPage}</span>
          {/if}
        </p>
        {#if session.selectedHit < 0 && session.hits.length > 1}
          <p class="scope muted">คลิกกรอบเหลืองบนหน้าเพื่อเลือกแก้เฉพาะจุด</p>
        {/if}
      {:else}
        <p class="notfound">
          ไม่พบ "{session.findText}" {session.scope === 'all' ? 'ในไฟล์นี้' : `ในหน้า ${session.currentPage}`}
          {#if session.scope === 'page' && session.totalHits > 0}
            <br /><span class="muted">แต่พบในหน้าอื่นรวม {session.totalHits} จุด — กด "ทุกหน้า"</span>
          {/if}
        </p>
      {/if}
    {/if}

    <div class="overflow-choice">
      <span class="choice-label">ถ้าข้อความใหม่ยาวกว่าเดิม</span>
      <div class="segmented" role="group" aria-label="วิธีจัดการข้อความที่ยาวกว่าเดิม">
        <button
          class:on={session.overflow === 'squeeze'}
          onclick={() => (session.overflow = 'squeeze')}
        >บีบให้พอดี</button>
        <button
          class:on={session.overflow === 'push'}
          onclick={() => (session.overflow = 'push')}
        >ดันข้อความถัดไป</button>
      </div>
      <p class="choice-hint">
        {session.overflow === 'squeeze'
          ? 'ตัวอักษรถูกบีบให้อยู่ในช่องเดิม — หน้าตาเอกสารไม่ขยับเลย'
          : 'ตัวอักษรคงขนาดเต็ม แล้วเลื่อนข้อความที่ตามมาในบรรทัดเดียวกันไปทางขวา'}
      </p>
    </div>

    <button class="primary wide" disabled={!canApply} onclick={() => session.apply()}>
      {session.busy || 'ใช้การเปลี่ยนแปลง'}
    </button>

    {#if session.replaceText === session.findText && session.findText}
      <p class="hint">ข้อความใหม่เหมือนของเดิม</p>
    {/if}
  </section>

  {#if session.error}
    <p class="error" role="alert">{session.error}</p>
  {/if}

  {#if session.reports.length > 0}
    <section class="block">
      <h2>ผลลัพธ์</h2>
      {#each session.reports as report (report.id)}
        {@const meta = METHOD[report.method]}
        <div class="result">
          <div class="result-head">
            <span class="check">✓</span>
            <span class="mono change">{report.find} → {report.replace}</span>
            <span class="page">หน้า {report.page}</span>
          </div>
          <div class="tag {meta.tone}">{meta.label}</div>
          <p class="blurb">{meta.blurb}</p>
          <dl class="facts">
            <div><dt>ฟอนต์</dt><dd>{report.fontName}</dd></div>
            {#if report.fontWidthError !== null}
              <div><dt>ความคลาดเคลื่อน</dt><dd>{report.fontWidthError.toFixed(3)} pt</dd></div>
            {/if}
            {#if report.fitScale < 0.999}
              <div><dt>บีบให้พอดี</dt><dd>{Math.round(report.fitScale * 100)}%</dd></div>
            {/if}
            {#if report.pushed > 0}
              <div><dt>ดันข้อความถัดไป</dt><dd>{report.pushed.toFixed(2)} pt</dd></div>
            {/if}
          </dl>
          {#if report.notes.length}
            <ul class="notes">
              {#each report.notes as note}<li>{note}</li>{/each}
            </ul>
          {/if}
        </div>
      {/each}

      <div class="row">
        <button onclick={() => session.undo()} disabled={!!session.busy}>↩ ย้อนกลับ 1 ขั้น</button>
        <button class="ghost" onclick={() => session.reset()}>เริ่มใหม่</button>
      </div>
    </section>
  {/if}

  <section class="block download">
    <button class="primary wide" onclick={() => session.download()} disabled={!session.previewBytes}>
      ⬇ ดาวน์โหลด PDF
    </button>
    <p class="filename mono">{session.outputName}</p>
    {#if !session.dirty}
      <p class="hint">ยังไม่ได้แก้อะไร — ดาวน์โหลดตอนนี้จะได้ไฟล์เดิม</p>
    {/if}
  </section>
</aside>

<style>
  .panel {
    width: 330px;
    flex: none;
    border-left: 1px solid var(--border);
    background: var(--surface);
    overflow-y: auto;
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  h2 {
    margin: 0;
    font-size: var(--fs-1);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .field { display: flex; flex-direction: column; gap: var(--space-1); }
  .field span { font-size: var(--fs-1); color: var(--text-muted); font-weight: 500; }

  .found, .notfound, .scope, .hint {
    margin: 0;
    font-size: var(--fs-2);
  }
  .found { color: var(--text); }
  .notfound {
    color: var(--warn);
    background: var(--warn-soft);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
  }
  .scope { color: var(--text-muted); display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .hint { color: var(--text-faint); font-size: var(--fs-1); }
  .muted { color: var(--text-faint); }

  .overflow-choice { display: flex; flex-direction: column; gap: var(--space-2); }
  .choice-label { font-size: var(--fs-1); color: var(--text-muted); font-weight: 500; }
  .choice-hint { margin: 0; font-size: var(--fs-1); color: var(--text-faint); }

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
  .segmented .count {
    font-family: var(--mono);
    font-size: var(--fs-1);
    opacity: 0.7;
    margin-left: var(--space-1);
  }

  .wide { width: 100%; }
  .tiny { padding: var(--space-1) var(--space-2); font-size: var(--fs-1); }
  .row { display: flex; gap: var(--space-2); }
  .row button { flex: 1; }

  .error {
    margin: 0;
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--danger-soft);
    color: var(--danger);
    font-size: var(--fs-2);
  }

  .result {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-3);
    background: var(--surface-2);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .result-head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .check {
    width: 20px; height: 20px;
    display: grid; place-items: center;
    border-radius: 50%;
    background: var(--ok);
    color: #fff;
    font-size: var(--fs-1);
    flex: none;
  }
  .change { font-weight: 600; }
  .page { margin-left: auto; font-size: var(--fs-1); color: var(--text-faint); }

  .tag {
    align-self: flex-start;
    font-size: var(--fs-1);
    font-weight: 600;
    padding: 0 var(--space-2);
    border-radius: 999px;
  }
  .tag.ok { background: var(--ok-soft); color: var(--ok); }
  .tag.warn { background: var(--warn-soft); color: var(--warn); }

  .blurb { margin: 0; font-size: var(--fs-1); color: var(--text-muted); }

  .facts { margin: 0; display: flex; flex-direction: column; gap: var(--space-1); }
  .facts > div { display: flex; justify-content: space-between; gap: var(--space-3); font-size: var(--fs-1); }
  .facts dt { color: var(--text-faint); }
  .facts dd { margin: 0; font-family: var(--mono); font-size: var(--fs-1); text-align: right; }

  .notes {
    margin: 0;
    padding-left: var(--space-4);
    font-size: var(--fs-1);
    color: var(--text-faint);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .download { margin-top: auto; padding-top: var(--space-4); border-top: 1px solid var(--border); }
  .filename { margin: 0; color: var(--text-faint); word-break: break-all; font-size: var(--fs-1); }
</style>

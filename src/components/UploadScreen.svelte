<script lang="ts">
  import VersionBadge from './VersionBadge.svelte';

  interface Props {
    error: string;
    busy: boolean;
    onpick: (file: File) => void;
    /** Dropping more than one file goes straight to batch mode. */
    onpickmany: (files: File[]) => void;
  }
  let { error, busy, onpick, onpickmany }: Props = $props();

  let dragging = $state(false);
  let input: HTMLInputElement;

  function take(files: FileList | null | undefined) {
    const list = files ? [...files] : [];
    if (list.length === 0) return;
    if (list.length === 1) onpick(list[0]);
    else onpickmany(list);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    take(e.dataTransfer?.files);
  }
</script>

<div class="screen">
  <div class="card">
    <div class="badge">ประมวลผลในเครื่อง 100%</div>
    <h1>Simple PDF Editor</h1>
    <p class="sub">ค้นหาและแทนที่ข้อความใน PDF — ทีละไฟล์หรือหลายไฟล์พร้อมกัน</p>

    <button
      class="drop"
      class:dragging
      class:busy
      disabled={busy}
      ondragover={(e) => { e.preventDefault(); dragging = true; }}
      ondragleave={() => (dragging = false)}
      ondrop={onDrop}
      onclick={() => input.click()}
    >
      {#if busy}
        <span class="spinner"></span>
        <span class="drop-title">กำลังเปิดไฟล์…</span>
      {:else}
        <span class="icon">📄</span>
        <span class="drop-title">อัปโหลด PDF</span>
        <span class="drop-hint">คลิกเพื่อเลือกไฟล์ หรือลากไฟล์มาวางตรงนี้ — วางหลายไฟล์ได้</span>
      {/if}
    </button>

    <input class="sr-only" type="file" accept="application/pdf,.pdf" multiple bind:this={input} onchange={(e) => take((e.currentTarget as HTMLInputElement).files)} />

    <button class="link" onclick={() => onpickmany([])}>
      หรือ แก้ทีละหลายไฟล์พร้อมกัน →
    </button>

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <p class="privacy">
      🔒 ไฟล์ PDF ของคุณจะถูกประมวลผลภายใน Browser และไม่ถูกอัปโหลดไปยัง Server
    </p>

    <p class="version"><VersionBadge /></p>
  </div>
</div>

<style>
  .screen {
    min-height: 100%;
    display: grid;
    place-items: center;
    padding: var(--space-7) var(--space-5);
  }
  .card {
    width: min(560px, 100%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow);
    padding: var(--space-8) var(--space-8) var(--space-7);
    text-align: center;
  }
  .badge {
    display: inline-block;
    font-size: var(--fs-1);
    font-weight: 600;
    color: var(--ok);
    background: var(--ok-soft);
    border-radius: 999px;
    padding: var(--space-1) var(--space-3);
    margin-bottom: var(--space-5);
  }
  h1 {
    margin: 0 0 var(--space-2);
    font-size: var(--fs-5);
    font-weight: 700;
    letter-spacing: -0.015em;
  }
  .sub {
    margin: 0 0 var(--space-6);
    color: var(--text-muted);
  }
  .drop {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-8) var(--space-5);
    border: 2px dashed var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
    color: var(--text);
  }
  .drop:hover:not(:disabled), .drop.dragging {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .icon { font-size: var(--fs-5); line-height: 1; }
  .drop-title { font-size: var(--fs-3); font-weight: 600; }
  .drop-hint { font-size: var(--fs-1); color: var(--text-muted); }
  .spinner {
    width: 24px; height: 24px;
    border: 3px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error {
    margin: var(--space-4) 0 0;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--danger-soft);
    color: var(--danger);
    font-size: var(--fs-2);
    text-align: left;
  }
  .link {
    margin-top: var(--space-4);
    border: none;
    background: none;
    color: var(--accent);
    font-size: var(--fs-2);
    font-weight: 600;
    cursor: pointer;
    padding: var(--space-1);
  }
  .link:hover { text-decoration: underline; }

  .privacy {
    margin: var(--space-6) 0 0;
    font-size: var(--fs-1);
    color: var(--text-faint);
  }
  .version { margin: var(--space-3) 0 0; }
</style>

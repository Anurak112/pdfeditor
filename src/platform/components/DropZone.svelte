<script lang="ts">
  /**
   * The upload target.
   *
   * Grown from the editor's own upload screen rather than rebuilt: the drag
   * handling, the multi-file path and the Thai copy were all already right.
   * What is new is that it takes images as well as PDFs, and that it can render
   * small enough to sit inside a workspace column.
   */
  import { prefs } from '../prefs.svelte';

  interface Props {
    onfiles: (files: File[]) => void;
    busy?: boolean;
    /** 'hero' on the home page, 'inline' inside a tool column. */
    variant?: 'hero' | 'inline';
    acceptImages?: boolean;
    label?: string;
  }
  let { onfiles, busy = false, variant = 'hero', acceptImages = false, label }: Props = $props();

  let dragging = $state(false);
  let input: HTMLInputElement;

  const accept = $derived(
    acceptImages ? 'application/pdf,.pdf,image/jpeg,image/png,.jpg,.jpeg,.png' : 'application/pdf,.pdf',
  );

  function take(list: FileList | null | undefined) {
    const files = list ? [...list] : [];
    if (files.length > 0) onfiles(files);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    take(e.dataTransfer?.files);
  }
</script>

<button
  class="drop {variant}"
  class:dragging
  class:busy
  disabled={busy}
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
  onclick={() => input.click()}
>
  {#if busy}
    <span class="spinner" aria-hidden="true"></span>
    <span class="title">{prefs.t('dropBusy')}</span>
  {:else}
    <svg class="arrow" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
    </svg>
    <span class="title">{label ?? prefs.t('dropTitle')}</span>
    <span class="hint">
      {dragging ? prefs.t('dropRelease') : prefs.t('dropHint')}
    </span>
    {#if acceptImages}
      <span class="types">{prefs.t('dropHintImages')}</span>
    {/if}
  {/if}
</button>

<input
  class="sr-only"
  type="file"
  {accept}
  multiple
  bind:this={input}
  onchange={(e) => {
    take((e.currentTarget as HTMLInputElement).files);
    // Let the same file be picked twice in a row after a reset.
    (e.currentTarget as HTMLInputElement).value = '';
  }}
/>

<style>
  .drop {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    border: 2px dashed var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    text-align: center;
    transition: border-color 0.12s, background 0.12s, color 0.12s;
  }
  .drop.hero { padding: var(--space-7) var(--space-6); min-height: 176px; }
  .drop.inline { padding: var(--space-6) var(--space-5); min-height: 140px; }

  .drop:hover:not(:disabled),
  .drop.dragging {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .drop.dragging { border-style: solid; }

  .arrow { color: var(--accent); }

  .title { font-weight: 600; font-size: var(--fs-3); text-wrap: balance; }
  .drop.inline .title { font-size: var(--fs-2); }

  .hint,
  .types {
    font-size: var(--fs-1);
    color: var(--text-muted);
    max-width: 42ch;
    line-height: 1.5;
    text-wrap: balance;
  }
  .types { color: var(--text-faint); }

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
</style>

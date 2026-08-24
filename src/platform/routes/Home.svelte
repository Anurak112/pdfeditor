<script lang="ts">
  /**
   * One dominant action, then the tools.
   *
   * Both entry orders work and neither is the "real" one: someone who knows they
   * want to merge picks the tool first, and someone holding a file they need to
   * do something with drops it first. Picking a tool with no files open just
   * opens that tool's workspace with the upload area waiting.
   */
  import DropZone from '../components/DropZone.svelte';
  import ErrorPanel from '../components/ErrorPanel.svelte';
  import ToolCard from '../components/ToolCard.svelte';
  import FileList from '../components/FileList.svelte';
  import { prefs } from '../prefs.svelte';
  import { router } from '../router.svelte';
  import { session } from '../session.svelte';
  import { TOOLS } from '../../tools/registry';
  import type { RecoveryAction } from '../../engine/errors';

  const present = $derived(session.presentMimeTypes);

  function incompatible(accepted: string[]): boolean {
    if (present.length === 0) return false;
    return !present.every((m) => accepted.includes(m));
  }

  function pick(toolId: string) {
    session.selectTool(toolId);
    router.openTool(toolId);
  }

  function onErrorAction(action: RecoveryAction) {
    if (action.kind === 'goto-tool' && action.toolId) pick(action.toolId);
    else if (action.kind === 'dismiss') session.dismissNotices();
    else session.reset();
  }
</script>

<div class="page">
  <section class="hero">
    <h1>{prefs.t('homeTitle')}</h1>
    <p class="sub">{prefs.t('homeSub')}</p>

    <div class="upload">
      <DropZone
        variant="hero"
        acceptImages
        busy={session.stage === 'loading'}
        onfiles={(files) => session.addFiles(files)}
      />
    </div>

    <p class="privacy">
      <span class="lock" aria-hidden="true">🔒</span>
      {prefs.t('privacyBadge')}
    </p>

    {#if session.error}
      <div class="alert">
        <ErrorPanel error={session.error} onaction={onErrorAction} />
      </div>
    {/if}

    {#each session.notices as notice (notice.code + prefs.pick(notice.message))}
      <div class="alert">
        <ErrorPanel error={notice} onaction={onErrorAction} />
      </div>
    {/each}

    {#if session.files.length > 0}
      <div class="loaded">
        <FileList
          files={session.files}
          onremove={(id) => session.removeFile(id)}
        />
      </div>
    {/if}
  </section>

  <section class="tools">
    <div class="tools-head">
      <h2>{prefs.t('chooseTool')}</h2>
      <p>{prefs.t('chooseToolHint')}</p>
    </div>

    <div class="grid">
      {#each TOOLS as tool (tool.id)}
        <ToolCard
          {tool}
          incompatible={incompatible(tool.acceptedInputs)}
          featured={tool.id === 'edit'}
          onpick={pick}
        />
      {/each}
    </div>
  </section>

  <section class="legacy">
    <p>{prefs.t('legacyNote')}</p>
    <button class="ghost" onclick={() => router.go({ name: 'legacy' })}>
      {prefs.t('openLegacy')} →
    </button>
  </section>
</div>

<style>
  /**
   * One column grid for the whole page.
   *
   * The hero used to be a 560px box floating above a 900px grid of cards, so
   * its edges landed 58px off the nearest card — close enough to read as a
   * mistake, far enough not to read as alignment. Both now measure themselves
   * from --cols and --grid-gap, so the upload box starts exactly where the
   * second card starts and ends exactly where the third one ends, at every
   * width, without a single hand-tuned number.
   *
   * The column count is chosen rather than inferred. auto-fill made the number
   * of columns a side effect of the viewport, and with seven cards — a prime —
   * every count it landed on left a half-empty row.
   */
  .page {
    --cols: 4;
    --grid-gap: var(--space-4);
    /* Two columns and the gap between them: the hero's measure. */
    --col-2: calc(
      (100% - (var(--cols) - 1) * var(--grid-gap)) / var(--cols) * 2 + var(--grid-gap)
    );

    max-width: 940px;
    margin: 0 auto;
    padding: var(--space-7) var(--space-5) var(--space-10);
    display: flex;
    flex-direction: column;
    gap: var(--space-9);
  }

  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
  }

  h1 {
    font-size: clamp(var(--fs-5), 4vw, var(--fs-6));
    letter-spacing: -0.015em;
    text-align: center;
    text-wrap: balance;
  }
  .sub {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--fs-3);
    text-align: center;
    max-width: 46ch;
    text-wrap: balance;
  }

  .upload { width: 100%; max-width: var(--col-2); margin-top: var(--space-2); }

  .privacy {
    margin: 0;
    font-size: var(--fs-1);
    color: var(--text-muted);
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .lock { font-size: var(--fs-1); }

  .alert,
  .loaded { width: 100%; max-width: var(--col-2); }

  .tools-head { text-align: center; margin-bottom: var(--space-5); }
  .tools-head h2 { font-size: var(--fs-4); }
  .tools-head p { margin: var(--space-1) 0 0; font-size: var(--fs-1); color: var(--text-muted); }

  .grid {
    display: grid;
    gap: var(--grid-gap);
    grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  }

  /* Seven cards never fill an even row, so the one tool no free competitor has
     takes two cells. Eight cells, and no orphan at any column count. */
  .grid > :global(.featured) { grid-column: span 2; }

  .legacy {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding-top: var(--space-6);
    border-top: 1px solid var(--border);
  }
  .legacy p { margin: 0; font-size: var(--fs-1); color: var(--text-muted); }
  .legacy button { min-height: 44px; }

  @media (max-width: 839px) {
    .page { --cols: 2; }
  }

  @media (max-width: 560px) {
    .page {
      padding: var(--space-6) var(--space-4) var(--space-9);
      gap: var(--space-7);
    }
  }

  /* One column: a two-cell span would conjure an implicit second column. */
  @media (max-width: 359px) {
    .page { --cols: 1; }
    .grid > :global(.featured) { grid-column: span 1; }
  }
</style>
